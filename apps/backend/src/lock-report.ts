import { batteryVoltsBelow } from '@smk/shared/node';
import { decodeReport, parseTable } from './vl-reports.ts';

/**
 * 2.18 Lock troubleshooting: the event report of ONE lock, exported from Visionline (Lock -> Events / the audit trail
 * read with the service device, saved as .xls = Unicode text). Used for offline locks, whose battery and fault history
 * the portal otherwise sees only in part.
 *
 * Privacy: only the time, the event code and name, the "(*)" mark and the card type are kept. Names, user IDs, card
 * numbers and "issued by" in the report are read past and never stored.
 */
export type DateOrder = 'MDY' | 'DMY' | 'YMD';

/** 2.19 The lock models on the sites (Armel, 27 Oct); chosen at upload and remembered per door. */
export const LOCK_MODELS = [
  { id: 'signature-rfid', name: 'VingCard Signature RFID' },
  { id: 'essence', name: 'VingCard Essence' },
  { id: 'classic-rfid', name: 'VingCard Classic RFID' },
  { id: 'allure', name: 'VingCard Allure' },
  { id: 'other', name: 'Other / not sure' },
] as const;
export const lockModelName = (id: string | null | undefined) => LOCK_MODELS.find((m) => m.id === id)?.name ?? null;
export interface LockEvent { t: string | null; code: number; name: string; mark: boolean; card: string; seq?: number | null }
export interface ParsedLockReport {
  events: LockEvent[];
  dateOrder: DateOrder;
  columns: { time: number; event: number; card: number; room: number; seq: number };
  rooms: { room: string; n: number }[];
  invalidTimes: number;
  /** 2.18 Rows read twice (same sequence number, event and time), e.g. after reading the lock twice: counted once. */
  duplicates: number;
  head: string[];
}

const CODE = /\((\d{3,4})\)\s*(\(\*\))?\s*$/;

/** "10/24/2026 1:52 PM", "24/10/2026 13:52", "2026-10-24 13:52", "24.10.2026 13:52:05" -> parts. */
function dateParts(s: string): { a: number; b: number; c: number; h: number; m: number; ymd: boolean } | null {
  const x = s.trim();
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2})?/.exec(x);
  if (r) return { a: +r[1]!, b: +r[2]!, c: +r[3]!, h: +r[4]!, m: +r[5]!, ymd: true };
  r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/.exec(x);
  if (!r) return null;
  let h = +r[4]!;
  if (r[6]) { const pm = /p/i.test(r[6]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  return { a: +r[1]!, b: +r[2]!, c: +r[3]!, h, m: +r[5]!, ymd: false };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function detectDateOrder(times: string[]): DateOrder {
  let mdy = 0, dmy = 0, ampm = 0;
  for (const s of times) {
    const p = dateParts(s);
    if (!p) continue;
    if (p.ymd) return 'YMD';
    if (p.a > 12) dmy++;
    if (p.b > 12) mdy++;
    if (/[ap]m\s*$/i.test(s.trim())) ampm++;
  }
  if (mdy && !dmy) return 'MDY';
  if (dmy && !mdy) return 'DMY';
  return ampm ? 'MDY' : 'DMY';
}

/** Local wall-clock time as "YYYY-MM-DDTHH:MM" (the lock's own time), or null. */
export function localTime(s: string, order: DateOrder): string | null {
  const p = dateParts(s);
  if (!p) return null;
  const [y, mo, d] = p.ymd ? [p.a, p.b, p.c] : order === 'MDY' ? [p.c, p.a, p.b] : [p.c, p.b, p.a];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || p.h > 23 || p.m > 59) return null;
  return `${y}-${pad(mo)}-${pad(d)}T${pad(p.h)}:${pad(p.m)}`;
}

export function parseLockReport(buf: Buffer, order?: DateOrder): ParsedLockReport {
  const { head, rows } = parseTable(decodeReport(buf));
  if (head.length < 2 || !rows.length) throw new Error('No table found: the first line must hold the column names.');
  const col = (re: RegExp) => head.findIndex((h) => re.test(h.toLowerCase()));
  // By content first: the event column holds "(0912)"-style codes, the time column dates.
  const sample = rows.slice(0, 200);
  const share = (i: number, test: (v: string) => boolean) => sample.filter((r) => test(r[i] ?? '')).length / sample.length;
  let event = -1, time = -1;
  // The event time, not the read-out time (newer Visionline versions have both columns).
  const named = head.findIndex((h) => /^(event ?time|time|date ?(and|&) ?time|date)$/i.test(h.trim()));
  if (named >= 0 && share(named, (v) => dateParts(v) != null) > 0.6) time = named;
  for (let i = 0; i < head.length; i++) {
    if (event < 0 && share(i, (v) => CODE.test(v)) > 0.6) event = i;
    if (time < 0 && !/read-?\s?out/i.test(head[i] ?? '') && share(i, (v) => dateParts(v) != null) > 0.6) time = i;
  }
  if (event < 0) event = col(/^event/);
  if (time < 0) time = col(/time|date/);
  if (event < 0 || time < 0) throw new Error('This does not look like a lock event report: no event column (e.g. "The door is opened (0912)") or no time column.');
  const card = col(/card name|card type/);
  const room = col(/room|door/);
  const seq = col(/^seq/);
  const dateOrder = order ?? detectDateOrder(sample.map((r) => r[time] ?? ''));
  const events: LockEvent[] = [];
  const rooms = new Map<string, number>();
  let invalidTimes = 0, duplicates = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    const m = CODE.exec((r[event] ?? '').trim());
    if (!m) continue;
    const t = localTime(r[time] ?? '', dateOrder);
    const sq = seq >= 0 && /^\d+$/.test((r[seq] ?? '').trim()) ? Number(r[seq]) : null;
    if (sq != null) {
      const k = `${sq}|${m[1]}|${t}`;
      if (seen.has(k)) { duplicates++; continue; }
      seen.add(k);
    }
    if (!t) invalidTimes++;
    const name = (r[event] ?? '').trim().replace(CODE, '').trim();
    events.push({ t, code: Number(m[1]), name: name.slice(0, 120), mark: Boolean(m[2]), card: card >= 0 ? (r[card] ?? '').slice(0, 40) : '', seq: sq });
    const rm = room >= 0 ? (r[room] ?? '').trim() : '';
    if (rm && rm.toLowerCase() !== 'n/a') rooms.set(rm, (rooms.get(rm) ?? 0) + 1);
  }
  if (!events.length) throw new Error('No lock events found in the file.');
  return { events, dateOrder, duplicates, columns: { time, event, card, room, seq }, rooms: [...rooms.entries()].map(([room, n]) => ({ room, n })).sort((a, b) => b.n - a.n).slice(0, 10), invalidTimes, head: head.slice(0, 20) };
}

// ---- Analysis -------------------------------------------------------------------------------------------------------
const C = {
  opened: [912], openedInside: [917], mechanicalKey: [672], ajar: [916], closed: [913], deadbolt: [896], deadboltReleased: [897],
  staffAccepted: [64], guestAccepted: [67],
  internal: [1975], cardRead: [1170, 1173, 1178], ble: [2006], data: [1283, 1285, 1109, 1132], wrongSystem: [336],
  restart: [576, 577, 578], coldStart: [578],
  readout: [83], paramsRead: [92], timeSet: [94], program: [95], init: [86], ping: [129],
  exchanged: [528, 535, 536],
  // The lock's own battery alarms (always count) and the "Alert, Battery level low" logged with cards (2.18: not a
  // battery problem shortly after new batteries unless a reading confirms it).
  lockAlarm: [305, 529, 530, 53, 307, 531, 532, 533, 534], cardLowAlert: [304, 306], accessDenied: [530, 53],
} as const;
// A door opening is counted by the door sensor (0912 / 0917); the metal key (0672) opens or locks, and an opening it
// causes is also seen by the sensor, so it is not counted twice.
const OPENING = [...C.opened, ...C.openedInside];

/**
 * 2.18 What the common lock events mean, in plain words (from the hotel's own explanations, 27 Oct, and the event
 * names). "Door Unit Internal" events are the lock's own, mostly mechanical, events.
 */
export const EVENT_MEANING: Record<number, string> = {
  912: 'Door opened (sensor), normally right after a card, key or command.',
  913: 'Door closed (sensor).',
  917: 'Door opened from the inside with the handle.',
  916: 'The door stayed open longer than allowed; the lock sounds an alarm.',
  896: 'Deadbolt (double lock) thrown with the knob inside the room.',
  897: 'Deadbolt (double lock) released from inside the room.',
  672: 'The metal (mechanical) key was used to open or lock the door.',
  64: 'Staff card accepted.', 67: 'Guest card accepted.',
  33: 'Refused: the double lock is on from inside. Only cards with the right to override the deadbolt open it. Normal privacy, not a fault.',
  322: 'Refused: the card has expired. The door does not open with an expired card.',
  320: 'Refused: the card has no access to this door.',
  17: 'Refused: a newer guest card was made for the room, so this older one no longer opens it.',
  336: 'Refused: the card belongs to another Visionline system, or the lock is not initialised for this one.',
  80: 'The latest guest card was checked out.',
  83: 'The lock was read out (its events collected).', 92: 'The lock\'s parameters were read.',
  93: 'Setting the lock\'s time started.', 94: 'The lock\'s time was set.', 95: 'A program was uploaded to the lock.',
  85: 'Initialisation started.', 86: 'The lock was initialised.', 115: 'A card was added to the lock\'s local card list.',
  129: 'Ping from the server (online lock).',
  576: 'The door unit reset itself without changes.', 577: 'The door unit started.', 578: 'The door unit cold started (it lost its power or memory).',
  1975: 'Internal error of the door unit (electronics).',
  1170: 'The reader could not read a card.', 1173: 'The reader could not read a card.', 1178: 'The reader could not read or write a card.',
  2006: 'Bluetooth (mobile key) communication failed.', 1285: 'Data received by the lock was not valid.', 1109: 'A parameter was out of range.',
  528: 'New batteries were put in.', 529: 'The lock raised a battery alarm.', 530: 'Battery so low that the lock refuses cards.',
  304: 'Battery-low alert logged with a card. Right after new batteries this can be logged by mistake.', 305: 'Battery critically low alert.',
  53: 'Access refused because of the battery alarm.',
};
const meaning = (code: number) => EVENT_MEANING[code] ?? (batteryVoltsBelow(code) != null ? `Battery reading: below ${batteryVoltsBelow(code)!.toFixed(1)} V.` : null);
/** Refusals that are the lock working as it should (a card or rights matter, not a lock fault). */
const EXPECTED_REFUSALS = [33, 322, 320, 17];
/** Fault codes are not "refusals"; everything else named "Error, ..." refused or failed an entry. */
const FAULT_CODES = [...C.internal, ...C.cardRead, ...C.ble, ...C.data];
const isIn = (code: number, list: readonly number[]) => list.includes(code);
const ms = (t: string) => Date.parse(`${t}:00Z`);
const DAY = 86_400_000, MIN = 60_000;
const r1 = (x: number) => Math.round(x * 10) / 10, r2 = (x: number) => Math.round(x * 100) / 100;
/** Something that lets a person in from outside: a card or key accepted, an online/BLE command, a mechanical key. */
const grantsEntry = (e: LockEvent) => isIn(e.code, [...C.staffAccepted, ...C.guestAccepted, ...C.mechanicalKey])
  || (/accepted|opened by|online command|unlock|mobile key|ble|emergency|master|passage|privacy override/i.test(e.name) && !/^error/i.test(e.name));

export interface Finding { level: 'high' | 'medium' | 'info'; title: string; detail: string; action?: string; area: 'battery' | 'lock' | 'door' | 'use' | 'security' | 'data' }
export interface BatteryPeriod {
  from: string; to: string; startedBy: 'exchange' | 'reading' | 'report'; firstVolts: number | null; lowestVolts: number | null;
  lowestAt: string | null; days: number; dropPer30Days: number | null; openings: number; dropPer1000Openings: number | null; alarms: number;
  /** 2.18 Days from the start of the period to the first reading at or below each level (null = not reached). */
  reached: { volts: number; days: number | null }[]; firmwareAlarms: number;
}

/** 2.19 One step of the elimination method. */
export interface Step { id: string; title: string; check: string; suggests: 'likely' | 'possible' | 'unlikely' | 'unknown'; evidence: string }

export interface AnalysisOptions {
  /** The reading that confirms a battery alarm after new batteries (the site's Low, else Critical threshold). */
  confirmVolts?: number | null;
  /** Days after a battery change in which an unconfirmed battery alarm is a firmware fault (site setting, 14). */
  firmwareDays?: number;
}

export function analyseLockReport(p: Pick<ParsedLockReport, 'events'> & Partial<Pick<ParsedLockReport, 'duplicates' | 'invalidTimes' | 'dateOrder'>>, now = Date.now(), opt: AnalysisOptions = {}) {
  const all = p.events;
  // Times before 2000 (or in the future) come from a lock whose clock was lost: counted, kept out of the timeline.
  const bogus = (t: string | null) => !t || t < '2000' || ms(t) > now + 2 * DAY;
  const ev = all.filter((e) => !bogus(e.t)).sort((a, b) => (a.t! < b.t! ? -1 : a.t! > b.t! ? 1 : (a.seq ?? 0) - (b.seq ?? 0)));
  const clockLost = all.filter((e) => e.t && e.t < '2000').length;
  const future = all.filter((e) => e.t && ms(e.t) > now + 2 * DAY).length;
  const count = (list: readonly number[], src: LockEvent[] = all) => src.filter((e) => isIn(e.code, list)).length;
  const from = ev[0]?.t ?? null, to = ev[ev.length - 1]?.t ?? null;
  // Rates (a day, a week) use the recent stretch without long gaps: a lock's memory can also hold events from months
  // or years before, when it was hardly used or its clock was wrong.
  let wi = ev.length - 1;
  while (wi > 0 && ms(ev[wi]!.t!) - ms(ev[wi - 1]!.t!) < 21 * DAY) wi--;
  const wFrom = ev[wi]?.t ?? null;
  const spanDays = wFrom && to ? Math.max(1, (ms(to) - ms(wFrom)) / DAY) : 1;
  const recent = ev.slice(Math.max(0, wi));
  const window = { from: wFrom, to, days: r1(spanDays), earlier: wi };
  const perDay = (n: number) => r1(n / spanDays);

  // ---- Use ----------------------------------------------------------------------------------------------------------
  const openings = count(OPENING);
  const byCard = new Map<string, number>();
  for (const e of all) if (isIn(e.code, [...C.staffAccepted, ...C.guestAccepted]) || /accepted/i.test(e.name)) { const k = e.card || '(card type not given)'; byCard.set(k, (byCard.get(k) ?? 0) + 1); }
  const hourly = Array.from({ length: 24 }, () => 0), weekday = Array.from({ length: 7 }, () => 0);
  for (const e of recent) if (isIn(e.code, OPENING)) { hourly[Number(e.t!.slice(11, 13))]!++; weekday[new Date(ms(e.t!)).getUTCDay()]!++; }
  const busiest = hourly.map((n, h) => ({ h, n })).sort((a, b) => b.n - a.n).slice(0, 3).filter((x) => x.n > 0);
  const night = hourly.slice(0, 6).reduce((s, x) => s + x, 0);
  const usage = {
    openings, openedFromOutside: count(C.opened), openedFromInside: count(C.openedInside), mechanicalKey: count(C.mechanicalKey),
    staffCards: count(C.staffAccepted), guestCards: count(C.guestAccepted), refused: 0, leftOpen: count(C.ajar), deadbolt: count(C.deadbolt), deadboltReleased: count(C.deadboltReleased),
    perDay: perDay(count(OPENING, recent)), byCardType: [...byCard.entries()].map(([card, n]) => ({ card, n })).sort((a, b) => b.n - a.n).slice(0, 12),
    hourly, weekday, busiestHours: busiest, nightOpenings: night,
  };

  // Refused or failed entries, by reason (all "Error, ..." events that are not lock faults).
  const refusals = new Map<string, { code: number; name: string; n: number; recent: number; meaning: string | null; expected: boolean }>();
  for (const e of all) if (/^error/i.test(e.name) && !isIn(e.code, FAULT_CODES)) {
    const x = refusals.get(String(e.code)) ?? { code: e.code, name: e.name, n: 0, recent: 0, meaning: meaning(e.code), expected: isIn(e.code, EXPECTED_REFUSALS) }; x.n++; if (e.t && wFrom && e.t >= wFrom) x.recent++; refusals.set(String(e.code), x);
  }
  const refusedBy = [...refusals.values()].sort((a, b) => b.n - a.n);
  usage.refused = refusedBy.reduce((s, x) => s + x.n, 0);

  // Door left open: from "left open too long" to the next "closed".
  const ajarMinutes: number[] = [];
  for (let i = 0; i < recent.length; i++) if (isIn(recent[i]!.code, C.ajar)) {
    const c = recent.slice(i + 1, i + 400).find((e) => isIn(e.code, C.closed));
    if (c) ajarMinutes.push((ms(c.t!) - ms(recent[i]!.t!)) / MIN);
  }
  ajarMinutes.sort((a, b) => a - b);
  const door = {
    leftOpenRecent: count(C.ajar, recent), longestOpenMinutes: ajarMinutes.length ? Math.round(ajarMinutes[ajarMinutes.length - 1]!) : null,
    medianOpenMinutes: ajarMinutes.length ? Math.round(ajarMinutes[Math.floor(ajarMinutes.length / 2)]!) : null,
    // Opened from outside with no card, key or command in the 2 minutes before: the latch did not hold, or the door was forced or left unlatched.
    openedWithoutCredential: [] as string[],
  };
  for (let i = 0; i < recent.length; i++) {
    const e = recent[i]!;
    if (!isIn(e.code, C.opened) || ms(e.t!) - ms(wFrom!) < 2 * MIN) continue; // nothing before it in the report
    let ok = false;
    for (let j = i - 1; j >= 0 && ms(e.t!) - ms(recent[j]!.t!) <= 2 * MIN; j--) if (grantsEntry(recent[j]!)) { ok = true; break; }
    // Same-minute events can be listed in either order.
    for (let j = i + 1; !ok && j < recent.length && recent[j]!.t === e.t; j++) if (grantsEntry(recent[j]!)) ok = true;
    if (!ok) door.openedWithoutCredential.push(e.t!);
  }

  // ---- Battery -----------------------------------------------------------------------------------------------------
  // Readings taken while the lock is being programmed or restarting are not reliable (e.g. "below 8.6 V" on a 4.8 V lock).
  const busy = ev.filter((e) => isIn(e.code, [85, 86, 95, 577, 578, 592])).map((e) => ms(e.t!));
  const nearBusy = (t: string) => busy.some((b) => Math.abs(ms(t) - b) <= 10 * MIN);
  const raw = ev.filter((e) => batteryVoltsBelow(e.code) != null).map((e) => ({ t: e.t!, volts: batteryVoltsBelow(e.code)! }));
  const mainScale = raw.filter((r) => r.volts < 6).length >= raw.filter((r) => r.volts >= 6).length ? 'low' : 'high';
  const scaleHigh = mainScale === 'high';
  const readings = raw.filter((r) => !nearBusy(r.t) && (r.volts >= 6) === scaleHigh && r.t >= (wFrom ?? ''));
  const ignoredReadings = raw.length - readings.length;
  const top = scaleHigh ? 9.0 : 4.8, alarmLevel = scaleHigh ? 7.2 : 4.0;
  const confirmLevel = !scaleHigh && opt.confirmVolts != null && opt.confirmVolts < 6 ? opt.confirmVolts : scaleHigh && opt.confirmVolts != null && opt.confirmVolts >= 6 ? opt.confirmVolts : alarmLevel;
  const firmwareDays = opt.firmwareDays ?? 14;
  const exchanges = recent.filter((e) => isIn(e.code, C.exchanged)).map((e) => ({ t: e.t!, how: 'Battery exchanged (event)' }));
  // A reading at the top of the scale after lower ones also means new batteries (when no exchange event is near).
  for (let i = 1; i < readings.length; i++) {
    const r = readings[i]!, prev = readings[i - 1]!;
    const isTop = Math.abs(r.volts - top) < 1e-6;
    if (((isTop && r.volts - prev.volts >= 0.4 - 1e-9) || r.volts - prev.volts >= 0.8 - 1e-9) && !exchanges.some((x) => Math.abs(ms(x.t) - ms(r.t)) < 2 * DAY))
      exchanges.push({ t: r.t, how: `Reading rose from ${prev.volts.toFixed(1)} V to ${r.volts.toFixed(1)} V` });
  }
  exchanges.sort((a, b) => (a.t < b.t ? -1 : 1));
  // Restarts right after new batteries are expected (the lock starts again when the batteries go in).
  const nearChange = (t: string) => exchanges.some((x) => ms(t) >= ms(x.t) - 15 * MIN && ms(t) <= ms(x.t) + 15 * MIN);
  // 2.19 (Armel, 27 Oct) A battery alarm after new batteries, even a single one, is a firmware fault unless a reading
  // since the change confirms low batteries: it is not counted as a battery alarm. From 10 minutes before the change
  // (same-minute events can be listed in any order) to firmwareDays after it.
  const lastChangeBefore = (t: string) => [...exchanges].reverse().find((x) => ms(x.t) - 10 * MIN <= ms(t));
  const firmwareAlarms: { t: string; code: number; name: string; changedAt: string }[] = [], alarms: { t: string; code: number; name: string }[] = [];
  for (const a of recent.filter((e) => isIn(e.code, [...C.lockAlarm, ...C.cardLowAlert]))) {
    const ch = lastChangeBefore(a.t!);
    const inWindow = ch && firmwareDays > 0 && ms(a.t!) - ms(ch.t) <= firmwareDays * DAY;
    const confirmed = ch ? readings.some((r) => r.t >= ch.t && r.t <= a.t! && r.volts <= confirmLevel + 1e-6) : true;
    if (inWindow && !confirmed) firmwareAlarms.push({ t: a.t!, code: a.code, name: a.name, changedAt: ch!.t });
    else alarms.push({ t: a.t!, code: a.code, name: a.name });
  }
  const alarmDays = new Set(alarms.map((a) => a.t.slice(0, 10))).size;

  const cuts = [wFrom, ...exchanges.map((x) => x.t)].filter(Boolean) as string[];
  const periods: BatteryPeriod[] = [];
  const levels = scaleHigh ? [8.4, 7.8, 7.2] : [4.4, 4.2, 4.0];
  for (let i = 0; i < cuts.length; i++) {
    const a = cuts[i]!, end = cuts[i + 1] ?? '9999', b = cuts[i + 1] ?? to!;
    if (!a || !b || (a === b && i < cuts.length - 1)) continue;
    const rs = readings.filter((r) => r.t >= a && r.t < end);
    const first = rs[0] ?? null;
    const lowest = rs.reduce<{ t: string; volts: number } | null>((m, r) => (!m || r.volts < m.volts ? r : m), null);
    const d = Math.max(0, (ms(b) - ms(a)) / DAY);
    const op = recent.filter((e) => e.t! >= a && e.t! < end && isIn(e.code, OPENING)).length;
    // Consumption: from the first reading to the moment the lowest level was first reached.
    let drop: number | null = null, per1000: number | null = null;
    const dd = first && lowest ? (ms(lowest.t) - ms(first.t)) / DAY : 0;
    if (first && lowest && lowest.volts < first.volts && dd >= 1) {
      drop = r2(((first.volts - lowest.volts) / dd) * 30);
      const opBetween = recent.filter((e) => e.t! >= first.t && e.t! <= lowest.t && isIn(e.code, OPENING)).length;
      per1000 = opBetween >= 20 ? r2(((first.volts - lowest.volts) / opBetween) * 1000) : null;
    }
    const startedBy: BatteryPeriod['startedBy'] = i === 0 ? 'report' : exchanges[i - 1]!.how.startsWith('Battery') ? 'exchange' : 'reading';
    periods.push({ from: a, to: b, startedBy, firstVolts: first?.volts ?? null, lowestVolts: lowest?.volts ?? null, lowestAt: lowest?.t ?? null, days: r1(d),
      dropPer30Days: drop, openings: op, dropPer1000Openings: per1000, alarms: alarms.filter((x) => x.t >= a && x.t < end).length,
      reached: levels.map((v) => { const h = rs.find((r) => r.volts <= v + 1e-6); return { volts: v, days: h && startedBy !== 'report' ? r1((ms(h.t) - ms(a)) / DAY) : null }; }),
      firmwareAlarms: firmwareAlarms.filter((x) => x.t >= a && x.t < end).length });
  }
  const rates = periods.map((x) => x.dropPer30Days).filter((x): x is number => x != null && x > 0);
  const avgDrop = rates.length ? r2(rates.reduce((s, x) => s + x, 0) / rates.length) : null;
  const estimatedDays = avgDrop ? Math.round(((top - alarmLevel) / avgDrop) * 30) : null;
  const lastReading = readings[readings.length - 1] ?? null;
  const battery = { readings, ignoredReadings, alarms, alarmDays, exchanges, periods, avgDropPer30Days: avgDrop, estimatedDaysPerSet: estimatedDays,
    scale: scaleHigh ? '6-9 V' : '3-4.8 V', alarmLevel, confirmLevel, firmwareDays, lastReading, firmwareAlarms };

  // ---- Faults ------------------------------------------------------------------------------------------------------
  const restartsAll = all.filter((e) => isIn(e.code, C.restart));
  const restartsExpected = restartsAll.filter((e) => e.t && !bogus(e.t) && nearChange(e.t)).length;
  const faults = {
    internal: count(C.internal), cardReading: count(C.cardRead), ble: count(C.ble), data: count(C.data), wrongSystem: count(C.wrongSystem),
    restarts: restartsAll.length - restartsExpected, restartsAfterBatteryChange: restartsExpected, coldStarts: count(C.coldStart), accessDeniedBattery: count(C.accessDenied),
  };

  // ---- Service and communication -----------------------------------------------------------------------------------
  const lastOf = (list: readonly number[]) => [...ev].reverse().find((e) => isIn(e.code, list))?.t ?? null;
  const service = {
    readouts: count(C.readout), parametersRead: count(C.paramsRead), timeSet: count(C.timeSet), programDownloads: count(C.program), initialisations: count(C.init),
    lastReadout: lastOf([...C.readout, ...C.paramsRead]), lastTimeSet: lastOf(C.timeSet), lastProgram: lastOf(C.program),
  };
  const pings = recent.filter((e) => isIn(e.code, C.ping)).map((e) => e.t!);
  let longestGap = 0, gapFrom: string | null = null;
  for (let i = 1; i < pings.length; i++) { const g = ms(pings[i]!) - ms(pings[i - 1]!); if (g > longestGap) { longestGap = g; gapFrom = pings[i - 1]!; } }
  const online = { pings: pings.length, lastPing: pings[pings.length - 1] ?? null, longestGapHours: pings.length > 1 ? r1(longestGap / 3_600_000) : null, longestGapFrom: gapFrom };

  // ---- Week by week ----------------------------------------------------------------------------------------------------
  const weekOf = (t: string) => { const d = new Date(ms(t.slice(0, 10) + 'T00:00')); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const weeks = new Map<string, { week: string; openings: number; refused: number; leftOpen: number; internal: number; cardReading: number; restarts: number; batteryAlarms: number; lowest: number | null }>();
  const wk = (t: string) => { const k = weekOf(t); let x = weeks.get(k); if (!x) { x = { week: k, openings: 0, refused: 0, leftOpen: 0, internal: 0, cardReading: 0, restarts: 0, batteryAlarms: 0, lowest: null }; weeks.set(k, x); } return x; };
  for (const e of recent) {
    const x = wk(e.t!);
    if (isIn(e.code, OPENING)) x.openings++;
    else if (isIn(e.code, C.ajar)) x.leftOpen++;
    else if (isIn(e.code, C.internal)) x.internal++;
    else if (isIn(e.code, C.cardRead)) x.cardReading++;
    else if (isIn(e.code, C.restart) && !nearChange(e.t!)) x.restarts++;
    else if (/^error/i.test(e.name) && !isIn(e.code, FAULT_CODES)) x.refused++;
  }
  for (const a of alarms) wk(a.t).batteryAlarms++;
  for (const r of readings) { const x = wk(r.t); x.lowest = x.lowest == null ? r.volts : Math.min(x.lowest, r.volts); }
  const weekly = [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1));

  // Openings per day (lock time).
  const daily = new Map<string, number>();
  for (const e of recent) if (isIn(e.code, OPENING)) daily.set(e.t!.slice(0, 10), (daily.get(e.t!.slice(0, 10)) ?? 0) + 1);
  const days: { day: string; openings: number }[] = [];
  if (wFrom && to) for (let d = ms(wFrom.slice(0, 10) + 'T00:00'); d <= ms(to.slice(0, 10) + 'T00:00') && days.length < 800; d += DAY) {
    const k = new Date(d).toISOString().slice(0, 10);
    days.push({ day: k, openings: daily.get(k) ?? 0 });
  }

  // ---- Findings, most serious first ---------------------------------------------------------------------------------------
  const f: Finding[] = [];
  const dt = (t: string) => t.slice(0, 10);
  const nd = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  // New batteries that drain fast, one finding for all the sets in the report.
  const fast: string[] = [];
  let fastest = Infinity;
  for (const x of periods) {
    if (x.startedBy === 'report' || x.lowestVolts == null || x.lowestAt == null) continue;
    const hit = readings.find((r) => r.t >= x.from && r.t <= x.to && r.volts <= levels[0]! + 1e-6);
    const reachDays = hit ? (ms(hit.t) - ms(x.from)) / DAY : Infinity;
    if (hit && reachDays <= 21) {
      fastest = Math.min(fastest, reachDays);
      fast.push(`changed ${dt(x.from)} (${x.startedBy === 'exchange' ? '"Battery exchanged"' : 'reading back at the top'}): below ${hit.volts.toFixed(1)} V after ${reachDays < 1 ? 'less than a day' : nd(Math.round(reachDays))}${x.lowestVolts < hit.volts ? `, below ${x.lowestVolts.toFixed(1)} V by ${dt(x.lowestAt)}` : ''}`);
    }
  }
  if (fast.length) f.push({ area: 'battery', level: 'high', title: fast.length === 1 ? `New batteries down to ${levels[0]!.toFixed(1)} V in ${fastest < 1 ? 'less than a day' : nd(Math.round(fastest))}` : `New batteries drained fast ${fast.length} times`,
    detail: `${fast.map((x) => x[0]!.toUpperCase() + x.slice(1)).join('; ')}. A good set normally lasts many months.`,
    action: 'Check that the batteries are new, of the type the lock requires (alkaline or lithium as specified, not rechargeable), all from the same pack, and that the contacts are clean and tight. Then look at the lock and door findings below: a lock that restarts, keeps its motor running, or a door that rubs or is left open, drains batteries.' });
  if (firmwareAlarms.length) {
    const changes = [...new Set(firmwareAlarms.map((x) => x.changedAt))];
    f.push({ area: 'lock', level: 'high', title: `Battery alarm after new batteries: firmware fault (${firmwareAlarms.length} time${firmwareAlarms.length === 1 ? '' : 's'})`,
      detail: `After the battery change${changes.length === 1 ? '' : 's'} on ${changes.map(dt).join(', ')} the lock raised a battery alarm (first: ${firmwareAlarms[0]!.name}, ${firmwareAlarms[0]!.t.replace('T', ' ')}) while its readings stayed above ${confirmLevel.toFixed(1)} V. A battery alarm after new batteries, even once, is a firmware fault, not a battery problem; it is not counted as a battery alarm here.`,
      action: 'Program the lock and upload its firmware with the service tool, then read the lock again and check that the alarm has cleared.' });
  }
  if (faults.accessDeniedBattery) f.push({ area: 'battery', level: 'high', title: 'The lock refused cards because of its battery', detail: `${faults.accessDeniedBattery} time(s) the lock switched to "access denied" for low battery.`, action: 'Replace the batteries now.' });
  if (!exchanges.length && lastReading && lastReading.volts <= confirmLevel + 1e-6)
    f.push({ area: 'battery', level: lastReading.volts <= alarmLevel + 1e-6 ? 'high' : 'medium', title: `Batteries at ${lastReading.volts.toFixed(1)} V at the end of the report`, detail: `Last reading ${lastReading.t.replace('T', ' ')}; the lock's usual low-battery level is ${alarmLevel.toFixed(1)} V.`, action: 'Plan a battery change.' });
  const intRecent = count(C.internal, recent);
  if (faults.internal >= 5) f.push({ area: 'lock', level: intRecent / spanDays >= 0.2 || faults.internal >= 20 ? 'high' : 'medium', title: `Internal lock error ${faults.internal} times`, detail: `"Error, Internal (1975)": ${intRecent} in the last ${Math.round(spanDays)} days (${(intRecent / spanDays * 7).toFixed(1)} a week).`,
    action: 'Program the lock and upload its firmware. If the error continues, have the door unit (electronics) checked or replaced.' });
  if (clockLost) f.push({ area: 'lock', level: 'medium', title: 'The lock lost its clock', detail: `${clockLost} event(s) are dated before 2000: the lock restarted without its time, which happens when the batteries run flat or are removed.`,
    action: 'Set the time with the service device after every battery change.' });
  if (faults.restarts >= 5) f.push({ area: 'lock', level: 'medium', title: `The lock restarted ${faults.restarts} times`, detail: `${faults.coldStarts} cold start(s) included; ${faults.restartsAfterBatteryChange} restart(s) right after a battery change are normal and not counted. Frequent restarts point to loose battery contacts or weak batteries.`, action: 'Check the battery holder, its springs and contacts, and the cable to the door unit.' });
  if (faults.cardReading >= 5) f.push({ area: 'lock', level: 'medium', title: `Card reading errors ${faults.cardReading} times`, detail: 'The reader could not read or write a card.', action: 'Clean the reader; if it continues for different cards, check the reader. Replace damaged cards.' });
  if (faults.ble >= 3) f.push({ area: 'lock', level: 'medium', title: `Bluetooth errors ${faults.ble} times`, detail: 'Mobile key or Bluetooth communication failed.', action: 'Check the lock\'s BLE module and firmware.' });
  if (faults.wrongSystem) f.push({ area: 'lock', level: 'medium', title: 'Cards from another system', detail: `"Wrong System-ID" ${faults.wrongSystem} time(s): cards of another Visionline system, or the lock was not initialised for this one.`, action: 'Initialise the lock for this system if it was replaced or moved.' });
  if (faults.data >= 3) f.push({ area: 'lock', level: 'info', title: `Communication/data errors ${faults.data} times`, detail: 'Decryption, received-data or parameter errors.', action: 'Usually cleared by programming the lock.' });
  const ajarPerDay = door.leftOpenRecent / spanDays;
  if (door.leftOpenRecent >= 10 || ajarPerDay >= 0.5) f.push({ area: 'door', level: ajarPerDay >= 2 ? 'high' : 'medium', title: `Door left open too long ${door.leftOpenRecent} times in ${nd(Math.round(spanDays))}`,
    detail: `About ${ajarPerDay.toFixed(1)} a day (${usage.leftOpen} in the whole report)${door.longestOpenMinutes != null ? `; open up to ${door.longestOpenMinutes} minutes (typically ${door.medianOpenMinutes})` : ''}. Each alarm wakes the lock and uses battery.`,
    action: 'Check the door closer and that the door shuts and latches by itself; check that it is not wedged open.' });
  if (door.openedWithoutCredential.length >= 3) f.push({ area: 'security', level: door.openedWithoutCredential.length / spanDays >= 0.5 ? 'high' : 'medium', title: `Opened from outside ${door.openedWithoutCredential.length} times with no card or key just before`,
    detail: `The lock saw the door open from outside without a card, key or command in the 2 minutes before (last: ${door.openedWithoutCredential[door.openedWithoutCredential.length - 1]!.replace('T', ' ')}). Usually the latch did not catch when the door closed; it can also be a forced door.`,
    action: 'Check that the latch and strike engage every time the door closes (door alignment, closer speed). If the door was latched, treat it as a security incident.' });
  if (usage.mechanicalKey) f.push({ area: 'security', level: usage.mechanicalKey >= 3 ? 'medium' : 'info', title: `Metal key used ${usage.mechanicalKey} time${usage.mechanicalKey === 1 ? '' : 's'}`,
    detail: `The mechanical key was used to open or lock the door (last: ${lastOf(C.mechanicalKey)?.replace('T', ' ') ?? '—'}). The metal key is for emergencies or a lock without power; the lock cannot tell who used it.`, action: 'Check who holds the metal key and why it was used; if the lock had no power, look at the battery findings.' });
  const refusedRecent = refusedBy.reduce((s, x) => s + x.recent, 0);
  const unexpected = refusedBy.filter((x) => !x.expected);
  if (refusedRecent / spanDays >= 1) f.push({ area: 'use', level: unexpected.some((x) => x.recent / spanDays >= 0.3) ? 'medium' : 'info', title: `Entries refused ${refusedRecent} times in ${Math.round(spanDays)} days`,
    detail: refusedBy.slice(0, 4).map((x) => `${x.name.replace(/^Error, /, '')} ${x.n}×${x.meaning ? ` (${x.meaning.replace(/^Refused: /, '').replace(/\.$/, '')})` : ''}`).join('; ') + '. The lock worked as it should in these cases: they are card or rights matters, not lock faults.',
    action: 'Check the cards and user groups of the people concerned (expired cards, missing rights, deadbolt override for staff who must enter). Repeated refusals also use battery.' });
  const deadboltRefused = refusals.get('33')?.n ?? 0;
  if (usage.deadbolt) f.push({ area: 'use', level: 'info', title: `Double lock used ${usage.deadbolt} time${usage.deadbolt === 1 ? '' : 's'} from inside`,
    detail: `The deadbolt knob inside the room was turned ${usage.deadbolt} time(s) (released ${usage.deadboltReleased}).${deadboltRefused ? ` ${deadboltRefused} card(s) were refused while it was on: only cards with the right to override the deadbolt open the room then.` : ''}` });
  if (online.pings) f.push({ area: 'data', level: 'info', title: `The lock has an online connection (${online.pings} pings from the server)`,
    detail: `Last ping ${online.lastPing?.replace('T', ' ')}. Pings are sent when the server asks, so gaps between them alone do not mean the lock was offline.` });
  if (avgDrop != null) f.push({ area: 'battery', level: 'info', title: `Battery use: ${avgDrop.toFixed(2)} V per 30 days`, detail: estimatedDays != null ? `At this rate a new set reaches the low-battery level (${alarmLevel.toFixed(1)} V) after about ${estimatedDays} days.` : 'Average of the battery periods in the report.' });
  f.push({ area: 'use', level: 'info', title: `${usage.perDay} openings a day`, detail: `Over the last ${Math.round(spanDays)} days${busiest.length ? `, busiest around ${busiest.map((b) => `${String(b.h).padStart(2, '0')}:00`).join(', ')}` : ''}. In the whole report: ${usage.openings} openings (${usage.staffCards} staff card, ${usage.guestCards} guest card, ${usage.openedFromInside} from inside).` });
  if (service.readouts) f.push({ area: 'data', level: 'info', title: `Read with the service device ${service.readouts} times`, detail: `Last read ${service.lastReadout?.replace('T', ' ') ?? '—'}. Time set ${service.timeSet} times, program uploaded ${service.programDownloads} times.` });
  const order = { high: 0, medium: 1, info: 2 };
  f.sort((a, b) => order[a.level] - order[b.level]);

  // What to do, in order, without repeats.
  const actions: { level: Finding['level']; text: string }[] = [];
  for (const x of f) if (x.action && x.level !== 'info' && !actions.some((a) => a.text === x.action)) actions.push({ level: x.level, text: x.action });
  const verdict = f.some((x) => x.level === 'high') ? 'attention' : f.some((x) => x.level === 'medium') ? 'check' : 'ok';

  // ---- Elimination, step by step (2.19) ------------------------------------------------------------------------------
  // The usual causes of a lock that drains its batteries or misbehaves, simplest first. Each step says what the report
  // shows; the technician checks it on the door and marks it OK or problem found, until the cause is left.
  const fastDrain = fast.length > 0;
  const per1000 = periods.map((x) => x.dropPer1000Openings).filter((x): x is number => x != null);
  const restartsNow = faults.restarts;
  const S = (id: string, title: string, check: string, suggests: Step['suggests'], evidence: string): Step => ({ id, title, check, suggests, evidence });
  const steps: Step[] = [
    S('batteries', 'Batteries', 'Are the batteries new, of the type the lock requires (not rechargeable), all from the same pack and fitted the right way round?',
      fastDrain ? 'likely' : alarms.length ? 'possible' : 'unlikely',
      fastDrain ? `New batteries drained fast ${fast.length} time(s).` : alarms.length ? `${alarms.length} battery alarm(s) that count.` : 'No fast drain in the report.'),
    S('contacts', 'Battery holder and contacts', 'Are the battery springs and contacts clean, tight and not corroded; is the cable to the door unit firmly connected?',
      restartsNow >= 5 || clockLost > 0 ? 'likely' : restartsNow > 0 ? 'possible' : 'unlikely',
      `${restartsNow} restart(s) not explained by a battery change${clockLost ? `, clock lost (${clockLost} events before 2000)` : ''}.`),
    S('door', 'Door and lock mechanics', 'Is the door aligned; do latch and strike engage without rubbing; does the closer shut and latch the door; does the deadbolt turn freely?',
      ajarPerDay >= 0.5 || door.openedWithoutCredential.length >= 3 ? 'likely' : door.leftOpenRecent > 0 ? 'possible' : 'unlikely',
      `Left open too long ${door.leftOpenRecent} time(s) in ${Math.round(spanDays)} days (up to ${door.longestOpenMinutes ?? 0} min); opened from outside with no card or key ${door.openedWithoutCredential.length} time(s).`),
    S('use', 'How much the door is used', 'Is this door unusually busy (staff corridor, service door), so the batteries simply work harder?',
      usage.perDay >= 40 ? 'possible' : 'unlikely',
      `${usage.perDay} openings a day${per1000.length ? `; ${per1000.map((x) => x.toFixed(1)).join(' / ')} V per 1,000 openings` : ''}.`),
    S('reader', 'Card reader', 'Is the reader clean and undamaged; do different cards fail, or only some?',
      faults.cardReading >= 5 ? 'likely' : faults.cardReading > 0 ? 'possible' : 'unlikely', `${faults.cardReading} card reading error(s).`),
    S('bluetooth', 'Bluetooth (mobile keys)', 'Is Bluetooth on at this lock; are mobile keys used here; is the BLE module and its firmware up to date?',
      faults.ble >= 3 ? 'likely' : faults.ble > 0 ? 'possible' : 'unlikely', `${faults.ble} Bluetooth error(s).`),
    S('radio', 'Online radio and gateway', 'Online locks keep a radio link to their gateway: is the signal to the gateway good, and the gateway online? A weak link makes the lock retry and use more battery.',
      online.pings > 0 && fastDrain ? 'possible' : online.pings > 0 ? 'unknown' : 'unlikely', online.pings ? `Online lock: ${online.pings} ping(s) from the server, last ${online.lastPing?.replace('T', ' ')}.` : 'No server pings: the lock works offline.'),
    S('electronics', 'Door unit electronics', 'If internal errors continue after programming, the door unit (electronics) must be checked or replaced.',
      faults.internal >= 5 ? 'likely' : faults.internal > 0 ? 'possible' : 'unlikely', `${faults.internal} internal error(s) (1975).`),
    S('firmware', 'Firmware', 'Program the lock and upload the firmware with the service tool; read the lock again afterwards. Firmware faults cause false battery alarms and can also drain the batteries.',
      firmwareAlarms.length || faults.internal >= 5 ? 'likely' : fastDrain ? 'possible' : 'unknown',
      `${firmwareAlarms.length} battery alarm(s) after new batteries with good readings; ${faults.internal} internal error(s); program uploaded ${service.programDownloads} time(s)${service.lastProgram ? `, last ${service.lastProgram.replace('T', ' ')}` : ''}.`),
    S('environment', 'Location and climate', 'Is the lock outdoors, in a humid or very cold or hot place (pool, kitchen, near heating, direct sun)? Batteries lose capacity there.',
      'unknown', 'The report cannot tell; check on site.'),
  ];

  // Event names, most frequent first (for the "all events" table).
  const byName = new Map<string, { code: number; name: string; n: number; last: string | null; meaning: string | null; internal: boolean }>();
  for (const e of all) { const k = String(e.code); const x = byName.get(k) ?? { code: e.code, name: e.name, n: 0, last: null, meaning: meaning(e.code), internal: /door unit internal/i.test(e.card) }; x.n++; if (e.t && !bogus(e.t) && (!x.last || e.t > x.last)) x.last = e.t; byName.set(k, x); }
  return {
    period: { from, to, days: from && to ? r1((ms(to) - ms(from)) / DAY) : 0 }, window, events: all.length, clockLost, verdict, actions,
    quality: { duplicates: p.duplicates ?? 0, invalidTimes: p.invalidTimes ?? 0, clockLost, future, dateOrder: p.dateOrder ?? null, ignoredReadings },
    usage, refusedBy, door, faults, service, online, battery, weekly, daily: days, findings: f, steps,
    eventTypes: [...byName.values()].sort((a, b) => b.n - a.n).slice(0, 120),
  };
}
export type LockAnalysis = ReturnType<typeof analyseLockReport>;
