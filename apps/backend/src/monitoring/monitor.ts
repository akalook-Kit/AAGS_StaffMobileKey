import { statfs } from 'node:fs/promises';
import { hostname } from 'node:os';
import { pool, many, one } from '../db.ts';
import { audit } from '../audit.ts';
import { getConfig, SCHEMAS } from '../hotel-config.ts';
import { isOnline } from '../routes/portal.ts';
import { classifyDoor, type DoorFacts } from './doors.ts';
import { maskRecipient, sendEmail, sendSms, type Channels } from './channels.ts';

/**
 * Monitoring (2.7). Runs every minute: raises and clears alerts, and tells the people configured for each category
 * by e-mail and/or SMS.
 *
 *   doors   door_offline        a lock lost contact (explicit event, Visionline alarm, or silence)
 *   vip     vip_entrance        first entrance at a watched door
 *   locks   lock_alarm, battery_critical
 *   system  connector_offline, visionline_unreachable, disk_low (red until fixed), db_large
 */
export const CATEGORIES = ['doors', 'vip', 'locks', 'system'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABELS: Record<Category, string> = { doors: 'Doors offline', vip: 'Watched doors (VIP)', locks: 'Lock alarms and batteries', system: 'System (server, disk, database, connector)' };
const KIND_CATEGORY: Record<string, Category> = {
  door_offline: 'doors', vip_entrance: 'vip', lock_alarm: 'locks', battery_critical: 'locks',
  connector_offline: 'system', visionline_unreachable: 'system', disk_low: 'system', db_large: 'system', test: 'system',
};
export const categoryOf = (kind: string): Category => KIND_CATEGORY[kind] ?? 'system';

export type Severity = 'critical' | 'warning' | 'info';
interface AlertInput { kind: string; subject?: string; severity: Severity; title: string; detail?: string | null; data?: Record<string, unknown> }

export async function monitoringPolicy(hotelId: string) {
  const raw = await getConfig(pool, hotelId, 'policy');
  const p = SCHEMAS.policy.safeParse(raw ?? {});
  return (p.success ? p.data : SCHEMAS.policy.parse({})).monitoring;
}
export async function channels(hotelId: string): Promise<Channels> {
  const raw = await getConfig(pool, hotelId, 'notifications');
  const p = SCHEMAS.notifications.safeParse(raw ?? {});
  return (p.success ? p.data : SCHEMAS.notifications.parse({})) as Channels;
}

// ---- alerts -------------------------------------------------------------------------------------------
/** Opens an alert, or refreshes the open one for the same problem. New alerts are announced (unless flapping). */
export async function raise(hotelId: string, a: AlertInput) {
  const subject = a.subject ?? '';
  const existing = await one(pool, `SELECT * FROM monitor_alerts WHERE hotel_id=$1 AND kind=$2 AND subject=$3 AND resolved_at IS NULL`, [hotelId, a.kind, subject]);
  if (existing) {
    await pool.query(`UPDATE monitor_alerts SET last_seen_at=now(), severity=$2, title=$3, detail=$4, data=$5 WHERE id=$1`, [existing.id, a.severity, a.title, a.detail ?? null, a.data ?? {}]);
    return { alert: existing, isNew: false };
  }
  const alert = await one(pool, `INSERT INTO monitor_alerts (hotel_id, kind, subject, severity, title, detail, data) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (hotel_id, kind, subject) WHERE resolved_at IS NULL DO NOTHING RETURNING *`, [hotelId, a.kind, subject, a.severity, a.title, a.detail ?? null, a.data ?? {}]);
  if (!alert) return { alert: null, isNew: false }; // raced with another worker
  await audit(null, { hotelId, actorType: 'system', action: 'monitor.alert_opened', targetType: 'alert', targetId: alert.id, details: { kind: a.kind, subject, severity: a.severity, title: a.title } });
  const pol = await monitoringPolicy(hotelId);
  const recent = await one(pool, `SELECT 1 FROM monitor_alerts WHERE hotel_id=$1 AND kind=$2 AND subject=$3 AND id<>$4 AND notified_at IS NOT NULL
    AND resolved_at > now() - make_interval(mins => $5)`, [hotelId, a.kind, subject, alert.id, pol.notify.cooldownMinutes]);
  if (!recent) await announce(hotelId, alert, 'opened');
  return { alert, isNew: true };
}

/** A one-off event (e.g. VIP entrance): recorded as an alert that is already over, and announced. */
export async function record(hotelId: string, a: AlertInput) {
  const alert = await one(pool, `INSERT INTO monitor_alerts (hotel_id, kind, subject, severity, title, detail, data, resolved_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING *`,
    [hotelId, a.kind, a.subject ?? '', a.severity, a.title, a.detail ?? null, a.data ?? {}]);
  await announce(hotelId, alert!, 'event');
  return alert!;
}

export async function clear(hotelId: string, kind: string, subject: string, note?: string) {
  const rows = await many(pool, `UPDATE monitor_alerts SET resolved_at=now(), detail=COALESCE($4, detail) WHERE hotel_id=$1 AND kind=$2 AND subject=$3 AND resolved_at IS NULL RETURNING *`, [hotelId, kind, subject, note ?? null]);
  for (const r of rows) {
    await audit(null, { hotelId, actorType: 'system', action: 'monitor.alert_resolved', targetType: 'alert', targetId: r.id, details: { kind, subject } });
    const pol = await monitoringPolicy(hotelId);
    if (pol.notify.sendResolved && r.notified_at) await announce(hotelId, r, 'resolved');
  }
  return rows.length;
}
/** Clears every open alert of a kind whose subject is not in the list (the problem went away). */
async function clearOthers(hotelId: string, kind: string, keep: string[]) {
  const open = await many(pool, `SELECT subject FROM monitor_alerts WHERE hotel_id=$1 AND kind=$2 AND resolved_at IS NULL`, [hotelId, kind]);
  for (const o of open) if (!keep.includes(o.subject)) await clear(hotelId, kind, o.subject);
}

// ---- messages -----------------------------------------------------------------------------------------
async function hotelName(hotelId: string) {
  const p = await getConfig(pool, hotelId, 'property');
  return (p?.displayName ?? (await one(pool, 'SELECT name FROM hotels WHERE id=$1', [hotelId]))?.name ?? 'Hotel') as string;
}
export function messageFor(hotel: string, a: any, phase: 'opened' | 'resolved' | 'event' | 'test') {
  const sev = a.severity === 'critical' ? 'ALERT' : a.severity === 'warning' ? 'Warning' : 'Notice';
  const head = phase === 'resolved' ? `Resolved: ${a.title}` : `${sev}: ${a.title}`;
  const subject = `[${hotel}] ${head}`;
  const when = new Date(phase === 'resolved' ? a.resolved_at ?? Date.now() : a.opened_at ?? Date.now()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const text = [head, phase === 'resolved' ? 'The problem is over.' : a.detail ?? '', `${hotel} - ${when}`].filter(Boolean).join('\n');
  const sms = `${hotel}: ${head}${a.detail && phase !== 'resolved' ? ` - ${a.detail}` : ''}`;
  return { subject, text: `${text}\n\nStaff Mobile Key monitoring. Open the portal: Monitoring.`, sms };
}

async function announce(hotelId: string, alert: any, phase: 'opened' | 'resolved' | 'event' | 'test', onlyContact?: string) {
  const cat = categoryOf(alert.kind);
  const contacts = await many(pool, `SELECT * FROM alert_contacts WHERE hotel_id=$1 AND active AND ($2::text = ANY(categories) OR $3::uuid IS NOT NULL) AND ($3::uuid IS NULL OR id=$3)`, [hotelId, cat, onlyContact ?? null]);
  if (!contacts.length) return { sent: 0, failed: 0 };
  const ch = await channels(hotelId);
  const m = messageFor(await hotelName(hotelId), alert, phase);
  let sent = 0, failed = 0;
  for (const c of contacts) {
    const jobs: ['email' | 'sms', string, () => Promise<void>][] = [];
    if (c.by_email && c.email && ch.email.enabled) jobs.push(['email', c.email, () => sendEmail(ch.email, c.email, m.subject, m.text)]);
    if (c.by_sms && c.phone && ch.sms.enabled) jobs.push(['sms', c.phone, () => sendSms(ch.sms, c.phone, m.sms)]);
    for (const [channel, to, run] of jobs) {
      let error: string | null = null;
      try { await run(); sent++; } catch (e) { error = (e as Error).message.slice(0, 300); failed++; }
      await pool.query(`INSERT INTO alert_messages (hotel_id, alert_id, contact_id, channel, recipient, subject, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [hotelId, alert.id ?? null, c.id, channel, maskRecipient(channel, to), channel === 'email' ? m.subject : m.sms.slice(0, 160), error ? 'failed' : 'sent', error]);
    }
  }
  if (alert.id && phase !== 'test') await pool.query(`UPDATE monitor_alerts SET ${phase === 'resolved' ? 'resolved_notified_at' : 'notified_at'}=now() WHERE id=$1`, [alert.id]);
  return { sent, failed };
}

/** "Send a test" from Settings: to one contact, or to everyone in the system category. */
export async function sendTest(hotelId: string, contactId: string | null) {
  const fake = { id: null, kind: 'test', severity: 'info', title: 'Test message', detail: 'Alerts from Staff Mobile Key reach you this way.', opened_at: new Date().toISOString() };
  if (contactId) return announce(hotelId, fake, 'test', contactId);
  return announce(hotelId, fake, 'test');
}

// ---- system health ------------------------------------------------------------------------------------
export const defaultDiskPath = () => (process.platform === 'win32' ? 'C:\\' : '/');
export async function diskInfo(path: string) {
  const s = await statfs(path);
  return { path, free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
}
export async function databaseInfo() {
  const size = await one(pool, `SELECT pg_database_size(current_database())::bigint AS b`);
  const tables = await many(pool, `SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes, c.reltuples::bigint AS rows
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY 2 DESC LIMIT 8`);
  return { bytes: Number(size!.b), tables: tables.map((t) => ({ name: t.name, bytes: Number(t.bytes), rows: Math.max(0, Number(t.rows)) })) };
}
const GB = 1024 ** 3, MB = 1024 ** 2;
const gb = (b: number) => `${(b / GB).toFixed(1)} GB`;

let lastSample = 0;
async function sampleSystem(diskPath: string) {
  if (Date.now() - lastSample < 55 * 60_000) return;
  lastSample = Date.now();
  const [db, disk] = await Promise.all([databaseInfo(), diskInfo(diskPath).catch(() => null)]);
  await pool.query(`INSERT INTO system_samples (source, db_bytes, disk_path, disk_free, disk_total) VALUES ('platform',$1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [db.bytes, disk?.path ?? null, disk?.free ?? null, disk?.total ?? null]);
  await pool.query(`DELETE FROM system_samples WHERE at < now() - interval '400 days'`);
}

// ---- the minute check ---------------------------------------------------------------------------------
export async function checkHotel(hotelId: string, now = new Date()) {
  const pol = await monitoringPolicy(hotelId);
  const conns = await many(pool, `SELECT id, name, last_seen_at, health FROM connectors WHERE hotel_id=$1 AND status='ACTIVE'`, [hotelId]);

  // Connector and Visionline
  const offline: string[] = [], vlDown: string[] = [];
  for (const c of conns) {
    const silentMin = c.last_seen_at ? (now.getTime() - new Date(c.last_seen_at).getTime()) / 60_000 : Infinity;
    if (silentMin > pol.connectorOfflineMinutes) {
      offline.push(c.id);
      await raise(hotelId, { kind: 'connector_offline', subject: c.id, severity: 'critical', title: `Hotel connector "${c.name}" is offline`,
        detail: c.last_seen_at ? `No contact since ${new Date(c.last_seen_at).toISOString().slice(0, 16).replace('T', ' ')} UTC. Keys cannot be issued or revoked.` : 'It has never connected.' });
    } else if (c.health && c.health.visionlineReachable === false && c.health.credentialsConfigured) {
      vlDown.push(c.id);
      await raise(hotelId, { kind: 'visionline_unreachable', subject: c.id, severity: 'critical', title: 'Visionline cannot be reached', detail: c.health.lastError ?? 'The connector cannot reach the Visionline Web API.' });
    }
  }
  await clearOthers(hotelId, 'connector_offline', offline);
  await clearOthers(hotelId, 'visionline_unreachable', vlDown);

  // Disk: this server, and the disk the connector reports (the Visionline PC). Same host and path = one alert.
  const minFree = pol.diskMinFreeGb * GB;
  const diskPath = pol.diskPath?.trim() || defaultDiskPath();
  const disks: { subject: string; where: string; free: number; total: number }[] = [];
  try { const d = await diskInfo(diskPath); disks.push({ subject: `${hostname()}|${d.path}`, where: `${d.path} on ${hostname()} (platform server)`, free: d.free, total: d.total }); } catch { /* path not found */ }
  for (const c of conns) {
    const d = c.health?.disk;
    if (d && typeof d.freeBytes === 'number' && isOnline(c.last_seen_at)) {
      const subject = `${d.host ?? c.id}|${d.path}`;
      if (!disks.some((x) => x.subject === subject)) disks.push({ subject, where: `${d.path} on ${d.host ?? 'the Visionline PC'} (connector)`, free: d.freeBytes, total: d.totalBytes ?? 0 });
    }
  }
  const low: string[] = [];
  for (const d of disks) if (d.free < minFree) {
    low.push(d.subject);
    await raise(hotelId, { kind: 'disk_low', subject: d.subject, severity: 'critical', title: `Disk space low: ${gb(d.free)} free`,
      detail: `${d.where}: ${gb(d.free)} free of ${gb(d.total)} - below the ${pol.diskMinFreeGb} GB limit. Free space or add a disk; the database and backups need room.`, data: { free: d.free, total: d.total } });
  }
  await clearOthers(hotelId, 'disk_low', low);

  // Database size
  const db = await databaseInfo();
  if (db.bytes > pol.dbMaxMb * MB) {
    await raise(hotelId, { kind: 'db_large', subject: 'database', severity: 'warning', title: `Database is ${Math.round(db.bytes / MB)} MB`,
      detail: `Above the ${pol.dbMaxMb} MB limit. Make a copy (database-tools.ps1 -Action Copy) and check System health for the largest tables.`, data: { bytes: db.bytes } });
  } else await clear(hotelId, 'db_large', 'database');

  // Doors
  if (pol.doorOffline.enabled) await checkDoors(hotelId, pol, conns, now);
  else await clearOthers(hotelId, 'door_offline', []);

  // Lock alarms (Visionline) and critical batteries
  const alarms = await many(pool, `SELECT alarm_id, COALESCE(type_name, alarm_type, 'Alarm') AS t, alarm_text, COALESCE(door_id, door_raw) AS door FROM vl_alarms
    WHERE hotel_id=$1 AND NOT completed AND COALESCE(alarm_at, received_at) > now() - interval '24 hours'`, [hotelId]);
  const names = await doorNames(hotelId);
  // Battery alarms are covered by the battery module (one alert per door), so they are not repeated here.
  const battOn = Boolean((await getConfig(pool, hotelId, 'features'))?.batteryMonitoring);
  const lockAlarms = alarms.filter((a) => !(battOn && /battery/i.test(`${a.t} ${a.alarm_text ?? ''}`)));
  for (const a of lockAlarms) await raise(hotelId, { kind: 'lock_alarm', subject: a.alarm_id, severity: 'critical', title: `Lock alarm at ${names.get(a.door) ?? a.door ?? 'a door'}: ${a.t}`, detail: a.alarm_text ?? null });
  await clearOthers(hotelId, 'lock_alarm', lockAlarms.map((a) => a.alarm_id));
  const batt = await many(pool, `SELECT door_id FROM battery_alerts WHERE hotel_id=$1 AND severity='CRITICAL' AND status<>'RESOLVED'`, [hotelId]);
  for (const b of batt) await raise(hotelId, { kind: 'battery_critical', subject: b.door_id, severity: 'critical', title: `Battery critically low at ${names.get(b.door_id) ?? b.door_id}`, detail: 'The lock may stop opening. Replace the batteries.' });
  await clearOthers(hotelId, 'battery_critical', batt.map((b) => b.door_id));
}

/** Door names by id, Visionline doorID (what lock events carry) or name. */
async function doorNames(hotelId: string) {
  const m = new Map<string, string>();
  for (const r of await doorRows(hotelId)) { m.set(r.external_id, r.name); m.set(r.name, r.name); if (r.vid) m.set(String(r.vid), r.name); }
  return m;
}
const doorRows = (hotelId: string) => many(pool, `SELECT external_id, name, data->>'doorID' AS vid FROM resources WHERE hotel_id=$1 AND kind='door'`, [hotelId]);
/** The door-list id for whatever a lock event or alarm calls the door. */
async function doorKey(hotelId: string, raw: string) {
  const rows = await doorRows(hotelId);
  return (rows.find((r) => r.external_id === raw) ?? rows.find((r) => String(r.vid ?? '') === raw) ?? rows.find((r) => r.name === raw))?.external_id as string | undefined;
}

async function checkDoors(hotelId: string, pol: Awaited<ReturnType<typeof monitoringPolicy>>, conns: any[], now: Date) {
  const d = pol.doorOffline;
  const watchRunning = conns.some((c) => isOnline(c.last_seen_at) && (c.health?.capabilities ?? []).includes('battery-events') && /watching/.test(c.health?.visionlineWatch ?? ''));
  const facts = new Map<string, DoorFacts>();
  const get = (id: string) => { let f = facts.get(id); if (!f) { f = { lastEventAt: null, eventsInLearnWindow: 0, lastExplicit: null, eventAfterExplicit: false, openOfflineAlarm: null }; facts.set(id, f); } return f; };
  const horizon = Math.max(d.learnDays * 24, d.silentHours) + 24 * 30;
  for (const r of await many(pool, `SELECT door_id, max(received_at) AS last, count(*) FILTER (WHERE received_at > $3::timestamptz - make_interval(days => $2))::int AS n
      FROM visionline_events WHERE hotel_id=$1 AND kind='event' AND door_id IS NOT NULL AND received_at > $3::timestamptz - make_interval(hours => $4) GROUP BY door_id`, [hotelId, d.learnDays, now, horizon])) {
    const f = get(r.door_id); f.lastEventAt = new Date(r.last); f.eventsInLearnWindow = r.n;
  }
  const codes = [...d.offlineEventCodes, ...d.onlineEventCodes];
  if (codes.length) {
    for (const r of await many(pool, `SELECT DISTINCT ON (door_id) door_id, event_code, received_at FROM visionline_events
        WHERE hotel_id=$1 AND kind='event' AND event_code = ANY($2::int[]) AND door_id IS NOT NULL ORDER BY door_id, received_at DESC, id DESC`, [hotelId, codes])) {
      const f = get(r.door_id);
      f.lastExplicit = { kind: d.offlineEventCodes.includes(r.event_code) ? 'offline' : 'online', at: new Date(r.received_at) };
      const after = await one(pool, `SELECT 1 FROM visionline_events WHERE hotel_id=$1 AND kind='event' AND door_id=$2 AND received_at > $3 AND NOT (event_code = ANY($4::int[])) LIMIT 1`, [hotelId, r.door_id, r.received_at, d.offlineEventCodes]);
      f.eventAfterExplicit = Boolean(after);
    }
  }
  if (d.alarmKeywords.length) {
    const re = new RegExp(d.alarmKeywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
    for (const a of await many(pool, `SELECT COALESCE(door_id, door_raw) AS door, COALESCE(type_name, alarm_type, '') AS t, COALESCE(alarm_text, '') AS x, alarm_at FROM vl_alarms
        WHERE hotel_id=$1 AND NOT completed AND COALESCE(door_id, door_raw) IS NOT NULL`, [hotelId])) {
      if (re.test(`${a.t} ${a.x}`)) get(a.door).openOfflineAlarm = { title: a.t || a.x, at: a.alarm_at ? new Date(a.alarm_at) : null };
    }
  }
  const names = await doorNames(hotelId);
  const offline: string[] = [];
  for (const [door, f] of facts) {
    const v = classifyDoor(f, d, now, watchRunning);
    const prev = await one(pool, `SELECT state FROM door_status WHERE hotel_id=$1 AND door_id=$2`, [hotelId, door]);
    await pool.query(`INSERT INTO door_status (hotel_id, door_id, state, last_event_at, reason) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (hotel_id, door_id) DO UPDATE SET last_event_at=EXCLUDED.last_event_at, reason=EXCLUDED.reason,
        changed_at = CASE WHEN door_status.state <> EXCLUDED.state THEN now() ELSE door_status.changed_at END, state=EXCLUDED.state`, [hotelId, door, v.state, f.lastEventAt, v.reason]);
    if (v.state === 'offline') {
      offline.push(door);
      await raise(hotelId, { kind: 'door_offline', subject: door, severity: v.severity ?? 'warning', title: `Door offline: ${names.get(door) ?? door}`, detail: v.reason, data: { previous: prev?.state ?? 'unknown' } });
    } else if (v.state === 'online') await clear(hotelId, 'door_offline', door, 'The lock is reporting again.');
  }
  // Doors with an open alert but no facts any more (e.g. alarm completed and no events): resolve.
  await clearOthers(hotelId, 'door_offline', offline.concat([...facts.entries()].filter(([, f]) => classifyDoor(f, d, now, watchRunning).state === 'unknown').map(([k]) => k)));
}

/** Called for each lock event (visionline-events.ts): watched doors announce their first entrance. */
export async function onLockEvent(hotelId: string, ev: { doorId: string | null; code: number; person: string | null; at: Date }, entranceCodes: number[]) {
  if (!ev.doorId || !entranceCodes.includes(ev.code)) return;
  const names = await doorNames(hotelId);
  const name = names.get(ev.doorId) ?? ev.doorId;
  const key = (await doorKey(hotelId, ev.doorId)) ?? ev.doorId;
  const w = await one(pool, `SELECT *, to_char(last_alert_day, 'YYYY-MM-DD') AS last_day FROM watched_doors WHERE hotel_id=$1 AND active AND door_id=$2 AND watch_from <= now() AND (watch_until IS NULL OR watch_until > now())`, [hotelId, key]);
  if (!w) return;
  const tz = ((await getConfig(pool, hotelId, 'property'))?.timezone ?? 'UTC') as string;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ev.at);
  await pool.query(`UPDATE watched_doors SET last_entrance_at=$2 WHERE id=$1`, [w.id, ev.at]);
  const announceIt = w.mode === 'every' || (w.mode === 'first_daily' && w.last_day !== day) || (w.mode === 'first_once' && !w.last_alert_day);
  if (!announceIt) return;
  await pool.query(`UPDATE watched_doors SET last_alert_day=$2 WHERE id=$1`, [w.id, day]);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(ev.at);
  await record(hotelId, { kind: 'vip_entrance', subject: key, severity: 'info', title: `${w.mode === 'every' ? 'Entrance' : 'First entrance'} at ${w.label} (${name})`,
    detail: `${time}${ev.person ? ` - ${ev.person}` : ''}`, data: { watchedDoorId: w.id, person: ev.person } });
  if (w.mode === 'first_once') await pool.query(`UPDATE watched_doors SET active=false WHERE id=$1`, [w.id]);
}

export async function runMonitoring() {
  const hotels = await many(pool, `SELECT id FROM hotels WHERE status='ACTIVE'`);
  let diskPath = defaultDiskPath();
  for (const h of hotels) {
    try { const p = await monitoringPolicy(h.id); if (p.diskPath) diskPath = p.diskPath; await checkHotel(h.id); }
    catch (e) { console.error('[monitor]', h.id, (e as Error).message); }
  }
  await sampleSystem(diskPath).catch((e) => console.error('[monitor] sample', (e as Error).message));
}
