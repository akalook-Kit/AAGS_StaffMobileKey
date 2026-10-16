/**
 * Time & attendance: turns clock records into working days. Pure functions (unit-tested); no database here.
 *
 *  - A working day starts at dayStartsAt (04:00 by default) in the hotel's time zone, so a night shift belongs to the
 *    day it started.
 *  - Desk and HR records say "in" or "out": worked time is the sum of in->out pairs. Door records ("auto") only say
 *    that the person passed an attendance door: the first is the arrival and the last the departure.
 *  - Break: the shift's break, or the default break when the person has no shift and worked more than 6 hours.
 *  - Late: arrival after shift start + grace (counted from the shift start). Early leave: departure before shift end
 *    - grace. Overtime: worked time above the shift's planned time (or above overtimeAfterMinutes without a shift).
 */
export interface Punch { id: string; at: Date; direction: 'in' | 'out' | 'auto'; source: 'door' | 'desk' | 'hr' }
export interface Shift { id: string; name: string; start: string; end: string; breakMinutes: number; graceMinutes: number; workDays: number[] }
export interface Absence { from: string; to: string; kind: string; note?: string | null }
export interface Policy { dayStartsAt: string; overtimeAfterMinutes: number; roundToMinutes: number; defaultBreakMinutes: number }
export interface DayRow {
  date: string; weekday: number; status: 'present' | 'incomplete' | 'absent' | 'leave' | 'holiday' | 'off' | 'future';
  firstIn: string | null; lastOut: string | null; workedMinutes: number; breakMinutes: number; regularMinutes: number; overtimeMinutes: number;
  plannedMinutes: number; lateMinutes: number; earlyLeaveMinutes: number; punches: number; sources: string[]; absence: string | null; shift: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h! * 60 + m!; };

/** Offset of tz from UTC at instant t (ms). */
export function tzOffsetMs(t: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(t / 1000) * 1000;
}
/** Local wall time "YYYY-MM-DD" + "HH:MM" in tz -> instant. */
export function localToInstant(date: string, hhmm: string, tz: string) {
  const [y, mo, d] = date.split('-').map(Number);
  const guess = Date.UTC(y!, mo! - 1, d!, Math.floor(toMin(hhmm) / 60), toMin(hhmm) % 60);
  let at = guess - tzOffsetMs(guess, tz);
  at = guess - tzOffsetMs(at, tz);
  return new Date(at);
}
/** The working day an instant belongs to. */
export function workDayOf(at: Date, tz: string, dayStartsAt: string) {
  const shifted = new Date(at.getTime() - toMin(dayStartsAt) * 60_000);
  const local = new Date(shifted.getTime() + tzOffsetMs(shifted.getTime(), tz));
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
}
export function addDays(date: string, n: number) {
  const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** ISO weekday, 1 = Monday ... 7 = Sunday. */
export const isoWeekday = (date: string) => { const w = new Date(`${date}T12:00:00Z`).getUTCDay(); return w === 0 ? 7 : w; };
export function datesBetween(from: string, to: string) { const out: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }

const round = (min: number, step: number) => (step > 0 ? Math.round(min / step) * step : Math.round(min));

/**
 * Where one working day ends and the next begins for this person: the hotel's dayStartsAt, except for a shift that
 * runs past midnight, where it is the middle of the time off (night shift 22:00-06:00 -> 14:00).
 */
export function dayBoundary(shift: Shift | null, dayStartsAt: string) {
  if (!shift) return dayStartsAt;
  const s = toMin(shift.start), e = toMin(shift.end);
  if (e > s) return dayStartsAt;
  const mid = (e + (s - e) / 2) % 1440;
  return `${pad(Math.floor(mid / 60))}:${pad(Math.round(mid % 60))}`;
}

export function computeDays(o: {
  from: string; to: string; tz: string; today: string; punches: Punch[]; shift: Shift | null; absences: Absence[]; policy: Policy;
  startDate?: string | null; endDate?: string | null;
}): DayRow[] {
  const byDay = new Map<string, Punch[]>();
  for (const p of [...o.punches].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const d = workDayOf(p.at, o.tz, dayBoundary(o.shift, o.policy.dayStartsAt));
    byDay.set(d, [...(byDay.get(d) ?? []), p]);
  }
  const rows: DayRow[] = [];
  for (const date of datesBetween(o.from, o.to)) {
    const wd = isoWeekday(date);
    const ps = byDay.get(date) ?? [];
    const abs = o.absences.find((a) => a.from <= date && a.to >= date) ?? null;
    const employed = (!o.startDate || date >= o.startDate) && (!o.endDate || date <= o.endDate);
    const workDay = o.shift ? o.shift.workDays.includes(wd) : wd <= 6;
    const row: DayRow = { date, weekday: wd, status: 'off', firstIn: null, lastOut: null, workedMinutes: 0, breakMinutes: 0, regularMinutes: 0, overtimeMinutes: 0,
      plannedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, punches: ps.length, sources: [...new Set(ps.map((p) => p.source))], absence: abs?.kind ?? null, shift: o.shift?.name ?? null };

    let shiftStart: Date | null = null, shiftEnd: Date | null = null;
    if (o.shift && workDay) {
      shiftStart = localToInstant(date, o.shift.start, o.tz);
      const endDate = toMin(o.shift.end) <= toMin(o.shift.start) ? addDays(date, 1) : date;
      shiftEnd = localToInstant(endDate, o.shift.end, o.tz);
      row.plannedMinutes = Math.max(0, Math.round((shiftEnd.getTime() - shiftStart.getTime()) / 60_000) - o.shift.breakMinutes);
    }

    if (ps.length) {
      let worked = 0, first: Date | null = null, last: Date | null = null, open = false;
      const explicit = ps.every((p) => p.direction !== 'auto');
      if (explicit) {
        let inAt: Date | null = null;
        for (const p of ps) {
          if (p.direction === 'in') { if (!inAt) inAt = p.at; first ??= p.at; }
          else if (inAt) { worked += (p.at.getTime() - inAt.getTime()) / 60_000; last = p.at; inAt = null; }
          else { first ??= p.at; last = p.at; } // "out" without "in": departure only
        }
        open = Boolean(inAt);
      } else {
        first = ps[0]!.at;
        if (ps.length > 1) { last = ps[ps.length - 1]!.at; worked = (last.getTime() - first.getTime()) / 60_000; } else open = true;
      }
      row.firstIn = first?.toISOString() ?? null;
      row.lastOut = open ? null : last?.toISOString() ?? null;
      const brk = o.shift ? (worked > 0 ? Math.min(o.shift.breakMinutes, worked) : 0) : (worked > 360 ? o.policy.defaultBreakMinutes : 0);
      row.breakMinutes = Math.round(brk);
      row.workedMinutes = Math.max(0, round(worked - brk, o.policy.roundToMinutes));
      const limit = o.shift && workDay ? row.plannedMinutes : o.policy.overtimeAfterMinutes;
      row.overtimeMinutes = row.lastOut ? Math.max(0, row.workedMinutes - limit) : 0;
      row.regularMinutes = row.workedMinutes - row.overtimeMinutes;
      if (shiftStart && first && first.getTime() > shiftStart.getTime() + o.shift!.graceMinutes * 60_000) row.lateMinutes = Math.round((first.getTime() - shiftStart.getTime()) / 60_000);
      if (shiftEnd && row.lastOut && last && last.getTime() < shiftEnd.getTime() - o.shift!.graceMinutes * 60_000) row.earlyLeaveMinutes = Math.round((shiftEnd.getTime() - last.getTime()) / 60_000);
      row.status = row.lastOut || row.workedMinutes > 0 ? (open ? 'incomplete' : 'present') : 'incomplete';
      if (open && date < o.today) row.status = 'incomplete';
    } else if (!employed) row.status = 'off';
    else if (abs) row.status = abs.kind === 'public_holiday' ? 'holiday' : abs.kind === 'day_off' ? 'off' : 'leave';
    else if (date > o.today) row.status = 'future';
    else if (workDay && date < o.today) row.status = 'absent';
    else if (workDay && date === o.today) row.status = 'future'; // not arrived yet today
    else row.status = 'off';
    rows.push(row);
  }
  return rows;
}

export function totals(rows: DayRow[]) {
  const sum = (k: keyof DayRow) => rows.reduce((a, r) => a + (r[k] as number), 0);
  return {
    daysPresent: rows.filter((r) => r.status === 'present' || r.status === 'incomplete').length,
    daysAbsent: rows.filter((r) => r.status === 'absent').length,
    daysLeave: rows.filter((r) => r.status === 'leave').length,
    daysHoliday: rows.filter((r) => r.status === 'holiday').length,
    incomplete: rows.filter((r) => r.status === 'incomplete').length,
    workedMinutes: sum('workedMinutes'), regularMinutes: sum('regularMinutes'), overtimeMinutes: sum('overtimeMinutes'),
    lateMinutes: sum('lateMinutes'), lateDays: rows.filter((r) => r.lateMinutes > 0).length, earlyLeaveMinutes: sum('earlyLeaveMinutes'),
  };
}
