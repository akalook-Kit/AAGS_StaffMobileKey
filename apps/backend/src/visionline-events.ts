import type pg from 'pg';
import type { VisionlineEventsBatch } from '@smk/shared';
import { one, tx, lockHotel, pool } from './db.ts';
import { audit } from './audit.ts';
import { getConfig } from './hotel-config.ts';
import { enqueueRevoke, notify } from './keys.ts';
import { applyBatteryEvent, batteryContext, isBatteryEvent, type BatteryContext } from './battery.ts';
import { onLockEvent } from './monitoring/monitor.ts';
import { recordDoorEntrance } from './attendance/service.ts';
import { fromVisionlineLocal } from '@smk/shared/node';

const LIVE = ['QUEUED', 'ISSUING', 'ISSUED', 'REVOKING'];
/** Lock event names the portal shows [Web API §7.14.1]. */
export const EVENT_NAMES: Record<number, string> = {
  53: 'Access denied due to battery alarm', 64: 'Staff card accepted', 320: 'No access to this room', 322: 'Card has expired', 323: 'Card can only access common rooms',
  325: 'Access at this time not allowed', 327: 'Blocked by anti-passback', 368: 'Card is cancelled', 369: 'User group is blocked',
};

/**
 * Applies what the connector saw in Visionline (hotel decision, 13 Oct):
 *  - a key's card cancelled or discarded in Visionline → the key is revoked and leaves the app;
 *  - overridden (a newer card for the same person) or expired → the key ends;
 *  - refused at a door that is not on the key (events 320/323 by default) → counted; after more than the
 *    hotel's limit (5) the card is cancelled in Visionline automatically ("wandering").
 * Repeats are ignored: cards by content (catch-up overlaps the callback), events by batch id + position (re-sent
 * batches). Visionline itself folds repeats within one minute into one event with repeatFlags [§7.14.1].
 */
export async function processVisionlineBatch(hotelId: string, b: VisionlineEventsBatch) {
  const summary = { cards: 0, events: 0, revoked: 0, wrongDoor: 0, autoCancelled: 0, ignored: 0, battery: 0 };
  const seen: { doorId: string | null; code: number; reg: string | null }[] = [];
  let entranceCodes: number[] = [64];
  let tz = 'UTC';
  await tx(async (c) => {
    await lockHotel(c, hotelId);
    const policy = await getConfig(c, hotelId, 'policy');
    const codes: number[] = policy?.wrongDoorEventCodes ?? [320, 323];
    const limit: number = policy?.wrongDoorLimit ?? 5;
    entranceCodes = policy?.eventLog?.entranceEventCodes ?? [64];
    tz = (await getConfig(c, hotelId, 'property'))?.timezone ?? 'UTC';
    let battery: BatteryContext | null | undefined;

    for (const card of b.cards) {
      const status = card.status ?? (card.cancelled ? 0 : undefined);
      const row = await one(c, `INSERT INTO visionline_events (hotel_id, batch_id, source, kind, registration_number, card_status, event_time, dedupe)
        VALUES ($1,$2,$3,'card',$4,$5,$6,$7) ON CONFLICT (hotel_id, dedupe) DO NOTHING RETURNING id`,
        [hotelId, b.batchId, b.source, card.registrationNumber, status ?? null, card.cancelTime || null, `card:${card.registrationNumber}:${status ?? '?'}:${card.cancelTime ?? ''}`]);
      if (!row) { summary.ignored++; continue; }
      summary.cards++;
      const key = await keyByRegNo(c, hotelId, card.registrationNumber);
      if (!key) continue; // a card the platform did not issue (e.g. a plastic staff card)
      await c.query('UPDATE visionline_events SET key_id=$2 WHERE id=$1', [row.id, key.id]);
      if (!LIVE.includes(key.status)) continue;
      if (status === 0 || status === 6) {
        const ours = key.status === 'REVOKING';
        await c.query(`UPDATE key_requests SET status='REVOKED', revoke_source=COALESCE(revoke_source, $2), revoke_reason=COALESCE(revoke_reason, $3), updated_at=now() WHERE id=$1`,
          [key.id, ours ? 'operator' : 'visionline', status === 6 ? 'Card discarded in Visionline' : 'Card cancelled in Visionline']);
        await audit(c, { hotelId, actorType: 'connector', action: ours ? 'key.revoke_confirmed_by_visionline' : 'key.cancelled_in_visionline', targetType: 'key_request', targetId: key.id, correlationId: key.correlation_id, details: { regNo: card.registrationNumber, status, cancelTime: card.cancelTime } });
        if (!ours && key.revoke_source !== 'wrong_door') await notify(c, hotelId, key.staff_id, 'Key removed', 'Your mobile key was cancelled in the hotel lock system.');
        summary.revoked++;
      } else if (status === 2) {
        await c.query(`UPDATE key_requests SET status='REVOKED', revoke_source=COALESCE(revoke_source, $2), revoke_reason=COALESCE(revoke_reason, 'Replaced by a newer card in Visionline'), updated_at=now() WHERE id=$1`,
          [key.id, key.replaced_by_key_id ? 'replaced' : 'visionline']);
        await audit(c, { hotelId, actorType: 'connector', action: 'key.overridden_in_visionline', targetType: 'key_request', targetId: key.id, correlationId: key.correlation_id, details: { regNo: card.registrationNumber, replacedBy: key.replaced_by_key_id } });
        summary.revoked++;
      } else if (status === 4) {
        await c.query(`UPDATE key_requests SET status='EXPIRED', updated_at=now() WHERE id=$1`, [key.id]);
      }
    }

    for (const [i, ev] of b.events.entries()) {
      const reg = ev.registrationNumber;
      const row = await one(c, `INSERT INTO visionline_events (hotel_id, batch_id, source, kind, registration_number, event_code, door_id, event_time, dedupe)
        VALUES ($1,$2,$3,'event',$4,$5,$6,$7,$8) ON CONFLICT (hotel_id, dedupe) DO NOTHING RETURNING id`,
        [hotelId, b.batchId, b.source, reg ?? null, ev.eventCode, ev.doorID ?? null, ev.eventTime ?? null, `event:${b.batchId}:${i}`]);
      if (!row) { summary.ignored++; continue; }
      summary.events++;
      seen.push({ id: String(row.id), doorId: ev.doorID ?? null, code: ev.eventCode, reg: reg && reg !== '0' ? reg : null, time: ev.eventTime ?? null } as any);
      if (isBatteryEvent(ev.eventCode)) {
        // Phase 2: battery alarms and readings (only while the hotel has battery monitoring switched on).
        if (battery === undefined) battery = await batteryContext(c, hotelId);
        if (battery) { await applyBatteryEvent(c, hotelId, battery, ev, Number(row.id)); summary.battery++; }
      }
      if (!reg || reg === '0') continue; // not caused by a card [§7.14.1 note]
      const key = await keyByRegNo(c, hotelId, reg);
      if (!key) continue;
      await c.query('UPDATE visionline_events SET key_id=$2 WHERE id=$1', [row.id, key.id]);
      if (!codes.includes(ev.eventCode) || !['ISSUING', 'ISSUED'].includes(key.status)) continue;
      const n = (await one(c, 'UPDATE key_requests SET wrong_door_count=wrong_door_count+1 WHERE id=$1 RETURNING wrong_door_count', [key.id]))!.wrong_door_count as number;
      summary.wrongDoor++;
      await audit(c, { hotelId, actorType: 'connector', action: 'key.wrong_door_attempt', targetType: 'key_request', targetId: key.id, correlationId: key.correlation_id, details: { door: ev.doorID, eventCode: ev.eventCode, event: EVENT_NAMES[ev.eventCode], eventTime: ev.eventTime, count: n, limit } });
      if (limit > 0 && n > limit) {
        const reason = `Cancelled automatically after ${n} attempts at doors that are not on the key (limit ${limit})`;
        await c.query(`UPDATE key_requests SET status='REVOKING', revoke_source='wrong_door', revoke_method='cancelCard', revoke_reason=$2, updated_at=now() WHERE id=$1`, [key.id, reason]);
        await enqueueRevoke(c, key, null, 'cancelCard');
        await audit(c, { hotelId, actorType: 'system', action: 'key.wrong_door_limit_reached', targetType: 'key_request', targetId: key.id, correlationId: key.correlation_id, details: { count: n, limit, action: 'cancel card in Visionline' } });
        await notify(c, hotelId, key.staff_id, 'Key cancelled', 'Your key was cancelled after repeated attempts at doors that are not on it. Please contact your supervisor.');
        summary.autoCancelled++;
      }
    }
  });
  // Watched (VIP) doors: announced after the batch is saved, outside the hotel lock (sending can take seconds).
  for (const e of seen as any[]) {
    if (!entranceCodes.includes(e.code)) continue;
    try {
      const person = e.reg ? (await one(pool, `SELECT COALESCE(s.full_name, (SELECT NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), '') FROM vl_cards vc JOIN vl_users u ON u.hotel_id=vc.hotel_id AND u.user_id=vc.card_holder WHERE vc.hotel_id=$1 AND vc.reg_no=$2 LIMIT 1)) AS n
          FROM (SELECT 1) x LEFT JOIN key_requests k ON k.hotel_id=$1 AND (k.card_reg_no=$2 OR (k.card_reg_no IS NULL AND k.credential_id=$2)) LEFT JOIN staff s ON s.id=k.staff_id ORDER BY k.created_at DESC NULLS LAST LIMIT 1`, [hotelId, e.reg]))?.n ?? null : null;
      let at = new Date();
      if (e.time) { try { at = fromVisionlineLocal(e.time, tz); } catch { /* keep now */ } }
      await onLockEvent(hotelId, { doorId: e.doorId, code: e.code, person, at }, entranceCodes);
      // 2.8 Time & attendance: entrances at the attendance doors are clock records.
      await recordDoorEntrance(hotelId, { eventId: e.id, doorId: e.doorId, reg: e.reg, at });
    } catch (err) { console.error('[monitor] watched door', (err as Error).message); }
  }
  return summary;
}

async function keyByRegNo(c: pg.PoolClient, hotelId: string, regNo: string) {
  // Callbacks and lock events carry the card registration number (§7.14). Keys created before the connector
  // looked it up only have the credentialID, which is tried second.
  return (await one(c, `SELECT * FROM key_requests WHERE hotel_id=$1 AND card_reg_no=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [hotelId, String(regNo)]))
    ?? one(c, `SELECT * FROM key_requests WHERE hotel_id=$1 AND credential_id=$2 AND card_reg_no IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [hotelId, String(regNo)]);
}
