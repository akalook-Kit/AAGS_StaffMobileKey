import type pg from 'pg';
import { VL, batteryVoltsBelow, fromVisionlineLocal } from '@smk/shared/node';
import { one, many } from './db.ts';
import { audit } from './audit.ts';
import { getConfig } from './hotel-config.ts';
import { activity, changeStatus, createTicket, maintenancePolicy, notifyMaintenanceTeam, SYSTEM, type Actor, OPEN_STATUSES } from './maintenance.ts';

/**
 * Lock battery monitoring (spec Phase 2, §12.6). The only source is the locks' own battery events, read by the
 * connector's Visionline watch [Web API §7.14.1]: alarms (low / critical), exchanges and "below X volts" readings.
 * The Web API does not return a battery level on demand, and offline locks report only when their events reach
 * Visionline, so a door can stay "never reported" or go "stale".
 */
export type BatteryState = 'GOOD' | 'LOW' | 'CRITICAL' | 'REPORTED';
const B = VL.batteryEvents;

export const BATTERY_EVENT_NAMES: Record<number, string> = {
  53: 'Access denied due to battery alarm', 304: 'Battery level low', 305: 'Battery level critically low', 306: 'IR battery level low',
  307: 'IR battery critically low', 528: 'Battery exchanged', 529: 'Battery alarm in lock', 530: 'Battery status changed to Access Denied',
  531: 'IR battery alarm', 532: 'IR battery status changed to Access Denied', 533: 'Backup battery low', 534: 'Backup battery critically low',
  535: 'IR battery exchanged', 536: 'Backup battery exchanged', 0: 'Battery replaced (maintenance request)',
};
export const batteryEventName = (code: number) => {
  const v = batteryVoltsBelow(code);
  return v != null ? `Battery level below ${v.toFixed(1)} volts` : BATTERY_EVENT_NAMES[code] ?? `Event ${code}`;
};
export const isBatteryEvent = (code: number) => (VL.batteryEventCodes as readonly number[]).includes(code);

type VoltagePolicy = { highRange: { low: number | null; critical: number | null }; lowRange: { low: number | null; critical: number | null } };

/** What one battery event says about the battery. "REPORTED" = a voltage reading with no hotel threshold set. */
export function classify(code: number, voltage: VoltagePolicy): { state: BatteryState; volts: number | null } {
  if ((B.critical as readonly number[]).includes(code)) return { state: 'CRITICAL', volts: null };
  if ((B.low as readonly number[]).includes(code)) return { state: 'LOW', volts: null };
  if ((B.exchanged as readonly number[]).includes(code)) return { state: 'GOOD', volts: null };
  const volts = batteryVoltsBelow(code);
  if (volts == null) return { state: 'REPORTED', volts: null };
  const r = volts >= 6 ? voltage.highRange : voltage.lowRange;
  if (r.low == null && r.critical == null) return { state: 'REPORTED', volts };
  if (r.critical != null && volts <= r.critical) return { state: 'CRITICAL', volts };
  if (r.low != null && volts <= r.low) return { state: 'LOW', volts };
  return { state: 'GOOD', volts };
}

/** Maps the doorID in lock events (room number or door number) to the discovered door. */
export async function doorResolver(c: pg.PoolClient, hotelId: string) {
  const rows = await many(c, `SELECT external_id, name, data->>'doorID' AS door_no, data->>'doorGroup' AS g FROM resources WHERE hotel_id=$1 AND kind='door' AND active`, [hotelId]);
  const by = new Map<string, { id: string; name: string; group: string | null }>();
  for (const r of rows) {
    const d = { id: r.external_id, name: r.name, group: r.g };
    for (const k of [r.door_no, r.name, r.external_id]) if (k != null && k !== '') by.set(String(k), d);
  }
  return (doorID: unknown) => by.get(String(doorID ?? '')) ?? null;
}

export interface BatteryContext { tz: string; resolveDoor: Awaited<ReturnType<typeof doorResolver>>; policy: Awaited<ReturnType<typeof maintenancePolicy>> }

export async function batteryContext(c: pg.PoolClient, hotelId: string): Promise<BatteryContext | null> {
  const features = await getConfig(c, hotelId, 'features');
  if (!features?.batteryMonitoring) return null;
  const property = await getConfig(c, hotelId, 'property');
  return { tz: property?.timezone ?? 'UTC', resolveDoor: await doorResolver(c, hotelId), policy: await maintenancePolicy(c, hotelId) };
}

/** Apply one battery event. Called inside the batch transaction (hotel lock held). */
export async function applyBatteryEvent(c: pg.PoolClient, hotelId: string, ctx: BatteryContext, ev: { doorID?: unknown; eventCode: number; eventTime?: string; registrationNumber?: unknown }, visionlineEventId: number) {
  const door = ctx.resolveDoor(ev.doorID);
  const doorId = door?.id ?? String(ev.doorID ?? '?');
  const doorName = door?.name ?? doorId;
  let at = new Date();
  try { if (ev.eventTime) at = fromVisionlineLocal(ev.eventTime, ctx.tz); } catch { /* keep receipt time */ }
  if (at.getTime() > Date.now() + 5 * 60_000) at = new Date(); // a lock clock far ahead: do not trust it
  const { state, volts } = classify(ev.eventCode, ctx.policy.battery.voltage);
  const reg = ev.registrationNumber != null && String(ev.registrationNumber) !== '0' ? String(ev.registrationNumber) : null;
  await c.query(`INSERT INTO battery_readings (hotel_id, door_id, event_code, state, volts_below, reported_at, visionline_event_id, reporting_registration_number)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [hotelId, doorId, ev.eventCode, state, volts, at, visionlineEventId, reg]);

  const cur = await one(c, 'SELECT * FROM battery_status WHERE hotel_id=$1 AND door_id=$2 FOR UPDATE', [hotelId, doorId]);
  if (cur && new Date(cur.reported_at) > at) return { doorId, state, applied: false }; // older than what we know: history only
  // A voltage reading without thresholds does not clear an alarm.
  const newState: BatteryState = state === 'REPORTED' && cur && ['LOW', 'CRITICAL', 'GOOD'].includes(cur.state) ? cur.state : state;
  await c.query(`INSERT INTO battery_status (hotel_id, door_id, state, last_event_code, volts_below, reported_at, received_at) VALUES ($1,$2,$3,$4,$5,$6,now())
    ON CONFLICT (hotel_id, door_id) DO UPDATE SET state=EXCLUDED.state, last_event_code=EXCLUDED.last_event_code,
      volts_below=COALESCE(EXCLUDED.volts_below, battery_status.volts_below), reported_at=EXCLUDED.reported_at, received_at=now()`,
    [hotelId, doorId, newState, ev.eventCode, volts, at]);

  if (newState === 'LOW' || newState === 'CRITICAL') await raiseAlert(c, hotelId, ctx, doorId, doorName, door?.group ?? null, newState, ev.eventCode);
  else if (newState === 'GOOD') await clearAlert(c, hotelId, doorId, doorName, (B.exchanged as readonly number[]).includes(ev.eventCode)
    ? `${batteryEventName(ev.eventCode)} (event ${ev.eventCode})` : `Battery reading above the hotel's threshold (${batteryEventName(ev.eventCode)})`, SYSTEM);
  return { doorId, state: newState, applied: true };
}

async function raiseAlert(c: pg.PoolClient, hotelId: string, ctx: BatteryContext, doorId: string, doorName: string, group: string | null, severity: 'LOW' | 'CRITICAL', code: number) {
  const open = await one(c, `SELECT * FROM battery_alerts WHERE hotel_id=$1 AND door_id=$2 AND status IN ('OPEN','ACKNOWLEDGED') FOR UPDATE`, [hotelId, doorId]);
  const label = severity === 'CRITICAL' ? 'critically low' : 'low';
  let alert = open;
  if (open) {
    const escalate = open.severity === 'LOW' && severity === 'CRITICAL';
    alert = await one(c, `UPDATE battery_alerts SET occurrences=occurrences+1, last_seen_at=now(), severity=$2, status=CASE WHEN $3 THEN 'OPEN' ELSE status END WHERE id=$1 RETURNING *`,
      [open.id, escalate ? 'CRITICAL' : open.severity, escalate]);
    if (!escalate) return; // duplicate: counted, nobody is told again
    await audit(c, { hotelId, actorType: 'connector', action: 'battery.alert_escalated', targetType: 'door', targetId: doorId, details: { alertId: open.id, eventCode: code, event: batteryEventName(code) } });
    if (open.ticket_id) {
      await activity(c, hotelId, open.ticket_id, SYSTEM, 'battery', `The lock now reports the battery as critically low (${batteryEventName(code)}).`, { eventCode: code });
      await c.query(`UPDATE maintenance_tickets SET priority=CASE WHEN priority IN ('low','normal') THEN 'high' ELSE priority END, updated_at=now() WHERE id=$1`, [open.ticket_id]);
    }
  } else {
    alert = await one(c, `INSERT INTO battery_alerts (hotel_id, door_id, severity, status) VALUES ($1,$2,$3,'OPEN') RETURNING *`, [hotelId, doorId, severity]);
    await audit(c, { hotelId, actorType: 'connector', action: 'battery.alert_opened', targetType: 'door', targetId: doorId, details: { alertId: alert.id, severity, eventCode: code, event: batteryEventName(code) } });
  }
  await notifyMaintenanceTeam(c, hotelId, `Lock battery ${label}`, `${doorName}${group ? ` · ${group}` : ''}: ${batteryEventName(code)}.`);
  const auto = ctx.policy.battery.autoTicket;
  if (!alert.ticket_id && (auto === 'any' || (auto === 'critical' && severity === 'CRITICAL'))) {
    const t = await createTicket(c, hotelId, {
      title: `Replace lock battery: ${doorName}`, description: `The lock reported "${batteryEventName(code)}" (Visionline event ${code}).`,
      category: 'battery', priority: severity === 'CRITICAL' ? 'high' : 'normal', doorId: (await one(c, `SELECT 1 FROM resources WHERE hotel_id=$1 AND kind='door' AND external_id=$2`, [hotelId, doorId])) ? doorId : null,
      location: group ? `${doorName} · ${group}` : doorName, source: 'battery', batteryAlertId: alert.id,
    }, SYSTEM);
    await c.query('UPDATE battery_alerts SET ticket_id=$2 WHERE id=$1', [alert.id, t.id]);
  }
}

/** The battery is fine again: close the alert, and resolve its maintenance request if nobody has yet. */
async function clearAlert(c: pg.PoolClient, hotelId: string, doorId: string, doorName: string, reason: string, actor: Actor) {
  const open = await one(c, `SELECT * FROM battery_alerts WHERE hotel_id=$1 AND door_id=$2 AND status IN ('OPEN','ACKNOWLEDGED') FOR UPDATE`, [hotelId, doorId]);
  if (!open) return;
  await c.query(`UPDATE battery_alerts SET status='RESOLVED', resolved_at=now(), resolved_reason=$2 WHERE id=$1`, [open.id, reason]);
  await audit(c, { hotelId, actorType: actor.type === 'system' ? 'connector' : actor.type, actorId: actor.id, action: 'battery.alert_resolved', targetType: 'door', targetId: doorId, details: { alertId: open.id, reason } });
  if (!open.ticket_id) return;
  const t = await one(c, 'SELECT * FROM maintenance_tickets WHERE id=$1 FOR UPDATE', [open.ticket_id]);
  if (t && OPEN_STATUSES.includes(t.status)) {
    await activity(c, hotelId, t.id, SYSTEM, 'battery', `${doorName}: ${reason}.`);
    await c.query(`UPDATE maintenance_tickets SET status='RESOLVED', resolved_at=now(), resolution=$2, updated_at=now() WHERE id=$1`, [t.id, `Resolved automatically: ${reason}.`]);
    await activity(c, hotelId, t.id, SYSTEM, 'status', `Resolved automatically: ${reason}.`, { from: t.status, to: 'RESOLVED' });
  }
}

/** A battery maintenance request was resolved or closed by a person. */
export async function resolveAlertFromTicket(c: pg.PoolClient, hotelId: string, t: any, actor: Actor, batteryReplaced: boolean) {
  const alert = await one(c, `SELECT * FROM battery_alerts WHERE id=$1 AND status IN ('OPEN','ACKNOWLEDGED') FOR UPDATE`, [t.battery_alert_id]);
  if (!alert) return;
  const reason = batteryReplaced ? `Battery replaced (maintenance request #${t.number})` : `Maintenance request #${t.number} ${t.status === 'CLOSED' ? 'closed' : 'resolved'}`;
  await c.query(`UPDATE battery_alerts SET status='RESOLVED', resolved_at=now(), resolved_reason=$2 WHERE id=$1`, [alert.id, reason]);
  await audit(c, { hotelId, actorType: actor.type, actorId: actor.id, action: 'battery.alert_resolved', targetType: 'door', targetId: alert.door_id, details: { alertId: alert.id, reason, ticket: t.number } });
  if (batteryReplaced) {
    // Recorded as a reading so the door shows Good until the lock itself reports again.
    await c.query(`INSERT INTO battery_readings (hotel_id, door_id, event_code, state, reported_at) VALUES ($1,$2,0,'GOOD',now())`, [hotelId, alert.door_id]);
    await c.query(`INSERT INTO battery_status (hotel_id, door_id, state, last_event_code, reported_at) VALUES ($1,$2,'GOOD',0,now())
      ON CONFLICT (hotel_id, door_id) DO UPDATE SET state='GOOD', last_event_code=0, volts_below=NULL, reported_at=now(), received_at=now()`, [hotelId, alert.door_id]);
  }
}

export async function acknowledgeAlert(c: pg.PoolClient, hotelId: string, alertId: string, operatorId: string) {
  const a = await one(c, `UPDATE battery_alerts SET status='ACKNOWLEDGED', acknowledged_by=$3, acknowledged_at=now() WHERE hotel_id=$1 AND id=$2 AND status='OPEN' RETURNING *`, [hotelId, alertId, operatorId]);
  if (a) await audit(c, { hotelId, actorType: 'operator', actorId: operatorId, action: 'battery.alert_acknowledged', targetType: 'door', targetId: a.door_id, details: { alertId } });
  return a;
}

export async function resolveAlertManually(c: pg.PoolClient, hotelId: string, alertId: string, actor: Actor, reason: string, batteryReplaced: boolean) {
  const a = await one(c, `SELECT * FROM battery_alerts WHERE hotel_id=$1 AND id=$2 AND status IN ('OPEN','ACKNOWLEDGED') FOR UPDATE`, [hotelId, alertId]);
  if (!a) return null;
  if (a.ticket_id) {
    const t = await one(c, 'SELECT * FROM maintenance_tickets WHERE id=$1 FOR UPDATE', [a.ticket_id]);
    if (t && OPEN_STATUSES.includes(t.status)) {
      await changeStatus(c, hotelId, t, 'RESOLVED', actor, { manager: true, note: reason, batteryReplaced });
      return a;
    }
  }
  await resolveAlertFromTicket(c, hotelId, { battery_alert_id: a.id, number: '-', status: 'RESOLVED' }, actor, batteryReplaced);
  await c.query(`UPDATE battery_alerts SET resolved_reason=$2 WHERE id=$1`, [a.id, reason]);
  return a;
}
