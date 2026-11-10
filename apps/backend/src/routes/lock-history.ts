import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, many, one, tx } from '../db.ts';
import { audit } from '../audit.ts';
import { permsIn, requireOperator, requirePerm } from '../auth.ts';
import { ApiError, forbidden, notFound } from '../lib/errors.ts';
import { noteChange } from '../battery.ts';
import { siteTz } from '../reports-centre.ts';
import { LOCK_MODELS, lockModelName } from '../lock-report.ts';
import { BATTERY_TYPES, PART_GROUPS, PARTS, RECOMMENDED_BATTERY, isNovel, judgeWorks, nextStep, partName, type Reading, type Work } from '../lock-history.ts';

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

/** Everything known about one lock, with each piece of work judged. */
export async function doorHistory(hotelId: string, doorId: string) {
  const tz = await siteTz(hotelId);
  const door = await one(pool, `SELECT external_id AS id, name, data->>'doorGroup' AS "group", (data->>'online')::boolean AS online FROM resources WHERE hotel_id=$1 AND kind='door' AND external_id=$2`, [hotelId, doorId]);
  const model = (await one(pool, `SELECT model FROM door_lock_models WHERE hotel_id=$1 AND door_id=$2`, [hotelId, doorId]))?.model ?? null;
  const reports = await many(pool, `SELECT id, file_name, period_from, period_to, uploaded_at, lock_model, checks, analysis->'battery' AS battery, analysis->'steps' AS steps, analysis->'verdict' AS verdict
    FROM lock_reports WHERE hotel_id=$1 AND door_id=$2 ORDER BY period_to NULLS FIRST, uploaded_at`, [hotelId, doorId]);
  const workRows = await many(pool, `SELECT w.*, w.done_on::text AS day, o.display_name AS recorded_by FROM lock_work w LEFT JOIN operators o ON o.id=w.created_by WHERE w.hotel_id=$1 AND w.door_id=$2 ORDER BY w.done_on, w.created_at`, [hotelId, doorId]);
  const dbChanges = await many(pool, `SELECT at, source, detail FROM battery_changes WHERE hotel_id=$1 AND door_id=$2 ORDER BY at`, [hotelId, doorId]);
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
  const elimination = nextStep(judged, lockModel, latest?.steps ?? null, checks, drainingNow);
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

  return {
    door: door ? { id: door.id, name: door.name, group: door.group, online: door.online } : { id: doorId, name: doorId, group: null, online: null },
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
      return { ...j, partNames: j.names ?? j.parts.map(partName), otherPart: w.other_part, batteryBrand: w.battery_brand, batteryTypeName: BATTERY_TYPES.find((t) => t.id === w.battery_type)?.name ?? null,
        recordedBy: w.recorded_by, recordedAt: w.created_at };
    }),
    reports: reports.map((r) => ({ id: r.id, fileName: r.file_name, from: r.period_from, to: r.period_to, uploadedAt: r.uploaded_at, verdict: r.verdict })),
    elimination,
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
    const ids = (await many(pool, `SELECT door_id FROM lock_work WHERE hotel_id=$1 UNION SELECT door_id FROM lock_reports WHERE hotel_id=$1
      UNION SELECT door_id FROM battery_changes WHERE hotel_id=$1 GROUP BY door_id HAVING count(*) >= 2`, [hotelId])).map((r) => r.door_id as string);
    const out = []; const detail: Awaited<ReturnType<typeof doorHistory>>[] = [];
    for (const id of ids.slice(0, 300)) {
      const h = await doorHistory(hotelId, id); detail.push(h);
      const last = h.work[h.work.length - 1] ?? null;
      out.push({ doorId: id, doorName: h.door.name, group: h.door.group, lockModel: h.lockModelName, novel: h.novel,
        batteryChanges: h.batteries.count, avgDays: h.batteries.avgDays, daysSinceLast: h.batteries.daysSinceLast, reports: h.reports.length,
        work: h.work.length, lastWork: last ? { on: last.on, parts: last.partNames, verdict: last.verdict, title: last.title } : null,
        state: h.elimination.state, next: h.elimination.next?.name ?? null, notRecommended: h.batteries.notRecommended.length });
    }
    // 2.31 Days a set lasted, by the year the set was fitted, across all locks: shows a site-wide change (a new battery
    // supply, a setting) that no single lock shows.
    const byYear = new Map<string, number[]>();
    for (const d of detail) d.batteries.changes.slice(0, -1).forEach((c, i) => { const y = c.day.slice(0, 4); const v = d.batteries.lastedDays[i]; if (v != null) byYear.set(y, [...(byYear.get(y) ?? []), v]); });
    const median = (a: number[]) => { const x = [...a].sort((p, q) => p - q); const m = Math.floor(x.length / 2); return x.length % 2 ? x[m]! : Math.round((x[m - 1]! + x[m]!) / 2); };
    const years = [...byYear.entries()].sort().map(([year, v]) => ({ year, sets: v.length, medianDays: median(v), shortest: Math.min(...v), longest: Math.max(...v) }));
    const rank: Record<string, number> = { draining: 0, waiting: 1, unknown: 2, solved: 3 };
    return { locks: out.sort((a, b) => (rank[a.state] ?? 2) - (rank[b.state] ?? 2) || b.batteryChanges - a.batteryChanges || a.doorName.localeCompare(b.doorName)), years };
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
      doneBy: z.string().trim().max(80).optional(),
      notes: z.string().trim().max(1000).optional(),
      lockModel: z.enum(LOCK_MODELS.map((m) => m.id) as [string, ...string[]]).optional(),
    }).parse(req.body);
    const tz = await siteTz(hotelId);
    if (b.doneOn > localDay(new Date(Date.now() + 86_400_000), tz)) throw new ApiError(400, 'FUTURE', 'The date of the work is in the future.');
    const parts = [...new Set(b.parts)];
    if (!parts.length && !b.otherPart) throw new ApiError(400, 'NO_PARTS', 'Choose at least one part or check, or describe the other part.');
    if (parts.includes('batteries') && !b.batteryType) throw new ApiError(400, 'BATTERY_TYPE', 'Say which batteries were fitted (industrial alkaline is recommended).');
    const door = await one(pool, `SELECT 1 FROM resources WHERE hotel_id=$1 AND kind='door' AND external_id=$2`, [hotelId, doorId]);
    if (!door && !(await one(pool, `SELECT 1 FROM lock_reports WHERE hotel_id=$1 AND door_id=$2 LIMIT 1`, [hotelId, doorId]))) throw notFound('Door');
    const id = await tx(async (c) => {
      const r = await c.query(`INSERT INTO lock_work (hotel_id, door_id, done_on, parts, other_part, battery_type, battery_brand, done_by, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [hotelId, doorId, b.doneOn, parts.length ? parts : ['other'], b.otherPart || null,
        parts.includes('batteries') ? b.batteryType : null, parts.includes('batteries') ? b.batteryBrand || null : null, b.doneBy || null, b.notes || null, op.id]);
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
