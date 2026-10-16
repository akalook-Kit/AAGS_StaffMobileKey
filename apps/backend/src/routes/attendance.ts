import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, many, one, tx } from '../db.ts';
import { audit } from '../audit.ts';
import { requirePerm } from '../auth.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { assertOpen, attendancePolicy, hotelTz, requireAttendanceOn, timesheet, today, todayIn } from '../attendance/service.ts';
import { addDays, datesBetween, workDayOf } from '../attendance/compute.ts';
import { buildReportPdf } from '../pdf.ts';
import { getConfig, saveConfig, validateConfig } from '../hotel-config.ts';

/**
 * Time & attendance (2.8). People (platform staff, Visionline keycard holders, people without a card such as daily
 * workers), shifts, leave and holidays, clock records (attendance doors, the check-in desk, HR corrections with a
 * reason, nothing deleted - records are voided), timesheets, approval of periods for payroll and payroll exports
 * (CSV, JSON for a payroll system, PDF).
 */
const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Hotel');
  return id;
};
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const Range = z.object({ from: Day, to: Day, department: z.string().max(80).optional().transform((v) => v || null), personId: z.string().uuid().optional().transform((v) => v ?? null) })
  .refine((r) => r.to >= r.from, 'The end must not be before the start').refine((r) => datesBetween(r.from, r.to).length <= 62, 'At most 62 days at a time');
const Person = z.object({
  fullName: z.string().trim().min(2).max(100),
  employeeNo: z.string().trim().max(40).nullable().optional().transform((v) => v || null),
  department: z.string().trim().max(80).nullable().optional().transform((v) => v || null),
  jobTitle: z.string().trim().max(80).nullable().optional().transform((v) => v || null),
  employment: z.enum(['permanent', 'contract', 'casual', 'intern']).default('permanent'),
  payBasis: z.enum(['monthly', 'daily', 'hourly']).default('monthly'),
  shiftId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  vlUserId: z.string().trim().max(120).nullable().optional().transform((v) => v || null),
  active: z.boolean().default(true),
  startDate: Day.nullable().optional().transform((v) => v ?? null), endDate: Day.nullable().optional().transform((v) => v ?? null),
});
const Shift = z.object({
  name: z.string().trim().min(2).max(60), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/),
  breakMinutes: z.number().int().min(0).max(600).default(60), graceMinutes: z.number().int().min(0).max(240).default(10),
  workDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5, 6]), active: z.boolean().default(true),
});
const csvCell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (head: string[], rows: unknown[][]) => '﻿' + [head.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n');
const hours = (min: number) => (min / 60).toFixed(2);
const STATUS: Record<string, string> = { present: 'Present', incomplete: 'No check-out', absent: 'Absent', leave: 'Leave', holiday: 'Public holiday', off: 'Day off', future: '' };
const personOut = (p: any) => ({ id: p.id, kind: p.kind, fullName: p.full_name, employeeNo: p.employee_no, department: p.department, jobTitle: p.job_title, employment: p.employment, payBasis: p.pay_basis,
  shiftId: p.shift_id, shift: p.shift_name ?? null, vlUserId: p.vl_user_id, staffId: p.staff_id, active: p.active, startDate: p.start_date, endDate: p.end_date, cardHolder: Boolean(p.vl_user_id || p.has_key) });

export function attendanceRoutes(app: FastifyInstance) {
  const base = `${P}/hotels/:hotelId/attendance`;

  app.get(`${base}/today`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'attendance.clock');
    await requireAttendanceOn(hotelId);
    return today(hotelId);
  });

  /** The check-in desk: check a person in or out now. HR may enter another time (with a reason). */
  app.post(`${base}/clock`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'attendance.clock');
    await requireAttendanceOn(hotelId);
    const b = z.object({ personId: z.string().uuid(), direction: z.enum(['in', 'out']), at: z.coerce.date().optional(), reason: z.string().trim().max(300).optional() }).parse(req.body);
    const person = await one(pool, `SELECT id, full_name, active FROM ta_people WHERE id=$1 AND hotel_id=$2`, [b.personId, hotelId]);
    if (!person) throw notFound('Person');
    if (!person.active) throw badRequest('INACTIVE', `${person.full_name} is not active.`);
    const pol = await attendancePolicy(hotelId);
    const tz = await hotelTz(hotelId);
    const at = b.at ?? new Date();
    const backdated = Math.abs(Date.now() - at.getTime()) > 5 * 60_000;
    if (backdated) {
      await requirePerm(req, hotelId, 'attendance.manage');
      if (pol.requireReason && !b.reason) throw badRequest('REASON_REQUIRED', 'Give a reason for a time that is not now.');
      if (at.getTime() > Date.now() + 5 * 60_000) throw badRequest('FUTURE', 'A check-in cannot be in the future.');
    }
    await assertOpen(hotelId, workDayOf(at, tz, pol.dayStartsAt));
    const r = await one(pool, `INSERT INTO ta_punches (hotel_id, person_id, at, direction, source, entered_by, reason) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, at`,
      [hotelId, b.personId, at, b.direction, backdated ? 'hr' : 'desk', op.id, b.reason ?? null]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: `attendance.${b.direction === 'in' ? 'checked_in' : 'checked_out'}`, targetType: 'ta_person', targetId: b.personId, details: { at: at.toISOString(), source: backdated ? 'hr' : 'desk', reason: b.reason ?? null } });
    return { id: r!.id, at: r!.at, name: person.full_name, direction: b.direction };
  });

  // ---- people ----
  app.get(`${base}/people`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'attendance.clock');
    const q = z.object({ q: z.string().max(80).optional(), all: z.coerce.boolean().optional() }).parse(req.query);
    const like = q.q?.trim() ? `%${q.q.trim().toLowerCase().replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
    const rows = await many(pool, `SELECT p.*, s.name AS shift_name, EXISTS (SELECT 1 FROM key_requests k WHERE k.staff_id=p.staff_id AND k.status='ISSUED') AS has_key
      FROM ta_people p LEFT JOIN ta_shifts s ON s.id=p.shift_id WHERE p.hotel_id=$1 AND ($2 OR p.active)
        AND ($3::text IS NULL OR lower(concat_ws(' ', p.full_name, p.employee_no, p.department, p.job_title)) LIKE $3)
      ORDER BY p.active DESC, p.department NULLS LAST, p.full_name LIMIT 2000`, [hotelId, Boolean(q.all), like]);
    return rows.map(personOut);
  });
  app.post(`${base}/people`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'attendance.manage');
    const b = Person.parse(req.body);
    // Earlier days are not "absent" for someone just added: they start today unless HR gives another date.
    if (!b.startDate) { const pol = await attendancePolicy(hotelId); b.startDate = todayIn(await hotelTz(hotelId), pol.dayStartsAt); }
    try {
      const r = await one(pool, `INSERT INTO ta_people (hotel_id, kind, full_name, employee_no, department, job_title, employment, pay_basis, shift_id, vl_user_id, active, start_date, end_date)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [hotelId, b.vlUserId ? 'keycard' : 'manual', b.fullName, b.employeeNo, b.department, b.jobTitle, b.employment, b.payBasis, b.shiftId, b.vlUserId, b.active, b.startDate, b.endDate]);
      await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'attendance.person_added', targetType: 'ta_person', targetId: r!.id, details: { name: b.fullName, employeeNo: b.employeeNo, employment: b.employment } });
      return personOut(r);
    } catch (e: any) { if (e.code === '23505') throw badRequest('DUPLICATE', 'That payroll number or keycard holder is already used by another person.'); throw e; }
  });
  app.put(`${base}/people/:personId`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'attendance.manage');
    const b = Person.parse(req.body);
    try {
      const r = await one(pool, `UPDATE ta_people SET full_name=$3, employee_no=$4, department=$5, job_title=$6, employment=$7, pay_basis=$8, shift_id=$9,
          vl_user_id=CASE WHEN kind='staff' THEN vl_user_id ELSE $10 END, kind=CASE WHEN kind='staff' THEN kind WHEN $10::text IS NULL THEN 'manual' ELSE 'keycard' END,
          active=$11, start_date=$12, end_date=$13, updated_at=now() WHERE id=$1 AND hotel_id=$2 RETURNING *`,
        [(req.params as any).personId, hotelId, b.fullName, b.employeeNo, b.department, b.jobTitle, b.employment, b.payBasis, b.shiftId, b.vlUserId, b.active, b.startDate, b.endDate]);
      if (!r) throw notFound('Person');
      await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'attendance.person_changed', targetType: 'ta_person', targetId: r.id, details: { name: b.fullName, active: b.active, shiftId: b.shiftId } });
      return personOut(r);
    } catch (e: any) { if (e.code === '23505') throw badRequest('DUPLICATE', 'That payroll number or keycard holder is already used by another person.'); throw e; }
  });
  /** Add everyone from the platform's staff list and/or Visionline's keycard holders (read in Reports & sync). */
  app.post(`${base}/people/import`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'attendance.manage');
    const b = z.object({ source: z.enum(['staff', 'keycard']), userGroups: z.array(z.string().max(80)).max(50).optional() }).parse(req.body);
    let added = 0;
    const startDay = todayIn(await hotelTz(hotelId), (await attendancePolicy(hotelId)).dayStartsAt);
    await tx(async (c) => {
      if (b.source === 'staff') {
        // Staff keep their Visionline user, so their keycards count as well as their mobile keys.
        const r = await c.query(`INSERT INTO ta_people (hotel_id, kind, staff_id, vl_user_id, full_name, employee_no, department, job_title, start_date)
          SELECT s.hotel_id, 'staff', s.id,
                 CASE WHEN s.visionline_user IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ta_people p WHERE p.hotel_id=s.hotel_id AND p.vl_user_id=s.visionline_user) THEN s.visionline_user END,
                 s.full_name, s.employee_no, COALESCE(s.visionline_user_group, s.job_role), s.job_role, $2::date FROM staff s
           WHERE s.hotel_id=$1 AND s.status='ACTIVE' AND NOT EXISTS (SELECT 1 FROM ta_people p WHERE p.hotel_id=s.hotel_id AND p.staff_id=s.id)
             AND (s.employee_no IS NULL OR NOT EXISTS (SELECT 1 FROM ta_people p WHERE p.hotel_id=s.hotel_id AND lower(p.employee_no)=lower(s.employee_no)))`, [hotelId, startDay]);
        added = r.rowCount ?? 0;
      } else {
        const r = await c.query(`INSERT INTO ta_people (hotel_id, kind, vl_user_id, full_name, department, start_date)
          SELECT u.hotel_id, 'keycard', u.user_id, COALESCE(NULLIF(trim(concat_ws(' ', u.given_name, u.surname)), ''), u.user_id), u.user_group, $3::date FROM vl_users u
           WHERE u.hotel_id=$1 AND u.active AND ($2::text[] IS NULL OR u.user_group = ANY($2))
             AND NOT EXISTS (SELECT 1 FROM ta_people p WHERE p.hotel_id=u.hotel_id AND p.vl_user_id=u.user_id)`, [hotelId, b.userGroups?.length ? b.userGroups : null, startDay]);
        added = r.rowCount ?? 0;
      }
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'attendance.people_imported', details: { source: b.source, added } });
    });
    return { added };
  });
  app.get(`${base}/keycard-holders`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'attendance.manage');
    return many(pool, `SELECT u.user_id AS id, NULLIF(trim(concat_ws(' ', u.given_name, u.surname)), '') AS name, u.user_group AS "group",
        (SELECT p.full_name FROM ta_people p WHERE p.hotel_id=u.hotel_id AND p.vl_user_id=u.user_id) AS linked_to
      FROM vl_users u WHERE u.hotel_id=$1 AND u.active ORDER BY u.user_group NULLS LAST, u.surname NULLS LAST LIMIT 5000`, [hotelId]);
  });

  // ---- shifts ----
  app.get(`${base}/shifts`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'attendance.read');
    return (await many(pool, `SELECT s.*, (SELECT count(*) FROM ta_people p WHERE p.shift_id=s.id AND p.active)::int AS people FROM ta_shifts s WHERE hotel_id=$1 ORDER BY active DESC, start_time`, [hotelId]))
      .map((s) => ({ id: s.id, name: s.name, start: s.start_time, end: s.end_time, breakMinutes: s.break_minutes, graceMinutes: s.grace_minutes, workDays: s.work_days, active: s.active, people: s.people }));
  });
  app.post(`${base}/shifts`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'attendance.manage');
    const b = Shift.parse(req.body);
    try {
      const r = await one(pool, `INSERT INTO ta_shifts (hotel_id, name, start_time, end_time, break_minutes, grace_minutes, work_days, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [hotelId, b.name, b.start, b.end, b.breakMinutes, b.graceMinutes, [...new Set(b.workDays)].sort(), b.active]);
      await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'attendance.shift_added', targetType: 'ta_shift', targetId: r!.id, details: b });
      return { id: r!.id };
    } catch (e: any) { if (e.code === '23505') throw badRequest('DUPLICATE', 'A shift with that name exists.'); throw e; }
  });
  app.put(`${base}/shifts/:shiftId`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'attendance.manage');
    const b = Shift.parse(req.body);
    const r = await one(pool, `UPDATE ta_shifts SET name=$3, start_time=$4, end_time=$5, break_minutes=$6, grace_minutes=$7, work_days=$8, active=$9 WHERE id=$1 AND hotel_id=$2 RETURNING id`,
      [(req.params as any).shiftId, hotelId, b.name, b.start, b.end, b.breakMinutes, b.graceMinutes, [...new Set(b.workDays)].sort(), b.active]);
    if (!r) throw notFound('Shift');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'attendance.shift_changed', targetType: 'ta_shift', targetId: r.id, details: b });
    return { ok: true };
  });

  // ---- leave, days off, public holidays ----
  app.get(`${base}/absences`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'attendance.read');
    const q = z.object({ from: Day, to: Day }).parse(req.query);
    return many(pool, `SELECT a.id, a.person_id, p.full_name AS person, to_char(a.date_from, 'YYYY-MM-DD') AS date_from, to_char(a.date_to, 'YYYY-MM-DD') AS date_to, a.kind, a.note, o.display_name AS created_by
      FROM ta_absences a LEFT JOIN ta_people p ON p.id=a.person_id LEFT JOIN operators o ON o.id=a.created_by WHERE a.hotel_id=$1 AND a.date_to >= $2 AND a.date_from <= $3 ORDER BY a.date_from`, [hotelId, q.from, q.to]);
  });
  app.post(`${base}/absences`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'attendance.manage');
    const b = z.object({ personId: z.string().uuid().nullable(), from: Day, to: Day, kind: z.enum(['annual_leave', 'sick', 'day_off', 'public_holiday', 'unpaid', 'other']), note: z.string().max(200).optional() })
      .refine((x) => x.to >= x.from, 'The end must not be before the start').refine((x) => x.personId || x.kind === 'public_holiday', 'Only a public holiday applies to everybody').parse(req.body);
    for (const d of datesBetween(b.from, b.to)) await assertOpen(hotelId, d);
    const r = await one(pool, `INSERT INTO ta_absences (hotel_id, person_id, date_from, date_to, kind, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [hotelId, b.personId, b.from, b.to, b.kind, b.note ?? null, op.id]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'attendance.absence_added', targetType: 'ta_absence', targetId: r!.id, details: b });
    return { id: r!.id };
  });
  app.delete(`${base}/absences/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'attendance.manage');
    const a = await one(pool, `SELECT id, to_char(date_from, 'YYYY-MM-DD') AS f, to_char(date_to, 'YYYY-MM-DD') AS t FROM ta_absences WHERE id=$1 AND hotel_id=$2`, [(req.params as any).id, hotelId]);
    if (!a) throw notFound('Absence');
    for (const d of datesBetween(a.f, a.t)) await assertOpen(hotelId, d);
    await pool.query('DELETE FROM ta_absences WHERE id=$1', [a.id]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'attendance.absence_removed', targetType: 'ta_absence', targetId: a.id, details: { from: a.f, to: a.t } });
    return { ok: true };
  });

  // ---- timesheets and clock records ----
  app.get(`${base}/timesheet`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'attendance.read');
    await requireAttendanceOn(hotelId);
    const r = Range.parse(req.query);
    return timesheet(hotelId, r);
  });
  app.get(`${base}/people/:personId/punches`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'attendance.read');
    const q = z.object({ from: Day, to: Day }).parse(req.query);
    const pol = await attendancePolicy(hotelId);
    const tz = await hotelTz(hotelId);
    const rows = await many(pool, `SELECT t.id, t.at, t.direction, t.source, t.door_id, COALESCE(r.name, t.door_id) AS door, t.reason, t.voided_at, t.void_reason,
        e.display_name AS entered_by, v.display_name AS voided_by
      FROM ta_punches t LEFT JOIN operators e ON e.id=t.entered_by LEFT JOIN operators v ON v.id=t.voided_by LEFT JOIN resources r ON r.hotel_id=t.hotel_id AND r.kind='door' AND r.external_id=t.door_id
      WHERE t.hotel_id=$1 AND t.person_id=$2 AND t.at BETWEEN $3 AND $4 ORDER BY t.at`, [hotelId, (req.params as any).personId, new Date(`${addDays(q.from, -1)}T00:00:00Z`), new Date(`${addDays(q.to, 2)}T00:00:00Z`)]);
    return rows.map((r) => ({ ...r, day: workDayOf(new Date(r.at), tz, pol.dayStartsAt) })).filter((r) => r.day >= q.from && r.day <= q.to);
  });
  /** HR adds a missing record (forgotten check-out, daily worker) - always with a reason. */
  app.post(`${base}/punches`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'attendance.manage');
    await requireAttendanceOn(hotelId);
    const b = z.object({ personId: z.string().uuid(), at: z.coerce.date(), direction: z.enum(['in', 'out']), reason: z.string().trim().min(3, 'Give a reason').max(300) }).parse(req.body);
    if (b.at.getTime() > Date.now() + 5 * 60_000) throw badRequest('FUTURE', 'A record cannot be in the future.');
    if (!(await one(pool, `SELECT 1 FROM ta_people WHERE id=$1 AND hotel_id=$2`, [b.personId, hotelId]))) throw notFound('Person');
    const pol = await attendancePolicy(hotelId);
    await assertOpen(hotelId, workDayOf(b.at, await hotelTz(hotelId), pol.dayStartsAt));
    const r = await one(pool, `INSERT INTO ta_punches (hotel_id, person_id, at, direction, source, entered_by, reason) VALUES ($1,$2,$3,$4,'hr',$5,$6) RETURNING id`, [hotelId, b.personId, b.at, b.direction, op.id, b.reason]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'attendance.record_added', targetType: 'ta_punch', targetId: r!.id, details: { personId: b.personId, at: b.at.toISOString(), direction: b.direction, reason: b.reason } });
    return { id: r!.id };
  });
  /** Records are never deleted: a wrong one is voided with a reason and stays visible. */
  app.post(`${base}/punches/:punchId/void`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'attendance.manage');
    const b = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) }).parse(req.body);
    const p = await one(pool, `SELECT id, at, person_id FROM ta_punches WHERE id=$1 AND hotel_id=$2 AND voided_at IS NULL`, [(req.params as any).punchId, hotelId]);
    if (!p) throw notFound('Record');
    const pol = await attendancePolicy(hotelId);
    await assertOpen(hotelId, workDayOf(new Date(p.at), await hotelTz(hotelId), pol.dayStartsAt));
    await pool.query(`UPDATE ta_punches SET voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1`, [p.id, op.id, b.reason]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'attendance.record_voided', targetType: 'ta_punch', targetId: p.id, details: { personId: p.person_id, at: p.at, reason: b.reason } });
    return { ok: true };
  });

  // ---- approval for payroll ----
  app.get(`${base}/periods`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'attendance.read');
    return many(pool, `SELECT p.id, to_char(p.date_from, 'YYYY-MM-DD') AS date_from, to_char(p.date_to, 'YYYY-MM-DD') AS date_to, p.approved_at, p.note, o.display_name AS approved_by
      FROM ta_periods p LEFT JOIN operators o ON o.id=p.approved_by WHERE p.hotel_id=$1 ORDER BY p.date_from DESC LIMIT 50`, [hotelId]);
  });
  app.post(`${base}/periods`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'attendance.manage');
    const b = z.object({ from: Day, to: Day, note: z.string().max(200).optional() }).refine((x) => x.to >= x.from).parse(req.body);
    const pol = await attendancePolicy(hotelId);
    if (b.to >= todayIn(await hotelTz(hotelId), pol.dayStartsAt)) throw badRequest('NOT_OVER', 'Only days that are over can be approved.');
    if (await one(pool, `SELECT 1 FROM ta_periods WHERE hotel_id=$1 AND date_to >= $2 AND date_from <= $3`, [hotelId, b.from, b.to])) throw badRequest('OVERLAP', 'Part of this period is already approved.');
    const t = await timesheet(hotelId, { from: b.from, to: b.to });
    const open = t.people.reduce((n, p) => n + p.totals.incomplete, 0);
    const r = await one(pool, `INSERT INTO ta_periods (hotel_id, date_from, date_to, approved_by, note) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [hotelId, b.from, b.to, op.id, b.note ?? null]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'attendance.period_approved', targetType: 'ta_period', targetId: r!.id, details: { ...b, people: t.people.length, daysWithoutCheckout: open } });
    return { id: r!.id, daysWithoutCheckout: open };
  });
  app.delete(`${base}/periods/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'attendance.manage');
    const b = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.query);
    const r = await one(pool, `DELETE FROM ta_periods WHERE id=$1 AND hotel_id=$2 RETURNING to_char(date_from, 'YYYY-MM-DD') AS f, to_char(date_to, 'YYYY-MM-DD') AS t`, [(req.params as any).id, hotelId]);
    if (!r) throw notFound('Period');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'attendance.period_reopened', details: { from: r.f, to: r.t, reason: b.reason } });
    return { ok: true };
  });

  // ---- settings (HR can change these without full settings rights) ----
  app.get(`${base}/settings`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'attendance.read');
    const doors = await many(pool, `SELECT external_id AS id, name, data->>'doorGroup' AS "group" FROM resources WHERE hotel_id=$1 AND kind='door' AND active ORDER BY name`, [hotelId]);
    return { settings: await attendancePolicy(hotelId), doors, enabled: await (await import('../attendance/service.ts')).attendanceOn(hotelId) };
  });
  app.put(`${base}/settings`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'attendance.manage');
    const current = (await getConfig(pool, hotelId, 'policy')) ?? {};
    const data = await validateConfig(pool, hotelId, 'policy', { ...current, attendance: req.body });
    const v = await tx(async (c) => {
      const nv = await saveConfig(c, hotelId, 'policy', data, op.id);
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'config.published', targetType: 'config', targetId: 'policy', details: { version: nv, attendance: data.attendance } });
      return nv;
    });
    return { version: v, settings: data.attendance };
  });

  // ---- payroll exports ----
  /** daily.csv / summary.csv for Excel and payroll imports; daily.json / summary.json for a payroll system. */
  app.get(`${base}/export/:file`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'attendance.read');
    await requireAttendanceOn(hotelId);
    const file = (req.params as any).file as string;
    const m = /^(daily|summary)\.(csv|json)$/.exec(file);
    if (!m) throw notFound('Export');
    const r = Range.parse(req.query);
    const t = await timesheet(hotelId, r);
    const time = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: t.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '');
    const approved = t.approved.length > 0 && t.approved.some((a: any) => a.date_from <= r.from && a.date_to >= r.to);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'attendance.exported', details: { file, ...r, people: t.people.length, approved } });
    const stamp = `${r.from}_${r.to}`;
    if (m[1] === 'daily') {
      const rows = t.people.flatMap((p) => p.days.filter((d) => d.status !== 'future').map((d) => ({
        employee_no: p.employeeNo ?? '', name: p.name, department: p.department ?? '', employment: p.employment, pay_basis: p.payBasis, date: d.date, shift: d.shift ?? '',
        status: STATUS[d.status] ?? d.status, absence: d.absence ?? '', first_in: time(d.firstIn), last_out: time(d.lastOut), worked_hours: hours(d.workedMinutes), regular_hours: hours(d.regularMinutes),
        overtime_hours: hours(d.overtimeMinutes), break_minutes: d.breakMinutes, late_minutes: d.lateMinutes, early_leave_minutes: d.earlyLeaveMinutes, records: d.punches, sources: d.sources.join(' '),
      })));
      if (m[2] === 'json') return { hotel: hotelId, from: r.from, to: r.to, timeZone: t.tz, approved, rows };
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="attendance-daily-${stamp}.csv"`).header('cache-control', 'private, no-store');
      return csv(Object.keys(rows[0] ?? { employee_no: 1, name: 1, department: 1, employment: 1, pay_basis: 1, date: 1, shift: 1, status: 1, absence: 1, first_in: 1, last_out: 1, worked_hours: 1, regular_hours: 1, overtime_hours: 1, break_minutes: 1, late_minutes: 1, early_leave_minutes: 1, records: 1, sources: 1 }), rows.map((x) => Object.values(x)));
    }
    const rows = t.people.map((p) => ({
      employee_no: p.employeeNo ?? '', name: p.name, department: p.department ?? '', employment: p.employment, pay_basis: p.payBasis,
      days_present: p.totals.daysPresent, days_absent: p.totals.daysAbsent, days_leave: p.totals.daysLeave, public_holidays: p.totals.daysHoliday, days_without_checkout: p.totals.incomplete,
      worked_hours: hours(p.totals.workedMinutes), regular_hours: hours(p.totals.regularMinutes), overtime_hours: hours(p.totals.overtimeMinutes), late_days: p.totals.lateDays, late_minutes: p.totals.lateMinutes, early_leave_minutes: p.totals.earlyLeaveMinutes,
    }));
    if (m[2] === 'json') return { hotel: hotelId, from: r.from, to: r.to, timeZone: t.tz, approved, rows };
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="attendance-summary-${stamp}.csv"`).header('cache-control', 'private, no-store');
    return csv(Object.keys(rows[0] ?? { employee_no: 1, name: 1, department: 1, employment: 1, pay_basis: 1, days_present: 1, days_absent: 1, days_leave: 1, public_holidays: 1, days_without_checkout: 1, worked_hours: 1, regular_hours: 1, overtime_hours: 1, late_days: 1, late_minutes: 1, early_leave_minutes: 1 }), rows.map((x) => Object.values(x)));
  });

  /** Printed timesheet summary for HR / payroll, with the hotel header on every page. */
  app.post(`${base}/pdf`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'attendance.read');
    await requireAttendanceOn(hotelId);
    const r = Range.parse(req.body);
    const t = await timesheet(hotelId, r);
    const approved = t.approved.some((a: any) => a.date_from <= r.from && a.date_to >= r.to);
    const all = t.people.reduce((a, p) => ({ w: a.w + p.totals.workedMinutes, o: a.o + p.totals.overtimeMinutes, abs: a.abs + p.totals.daysAbsent }), { w: 0, o: 0, abs: 0 });
    const out = await buildReportPdf({
      hotelId, report: 'attendance-summary', title: 'Time & attendance - summary for payroll', operatorId: op.id, operatorName: op.displayName,
      selection: [`Period: ${r.from} to ${r.to} (${t.tz})${r.department ? ` · department: ${r.department}` : ''}`, approved ? 'Status: APPROVED for payroll' : 'Status: not approved yet (figures may still change)'],
      summary: [['People', String(t.people.length)], ['Worked hours', hours(all.w)], ['Overtime hours', hours(all.o)], ['Days absent', String(all.abs)]],
      columns: [{ label: 'Payroll no.', width: 9 }, { label: 'Name', width: 18 }, { label: 'Department', width: 12 }, { label: 'Present', width: 7, align: 'right' }, { label: 'Absent', width: 7, align: 'right' }, { label: 'Leave', width: 6, align: 'right' },
        { label: 'No check-out', width: 8, align: 'right' }, { label: 'Worked h', width: 8, align: 'right' }, { label: 'Overtime h', width: 8, align: 'right' }, { label: 'Late (days/min)', width: 10, align: 'right' }],
      rows: t.people.map((p) => [p.employeeNo ?? '', p.name, p.department ?? '', String(p.totals.daysPresent), String(p.totals.daysAbsent), String(p.totals.daysLeave + p.totals.daysHoliday), String(p.totals.incomplete),
        hours(p.totals.workedMinutes), hours(p.totals.overtimeMinutes), `${p.totals.lateDays} / ${p.totals.lateMinutes}`]),
      tones: t.people.map((p) => (p.totals.incomplete || p.totals.daysAbsent ? 'warning' : null)),
      filters: { ...r },
    });
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'report.printed', targetType: 'report', targetId: out.reportId, details: { report: 'attendance-summary', ...r, sha256: out.sha256 } });
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="attendance-${r.from}_${r.to}.pdf"`).header('cache-control', 'private, no-store').header('x-report-id', out.reportId).header('x-report-sha256', out.sha256);
    return reply.send(out.bytes);
  });
}
