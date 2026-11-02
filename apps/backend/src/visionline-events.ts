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
  const reRead = new Set<string>();
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
    // 2.10 Every keycard Visionline reports (made, changed, cancelled at the desk) is recorded straight away when the
    // hotel reads its people and cards; the holder is then re-read for the card's doors and validity.
    const vlCfg = await getConfig(c, hotelId, 'visionline');
    const recordCards = Boolean(vlCfg?.directorySync?.enabled);

    for (const card of b.cards) {
      const status = card.status ?? (card.cancelled ? 0 : undefined);
      const row = await one(c, `INSERT INTO visionline_events (hotel_id, batch_id, source, kind, registration_number, card_status, event_time, dedupe)
        VALUES ($1,$2,$3,'card',$4,$5,$6,$7) ON CONFLICT (hotel_id, dedupe) DO NOTHING RETURNING id`,
        [hotelId, b.batchId, b.source, card.registrationNumber, status ?? null, card.cancelTime || null, `card:${card.registrationNumber}:${status ?? '?'}:${card.cancelTime ?? ''}`]);
      if (!row) { summary.ignored++; continue; }
      summary.cards++;
      if (recordCards) {
        const st = status;
        const holder = card.cardHolder && card.cardHolder !== '0' ? card.cardHolder : null;
        const valid = st === undefined || st === 1;
        let exp: Date | null = null;
        if (card.expireTime) { try { exp = fromVisionlineLocal(card.expireTime, tz); } catch { exp = null; } }
        await c.query(`INSERT INTO vl_cards (hotel_id, reg_no, card_holder, expires_at, cancelled, discarded, overridden, expired, not_issued, key_id, active, source, last_seen_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,(SELECT id FROM key_requests WHERE hotel_id=$1 AND card_reg_no=$2 ORDER BY created_at DESC LIMIT 1),$10,'live',now())
          ON CONFLICT (hotel_id, reg_no) DO UPDATE SET card_holder=COALESCE(EXCLUDED.card_holder, vl_cards.card_holder), expires_at=COALESCE(EXCLUDED.expires_at, vl_cards.expires_at),
            cancelled=EXCLUDED.cancelled, discarded=EXCLUDED.discarded, overridden=EXCLUDED.overridden, expired=EXCLUDED.expired, not_issued=EXCLUDED.not_issued,
            key_id=COALESCE(vl_cards.key_id, EXCLUDED.key_id), active=EXCLUDED.active, last_seen_at=now()`,
          [hotelId, card.registrationNumber, holder, exp, st === 0, st === 6, st === 2 || st === 5, st === 4, st === 3, valid]);
        if (holder) await c.query(`UPDATE vl_cards k SET user_group=u.user_group FROM vl_users u WHERE k.hotel_id=$1 AND k.reg_no=$2 AND u.hotel_id=k.hotel_id AND u.user_id=k.card_holder`, [hotelId, card.registrationNumber]);
        if (holder && valid) reRead.add(holder);
      }
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
  // 2.10 Re-read the holders of new or changed cards (doors, validity, name, group), a few seconds later.
  if (reRead.size) {
    try { await (await import('./directory.ts')).requestDirectorySync(hotelId, null, { userIds: [...reRead] }); }
    catch { /* connector busy with a full sync (it reads them anyway) or an older connector: the next sync catches up */ }
  }
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
