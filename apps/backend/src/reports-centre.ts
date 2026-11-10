import { VL } from '@smk/shared/node';
import type { Permission } from '@smk/shared';
import { pool, many, one } from './db.ts';
import { getConfig } from './hotel-config.ts';
import { genericCards } from './generic-cards.ts';
import { LIGHT_HIDDEN_REPORTS } from '@smk/shared';
import { edition } from './edition.ts';
import type { Column, Tone } from './pdf.ts';

/**
 * 2.27 Reports (Armel, 4 Nov: "monthly reports ... a section of reports only ... daily, the number of guest keycards
 * issued, monthly staff keycards issued and who has those keycards ... comprehensive ... sent via email or extracted
 * from the portal"). Each report is one table with key figures, for a day or a month in the site's time zone. The same
 * data is shown on screen, printed as a fingerprinted PDF, exported as CSV and e-mailed (now or on a schedule).
 *
 * Guest keycards: Visionline reports every card it makes on its live feed (card status 1); a card that is not a staff
 * keycard read from Visionline and not a mobile key is counted as a guest (or other) keycard. A card made while the
 * connector was off is counted on the day it is first used at a door.
 */
export type Period = 'day' | 'month';
export interface ReportDef { id: string; title: string; about: string; group: 'Daily and monthly' | 'Keycards' | 'Doors' | 'Locks'; periods: (Period | 'now')[]; perms: Permission[] }
export interface ReportOut {
  id: string; title: string; period: string; from: string; to: string; timezone: string;
  summary: [string, string][]; columns: Column[]; rows: string[][]; tones?: Tone[]; note?: string | null;
}

export const REPORTS: ReportDef[] = [
  { id: 'daily-summary', title: 'Daily summary', group: 'Daily and monthly', periods: ['day', 'month'], perms: ['reports.read', 'events.read'],
    about: 'Everything in one page: entrances, refused entries, guest and staff keycards issued, keycards returned, battery alarms, locks offline, open alarms and maintenance.' },
  { id: 'guest-keycards', title: 'Guest keycards issued', group: 'Keycards', periods: ['day', 'month'], perms: ['reports.read', 'events.read'],
    about: 'How many guest keycards Visionline made, and the rooms where guest keycards were used. For a month: one line per day.' },
  { id: 'staff-keycards-issued', title: 'Staff keycards issued', group: 'Keycards', periods: ['month', 'day'], perms: ['reports.read', 'keycards.read'],
    about: 'Every staff keycard made in the period: for whom, user group, card number, who issued it, until when it is valid, and whether it still works.' },
  { id: 'keycard-holders', title: 'Who holds staff keycards', group: 'Keycards', periods: ['now'], perms: ['reports.read', 'keycards.read'],
    about: 'Every valid staff keycard today: holder, user group, card and register number, doors, deadbolt override, valid until, who issued it and when it was last used.' },
  { id: 'keycard-requests', title: 'Keycard requests and returns', group: 'Keycards', periods: ['month', 'day'], perms: ['reports.read', 'keycards.read'],
    about: 'Requests for new or replacement keycards and returns or cancellations, with their state and who handled them.' },
  { id: 'door-activity', title: 'Door activity', group: 'Doors', periods: ['day', 'month'], perms: ['reports.read', 'events.read'],
    about: 'For each door: entrances, refused entries, how many different staff and guest keycards were used, and the last use.' },
  { id: 'refused-entries', title: 'Refused entries', group: 'Doors', periods: ['day', 'month'], perms: ['reports.read', 'events.read'],
    about: 'Every refused entry: when, which door, which card, whose, and why the lock refused it.' },
  { id: 'locks-batteries', title: 'Locks and batteries', group: 'Locks', periods: ['month', 'day'], perms: ['reports.read', 'battery.read'],
    about: 'Battery alarms and battery changes in the period, the battery state of each lock now, how long its batteries have been in, and locks offline.' },
];

/** 2.33 The light edition (offline hotel) leaves out the reports that need door events of online locks. */
const inEdition = (r: ReportDef) => edition() !== 'light' || !(LIGHT_HIDDEN_REPORTS as readonly string[]).includes(r.id);
export const reportDef = (id: string) => REPORTS.find((r) => r.id === id && inEdition(r)) ?? null;
export const editionReports = () => REPORTS.filter(inEdition);
export const allowedReport = (def: ReportDef, perms: Set<Permission>) => def.perms.some((p) => perms.has(p));

/** Day "YYYY-MM-DD" or month "YYYY-MM" in the site's time zone → [from, to) in UTC. */
export function periodBounds(period: Period | 'now', date: string, tz: string) {
  const local = (y: number, m: number, d: number) => {
    // Midnight of that local day in the site's time zone.
    const guess = Date.UTC(y, m - 1, d);
    const off = (t: number) => { const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t));
      const g = (k: string) => +(p.find((x) => x.type === k)!.value); return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - t; };
    return new Date(guess - off(guess - off(guess)));
  };
  if (period === 'now') { const now = new Date(); return { from: now, to: now, label: `As of ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(now)}` }; }
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(date);
  if (!m) throw new Error('Choose a day (YYYY-MM-DD) or a month (YYYY-MM).');
  const y = +m[1]!, mo = +m[2]!, d = +(m[3] ?? 1);
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || y < 2000 || y > 2100) throw new Error('Choose a real day (YYYY-MM-DD) or month (YYYY-MM).');
  if (period === 'day') {
    const from = local(y, mo, d), to = local(y, mo, d + 1);
    return { from, to, label: new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(from.getTime() + 3_600_000)) };
  }
  const from = local(y, mo, 1), to = local(mo === 12 ? y + 1 : y, mo === 12 ? 1 : mo + 1, 1);
  return { from, to, label: new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: 'long', year: 'numeric' }).format(new Date(from.getTime() + 86_400_000)) };
}

/** Time of a lock event: the lock's own time (Visionline local) when given, else when it was received. */
const AT = (tz: string) => `COALESCE(CASE WHEN e.event_time ~ '^\\d{8}T\\d{4}' THEN (to_timestamp(substr(e.event_time, 1, 13), 'YYYYMMDD"T"HH24MI')::timestamp AT TIME ZONE '${tz.replace(/'/g, '')}') END, e.received_at)`;
/** A card that is a staff keycard (read from Visionline) or a mobile key. */
const STAFF_CARD = `(EXISTS (SELECT 1 FROM vl_cards vc WHERE vc.hotel_id=e.hotel_id AND vc.reg_no=e.registration_number AND vc.card_holder IS NOT NULL) OR e.key_id IS NOT NULL
  OR EXISTS (SELECT 1 FROM portal_encoded_cards p WHERE p.hotel_id=e.hotel_id AND p.reg_no=e.registration_number AND p.kind='staff'))`;

async function ctx(hotelId: string) {
  const [prop, h, pol] = await Promise.all([getConfig(pool, hotelId, 'property'), one(pool, 'SELECT name, timezone FROM hotels WHERE id=$1', [hotelId]), getConfig(pool, hotelId, 'policy')]);
  const tz = (prop?.timezone ?? h?.timezone ?? 'UTC') as string;
  const entrance: number[] = pol?.eventLog?.entranceEventCodes ?? [64];
  return { tz, entrance, denial: [...VL.denialEventCodes, 53], name: (prop?.displayName ?? h?.name ?? 'Site') as string };
}
const fmt = (tz: string, opts: Intl.DateTimeFormatOptions) => { const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }); return (v: Date | string | null | undefined) => (v ? f.format(new Date(v)) : '—'); };

export async function buildReport(hotelId: string, id: string, period: Period | 'now', date: string): Promise<ReportOut> {
  const def = reportDef(id);
  if (!def) throw new Error('Unknown report');
  const c = await ctx(hotelId);
  const p = periodBounds(def.periods.includes('now') ? 'now' : period, date, c.tz);
  const dt = fmt(c.tz, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const d = fmt(c.tz, { day: '2-digit', month: 'short', year: 'numeric' });
  const base = { id, title: def.title, period: p.label, from: p.from.toISOString(), to: p.to.toISOString(), timezone: c.tz };
  const args = [hotelId, p.from, p.to];

  switch (id) {
    case 'guest-keycards': {
      // Cards Visionline reported as made (status 1) that are neither staff keycards nor mobile keys.
      const issued = await many(pool, `SELECT DISTINCT ON (e.registration_number) e.registration_number AS reg, e.received_at AS at FROM visionline_events e
        WHERE e.hotel_id=$1 AND e.kind='card' AND e.card_status=1 AND e.received_at >= $2 AND e.received_at < $3 AND NOT ${STAFF_CARD} ORDER BY e.registration_number, e.received_at`, args);
      const used = await many(pool, `SELECT * FROM (SELECT e.registration_number AS reg, COALESCE(r.name, e.door_id) AS room, ${AT(c.tz)} AS at, e.event_code AS code FROM visionline_events e
          LEFT JOIN resources r ON r.hotel_id=e.hotel_id AND r.kind='door' AND (r.external_id=e.door_id OR r.data->>'doorID'=e.door_id)
          WHERE e.hotel_id=$1 AND e.kind='event' AND e.registration_number IS NOT NULL AND e.registration_number <> '0' AND e.received_at BETWEEN $2::timestamptz - interval '2 days' AND $3::timestamptz + interval '2 days'
            AND NOT ${STAFF_CARD}) x WHERE at >= $2 AND at < $3`, args);
      const firstUse = new Map<string, { at: Date; room: string }>();
      for (const u of used) if (c.entrance.includes(u.code)) { const f = firstUse.get(u.reg); if (!f || u.at < f.at) firstUse.set(u.reg, { at: u.at, room: u.room }); }
      const issuedSet = new Set(issued.map((i) => i.reg as string));
      const allNew = new Set([...issuedSet, ...[...firstUse.keys()].filter((r) => !issuedSet.has(r))]);
      const rooms = new Set([...firstUse.values()].map((f) => f.room));
      const summary: [string, string][] = [['Guest keycards issued', String(issued.length)], ['Guest keycards used at doors', String(firstUse.size)], ['Rooms', String(rooms.size)],
        ['New guest keycards (issued or first used)', String(allNew.size)]];
      const note = 'Issued = keycards Visionline reported as made on its live feed (not staff keycards, not mobile keys). A keycard made while the connector was off is counted when first used at a door.';
      if (period === 'month') {
        const byDay = new Map<string, { issued: number; used: Set<string>; rooms: Set<string> }>();
        const day = fmt(c.tz, { year: 'numeric', month: '2-digit', day: '2-digit' });
        const get = (k: string) => { let v = byDay.get(k); if (!v) { v = { issued: 0, used: new Set(), rooms: new Set() }; byDay.set(k, v); } return v; };
        const key = (t: Date) => day(t).split('/').reverse().join('-');
        for (const i of issued) get(key(i.at)).issued++;
        for (const [reg, f] of firstUse) { const v = get(key(f.at)); v.used.add(reg); v.rooms.add(f.room); }
        const rows = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, String(v.issued), String(v.used.size), String(v.rooms.size)]);
        return { ...base, summary, columns: [{ label: 'Day', width: 20 }, { label: 'Guest keycards issued', width: 25, align: 'right' }, { label: 'Used at doors (first time)', width: 25, align: 'right' }, { label: 'Rooms', width: 15, align: 'right' }], rows, note };
      }
      const perRoom = new Map<string, { cards: Set<string>; entries: number; refused: number; first: Date }>();
      for (const u of used) {
        let v = perRoom.get(u.room); if (!v) { v = { cards: new Set(), entries: 0, refused: 0, first: u.at }; perRoom.set(u.room, v); }
        v.cards.add(u.reg); if (c.entrance.includes(u.code)) v.entries++; else if (c.denial.includes(u.code)) v.refused++; if (u.at < v.first) v.first = u.at;
      }
      const rows = [...perRoom.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([room, v]) => [room, String(v.cards.size), String(v.entries), String(v.refused), dt(v.first)]);
      return { ...base, summary, columns: [{ label: 'Room / door', width: 18 }, { label: 'Guest keycards used', width: 18, align: 'right' }, { label: 'Entries', width: 12, align: 'right' }, { label: 'Refused', width: 12, align: 'right' }, { label: 'First use', width: 22 }], rows,
        tones: [...perRoom.values()].map((v) => (v.refused ? 'warning' : null)), note };
    }

    case 'staff-keycards-issued': {
      const rows0 = await many(pool, `SELECT k.reg_no, k.first_seen_at, k.expires_at, k.door_count, k.deadbolt_override,
          NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), '') AS holder, COALESCE(u.user_group, k.user_group) AS grp,
          (SELECT g.label FROM keycard_register g WHERE g.hotel_id=k.hotel_id AND g.card_reg_no=k.reg_no LIMIT 1) AS label,
          COALESCE((SELECT o.display_name FROM key_requests r JOIN operators o ON o.id=r.requested_by WHERE r.id=k.key_id),
            (SELECT p.operator_name FROM portal_encoded_cards p WHERE p.hotel_id=k.hotel_id AND p.reg_no=k.reg_no), vl_issuer_label(k.hotel_id, k.reg_no), 'Issued from Visionline') AS issued_by,
          k.active AND NOT (k.cancelled OR k.discarded OR k.overridden OR k.expired) AND (k.expires_at IS NULL OR k.expires_at > now()) AS valid, k.cancelled, k.overridden
        FROM vl_cards k LEFT JOIN vl_users u ON u.hotel_id=k.hotel_id AND u.user_id=k.card_holder
        WHERE k.hotel_id=$1 AND k.card_holder IS NOT NULL AND k.key_id IS NULL AND NOT COALESCE(k.mobile, false) AND k.first_seen_at >= $2 AND k.first_seen_at < $3
        ORDER BY k.first_seen_at`, args);
      const returned = await one(pool, `SELECT count(*)::int AS n FROM keycard_requests WHERE hotel_id=$1 AND status='COLLECTED' AND updated_at >= $2 AND updated_at < $3`, args);
      const groups = new Map<string, number>(); for (const r of rows0) groups.set(r.grp ?? '—', (groups.get(r.grp ?? '—') ?? 0) + 1);
      const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g, n]) => `${g} ${n}`).join(', ');
      return { ...base, summary: [['Staff keycards issued', String(rows0.length)], ['People', String(new Set(rows0.map((r) => r.holder)).size)], ['Still valid', String(rows0.filter((r) => r.valid).length)], ['Returned or cancelled (requests)', String(returned?.n ?? 0)]],
        columns: [{ label: 'Issued', width: 15 }, { label: 'Holder', width: 20 }, { label: 'User group', width: 14 }, { label: 'Card', width: 11 }, { label: 'Register', width: 9 }, { label: 'Issued by', width: 22 }, { label: 'Valid until', width: 12 }, { label: 'Now', width: 10 }],
        rows: rows0.map((r) => [dt(r.first_seen_at), r.holder ?? '—', r.grp ?? '—', r.reg_no, r.label ?? '—', r.issued_by, d(r.expires_at), r.valid ? 'Valid' : r.cancelled ? 'Cancelled' : r.overridden ? 'Replaced' : 'Ended']),
        tones: rows0.map((r) => (r.valid ? null : 'warning')), note: top ? `By user group: ${top}. A staff keycard is counted on the day it first appeared in Visionline's card list or live feed.` : null };
    }

    case 'keycard-holders': {
      const rows0 = await many(pool, `SELECT k.reg_no, k.expires_at, k.door_count, k.deadbolt_override, k.card_holder,
          NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), '') AS holder, COALESCE(u.user_group, k.user_group) AS grp,
          (SELECT g.label FROM keycard_register g WHERE g.hotel_id=k.hotel_id AND g.card_reg_no=k.reg_no LIMIT 1) AS label,
          COALESCE((SELECT p.operator_name FROM portal_encoded_cards p WHERE p.hotel_id=k.hotel_id AND p.reg_no=k.reg_no), vl_issuer_label(k.hotel_id, k.reg_no), 'Issued from Visionline') AS issued_by,
          (SELECT max(e.received_at) FROM visionline_events e WHERE e.hotel_id=k.hotel_id AND e.kind='event' AND e.registration_number=k.reg_no) AS last_used
        FROM vl_cards k LEFT JOIN vl_users u ON u.hotel_id=k.hotel_id AND u.user_id=k.card_holder
        WHERE k.hotel_id=$1 AND k.card_holder IS NOT NULL AND k.key_id IS NULL AND NOT COALESCE(k.mobile, false) AND k.active
          AND NOT (k.cancelled OR k.discarded OR k.overridden OR k.expired) AND (k.expires_at IS NULL OR k.expires_at > now())
        ORDER BY COALESCE(u.user_group, k.user_group) NULLS LAST, holder NULLS LAST`, [hotelId]);
      const generic = new Set((await genericCards(hotelId)).map((g) => g.regNo));
      const per = new Map<string, number>(); for (const r of rows0) per.set(r.card_holder, (per.get(r.card_holder) ?? 0) + 1);
      const soon = rows0.filter((r) => r.expires_at && new Date(r.expires_at).getTime() < Date.now() + 30 * 86_400_000).length;
      return { ...base, summary: [['Valid staff keycards', String(rows0.length)], ['People', String(per.size)], ['End within 30 days', String(soon)], ['Generic names', String(generic.size)], ['People with 2+ cards', String([...per.values()].filter((n) => n > 1).length)]],
        columns: [{ label: 'Holder', width: 19 }, { label: 'User group', width: 13 }, { label: 'Card', width: 10 }, { label: 'Register', width: 8 }, { label: 'Doors', width: 6, align: 'right' }, { label: 'Deadbolt', width: 8 }, { label: 'Valid until', width: 11 }, { label: 'Issued by', width: 19 }, { label: 'Last used', width: 14 }],
        rows: rows0.map((r) => [`${r.holder ?? r.card_holder}${generic.has(r.reg_no) ? ' (generic name)' : ''}${(per.get(r.card_holder) ?? 0) > 1 ? ' (2+ cards)' : ''}`, r.grp ?? '—', r.reg_no, r.label ?? '—', String(r.door_count ?? 0),
          r.deadbolt_override ? 'Override' : r.deadbolt_override === false ? 'No' : '—', d(r.expires_at), r.issued_by, r.last_used ? dt(r.last_used) : 'never']),
        tones: rows0.map((r) => (generic.has(r.reg_no) ? 'error' : (per.get(r.card_holder) ?? 0) > 1 || (r.expires_at && new Date(r.expires_at).getTime() < Date.now() + 30 * 86_400_000) ? 'warning' : null)),
        note: 'Red: keycard in a generic name (nobody can tell who used it). Orange: the person holds more than one card, or the card ends within 30 days.' };
    }

    case 'keycard-requests': {
      const rows0 = await many(pool, `SELECT q.created_at, q.number, q.kind, q.status, q.given_name, q.surname, q.department, q.card_label, q.card_reg_no, q.return_state, q.manager_name,
          ib.display_name AS issued_by, q.issued_at FROM keycard_requests q LEFT JOIN operators ib ON ib.id=q.issued_by
        WHERE q.hotel_id=$1 AND ((q.created_at >= $2 AND q.created_at < $3) OR (q.updated_at >= $2 AND q.updated_at < $3)) ORDER BY q.created_at`, args);
      const n = (f: (r: any) => boolean) => String(rows0.filter(f).length);
      const KIND: Record<string, string> = { new: 'New', replacement: 'Replacement', cancel: 'Return / cancellation' };
      const ST: Record<string, string> = { SUBMITTED: 'Waiting', ISSUED: 'Issued', REJECTED: 'Rejected', COLLECTED: 'Returned / cancelled', CANCELLED: 'Cancelled', WITHDRAWN: 'Withdrawn' };
      return { ...base, summary: [['Requests', String(rows0.length)], ['Issued', n((r) => r.status === 'ISSUED')], ['Returned / cancelled', n((r) => r.status === 'COLLECTED')], ['Waiting', n((r) => r.status === 'SUBMITTED')], ['Lost cards', n((r) => r.return_state === 'lost')]],
        columns: [{ label: 'Date', width: 13 }, { label: 'Number', width: 12 }, { label: 'Request', width: 14 }, { label: 'Person', width: 18 }, { label: 'Department', width: 13 }, { label: 'Card', width: 10 }, { label: 'State', width: 14 }, { label: 'Issued by', width: 16 }],
        rows: rows0.map((r) => [d(r.created_at), r.number, KIND[r.kind] ?? r.kind, `${r.given_name ?? ''} ${r.surname ?? ''}`.trim(), r.department ?? '—', r.card_label ?? r.card_reg_no ?? '—',
          `${ST[r.status] ?? r.status}${r.return_state ? ` (${r.return_state.replace('_', ' ')})` : ''}`, r.issued_by ?? '—']),
        tones: rows0.map((r) => (r.return_state === 'lost' || r.return_state === 'not_returned' ? 'error' : r.status === 'SUBMITTED' ? 'warning' : null)) };
    }

    case 'door-activity': {
      const rows0 = await many(pool, `SELECT room, count(*) FILTER (WHERE code = ANY($4::int[]))::int AS entries, count(*) FILTER (WHERE code = ANY($5::int[]))::int AS refused,
          count(DISTINCT reg) FILTER (WHERE staff)::int AS staff, count(DISTINCT reg) FILTER (WHERE NOT staff)::int AS other, max(at) AS last
        FROM (SELECT COALESCE(r.name, e.door_id) AS room, e.event_code AS code, e.registration_number AS reg, ${STAFF_CARD} AS staff, ${AT(c.tz)} AS at
          FROM visionline_events e LEFT JOIN resources r ON r.hotel_id=e.hotel_id AND r.kind='door' AND (r.external_id=e.door_id OR r.data->>'doorID'=e.door_id)
          WHERE e.hotel_id=$1 AND e.kind='event' AND e.received_at BETWEEN $2::timestamptz - interval '2 days' AND $3::timestamptz + interval '2 days') x
        WHERE at >= $2 AND at < $3 AND (code = ANY($4::int[]) OR code = ANY($5::int[])) GROUP BY room ORDER BY entries DESC, room`, [...args, c.entrance, c.denial]);
      const sum = (k: string) => rows0.reduce((a, r) => a + r[k], 0);
      return { ...base, summary: [['Entrances', String(sum('entries'))], ['Refused', String(sum('refused'))], ['Doors used', String(rows0.length)]],
        columns: [{ label: 'Door', width: 22 }, { label: 'Entrances', width: 12, align: 'right' }, { label: 'Refused', width: 11, align: 'right' }, { label: 'Staff keycards', width: 14, align: 'right' }, { label: 'Guest / other keycards', width: 16, align: 'right' }, { label: 'Last use', width: 20 }],
        rows: rows0.map((r) => [r.room ?? '—', String(r.entries), String(r.refused), String(r.staff), String(r.other), dt(r.last)]), tones: rows0.map((r) => (r.refused ? 'warning' : null)) };
    }

    case 'refused-entries': {
      const rows0 = await many(pool, `SELECT * FROM (SELECT ${AT(c.tz)} AS at, COALESCE(r.name, e.door_id) AS door, e.registration_number AS reg, e.event_code AS code,
          NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), '') AS holder, COALESCE(u.user_group, vc.user_group) AS grp, ${STAFF_CARD} AS staff
        FROM visionline_events e LEFT JOIN resources r ON r.hotel_id=e.hotel_id AND r.kind='door' AND (r.external_id=e.door_id OR r.data->>'doorID'=e.door_id)
          LEFT JOIN vl_cards vc ON vc.hotel_id=e.hotel_id AND vc.reg_no=e.registration_number LEFT JOIN vl_users u ON u.hotel_id=e.hotel_id AND u.user_id=vc.card_holder
        WHERE e.hotel_id=$1 AND e.kind='event' AND e.event_code = ANY($4::int[]) AND e.received_at BETWEEN $2::timestamptz - interval '2 days' AND $3::timestamptz + interval '2 days') x
        WHERE at >= $2 AND at < $3 ORDER BY at DESC LIMIT 5000`, [...args, c.denial]);
      const REASON: Record<number, string> = { 320: 'No access to this door', 322: 'Card not valid yet or expired', 323: 'Only common doors', 325: 'Card cancelled or replaced', 327: 'Time schedule', 368: 'Deadbolt on', 369: 'Privacy (do not disturb)', 53: 'Refused' };
      const people = new Set(rows0.filter((r) => r.holder).map((r) => r.holder));
      return { ...base, summary: [['Refused entries', String(rows0.length)], ['Doors', String(new Set(rows0.map((r) => r.door)).size)], ['Staff keycards', String(rows0.filter((r) => r.staff).length)], ['People', String(people.size)]],
        columns: [{ label: 'Time', width: 16 }, { label: 'Door', width: 14 }, { label: 'Card', width: 10 }, { label: 'Holder', width: 20 }, { label: 'User group', width: 14 }, { label: 'Why', width: 26 }],
        rows: rows0.map((r) => [dt(r.at), r.door ?? '—', r.reg ?? '—', r.holder ?? (r.staff ? 'Staff keycard' : 'Guest / other keycard'), r.grp ?? '—', `${REASON[r.code] ?? 'Refused'} (event ${r.code})`]),
        tones: rows0.map((r) => (r.staff ? 'warning' : null)), note: rows0.length >= 5000 ? 'Only the newest 5,000 refused entries are listed.' : null };
    }

    case 'locks-batteries': {
      const rows0 = await many(pool, `SELECT COALESCE(r.name, s.door_id) AS door, r.data->>'doorGroup' AS grp, s.state, s.reported_at, ds.state AS online,
          (SELECT count(*)::int FROM battery_readings b WHERE b.hotel_id=s.hotel_id AND b.door_id=s.door_id AND b.state IN ('LOW','CRITICAL') AND b.reported_at >= $2 AND b.reported_at < $3) AS alarms,
          (SELECT count(*)::int FROM battery_changes b WHERE b.hotel_id=s.hotel_id AND b.door_id=s.door_id AND b.at >= $2 AND b.at < $3) AS changes,
          (SELECT max(b.at) FROM battery_changes b WHERE b.hotel_id=s.hotel_id AND b.door_id=s.door_id) AS last_change
        FROM battery_status s LEFT JOIN resources r ON r.hotel_id=s.hotel_id AND r.kind='door' AND r.external_id=s.door_id
          LEFT JOIN door_status ds ON ds.hotel_id=s.hotel_id AND ds.door_id=s.door_id
        WHERE s.hotel_id=$1 ORDER BY CASE s.state WHEN 'CRITICAL' THEN 0 WHEN 'LOW' THEN 1 ELSE 2 END, door`, args);
      const offline = await one(pool, `SELECT count(*)::int AS n FROM door_status WHERE hotel_id=$1 AND state='offline'`, [hotelId]);
      const tickets = await one(pool, `SELECT count(*) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS opened, count(*) FILTER (WHERE resolved_at >= $2 AND resolved_at < $3)::int AS solved FROM maintenance_tickets WHERE hotel_id=$1`, args);
      const shown = rows0.filter((r) => r.alarms || r.changes || r.state !== 'GOOD');
      const STATE: Record<string, string> = { GOOD: 'Good', LOW: 'Low', CRITICAL: 'Critical', REPORTED: 'Reported' };
      return { ...base, summary: [['Battery alarms', String(rows0.reduce((a, r) => a + r.alarms, 0))], ['Batteries changed', String(rows0.reduce((a, r) => a + r.changes, 0))], ['Critical now', String(rows0.filter((r) => r.state === 'CRITICAL').length)],
          ['Low now', String(rows0.filter((r) => r.state === 'LOW').length)], ['Locks offline now', String(offline?.n ?? 0)], ['Maintenance opened / solved', `${tickets?.opened ?? 0} / ${tickets?.solved ?? 0}`]],
        columns: [{ label: 'Lock', width: 16 }, { label: 'Door group', width: 14 }, { label: 'Battery now', width: 12 }, { label: 'Alarms in period', width: 13, align: 'right' }, { label: 'Changes in period', width: 13, align: 'right' }, { label: 'Batteries in since', width: 16 }, { label: 'Last report', width: 16 }, { label: 'Online', width: 9 }],
        rows: shown.map((r) => [r.door, r.grp ?? '—', STATE[r.state] ?? r.state, String(r.alarms), String(r.changes), r.last_change ? d(r.last_change) : '—', dt(r.reported_at), r.online === 'online' ? 'Online' : r.online === 'offline' ? 'Offline' : '—']),
        tones: shown.map((r) => (r.state === 'CRITICAL' ? 'error' : r.state === 'LOW' ? 'warning' : null)), note: `Locks with no alarm, no change and a good battery are left out (${rows0.length - shown.length} locks).` };
    }

    case 'daily-summary': default: {
      const ev = await one(pool, `SELECT count(*) FILTER (WHERE code = ANY($4::int[]))::int AS entries, count(*) FILTER (WHERE code = ANY($5::int[]))::int AS refused,
          count(DISTINCT reg) FILTER (WHERE staff AND code = ANY($4::int[]))::int AS staff_cards, count(DISTINCT reg) FILTER (WHERE NOT staff AND code = ANY($4::int[]))::int AS guest_cards,
          count(*) FILTER (WHERE code = ANY($6::int[]))::int AS battery
        FROM (SELECT e.event_code AS code, e.registration_number AS reg, ${STAFF_CARD} AS staff, ${AT(c.tz)} AS at FROM visionline_events e
          WHERE e.hotel_id=$1 AND e.kind='event' AND e.received_at BETWEEN $2::timestamptz - interval '2 days' AND $3::timestamptz + interval '2 days') x WHERE at >= $2 AND at < $3`,
        [...args, c.entrance, c.denial, [...VL.batteryEvents.low, ...VL.batteryEvents.critical]]);
      const g = await buildReport(hotelId, 'guest-keycards', period, date);
      const staff = await one(pool, `SELECT count(*)::int AS n FROM vl_cards WHERE hotel_id=$1 AND card_holder IS NOT NULL AND key_id IS NULL AND NOT COALESCE(mobile,false) AND first_seen_at >= $2 AND first_seen_at < $3`, args);
      const req = await one(pool, `SELECT count(*) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS asked, count(*) FILTER (WHERE status='COLLECTED' AND updated_at >= $2 AND updated_at < $3)::int AS returned,
          count(*) FILTER (WHERE return_state IN ('lost','not_returned') AND updated_at >= $2 AND updated_at < $3)::int AS lost FROM keycard_requests WHERE hotel_id=$1`, args);
      const now = await one(pool, `SELECT (SELECT count(*)::int FROM battery_status WHERE hotel_id=$1 AND state='CRITICAL') AS critical, (SELECT count(*)::int FROM battery_status WHERE hotel_id=$1 AND state='LOW') AS low,
          (SELECT count(*)::int FROM door_status WHERE hotel_id=$1 AND state='offline') AS offline, (SELECT count(*)::int FROM vl_alarms WHERE hotel_id=$1 AND NOT completed) AS alarms,
          (SELECT count(*)::int FROM maintenance_tickets WHERE hotel_id=$1 AND created_at >= $2 AND created_at < $3) AS mt_opened,
          (SELECT count(*)::int FROM maintenance_tickets WHERE hotel_id=$1 AND status NOT IN ('RESOLVED','CLOSED','CANCELLED')) AS mt_open,
          (SELECT count(*)::int FROM monitor_alerts WHERE hotel_id=$1 AND opened_at >= $2 AND opened_at < $3 AND severity='critical') AS critical_alerts`, args);
      const generic = (await genericCards(hotelId)).length;
      const gi = (k: string) => g.summary.find((s) => s[0] === k)?.[1] ?? '0';
      const rows: [string, string, string][] = [
        ['Entrances', String(ev?.entries ?? 0), 'Doors opened with a keycard or mobile key'],
        ['Refused entries', String(ev?.refused ?? 0), 'See the "Refused entries" report for each one'],
        ['Different staff keycards used', String(ev?.staff_cards ?? 0), ''],
        ['Different guest / other keycards used', String(ev?.guest_cards ?? 0), ''],
        ['Guest keycards issued', gi('Guest keycards issued'), 'Reported by Visionline as made'],
        ['Staff keycards issued', String(staff?.n ?? 0), 'New staff keycards in Visionline'],
        ['Keycard requests received', String(req?.asked ?? 0), ''],
        ['Keycards returned or cancelled', String(req?.returned ?? 0), req?.lost ? `${req.lost} lost or not returned` : ''],
        ['Battery alarms from locks', String(ev?.battery ?? 0), ''],
        ['Locks with a critical battery now', String(now?.critical ?? 0), `${now?.low ?? 0} low`],
        ['Locks offline now', String(now?.offline ?? 0), ''],
        ['Open Visionline alarms now', String(now?.alarms ?? 0), ''],
        ['Maintenance requests opened', String(now?.mt_opened ?? 0), `${now?.mt_open ?? 0} open in total`],
        ['Critical alerts (monitoring)', String(now?.critical_alerts ?? 0), ''],
        ['Staff keycards in a generic name', String(generic), generic ? 'Put them in the holder\'s name' : ''],
      ];
      return { ...base, summary: [['Entrances', String(ev?.entries ?? 0)], ['Refused', String(ev?.refused ?? 0)], ['Guest keycards issued', gi('Guest keycards issued')], ['Staff keycards issued', String(staff?.n ?? 0)], ['Critical batteries', String(now?.critical ?? 0)]],
        columns: [{ label: 'What', width: 40 }, { label: 'Count', width: 12, align: 'right' }, { label: 'Note', width: 48 }], rows,
        tones: rows.map((r, i) => ([1, 9, 10, 11, 13, 14].includes(i) && r[1] !== '0' ? 'warning' : null)) };
    }
  }
}

/** CSV with the formula guard used by every export. */
export function reportCsv(r: ReportOut) {
  const cell = (v: unknown) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [[r.title], [r.period], ...r.summary.map(([k, v]) => [k, v]), [], r.columns.map((c) => c.label), ...r.rows].map((row) => row.map(cell).join(',')).join('\r\n');
}

/** Plain-text body of the e-mail: the key figures and the first lines of the table. */
export function reportText(siteName: string, r: ReportOut) {
  const lines = [`${siteName}: ${r.title}`, r.period, '', ...r.summary.map(([k, v]) => `${k}: ${v}`), ''];
  if (r.rows.length) {
    lines.push(r.columns.map((c) => c.label).join(' | '));
    for (const row of r.rows.slice(0, 40)) lines.push(row.join(' | '));
    if (r.rows.length > 40) lines.push(`... ${r.rows.length - 40} more lines in the attached PDF and CSV.`);
  }
  if (r.note) lines.push('', r.note);
  lines.push('', 'The full report is attached (PDF with fingerprint, and CSV for Excel). Access Monitoring Tool.');
  return lines.join('\n');
}

export async function siteName(hotelId: string) { return (await ctx(hotelId)).name; }
export async function siteTz(hotelId: string) { return (await ctx(hotelId)).tz; }
