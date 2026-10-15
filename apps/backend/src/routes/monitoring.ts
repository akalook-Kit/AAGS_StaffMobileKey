import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { z } from 'zod';
import { pool, many, one } from '../db.ts';
import { audit } from '../audit.ts';
import { requirePerm } from '../auth.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { getConfig } from '../hotel-config.ts';
import { getSecret } from '../config.ts';
import { isOnline } from './portal.ts';
import { CATEGORIES, CATEGORY_LABELS, checkHotel, channels, databaseInfo, defaultDiskPath, diskInfo, monitoringPolicy, sendTest } from '../monitoring/monitor.ts';
import { normalisePhone } from '../monitoring/channels.ts';

/** Monitoring (2.7): alerts, doors online/offline, watched (VIP) doors, system health, e-mail/SMS contacts. */
const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Hotel');
  return id;
};
const SEV_ORDER = `CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`;

const Contact = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal('').transform(() => null)),
  phone: z.string().trim().max(30).nullable().optional().or(z.literal('').transform(() => null)),
  byEmail: z.boolean().default(true), bySms: z.boolean().default(false),
  categories: z.array(z.enum(CATEGORIES)).min(1, 'Choose at least one kind of alert'),
  active: z.boolean().default(true),
}).superRefine((c, ctx) => {
  if (c.byEmail && !c.email) ctx.addIssue({ code: 'custom', path: ['email'], message: 'Give an e-mail address, or untick e-mail.' });
  if (c.bySms && !c.phone) ctx.addIssue({ code: 'custom', path: ['phone'], message: 'Give a mobile number, or untick SMS.' });
  if (c.phone) { try { normalisePhone(c.phone); } catch (e) { ctx.addIssue({ code: 'custom', path: ['phone'], message: (e as Error).message }); } }
  if (!c.byEmail && !c.bySms) ctx.addIssue({ code: 'custom', path: ['byEmail'], message: 'Choose e-mail, SMS or both.' });
});
const Watched = z.object({
  doorId: z.string().min(1).max(120), label: z.string().trim().min(2).max(80),
  mode: z.enum(['first_daily', 'first_once', 'every']).default('first_daily'),
  watchFrom: z.coerce.date().optional(), watchUntil: z.coerce.date().nullable().optional(), active: z.boolean().default(true),
});

function lastBackup() {
  const f = process.env.SMK_BACKUP_LOG;
  if (!f || !existsSync(f)) return null;
  try {
    const lines = readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    const last = lines.at(-1) ?? '';
    const ok = [...lines].reverse().find((l) => / OK /.test(l));
    return { last: last.slice(0, 200), lastOkAt: ok ? ok.split(' ')[0] : null, failed: / FAILED/.test(last) };
  } catch { return null; }
}

export function monitoringRoutes(app: FastifyInstance) {
  app.get(`${P}/hotels/:hotelId/monitoring`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'alerts.read');
    const pol = await monitoringPolicy(hotelId);
    const [open, doors, watched, conns, db, samples, messages, ch, tz] = await Promise.all([
      many(pool, `SELECT id, kind, subject, severity, title, detail, opened_at, last_seen_at, acknowledged_at, notified_at,
          (SELECT display_name FROM operators o WHERE o.id=a.acknowledged_by) AS acknowledged_by
        FROM monitor_alerts a WHERE hotel_id=$1 AND resolved_at IS NULL ORDER BY ${SEV_ORDER}, opened_at DESC`, [hotelId]),
      many(pool, `SELECT s.door_id, COALESCE(r.name, s.door_id) AS name, r.data->>'doorGroup' AS "group", s.state, s.last_event_at, s.changed_at, s.reason
        FROM door_status s LEFT JOIN LATERAL (SELECT * FROM resources r WHERE r.hotel_id=s.hotel_id AND r.kind='door' AND (r.external_id=s.door_id OR r.data->>'doorID'=s.door_id OR r.name=s.door_id) LIMIT 1) r ON true
        WHERE s.hotel_id=$1 ORDER BY CASE s.state WHEN 'offline' THEN 0 WHEN 'unknown' THEN 2 ELSE 1 END, s.last_event_at DESC NULLS LAST`, [hotelId]),
      many(pool, `SELECT w.id, w.door_id, COALESCE(r.name, w.door_id) AS door_name, w.label, w.mode, w.watch_from, w.watch_until, w.active, w.last_entrance_at, w.last_alert_day,
          (SELECT count(*) FROM monitor_alerts a WHERE a.hotel_id=w.hotel_id AND a.kind='vip_entrance' AND a.subject=w.door_id AND a.opened_at > now() - interval '7 days')::int AS alerts_7d
        FROM watched_doors w LEFT JOIN resources r ON r.hotel_id=w.hotel_id AND r.kind='door' AND r.external_id=w.door_id WHERE w.hotel_id=$1 ORDER BY w.active DESC, w.label`, [hotelId]),
      many(pool, `SELECT id, name, last_seen_at, health FROM connectors WHERE hotel_id=$1 AND status='ACTIVE'`, [hotelId]),
      databaseInfo(),
      many(pool, `SELECT date_trunc('day', at) AS day, max(db_bytes)::bigint AS db, min(disk_free)::bigint AS free FROM system_samples WHERE source='platform' AND at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`),
      many(pool, `SELECT channel, recipient, subject, status, error, sent_at FROM alert_messages WHERE hotel_id=$1 ORDER BY sent_at DESC LIMIT 15`, [hotelId]),
      channels(hotelId),
      getConfig(pool, hotelId, 'property').then((p) => p?.timezone ?? 'UTC'),
    ]);
    const diskPath = pol.diskPath?.trim() || defaultDiskPath();
    const disks: any[] = [];
    try { const d = await diskInfo(diskPath); disks.push({ where: `${d.path} on ${hostname()}`, role: 'Platform server', free: d.free, total: d.total }); } catch (e) { disks.push({ where: diskPath, role: 'Platform server', error: (e as Error).message }); }
    for (const c of conns) if (c.health?.disk) disks.push({ where: `${c.health.disk.path} on ${c.health.disk.host ?? c.name}`, role: `Connector "${c.name}"`, free: c.health.disk.freeBytes, total: c.health.disk.totalBytes, at: c.last_seen_at, online: isOnline(c.last_seen_at) });
    const minFree = pol.diskMinFreeGb * 1024 ** 3;
    return {
      timeZone: tz,
      alerts: open, counts: { critical: open.filter((a) => a.severity === 'critical').length, warning: open.filter((a) => a.severity === 'warning').length, info: open.filter((a) => a.severity === 'info').length },
      doors: { total: doors.length, online: doors.filter((d) => d.state === 'online').length, offline: doors.filter((d) => d.state === 'offline').length, unknown: doors.filter((d) => d.state === 'unknown').length, list: doors.slice(0, 500),
        watching: conns.some((c) => isOnline(c.last_seen_at) && /watching/.test(c.health?.visionlineWatch ?? '')), settings: pol.doorOffline },
      watched,
      system: {
        database: { ...db, limitBytes: pol.dbMaxMb * 1024 ** 2, over: db.bytes > pol.dbMaxMb * 1024 ** 2 },
        disks: disks.map((d) => ({ ...d, minFree, low: typeof d.free === 'number' && d.free < minFree })),
        trend: samples.map((s) => ({ day: s.day, db: Number(s.db), free: s.free == null ? null : Number(s.free) })),
        backup: lastBackup(),
        connectors: conns.map((c) => ({ name: c.name, online: isOnline(c.last_seen_at), lastSeenAt: c.last_seen_at, version: c.health?.connectorVersion ?? null, visionline: c.health?.visionlineReachable ?? null, watch: c.health?.visionlineWatch ?? null })),
      },
      channels: { email: ch.email.enabled, sms: ch.sms.enabled, smsProvider: ch.sms.provider,
        emailPassword: Boolean(getSecret(ch.email.passwordRef)), smsKey: Boolean(getSecret(ch.sms.secretRef)) },
      messages,
      thresholds: { diskMinFreeGb: pol.diskMinFreeGb, dbMaxMb: pol.dbMaxMb, connectorOfflineMinutes: pol.connectorOfflineMinutes, cooldownMinutes: pol.notify.cooldownMinutes },
    };
  });

  app.get(`${P}/hotels/:hotelId/monitoring/alerts`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'alerts.read');
    const q = z.object({ days: z.coerce.number().int().min(1).max(366).default(30), kind: z.string().max(40).optional() }).parse(req.query);
    return many(pool, `SELECT id, kind, subject, severity, title, detail, opened_at, resolved_at, acknowledged_at, notified_at FROM monitor_alerts
      WHERE hotel_id=$1 AND opened_at > now() - make_interval(days => $2) AND ($3::text IS NULL OR kind=$3) ORDER BY opened_at DESC LIMIT 500`, [hotelId, q.days, q.kind ?? null]);
  });

  app.post(`${P}/hotels/:hotelId/monitoring/alerts/:alertId/acknowledge`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'alerts.manage');
    const id = (req.params as any).alertId as string;
    const r = await one(pool, `UPDATE monitor_alerts SET acknowledged_at=now(), acknowledged_by=$3 WHERE id=$1 AND hotel_id=$2 AND resolved_at IS NULL RETURNING id, kind`, [id, hotelId, op.id]);
    if (!r) throw notFound('Open alert');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'monitor.alert_acknowledged', targetType: 'alert', targetId: id, details: { kind: r.kind } });
    return { ok: true };
  });

  /** Runs the checks now instead of waiting for the next minute. */
  app.post(`${P}/hotels/:hotelId/monitoring/check`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'alerts.manage');
    await checkHotel(hotelId);
    return { ok: true };
  });

  // ---- contacts ----
  const contactOut = (c: any) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, byEmail: c.by_email, bySms: c.by_sms, categories: c.categories, active: c.active, updatedAt: c.updated_at });
  app.get(`${P}/hotels/:hotelId/monitoring/contacts`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'alerts.manage');
    const rows = await many(pool, `SELECT * FROM alert_contacts WHERE hotel_id=$1 ORDER BY active DESC, name`, [hotelId]);
    return { contacts: rows.map(contactOut), categories: CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABELS[c] })) };
  });
  app.post(`${P}/hotels/:hotelId/monitoring/contacts`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'alerts.manage');
    const c = Contact.parse(req.body);
    const phone = c.phone ? normalisePhone(c.phone) : null;
    const r = await one(pool, `INSERT INTO alert_contacts (hotel_id, name, email, phone, by_email, by_sms, categories, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [hotelId, c.name, c.email ?? null, phone, c.byEmail, c.bySms, c.categories, c.active]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'monitor.contact_added', targetType: 'alert_contact', targetId: r!.id, details: { name: c.name, categories: c.categories, email: Boolean(c.email), sms: Boolean(phone) } });
    return contactOut(r);
  });
  app.put(`${P}/hotels/:hotelId/monitoring/contacts/:contactId`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'alerts.manage');
    const c = Contact.parse(req.body);
    const phone = c.phone ? normalisePhone(c.phone) : null;
    const r = await one(pool, `UPDATE alert_contacts SET name=$3, email=$4, phone=$5, by_email=$6, by_sms=$7, categories=$8, active=$9, updated_at=now() WHERE id=$1 AND hotel_id=$2 RETURNING *`,
      [(req.params as any).contactId, hotelId, c.name, c.email ?? null, phone, c.byEmail, c.bySms, c.categories, c.active]);
    if (!r) throw notFound('Contact');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'monitor.contact_changed', targetType: 'alert_contact', targetId: r.id, details: { name: c.name, categories: c.categories, active: c.active } });
    return contactOut(r);
  });
  app.delete(`${P}/hotels/:hotelId/monitoring/contacts/:contactId`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'alerts.manage');
    const r = await one(pool, `DELETE FROM alert_contacts WHERE id=$1 AND hotel_id=$2 RETURNING id, name`, [(req.params as any).contactId, hotelId]);
    if (!r) throw notFound('Contact');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'monitor.contact_removed', targetType: 'alert_contact', targetId: r.id, details: { name: r.name } });
    return { ok: true };
  });
  app.post(`${P}/hotels/:hotelId/monitoring/test`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'alerts.manage');
    const b = z.object({ contactId: z.string().uuid().nullable().optional() }).parse(req.body ?? {});
    const ch = await channels(hotelId);
    if (!ch.email.enabled && !ch.sms.enabled) throw badRequest('NO_CHANNEL', 'Switch on e-mail or SMS first (Settings -> Alerts & notifications).');
    const r = await sendTest(hotelId, b.contactId ?? null);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'monitor.test_sent', details: r });
    const failures = await many(pool, `SELECT channel, recipient, error FROM alert_messages WHERE hotel_id=$1 AND status='failed' AND sent_at > now() - interval '2 minutes' ORDER BY sent_at DESC LIMIT 5`, [hotelId]);
    return { ...r, failures };
  });
  app.get(`${P}/hotels/:hotelId/monitoring/messages`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'alerts.read');
    return many(pool, `SELECT m.channel, m.recipient, m.subject, m.status, m.error, m.sent_at, c.name AS contact FROM alert_messages m LEFT JOIN alert_contacts c ON c.id=m.contact_id
      WHERE m.hotel_id=$1 ORDER BY m.sent_at DESC LIMIT 200`, [hotelId]);
  });

  // ---- watched (VIP) doors ----
  app.post(`${P}/hotels/:hotelId/monitoring/watched-doors`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'alerts.manage');
    const w = Watched.parse(req.body);
    const door = await one(pool, `SELECT external_id, name FROM resources WHERE hotel_id=$1 AND kind='door' AND external_id=$2`, [hotelId, w.doorId]);
    if (!door) throw badRequest('UNKNOWN_DOOR', 'That door is not in the list read from Visionline.');
    const r = await one(pool, `INSERT INTO watched_doors (hotel_id, door_id, label, mode, watch_from, watch_until, active, created_by) VALUES ($1,$2,$3,$4,COALESCE($5, now()),$6,$7,$8)
      ON CONFLICT (hotel_id, door_id) DO UPDATE SET label=EXCLUDED.label, mode=EXCLUDED.mode, watch_from=EXCLUDED.watch_from, watch_until=EXCLUDED.watch_until, active=EXCLUDED.active, last_alert_day=NULL
      RETURNING id`, [hotelId, w.doorId, w.label, w.mode, w.watchFrom ?? null, w.watchUntil ?? null, w.active, op.id]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'monitor.door_watched', targetType: 'door', targetId: w.doorId, details: { label: w.label, mode: w.mode, door: door.name } });
    return { id: r!.id };
  });
  app.put(`${P}/hotels/:hotelId/monitoring/watched-doors/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'alerts.manage');
    const w = Watched.parse(req.body);
    const r = await one(pool, `UPDATE watched_doors SET label=$3, mode=$4, watch_until=$5, active=$6, last_alert_day=CASE WHEN $6 AND NOT active THEN NULL ELSE last_alert_day END WHERE id=$1 AND hotel_id=$2 RETURNING id, door_id`,
      [(req.params as any).id, hotelId, w.label, w.mode, w.watchUntil ?? null, w.active]);
    if (!r) throw notFound('Watched door');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'monitor.door_watch_changed', targetType: 'door', targetId: r.door_id, details: { label: w.label, mode: w.mode, active: w.active } });
    return { ok: true };
  });
  app.delete(`${P}/hotels/:hotelId/monitoring/watched-doors/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'alerts.manage');
    const r = await one(pool, `DELETE FROM watched_doors WHERE id=$1 AND hotel_id=$2 RETURNING door_id, label`, [(req.params as any).id, hotelId]);
    if (!r) throw notFound('Watched door');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'monitor.door_unwatched', targetType: 'door', targetId: r.door_id, details: { label: r.label } });
    return { ok: true };
  });

  /** For the Overview page: open alerts, doors, watched doors. */
  app.get(`${P}/hotels/:hotelId/monitoring/summary`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'alerts.read');
    const a = await one(pool, `SELECT count(*) FILTER (WHERE severity='critical')::int AS critical, count(*) FILTER (WHERE severity='warning')::int AS warning FROM monitor_alerts WHERE hotel_id=$1 AND resolved_at IS NULL`, [hotelId]);
    const d = await one(pool, `SELECT count(*) FILTER (WHERE state='online')::int AS online, count(*) FILTER (WHERE state='offline')::int AS offline, count(*)::int AS total FROM door_status WHERE hotel_id=$1`, [hotelId]);
    const w = await many(pool, `SELECT w.label, COALESCE(r.name, w.door_id) AS door, w.last_entrance_at FROM watched_doors w LEFT JOIN resources r ON r.hotel_id=w.hotel_id AND r.kind='door' AND r.external_id=w.door_id
      WHERE w.hotel_id=$1 AND w.active ORDER BY w.last_entrance_at DESC NULLS LAST LIMIT 6`, [hotelId]);
    const top = await many(pool, `SELECT id, kind, severity, title, opened_at FROM monitor_alerts WHERE hotel_id=$1 AND resolved_at IS NULL ORDER BY ${SEV_ORDER}, opened_at DESC LIMIT 5`, [hotelId]);
    return { alerts: a, doors: d, watched: w, top };
  });

  /** Small summary for every portal page: a red band while a critical system alert is open (disk, connector...). */
  app.get(`${P}/hotels/:hotelId/monitoring/banner`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'alerts.read');
    return many(pool, `SELECT id, kind, title, detail, opened_at FROM monitor_alerts WHERE hotel_id=$1 AND resolved_at IS NULL AND severity='critical'
      AND kind IN ('disk_low', 'connector_offline', 'visionline_unreachable', 'db_large') ORDER BY opened_at`, [hotelId]);
  });
}
