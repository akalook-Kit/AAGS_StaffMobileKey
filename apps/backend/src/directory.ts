import { fromVisionlineLocal } from '@smk/shared/node';
import type { DirectoryChunk } from '@smk/shared';
import { pool, tx, one, many, lockHotel } from './db.ts';
import { audit } from './audit.ts';
import { getConfig } from './hotel-config.ts';
import { enqueue, newCorrelationId } from './commands.ts';
import { doorResolver } from './battery.ts';
import { ApiError } from './lib/errors.ts';
import { isOnline } from './routes/portal.ts';

/**
 * Visionline directory snapshot for management reports (opt-in, read-only). The connector streams parts to
 * /connector/v1/directory while it reads; the last part completes the snapshot. People and cards that were not
 * seen in the latest complete snapshot are marked inactive, so the reports always show the current state.
 */
const SYNC_TTL_SEC = 40 * 60;

export async function requestDirectorySync(hotelId: string, operatorId: string | null) {
  const vl = await getConfig(pool, hotelId, 'visionline');
  const ds = vl?.directorySync;
  if (!ds?.enabled) throw new ApiError(409, 'SYNC_OFF', 'Reading people and keycards from Visionline is switched off (Settings → Reports & sync).');
  const conn = await one(pool, `SELECT id, last_seen_at, health FROM connectors WHERE hotel_id=$1 AND status='ACTIVE' AND health->'capabilities' ? 'directory-sync'
    ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [hotelId]);
  if (!conn) throw new ApiError(409, 'CONNECTOR_CAPABILITY', 'Reports need connector 0.6.0 or newer. Update the connector on the Visionline PC.');
  if (!isOnline(conn.last_seen_at)) throw new ApiError(409, 'CONNECTOR_OFFLINE', 'The hotel connector is offline.');
  const running = await one(pool, `SELECT id FROM directory_syncs WHERE hotel_id=$1 AND status='RUNNING' AND started_at > now() - make_interval(secs => $2)`, [hotelId, SYNC_TTL_SEC]);
  if (running) return { syncId: running.id as string, alreadyRunning: true };
  const last = await one(pool, `SELECT max(updated_at) AS t FROM vl_alarms WHERE hotel_id=$1`, [hotelId]);
  const alarmsSince = last?.t ? new Date(new Date(last.t).getTime() - 3600_000).toISOString() : new Date(Date.now() - 30 * 86_400_000).toISOString();
  const payload = {
    userGroups: ds.scope === 'all' ? null : (vl.userGroups ?? []), includeCards: ds.includeCards, includeAlarms: ds.includeAlarms, alarmsSince, maxUsers: ds.maxUsers,
  };
  return tx(async (c) => {
    await lockHotel(c, hotelId);
    const cmd = await enqueue(c, { hotelId, type: 'SYNC_DIRECTORY', payload, idempotencyKey: `directory:${Date.now()}`, correlationId: newCorrelationId(), ttlSec: SYNC_TTL_SEC });
    await c.query(`INSERT INTO directory_syncs (id, hotel_id, requested_by) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [cmd.id, hotelId, operatorId]);
    await audit(c, { hotelId, actorType: operatorId ? 'operator' : 'system', actorId: operatorId, action: 'directory.sync_requested', targetType: 'command', targetId: cmd.id, details: { scope: ds.scope, includeCards: ds.includeCards, includeAlarms: ds.includeAlarms } });
    return { syncId: cmd.id as string, alreadyRunning: false };
  });
}

const toUtc = (local: string | null, tz: string) => { if (!local) return null; try { return fromVisionlineLocal(local, tz); } catch { return null; } };
/** "20261013T153012" in UTC (alarm updateTime, §5.4.2). */
const fromUtcCompact = (s: string | null) => {
  const m = s ? /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2}):?(\d{2})?/.exec(s) : null;
  return m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0))) : null;
};

export async function applyDirectoryChunk(hotelId: string, ch: DirectoryChunk) {
  return tx(async (c) => {
    await lockHotel(c, hotelId);
    const sync = await one(c, `SELECT * FROM directory_syncs WHERE id=$1 AND hotel_id=$2 FOR UPDATE`, [ch.syncId, hotelId]);
    if (!sync) throw new ApiError(404, 'NOT_FOUND', 'Unknown directory sync');
    if (sync.status !== 'RUNNING') return { ok: true, ignored: true };
    const tz = (await getConfig(c, hotelId, 'property'))?.timezone ?? 'UTC';

    for (const u of ch.users) {
      await c.query(`INSERT INTO vl_users (hotel_id, user_id, surname, given_name, user_group, seen_sync, active, last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,true,now())
        ON CONFLICT (hotel_id, user_id) DO UPDATE SET surname=EXCLUDED.surname, given_name=EXCLUDED.given_name, user_group=EXCLUDED.user_group, seen_sync=EXCLUDED.seen_sync, active=true, last_seen_at=now()`,
        [hotelId, u.id, u.surname, u.givenName, u.userGroup, ch.syncId]);
    }
    for (const k of ch.cards) {
      await c.query(`INSERT INTO vl_cards (hotel_id, reg_no, card_holder, format, starts_at, expires_at, cancelled, discarded, overridden, expired, not_issued, issued_count,
          door_count, doors, door_groups, time_schedule, key_id, seen_sync, active, last_seen_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,(SELECT id FROM key_requests WHERE hotel_id=$1 AND card_reg_no=$2 ORDER BY created_at DESC LIMIT 1),$17,true,now())
        ON CONFLICT (hotel_id, reg_no) DO UPDATE SET card_holder=EXCLUDED.card_holder, format=EXCLUDED.format, starts_at=EXCLUDED.starts_at, expires_at=EXCLUDED.expires_at,
          cancelled=EXCLUDED.cancelled, discarded=EXCLUDED.discarded, overridden=EXCLUDED.overridden, expired=EXCLUDED.expired, not_issued=EXCLUDED.not_issued,
          issued_count=EXCLUDED.issued_count, door_count=EXCLUDED.door_count, doors=EXCLUDED.doors, door_groups=EXCLUDED.door_groups, time_schedule=EXCLUDED.time_schedule,
          key_id=EXCLUDED.key_id, seen_sync=EXCLUDED.seen_sync, active=true, last_seen_at=now()`,
        [hotelId, k.regNo, k.cardHolder, k.format, toUtc(k.startTime, tz), toUtc(k.expireTime, tz), k.cancelled, k.discarded, k.overridden, k.expired, k.notIssued, k.issuedCount,
          k.doors.length, k.doors, k.doorGroups, k.timeSchedule, ch.syncId]);
    }
    if (ch.alarms.length) {
      const resolve = await doorResolver(c, hotelId);
      for (const a of ch.alarms) {
        await c.query(`INSERT INTO vl_alarms (hotel_id, alarm_id, alarm_type, type_name, alarm_text, alarm_at, door_id, door_raw, card_holder, completed, completed_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (hotel_id, alarm_id) DO UPDATE SET completed=EXCLUDED.completed, completed_at=EXCLUDED.completed_at, updated_at=EXCLUDED.updated_at, alarm_text=EXCLUDED.alarm_text,
            type_name=COALESCE(EXCLUDED.type_name, vl_alarms.type_name), received_at=now()`,
          [hotelId, a.id, a.alarmType, a.alarmTypeName, a.alarmText, toUtc(a.alarmTime, tz), a.door ? resolve(a.door)?.id ?? null : null, a.door, a.cardHolder, a.completed,
            toUtc(a.completionTime, tz), fromUtcCompact(a.updateTime)]);
      }
    }
    await c.query(`UPDATE directory_syncs SET users=users+$2, cards=cards+$3, alarms=alarms+$4 WHERE id=$1`, [ch.syncId, ch.users.length, ch.cards.length, ch.alarms.length]);

    if (ch.final) {
      // Complete snapshot: everything not seen this time is no longer in Visionline (or no longer valid).
      await c.query(`UPDATE vl_users SET active=false WHERE hotel_id=$1 AND active AND seen_sync IS DISTINCT FROM $2`, [hotelId, ch.syncId]);
      await c.query(`UPDATE vl_cards SET active=false WHERE hotel_id=$1 AND active AND seen_sync IS DISTINCT FROM $2`, [hotelId, ch.syncId]);
      await c.query(`UPDATE vl_cards k SET user_group=u.user_group FROM vl_users u WHERE k.hotel_id=$1 AND k.seen_sync=$2 AND u.hotel_id=k.hotel_id AND u.user_id=k.card_holder`, [hotelId, ch.syncId]);
      await c.query(`INSERT INTO vl_card_counts (hotel_id, sync_id, user_group, users, valid_cards, mobile_keys)
        SELECT $1::uuid, $2::uuid, COALESCE(u.user_group, '(no group)'), count(DISTINCT u.user_id)::int,
          count(k.reg_no) FILTER (WHERE k.reg_no IS NOT NULL AND NOT (k.cancelled OR k.discarded OR k.overridden OR k.expired))::int,
          count(k.reg_no) FILTER (WHERE k.key_id IS NOT NULL AND NOT (k.cancelled OR k.discarded OR k.overridden OR k.expired))::int
        FROM vl_users u LEFT JOIN vl_cards k ON k.hotel_id=u.hotel_id AND k.card_holder=u.user_id AND k.active
        WHERE u.hotel_id=$1::uuid AND u.active GROUP BY 1,2,3 ON CONFLICT DO NOTHING`, [hotelId, ch.syncId]);
      await c.query(`UPDATE directory_syncs SET status='SUCCEEDED', finished_at=now(), notes=$2 WHERE id=$1`, [ch.syncId, JSON.stringify(ch.notes)]);
      const s = await one(c, 'SELECT users, cards, alarms FROM directory_syncs WHERE id=$1', [ch.syncId]);
      await audit(c, { hotelId, actorType: 'connector', action: 'directory.synced', targetType: 'command', targetId: ch.syncId, details: { users: s.users, cards: s.cards, alarms: s.alarms, notes: ch.notes } });
    }
    return { ok: true };
  });
}

/** Command result: only a failure needs recording here (the final part already completed a successful sync). */
export async function onDirectorySyncResult(c: import('pg').PoolClient, cmd: any, result: { status: string; error?: { message?: string } }) {
  if (result.status === 'FAILED') await c.query(`UPDATE directory_syncs SET status='FAILED', finished_at=now(), error=$2 WHERE id=$1 AND status='RUNNING'`, [cmd.id, result.error?.message ?? 'failed']);
}

/** Scheduled syncs, every `everyHours` per hotel that switched it on. */
export async function scheduleDirectorySyncs() {
  const hotels = await many(pool, `SELECT h.id FROM hotels h WHERE h.status='ACTIVE'`);
  for (const h of hotels) {
    const vl = await getConfig(pool, h.id, 'visionline');
    const ds = vl?.directorySync;
    if (!ds?.enabled) continue;
    await pool.query(`UPDATE directory_syncs SET status='FAILED', finished_at=now(), error='No answer from the connector in time' WHERE hotel_id=$1 AND status='RUNNING' AND started_at < now() - make_interval(secs => $2)`, [h.id, SYNC_TTL_SEC]);
    const last = await one(pool, `SELECT started_at, status FROM directory_syncs WHERE hotel_id=$1 ORDER BY started_at DESC LIMIT 1`, [h.id]);
    // After a failure, try again within the hour rather than waiting a whole period.
    const waitMs = (last?.status === 'FAILED' ? Math.min(ds.everyHours, 1) : ds.everyHours) * 3600_000;
    if (last && Date.now() - new Date(last.started_at).getTime() < waitMs) continue;
    try { await requestDirectorySync(h.id, null); } catch { /* connector offline or older: try again next time */ }
  }
}
