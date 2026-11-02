import { pool, many } from './db.ts';
import { queryEvents } from './event-log.ts';

/**
 * 2.15 Keycards used per room: for each door (guest rooms by default), which keycards opened it or were refused in
 * a period, whose they are and who issued them.
 *
 * Issued by:
 *   - mobile keys: the portal user who requested the key;
 *   - keycards encoded or recorded through the portal's Keycards page: the person who handled the request;
 *   - other keycards in Visionline's card list: "Visionline desk". The Visionline Web API does not say which desk
 *     operator encoded a card; Visionline's own card log does.
 *   - cards not in the staff card list (normally guest cards): "Visionline desk (guest card)"; when the hotel's
 *     in-house list has a stay in that room on that day, the guest's name is shown as the likely holder.
 *
 * Lock events reach the platform when Visionline has them: online locks at once, offline locks when their audit
 * trail is uploaded to Visionline. They are placed at the time the lock recorded them, not the upload time.
 */
export interface RoomCardRow {
  card: string; kind: 'mobile' | 'staff card' | 'guest / other card'; holder: string | null; group: string | null;
  issuedBy: string; entries: number; refused: number; first: string; last: string; validThen: boolean | null;
}
export interface RoomUsage { door: string; doorId: string | null; entries: number; refused: number; cards: RoomCardRow[] }

const ROOM = /^[0-9]{2,5}[A-Za-z]?$/;

export async function roomCardUsage(hotelId: string, f: { from: Date; to: Date; door: string | null; scope: 'rooms' | 'all' }) {
  const LIMIT = 20_000;
  const r = await queryEvents(hotelId, { from: f.from, to: f.to, cls: 'all', categories: ['entrance', 'refused'], door: f.door, q: null, limit: LIMIT });
  const doors = await many(pool, `SELECT external_id, name, data->>'doorCategory' AS cat FROM resources WHERE hotel_id=$1 AND kind='door'`, [hotelId]);
  const isRoom = new Map<string, boolean>();
  for (const d of doors) { const v = d.cat === 'guest' || ROOM.test(d.name); isRoom.set(d.external_id, v); isRoom.set(d.name, v); }

  const cards = [...new Set(r.events.filter((e) => e.id.startsWith('v')).map((e) => e.card).filter((c): c is string => Boolean(c)))];
  // Keycards handled on the portal's Keycards page (encoded at an encoder, or recorded as encoded at the desk).
  const portal = cards.length ? await many(pool, `SELECT DISTINCT ON (k.card_reg_no) k.card_reg_no, k.issue_method, o.display_name,
      NULLIF(trim(coalesce(k.given_name,'') || ' ' || coalesce(k.surname,'')), '') AS holder, k.department
    FROM keycard_requests k LEFT JOIN operators o ON o.id=k.handled_by
    WHERE k.hotel_id=$1 AND k.card_reg_no = ANY($2::text[]) AND k.status IN ('ISSUED','COLLECTED') ORDER BY k.card_reg_no, k.updated_at DESC`, [hotelId, cards]) : [];
  const byPortal = new Map(portal.map((p) => [p.card_reg_no, p]));
  // In-house list (breakfast / occupancy import), to name the likely holder of a guest card.
  const stays = await many(pool, `SELECT room, guest_name, arrival::text, departure::text FROM bf_stays WHERE hotel_id=$1 AND arrival <= $3::date AND departure >= $2::date`,
    [hotelId, f.from, f.to]).catch(() => [] as any[]);
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: r.tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const guestAt = (door: string | null, at: string) => {
    if (!door) return null;
    const day = dayFmt.format(new Date(at));
    const s = stays.find((x: any) => x.room === door && x.arrival <= day && x.departure >= day);
    return s?.guest_name ?? null;
  };

  const rooms = new Map<string, RoomUsage>();
  for (const e of r.events) {
    // Lock events only (the platform's own "first use of a mobile key" entry repeats a lock event).
    if (!e.card || !e.id.startsWith('v')) continue;
    const doorKey = e.door ?? e.doorId ?? '?';
    if (f.scope === 'rooms' && !f.door && !(isRoom.get(e.doorId ?? '') ?? isRoom.get(doorKey) ?? ROOM.test(doorKey))) continue;
    let room = rooms.get(doorKey);
    if (!room) { room = { door: doorKey, doorId: e.doorId, entries: 0, refused: 0, cards: [] }; rooms.set(doorKey, room); }
    let c = room.cards.find((x) => x.card === e.card);
    if (!c) {
      const p = byPortal.get(e.card);
      const m = e.match;
      const kind: RoomCardRow['kind'] = m?.kind === 'mobile' ? 'mobile' : m?.kind === 'card' || p ? 'staff card' : 'guest / other card';
      const guest = kind === 'guest / other card' ? guestAt(e.door, e.at) : null;
      const fromPortal = m?.issuedBy && !/^Visionline/.test(m.issuedBy) ? m.issuedBy : null;
      const issuedBy = p ? `${p.display_name ?? fromPortal ?? 'Portal user'} (${p.issue_method === 'encoder' ? 'encoded from the portal' : 'recorded in the portal, encoded at the Visionline desk'})`
        : fromPortal ? `${fromPortal} (${m?.kind === 'mobile' ? 'mobile key' : 'encoded from the portal'})`
        : m?.issuedBy?.startsWith('Visionline: ') ? m.issuedBy
        : m?.kind === 'mobile' ? 'Visionline (mobile key)' : kind === 'staff card' ? 'Visionline desk' : 'Visionline desk (guest card)';
      c = {
        card: e.card, kind, holder: e.person ?? p?.holder ?? (guest ? `In-house guest: ${guest}` : null), group: m?.group ?? p?.department ?? null,
        issuedBy, entries: 0, refused: 0, first: e.at, last: e.at, validThen: m?.validThen ?? null,
      };
      room.cards.push(c);
    }
    if (e.category === 'entrance') { c.entries++; room.entries++; } else { c.refused++; room.refused++; }
    if (e.at < c.first) c.first = e.at;
    if (e.at > c.last) c.last = e.at;
  }
  const list = [...rooms.values()].sort((a, b) => a.door.localeCompare(b.door, 'en', { numeric: true }));
  for (const x of list) x.cards.sort((a, b) => b.last.localeCompare(a.last));
  return {
    tz: r.tz, truncated: r.truncated, rooms: list,
    totals: { rooms: list.length, cards: list.reduce((a, x) => a + x.cards.length, 0), entries: list.reduce((a, x) => a + x.entries, 0), refused: list.reduce((a, x) => a + x.refused, 0) },
  };
}
