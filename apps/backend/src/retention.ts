import { pool, many } from './db.ts';
import { audit } from './audit.ts';

/**
 * 2.13 Data retention (privacy): old lock events, guest lists and usage counts are deleted after the number of days
 * set in Settings -> Privacy & retention (0 = keep). Runs hourly, a limited batch at a time so it never holds the
 * database. The audit trail is never deleted (it is append-only by design).
 */
const BATCH = 20_000;
export async function applyRetention() {
  const hotels = await many(pool, `SELECT h.id, (SELECT data->'privacy' FROM hotel_config_versions v WHERE v.hotel_id=h.id AND v.kind='policy' ORDER BY version DESC LIMIT 1) AS p FROM hotels h`);
  for (const h of hotels) {
    const p = { lockEventsDays: 730, guestListDays: 400, usageDays: 730, ...(h.p ?? {}) };
    const done: Record<string, number> = {};
    if (p.lockEventsDays > 0) done.lockEvents = (await pool.query(`DELETE FROM visionline_events WHERE id IN (SELECT id FROM visionline_events WHERE hotel_id=$1 AND received_at < now() - make_interval(days => $2) LIMIT ${BATCH})`, [h.id, p.lockEventsDays])).rowCount ?? 0;
    if (p.guestListDays > 0) {
      done.breakfastServed = (await pool.query(`DELETE FROM bf_served WHERE id IN (SELECT id FROM bf_served WHERE hotel_id=$1 AND day < (now() - make_interval(days => $2))::date LIMIT ${BATCH})`, [h.id, p.guestListDays])).rowCount ?? 0;
      done.guestStays = (await pool.query(`DELETE FROM bf_stays WHERE id IN (SELECT id FROM bf_stays WHERE hotel_id=$1 AND departure < (now() - make_interval(days => $2))::date LIMIT ${BATCH})`, [h.id, p.guestListDays])).rowCount ?? 0;
    }
    if (p.usageDays > 0) done.usage = (await pool.query(`DELETE FROM usage_daily WHERE hotel_id=$1 AND day < (now() - make_interval(days => $2))::date`, [h.id, p.usageDays])).rowCount ?? 0;
    if (Object.values(done).some((n) => n > 0)) await audit(null, { hotelId: h.id, actorType: 'system', action: 'privacy.retention_applied', details: { deleted: done, policy: p } });
  }
}
