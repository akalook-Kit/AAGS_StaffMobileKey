import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, many, one, tx } from '../db.ts';
import { audit } from '../audit.ts';
import { requirePerm } from '../auth.ts';
import { ApiError, notFound } from '../lib/errors.ts';
import { binaryWorkbook } from '../vl-reports.ts';
import { analyseLockReport, parseLockReport, type DateOrder } from '../lock-report.ts';

/**
 * 2.18 Lock troubleshooting (Building -> Lock troubleshooting; works with or without battery monitoring). An administrator or the maintenance manager
 * uploads the event report of one lock, checks what was read (step 1, nothing stored), confirms the door (step 2)
 * and gets usage, battery periods and consumption, faults and what to do. Only time, event and card type are kept.
 */
const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Site');
  return id;
};
const Upload = z.object({
  fileName: z.string().trim().min(1).max(200),
  data: z.string().min(4).max(14_000_000),
  dateOrder: z.enum(['MDY', 'DMY', 'YMD']).optional(),
});

function read(b: z.infer<typeof Upload>) {
  const buf = Buffer.from(b.data, 'base64');
  if (binaryWorkbook(buf)) throw new ApiError(400, 'WORKBOOK', 'This is an Excel workbook. Upload the report exactly as Visionline saved it (its .xls reports are text), or in Excel use File → Save As → "Unicode Text (*.txt)".');
  try { return parseLockReport(buf, b.dateOrder as DateOrder | undefined); }
  catch (e) { throw new ApiError(400, 'NOT_A_LOCK_REPORT', (e as Error).message); }
}

async function doorsOf(hotelId: string) {
  return many(pool, `SELECT external_id AS id, name, data->>'doorID' AS no, data->>'doorGroup' AS "group" FROM resources WHERE hotel_id=$1 AND kind='door' AND active ORDER BY name`, [hotelId]);
}

export function lockReportRoutes(app: FastifyInstance) {
  // Step 1: what was read. Nothing is stored.
  app.post(`${P}/hotels/:hotelId/lock-reports/preview`, { bodyLimit: 15 * 1024 * 1024 }, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'battery.manage');
    const p = read(Upload.parse(req.body));
    const a = analyseLockReport(p);
    const doors = await doorsOf(hotelId);
    const top = p.rooms[0]?.room;
    const suggested = top ? doors.find((d) => [d.no, d.name, d.id].map((x) => String(x ?? '')).includes(top)) ?? null : null;
    return {
      events: p.events.length, dateOrder: p.dateOrder, invalidTimes: p.invalidTimes, duplicates: p.duplicates, columns: p.head, doors,
      period: a.period, window: a.window, clockLost: a.clockLost, rooms: p.rooms, suggestedDoor: suggested,
      // A few events to check the dates were read the right way round (no names: they are never read out).
      sample: [...p.events].filter((e) => e.t).sort((x, y) => (x.t! < y.t! ? 1 : -1)).slice(0, 6).map((e) => ({ t: e.t, event: `${e.name} (${String(e.code).padStart(4, '0')})` })),
      findings: a.findings.filter((f) => f.level !== 'info').length,
    };
  });

  // Step 2: confirmed for a door -> analysed and kept.
  app.post(`${P}/hotels/:hotelId/lock-reports`, { bodyLimit: 15 * 1024 * 1024 }, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'battery.manage');
    const b = Upload.extend({ doorId: z.string().trim().min(1).max(100), doorName: z.string().trim().max(120).optional() }).parse(req.body);
    const p = read(b);
    const a = analyseLockReport(p);
    const door = (await doorsOf(hotelId)).find((d) => d.id === b.doorId);
    const doorName = door?.name ?? b.doorName ?? b.doorId;
    const r = await tx(async (c) => {
      const row = await one(c, `INSERT INTO lock_reports (hotel_id, door_id, door_name, file_name, date_order, period_from, period_to, events, analysis, lock_events, uploaded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, uploaded_at`,
        [hotelId, b.doorId, doorName, b.fileName, p.dateOrder, a.period.from, a.period.to, p.events.length, JSON.stringify(a),
          JSON.stringify(p.events.map((e) => [e.t, e.code, e.name, e.mark ? 1 : 0, e.card])), op.id]);
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'lock.report_analysed', targetType: 'door', targetId: b.doorId,
        details: { reportId: row!.id, fileName: b.fileName, events: p.events.length, from: a.period.from, to: a.period.to, findings: a.findings.filter((f) => f.level !== 'info').map((f) => f.title) } });
      return row!;
    });
    return { id: r.id, uploadedAt: r.uploaded_at };
  });

  app.get(`${P}/hotels/:hotelId/lock-reports`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'battery.read');
    const door = z.string().max(100).optional().parse((req.query as any).door);
    const rows = await many(pool, `SELECT r.id, r.door_id, r.door_name, r.file_name, r.period_from, r.period_to, r.events, r.uploaded_at, o.display_name AS uploaded_by,
        r.analysis->'findings' AS findings, r.analysis->'battery'->'avgDropPer30Days' AS avg_drop, r.analysis->'usage'->'perDay' AS per_day
      FROM lock_reports r LEFT JOIN operators o ON o.id=r.uploaded_by WHERE r.hotel_id=$1 AND ($2::text IS NULL OR r.door_id=$2) ORDER BY r.uploaded_at DESC LIMIT 200`, [hotelId, door ?? null]);
    return rows.map((r) => ({
      id: r.id, doorId: r.door_id, doorName: r.door_name, fileName: r.file_name, from: r.period_from, to: r.period_to, events: r.events, uploadedAt: r.uploaded_at, uploadedBy: r.uploaded_by,
      avgDropPer30Days: r.avg_drop, perDay: r.per_day,
      high: (r.findings ?? []).filter((f: any) => f.level === 'high').length, medium: (r.findings ?? []).filter((f: any) => f.level === 'medium').length,
      top: (r.findings ?? []).find((f: any) => f.level !== 'info')?.title ?? null,
    }));
  });

  app.get(`${P}/hotels/:hotelId/lock-reports/:id`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'battery.read');
    const id = z.string().uuid().parse((req.params as any).id);
    const r = await one(pool, `SELECT r.*, o.display_name AS uploader FROM lock_reports r LEFT JOIN operators o ON o.id=r.uploaded_by WHERE r.id=$1 AND r.hotel_id=$2`, [id, hotelId]);
    if (!r) throw notFound('Report');
    const prev = await many(pool, `SELECT id, uploaded_at, analysis->'battery'->'avgDropPer30Days' AS avg_drop, period_to FROM lock_reports WHERE hotel_id=$1 AND door_id=$2 AND id<>$3 ORDER BY uploaded_at DESC LIMIT 5`, [hotelId, r.door_id, id]);
    return {
      id: r.id, doorId: r.door_id, doorName: r.door_name, fileName: r.file_name, dateOrder: r.date_order, uploadedAt: r.uploaded_at, uploadedBy: r.uploader,
      analysis: r.analysis, others: prev.map((x) => ({ id: x.id, uploadedAt: x.uploaded_at, to: x.period_to, avgDropPer30Days: x.avg_drop })),
    };
  });

  app.delete(`${P}/hotels/:hotelId/lock-reports/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'battery.manage');
    const id = z.string().uuid().parse((req.params as any).id);
    const r = await one(pool, `DELETE FROM lock_reports WHERE id=$1 AND hotel_id=$2 RETURNING door_id, file_name`, [id, hotelId]);
    if (!r) throw notFound('Report');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'lock.report_removed', targetType: 'door', targetId: r.door_id, details: { fileName: r.file_name } });
    return { ok: true };
  });
}
