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
  { id: 'classic-alfa', name: 'VingCard Classic Alfa (offline)' },
  { id: 'allure', name: 'VingCard Allure' },
  { id: 'novel', name: 'VingCard Novel' },
  { id: 'novel-battery-free', name: 'VingCard Novel battery-free' },
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
  // 2.36 The .txt export of Visionline's "Read events" window: "Event name" and "Event code" in two columns
  // ("Staff card accepted" / "64"), the "(*)" mark in the name.
  let codeCol = -1;
  if (event < 0) {
    const c = head.findIndex((h, i) => /^event ?code$|^code$/i.test(h.trim()) && share(i, (v) => /^\d{1,4}$/.test(v.trim())) > 0.6);
    const n = head.findIndex((h) => /^event( ?name)?$|^description$/i.test(h.trim()));
    if (c >= 0) { codeCol = c; event = n >= 0 ? n : c; }
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
    const m = codeCol >= 0
      ? (/^\d{1,4}$/.test((r[codeCol] ?? '').trim()) ? ['', (r[codeCol] ?? '').trim(), /\(\*\)/.test(r[event] ?? '') ? '*' : undefined] as unknown as RegExpExecArray : null)
      : CODE.exec((r[event] ?? '').trim());
    if (!m) continue;
    const t = localTime(r[time] ?? '', dateOrder);
    const sq = seq >= 0 && /^\d+$/.test((r[seq] ?? '').trim()) ? Number(r[seq]) : null;
    if (sq != null) {
      const k = `${sq}|${m[1]}|${t}`;
      if (seen.has(k)) { duplicates++; continue; }
      seen.add(k);
    }
    if (!t) invalidTimes++;
    const name = (codeCol >= 0 && event !== codeCol ? (r[event] ?? '').replace(/\(\*\)/, '') : (r[event] ?? '').replace(CODE, '')).trim();
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
  /** 2.31 Per set: use, deadbolt, restarts, card and internal errors, days to the first battery alarm. */
  openingsPerDay?: number | null; deadbolt?: number; restarts?: number; cardErrors?: number; internalErrors?: number; firstAlarmDays?: number | null;
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
  // 2.31 Locks without a door sensor (VingCard Classic: no "The door is opened" event) count an opening for each card
  // accepted, power open or metal key, so use per day and battery use per 1,000 openings work for them too.
  // 2.35 A few "door opened" events (from inside, or from a service visit) do not make a door sensor: K Hotel Douala 508
  // had 2,500 guest cards accepted and only a handful of door events, and was shown with 0 openings a day.
  const doorEvents = all.filter((e) => isIn(e.code, OPENING)).length;
  const sensor = doorEvents > 0 && doorEvents >= 0.25 * all.filter((e) => isIn(e.code, [...C.staffAccepted, ...C.guestAccepted])).length;
  const isOpening = (e: LockEvent): boolean => (sensor ? isIn(e.code, OPENING) : isIn(e.code, [...C.staffAccepted, ...C.guestAccepted, ...C.mechanicalKey, 76]) || (/accepted|power open/i.test(e.name) && !/^error/i.test(e.name)));
  const countOpen = (src: LockEvent[] = all) => src.filter(isOpening).length;
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
  const openings = countOpen();
  const byCard = new Map<string, number>();
  for (const e of all) if (isIn(e.code, [...C.staffAccepted, ...C.guestAccepted]) || /accepted/i.test(e.name)) { const k = e.card || '(card type not given)'; byCard.set(k, (byCard.get(k) ?? 0) + 1); }
  const hourly = Array.from({ length: 24 }, () => 0), weekday = Array.from({ length: 7 }, () => 0);
  for (const e of recent) if (isOpening(e)) { hourly[Number(e.t!.slice(11, 13))]!++; weekday[new Date(ms(e.t!)).getUTCDay()]!++; }
  const busiest = hourly.map((n, h) => ({ h, n })).sort((a, b) => b.n - a.n).slice(0, 3).filter((x) => x.n > 0);
  const night = hourly.slice(0, 6).reduce((s, x) => s + x, 0);
  const usage = {
    openings, openingsFrom: sensor ? 'door sensor' as const : 'cards accepted' as const, openedFromOutside: count(C.opened), openedFromInside: count(C.openedInside), mechanicalKey: count(C.mechanicalKey),
    staffCards: count(C.staffAccepted), guestCards: count(C.guestAccepted), refused: 0, leftOpen: count(C.ajar), deadbolt: count(C.deadbolt), deadboltReleased: count(C.deadboltReleased),
    perDay: perDay(countOpen(recent)), byCardType: [...byCard.entries()].map(([card, n]) => ({ card, n })).sort((a, b) => b.n - a.n).slice(0, 12),
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
  // 2.36 Not "Door unit started" (577): the reading the lock takes when it powers up is the battery voltage it started
  // with (K Hotel Douala HK Room 6th Floor: 4.2 V at power-up on 26 Oct, 4.8 V on 12 Nov = new batteries).
  const busy = ev.filter((e) => isIn(e.code, [85, 86, 95, 578, 592])).map((e) => ms(e.t!));
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
  // 2.36 The lock started again ("Door unit started") and its next reading, within 10 days, is 0.4 V or more higher
  // than before: new batteries went in at the power-up (K Hotel Douala HK Room 9th: 4.2 V, then 4.6 V).
  for (const e of recent.filter((x) => isIn(x.code, [577]))) {
    if (exchanges.some((x) => Math.abs(ms(x.t) - ms(e.t!)) < 2 * DAY)) continue;
    // The reading before the power cut, the one the lock took at power-up, and the next one.
    const prev = [...raw].reverse().find((r) => ms(r.t) < ms(e.t!) - 10 * MIN && (r.volts >= 6) === scaleHigh)?.volts ?? null;
    const atUp = raw.find((r) => Math.abs(ms(r.t) - ms(e.t!)) <= 10 * MIN && (r.volts >= 6) === scaleHigh)?.volts ?? null;
    const after = readings.find((r) => ms(r.t) > ms(e.t!) + 10 * MIN && ms(r.t) <= ms(e.t!) + 10 * DAY) ?? null;
    const base = prev ?? atUp, high = Math.max(prev != null ? (atUp ?? -1) : -1, after?.volts ?? -1);
    if (base != null && high - base >= 0.4 - 1e-9 && !(after && exchanges.some((x) => Math.abs(ms(x.t) - ms(after.t)) < 2 * DAY))) {
      // When the power-up reading is still the old level, the new set starts just after it.
      const t = atUp != null && after && atUp < after.volts ? new Date(ms(e.t!) + 11 * MIN).toISOString().slice(0, 16) : e.t!;
      exchanges.push({ t, how: `Lock started again with new batteries: ${base.toFixed(1)} V before, ${high.toFixed(1)} V after` });
    }
  }
  exchanges.sort((a, b) => (a.t < b.t ? -1 : 1));
  // 2.36 Power-ups that are not battery changes: the lock lost its power and started again without new batteries
  // (batteries taken out and put back, a loose holder or contact, or batteries too weak to start). The reading the
  // lock took then, and the next one, tell which.
  const readingAt = (t: string) => [...raw].reverse().find((r) => ms(r.t) <= ms(t) + 10 * MIN && ms(r.t) >= ms(t) - 10 * MIN)?.volts ?? null;
  // A program upload, an initialisation or a factory reset restarts the lock too: not a power cut.
  const serviceAt = ev.filter((e) => isIn(e.code, [85, 86, 92, 93, 94, 95, 578, 592])).map((e) => ms(e.t!));
  const powerCuts = recent.filter((e) => isIn(e.code, [577]) && !exchanges.some((x) => Math.abs(ms(x.t) - ms(e.t!)) < 2 * DAY) && !serviceAt.some((b) => Math.abs(ms(e.t!) - b) <= 30 * MIN))
    .map((e) => ({ t: e.t!, volts: readingAt(e.t!) ?? [...readings].reverse().find((r) => r.t <= e.t!)?.volts ?? null }));
  // Resets "nothing changed" away from battery changes and programming: when they bunch up while the batteries are at
  // or under 4.4 V, the voltage collapses when the motor runs (weak batteries, a bad contact or a rusty holder).
  const lowAt = (t: string) => { const r = [...readings].reverse().find((x) => x.t <= t); return r ? r.volts : null; };
  const resets576 = recent.filter((e) => isIn(e.code, [576]) && !exchanges.some((x) => Math.abs(ms(x.t) - ms(e.t!)) < 30 * MIN) && !busy.some((b) => Math.abs(ms(e.t!) - b) <= 10 * MIN));
  const brownouts = resets576.filter((e) => { const v = lowAt(e.t!); return v != null && v <= (scaleHigh ? 8.4 : 4.4) + 1e-6; }).map((e) => e.t!);
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
    const op = recent.filter((e) => e.t! >= a && e.t! < end && isOpening(e)).length;
    // Consumption: from the first reading to the moment the lowest level was first reached.
    let drop: number | null = null, per1000: number | null = null;
    const dd = first && lowest ? (ms(lowest.t) - ms(first.t)) / DAY : 0;
    // 2.36 One 0.2 V step a day after new batteries is the lock settling, not a rate (HK Room 6th: "4.81 V per 30
    // days"): at least a week, or two steps over two days.
    if (first && lowest && lowest.volts < first.volts && (dd >= 7 || (first.volts - lowest.volts >= 0.4 - 1e-9 && dd >= 2))) {
      drop = r2(((first.volts - lowest.volts) / dd) * 30);
      const opBetween = recent.filter((e) => e.t! >= first.t && e.t! <= lowest.t && isOpening(e)).length;
      per1000 = opBetween >= 20 ? r2(((first.volts - lowest.volts) / opBetween) * 1000) : null;
    }
    const startedBy: BatteryPeriod['startedBy'] = i === 0 ? 'report' : exchanges[i - 1]!.how.startsWith('Battery') ? 'exchange' : 'reading';
    periods.push({ from: a, to: b, startedBy, firstVolts: first?.volts ?? null, lowestVolts: lowest?.volts ?? null, lowestAt: lowest?.t ?? null, days: r1(d),
      dropPer30Days: drop, openings: op, dropPer1000Openings: per1000, alarms: alarms.filter((x) => x.t >= a && x.t < end).length,
      reached: levels.map((v) => { const h = rs.find((r) => r.volts <= v + 1e-6); return { volts: v, days: h && startedBy !== 'report' ? r1((ms(h.t) - ms(a)) / DAY) : null }; }),
      firmwareAlarms: firmwareAlarms.filter((x) => x.t >= a && x.t < end).length,
      ...(() => { const inP = all.filter((e) => e.t && !bogus(e.t) && e.t >= a && e.t < end); const n = (l: readonly number[]) => inP.filter((e) => isIn(e.code, l)).length;
        const firstAlarm = [...alarms, ...firmwareAlarms].filter((x) => x.t >= a && x.t < end).map((x) => x.t).sort()[0];
        return { openingsPerDay: d >= 1 ? r1(op / d) : null, deadbolt: n(C.deadbolt), restarts: n(C.restart), cardErrors: n(C.cardRead) + n(C.data), internalErrors: n(C.internal),
          firstAlarmDays: firstAlarm && startedBy !== 'report' ? r1((ms(firstAlarm) - ms(a)) / DAY) : null }; })() });
  }
  const rates = periods.map((x) => x.dropPer30Days).filter((x): x is number => x != null && x > 0);
  const avgDrop = rates.length ? r2(rates.reduce((s, x) => s + x, 0) / rates.length) : null;
  const estimatedDays = avgDrop ? Math.round(((top - alarmLevel) / avgDrop) * 30) : null;
  // 2.20 How many days each set of batteries lasted: from one change to the next (complete sets only); the set still in
  // the lock at the end of the report is counted apart, as "in for N days so far".
  const finished = periods.filter((x, i) => x.startedBy !== 'report' && i < periods.length - 1);
  const lastPeriod = periods[periods.length - 1];
  const lasted = {
    sets: finished.map((x) => ({ from: x.from, to: x.to, days: x.days })),
    avgDays: finished.length ? Math.round((finished.reduce((s2, x) => s2 + x.days, 0) / finished.length) * 10) / 10 : null,
    currentDays: lastPeriod && lastPeriod.startedBy !== 'report' ? lastPeriod.days : null,
  };
  const lastReading = readings[readings.length - 1] ?? null;
  // 2.35 How often the batteries were changed (Armel, 16 Nov: "share the frequency of battery changed"): per year, the
  // trend of the set life (each set lasting less than the one before points to a fault getting worse) and, when sets
  // that used to last weeks now last months, the day it changed (what was done that day fixed it).
  const setDays = lasted.sets.map((x) => x.days);
  const med = (a: number[]) => { const v = [...a].sort((x, y) => x - y); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2) : null; };
  const third = Math.max(1, Math.floor(setDays.length / 3));
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const early = avg(setDays.slice(0, third)), late = avg(setDays.slice(-third));
  const years = new Map<string, { year: string; changes: number; days: number[] }>();
  for (const x of exchanges) { const y = x.t.slice(0, 4); const e = years.get(y) ?? { year: y, changes: 0, days: [] }; e.changes++; years.set(y, e); }
  for (const x of lasted.sets) years.get(x.to.slice(0, 4))?.days.push(x.days);
  const firstChange = exchanges[0]?.t ?? null, lastChange = exchanges[exchanges.length - 1]?.t ?? null;
  const spanForRate = firstChange && to ? (ms(to) - ms(wFrom ?? firstChange)) / DAY : 0;
  const setMedian = med(setDays);
  const currentSet = lasted.currentDays;
  const frequency = {
    changes: exchanges.length, firstChange, lastChange,
    daysSinceLast: lastChange && to ? Math.round((ms(to) - ms(lastChange)) / DAY) : null,
    perYearRate: spanForRate >= 180 ? r1(exchanges.length / (spanForRate / 365)) : null,
    last365: to ? exchanges.filter((x) => ms(x.t) > ms(to) - 365 * DAY).length : 0,
    medianDays: setMedian != null ? r1(setMedian) : null, shortestDays: setDays.length ? r1(Math.min(...setDays)) : null, longestDays: setDays.length ? r1(Math.max(...setDays)) : null,
    trend: setDays.length >= 4 && early && late ? (late <= early * 0.7 ? 'shortening' as const : late >= early * 1.4 ? 'lengthening' as const : 'stable' as const) : null,
    earlyAvgDays: setDays.length >= 4 && early ? r1(early) : null, lateAvgDays: setDays.length >= 4 && late ? r1(late) : null,
    perYear: [...years.values()].sort((a, b) => (a.year < b.year ? -1 : 1)).map((y) => ({ year: y.year, changes: y.changes, avgDays: y.days.length ? r1(avg(y.days)!) : null })),
    /** 2.36 Openings each finished set gave (median): a busy door empties a set faster, a faulty lock gives few openings. */
    openingsPerSet: (() => { const v = med(periods.filter((x) => x.startedBy !== 'report' && cuts.indexOf(x.from) < cuts.length - 1 && x.openings > 0).map((x) => x.openings)); return v != null ? Math.round(v) : null; })(),
    /** When the report is too short for a yearly count: 365 / the set life (an estimate). */
    estimatedPerYear: setMedian != null && setMedian > 0 ? r1(365 / setMedian) : null,
    reportDays: from && to ? Math.round((ms(to) - ms(from)) / DAY) : null,
    // Last 12 months of the report (older ones are history).
    powerCuts: powerCuts.filter((x) => !to || ms(x.t) > ms(to) - 365 * DAY).length, brownoutResets: brownouts.filter((t) => !to || ms(t) > ms(to) - 365 * DAY).length,
    fixedSince: setDays.length >= 3 && setMedian != null && setMedian <= 60 && currentSet != null && currentSet >= Math.max(90, setMedian * 3) && lastChange
      ? { since: lastChange, days: Math.round(currentSet), before: r1(setMedian) } : null,
  };
  const battery = { readings, ignoredReadings, alarms, alarmDays, exchanges, periods, avgDropPer30Days: avgDrop, estimatedDaysPerSet: estimatedDays,
    scale: scaleHigh ? '6-9 V' : '3-4.8 V', alarmLevel, confirmLevel, firmwareDays, lastReading, firmwareAlarms, lasted, frequency };

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
    if (isOpening(e)) x.openings++;
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
  for (const e of recent) if (isOpening(e)) daily.set(e.t!.slice(0, 10), (daily.get(e.t!.slice(0, 10)) ?? 0) + 1);
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
    detail: `${(fast.length > 5 ? fast.slice(-5) : fast).map((x) => x[0]!.toUpperCase() + x.slice(1)).join('; ')}${fast.length > 5 ? ` (the last 5 of ${fast.length}; all are in Battery periods below)` : ''}. A good set normally lasts many months.`,
    action: 'Check that the batteries are new, of the type the lock requires (alkaline or lithium as specified, not rechargeable), all from the same pack, and that the contacts are clean and tight. Then look at the lock and door findings below: a lock that restarts, keeps its motor running, or a door that rubs or is left open, drains batteries.' });
  // 2.37 ASSA ABLOY (case CS0055208, Armel's 2021 Radisson Blu case): after LOW or CRITICAL, the lock clears its
  // battery flag only when the new batteries measure more than 4.5 V AND at least 0.5 V more than the previous
  // measurement. Batteries that are "good enough" but not fresh leave the flag on: low-battery warnings with new
  // batteries. Readings are steps of 0.2 V ("below 4.8 V" = 4.6 to 4.8 V).
  const flagCase = (changedAt: string) => {
    const prev = [...readings].reverse().find((r) => ms(r.t) < ms(changedAt) - 10 * MIN)?.volts ?? null;
    const next = readings.find((r) => ms(r.t) >= ms(changedAt) - 10 * MIN && ms(r.t) <= ms(changedAt) + 3 * DAY)?.volts ?? null;
    if (scaleHigh || next == null) return { prev, next, clears: null as boolean | null };
    // "below 4.8 V" (4.6-4.8) is over 4.5 V; "below 4.6 V" (4.4-4.6) may not be. A rise of one 0.2 V step or two
    // (0.4 V) may be under 0.5 V.
    const clears = next >= 4.8 - 1e-6 && (prev == null || next - prev >= 0.6 - 1e-6) ? true : next <= 4.6 + 1e-6 || (prev != null && next - prev <= 0.4 + 1e-6) ? false : null;
    return { prev, next, clears };
  };
  if (firmwareAlarms.length) {
    const changes = [...new Set(firmwareAlarms.map((x) => x.changedAt))];
    const cases = changes.map((c) => ({ c, ...flagCase(c) }));
    const notFresh = cases.filter((x) => x.clears === false);
    const n = firmwareAlarms.length;
    f.push({ area: 'battery', level: 'medium', title: `Low-battery warning still shown after new batteries (${n} time${n === 1 ? '' : 's'})`,
      detail: `${notFresh.length ? `${notFresh.slice(-4).map((x) => `${dt(x.c)}: ${x.prev != null ? `${x.prev.toFixed(1)} V before, ` : ''}${x.next!.toFixed(1)} V after`).join('; ')}. ` : ''}The lock clears its low-battery flag only when the new batteries measure more than 4.5 V and at least 0.5 V more than the previous measurement (ASSA ABLOY). ${notFresh.length ? 'These batteries were good enough to run the lock but not fresh enough to clear the flag, so the warning stayed on.' : 'The readings after the change do not show why the flag stayed on: the lock firmware kept it.'} These warnings are not counted as battery alarms here.`,
      action: notFresh.length
        ? 'Fit fresh industrial alkaline batteries from one pack (ASSA ABLOY recommends Varta Industrial 4006 or Panasonic Industrial LR6), not batteries from stock that already read under 4.6 V.'
        : 'Clear the flag with Lock Service 3G: Configure lock → "9V battery, 9V lock case" → Set → remove and re-insert the service cable → "4.5V battery, 4.5V lock case" → Set → remove the cable → present a staff card → parameter read-out. If the flag keeps coming back, upgrade the lock firmware.' });
  }
  // 2.37 Readings on both scales: the lock was set as a 9 V lock case at some point ("10 V / 10 V" after initialising).
  if (raw.some((r) => r.volts >= 6) && raw.some((r) => r.volts < 6))
    f.push({ area: 'lock', level: 'medium', title: 'Battery readings on both the 4.5 V and the 9 V scale',
      detail: 'Some readings are on the 9 V scale (a lock set as "9V battery, 9V lock case"), others on the 4.5 V scale. A lock on the wrong setting reports wrong battery levels and false alarms.',
      action: 'With Lock Service 3G: Configure lock → "4.5V battery, 4.5V lock case" → Set, then read the lock again.' });
  if (faults.accessDeniedBattery) f.push({ area: 'battery', level: 'high', title: 'The lock refused cards because of its battery', detail: `${faults.accessDeniedBattery} time(s) the lock switched to "access denied" for low battery.`, action: 'Replace the batteries now.' });
  if (!exchanges.length && lastReading && lastReading.volts <= confirmLevel + 1e-6)
    f.push({ area: 'battery', level: lastReading.volts <= alarmLevel + 1e-6 ? 'high' : 'medium', title: `Batteries at ${lastReading.volts.toFixed(1)} V at the end of the report`, detail: `Last reading ${lastReading.t.replace('T', ' ')}; the lock's usual low-battery level is ${alarmLevel.toFixed(1)} V.`, action: 'Plan a battery change.' });
  const intRecent = count(C.internal, recent);
  if (faults.internal >= 5) f.push({ area: 'lock', level: intRecent / spanDays >= 0.2 || faults.internal >= 20 ? 'high' : 'medium', title: `Internal lock error ${faults.internal} times`, detail: `"Error, Internal (1975)": ${intRecent} in the last ${Math.round(spanDays)} days (${(intRecent / spanDays * 7).toFixed(1)} a week).`,
    action: 'Program the lock and upload its firmware. If the error continues, have the door unit (electronics) checked or replaced.' });
  // 2.32 Firmware signs (Armel: "the locks were working fine before I upgraded the firmware in December 2025"):
  // program downloads, events this Visionline has no name for, and "Unknown command" answered to the service device.
  {
    const prog = all.filter((e) => e.t && !bogus(e.t) && isIn(e.code, C.program)).map((e) => e.t!.slice(0, 10));
    const unnamed = [...new Set(all.filter((e) => !e.name.replace(/\(\d+\)|\(\*\)/g, '').trim()).map((e) => e.code))];
    const unknownCmd = all.filter((e) => e.code === 1121).length;
    if (unnamed.length || unknownCmd) f.push({ area: 'lock', level: 'medium', title: 'Signs of a firmware / software mismatch',
      detail: `${unnamed.length ? `Events with no name in this Visionline: ${unnamed.slice(0, 6).map((c) => `(${String(c).padStart(4, '0')})`).join(', ')} (logged by a newer firmware than Visionline knows). ` : ''}${unknownCmd ? `"Error, Unknown command (1121)" ${unknownCmd} time(s): the lock did not understand the service device. ` : ''}${prog.length ? `Program loaded on ${[...new Set(prog)].slice(-4).join(', ')}. ` : ''}Compare the lock firmware with the firmware pack of Visionline and the service device; if battery life fell after a firmware upgrade, give ASSA ABLOY these dates and the battery sets.`,
      action: 'Check the firmware version of the lock (service device: read lock information) and of Visionline/the service device; ask ASSA ABLOY whether the version is known to drain batteries on this lock model.' });
  }
  if (clockLost) f.push({ area: 'lock', level: all.some((e) => isIn(e.code, C.coldStart)) ? 'info' : 'medium', title: 'The lock lost its clock', detail: `${clockLost} event(s) are dated before 2000: the lock restarted without its time, which happens when the batteries run flat or are removed.`,
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
  // 2.35 Battery change frequency, trend and the day a draining lock was fixed.
  if (frequency.changes >= 2 && frequency.perYearRate != null) {
    const often = frequency.medianDays != null && frequency.medianDays <= 90 && !frequency.fixedSince;
    f.push({ area: 'battery', level: often ? 'high' : 'info', title: `Batteries changed ${frequency.changes} times (${frequency.perYearRate} a year)`,
      detail: `${frequency.medianDays != null ? `A set lasted ${Math.round(frequency.medianDays)} days (median), from ${Math.round(frequency.shortestDays!)} to ${Math.round(frequency.longestDays!)} days. ` : ''}Last change ${dt(frequency.lastChange!)}, ${frequency.daysSinceLast} days before the end of the report. A healthy lock with industrial alkaline batteries goes a year or more on one set. Year by year: see "Battery change frequency" below.`,
      ...(often ? { action: 'Follow the steps below in order (cables and alignment, battery holder, batteries, then the LCA and the LCU swapped with a lock that works) and record each one on the lock, so the next report shows which one fixed it.' } : {}) });
  }
  // 2.36 What the K Hotel Douala staff-door logs showed (16 Nov 2026).
  let writeShare = 0, writePaired = 0, acceptedN = 0;
  // Power cuts and low-battery days of the last 12 months only: older ones are history (K Hotel Douala 508, 702).
  const yearAgo = to ? ms(to) - 365 * DAY : 0;
  const cutsRecent = powerCuts.filter((x) => ms(x.t) > yearAgo);
  if (cutsRecent.length) {
    const powerCuts = cutsRecent;
    const weak = powerCuts.filter((x) => x.volts != null && x.volts <= (scaleHigh ? 8.4 : 4.2) + 1e-6).length;
    f.push({ area: 'battery', level: powerCuts.length >= 2 ? 'high' : 'medium', title: `The lock lost its power ${powerCuts.length} time${powerCuts.length === 1 ? '' : 's'} without new batteries`,
      detail: `${powerCuts.slice(-6).map((x) => `${dt(x.t)}${x.volts != null ? ` (batteries at ${x.volts.toFixed(1)} V)` : ''}`).join('; ')}. "Door unit started" means the lock had no power and started again, and no higher battery reading followed: the batteries were taken out and put back, a contact or the battery holder opened, or ${weak ? 'the batteries were too weak to keep the lock running' : 'a cable is loose'}.`,
      action: 'Check the battery holder (springs, rust, contacts) and the cables first. If the lock keeps losing its power with good batteries and a clean holder, swap the LCA, then the LCU.' });
  }
  const brownoutsRecent = brownouts.filter((t) => ms(t) > yearAgo);
  if (brownoutsRecent.length >= 3) {
    const brownouts = brownoutsRecent;
    const bdays = new Set(brownouts.map((t) => t.slice(0, 10))).size;
    f.push({ area: 'battery', level: brownouts.length >= 8 ? 'high' : 'medium', title: `The lock reset ${brownouts.length} times on ${bdays} day${bdays === 1 ? '' : 's'} while its batteries were low`,
      detail: `"Door unit reset, nothing changed" with the batteries at ${scaleHigh ? '8.4' : '4.4'} V or less (last ${dt(brownouts[brownouts.length - 1]!)}). The voltage collapses when the motor runs and the lock starts again: weak batteries, a rusty battery holder or a bad contact. Each restart also uses battery.`,
      action: 'Change the batteries and clean or replace the battery holder. If the resets continue with new batteries, check that the door does not press on the lock (alignment, closer), then swap the LCA and the LCU.' });
  }
  {
    // Low-battery warnings while staff kept using the lock: how long it ran low before the batteries were changed.
    const lows = recent.filter((e) => isIn(e.code, C.cardLowAlert) && ms(e.t!) > yearAgo);
    const lowDays = new Set(lows.map((e) => e.t!.slice(0, 10)));
    const lowN = lows.length;
    if (lowN >= 20 && lowDays.size >= 3)
      f.push({ area: 'battery', level: 'medium', title: `Ran on low batteries for ${lowDays.size} days (${lowN} low-battery warnings)`,
        detail: 'Each card used on the lock while its batteries were low showed the warning. A lock left low for days refuses cards, restarts and can lose its time: change the batteries the day the first warning shows.',
        action: 'Have the battery alarms of this lock sent to the technicians (Battery status page) and change the batteries the same day.' });
  }
  {
    // The card is accepted, then "Error, Smart Card reading/writing" for the same card in the same minute: the lock
    // fails to write to the card (not a bad read). On every opening this keeps the radio on longer.
    const accepted = recent.filter((e) => isIn(e.code, [...C.staffAccepted, ...C.guestAccepted]));
    const accKeys = new Set(accepted.map((e) => `${e.t}|${e.card}`));
    const errKeys = new Set(recent.filter((e) => isIn(e.code, [1178])).map((e) => `${e.t}|${e.card}`));
    const paired = accepted.filter((e) => errKeys.has(`${e.t}|${e.card}`)).length;
    void accKeys;
    const share = accepted.length ? paired / accepted.length : 0;
    writeShare = share; writePaired = paired; acceptedN = accepted.length;
    if (accepted.length >= 50 && share >= 0.3) {
      for (let i = f.length - 1; i >= 0; i--) if (/^Card reading errors/.test(f[i]!.title)) f.splice(i, 1);
      f.push({ area: 'lock', level: share >= 0.6 ? 'high' : 'medium', title: `The lock fails to write to the card on ${Math.round(share * 100)}% of openings`,
        detail: `${paired} of ${accepted.length} accepted cards were followed in the same minute by "Error, Smart Card reading/writing". The card opens the door, but the lock cannot write back to it, and it tries on every opening. When the same cards work without this error on other doors, it is this lock (its reader, the LCA on Classic locks, or its settings), not the cards.`,
        action: 'Compare this lock with a door where the same cards give no error (Compare locks tab). Reprogram the lock with the service device; if the errors continue, swap the reader (or the LCA) with a lock that works.' });
    }
  }
  if (all.some((e) => isIn(e.code, C.coldStart)) && all.length < 200)
    f.push({ area: 'data', level: 'info', title: 'The lock was reset to factory settings and initialised again',
      detail: `${all.some((e) => isIn(e.code, C.data)) ? 'A "Decryption failed" error came first. ' : ''}Events before the time was set carry the lock's start date (1996 or 2000). With only ${all.length} events this read-out says nothing yet about the batteries.`,
      action: 'Read the lock again once it has been used for a few weeks.' });
  if (frequency.perYearRate == null && frequency.estimatedPerYear != null && frequency.reportDays != null && frequency.reportDays < 120)
    f.push({ area: 'battery', level: frequency.estimatedPerYear >= 6 ? 'high' : 'info', title: `About ${Math.round(frequency.estimatedPerYear)} battery changes a year at this rate`,
      detail: `The report covers only ${frequency.reportDays} days (${all.length} events: a busy door fills the lock's memory quickly). A set lasted ${Math.round(frequency.medianDays!)} days${frequency.openingsPerSet != null ? ` and gave about ${frequency.openingsPerSet} openings` : ''}. Read the lock again every few weeks and upload each read-out: the history adds up.` });
  if (frequency.trend === 'shortening' && !frequency.fixedSince)
    f.push({ area: 'battery', level: 'high', title: `Each set lasts less: from ${Math.round(frequency.earlyAvgDays!)} to ${Math.round(frequency.lateAvgDays!)} days`,
      detail: 'The first sets in the report lasted much longer than the last ones. Batteries of the same type do not do that: a fault in the lock is getting worse (a contact, the LCA or LCU, the reader or Bluetooth module keeping the lock awake).',
      action: 'Do not keep changing batteries: swap the LCA, then the LCU, with a lock whose batteries last, and read both locks again after 3 weeks.' });
  if (frequency.fixedSince) {
    const day0 = frequency.fixedSince.since.slice(0, 10);
    const that = all.filter((e) => e.t && e.t.slice(0, 10) === day0);
    const what = [that.some((e) => isIn(e.code, C.program)) && 'a program was uploaded', that.filter((e) => isIn(e.code, C.restart)).length >= 2 && `the door unit restarted ${that.filter((e) => isIn(e.code, C.restart)).length} times (parts being changed or plugged back)`,
      that.some((e) => isIn(e.code, C.timeSet)) && 'the time was set'].filter(Boolean);
    f.push({ area: 'battery', level: 'info', title: `Fixed since ${day0}: the current set has lasted ${frequency.fixedSince.days} days`,
      detail: `Before ${day0} a set lasted about ${Math.round(frequency.fixedSince.before)} days; the set fitted that day has lasted ${frequency.fixedSince.days} days so far.${what.length ? ` That day ${what.join(', ')}.` : ''} Whatever was done on ${day0} fixed the drain: write it in the lock's history so other locks get the same repair.` });
  }
  {
    // Card reading errors that started at some point (a reader going bad), month by month over the report.
    const byMonth = new Map<string, number>();
    for (const e of ev) if (isIn(e.code, C.cardRead)) byMonth.set(e.t!.slice(0, 7), (byMonth.get(e.t!.slice(0, 7)) ?? 0) + 1);
    const months: string[] = []; if (from && to) for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= to.slice(0, 7); d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
    const series = months.map((m) => byMonth.get(m) ?? 0);
    if (series.length >= 9) {
      // The month the errors jumped: the split into two steady levels that fits best (least squares, each side at least
      // 4 months); it counts when the level after is 4 times the level before and still high in the last 3 months.
      const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
      const sse = (a: number[]) => { const m = mean(a); return a.reduce((x, y) => x + (y - m) ** 2, 0); };
      let start = -1, best = Infinity;
      for (let k = 4; k <= series.length - 4; k++) { const e = sse(series.slice(0, k)) + sse(series.slice(k)); if (e < best) { best = e; start = k; } }
      const a6 = start >= 0 ? mean(series.slice(start)) : 0, b = start >= 0 ? mean(series.slice(0, start)) : 0;
      if (start >= 0 && a6 >= 20 && a6 >= Math.max(1, b) * 4 && mean(series.slice(-3)) >= a6 / 2) {
        for (let i = f.length - 1; i >= 0; i--) if (/^Card reading errors \d+ times$/.test(f[i]!.title)) f.splice(i, 1);
        f.push({ area: 'lock', level: 'medium', title: `Card reading errors rose to ${Math.round(a6)} a month since ${months[start]}`,
          detail: `Before ${months[start]}: about ${b.toFixed(b < 10 ? 1 : 0)} a month. A reader that keeps failing makes guests and staff present their card again and again, and each try wakes the lock: it also uses battery.`,
          action: 'Clean the reader and test with a new card. If the errors continue for every card, swap the reader (or the LCA on Classic locks) with a lock that works.' });
      }
    }
  }
  {
    // Use that rose sharply (a room that was little sold and is now busy): faster battery use is then expected.
    if (to && from && ms(to) - ms(from) >= 240 * DAY) {
      const cut = ms(to) - 90 * DAY, yearAgo = ms(to) - 365 * DAY;
      const accepted = ev.filter((e) => isIn(e.code, [...C.staffAccepted, ...C.guestAccepted]));
      const now90 = accepted.filter((e) => ms(e.t!) > cut).length / 90;
      const prev = accepted.filter((e) => ms(e.t!) > yearAgo && ms(e.t!) <= cut).length / 275;
      if (now90 >= 2 && now90 >= Math.max(0.3, prev) * 3)
        f.push({ area: 'use', level: 'info', title: `The room is used much more: ${now90.toFixed(1)} cards a day, against ${prev.toFixed(1)} before`,
          detail: 'Cards accepted in the last 90 days compared with the 9 months before. More openings use the batteries faster: a shorter set life is expected, not a fault, as long as the set still lasts many months.' });
    }
  }
  const low30 = to ? readings.filter((r) => ms(r.t) > ms(to) - 30 * DAY).reduce<number | null>((m, r) => (m == null || r.volts < m ? r.volts : m), null) : null;
  if (low30 != null && lasted.currentDays != null && lasted.currentDays >= 300 && low30 <= (scaleHigh ? 8.4 : 4.4) + 1e-6 && low30 > alarmLevel + 1e-6)
    f.push({ area: 'battery', level: 'medium', title: `Old set: in for ${Math.round(lasted.currentDays)} days, dipping to ${low30.toFixed(1)} V`,
      detail: `The set has done its time; the voltage dips when the lock works. It reaches the low-battery level (${alarmLevel.toFixed(1)} V) soon.`, action: 'Plan a battery change in the coming weeks (not urgent while no battery alarm shows).' });
  if (!readings.length && !raw.length && !exchanges.length && all.length > 0 && all.length < 1500 && !all.some((e) => isIn(e.code, [...C.ping, ...C.restart, ...C.readout, ...C.paramsRead])))
    f.push({ area: 'data', level: 'medium', title: 'This file has no battery readings: not a full read-out of the lock',
      detail: `${all.length} events over ${Math.round((ms(to ?? from ?? '2000-01-01T00:00') - ms(from ?? '2000-01-01T00:00')) / DAY)} days, without any "Battery level below" reading, battery change, restart or service event. It looks like a filtered export from Visionline (for example card events only), so the battery change frequency cannot be worked out.`,
      action: 'Read the lock with the service device, then in Visionline export all its events (100 to 3,000) without a filter, and upload that file.' });
  if (lasted.sets.length > 6) f.push({ area: 'battery', level: 'info', title: `${lasted.sets.length} battery sets lasted ${Math.round(frequency.medianDays ?? lasted.avgDays!)} days (median)`,
    detail: `From ${Math.round(frequency.shortestDays!)} to ${Math.round(frequency.longestDays!)} days, from one battery change to the next (average ${Math.round(lasted.avgDays!)} days).${lasted.currentDays != null ? ` The set in the lock at the end of the report had been in for ${Math.round(lasted.currentDays)} days.` : ''}` });
  else if (lasted.sets.length) f.push({ area: 'battery', level: 'info', title: `Battery sets lasted ${lasted.sets.map((x) => Math.round(x.days)).join(', ')} day${lasted.sets.length === 1 && Math.round(lasted.sets[0]!.days) === 1 ? '' : 's'}`,
    detail: `From one battery change to the next${lasted.sets.length > 1 ? ` (average ${Math.round(lasted.avgDays!)} days)` : ''}.${lasted.currentDays != null ? ` The set in the lock at the end of the report had been in for ${Math.round(lasted.currentDays)} days.` : ''}` });
  else if (lasted.currentDays != null) f.push({ area: 'battery', level: 'info', title: `Batteries in for ${Math.round(lasted.currentDays)} days`, detail: 'Since the last battery change in the report; no complete set to compare with.' });
  if (avgDrop != null) f.push({ area: 'battery', level: 'info', title: `Battery use: ${avgDrop.toFixed(2)} V per 30 days`, detail: estimatedDays != null ? `At this rate a new set reaches the low-battery level (${alarmLevel.toFixed(1)} V) after about ${estimatedDays} days.` : 'Average of the battery periods in the report.' });
  f.push({ area: 'use', level: 'info', title: `${usage.perDay} openings a day`, detail: `Over the last ${Math.round(spanDays)} days${busiest.length ? `, busiest around ${busiest.map((b) => `${String(b.h).padStart(2, '0')}:00`).join(', ')}` : ''}. In the whole report: ${usage.openings} openings (${usage.staffCards} staff card, ${usage.guestCards} guest card, ${usage.openedFromInside} from inside).` });
  if (service.readouts) f.push({ area: 'data', level: 'info', title: `Read with the service device ${service.readouts} times`, detail: `Last read ${service.lastReadout?.replace('T', ' ') ?? '—'}. Time set ${service.timeSet} times, program uploaded ${service.programDownloads} times.` });
  // 2.35 A drain that stopped (fixedSince): the old fast drains, battery alarms and battery refusals all came before the
  // fix, so they no longer ask for action; they stay listed as history.
  // A firmware battery alarm long ago (more than 6 months before the end of the report) is history, not an action.
  if (firmwareAlarms.length && to && ms(to) - ms(firmwareAlarms[firmwareAlarms.length - 1]!.t) > 180 * DAY)
    for (const x of f) if (/^Low-battery warning still shown after new batteries/.test(x.title)) { x.level = 'info'; x.title = `${x.title} (last ${firmwareAlarms[firmwareAlarms.length - 1]!.t.slice(0, 7)})`; delete x.action; }
  if (frequency.fixedSince) {
    const fx = frequency.fixedSince.since;
    const after = (l: readonly number[]) => ev.filter((e) => e.t! > fx && isIn(e.code, l) && !nearChange(e.t!)).length;
    for (const x of f) if (x.level !== 'info' && ((/^Internal lock error/.test(x.title) && after(C.internal) === 0) || (/^The lock restarted/.test(x.title) && after(C.restart) <= Math.max(2, frequency.fixedSince.days / 60)))) {
      x.level = 'info'; x.title = `Before ${fx.slice(0, 10)}: ${x.title[0]!.toLowerCase()}${x.title.slice(1)}`; delete x.action;
    }
    const lastAlarm = [...alarms, ...firmwareAlarms].map((a) => a.t).sort().pop() ?? '';
    for (const x of f) if (x.level === 'high' && x.area === 'battery' || /^Low-battery warning still shown after new batteries/.test(x.title)) {
      if (lastAlarm && lastAlarm > fx && !/^New batteries/.test(x.title)) continue;
      x.level = 'info'; x.title = `Before ${fx.slice(0, 10)}: ${x.title[0]!.toLowerCase()}${x.title.slice(1)}`; delete x.action;
    }
  }
  /**
   * 2.36 One status per lock for the hotel-wide comparison (Armel: "a realistic view on the locks draining batteries"):
   * the worst that applies, with every reason that applies, so a busy door, a power problem and a lock that cannot write
   * to cards are not all called "draining".
   */
  const health = () => {
    const reasons: { id: string; text: string }[] = [];
    const life = frequency.medianDays, est = frequency.estimatedPerYear;
    const draining = !frequency.fixedSince && ((life != null && life <= 90) || (lasted.currentDays == null && est != null && est >= 4) || alarmDays >= 7 && to != null && alarms.some((a) => ms(a.t) > ms(to) - 60 * DAY));
    if (draining) reasons.push({ id: 'draining', text: life != null ? `A set lasts ${Math.round(life)} days${frequency.openingsPerSet != null ? ` (${frequency.openingsPerSet} openings)` : ''}` : 'Battery alarms on many days' });
    if (cutsRecent.length) reasons.push({ id: 'power', text: `Lost its power ${cutsRecent.length} time${cutsRecent.length === 1 ? '' : 's'} without new batteries` });
    const lowResetsRecent = brownouts.filter((t) => ms(t) > yearAgo).length;
    if (lowResetsRecent >= 3) reasons.push({ id: 'power', text: `Reset ${lowResetsRecent} times while the batteries were low` });
    if (writeShare >= 0.3 && acceptedN >= 50) reasons.push({ id: 'card-writing', text: `Fails to write to the card on ${Math.round(writeShare * 100)}% of openings` });
    if (low30 != null && lasted.currentDays != null && lasted.currentDays >= 300 && low30 <= (scaleHigh ? 8.4 : 4.4) + 1e-6) reasons.push({ id: 'old-set', text: `Set in for ${Math.round(lasted.currentDays)} days, dipping to ${low30.toFixed(1)} V` });
    if (frequency.fixedSince) reasons.push({ id: 'fixed', text: `Fixed since ${frequency.fixedSince.since.slice(0, 10)}` });
    const noData = (!readings.length && !exchanges.length) || all.length < 100;
    const status = reasons.some((r) => r.id === 'draining') ? 'draining' : reasons.some((r) => r.id === 'power') ? 'power' : reasons.some((r) => r.id === 'card-writing') ? 'card-writing'
      : reasons.some((r) => r.id === 'old-set') ? 'watch' : noData ? 'no-data' : frequency.fixedSince ? 'fixed' : 'ok';
    const pick = (re: RegExp) => f.find((x) => re.test(x.title) && x.action)?.action ?? null;
    const todo = status === 'draining' ? pick(/^Each set lasts less/) ?? 'Follow the steps in order: cables and alignment, battery holder, batteries, then swap the LCA and the LCU with a lock that works.'
      : status === 'power' ? pick(/lost its power|while its batteries were low/) : status === 'card-writing' ? pick(/fails to write/) : status === 'watch' ? pick(/^Old set/)
      : status === 'no-data' ? pick(/no battery readings|initialised again/) ?? 'Read the lock with the service device and upload all its events.' : null;
    return { status, reasons: reasons.map((r) => r.text), todo };
  };
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
  // 2.35 Armel's order: cables and alignment, battery holder, batteries, door, then the LCA and the LCU.
  const steps: Step[] = [
    S('contacts', 'Cables, alignment and battery holder', 'First: is any cable cut, pinched or unplugged, is anything misaligned? Plug everything back correctly. Then the battery holder: rust or deposits on the holder, its springs and contacts? Clean it, or replace it if it is rusty.',
      restartsNow >= 5 || clockLost > 0 ? 'likely' : restartsNow > 0 ? 'possible' : 'unlikely',
      `${restartsNow} restart(s) not explained by a battery change${clockLost ? `, clock lost (${clockLost} events before 2000)` : ''}.`),
    S('batteries', 'Batteries', 'Are the batteries new, of the type the lock requires (not rechargeable), all from the same pack and fitted the right way round?',
      fastDrain ? 'likely' : alarms.length ? 'possible' : 'unlikely',
      fastDrain ? `New batteries drained fast ${fast.length} time(s).` : alarms.length ? `${alarms.length} battery alarm(s) that count.` : 'No fast drain in the report.'),
    S('door', 'Door and lock mechanics', 'Is the door aligned; do latch and strike engage without rubbing; does the closer shut and latch the door; does the deadbolt turn freely?',
      ajarPerDay >= 0.5 || door.openedWithoutCredential.length >= 3 ? 'likely' : door.leftOpenRecent > 0 ? 'possible' : 'unlikely',
      `Left open too long ${door.leftOpenRecent} time(s) in ${Math.round(spanDays)} days (up to ${door.longestOpenMinutes ?? 0} min); opened from outside with no card or key ${door.openedWithoutCredential.length} time(s).`),
    S('electronics', 'LCA, then LCU (door unit electronics)', 'If the batteries still drop after the cables, the battery holder and new batteries: swap the LCA (lock case adapter) with a lock whose batteries last, then the LCU (lock controller unit), one at a time, and read both locks again after 3 weeks. Internal errors that continue after programming point there too.',
      faults.internal >= 5 || (fastDrain && frequency.trend === 'shortening') ? 'likely' : faults.internal > 0 || fastDrain ? 'possible' : 'unlikely', `${faults.internal} internal error(s) (1975).`),
    S('reader', 'Card reader', 'Is the reader clean and undamaged; do different cards fail, or only some?',
      faults.cardReading >= 5 ? 'likely' : faults.cardReading > 0 ? 'possible' : 'unlikely', `${faults.cardReading} card reading error(s).`),
    S('bluetooth', 'Bluetooth (mobile keys)', 'Is Bluetooth on at this lock; are mobile keys used here; is the BLE module and its firmware up to date?',
      faults.ble >= 3 ? 'likely' : faults.ble > 0 ? 'possible' : 'unlikely', `${faults.ble} Bluetooth error(s).`),
    S('radio', 'Online radio and gateway', 'Online locks keep a radio link to their gateway: is the signal to the gateway good, and the gateway online? A weak link makes the lock retry and use more battery.',
      online.pings > 0 && fastDrain ? 'possible' : online.pings > 0 ? 'unknown' : 'unlikely', online.pings ? `Online lock: ${online.pings} ping(s) from the server, last ${online.lastPing?.replace('T', ' ')}.` : 'No server pings: the lock works offline.'),
    S('firmware', 'Firmware', 'Program the lock and upload the firmware with the service tool; read the lock again afterwards. Firmware faults cause false battery alarms and can also drain the batteries.',
      firmwareAlarms.length || faults.internal >= 5 ? 'likely' : fastDrain ? 'possible' : 'unknown',
      `${firmwareAlarms.length} battery alarm(s) after new batteries with good readings; ${faults.internal} internal error(s); program uploaded ${service.programDownloads} time(s)${service.lastProgram ? `, last ${service.lastProgram.replace('T', ' ')}` : ''}.`),
    S('use', 'How much the door is used', 'Is this door unusually busy (staff corridor, service door), so the batteries simply work harder?',
      usage.perDay >= 40 ? 'possible' : 'unlikely',
      `${usage.perDay} openings a day${per1000.length ? `; ${per1000.slice(-6).map((x) => x.toFixed(1)).join(' / ')} V per 1,000 openings${per1000.length > 6 ? ' (last 6 sets)' : ''}` : ''}.`),
    S('environment', 'Location and climate', 'Is the lock outdoors, in a humid or very cold or hot place (pool, kitchen, near heating, direct sun)? Batteries lose capacity there.',
      'unknown', 'The report cannot tell; check on site.'),
  ];

  // 2.35 A lock whose drain stopped: the steps keep their evidence, but none is "likely" any more.
  if (frequency.fixedSince) for (const st of steps) if (st.suggests === 'likely') { st.suggests = 'possible'; st.evidence = `Drain stopped on ${frequency.fixedSince.since.slice(0, 10)}. Before: ${st.evidence}`; }

  // Event names, most frequent first (for the "all events" table).
  const byName = new Map<string, { code: number; name: string; n: number; last: string | null; meaning: string | null; internal: boolean }>();
  for (const e of all) { const k = String(e.code); const x = byName.get(k) ?? { code: e.code, name: e.name, n: 0, last: null, meaning: meaning(e.code), internal: /door unit internal/i.test(e.card) }; x.n++; if (e.t && !bogus(e.t) && (!x.last || e.t > x.last)) x.last = e.t; byName.set(k, x); }
  return {
    period: { from, to, days: from && to ? r1((ms(to) - ms(from)) / DAY) : 0 }, window, events: all.length, clockLost, verdict, actions,
    cards: { accepted: acceptedN, writeErrors: writePaired, writeErrorShare: Math.round(writeShare * 100) / 100 },
    health: health(),
    quality: { duplicates: p.duplicates ?? 0, invalidTimes: p.invalidTimes ?? 0, clockLost, future, dateOrder: p.dateOrder ?? null, ignoredReadings },
    usage, refusedBy, door, faults, service, online, battery, weekly, daily: days, findings: f, steps,
    eventTypes: [...byName.values()].sort((a, b) => b.n - a.n).slice(0, 120),
  };
}
export type LockAnalysis = ReturnType<typeof analyseLockReport>;
