import { describe, expect, it } from 'vitest';
import { computeDays, dayBoundary, localToInstant, totals, workDayOf, type Punch, type Shift } from './compute.ts';

const tz = 'Africa/Nairobi'; // UTC+3, no DST
const pol = { dayStartsAt: '04:00', overtimeAfterMinutes: 480, roundToMinutes: 0, defaultBreakMinutes: 60 };
const at = (d: string, t: string) => localToInstant(d, t, tz);
const p = (d: string, t: string, direction: Punch['direction'] = 'auto', source: Punch['source'] = 'door'): Punch => ({ id: `${d}${t}`, at: at(d, t), direction, source });
const day: Shift = { id: 's', name: 'Day 08-17', start: '08:00', end: '17:00', breakMinutes: 60, graceMinutes: 10, workDays: [1, 2, 3, 4, 5] };
const night: Shift = { id: 'n', name: 'Night 22-06', start: '22:00', end: '06:00', breakMinutes: 30, graceMinutes: 5, workDays: [1, 2, 3, 4, 5, 6, 7] };
// 2026-10-12 is a Monday
describe('time and attendance days', () => {
  it('door records: first = arrival, last = departure; break, late, overtime', () => {
    const [r] = computeDays({ from: '2026-10-12', to: '2026-10-12', tz, today: '2026-10-20', shift: day, absences: [], policy: pol,
      punches: [p('2026-10-12', '08:25'), p('2026-10-12', '12:00'), p('2026-10-12', '18:30')] });
    expect(r).toMatchObject({ status: 'present', workedMinutes: 545, breakMinutes: 60, plannedMinutes: 480, overtimeMinutes: 65, regularMinutes: 480, lateMinutes: 25, earlyLeaveMinutes: 0, punches: 3 });
  });
  it('within grace is not late; leaving early is counted', () => {
    const [r] = computeDays({ from: '2026-10-12', to: '2026-10-12', tz, today: '2026-10-20', shift: day, absences: [], policy: pol, punches: [p('2026-10-12', '08:09'), p('2026-10-12', '15:30')] });
    expect(r).toMatchObject({ lateMinutes: 0, earlyLeaveMinutes: 90, overtimeMinutes: 0 });
  });
  it('a night shift belongs to the day it started', () => {
    expect(dayBoundary(night, '04:00')).toBe('14:00');
    expect(workDayOf(at('2026-10-13', '05:50'), tz, dayBoundary(night, '04:00'))).toBe('2026-10-12');
    expect(dayBoundary(day, '04:00')).toBe('04:00');
    const [r] = computeDays({ from: '2026-10-12', to: '2026-10-12', tz, today: '2026-10-20', shift: night, absences: [], policy: pol, punches: [p('2026-10-12', '21:58'), p('2026-10-13', '06:05')] });
    expect(r).toMatchObject({ status: 'present', workedMinutes: 457, plannedMinutes: 450, overtimeMinutes: 7, lateMinutes: 0 });
  });
  it('desk records: in/out pairs, split shift', () => {
    const [r] = computeDays({ from: '2026-10-12', to: '2026-10-12', tz, today: '2026-10-20', shift: null, absences: [], policy: pol,
      punches: [p('2026-10-12', '07:00', 'in', 'desk'), p('2026-10-12', '11:00', 'out', 'desk'), p('2026-10-12', '15:00', 'in', 'desk'), p('2026-10-12', '19:00', 'out', 'desk')] });
    expect(r).toMatchObject({ workedMinutes: 420, breakMinutes: 60, overtimeMinutes: 0, status: 'present' });
  });
  it('a single door record is incomplete (no departure); absent, leave, holiday, weekend', () => {
    const rows = computeDays({ from: '2026-10-12', to: '2026-10-18', tz, today: '2026-10-20', shift: day, policy: pol,
      absences: [{ from: '2026-10-14', to: '2026-10-14', kind: 'annual_leave' }, { from: '2026-10-15', to: '2026-10-15', kind: 'public_holiday' }],
      punches: [p('2026-10-12', '08:00')] });
    expect(rows.map((r) => r.status)).toEqual(['incomplete', 'absent', 'leave', 'holiday', 'absent', 'off', 'off']);
    const t = totals(rows);
    expect(t).toMatchObject({ daysPresent: 1, daysAbsent: 2, daysLeave: 1, daysHoliday: 1, incomplete: 1 });
  });
  it('rounding and the default break without a shift; employment dates', () => {
    const [r] = computeDays({ from: '2026-10-12', to: '2026-10-12', tz, today: '2026-10-20', shift: null, absences: [], policy: { ...pol, roundToMinutes: 15 }, punches: [p('2026-10-12', '08:03'), p('2026-10-12', '17:11')] });
    expect(r).toMatchObject({ workedMinutes: 495, breakMinutes: 60, overtimeMinutes: 15 });
    const rows = computeDays({ from: '2026-10-12', to: '2026-10-13', tz, today: '2026-10-20', shift: day, absences: [], policy: pol, punches: [], startDate: '2026-10-13' });
    expect(rows.map((x) => x.status)).toEqual(['off', 'absent']);
  });
  it('today without records is not absent yet', () => {
    const [r] = computeDays({ from: '2026-10-12', to: '2026-10-12', tz, today: '2026-10-12', shift: day, absences: [], policy: pol, punches: [] });
    expect(r!.status).toBe('future');
  });
});
