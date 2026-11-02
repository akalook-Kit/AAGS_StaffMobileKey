import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, many, one } from '../db.ts';
import { permsIn, requirePerm } from '../auth.ts';
import { queryEvents, type EventRow } from '../event-log.ts';
import { notFound } from '../lib/errors.ts';

/**
 * 2.12 Access history: which doors a person opened (or was refused at), and who went through a door. Built from the
 * lock events the connector receives from Visionline (entrances and refused entries) and from mobile-key first uses.
 * Only what the locks reported to Visionline since the watch started is known; offline locks report later.
 */
const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Site');
  return id;
};
const name = (u: any) => [u?.given_name, u?.surname].filter(Boolean).join(' ') || null;

export function accessRoutes(app: FastifyInstance) {
  /** People (Visionline users and staff) and doors matching a few letters. */
  app.get(`${P}/hotels/:hotelId/access/search`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'events.read');
    const q = z.object({ q: z.string().trim().min(1).max(60) }).parse(req.query).q;
    const like = `%${q}%`;
    const [people, staff, doors] = await Promise.all([
      many(pool, `SELECT user_id, given_name, surname, user_group FROM vl_users WHERE hotel_id=$1 AND active
          AND (given_name ILIKE $2 OR surname ILIKE $2 OR user_id ILIKE $2 OR (coalesce(given_name,'') || ' ' || coalesce(surname,'')) ILIKE $2) ORDER BY surname NULLS LAST, given_name LIMIT 12`, [hotelId, like]),
      many(pool, `SELECT id, full_name, visionline_user, visionline_user_group AS department FROM staff WHERE hotel_id=$1 AND full_name ILIKE $2 ORDER BY full_name LIMIT 8`, [hotelId, like]),
      many(pool, `SELECT external_id, name FROM resources WHERE hotel_id=$1 AND kind='door' AND active AND name ILIKE $2 ORDER BY length(name), name LIMIT 10`, [hotelId, like]),
    ]);
    const seen = new Set(people.map((p) => p.user_id));
    return {
      people: [
        ...people.map((p) => ({ holder: p.user_id, name: name(p) ?? p.user_id, group: p.user_group })),
        ...staff.filter((s) => !s.visionline_user || !seen.has(s.visionline_user)).map((s) => (s.visionline_user ? { holder: s.visionline_user, name: s.full_name, group: s.department } : { name: s.full_name, group: s.department })),
      ],
      doors: doors.map((d) => ({ id: d.external_id, name: d.name })),
    };
  });

  app.get(`${P}/hotels/:hotelId/access`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'events.read');
    const q = z.object({
      holder: z.string().max(200).optional(), name: z.string().max(200).optional(), door: z.string().max(120).optional(),
      days: z.coerce.number().int().min(1).max(366).default(30),
    }).refine((x) => x.holder || x.name || x.door, 'Choose a person or a door').parse(req.query);
    const to = new Date();
    const from = new Date(to.getTime() - q.days * 86_400_000);
    // Person: their name and Visionline user id are filtered in the database (2.13), at most 5,000 events are read.
    const who = q.door ? null : await one(pool, `SELECT NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), '') AS n FROM vl_users u WHERE u.hotel_id=$1 AND u.user_id=$2`, [hotelId, q.holder ?? null]);
    const staffName = q.door ? null : await one(pool, `SELECT full_name FROM staff WHERE hotel_id=$1 AND visionline_user=$2 LIMIT 1`, [hotelId, q.holder ?? null]);
    const r = await queryEvents(hotelId, { from, to, cls: 'all', categories: ['entrance', 'refused'], door: q.door ?? null, q: null, limit: 5_000,
      holder: q.door ? null : q.holder ?? null, person: q.door ? null : (staffName?.full_name ?? q.name ?? who?.n ?? null) });
    const tzDay = new Intl.DateTimeFormat('en-CA', { timeZone: r.tz, year: 'numeric', month: '2-digit', day: '2-digit' });

    if (q.door) {
      const door = await one(pool, `SELECT external_id, name, data FROM resources WHERE hotel_id=$1 AND kind='door' AND (external_id=$2 OR name=$2) LIMIT 1`, [hotelId, q.door]);
      const events = r.events;
      const people = new Map<string, { person: string | null; holder: string | null; entrances: number; refused: number; last: string }>();
      for (const e of events) {
        const k = e.match?.holderId ?? e.person ?? e.card ?? 'unknown';
        const p = people.get(k) ?? { person: e.person, holder: e.match?.holderId ?? null, entrances: 0, refused: 0, last: e.at };
        if (e.category === 'entrance') p.entrances++; else p.refused++;
        if (e.at > p.last) p.last = e.at;
        people.set(k, p);
      }
      return { tz: r.tz, days: q.days, door: { id: door?.external_id ?? q.door, name: door?.name ?? q.door, floor: door?.data?.floor ?? null },
        totals: { ...totals(events), entrances: r.counts.entrances, refused: r.counts.all - r.counts.entrances }, people: [...people.values()].sort((a, b) => b.last.localeCompare(a.last)), byDay: byDay(events, tzDay), events: events.slice(0, 500) };
    }

    // A person: by Visionline user id (all their keycards and mobile keys) or by name.
    const u = q.holder ? await one(pool, `SELECT user_id, given_name, surname, user_group FROM vl_users WHERE hotel_id=$1 AND user_id=$2`, [hotelId, q.holder]) : null;
    const s = await one(pool, `SELECT id, full_name, visionline_user_group AS department, job_role AS job_title FROM staff WHERE hotel_id=$1 AND (visionline_user=$2 OR full_name=$3) LIMIT 1`, [hotelId, q.holder ?? null, q.name ?? null]);
    const display = name(u) ?? s?.full_name ?? q.name ?? q.holder ?? '';
    const mine = (e: EventRow) => (q.holder && e.match?.holderId === q.holder) || (e.person && (e.person === display || e.person === q.name));
    const events = r.events.filter(mine);
    const cards = q.holder ? await many(pool, `SELECT k.reg_no, k.starts_at, k.expires_at, k.door_count, k.deadbolt_override, k.key_id IS NOT NULL AS mobile_key,
        (k.starts_at IS NULL OR k.starts_at <= now()) AND (k.expires_at IS NULL OR k.expires_at > now()) AND NOT k.cancelled AND NOT k.discarded AND NOT k.overridden AND k.active AS valid,
        COALESCE((SELECT o.display_name FROM key_requests kr JOIN operators o ON o.id=kr.requested_by WHERE kr.id=k.key_id),
          (SELECT p.operator_name FROM portal_encoded_cards p WHERE p.hotel_id=k.hotel_id AND p.reg_no=k.reg_no), vl_issuer_label(k.hotel_id, k.reg_no)) AS issued_by
      FROM vl_cards k WHERE k.hotel_id=$1 AND k.card_holder=$2 ORDER BY valid DESC, k.expires_at DESC NULLS LAST LIMIT 20`, [hotelId, q.holder]) : [];
    const doors = new Map<string, { door: string; doorId: string | null; entrances: number; refused: number; last: string }>();
    for (const e of events) {
      const k = e.doorId ?? e.door ?? '?';
      const d = doors.get(k) ?? { door: e.door ?? '—', doorId: e.doorId, entrances: 0, refused: 0, last: e.at };
      if (e.category === 'entrance') d.entrances++; else d.refused++;
      if (e.at > d.last) d.last = e.at;
      doors.set(k, d);
    }
    return { tz: r.tz, days: q.days,
      person: { name: display, holder: q.holder ?? null, group: u?.user_group ?? s?.department ?? null, jobTitle: s?.job_title ?? null, staffId: s?.id ?? null },
      cards: cards.map((c) => ({ regNo: c.reg_no, startsAt: c.starts_at, expiresAt: c.expires_at, doors: c.door_count, deadbolt: c.deadbolt_override, mobileKey: c.mobile_key, valid: c.valid, issuedBy: c.issued_by ?? (c.mobile_key ? null : 'Issued from Visionline') })),
      totals: { ...totals(events), entrances: r.counts.entrances, refused: r.counts.all - r.counts.entrances }, doors: [...doors.values()].sort((a, b) => b.last.localeCompare(a.last)), byDay: byDay(events, tzDay), events: events.slice(0, 500) };
  });
}

/** 2.12 "Worth a look" on the overview: a few things a manager would want to know, each one click from the detail. */
export function highlightRoutes(app: FastifyInstance) {
  app.get(`${P}/hotels/:hotelId/highlights`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'resources.read').catch((e) => requirePerm(req, hotelId, 'events.read').catch(() => { throw e; }));
    const perms = permsIn(op, hotelId);
    const out: { id: string; tone: 'bad' | 'warn' | 'ok'; value: string; title: string; detail: string; link: string }[] = [];
    if (perms.has('events.read')) {
      const to = new Date();
      const r = await queryEvents(hotelId, { from: new Date(to.getTime() - 7 * 86_400_000), to, cls: 'all', categories: ['entrance', 'refused'], door: null, q: null, limit: 5_000 });
      const refusedBy = new Map<string, { name: string; holder: string | null; n: number }>();
      for (const e of r.events) if (e.category === 'refused' && (e.person || e.match?.holderId)) {
        const k = e.person ?? e.match!.holderId!; const x = refusedBy.get(k) ?? { name: k, holder: e.match?.holderId ?? null, n: 0 }; x.n++; if (!x.holder && e.match?.holderId) x.holder = e.match.holderId; refusedBy.set(k, x);
      }
      const often = [...refusedBy.values()].filter((x) => x.n >= 3).sort((a, b) => b.n - a.n);
      if (often.length) out.push({ id: 'refused', tone: 'warn', value: String(often.length), title: 'people refused at doors 3 times or more', detail: often.slice(0, 3).map((x) => `${x.name} (${x.n})`).join(', '), link: often[0]!.holder ? `/access?holder=${encodeURIComponent(often[0]!.holder)}&days=7` : `/access?name=${encodeURIComponent(often[0]!.name)}&days=7` });
      const unmatched = r.events.filter((e) => e.match && !e.match.known);
      if (unmatched.length) out.push({ id: 'unmatched', tone: 'bad', value: String(unmatched.length), title: 'door events with a card that matches no keycard', detail: `last at ${unmatched[0]!.door ?? 'a door'} · last 7 days`, link: '/events?match=unknown&p=7d' });
      const entr = r.events.filter((e) => e.category === 'entrance');
      const night = entr.filter((e) => { const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: r.tz, hour: '2-digit', hour12: false }).format(new Date(e.at))); return h >= 0 && h < 5; });
      if (night.length) out.push({ id: 'night', tone: 'warn', value: String(night.length), title: 'entrances between midnight and 5 am', detail: [...new Set(night.map((e) => e.person).filter(Boolean))].slice(0, 3).join(', ') || 'unknown holders', link: '/insights?page=access&days=7' });
      out.push({ id: 'entrances', tone: 'ok', value: entr.length.toLocaleString(), title: 'door entrances in the last 7 days', detail: `${new Set(entr.map((e) => e.match?.holderId ?? e.person)).size} different people`, link: '/insights?page=access&days=7' });
    }
    if (perms.has('reports.read')) {
      const k = await one(pool, `SELECT count(*) FILTER (WHERE expires_at BETWEEN now() AND now() + interval '7 days')::int AS ending,
          count(*) FILTER (WHERE deadbolt_override)::int AS deadbolt
        FROM vl_cards WHERE hotel_id=$1 AND active AND NOT cancelled AND NOT discarded AND NOT overridden AND (expires_at IS NULL OR expires_at > now())`, [hotelId]);
      if (k!.ending) out.push({ id: 'ending', tone: 'warn', value: String(k!.ending), title: 'keycards end within 7 days', detail: 'renew the ones still needed in Visionline', link: '/insights?page=cards' });
      if (k!.deadbolt) out.push({ id: 'deadbolt', tone: 'ok', value: String(k!.deadbolt), title: 'valid keycards can override the deadbolt', detail: 'check that each one still needs it', link: '/visionline?tab=cards' });
    }
    if (perms.has('key.read')) {
      const u = await one(pool, `SELECT count(*)::int AS n FROM key_requests WHERE hotel_id=$1 AND status='ISSUED' AND first_used_at IS NULL AND created_at < now() - interval '3 days'`, [hotelId]);
      if (u!.n) out.push({ id: 'unused', tone: 'warn', value: String(u!.n), title: 'mobile keys never used at a door after 3 days', detail: 'maybe the phone was not set up', link: '/keys' });
    }
    return out;
  });
}

function totals(events: EventRow[]) {
  return { entrances: events.filter((e) => e.category === 'entrance').length, refused: events.filter((e) => e.category === 'refused').length,
    doors: new Set(events.map((e) => e.doorId ?? e.door)).size, last: events[0]?.at ?? null };
}
function byDay(events: EventRow[], f: Intl.DateTimeFormat) {
  const m = new Map<string, { day: string; entrances: number; refused: number }>();
  for (const e of events) {
    const d = f.format(new Date(e.at));
    const x = m.get(d) ?? { day: d, entrances: 0, refused: 0 };
    if (e.category === 'entrance') x.entrances++; else x.refused++;
    m.set(d, x);
  }
  return [...m.values()].sort((a, b) => a.day.localeCompare(b.day));
}
