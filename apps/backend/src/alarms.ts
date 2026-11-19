import { randomUUID } from 'node:crypto';
import { pool, tx, one, many, lockHotel } from './db.ts';
import { audit } from './audit.ts';
import { getConfig } from './hotel-config.ts';
import { enqueue, newCorrelationId } from './commands.ts';
import { upsertAlarms } from './directory.ts';
import { readyConnector } from './visionline-sync.ts';

/**
 * 2.38 Visionline alarms on their own (Armel, 18 Nov 2026: "Read alarms every 15 minutes … notify the logged in user or
 * the security or front office team … close the alarms automatically").
 *
 *  - READ_ALARMS every `visionline.alarms.readEveryMinutes` (15): GET /alarms?updatedSince [Web API §5.3].
 *  - "Excessive card usage" becomes a card alarm (monitor.ts): shown to everyone signed in and sent to the contacts
 *    who chose "Card alarms".
 *  - COMPLETE_ALARMS: a lock's open battery alarms are marked completed in Visionline [§5.4.1 POST /alarms/{id}]
 *    once the portal saw new batteries in that lock after the alarm (battery-change event 528 or a voltage jump) and
 *    the lock no longer reports low batteries. The lock itself only clears its flag when the new batteries are above
 *    4.5 V and 0.5 V more than before (ASSA ABLOY), so an alarm whose lock still says LOW stays open.
 *    Read-only connectors (-ReadOnly, e.g. the Marriott one) do not offer 'alarms-complete': nothing is written there.
 */
export const isBatteryAlarm = (typeName: string | null, text: string | null) => /batter(y|ie)|\bpiles?\b/i.test(`${typeName ?? ''} ${text ?? ''}`);
export const isExcessiveCardUsage = (typeName: string | null, text: string | null) => /excessive\s+card/i.test(`${typeName ?? ''} ${text ?? ''}`);

const READ_TTL_SEC = 10 * 60;
const MAX_COMPLETE = 50;

async function alarmsConfig(hotelId: string) {
  const vl = await getConfig(pool, hotelId, 'visionline');
  return { readEveryMinutes: 15, completeBatteryAlarms: true, excessiveCardUsage: true, ...(vl?.alarms ?? {}) } as { readEveryMinutes: number; completeBatteryAlarms: boolean; excessiveCardUsage: boolean };
}

/** Every minute (jobs.ts): ask for alarms when due, and ask Visionline to complete battery alarms that are done. */
export async function scheduleAlarmWork() {
  await releaseFailedCompletions();
  for (const h of await many(pool, `SELECT id FROM hotels WHERE status='ACTIVE' AND NOT COALESCE(is_demo, false)`)) {
    try {
      const cfg = await alarmsConfig(h.id);
      const conn = await readyConnector(pool, h.id);
      if (!conn) continue;
      const caps: string[] = conn.health?.capabilities ?? [];
      if (cfg.readEveryMinutes > 0 && caps.includes('alarms-read')) await maybeReadAlarms(h.id, cfg.readEveryMinutes);
      if (cfg.completeBatteryAlarms && caps.includes('alarms-complete')) await completeBatteryAlarms(h.id);
    } catch (e) { console.warn(`[alarms] ${h.id}: ${(e as Error).message}`); }
  }
}

export async function maybeReadAlarms(hotelId: string, everyMinutes: number, force = false) {
  const busy = await one(pool, `SELECT 1 FROM commands WHERE hotel_id=$1 AND type='READ_ALARMS' AND status IN ('PENDING','LEASED') AND expires_at > now()`, [hotelId]);
  if (busy) return null;
  if (!force) {
    const last = await one(pool, `SELECT created_at, status FROM commands WHERE hotel_id=$1 AND type='READ_ALARMS' ORDER BY created_at DESC LIMIT 1`, [hotelId]);
    if (last && Date.now() - new Date(last.created_at).getTime() < everyMinutes * 60_000 - 5_000) return null;
  }
  const lastAlarm = await one(pool, `SELECT max(updated_at) AS t FROM vl_alarms WHERE hotel_id=$1`, [hotelId]);
  // One hour of overlap: Visionline's updateTime and our clock can differ a little; upserts make repeats harmless.
  const since = lastAlarm?.t ? new Date(new Date(lastAlarm.t).getTime() - 3600_000) : new Date(Date.now() - 30 * 86_400_000);
  return tx(async (c) => {
    await lockHotel(c, hotelId);
    return enqueue(c, { hotelId, type: 'READ_ALARMS', payload: { since: since.toISOString(), max: 300 }, idempotencyKey: `alarms:${randomUUID()}`, correlationId: newCorrelationId(), ttlSec: READ_TTL_SEC });
  });
}

export async function onReadAlarmsResult(c: import('pg').PoolClient, cmd: any, result: { status: string; result?: any }) {
  if (result.status !== 'SUCCEEDED') return;
  const alarms = (result.result?.alarms ?? []) as any[];
  if (!alarms.length) return;
  const tz = (await getConfig(c, cmd.hotel_id, 'property'))?.timezone ?? 'UTC';
  await upsertAlarms(c, cmd.hotel_id, alarms.map((a) => ({
    id: String(a.id), alarmType: a.alarmType ?? null, alarmTypeName: a.alarmTypeName ?? null, alarmText: a.alarmText ?? null, alarmTime: a.alarmTime ?? null,
    door: a.door ?? null, cardHolder: a.cardHolder ?? null, completed: Boolean(a.completed), completionTime: a.completionTime ?? null, updateTime: a.updateTime ?? null,
  })), tz);
  // A completion the portal asked for, confirmed by Visionline itself.
  await c.query(`UPDATE vl_alarms SET complete_error=NULL WHERE hotel_id=$1 AND completed AND complete_error IS NOT NULL`, [cmd.hotel_id]);
}

/** Open battery alarms of locks that have had new batteries since the alarm, and no longer report low batteries. */
export async function batteryAlarmsToComplete(hotelId: string) {
  const rows = await many(pool, `SELECT a.alarm_id, a.door_id, a.alarm_at, a.type_name, a.alarm_text, ch.at AS changed_at, ch.source, s.state
      FROM vl_alarms a
      JOIN LATERAL (SELECT at, source FROM battery_changes b WHERE b.hotel_id=a.hotel_id AND b.door_id=a.door_id ORDER BY at DESC LIMIT 1) ch ON true
      LEFT JOIN battery_status s ON s.hotel_id=a.hotel_id AND s.door_id=a.door_id
     WHERE a.hotel_id=$1 AND NOT a.completed AND a.door_id IS NOT NULL AND a.complete_requested_at IS NULL
       -- Visionline gives alarm and event times to the minute: a change in the same minute counts (the state check
       -- below keeps an alarm open while the lock still says low).
       AND ch.at >= date_trunc('minute', COALESCE(a.alarm_at, a.received_at))
       AND COALESCE(s.state, 'GOOD') NOT IN ('LOW','CRITICAL')
     ORDER BY a.alarm_at LIMIT 500`, [hotelId]);
  return rows.filter((r) => isBatteryAlarm(r.type_name, r.alarm_text)).slice(0, MAX_COMPLETE);
}

export async function completeBatteryAlarms(hotelId: string) {
  const due = await batteryAlarmsToComplete(hotelId);
  if (!due.length) return null;
  const busy = await one(pool, `SELECT 1 FROM commands WHERE hotel_id=$1 AND type='COMPLETE_ALARMS' AND status IN ('PENDING','LEASED') AND expires_at > now()`, [hotelId]);
  if (busy) return null;
  const how = (s: string) => s === 'event' ? 'battery-change event' : s === 'maintenance' ? 'maintenance record' : 'voltage jump';
  const reason = `New batteries (${[...new Set(due.map((d) => how(d.source)))].join(', ')}); lock no longer reports low batteries`.slice(0, 200);
  return tx(async (c) => {
    await lockHotel(c, hotelId);
    const cmd = await enqueue(c, { hotelId, type: 'COMPLETE_ALARMS', payload: { alarmIds: due.map((d) => d.alarm_id), reason }, idempotencyKey: `alarms-complete:${randomUUID()}`, correlationId: newCorrelationId(), ttlSec: READ_TTL_SEC });
    await c.query(`UPDATE vl_alarms SET complete_requested_at=now(), complete_reason=$3, complete_error=NULL WHERE hotel_id=$1 AND alarm_id = ANY($2::text[])`, [hotelId, due.map((d) => d.alarm_id), reason]);
    await audit(c, { hotelId, actorType: 'system', action: 'visionline.alarm_complete_requested', targetType: 'command', targetId: cmd.id, correlationId: cmd.correlation_id,
      details: { alarms: due.map((d) => ({ id: d.alarm_id, door: d.door_id, changedAt: d.changed_at, source: d.source })), reason } });
    return cmd;
  });
}

export async function onCompleteAlarmsResult(c: import('pg').PoolClient, cmd: any, result: { status: string; result?: any; error?: { message?: string } }) {
  const ids: string[] = cmd.payload?.alarmIds ?? [];
  const outcome = new Map<string, { ok: boolean; error?: string }>();
  for (const r of (result.result?.results ?? []) as { id: string; ok: boolean; error?: string }[]) outcome.set(String(r.id), r);
  const done: string[] = []; const failed: { id: string; error: string }[] = [];
  for (const id of ids) {
    const r = outcome.get(id);
    if (r?.ok) done.push(id);
    else failed.push({ id, error: (r?.error ?? result.error?.message ?? 'Not completed').slice(0, 200) });
  }
  if (done.length) await c.query(`UPDATE vl_alarms SET completed=true, completed_at=COALESCE(completed_at, now()), completed_by_portal=true, complete_error=NULL
    WHERE hotel_id=$1 AND alarm_id = ANY($2::text[])`, [cmd.hotel_id, done]);
  // Not completed: kept open with the reason; asked again after a day (the lock may need another look).
  for (const f of failed) await c.query(`UPDATE vl_alarms SET complete_error=$3 WHERE hotel_id=$1 AND alarm_id=$2`, [cmd.hotel_id, f.id, f.error]);
  await audit(c, { hotelId: cmd.hotel_id, actorType: 'connector', action: 'visionline.alarm_completed', targetType: 'command', targetId: cmd.id, correlationId: cmd.correlation_id,
    details: { completed: done, failed, reason: cmd.payload?.reason } });
}

/** Retry: completions that failed (Visionline busy, option missing) are asked again a day later. */
export async function releaseFailedCompletions() {
  await pool.query(`UPDATE vl_alarms SET complete_requested_at=NULL WHERE NOT completed AND complete_error IS NOT NULL AND complete_requested_at < now() - interval '24 hours'`);
  // A command that expired without an answer: ask again after an hour.
  await pool.query(`UPDATE vl_alarms SET complete_requested_at=NULL WHERE NOT completed AND complete_error IS NULL AND complete_requested_at < now() - interval '1 hour'`);
}

/** For the portal: the alarm list with what the portal did. */
export async function alarmOverview(hotelId: string, days = 30) {
  const cfg = await alarmsConfig(hotelId);
  const last = await one(pool, `SELECT created_at, completed_at, status, error FROM commands WHERE hotel_id=$1 AND type='READ_ALARMS' ORDER BY created_at DESC LIMIT 1`, [hotelId]);
  const rows = await many(pool, `SELECT a.alarm_id, COALESCE(a.type_name, a.alarm_type, 'Alarm') AS type, a.alarm_text, a.alarm_at, a.door_id, a.door_raw, a.card_holder,
      a.completed, a.completed_at, a.completed_by_portal, a.complete_requested_at, a.complete_reason, a.complete_error,
      r.name AS door_name, NULLIF(trim(concat_ws(' ', u.given_name, u.surname)), '') AS holder_name
    FROM vl_alarms a
    LEFT JOIN resources r ON r.hotel_id=a.hotel_id AND r.kind='door' AND r.external_id=a.door_id
    LEFT JOIN vl_users u ON u.hotel_id=a.hotel_id AND u.user_id=a.card_holder
    WHERE a.hotel_id=$1 AND COALESCE(a.alarm_at, a.received_at) > now() - make_interval(days => $2)
    ORDER BY COALESCE(a.alarm_at, a.received_at) DESC LIMIT 500`, [hotelId, days]);
  return {
    settings: cfg,
    lastRead: last ? { at: last.completed_at ?? last.created_at, status: last.status, error: last.error?.message ?? null } : null,
    alarms: rows.map((r) => ({
      id: r.alarm_id, type: r.type, text: r.alarm_text, at: r.alarm_at, door: r.door_name ?? r.door_raw, holder: r.holder_name ?? r.card_holder,
      kind: isExcessiveCardUsage(r.type, r.alarm_text) ? 'card' : isBatteryAlarm(r.type, r.alarm_text) ? 'battery' : 'lock',
      completed: r.completed, completedAt: r.completed_at, byPortal: r.completed_by_portal, requestedAt: r.complete_requested_at, reason: r.complete_reason, error: r.complete_error,
    })),
  };
}
