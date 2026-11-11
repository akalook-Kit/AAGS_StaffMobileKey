import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, many, one, tx } from '../db.ts';
import { audit } from '../audit.ts';
import { permsIn, requireOperator, requirePerm } from '../auth.ts';
import { ApiError, forbidden, notFound } from '../lib/errors.ts';
import { noteChange } from '../battery.ts';
import { siteTz } from '../reports-centre.ts';
import { LOCK_MODELS, lockModelName } from '../lock-report.ts';
import { BATTERY_TYPES, PART_GROUPS, PARTS, RECOMMENDED_BATTERY, isNovel, isObservation, judgeWorks, nextStep, partName, type Reading, type Work } from '../lock-history.ts';

/**
 * 2.30 Lock history (Lock troubleshooting → a door): battery changes, work done (parts changed or checked, battery
 * type), and the elimination method judged from the lock reports uploaded after each piece of work.
 */
const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Site');
  return id;
};
const doorParam = (req: FastifyRequest) => z.string().min(1).max(100).parse((req.params as any).doorId);
const localDay = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

async function canWork(req: FastifyRequest, hotelId: string) {
  const op = await requireOperator(req);
  const p = permsIn(op, hotelId);
  if (!p.has('maintenance.work') && !p.has('battery.manage')) throw forbidden('Missing permission: maintenance.work or battery.manage');
  return op;
}

/** 2.32 Load everything for many locks at once (5 queries for the whole hotel, however many locks it has). */
async function loadData(hotelId: string, doorIds: string[] | null) {
  const ids = doorIds ?? null;
  const by = <T extends { door_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { const a = m.get(r.door_id) ?? []; a.push(r); m.set(r.door_id, a); } return m; };
  const doors = await many(pool, `SELECT external_id AS id, name, data->>'doorGroup' AS "group", (data->>'online')::boolean AS online FROM resources WHERE hotel_id=$1 AND kind='door' AND ($2::text[] IS NULL OR external_id = ANY($2))`, [hotelId, ids]);
  const models = await many(pool, `SELECT door_id, model FROM door_lock_models WHERE hotel_id=$1 AND ($2::text[] IS NULL OR door_id = ANY($2))`, [hotelId, ids]);
  const reports = await many(pool, `SELECT id, door_id, file_name, period_from, period_to, uploaded_at, lock_model, checks, analysis->'battery' AS battery, analysis->'steps' AS steps, analysis->'verdict' AS verdict
    FROM lock_reports WHERE hotel_id=$1 AND ($2::text[] IS NULL OR door_id = ANY($2)) ORDER BY period_to NULLS FIRST, uploaded_at`, [hotelId, ids]);
  const work = await many(pool, `SELECT w.*, w.done_on::text AS day, o.display_name AS recorded_by, (SELECT count(*) FROM lock_work_files f WHERE f.work_id=w.id)::int AS files FROM lock_work w LEFT JOIN operators o ON o.id=w.created_by
    WHERE w.hotel_id=$1 AND ($2::text[] IS NULL OR w.door_id = ANY($2)) ORDER BY w.done_on, w.created_at`, [hotelId, ids]);
  const changes = await many(pool, `SELECT door_id, at, source, detail FROM battery_changes WHERE hotel_id=$1 AND ($2::text[] IS NULL OR door_id = ANY($2)) ORDER BY at`, [hotelId, ids]);
  const firmware = await many(pool, `SELECT id, done_on::text AS day, version_from, version_to, doors, notes FROM lock_firmware_events WHERE hotel_id=$1 ORDER BY done_on`, [hotelId]);
  return { firmware, doors: new Map(doors.map((d) => [d.id as string, d])), models: new Map(models.map((m) => [m.door_id as string, m.model as string])), reports: by(reports), work: by(work), changes: by(changes) };
}
type Data = Awaited<ReturnType<typeof loadData>>;

/** Everything known about one lock, with each piece of work judged. */
export async function doorHistory(hotelId: string, doorId: string) {
  return buildHistory(doorId, await loadData(hotelId, [doorId]), await siteTz(hotelId), await siteMedianLife(hotelId));
}

/** 2.34 The floor of a door: its Visionline door group, else the digits of the room number before the last two (804 → 8). */
export function floorOf(name: string, group: string | null | undefined) {
  if (group) return group;
  const m = /^(\d{1,3})\d{2}[A-Za-z]?$/.exec(name.trim());
  return m ? `Floor ${Number(m[1])}` : null;
}
const median = (a: number[]) => { if (!a.length) return null; const x = [...a].sort((p, q) => p - q); const m = Math.floor(x.length / 2); return x.length % 2 ? x[m]! : Math.round((x[m - 1]! + x[m]!) / 2); };

/** 2.34 How long a battery set lasts at this hotel (median over every lock with at least two changes). */
async function siteMedianLife(hotelId: string) {
  const D = await loadData(hotelId, null); const tz = await siteTz(hotelId);
  const all: number[] = [];
  for (const id of new Set([...D.work.keys(), ...D.reports.keys(), ...D.changes.keys()])) all.push(...buildHistory(id, D, tz, null).batteries.lastedDays);
  return median(all);
}

function buildHistory(doorId: string, D: Data, tz: string, siteLife: number | null) {
  const door = D.doors.get(doorId) ?? null;
  const model = D.models.get(doorId) ?? null;
  const reports = D.reports.get(doorId) ?? [];
  const allRows = D.work.get(doorId) ?? [];
  // 2.34 What was only seen or measured (a problem on a day, a voltage) is not work: it is not judged as a part.
  const workRows = allRows.filter((w) => w.parts.some((p: string) => !isObservation(p)));
  const seenRows = allRows.filter((w) => !w.parts.some((p: string) => !isObservation(p)));
  const dbChanges = D.changes.get(doorId) ?? [];
  const lockModel = model ?? [...reports].reverse().find((r) => r.lock_model)?.lock_model ?? null;

  const readings: Reading[] = reports.flatMap((r) => (r.battery?.readings ?? []) as Reading[]);
  const alarms: string[] = reports.flatMap((r) => ((r.battery?.alarms ?? []) as { t: string }[]).map((a) => a.t));
  const latest = reports[reports.length - 1] ?? null;
  const scaleHigh = latest?.battery?.scale === '6-9 V';
  const top = scaleHigh ? 9.0 : 4.8, alarmLevel = Number(latest?.battery?.alarmLevel ?? (scaleHigh ? 7.2 : 4.0));

  // Battery changes: from Visionline (live events), from the lock reports and from the work recorded; one per day.
  const changes = new Map<string, { day: string; sources: Set<string>; batteryType: string | null; brand: string | null }>();
  const addChange = (day: string, source: string, type: string | null = null, brand: string | null = null) => {
    const c = changes.get(day) ?? { day, sources: new Set<string>(), batteryType: null, brand: null };
    c.sources.add(source); if (type) c.batteryType = type; if (brand) c.brand = brand; changes.set(day, c);
  };
  for (const c of dbChanges) addChange(localDay(new Date(c.at), tz), c.source === 'maintenance' ? 'work recorded' : c.source === 'event' ? 'Visionline (battery exchanged)' : 'Visionline (level rose)');
  for (const r of reports) for (const x of (r.battery?.exchanges ?? []) as { t: string; how: string }[]) addChange(x.t.slice(0, 10), `lock report ${r.file_name}`);
  for (const w of workRows) if (w.parts.includes('batteries')) addChange(w.day, 'work recorded', w.battery_type, w.battery_brand);
  const changeList = [...changes.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  const lasted = changeList.slice(1).map((c, i) => Math.round((Date.parse(c.day) - Date.parse(changeList[i]!.day)) / 86_400_000));

  const works: Work[] = workRows.map((w) => ({ id: w.id, on: w.day, parts: w.parts, names: w.parts.map((p: string) => (p === 'other' ? w.other_part ?? 'other part' : partName(p))), batteryType: w.battery_type, notes: w.notes, by: w.done_by }));
  const today = localDay(new Date(), tz);
  const judged = judgeWorks(works, readings, changeList.map((c) => c.day), alarms, { top, alarmLevel, today });
  const est = latest?.battery?.estimatedDaysPerSet as number | null | undefined;
  const recentAlarms = alarms.filter((a) => a.slice(0, 10) >= localDay(new Date(Date.now() - 45 * 86_400_000), tz)).length;
  const drainingNow = (est != null && est < 180) || recentAlarms >= 2 || (lasted.length > 0 && lasted[lasted.length - 1]! < 180);
  const checks = latest ? Object.fromEntries(Object.entries(latest.checks ?? {}).map(([k, v]: [string, any]) => [k, v?.result])) : null;
  // 2.32 Firmware upgrades that concern this lock, and how long its battery sets lasted before and after each.
  const fw = D.firmware.filter((f) => !f.doors || f.doors.includes(doorId)).map((f) => {
    const before = changeList.slice(0, -1).map((c, i) => ({ day: c.day, d: lasted[i]! })).filter((x) => x.day < f.day);
    const after = changeList.slice(0, -1).map((c, i) => ({ day: c.day, d: lasted[i]! })).filter((x) => x.day >= f.day);
    const med = (a: number[]) => { if (!a.length) return null; const x = [...a].sort((p, q) => p - q); const m = Math.floor(x.length / 2); return x.length % 2 ? x[m]! : Math.round((x[m - 1]! + x[m]!) / 2); };
    return { id: f.id, day: f.day, from: f.version_from, to: f.version_to, notes: f.notes, beforeMedian: med(before.map((x) => x.d)), beforeSets: before.length, afterMedian: med(after.map((x) => x.d)), afterSets: after.length };
  });
  const firmwareWorks = workRows.filter((w) => w.firmware_version).map((w) => ({ on: w.day, version: w.firmware_version }));

  // A firmware upgrade after which this lock's sets last half as long or less makes the electronics/firmware step
  // "likely", ahead of parts that do not explain it.
  const fwDrop = fw.find((f) => f.beforeMedian && f.afterMedian != null && f.afterMedian <= f.beforeMedian * 0.5) ?? null;
  const steps = [...((latest?.steps ?? []) as { id: string; suggests: string }[]).filter((x) => !(fwDrop && x.id === 'electronics')), ...(fwDrop ? [{ id: 'electronics', suggests: 'likely' }] : [])];
  const elimination = nextStep(judged, lockModel, steps.length ? steps : null, checks, drainingNow);
  const notRecommended = workRows.filter((w) => w.parts.includes('batteries') && w.battery_type && w.battery_type !== RECOMMENDED_BATTERY)
    .map((w) => ({ on: w.day, type: BATTERY_TYPES.find((t) => t.id === w.battery_type)?.name ?? w.battery_type, brand: w.battery_brand }));

  // 2.31 Every battery set seen in the lock reports (newest report wins for the same set), with the work done when it
  // was fitted (within 3 days): how long it lasted, use, days to each level, first alarm, restarts, card errors.
  const setMap = new Map<string, any>();
  for (const r of reports) for (const p of (r.battery?.periods ?? []) as any[]) if (p.startedBy !== 'report') setMap.set(p.from.slice(0, 10), p);
  const sets = [...setMap.values()].sort((a, b) => (a.from < b.from ? -1 : 1)).map((p, i, arr) => {
    const d0 = Date.parse(`${p.from.slice(0, 10)}T00:00:00Z`);
    const near = workRows.filter((w) => Math.abs(Date.parse(`${w.day}T00:00:00Z`) - d0) <= 3 * 86_400_000);
    return { from: p.from, to: p.to, days: p.days, finished: i < arr.length - 1 || p.to < (latest?.period_to ?? ''), openingsPerDay: p.openingsPerDay ?? null, perThousand: p.dropPer1000Openings, per30: p.dropPer30Days,
      reached: p.reached, firstAlarmDays: p.firstAlarmDays ?? null, alarms: p.alarms, firmwareAlarms: p.firmwareAlarms, restarts: p.restarts ?? null, cardErrors: p.cardErrors ?? null,
      internalErrors: p.internalErrors ?? null, deadbolt: p.deadbolt ?? null,
      work: near.map((w) => ({ id: w.id, on: w.day, parts: w.parts.map((x: string) => (x === 'other' ? w.other_part ?? 'other part' : partName(x))) })) };
  });

  // 2.32 What to do next on this lock, in order (the To do list of the hotel is made of these).
  const plan: { kind: 'read' | 'batteries' | 'check' | 'report' | 'record' | 'firmware'; priority: number; title: string; detail: string; due: string | null }[] = [];
  const lastJ = judged[judged.length - 1] ?? null;
  const industrialFitted = workRows.some((w) => w.parts.includes('batteries') && w.battery_type === RECOMMENDED_BATTERY);
  const minNew = scaleHigh ? 8.7 : 4.6;
  if (lastJ?.verdict === 'waiting' && lastJ.waitUntil) {
    const late = lastJ.waitUntil <= today;
    plan.push({ kind: 'read', priority: late ? 1 : 6, title: late ? 'Read the lock and upload its report' : `Read the lock after ${lastJ.waitUntil}`, due: lastJ.waitUntil,
      detail: `To see whether the work of ${lastJ.on} (${(lastJ.names ?? lastJ.parts).join(', ')}) solved it.` });
  } else if (elimination.state === 'draining') {
    if (!industrialFitted) plan.push({ kind: 'batteries', priority: 2, title: 'Fit industrial alkaline AA batteries', due: null,
      detail: `Measure the new pack before fitting (${scaleHigh ? 'about 9 V' : 'about 4.8 V for 3 fresh cells'}; under ${minNew} V = old or weak stock), record the brand and batch, then read the lock 3 weeks later.` });
    else if (elimination.next) plan.push({ kind: 'check', priority: 3, title: `Check: ${elimination.next.name}`, detail: elimination.next.parts.join(' · '), due: null });
  }
  if (fwDrop) plan.push({ kind: 'firmware', priority: 2, due: null, title: `Firmware: sets last ${fwDrop.afterMedian} days since the upgrade of ${fwDrop.day} (${fwDrop.beforeMedian} before)`,
    detail: `Give ASSA ABLOY (or your reseller)${fwDrop.from || fwDrop.to ? ` the firmware versions (${fwDrop.from ?? 'before: not recorded'} → ${fwDrop.to ?? 'after: not recorded'}),` : ' the firmware version of the lock (read it with the service device),'} the upgrade date and these battery sets, and ask whether this version drains batteries on ${lockModelName(lockModel) ?? 'this lock model'} and which version fixes it.` });
  const latestTo = latest?.period_to ? String(latest.period_to instanceof Date ? latest.period_to.toISOString() : latest.period_to).slice(0, 10) : null;
  if (elimination.state === 'draining' && lastJ?.verdict !== 'waiting' && (!latestTo || Date.parse(today) - Date.parse(latestTo) > 60 * 86_400_000))
    plan.push({ kind: 'report', priority: 4, title: 'Upload a recent report of this lock', detail: latestTo ? `The newest report ends on ${latestTo}.` : 'No lock report yet.', due: null });
  const since = localDay(new Date(Date.now() - 180 * 86_400_000), tz);
  const unrecorded = changeList.filter((c) => c.day >= since && !c.sources.has('work recorded'));
  if (unrecorded.length) plan.push({ kind: 'record', priority: 5, title: `Record what was done at ${unrecorded.length} battery change(s)`, due: null,
    detail: `Seen in Visionline or the lock report but not recorded: ${unrecorded.map((c) => c.day).join(', ')}. Add them from the paper log (batteries, and any part changed).` });
  // 2.34 The batteries dropped again (a problem seen, a new battery change soon after the work, or new battery alarms)
  // since the last part changed: ask for the latest lock report first, then the next part (LCA / LCU swapped with a
  // lock that works).
  const lastPartDay = workRows.filter((w) => w.parts.some((p: string) => !['batteries'].includes(p))).map((w) => w.day as string).sort().pop() ?? null;
  const issues = seenRows.filter((w) => w.parts.includes('issue-reported')).map((w) => ({ id: w.id as string, on: w.day as string, notes: w.notes as string | null, by: w.done_by as string | null }));
  const dropSince = issues.filter((i) => !lastPartDay || i.on >= lastPartDay).map((i) => i.on);
  const changedAgain = lastJ?.verdict === 'draining' && lastJ.againInDays != null ? [lastJ.on] : [];
  const reportAfterDrop = (d: string) => Boolean(latestTo && latestTo >= d);
  const dropDay = [...dropSince, ...changedAgain].sort().pop() ?? null;
  if (dropDay && !reportAfterDrop(dropDay) && !plan.some((x) => x.kind === 'read' && x.priority === 1))
    plan.push({ kind: 'report', priority: 1, due: today, title: 'Upload the latest report of this lock',
      detail: `The batteries dropped again (${dropSince.length ? `problem seen on ${dropSince[dropSince.length - 1]}` : `batteries changed again after the work of ${lastJ!.on}`}). Read the lock, save its events from Visionline and upload them: if the report shows the drop, change the next part.` });
  const nextG = elimination.next?.group;
  if (elimination.state === 'draining' && (nextG === 'lca' || nextG === 'lcu') && (!dropDay || reportAfterDrop(dropDay)))
    plan.push({ kind: 'check', priority: 3, due: null, title: `Swap the ${nextG.toUpperCase()} with a lock that works`,
      detail: `${nextG === 'lca' ? 'LCA (lock case adapter)' : 'LCU (lock controller unit)'}: take it from a lock whose batteries last, fit it here (and this one there), record the door it came from, and monitor both locks for 3 weeks.` });
  for (let i = plan.length - 1; i >= 0; i--) if (plan[i]!.kind === 'check' && plan[i]!.title.startsWith('Check:') && (nextG === 'lca' || nextG === 'lcu') && plan.some((x) => x.title.startsWith('Swap'))) plan.splice(i, 1);
  plan.sort((a, b) => a.priority - b.priority);

  // 2.34 When the batteries are expected to be low if nothing changes: the last battery change + how long a set lasts
  // on this lock (its own sets), else the estimate of its latest report, else the hotel's usual set.
  const lastChange = changeList[changeList.length - 1]?.day ?? null;
  const ownLife = median(lasted);
  const life = ownLife ?? (est != null && est > 0 ? Math.round(est) : null) ?? siteLife;
  const basis = ownLife != null ? 'this lock' : est != null && est > 0 ? 'lock report' : siteLife != null ? 'hotel' : null;
  const lowOn = lastChange && life != null ? new Date(Date.parse(`${lastChange}T00:00:00Z`) + life * 86_400_000).toISOString().slice(0, 10) : null;
  const forecast = { lastChange, expectedLifeDays: life, basis, expectedLowOn: lowOn,
    daysLeft: lowOn ? Math.round((Date.parse(`${lowOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null };
  const measures = allRows.filter((w) => w.volts_idle != null || w.volts_loaded != null || w.volts_before != null || w.volts_after != null)
    .map((w) => ({ on: w.day as string, idle: w.volts_idle != null ? Number(w.volts_idle) : null, loaded: w.volts_loaded != null ? Number(w.volts_loaded) : null,
      before: w.volts_before != null ? Number(w.volts_before) : null, after: w.volts_after != null ? Number(w.volts_after) : null }));
  const weakPacks = workRows.filter((w) => w.parts.includes('batteries') && w.volts_after != null && Number(w.volts_after) < minNew).map((w) => ({ on: w.day, volts: Number(w.volts_after) }));

  return {
    door: door ? { id: door.id, name: door.name, group: door.group, online: door.online, floor: floorOf(door.name, door.group) } : { id: doorId, name: doorId, group: null, online: null, floor: floorOf(doorId, null) },
    lockModel, lockModelName: lockModelName(lockModel), novel: isNovel(lockModel), timezone: tz,
    batteries: {
      changes: changeList.map((c) => ({ day: c.day, sources: [...c.sources], batteryType: c.batteryType, batteryTypeName: BATTERY_TYPES.find((t) => t.id === c.batteryType)?.name ?? null, brand: c.brand })),
      count: changeList.length, lastedDays: lasted, avgDays: lasted.length ? Math.round(lasted.reduce((s, x) => s + x, 0) / lasted.length) : null,
      daysSinceLast: changeList.length ? Math.round((Date.parse(today) - Date.parse(changeList[changeList.length - 1]!.day)) / 86_400_000) : null,
      recommended: BATTERY_TYPES.find((t) => t.id === RECOMMENDED_BATTERY)!.name, notRecommended,
      estimatedDaysPerSet: est ?? null, avgDropPer30Days: latest?.battery?.avgDropPer30Days ?? null, scale: { top, alarmLevel },
    },
    sets,
    readings: [...new Map(readings.map((r) => [r.t, r])).values()].sort((a, b) => (a.t < b.t ? -1 : 1)),
    work: judged.map((j) => {
      const w = workRows.find((x) => x.id === j.id)!;
      return { ...j, partNames: j.names ?? j.parts.map(partName), otherPart: w.other_part, batteryBrand: w.battery_brand, batteryBatch: w.battery_batch,
        voltsBefore: w.volts_before != null ? Number(w.volts_before) : null, voltsAfter: w.volts_after != null ? Number(w.volts_after) : null, batteryTypeName: BATTERY_TYPES.find((t) => t.id === w.battery_type)?.name ?? null,
        recordedBy: w.recorded_by, recordedAt: w.created_at, voltsIdle: w.volts_idle != null ? Number(w.volts_idle) : null, voltsLoaded: w.volts_loaded != null ? Number(w.volts_loaded) : null,
        swappedFrom: w.swapped_from ?? null, files: Number(w.files ?? 0) };
    }),
    reports: reports.map((r) => ({ id: r.id, fileName: r.file_name, from: r.period_from, to: r.period_to, uploadedAt: r.uploaded_at, verdict: r.verdict })),
    elimination, plan, weakPacks, firmware: fw, firmwareSeen: firmwareWorks,
    forecast, issues, measures,
    seen: seenRows.map((w) => ({ id: w.id as string, on: w.day as string, parts: w.parts as string[], partNames: (w.parts as string[]).map(partName), notes: w.notes as string | null, by: w.done_by as string | null,
      voltsIdle: w.volts_idle != null ? Number(w.volts_idle) : null, voltsLoaded: w.volts_loaded != null ? Number(w.volts_loaded) : null, recordedBy: w.recorded_by as string | null, files: Number(w.files ?? 0) })),
  };
}

export function lockHistoryRoutes(app: FastifyInstance) {
  /** The catalogue: lock models, parts (Novel ones apart), battery types, elimination order. */
  app.get(`${P}/hotels/:hotelId/lock-history/catalogue`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'battery.read');
    return { models: LOCK_MODELS, parts: PARTS, groups: PART_GROUPS, batteryTypes: BATTERY_TYPES, recommended: RECOMMENDED_BATTERY };
  });

  /** Every lock with a history: battery changes, work, reports; state and next step. */
  app.get(`${P}/hotels/:hotelId/lock-history`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'battery.read');
    // 2.34 ?all=1: every door of the hotel (the lock register), not only the locks with a history.
    const all = (req.query as any)?.all === '1';
    const D = await loadData(hotelId, null);
    const tz = await siteTz(hotelId);
    const counted = new Map<string, number>(); for (const [id, ch] of D.changes) counted.set(id, ch.length);
    const ids = [...new Set([...D.work.keys(), ...D.reports.keys(), ...[...counted.entries()].filter(([, n]) => n >= (all ? 1 : 2)).map(([id]) => id), ...(all ? D.doors.keys() : [])])].slice(0, 3000);
    const out = []; const detail: ReturnType<typeof buildHistory>[] = [];
    const siteLife = median(ids.flatMap((id) => buildHistory(id, D, tz, null).batteries.lastedDays));
    for (const id of ids) {
      const h = buildHistory(id, D, tz, siteLife); detail.push(h);
      const last = h.work[h.work.length - 1] ?? null;
      out.push({ doorId: id, doorName: h.door.name, group: h.door.group, floor: h.door.floor, online: h.door.online, lockModel: h.lockModelName, lockModelId: h.lockModel, novel: h.novel,
        forecast: h.forecast, lastIssue: h.issues[h.issues.length - 1] ?? null, lastChange: h.batteries.changes[h.batteries.changes.length - 1]?.day ?? null,
        batteryChanges: h.batteries.count, avgDays: h.batteries.avgDays, lastSetDays: h.batteries.lastedDays[h.batteries.lastedDays.length - 1] ?? null, daysSinceLast: h.batteries.daysSinceLast, reports: h.reports.length,
        work: h.work.length, lastWork: last ? { on: last.on, parts: last.partNames, verdict: last.verdict, title: last.title } : null,
        state: h.elimination.state, next: h.elimination.next?.name ?? null, notRecommended: h.batteries.notRecommended.length, plan: h.plan });
    }
    // 2.31 Days a set lasted, by the year the set was fitted, across all locks: shows a site-wide change (a new battery
    // supply, a setting) that no single lock shows.
    const byYear = new Map<string, number[]>();
    for (const d of detail) d.batteries.changes.slice(0, -1).forEach((c, i) => { const y = c.day.slice(0, 4); const v = d.batteries.lastedDays[i]; if (v != null) byYear.set(y, [...(byYear.get(y) ?? []), v]); });
    const years = [...byYear.entries()].sort().map(([year, v]) => ({ year, sets: v.length, medianDays: median(v)!, shortest: Math.min(...v), longest: Math.max(...v) }));
    // Firmware upgrades: days a set lasted (all locks concerned) before and after each upgrade.
    const firmware = D.firmware.map((f) => {
      const before: number[] = [], after: number[] = [];
      for (const d of detail) { if (f.doors && !f.doors.includes(d.door.id)) continue; d.batteries.changes.slice(0, -1).forEach((c, i) => { const v = d.batteries.lastedDays[i]; if (v != null) (c.day < f.day ? before : after).push(v); }); }
      const b = median(before), a = median(after);
      return { id: f.id, day: f.day, from: f.version_from, to: f.version_to, scope: f.doors ? `${f.doors.length} lock(s)` : 'all locks', notes: f.notes,
        beforeMedian: b, beforeSets: before.length, afterMedian: a, afterSets: after.length, drop: b && a ? Math.round((1 - a / b) * 100) : null };
    });
    const rank: Record<string, number> = { draining: 0, waiting: 1, unknown: 2, solved: 3 };
    const counts = { draining: 0, waiting: 0, solved: 0, unknown: 0 } as Record<string, number>;
    for (const o of out) counts[o.state] = (counts[o.state] ?? 0) + 1;
    return { locks: out.sort((a, b) => (rank[a.state] ?? 2) - (rank[b.state] ?? 2) || (a.plan[0]?.priority ?? 9) - (b.plan[0]?.priority ?? 9) || b.batteryChanges - a.batteryChanges || a.doorName.localeCompare(b.doorName, undefined, { numeric: true })),
      years, counts, total: ids.length, firmware, siteLifeDays: siteLife, today: localDay(new Date(), tz) };
  });

  app.get(`${P}/hotels/:hotelId/lock-history/:doorId`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'battery.read');
    return doorHistory(hotelId, doorParam(req));
  });

  /** Record work done on the lock (parts changed or checked; batteries and their type). */
  app.post(`${P}/hotels/:hotelId/lock-history/:doorId/work`, async (req) => {
    const hotelId = hid(req);
    const op = await canWork(req, hotelId);
    const doorId = doorParam(req);
    const b = z.object({
      doneOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      parts: z.array(z.enum(PARTS.map((p) => p.id) as [string, ...string[]])).min(0).max(30),
      otherPart: z.string().trim().max(120).optional(),
      batteryType: z.enum(BATTERY_TYPES.map((t) => t.id) as [string, ...string[]]).optional(),
      batteryBrand: z.string().trim().max(60).optional(),
      batteryBatch: z.string().trim().max(60).optional(),
      voltsBefore: z.number().min(0).max(12).optional(),
      voltsAfter: z.number().min(0).max(12).optional(),
      /** 2.34 The pack at rest and under load (the motor turning), and the door a part was swapped from. */
      voltsIdle: z.number().min(0).max(12).optional(),
      voltsLoaded: z.number().min(0).max(12).optional(),
      swappedFrom: z.string().trim().max(100).optional(),
      firmwareVersion: z.string().trim().max(40).optional(),
      doneBy: z.string().trim().max(80).optional(),
      notes: z.string().trim().max(1000).optional(),
      lockModel: z.enum(LOCK_MODELS.map((m) => m.id) as [string, ...string[]]).optional(),
    }).parse(req.body);
    const tz = await siteTz(hotelId);
    if (b.doneOn > localDay(new Date(Date.now() + 86_400_000), tz)) throw new ApiError(400, 'FUTURE', 'The date of the work is in the future.');
    const parts = [...new Set(b.parts)];
    if (!parts.length && !b.otherPart) throw new ApiError(400, 'NO_PARTS', 'Choose at least one part or check, or describe the other part.');
    if (parts.includes('batteries') && !b.batteryType) throw new ApiError(400, 'BATTERY_TYPE', 'Say which batteries were fitted (industrial alkaline is recommended).');
    if (parts.includes('measured') && b.voltsIdle == null && b.voltsLoaded == null) throw new ApiError(400, 'NO_VOLTS', 'Enter the voltage measured at rest or under load.');
    if (b.voltsIdle != null && b.voltsLoaded != null && b.voltsLoaded > b.voltsIdle + 0.2) throw new ApiError(400, 'VOLTS', 'Under load the voltage is lower than at rest: check the two readings.');
    const door = await one(pool, `SELECT 1 FROM resources WHERE hotel_id=$1 AND kind='door' AND external_id=$2`, [hotelId, doorId]);
    if (!door && !(await one(pool, `SELECT 1 FROM lock_reports WHERE hotel_id=$1 AND door_id=$2 LIMIT 1`, [hotelId, doorId]))) throw notFound('Door');
    const id = await tx(async (c) => {
      const r = await c.query(`INSERT INTO lock_work (hotel_id, door_id, done_on, parts, other_part, battery_type, battery_brand, battery_batch, volts_before, volts_after, done_by, notes, created_by, firmware_version, volts_idle, volts_loaded, swapped_from)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`, [hotelId, doorId, b.doneOn, parts.length ? parts : ['other'], b.otherPart || null,
        parts.includes('batteries') ? b.batteryType : null, parts.includes('batteries') ? b.batteryBrand || null : null, parts.includes('batteries') ? b.batteryBatch || null : null,
        b.voltsBefore ?? null, b.voltsAfter ?? null, b.doneBy || null, b.notes || null, op.id, b.firmwareVersion || null, b.voltsIdle ?? null, b.voltsLoaded ?? null,
        parts.some((p) => ['lca', 'lcu', 'classic-lockcase', 'lockcase', 'door-unit', 'reader', 'novel-inside', 'novel-reader'].includes(p)) ? b.swappedFrom || null : null]);
      if (b.lockModel) await c.query(`INSERT INTO door_lock_models (hotel_id, door_id, model, updated_by) VALUES ($1,$2,$3,$4)
        ON CONFLICT (hotel_id, door_id) DO UPDATE SET model=EXCLUDED.model, updated_by=EXCLUDED.updated_by, updated_at=now()`, [hotelId, doorId, b.lockModel, op.id]);
      // New batteries also count as a battery change of the door (Battery status and the battery sets use it).
      if (parts.includes('batteries')) {
        const at = new Date(`${b.doneOn}T12:00:00Z`);
        await noteChange(c, hotelId, doorId, at, 'maintenance', `New batteries recorded in the lock history (${BATTERY_TYPES.find((t) => t.id === b.batteryType)?.name ?? 'type not given'})`);
      }
      return r.rows[0].id as string;
    });
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'lock.work_recorded', targetType: 'door', targetId: doorId, details: { id, doneOn: b.doneOn, parts, batteryType: b.batteryType ?? null } });
    return { id };
  });

  // ---- 2.34 Photos and screenshots of a piece of work (paper log, multimeter, battery holder, Visionline) ----------
  app.post(`${P}/hotels/:hotelId/lock-history/:doorId/work/:id/files`, { bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const hotelId = hid(req);
    const op = await canWork(req, hotelId);
    const doorId = doorParam(req);
    const id = z.string().uuid().parse((req.params as any).id);
    const b = z.object({ name: z.string().trim().min(1).max(160), dataUrl: z.string().max(4_300_000) }).parse(req.body);
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.dataUrl);
    if (!m) throw new ApiError(400, 'FILE_TYPE', 'Attach a photo or screenshot (PNG, JPEG or WebP).');
    const buf = Buffer.from(m[2]!, 'base64');
    if (!buf.length || buf.length > 3 * 1024 * 1024) throw new ApiError(400, 'FILE_SIZE', 'A photo can be up to 3 MB.');
    const sig = buf.subarray(0, 12);
    const okSig = m[1] === 'image/png' ? sig[0] === 0x89 && sig[1] === 0x50 : m[1] === 'image/jpeg' ? sig[0] === 0xff && sig[1] === 0xd8 : sig.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!okSig) throw new ApiError(400, 'FILE_TYPE', 'This file is not a valid image.');
    const w = await one(pool, `SELECT 1 FROM lock_work WHERE id=$1 AND hotel_id=$2 AND door_id=$3`, [id, hotelId, doorId]);
    if (!w) throw notFound('Work');
    const n = await one(pool, `SELECT count(*)::int AS n FROM lock_work_files WHERE work_id=$1`, [id]);
    if ((n?.n ?? 0) >= 6) throw new ApiError(409, 'TOO_MANY_FILES', 'Up to 6 photos per entry.');
    const r = await one(pool, `INSERT INTO lock_work_files (hotel_id, work_id, file_name, mime, bytes, data, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [hotelId, id, b.name, m[1], buf.length, buf, op.id]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'lock.work_file_added', targetType: 'door', targetId: doorId, details: { work: id, name: b.name, bytes: buf.length } });
    return { id: r!.id };
  });
  app.get(`${P}/hotels/:hotelId/lock-history/:doorId/work/:id/files`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'battery.read');
    const id = z.string().uuid().parse((req.params as any).id);
    return { files: await many(pool, `SELECT f.id, f.file_name AS name, f.mime, f.bytes, f.created_at FROM lock_work_files f JOIN lock_work w ON w.id=f.work_id WHERE f.work_id=$1 AND f.hotel_id=$2 AND w.door_id=$3 ORDER BY f.created_at`, [id, hotelId, doorParam(req)]) };
  });
  app.get(`${P}/hotels/:hotelId/lock-history/:doorId/work/:id/files/:fileId`, async (req, reply) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'battery.read');
    const f = await one(pool, `SELECT f.mime, f.data, f.file_name FROM lock_work_files f JOIN lock_work w ON w.id=f.work_id WHERE f.id=$1 AND f.work_id=$2 AND f.hotel_id=$3 AND w.door_id=$4`,
      [z.string().uuid().parse((req.params as any).fileId), z.string().uuid().parse((req.params as any).id), hotelId, doorParam(req)]);
    if (!f) throw notFound('File');
    reply.header('content-type', f.mime).header('cache-control', 'private, max-age=3600').header('x-content-type-options', 'nosniff')
      .header('content-disposition', `inline; filename="${String(f.file_name).replace(/[^\w. -]/g, '_')}"`);
    return reply.send(f.data);
  });

  /**
   * 2.34 The day report (Armel: "a report at the end of the day"): what was done on which lock and floor, the battery
   * changes, the problems seen, and the locks to prepare (low batteries expected soon), for one day or a period.
   */
  app.get(`${P}/hotels/:hotelId/lock-history/day-report`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'battery.read');
    const tz = await siteTz(hotelId);
    const today = localDay(new Date(), tz);
    const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(today), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), soonDays: z.coerce.number().int().min(1).max(60).default(7) }).parse(req.query);
    const to = q.to ?? q.from;
    if (to < q.from) throw new ApiError(400, 'RANGE', 'The end must not be before the start');
    if (Date.parse(to) - Date.parse(q.from) > 93 * 86_400_000) throw new ApiError(400, 'RANGE', 'At most 93 days at a time');
    const D = await loadData(hotelId, null);
    const ids = [...new Set([...D.work.keys(), ...D.reports.keys(), ...D.changes.keys()])];
    const siteLife = median(ids.flatMap((id) => buildHistory(id, D, tz, null).batteries.lastedDays));
    const hs = ids.map((id) => buildHistory(id, D, tz, siteLife));
    const inRange = (d: string | null | undefined) => Boolean(d && d >= q.from && d <= to);
    const entries: any[] = [];
    for (const h of hs) {
      const rows = (D.work.get(h.door.id) ?? []).filter((w) => inRange(w.day));
      for (const w of rows) entries.push({ on: w.day, doorId: h.door.id, door: h.door.name, floor: h.door.floor, model: h.lockModelName,
        kind: w.parts.every((p: string) => isObservation(p)) ? (w.parts.includes('issue-reported') ? 'problem' : 'measured') : 'work',
        parts: (w.parts as string[]).map((p) => (p === 'other' ? w.other_part ?? 'other part' : partName(p))),
        batteries: w.parts.includes('batteries') ? BATTERY_TYPES.find((t) => t.id === w.battery_type)?.name ?? null : null,
        voltsIdle: w.volts_idle != null ? Number(w.volts_idle) : null, voltsLoaded: w.volts_loaded != null ? Number(w.volts_loaded) : null,
        voltsBefore: w.volts_before != null ? Number(w.volts_before) : null, voltsAfter: w.volts_after != null ? Number(w.volts_after) : null,
        swappedFrom: w.swapped_from ?? null, by: w.done_by ?? null, notes: w.notes ?? null, files: Number(w.files ?? 0), state: h.elimination.state });
      for (const c of h.batteries.changes) if (inRange(c.day) && !c.sources.includes('work recorded'))
        entries.push({ on: c.day, doorId: h.door.id, door: h.door.name, floor: h.door.floor, model: h.lockModelName, kind: 'battery-seen', parts: ['Batteries replaced (seen in ' + c.sources.join(', ') + ')'],
          batteries: null, voltsIdle: null, voltsLoaded: null, voltsBefore: null, voltsAfter: null, swappedFrom: null, by: null, notes: 'Not recorded yet: add it from the paper log.', files: 0, state: h.elimination.state });
    }
    entries.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : String(a.floor ?? '').localeCompare(String(b.floor ?? ''), undefined, { numeric: true }) || a.door.localeCompare(b.door, undefined, { numeric: true })));
    const soon = hs.filter((h) => h.forecast.daysLeft != null && h.forecast.daysLeft <= q.soonDays + Math.max(0, Math.round((Date.parse(to) - Date.parse(today)) / 86_400_000)))
      .map((h) => ({ doorId: h.door.id, door: h.door.name, floor: h.door.floor, lastChange: h.forecast.lastChange, expectedLowOn: h.forecast.expectedLowOn, daysLeft: h.forecast.daysLeft, lifeDays: h.forecast.expectedLifeDays, basis: h.forecast.basis, state: h.elimination.state }))
      .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
    const reminders = hs.flatMap((h) => h.plan.filter((p) => p.priority <= 1).map((p) => ({ doorId: h.door.id, door: h.door.name, floor: h.door.floor, title: p.title, detail: p.detail })));
    const states = { draining: 0, waiting: 0, solved: 0, unknown: 0 } as Record<string, number>;
    for (const h of hs) states[h.elimination.state] = (states[h.elimination.state] ?? 0) + 1;
    return { from: q.from, to, today, timezone: tz, entries, soon, reminders, states,
      counts: { work: entries.filter((e) => e.kind === 'work').length, problems: entries.filter((e) => e.kind === 'problem').length, batteries: entries.filter((e) => e.parts.some((p: string) => /^Batteries replaced/.test(p))).length, locks: new Set(entries.map((e) => e.doorId)).size } };
  });

  app.delete(`${P}/hotels/:hotelId/lock-history/:doorId/work/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'battery.manage');
    const doorId = doorParam(req);
    const id = z.string().uuid().parse((req.params as any).id);
    const r = await one(pool, `DELETE FROM lock_work WHERE id=$1 AND hotel_id=$2 AND door_id=$3 RETURNING done_on, parts`, [id, hotelId, doorId]);
    if (!r) throw notFound('Work');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'lock.work_removed', targetType: 'door', targetId: doorId, details: { id, parts: r.parts } });
    return { ok: true };
  });

  /** 2.32 Firmware upgrades of the site's locks (when, versions, all or some locks). */
  app.post(`${P}/hotels/:hotelId/lock-history/firmware`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'battery.manage');
    const b = z.object({ doneOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), versionFrom: z.string().trim().max(40).optional(), versionTo: z.string().trim().max(40).optional(),
      doors: z.array(z.string().min(1).max(100)).max(3000).optional(), notes: z.string().trim().max(1000).optional() }).parse(req.body);
    const r = await one(pool, `INSERT INTO lock_firmware_events (hotel_id, done_on, version_from, version_to, doors, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [hotelId, b.doneOn, b.versionFrom || null, b.versionTo || null, b.doors?.length ? b.doors : null, b.notes || null, op.id]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'lock.firmware_recorded', targetType: 'lock_firmware', targetId: r!.id, details: { doneOn: b.doneOn, to: b.versionTo ?? null, doors: b.doors?.length ?? 'all' } });
    return { id: r!.id };
  });
  app.delete(`${P}/hotels/:hotelId/lock-history/firmware/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'battery.manage');
    const id = z.string().uuid().parse((req.params as any).id);
    const r = await pool.query(`DELETE FROM lock_firmware_events WHERE id=$1 AND hotel_id=$2`, [id, hotelId]);
    if (!r.rowCount) throw notFound('Firmware upgrade');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'lock.firmware_removed', targetType: 'lock_firmware', targetId: id });
    return { ok: true };
  });

  /** The lock model of a door (Novel locks have their own parts). */
  app.put(`${P}/hotels/:hotelId/lock-history/:doorId/model`, async (req) => {
    const hotelId = hid(req);
    const op = await canWork(req, hotelId);
    const doorId = doorParam(req);
    const { model } = z.object({ model: z.enum(LOCK_MODELS.map((m) => m.id) as [string, ...string[]]) }).parse(req.body);
    await pool.query(`INSERT INTO door_lock_models (hotel_id, door_id, model, updated_by) VALUES ($1,$2,$3,$4)
      ON CONFLICT (hotel_id, door_id) DO UPDATE SET model=EXCLUDED.model, updated_by=EXCLUDED.updated_by, updated_at=now()`, [hotelId, doorId, model, op.id]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'lock.model_set', targetType: 'door', targetId: doorId, details: { model } });
    return { ok: true };
  });
}
