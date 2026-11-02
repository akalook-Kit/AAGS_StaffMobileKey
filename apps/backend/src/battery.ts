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
/** 2.18 The highest "below X volts" step of each scale: what a lock reads with new batteries. */
export const isFullReading = (volts: number) => Math.abs(volts - 4.8) < 1e-6 || Math.abs(volts - 9.0) < 1e-6;
/** 2.19 The reading that confirms a battery alarm after new batteries: the hotel's Low threshold, else its Critical
 *  threshold, else the level at which the locks raise their own alarm (4.0 V; 7.2 V for 6-9 V packs). */
export function confirmLowVolts(volts: number, v: VoltagePolicy) {
  const r = volts >= 6 ? v.highRange : v.lowRange;
  return r.low ?? r.critical ?? (volts >= 6 ? 7.2 : 4.0);
}
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
  const cls = classify(ev.eventCode, ctx.policy.battery.voltage);
  const volts = cls.volts;
  const state: BatteryState = volts != null && ctx.policy.battery.fullReadingMeansNew !== false && isFullReading(volts) ? 'GOOD' : cls.state;
  const reg = ev.registrationNumber != null && String(ev.registrationNumber) !== '0' ? String(ev.registrationNumber) : null;

  // 2.15 Was this a battery change? "Battery exchanged", or a "below X volts" reading that jumped up at once.
  const exchanged = (B.exchanged as readonly number[]).includes(ev.eventCode);
  let change: { source: 'event' | 'inferred'; detail: string } | null = exchanged ? { source: 'event', detail: `${batteryEventName(ev.eventCode)} (event ${ev.eventCode})` } : null;
  if (!change && volts != null) {
    const prev = await one(c, `SELECT volts_below FROM battery_readings WHERE hotel_id=$1 AND door_id=$2 AND volts_below IS NOT NULL AND reported_at < $3 ORDER BY reported_at DESC, id DESC LIMIT 1`, [hotelId, doorId, at]);
    const before = prev ? Number(prev.volts_below) : null;
    // Same battery range only (a 4.5 V reading after a 6.5 V one is a different battery pack, not a change).
    if (before != null && (before >= 6) === (volts >= 6) && volts - before >= ctx.policy.battery.changeJumpVolts - 1e-9)
      change = { source: 'inferred', detail: `Battery level rose from ${before.toFixed(1)} V to ${volts.toFixed(1)} V` };
  }
  // 2.18 New batteries read at the top of the scale ("below 4.8 V", or "below 9.0 V" for 6-9 V packs). Such a reading
  // means the batteries were replaced: the alarm and its maintenance request close by themselves.
  const full = volts != null && ctx.policy.battery.fullReadingMeansNew !== false && isFullReading(volts);
  if (full && !change) {
    const prev = await one(c, `SELECT state, volts_below FROM battery_status WHERE hotel_id=$1 AND door_id=$2`, [hotelId, doorId]);
    const open = await one(c, `SELECT 1 FROM battery_alerts WHERE hotel_id=$1 AND door_id=$2 AND status IN ('OPEN','ACKNOWLEDGED')`, [hotelId, doorId]);
    const lower = prev?.volts_below != null && (Number(prev.volts_below) >= 6) === (volts! >= 6) && Number(prev.volts_below) < volts!;
    if (open || ['LOW', 'CRITICAL'].includes(prev?.state) || lower)
      change = { source: 'inferred', detail: `New batteries: the lock reads ${volts!.toFixed(1)} V, the top of its scale` };
  }
  // 2.19 (Armel, 27 Oct) A battery alarm from the lock after new batteries is a firmware fault, even if it comes only
  // once, unless a voltage reading since the change confirms low batteries. It is not a battery problem: no battery
  // alert, no "replace battery" request, the battery stays Good; the lock gets "Program the lock and upload firmware".
  // From 10 minutes before the change (same-minute events are listed in any order) to stillAlarmingDays after it.
  if (!change && volts == null && (state === 'LOW' || state === 'CRITICAL')) {
    const st = await one(c, 'SELECT * FROM battery_status WHERE hotel_id=$1 AND door_id=$2 FOR UPDATE', [hotelId, doorId]);
    const since = st?.last_change_at ? new Date(st.last_change_at) : null;
    const days = ctx.policy.battery.stillAlarmingDays;
    if (since && days > 0 && at.getTime() >= since.getTime() - 10 * 60_000 && at.getTime() - since.getTime() <= days * 86_400_000) {
      const conf = await one(c, `SELECT volts_below FROM battery_readings WHERE hotel_id=$1 AND door_id=$2 AND volts_below IS NOT NULL AND reported_at >= $3 AND reported_at <= $4
        ORDER BY reported_at DESC, id DESC LIMIT 1`, [hotelId, doorId, since, at]);
      if (!(conf && Number(conf.volts_below) <= confirmLowVolts(Number(conf.volts_below), ctx.policy.battery.voltage) + 1e-6)) {
        await c.query(`INSERT INTO battery_readings (hotel_id, door_id, event_code, state, volts_below, reported_at, visionline_event_id, reporting_registration_number, change_inferred)
          VALUES ($1,$2,$3,'REPORTED',NULL,$4,$5,$6,false)`, [hotelId, doorId, ev.eventCode, at, visionlineEventId, reg]);
        await audit(c, { hotelId, actorType: 'connector', action: 'battery.firmware_suspected', targetType: 'door', targetId: doorId,
          details: { eventCode: ev.eventCode, event: batteryEventName(ev.eventCode), at: at.toISOString(), batteriesChanged: since.toISOString(), lastReading: conf ? Number(conf.volts_below) : null } });
        await raiseReprogram(c, hotelId, doorId, doorName, door?.group ?? null, st, ev.eventCode, at, null);
        return { doorId, state: st.state as BatteryState, applied: false };
      }
    }
  }
  await c.query(`INSERT INTO battery_readings (hotel_id, door_id, event_code, state, volts_below, reported_at, visionline_event_id, reporting_registration_number, change_inferred)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [hotelId, doorId, ev.eventCode, state, volts, at, visionlineEventId, reg, change?.source === 'inferred']);

  const cur = await one(c, 'SELECT * FROM battery_status WHERE hotel_id=$1 AND door_id=$2 FOR UPDATE', [hotelId, doorId]);
  if (cur && new Date(cur.reported_at) > at) { // older than what we know: history only (but a late-reported change still counts)
    if (change) await noteChange(c, hotelId, doorId, at, change.source, change.detail);
    return { doorId, state, applied: false };
  }
  // A voltage reading without thresholds does not clear an alarm, unless it shows that the batteries were changed.
  const newState: BatteryState = state === 'REPORTED' && change ? 'GOOD'
    : state === 'REPORTED' && cur && ['LOW', 'CRITICAL', 'GOOD'].includes(cur.state) ? cur.state : state;
  await c.query(`INSERT INTO battery_status (hotel_id, door_id, state, last_event_code, volts_below, reported_at, received_at) VALUES ($1,$2,$3,$4,$5,$6,now())
    ON CONFLICT (hotel_id, door_id) DO UPDATE SET state=EXCLUDED.state, last_event_code=EXCLUDED.last_event_code,
      volts_below=COALESCE(EXCLUDED.volts_below, battery_status.volts_below), reported_at=EXCLUDED.reported_at, received_at=now()`,
    [hotelId, doorId, newState, ev.eventCode, volts, at]);
  if (change) await noteChange(c, hotelId, doorId, at, change.source, change.detail);

  if (newState === 'LOW' || newState === 'CRITICAL') {
    // 2.15 Still alarming after the batteries were changed: the lock needs programming and a firmware upload,
    // not another battery (so no "Replace lock battery" request is opened).
    const days = ctx.policy.battery.stillAlarmingDays;
    const since = cur?.last_change_at ? new Date(cur.last_change_at) : null;
    const still = days > 0 && since != null && at.getTime() > since.getTime() + 2 * 60_000 && at.getTime() - since.getTime() <= days * 86_400_000;
    const alert = await raiseAlert(c, hotelId, ctx, doorId, doorName, door?.group ?? null, newState, ev.eventCode, still);
    if (still) await raiseReprogram(c, hotelId, doorId, doorName, door?.group ?? null, cur, ev.eventCode, at, alert);
  } else if (newState === 'GOOD') await clearAlert(c, hotelId, doorId, doorName, change ? change.detail
    : `Battery reading above the hotel's threshold (${batteryEventName(ev.eventCode)})`, SYSTEM);
  return { doorId, state: newState, applied: true };
}

/** Remember the newest battery change of a door (and forget the "program the lock" request of an older change). */
async function noteChange(c: pg.PoolClient, hotelId: string, doorId: string, at: Date, source: 'event' | 'inferred' | 'maintenance', detail: string) {
  const r = await c.query(`UPDATE battery_status SET last_change_at=$3, last_change_source=$4, last_change_detail=$5, reprogram_ticket_id=NULL, reprogram_at=NULL
    WHERE hotel_id=$1 AND door_id=$2 AND (last_change_at IS NULL OR last_change_at < $3)`, [hotelId, doorId, at, source, detail]);
  if (r.rowCount) await audit(c, { hotelId, actorType: source === 'maintenance' ? 'system' : 'connector', action: 'battery.changed', targetType: 'door', targetId: doorId,
    details: { at: at.toISOString(), source, detail } });
}

export const REPROGRAM_ADVICE = 'The batteries were changed but the lock still reports a battery alarm. Program the lock and upload its firmware with the '
  + 'service tool (portable programming unit / LockLink), then check that the alarm has cleared. Changing batteries in good time, before '
  + 'they are critically low, avoids this.';

async function raiseReprogram(c: pg.PoolClient, hotelId: string, doorId: string, doorName: string, group: string | null, cur: any, code: number, at: Date, alert: any) {
  if (cur.reprogram_ticket_id) {
    const t = await one(c, 'SELECT id, status FROM maintenance_tickets WHERE id=$1', [cur.reprogram_ticket_id]);
    if (t && OPEN_STATUSES.includes(t.status)) return; // already asked
  }
  const changed = new Date(cur.last_change_at).toISOString().slice(0, 16).replace('T', ' ');
  const known = await one(c, `SELECT 1 FROM resources WHERE hotel_id=$1 AND kind='door' AND external_id=$2`, [hotelId, doorId]);
  const t = await createTicket(c, hotelId, {
    title: `Program lock and upload firmware: ${doorName}`,
    description: `${REPROGRAM_ADVICE}\n\nBatteries changed: ${changed} UTC (${cur.last_change_detail ?? cur.last_change_source}). Alarm afterwards: ${batteryEventName(code)} (event ${code}).`,
    category: 'lock', priority: 'high', doorId: known ? doorId : null, location: group ? `${doorName} · ${group}` : doorName, source: 'battery',
    batteryAlertId: alert && !alert.ticket_id ? alert.id : null,
  }, SYSTEM);
  if (alert && !alert.ticket_id) await c.query('UPDATE battery_alerts SET ticket_id=$2 WHERE id=$1', [alert.id, t.id]);
  await c.query('UPDATE battery_status SET reprogram_ticket_id=$3, reprogram_at=$4 WHERE hotel_id=$1 AND door_id=$2', [hotelId, doorId, t.id, at]);
  await audit(c, { hotelId, actorType: 'connector', action: 'battery.reprogram_requested', targetType: 'door', targetId: doorId, details: { ticket: t.number, eventCode: code, changedAt: cur.last_change_at } });
  await notifyMaintenanceTeam(c, hotelId, 'Program the lock and upload firmware', `${doorName}${group ? ` · ${group}` : ''}: batteries were changed but the lock still alarms.`);
}

async function raiseAlert(c: pg.PoolClient, hotelId: string, ctx: BatteryContext, doorId: string, doorName: string, group: string | null, severity: 'LOW' | 'CRITICAL', code: number, noReplaceTicket = false): Promise<any> {
  const open = await one(c, `SELECT * FROM battery_alerts WHERE hotel_id=$1 AND door_id=$2 AND status IN ('OPEN','ACKNOWLEDGED') FOR UPDATE`, [hotelId, doorId]);
  const label = severity === 'CRITICAL' ? 'critically low' : 'low';
  let alert = open;
  if (open) {
    const escalate = open.severity === 'LOW' && severity === 'CRITICAL';
    alert = await one(c, `UPDATE battery_alerts SET occurrences=occurrences+1, last_seen_at=now(), severity=$2, status=CASE WHEN $3 THEN 'OPEN' ELSE status END WHERE id=$1 RETURNING *`,
      [open.id, escalate ? 'CRITICAL' : open.severity, escalate]);
    if (!escalate) return alert; // duplicate: counted, nobody is told again
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
  if (!noReplaceTicket && !alert.ticket_id && (auto === 'any' || (auto === 'critical' && severity === 'CRITICAL'))) {
    const t = await createTicket(c, hotelId, {
      title: `Replace lock battery: ${doorName}`, description: `The lock reported "${batteryEventName(code)}" (Visionline event ${code}).`,
      category: 'battery', priority: severity === 'CRITICAL' ? 'high' : 'normal', doorId: (await one(c, `SELECT 1 FROM resources WHERE hotel_id=$1 AND kind='door' AND external_id=$2`, [hotelId, doorId])) ? doorId : null,
      location: group ? `${doorName} · ${group}` : doorName, source: 'battery', batteryAlertId: alert.id,
    }, SYSTEM);
    await c.query('UPDATE battery_alerts SET ticket_id=$2 WHERE id=$1', [alert.id, t.id]);
    alert.ticket_id = t.id;
  }
  return alert;
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
    await noteChange(c, hotelId, alert.door_id, new Date(), 'maintenance', reason);
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
