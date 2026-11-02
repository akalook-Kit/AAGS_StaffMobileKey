/**
 * Breakfast (2.11). Who is in the hotel today and who may have breakfast comes from the in-house list: the PMS
 * "in-house guests" report imported as CSV, or rooms typed by front office (later straight from the PMS). A stay
 * stays on the list from arrival until departure, so the list is imported once and only changes are added.
 * The restaurant looks a room up and records how many people were served; above what the rate includes (or a
 * room not on the list) is recorded as paying. Nothing is deleted: mistakes are voided with a reason.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, many, one, tx } from '../db.ts';
import { audit } from '../audit.ts';
import { requirePerm, permsIn } from '../auth.ts';
import { ApiError, badRequest, notFound } from '../lib/errors.ts';
import { getConfig, saveConfig, validateConfig } from '../hotel-config.ts';
import { addDays, datesBetween, workDayOf } from '../attendance/compute.ts';
import { hotelTz } from '../attendance/service.ts';
import { buildReportPdf } from '../pdf.ts';

const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Hotel');
  return id;
};
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const Room = z.string().trim().min(1).max(20).transform((v) => v.toUpperCase());
const csvCell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (head: string[], rows: unknown[][]) => '﻿' + [head.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n');

async function requireOn(hotelId: string) {
  if (!(await getConfig(pool, hotelId, 'features'))?.breakfast) throw new ApiError(409, 'MODULE_OFF', 'Breakfast is switched off (Settings → Modules).');
}
async function policy(hotelId: string) {
  const p = (await getConfig(pool, hotelId, 'policy'))?.breakfast ?? {};
  return { dayStartsAt: '03:00', serviceFrom: '06:00', serviceUntil: '10:30', countChildren: true, allowWalkIns: true, ...p } as
    { dayStartsAt: string; serviceFrom: string; serviceUntil: string; countChildren: boolean; allowWalkIns: boolean };
}
/** The breakfast day "now" in the hotel's time zone. */
export async function breakfastToday(hotelId: string) {
  const [tz, pol] = await Promise.all([hotelTz(hotelId), policy(hotelId)]);
  return { day: workDayOf(new Date(), tz, pol.dayStartsAt), tz, pol };
}

const STAY_COLS = `id, room, guest_name, adults, children, arrival::text, departure::text, breakfast, note, source, external_ref, checked_out_at`;
const stayOut = (s: any) => ({ id: s.id, room: s.room, guestName: s.guest_name, adults: s.adults, children: s.children, arrival: s.arrival, departure: s.departure,
  breakfast: s.breakfast, note: s.note, source: s.source, ref: s.external_ref, checkedOut: Boolean(s.checked_out_at) });

/** Everything the restaurant needs for one day: rooms in house, what is included, who was served. */
async function dayView(hotelId: string, day: string) {
  const pol = await policy(hotelId);
  const stays = await many(pool, `SELECT ${STAY_COLS} FROM bf_stays WHERE hotel_id=$1 AND arrival <= $2::date AND departure > $2::date AND (ended_on IS NULL OR ended_on > $2::date) ORDER BY room, guest_name`, [hotelId, day]);
  const served = await many(pool, `SELECT s.id, s.room, s.stay_id, s.persons, s.kind, s.note, s.served_at, s.voided_at, s.void_reason, o.display_name AS served_by_name, s.served_by
    FROM bf_served s LEFT JOIN operators o ON o.id=s.served_by WHERE s.hotel_id=$1 AND s.day=$2 ORDER BY s.served_at`, [hotelId, day]);
  const live = served.filter((x) => !x.voided_at);
  const rooms = new Map<string, any>();
  for (const s of stays) {
    const r = rooms.get(s.room) ?? { room: s.room, stays: [], included: 0, persons: 0, servedIncluded: 0, servedPaying: 0, lastServedAt: null };
    r.stays.push(stayOut(s));
    const persons = s.adults + (pol.countChildren ? s.children : 0);
    r.persons += persons;
    if (s.breakfast) r.included += persons;
    rooms.set(s.room, r);
  }
  const walkIns: any[] = [];
  for (const x of live) {
    const r = x.room ? rooms.get(x.room) : null;
    if (!r) { walkIns.push(x); continue; }
    if (x.kind === 'included') r.servedIncluded += x.persons; else r.servedPaying += x.persons;
    r.lastServedAt = x.served_at;
  }
  const list = [...rooms.values()].map((r) => ({ ...r, remaining: Math.max(0, r.included - r.servedIncluded), status: r.included === 0 ? 'not_included' : r.servedIncluded >= r.included ? 'done' : r.servedIncluded > 0 ? 'partly' : 'waiting' }));
  const sum = (f: (r: any) => number) => list.reduce((a, r) => a + f(r), 0);
  return {
    day, policy: pol,
    totals: {
      rooms: list.length, guests: sum((r) => r.persons), expected: sum((r) => r.included), served: sum((r) => r.servedIncluded),
      remaining: sum((r) => r.remaining), paying: sum((r) => r.servedPaying) + walkIns.reduce((a, x) => a + x.persons, 0), walkIns: walkIns.length,
      roomsDone: list.filter((r) => r.status === 'done').length, roomsWaiting: list.filter((r) => r.status === 'waiting').length,
    },
    rooms: list,
    served: served.map((x) => ({ id: x.id, room: x.room, stayId: x.stay_id, persons: x.persons, kind: x.kind, note: x.note, servedAt: x.served_at, servedBy: x.served_by_name, servedById: x.served_by, voided: Boolean(x.voided_at), voidReason: x.void_reason })),
  };
}

const StayBody = z.object({
  room: Room, guestName: z.string().trim().max(120).nullable().optional().transform((v) => v || null),
  adults: z.coerce.number().int().min(0).max(20).default(1), children: z.coerce.number().int().min(0).max(20).default(0),
  arrival: Day, departure: Day, breakfast: z.boolean().default(true), note: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
}).refine((s) => s.departure > s.arrival, { message: 'Departure must be after arrival', path: ['departure'] }).refine((s) => s.adults + s.children > 0, { message: 'At least one guest', path: ['adults'] });

export function breakfastRoutes(app: FastifyInstance) {
  const base = `${P}/hotels/:hotelId/breakfast`;

  app.get(`${base}/day`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'breakfast.read');
    await requireOn(hotelId);
    const { day: today, tz } = await breakfastToday(hotelId);
    const q = z.object({ date: Day.optional() }).parse(req.query);
    const v = await dayView(hotelId, q.date ?? today);
    const perms = permsIn(op, hotelId);
    return { ...v, today, timeZone: tz, can: { serve: perms.has('breakfast.serve'), manage: perms.has('breakfast.manage') } };
  });

  app.post(`${base}/serve`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'breakfast.serve');
    await requireOn(hotelId);
    const b = z.object({ room: Room.optional(), persons: z.number().int().min(1).max(30), kind: z.enum(['included', 'paying', 'walk_in']).optional(),
      note: z.string().trim().max(200).optional(), date: Day.optional() }).parse(req.body);
    const { day: today, pol } = await breakfastToday(hotelId);
    const day = b.date ?? today;
    if (day !== today && !permsIn(op, hotelId).has('breakfast.manage')) throw new ApiError(403, 'FORBIDDEN', 'Only today can be recorded at the restaurant.');
    if (day > today) throw badRequest('VALIDATION', 'Breakfast cannot be recorded for a future day.');
    const v = await dayView(hotelId, day);
    const room = b.room ? v.rooms.find((r) => r.room === b.room) : undefined;
    let kind = b.kind;
    if (!kind) kind = !room ? 'walk_in' : room.remaining >= b.persons ? 'included' : 'paying';
    if (kind === 'included' && (!room || room.remaining < b.persons))
      throw new ApiError(409, 'NOT_INCLUDED', room ? `Room ${room.room} has ${room.remaining} breakfast(s) left in its rate; record the others as paying.` : `Room ${b.room ?? ''} is not on today's in-house list.`);
    if (kind !== 'included' && !pol.allowWalkIns) throw new ApiError(409, 'WALK_INS_OFF', 'Only breakfasts included in the rate can be recorded (Breakfast → Setup).');
    if (kind === 'walk_in' && !b.note && !b.room) throw badRequest('VALIDATION', 'For a guest without a room, add a note (name or reason).');
    const r = await one(pool, `INSERT INTO bf_served (hotel_id, day, room, stay_id, persons, kind, note, served_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, served_at`,
      [hotelId, day, b.room ?? null, room?.stays[0]?.id ?? null, b.persons, kind, b.note ?? null, op.id]);
    return { id: r!.id, kind, servedAt: r!.served_at, day };
  });

  app.post(`${base}/served/:id/void`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'breakfast.serve');
    await requireOn(hotelId);
    const b = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(200) }).parse(req.body);
    const id = z.string().uuid().parse((req.params as any).id);
    const row = await one(pool, `SELECT * FROM bf_served WHERE id=$1 AND hotel_id=$2`, [id, hotelId]);
    if (!row) throw notFound('Record');
    if (row.voided_at) return { ok: true, already: true };
    const own = row.served_by === op.id && Date.now() - new Date(row.served_at).getTime() < 15 * 60_000;
    if (!own && !permsIn(op, hotelId).has('breakfast.manage')) throw new ApiError(403, 'FORBIDDEN', 'You can undo your own entries for 15 minutes; ask a supervisor for older ones.');
    await pool.query(`UPDATE bf_served SET voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1`, [id, op.id, b.reason]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'breakfast.voided', targetType: 'breakfast', targetId: id, details: { room: row.room, persons: row.persons, day: row.day, reason: b.reason } });
    return { ok: true };
  });

  // ---- In-house list ---------------------------------------------------------------------------------------
  app.get(`${base}/stays`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'breakfast.read');
    await requireOn(hotelId);
    const { day: today } = await breakfastToday(hotelId);
    const q = z.object({ date: Day.optional(), scope: z.enum(['inhouse', 'upcoming', 'all']).default('inhouse'), q: z.string().trim().max(60).optional() }).parse(req.query);
    const day = q.date ?? today;
    const where = q.scope === 'inhouse' ? `arrival <= $2::date AND departure > $2::date AND (ended_on IS NULL OR ended_on > $2::date)` : q.scope === 'upcoming' ? `arrival > $2::date` : `departure > $2::date - 30`;
    const rows = await many(pool, `SELECT ${STAY_COLS} FROM bf_stays WHERE hotel_id=$1 AND ${where}
      AND ($3::text IS NULL OR room ILIKE '%'||$3||'%' OR guest_name ILIKE '%'||$3||'%') ORDER BY room, arrival LIMIT 2000`, [hotelId, day, q.q || null]);
    return { day, stays: rows.map(stayOut) };
  });

  app.post(`${base}/stays`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'breakfast.manage');
    await requireOn(hotelId);
    const s = StayBody.parse(req.body);
    const r = await one(pool, `INSERT INTO bf_stays (hotel_id, room, guest_name, adults, children, arrival, departure, breakfast, note, source, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',$10) RETURNING ${STAY_COLS}`, [hotelId, s.room, s.guestName, s.adults, s.children, s.arrival, s.departure, s.breakfast, s.note, op.id]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'breakfast.stay_added', targetType: 'stay', targetId: r!.id, details: { room: s.room, arrival: s.arrival, departure: s.departure, breakfast: s.breakfast } });
    return stayOut(r);
  });

  app.put(`${base}/stays/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'breakfast.manage');
    await requireOn(hotelId);
    const s = StayBody.parse(req.body);
    const r = await one(pool, `UPDATE bf_stays SET room=$3, guest_name=$4, adults=$5, children=$6, arrival=$7, departure=$8, breakfast=$9, note=$10, ended_on=NULL, checked_out_at=NULL, updated_at=now()
      WHERE id=$1 AND hotel_id=$2 RETURNING ${STAY_COLS}`, [z.string().uuid().parse((req.params as any).id), hotelId, s.room, s.guestName, s.adults, s.children, s.arrival, s.departure, s.breakfast, s.note]);
    if (!r) throw notFound('Stay');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'breakfast.stay_changed', targetType: 'stay', targetId: r.id, details: { room: s.room, arrival: s.arrival, departure: s.departure, breakfast: s.breakfast } });
    return stayOut(r);
  });

  /** Guest left early: from today the room is no longer on the list. */
  app.post(`${base}/stays/:id/checkout`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'breakfast.manage');
    await requireOn(hotelId);
    const { day: today } = await breakfastToday(hotelId);
    const r = await one(pool, `UPDATE bf_stays SET departure=GREATEST(arrival + 1, LEAST(departure, $3::date)), ended_on=$3::date, checked_out_at=now(), updated_at=now() WHERE id=$1 AND hotel_id=$2 RETURNING ${STAY_COLS}`,
      [z.string().uuid().parse((req.params as any).id), hotelId, today]);
    if (!r) throw notFound('Stay');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'breakfast.stay_checked_out', targetType: 'stay', targetId: r.id, details: { room: r.room, departure: r.departure } });
    return stayOut(r);
  });

  /**
   * In-house list from the PMS (columns mapped in the portal). Rows with the PMS reservation number update the same
   * stay when imported again. With replace, the file is the complete list for that day: stays on the list that the
   * file does not contain are ended (left early or moved), so importing every morning keeps the list exact.
   */
  app.post(`${base}/stays/import`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'breakfast.manage');
    await requireOn(hotelId);
    const { day: today } = await breakfastToday(hotelId);
    const b = z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(3000), replace: z.boolean().default(false), date: Day.optional() }).parse(req.body);
    const day = b.date ?? today;
    const errors: { row: number; message: string }[] = [];
    const ok: (z.infer<typeof StayBody> & { ref: string | null })[] = [];
    b.rows.forEach((raw, i) => {
      const yes = (v: unknown) => (v === undefined || v === null || v === '' ? true : /^(1|y|yes|true|oui|bb|hb|fb|ai|included|incl)$/i.test(String(v).trim()));
      const r = StayBody.safeParse({ ...raw, arrival: raw.arrival ?? day, departure: raw.departure ?? addDays(String(raw.arrival ?? day), 1), breakfast: typeof raw.breakfast === 'boolean' ? raw.breakfast : yes(raw.breakfast) });
      if (!r.success) errors.push({ row: i + 1, message: r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
      else ok.push({ ...r.data, ref: raw.ref ? String(raw.ref).trim().slice(0, 80) : null });
    });
    if (errors.length && !ok.length) throw badRequest('VALIDATION', 'No row could be read.', errors.slice(0, 50));
    const result = await tx(async (c) => {
      let added = 0, updated = 0, ended = 0;
      const kept: string[] = [];
      for (const s of ok) {
        let r = s.ref ? await one(c, `UPDATE bf_stays SET room=$3, guest_name=$4, adults=$5, children=$6, arrival=$7, departure=$8, breakfast=$9, note=COALESCE($10, note), source='import', checked_out_at=NULL, ended_on=NULL, updated_at=now()
            WHERE hotel_id=$1 AND external_ref=$2 RETURNING id`, [hotelId, s.ref, s.room, s.guestName, s.adults, s.children, s.arrival, s.departure, s.breakfast, s.note]) : null;
        if (r) updated++;
        else if (!s.ref) {
          // Without a reservation number: the same room, guest and arrival is the same stay.
          r = await one(c, `UPDATE bf_stays SET adults=$5, children=$6, departure=$7, breakfast=$8, source='import', checked_out_at=NULL, ended_on=NULL, updated_at=now()
            WHERE hotel_id=$1 AND room=$2 AND arrival=$3 AND coalesce(guest_name,'')=coalesce($4,'') RETURNING id`, [hotelId, s.room, s.arrival, s.guestName, s.adults, s.children, s.departure, s.breakfast]);
          if (r) updated++;
        }
        if (!r) { r = await one(c, `INSERT INTO bf_stays (hotel_id, room, guest_name, adults, children, arrival, departure, breakfast, note, source, external_ref, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'import',$10,$11) RETURNING id`, [hotelId, s.room, s.guestName, s.adults, s.children, s.arrival, s.departure, s.breakfast, s.note, s.ref, op.id]); added++; }
        kept.push(r!.id);
      }
      if (b.replace) {
        const e = await c.query(`UPDATE bf_stays SET departure=GREATEST(arrival + 1, $3::date), ended_on=$3::date, checked_out_at=now(), updated_at=now()
          WHERE hotel_id=$1 AND arrival <= $3::date AND departure > $3::date AND (ended_on IS NULL OR ended_on > $3::date) AND NOT (id = ANY($2::uuid[]))`, [hotelId, kept, day]);
        ended = e.rowCount ?? 0;
      }
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'breakfast.list_imported', details: { day, rows: b.rows.length, added, updated, ended, rejected: errors.length, replace: b.replace } });
      return { added, updated, ended };
    });
    return { ...result, rejected: errors.length, errors: errors.slice(0, 50), day };
  });

  // ---- Reports ----------------------------------------------------------------------------------------------
  async function report(hotelId: string, from: string, to: string) {
    const days = datesBetween(from, to);
    if (days.length > 62) throw badRequest('VALIDATION', 'At most 62 days at a time.');
    const out = [];
    for (const d of days) { const v = await dayView(hotelId, d); out.push({ day: d, ...v.totals, noShowRooms: v.rooms.filter((r) => r.included > 0 && r.servedIncluded === 0).map((r) => r.room) }); }
    return out;
  }
  const RangeQ = z.object({ from: Day, to: Day }).refine((r) => r.to >= r.from, 'The end must not be before the start');

  app.get(`${base}/report`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'breakfast.read');
    await requireOn(hotelId);
    const r = RangeQ.parse(req.query);
    return { from: r.from, to: r.to, days: await report(hotelId, r.from, r.to) };
  });

  app.get(`${base}/export.csv`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'breakfast.read');
    await requireOn(hotelId);
    const r = RangeQ.parse(req.query);
    const rows: unknown[][] = [];
    for (const d of datesBetween(r.from, r.to).slice(0, 62)) {
      const v = await dayView(hotelId, d);
      for (const x of v.rooms) rows.push([d, x.room, x.stays.map((s: any) => s.guestName).filter(Boolean).join(' / '), x.persons, x.included, x.servedIncluded, x.servedPaying, x.remaining]);
      for (const x of v.served.filter((s) => !s.voided && !v.rooms.some((rr) => rr.room === s.room))) rows.push([d, x.room ?? '', x.note ?? 'walk-in', '', 0, 0, x.persons, 0]);
    }
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'breakfast.exported', details: { ...r, rows: rows.length } });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="breakfast-${r.from}_${r.to}.csv"`).header('cache-control', 'private, no-store');
    return csv(['date', 'room', 'guests', 'persons_in_room', 'breakfast_included', 'served_included', 'served_paying', 'not_come'], rows);
  });

  /** The day sheet for the restaurant manager / F&B: every room, expected, served, paying; hotel header on each page. */
  app.post(`${base}/pdf`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'breakfast.read');
    await requireOn(hotelId);
    const { day: today, tz } = await breakfastToday(hotelId);
    const b = z.object({ date: Day.optional() }).parse(req.body ?? {});
    const v = await dayView(hotelId, b.date ?? today);
    const STATUS: Record<string, string> = { done: 'Served', partly: 'Partly', waiting: 'Not come', not_included: 'Not in rate' };
    const out = await buildReportPdf({
      hotelId, report: 'breakfast-day', title: 'Breakfast - day sheet', operatorId: op.id, operatorName: op.displayName,
      selection: [`Breakfast day: ${v.day} (${tz}) · service ${v.policy.serviceFrom}-${v.policy.serviceUntil}`],
      summary: [['Rooms in house', String(v.totals.rooms)], ['Breakfasts in rate', String(v.totals.expected)], ['Served (in rate)', String(v.totals.served)], ['Not come', String(v.totals.remaining)], ['Paying / walk-in', String(v.totals.paying)]],
      columns: [{ label: 'Room', width: 7 }, { label: 'Guest(s)', width: 26 }, { label: 'Persons', width: 8, align: 'right' }, { label: 'In rate', width: 8, align: 'right' }, { label: 'Served', width: 8, align: 'right' },
        { label: 'Paying', width: 8, align: 'right' }, { label: 'Status', width: 11 }, { label: 'Last served', width: 11 }],
      rows: [
        ...v.rooms.map((r) => [r.room, r.stays.map((s: any) => s.guestName).filter(Boolean).join(' / ') || '—', String(r.persons), String(r.included), String(r.servedIncluded), String(r.servedPaying),
          STATUS[r.status] ?? r.status, r.lastServedAt ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(r.lastServedAt)) : '']),
        ...v.served.filter((s) => !s.voided && !v.rooms.some((rr) => rr.room === s.room)).map((s) => [s.room ?? '—', s.note ?? 'Walk-in', '', '0', '0', String(s.persons), 'Walk-in',
          new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(s.servedAt))]),
      ],
      tones: v.rooms.map((r) => (r.status === 'waiting' ? 'warning' : null)),
      filters: { day: v.day },
    });
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'report.printed', targetType: 'report', targetId: out.reportId, details: { report: 'breakfast-day', day: v.day, sha256: out.sha256 } });
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="breakfast-${v.day}.pdf"`).header('cache-control', 'private, no-store').header('x-report-id', out.reportId).header('x-report-sha256', out.sha256);
    return reply.send(out.bytes);
  });

  // ---- Settings and rooms ---------------------------------------------------------------------------------------
  app.get(`${base}/settings`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'breakfast.read');
    return policy(hotelId);
  });
  app.put(`${base}/settings`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'breakfast.manage');
    const b = z.object({ dayStartsAt: z.string().regex(/^\d{2}:\d{2}$/), serviceFrom: z.string().regex(/^\d{2}:\d{2}$/), serviceUntil: z.string().regex(/^\d{2}:\d{2}$/),
      countChildren: z.boolean(), allowWalkIns: z.boolean() }).parse(req.body);
    const cur = (await getConfig(pool, hotelId, 'policy')) ?? {};
    const data = await validateConfig(pool, hotelId, 'policy', { ...cur, breakfast: b });
    const version = await saveConfig(pool, hotelId, 'policy', data, op.id);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'config.published', targetType: 'config', targetId: 'policy', details: { version, breakfast: b } });
    return { version, settings: b };
  });
  /** Room numbers from Visionline (guest room doors), to help typing and to check imported rooms. */
  app.get(`${base}/rooms`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'breakfast.read');
    const rows = await many(pool, `SELECT name FROM resources WHERE hotel_id=$1 AND kind='door' AND active
      AND (name ~ '^[0-9]{2,5}[A-Za-z]?$' OR coalesce(data->>'doorCategory','') ILIKE '%room%' OR coalesce(data->>'doorCategory','') ILIKE '%guest%') ORDER BY length(name), name`, [hotelId]);
    return rows.map((r) => r.name as string);
  });
}
