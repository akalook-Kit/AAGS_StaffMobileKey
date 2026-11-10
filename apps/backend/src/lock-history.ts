/**
 * 2.30 Lock history and the elimination method (Armel, 9 Nov): for each lock, how many times its batteries were
 * changed, which parts were changed or checked and when, and — once a lock report covering the time after the work is
 * uploaded — whether the batteries are fine since, or still draining (then that part was not the cause, and the next
 * one in the elimination order is checked). Works for offline locks from their own event reports; Novel locks have
 * their own parts. The recommended batteries are industrial alkaline AA.
 */

export const RECOMMENDED_BATTERY = 'industrial-alkaline';
export const BATTERY_TYPES = [
  { id: 'industrial-alkaline', name: 'Industrial alkaline AA (recommended)' },
  { id: 'alkaline', name: 'Standard alkaline AA (consumer)' },
  { id: 'lithium', name: 'Lithium AA' },
  { id: 'rechargeable', name: 'Rechargeable (NiMH) — not suitable' },
  { id: 'unknown', name: 'Not known' },
] as const;
export type BatteryType = (typeof BATTERY_TYPES)[number]['id'];

/** Groups in the order they are eliminated: simplest and cheapest first. step = the matching lock-report step. */
export const PART_GROUPS = [
  { id: 'batteries', name: 'Batteries', step: 'batteries', why: 'Wrong type (not industrial alkaline), old stock, mixed packs or fitted the wrong way drain fast or give false alarms. Fit a new pack of industrial alkaline AA from a known supplier, note the brand and batch, and check each cell with a multimeter before fitting (about 1.6 V for a fresh alkaline cell).' },
  { id: 'power', name: 'Battery holder, contacts and cable', step: 'contacts', why: 'Dirty, loose or corroded contacts and a pinched or cut cable make the voltage drop when the motor starts: alarms and restarts with good batteries.' },
  { id: 'mechanics', name: 'Door and lock mechanics', step: 'door', why: 'A door that rubs, a misaligned strike, a drooping handle or a stiff lockcase makes the motor work harder at every opening.' },
  { id: 'reader', name: 'Card reader', step: 'reader', why: 'A faulty or disturbed reader wakes up and reads again and again.' },
  { id: 'ble', name: 'Bluetooth (mobile keys)', step: 'bluetooth', why: 'A faulty BLE board or many mobile-key sessions use more power than cards.' },
  { id: 'online', name: 'Online radio and gateway', step: 'radio', why: 'A weak link to the gateway makes an online lock send again and again.' },
  { id: 'electronics', name: 'Door unit electronics and firmware', step: 'electronics', why: 'A faulty door unit or firmware can keep the lock awake or raise false battery alarms.' },
] as const;
export type PartGroup = (typeof PART_GROUPS)[number]['id'];

export const PARTS: { id: string; name: string; group: PartGroup; novel?: boolean; notNovel?: boolean; action?: boolean; only?: string[]; not?: string[] }[] = [
  { id: 'batteries', name: 'Batteries replaced', group: 'batteries' },
  { id: 'battery-holder', name: 'Battery holder / cover cleaned or replaced', group: 'power' },
  { id: 'battery-cable', name: 'Battery cable replaced', group: 'power' },
  { id: 'contacts-cleaned', name: 'Contacts cleaned (dirt, moisture, corrosion)', group: 'power', action: true },
  { id: 'strike', name: 'Strike plate / door alignment adjusted', group: 'mechanics', action: true },
  { id: 'screws', name: 'Fixing screws and spindle secured', group: 'mechanics', action: true },
  { id: 'handles', name: 'Handle or lever spring replaced', group: 'mechanics' },
  { id: 'spindle', name: 'Spindle replaced', group: 'mechanics' },
  { id: 'lockcase', name: 'Lockcase (mortise) replaced', group: 'mechanics', notNovel: true, not: ['classic-alfa'] },
  { id: 'closer', name: 'Door closer adjusted or replaced', group: 'mechanics' },
  { id: 'reader', name: 'Card reader / outside escutcheon replaced', group: 'reader', notNovel: true, not: ['classic-alfa'] },
  { id: 'ble', name: 'BLE (mobile key) board replaced', group: 'ble', notNovel: true, not: ['classic-alfa'] },
  { id: 'zigbee', name: 'Online (Zigbee) module replaced', group: 'online' , not: ['classic-alfa'] },
  { id: 'gateway', name: 'Gateway moved, replaced or signal improved', group: 'online', action: true , not: ['classic-alfa'] },
  { id: 'door-unit', name: 'Door unit electronics / inside escutcheon replaced', group: 'electronics', notNovel: true , not: ['classic-alfa'] },
  { id: 'firmware', name: 'Firmware updated / lock programmed', group: 'electronics', action: true },
  { id: 'time-set', name: 'Time set after the battery change', group: 'electronics', action: true },
  // VingCard Classic Alfa, offline (2.31, Armel: "has the LCU, LCA, lock case and the battery holder as components")
  { id: 'lca', name: 'LCA (outside unit, card reader) replaced', group: 'reader', only: ['classic-alfa'] },
  { id: 'lcu', name: 'LCU (lock control unit, inside) replaced', group: 'electronics', only: ['classic-alfa'] },
  { id: 'classic-lockcase', name: 'Lockcase replaced', group: 'mechanics', only: ['classic-alfa'] },
  // Novel (2.30, Armel: "if it is a novel lock, we need also to consider the equipment changed")
  { id: 'novel-reader', name: 'Novel reader unit (outside, RFID/BLE) replaced', group: 'reader', novel: true },
  { id: 'novel-inside', name: 'Novel inside unit / battery pack replaced', group: 'electronics', novel: true },
  { id: 'novel-lockcase', name: 'Novel lockcase (motor) replaced', group: 'mechanics', novel: true },
  { id: 'novel-power', name: 'Novel power module (frame / lock, battery-free) replaced', group: 'power', novel: true },
];
export const partName = (id: string) => PARTS.find((p) => p.id === id)?.name ?? id;
/** The parts that exist on a lock model (Novel and Classic Alfa have their own). */
export const partsFor = (model: string | null | undefined) => PARTS.filter((p) => (p.only ? Boolean(model && p.only.includes(model)) : !(model && p.not?.includes(model)) && (isNovel(model) ? !p.notNovel : !p.novel)));
export const isNovel = (model: string | null | undefined) => Boolean(model && model.startsWith('novel'));

export interface Reading { t: string; volts: number }
export interface Work { id: string; on: string; parts: string[]; names?: string[]; batteryType: string | null; notes?: string | null; by?: string | null }
export type Verdict = 'waiting' | 'fixed' | 'better' | 'ok' | 'watch' | 'same' | 'worse' | 'draining';
export interface Judged extends Work {
  verdict: Verdict; title: string; detail: string;
  before: Rate | null; after: Rate | null; againInDays: number | null; alarmsAfter: number; waitUntil: string | null;
}
export interface Rate { per30Days: number; days: number; readings: number; from: string; to: string; lowest: number; lifeDays: number | null }

const ms = (t: string) => Date.parse(t.length === 10 ? `${t}T00:00:00Z` : `${t}:00Z`);
const DAY = 86_400_000;
const r2 = (x: number) => Math.round(x * 100) / 100;
const addDays = (d: string, n: number) => new Date(ms(d) + n * DAY).toISOString().slice(0, 10);

/** Battery use over a window: from the first reading to the moment the lowest level was first reached (like the report). */
export function rateOf(rs: Reading[], top: number, alarmLevel: number): Rate | null {
  if (rs.length < 2) return null;
  const first = rs[0]!, last = rs[rs.length - 1]!;
  const span = (ms(last.t) - ms(first.t)) / DAY;
  const lowest = rs.reduce((m, r) => (r.volts < m.volts ? r : m), first);
  const dd = (ms(lowest.t) - ms(first.t)) / DAY;
  let per30: number;
  if (lowest.volts < first.volts && dd >= 1) per30 = ((first.volts - lowest.volts) / Math.max(dd, span >= 14 ? span : dd)) * 30;
  else if (span >= 14) per30 = 0; // no drop over two weeks or more
  else return null;
  // A set starts near the top of the scale: the life estimate is from the top to the alarm level at this rate.
  return { per30Days: r2(per30), days: Math.round(span), readings: rs.length, from: first.t, to: last.t, lowest: lowest.volts,
    lifeDays: per30 > 0 ? Math.round(((top - alarmLevel) / per30) * 30) : null };
}

/**
 * Judge each piece of work on the lock from what happened after it: battery use before and after, a new battery change
 * soon after, battery alarms. `changes` = battery changes (lock local time or date), `alarms` = battery alarms that count.
 */
export function judgeWorks(works: Work[], readings: Reading[], changes: string[], alarms: string[], o: { top: number; alarmLevel: number; today: string }): Judged[] {
  const rs = [...new Map(readings.map((r) => [r.t, r])).values()].sort((a, b) => (a.t < b.t ? -1 : 1));
  const ws = [...works].sort((a, b) => (a.on < b.on ? -1 : 1));
  const chDays = [...new Set([...changes.map((c) => c.slice(0, 10)), ...ws.filter((w) => w.parts.includes('batteries')).map((w) => w.on)])].sort();
  const lastReading = rs[rs.length - 1]?.t ?? null;
  return ws.map((w, i) => {
    const t0 = w.on;
    const prevChange = [...chDays].reverse().find((d) => d < t0) ?? null;
    const nextChange = chDays.find((d) => d > t0) ?? null;
    const nextWork = ws[i + 1]?.on ?? null;
    const afterEnd = [nextChange, nextWork].filter(Boolean).sort()[0] ?? '9999-12-31';
    const before = rateOf(rs.filter((r) => r.t.slice(0, 10) >= (prevChange ?? '0000') && r.t.slice(0, 10) < t0), o.top, o.alarmLevel);
    const afterRs = rs.filter((r) => r.t.slice(0, 10) > t0 || (r.t.slice(0, 10) === t0 && !w.parts.includes('batteries'))).filter((r) => r.t.slice(0, 10) < afterEnd);
    const after = rateOf(afterRs, o.top, o.alarmLevel);
    const againInDays = nextChange ? Math.round((ms(nextChange) - ms(t0)) / DAY) : null;
    const alarmsAfter = alarms.filter((a) => a.slice(0, 10) > addDays(t0, 0) && a.slice(0, 10) < afterEnd).length;
    const parts = (w.names ?? w.parts.map(partName)).join(', ') || 'the work';
    const J = (verdict: Verdict, title: string, detail: string, waitUntil: string | null = null): Judged => ({ ...w, verdict, title, detail, before, after, againInDays, alarmsAfter, waitUntil });
    const rate = (x: Rate) => `${x.per30Days.toFixed(2)} V / 30 days${x.lifeDays != null ? ` (a set would last about ${x.lifeDays} days)` : ' (no drop)'}`;
    if (againInDays != null && againInDays < 120)
      return J('draining', `Batteries needed again ${againInDays} days later`, `After ${parts} on ${t0}, the batteries were changed again on ${nextChange}. ${parts} was not the cause, or not the only one.`);
    if (!after) {
      const wait = addDays(t0, 21);
      const covered = lastReading && lastReading.slice(0, 10) > t0;
      return J('waiting', 'Waiting for a lock report after the work', covered
        ? `The lock reports uploaded so far have too few battery readings after ${t0}. Upload a new report of this lock after ${wait} (3 weeks of use or more).`
        : `No lock report covers the time after ${t0} yet. Read the lock and upload its report after ${wait} (3 weeks of use or more).`, wait);
    }
    if (alarmsAfter >= 2 && (after.lifeDays == null || after.lifeDays < 365))
      return J('draining', `Still draining: ${alarmsAfter} battery alarms since`, `Since ${parts} on ${t0}: ${rate(after)}, ${alarmsAfter} battery alarms. ${parts} was not the cause.`);
    if (before && before.per30Days > 0) {
      const ratio = after.per30Days / before.per30Days;
      if (ratio <= 0.5 && (after.lifeDays == null || after.lifeDays >= 180)) return J('fixed', 'Fixed: the batteries now last', `Battery use fell from ${rate(before)} to ${rate(after)} after ${parts} on ${t0}: this work solved it.`);
      if (ratio <= 0.5) return J('better', 'Much better, but a set still would not last', `Battery use fell from ${rate(before)} to ${rate(after)} after ${parts} on ${t0}. Part of the cause is solved; check the next part.`);
      if (ratio <= 0.8) return J('better', 'Better, keep watching', `Battery use fell from ${rate(before)} to ${rate(after)} after ${parts} on ${t0}: an improvement, but check the next part if the set does not last.`);
      if (ratio <= 1.2) return J('same', `No change: ${parts} was not the cause`, `Battery use ${rate(before)} before and ${rate(after)} after ${parts} on ${t0}.`);
      return J('worse', 'Worse since the work', `Battery use rose from ${rate(before)} to ${rate(after)} after ${parts} on ${t0}. Check the work done (fitting, cable, alignment) and the batteries.`);
    }
    if (after.lifeDays == null || after.lifeDays >= 365) return J('ok', 'Batteries fine since the work', `Since ${parts} on ${t0}: ${rate(after)} over ${after.days} days.`);
    if (after.lifeDays < 180) return J('draining', 'Still draining since the work', `Since ${parts} on ${t0}: ${rate(after)}. A good set of industrial alkaline batteries lasts well over a year. ${parts} was not the cause.`);
    return J('watch', 'Watch: shorter than it should be', `Since ${parts} on ${t0}: ${rate(after)} over ${after.days} days. Upload another report in a month to confirm.`);
  });
}

/** Overall state of the lock and the next part to check (elimination method). */
export function nextStep(judged: Judged[], model: string | null, reportSteps: { id: string; suggests: string }[] | null, checks: Record<string, string> | null, drainingNow: boolean) {
  const last = judged[judged.length - 1] ?? null;
  const solved = last && ['fixed', 'ok'].includes(last.verdict);
  const tried = new Set<string>(judged.flatMap((j) => j.parts.map((p) => PARTS.find((x) => x.id === p)?.group).filter((g): g is PartGroup => Boolean(g))));
  // 2.31 Batteries count as tried only once a set of the recommended type (industrial alkaline) was fitted: a lock
  // that drains with batteries of unknown or consumer type gets industrial alkaline first.
  if (!judged.some((j) => j.parts.includes('batteries') && j.batteryType === RECOMMENDED_BATTERY)) tried.delete('batteries');
  const okByCheck = new Set(Object.entries(checks ?? {}).filter(([, v]) => v === 'ok').map(([k]) => k));
  const rank = { likely: 0, possible: 1, unknown: 2, unlikely: 3 } as Record<string, number>;
  const has = new Set(partsFor(model).map((p) => p.group));
  const left = PART_GROUPS.filter((g) => has.has(g.id) && !tried.has(g.id) && !okByCheck.has(g.step))
    .map((g, i) => ({ g, i, s: rank[reportSteps?.find((s) => s.id === g.step)?.suggests ?? 'unknown'] ?? 2 }))
    .sort((a, b) => a.s - b.s || a.i - b.i);
  const partsOf = (g: PartGroup) => partsFor(model).filter((p) => p.group === g).map((p) => p.name);
  const state = last?.verdict === 'waiting' ? 'waiting' : solved ? 'solved' : (last && ['draining', 'same', 'worse', 'watch', 'better'].includes(last.verdict)) || drainingNow ? 'draining' : 'unknown';
  const n = left[0];
  return {
    state,
    next: state === 'solved' || !n ? null : { group: n.g.id, name: n.g.name, why: n.g.why, parts: partsOf(n.g.id), suggestedByReport: (reportSteps?.find((s) => s.id === n.g.step)?.suggests ?? null) },
    tried: PART_GROUPS.filter((g) => tried.has(g.id)).map((g) => g.name),
    remaining: left.map((x) => x.g.name),
  };
}
