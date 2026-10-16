import { pool, many, one } from '../db.ts';
import { getConfig, SCHEMAS } from '../hotel-config.ts';
import { ApiError } from '../lib/errors.ts';
import { computeDays, totals, workDayOf, dayBoundary, addDays, type Punch, type Shift } from './compute.ts';

/** Time & attendance (2.8): settings, people, timesheets, door records, approved periods. */
export async function attendancePolicy(hotelId: string) {
  const p = SCHEMAS.policy.safeParse((await getConfig(pool, hotelId, 'policy')) ?? {});
  return (p.success ? p.data : SCHEMAS.policy.parse({})).attendance;
}
export async function hotelTz(hotelId: string) {
  return ((await getConfig(pool, hotelId, 'property'))?.timezone ?? (await one(pool, 'SELECT timezone FROM hotels WHERE id=$1', [hotelId]))?.timezone ?? 'UTC') as string;
}
export async function attendanceOn(hotelId: string) {
  return Boolean((await getConfig(pool, hotelId, 'features'))?.timeAttendance);
}
export async function requireAttendanceOn(hotelId: string) {
  if (!(await attendanceOn(hotelId))) throw new ApiError(409, 'MODULE_OFF', 'Time & attendance is switched off (Settings -> Modules).');
}
export const shiftOf = (r: any): Shift | null => r ? ({ id: r.id, name: r.name, start: r.start_time, end: r.end_time, breakMinutes: r.break_minutes, graceMinutes: r.grace_minutes, workDays: r.work_days }) : null;
export const todayIn = (tz: string, dayStartsAt: string) => workDayOf(new Date(), tz, dayStartsAt);
const iso = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d == null ? null : String(d).slice(0, 10));

/** Is this day inside a period already approved for payroll? Then nothing in it may change. */
export async function assertOpen(hotelId: string, date: string) {
  const p = await one(pool, `SELECT date_from, date_to FROM ta_periods WHERE hotel_id=$1 AND $2::date BETWEEN date_from AND date_to LIMIT 1`, [hotelId, date]);
  if (p) throw new ApiError(409, 'PERIOD_APPROVED', `${date} is in a period approved for payroll (${iso(p.date_from)} to ${iso(p.date_to)}). Re-open the period first.`);
}

export async function timesheet(hotelId: string, o: { from: string; to: string; personId?: string | null; department?: string | null; includeInactive?: boolean }) {
  const pol = await attendancePolicy(hotelId);
  const tz = await hotelTz(hotelId);
  const today = todayIn(tz, pol.dayStartsAt);
  const people = await many(pool, `SELECT p.*, s.id AS s_id, s.name AS s_name, s.start_time, s.end_time, s.break_minutes, s.grace_minutes, s.work_days
      FROM ta_people p LEFT JOIN ta_shifts s ON s.id=p.shift_id
     WHERE p.hotel_id=$1 AND ($2::uuid IS NULL OR p.id=$2) AND ($3::text IS NULL OR p.department=$3) AND ($4 OR p.active)
     ORDER BY p.department NULLS LAST, p.full_name`, [hotelId, o.personId ?? null, o.department ?? null, Boolean(o.includeInactive)]);
  if (!people.length) return { tz, today, from: o.from, to: o.to, people: [], approved: await approvedIn(hotelId, o.from, o.to) };
  const ids = people.map((p) => p.id);
  // Records from the day before to the day after, so night shifts at the edges are complete.
  const fromAt = new Date(`${addDays(o.from, -1)}T00:00:00Z`), toAt = new Date(`${addDays(o.to, 2)}T00:00:00Z`);
  const punches = await many(pool, `SELECT id, person_id, at, direction, source FROM ta_punches WHERE hotel_id=$1 AND person_id = ANY($2) AND voided_at IS NULL AND at BETWEEN $3 AND $4 ORDER BY at`, [hotelId, ids, fromAt, toAt]);
  const absences = await many(pool, `SELECT person_id, date_from, date_to, kind, note FROM ta_absences WHERE hotel_id=$1 AND (person_id IS NULL OR person_id = ANY($2)) AND date_to >= $3 AND date_from <= $4`, [hotelId, ids, o.from, o.to]);
  const out = people.map((p) => {
    const shift = p.s_id ? shiftOf({ id: p.s_id, name: p.s_name, start_time: p.start_time, end_time: p.end_time, break_minutes: p.break_minutes, grace_minutes: p.grace_minutes, work_days: p.work_days }) : null;
    const days = computeDays({
      from: o.from, to: o.to, tz, today, shift, policy: pol, startDate: iso(p.start_date), endDate: iso(p.end_date),
      punches: punches.filter((x) => x.person_id === p.id).map((x) => ({ id: x.id, at: new Date(x.at), direction: x.direction, source: x.source }) as Punch),
      absences: absences.filter((a) => !a.person_id || a.person_id === p.id).map((a) => ({ from: iso(a.date_from)!, to: iso(a.date_to)!, kind: a.kind, note: a.note })),
    });
    return { id: p.id, name: p.full_name, employeeNo: p.employee_no, department: p.department, jobTitle: p.job_title, kind: p.kind, employment: p.employment, payBasis: p.pay_basis,
      shift: shift?.name ?? null, active: p.active, days, totals: totals(days) };
  });
  return { tz, today, from: o.from, to: o.to, people: out, approved: await approvedIn(hotelId, o.from, o.to) };
}

async function approvedIn(hotelId: string, from: string, to: string) {
  return (await many(pool, `SELECT p.id, p.date_from, p.date_to, p.approved_at, o.display_name AS approved_by FROM ta_periods p LEFT JOIN operators o ON o.id=p.approved_by
    WHERE p.hotel_id=$1 AND p.date_to >= $2 AND p.date_from <= $3 ORDER BY p.date_from`, [hotelId, from, to])).map((r) => ({ ...r, date_from: iso(r.date_from), date_to: iso(r.date_to) }));
}

/** Who is in right now: today's records per person. */
export async function today(hotelId: string) {
  const pol = await attendancePolicy(hotelId);
  const tz = await hotelTz(hotelId);
  const d = todayIn(tz, pol.dayStartsAt);
  const t = await timesheet(hotelId, { from: d, to: d });
  const last = await many(pool, `SELECT DISTINCT ON (person_id) person_id, at, direction, source FROM ta_punches WHERE hotel_id=$1 AND voided_at IS NULL AND at > now() - interval '36 hours' ORDER BY person_id, at DESC`, [hotelId]);
  const lastBy = new Map(last.map((l) => [l.person_id, l]));
  const people = t.people.map((p) => {
    const day = p.days[0]!;
    const l = lastBy.get(p.id);
    const inNow = day.punches > 0 && day.status === 'incomplete' && (!l || l.direction !== 'out');
    return { ...p, day, state: inNow ? 'in' : day.punches > 0 ? 'out' : day.status === 'leave' || day.status === 'holiday' ? day.status : day.status === 'off' ? 'off' : 'not_in', lastAt: l?.at ?? null };
  });
  const c = (s: string) => people.filter((p) => p.state === s).length;
  return { date: d, tz, people, counts: { in: c('in'), out: c('out'), notIn: c('not_in'), leave: c('leave') + c('holiday'), off: c('off'), total: people.length } };
}

/**
 * Door entrances (lock events at the attendance doors) become clock records for the person holding the card:
 * a mobile key (platform staff) or a Visionline keycard (holder linked to a person). Repeats within a few minutes
 * (passing the door twice) are ignored.
 */
export async function recordDoorEntrance(hotelId: string, e: { eventId: string; doorId: string | null; reg: string | null; at: Date }) {
  if (!e.doorId || !e.reg || !(await attendanceOn(hotelId))) return null;
  const pol = await attendancePolicy(hotelId);
  if (!pol.doorIds.length) return null;
  const door = await one(pool, `SELECT external_id FROM resources WHERE hotel_id=$1 AND kind='door' AND (external_id=$2 OR data->>'doorID'=$2 OR name=$2) LIMIT 1`, [hotelId, e.doorId]);
  const doorKey = door?.external_id ?? e.doorId;
  if (!pol.doorIds.includes(doorKey)) return null;
  const person = await one(pool, `SELECT p.id FROM ta_people p WHERE p.hotel_id=$1 AND p.active AND (
      p.staff_id = (SELECT k.staff_id FROM key_requests k WHERE k.hotel_id=$1 AND (k.card_reg_no=$2 OR (k.card_reg_no IS NULL AND k.credential_id=$2)) ORDER BY k.created_at DESC LIMIT 1)
      OR p.vl_user_id = (SELECT c.card_holder FROM vl_cards c WHERE c.hotel_id=$1 AND c.reg_no=$2 LIMIT 1)) LIMIT 1`, [hotelId, e.reg]);
  if (!person) return null;
  const recent = await one(pool, `SELECT 1 FROM ta_punches WHERE hotel_id=$1 AND person_id=$2 AND voided_at IS NULL AND at BETWEEN $3::timestamptz - make_interval(mins => $4) AND $3::timestamptz + make_interval(mins => $4)`, [hotelId, person.id, e.at, pol.ignoreRepeatMinutes]);
  if (recent) return null;
  const r = await one(pool, `INSERT INTO ta_punches (hotel_id, person_id, at, direction, source, door_id, event_ref) VALUES ($1,$2,$3,'auto','door',$4,$5) ON CONFLICT (event_ref) DO NOTHING RETURNING id`,
    [hotelId, person.id, e.at, doorKey, `vl:${e.eventId}`]);
  return r?.id ?? null;
}

export { dayBoundary };
