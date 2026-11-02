import { pool, many, one } from './db.ts';
import { audit } from './audit.ts';
import { getConfig } from './hotel-config.ts';
import { channels } from './monitoring/monitor.ts';
import { sendEmail } from './monitoring/channels.ts';
import { enqueue, newCorrelationId } from './commands.ts';

/**
 * 2.14 Daily report for the Accounts team (e-mail, hotel's own mail server): guests who checked in yesterday, guests
 * in house today, the number of occupied rooms to tally with the PMS, and unpaid-guest lock-outs of the last day.
 * Source: the in-house list (Opera report import, Breakfast -> In-house list).
 */
const fmtDay = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export async function buildAccountsReport(hotelId: string) {
  const [prop, h] = await Promise.all([getConfig(pool, hotelId, 'property'), one(pool, 'SELECT name, timezone FROM hotels WHERE id=$1', [hotelId])]);
  const tz = prop?.timezone ?? h?.timezone ?? 'UTC';
  const today = fmtDay(new Date(), tz), yesterday = fmtDay(new Date(Date.now() - 86_400_000), tz);
  const inHouse = await many(pool, `SELECT room, guest_name, adults, children, arrival::text, departure::text FROM bf_stays WHERE hotel_id=$1 AND arrival <= $2::date AND departure > $2::date
      AND (ended_on IS NULL OR ended_on > $2::date) AND checked_out_at IS NULL ORDER BY room`, [hotelId, today]);
  const arrived = await many(pool, `SELECT room, guest_name, adults, children, departure::text FROM bf_stays WHERE hotel_id=$1 AND arrival = $2::date ORDER BY room`, [hotelId, yesterday]);
  const lockouts = await many(pool, `SELECT room, guest_name, amount, status, method FROM guest_lockouts WHERE hotel_id=$1 AND created_at > now() - interval '1 day' ORDER BY created_at`, [hotelId]);
  const rooms = new Set(inHouse.map((s) => s.room));
  // Rooms with more than one valid guest keycard (read from Visionline before the report; at most a day old).
  const multi = await many(pool, `SELECT g.room, g.n, g.read_at FROM guest_card_counts g WHERE g.hotel_id=$1 AND g.n > 1 AND g.read_at > now() - interval '1 day' ORDER BY g.room`, [hotelId]);
  const read = await one(pool, `SELECT max(read_at) AS at, count(*)::int AS rooms FROM guest_card_counts WHERE hotel_id=$1 AND read_at > now() - interval '1 day'`, [hotelId]);
  const guests = inHouse.reduce((a, s) => a + s.adults + s.children, 0);
  const line = (s: any) => `  ${String(s.room).padEnd(6)} ${String(s.guest_name ?? '').padEnd(30).slice(0, 30)} ${s.adults + (s.children ?? 0)} pers.  ${s.arrival ? `${s.arrival} -> ` : ''}${s.departure}`;
  const text = [
    `${prop?.displayName ?? h?.name} - daily report for Accounts, ${today}`, '',
    `Occupied rooms tonight: ${rooms.size}   Guests in house: ${guests}`,
    `Checked in yesterday (${yesterday}): ${arrived.length} room(s)`, '',
    'CHECKED IN YESTERDAY', ...(arrived.length ? arrived.map(line) : ['  none']), '',
    'IN HOUSE TODAY', ...(inHouse.length ? inHouse.map(line) : ['  The in-house list is empty: import today\'s Opera in-house report (Breakfast -> In-house list).']), '',
    'ROOMS WITH MORE THAN ONE ACTIVE GUEST KEYCARD', ...(read?.rooms ? (multi.length ? multi.map((m) => `  ${String(m.room).padEnd(6)} ${m.n} valid guest keycards${rooms.has(m.room) ? '' : '  (room NOT on the in-house list)'}`) : ['  none']) : ['  Guest keycards not read from Visionline in the last 24 hours.']),
    ...(read?.rooms ? [`  (read from Visionline ${new Date(read.at).toISOString().slice(0, 16).replace('T', ' ')} UTC, ${read.rooms} rooms)`] : []), '',
    'UNPAID-GUEST LOCK-OUTS (last 24 h)', ...(lockouts.length ? lockouts.map((l) => `  ${l.room}  ${l.guest_name ?? ''}  ${l.amount ?? ''}  ${l.status}${l.method ? ` (${l.method === 'checkout_online' ? 'online checkout' : 'offline card'})` : ''}`) : ['  none']), '',
    'Tally the occupied rooms with the PMS (Opera) night audit. Sent by the staff access portal.',
  ].join('\n');
  return { subject: `Accounts daily report ${today}: ${rooms.size} occupied rooms`, text, rooms: rooms.size, guests, arrived: arrived.length, multipleCards: multi.map((m) => ({ room: m.room, n: m.n })) };
}

const sentToday = new Map<string, string>();
const readToday = new Map<string, string>();
/** Ask the connector to count the valid guest keycards of every guest room (background, one room at a time). */
export async function requestGuestCardRead(hotelId: string) {
  const rooms = await many(pool, `SELECT external_id FROM resources WHERE hotel_id=$1 AND kind='door' AND active AND (data->>'doorCategory'='guest' OR name ~ '^[0-9]{2,5}[A-Za-z]?$') ORDER BY name LIMIT 1000`, [hotelId]);
  if (!rooms.length) return null;
  return enqueue(pool, { hotelId, type: 'COUNT_GUEST_CARDS', payload: { rooms: rooms.map((r) => r.external_id) }, idempotencyKey: `guestcards:${Date.now()}`, correlationId: newCorrelationId(), ttlSec: 3600 });
}
/** Called every few minutes: sends once a day at the time set in Settings -> Safety & emergency -> Accounts report. */
export async function maybeSendAccountsReport() {
  const rows = await many(pool, `SELECT DISTINCT ON (hotel_id) hotel_id, data->'accountsReport' AS r FROM hotel_config_versions WHERE kind='policy' ORDER BY hotel_id, version DESC`);
  for (const row of rows) {
    const r = row.r;
    if (!r?.enabled || !Array.isArray(r.emails) || !r.emails.length) continue;
    const prop = await getConfig(pool, row.hotel_id, 'property');
    const tz = prop?.timezone ?? 'UTC';
    const now = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const day = fmtDay(new Date(), tz);
    const [hh, mm] = String(r.time ?? '06:30').split(':').map(Number);
    const readAt = `${String(Math.floor(((hh! * 60 + mm!) - 30 + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((hh! * 60 + mm!) - 30 + 1440) % 60).padStart(2, '0')}`;
    if (now >= readAt && readToday.get(row.hotel_id) !== day) { readToday.set(row.hotel_id, day); await requestGuestCardRead(row.hotel_id).catch(() => undefined); }
    if (now < (r.time ?? '06:30') || sentToday.get(row.hotel_id) === day) continue;
    sentToday.set(row.hotel_id, day);
    await sendAccountsReport(row.hotel_id, r.emails, null).catch((e) => console.error('[accounts-report]', (e as Error).message));
  }
}

export async function sendAccountsReport(hotelId: string, emails: string[], operatorId: string | null) {
  const rep = await buildAccountsReport(hotelId);
  const ch = await channels(hotelId);
  if (!ch.email?.enabled) throw new Error('E-mail is not set up (Settings -> Alerts & notifications).');
  for (const to of emails) await sendEmail(ch.email, to, rep.subject, rep.text, hotelId);
  await audit(null, { hotelId, actorType: operatorId ? 'operator' : 'system', actorId: operatorId, action: 'report.accounts_sent', details: { to: emails.length, rooms: rep.rooms, guests: rep.guests } });
  return rep;
}
