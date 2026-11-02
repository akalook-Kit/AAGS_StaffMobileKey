import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, many, one } from '../db.ts';
import { audit } from '../audit.ts';
import { permsIn, requireOperator } from '../auth.ts';
import { forbidden } from '../lib/errors.ts';

/** 2.17 Everyone who may read at least one data set can build charts from it (each data set keeps its own permission). */
const DATA_PERMS = ['reports.read', 'events.read', 'maintenance.read', 'key.read', 'breakfast.read'] as const;
async function requirePerm(req: import('fastify').FastifyRequest, hotelId: string, _perm: 'reports.read') {
  const op = await requireOperator(req);
  if (!op.isPlatformAdmin && !op.roles.has(hotelId)) throw forbidden('You are not a member of this site.');
  const have = permsIn(op, hotelId);
  if (!DATA_PERMS.some((p) => have.has(p))) throw forbidden('Your role cannot read any data for charts.');
  return op;
}
import { datasetCatalog, runReport, type ReportSpec } from '../report-builder.ts';
import { ApiError, notFound } from '../lib/errors.ts';

const P = '/api/v1';
const hid = (req: FastifyRequest) => { const id = (req.params as any).hotelId as string; if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Site'); return id; };
const Spec = z.object({
  dataset: z.string().max(40), groupBy: z.string().max(40), splitBy: z.string().max(40).nullable().optional(), measure: z.string().max(40),
  days: z.number().int().min(1).max(731).default(30), limit: z.number().int().min(1).max(400).default(15),
  filters: z.array(z.object({ dim: z.string().max(40), values: z.array(z.string().max(200)).max(200) })).max(10).default([]),
  chart: z.enum(['bars', 'columns', 'lines', 'table']).default('bars'), sort: z.enum(['value', 'key']).optional(),
});
const Saved = z.object({ name: z.string().trim().min(1).max(80), spec: Spec, pinned: z.boolean().default(false), shared: z.boolean().default(false) });
const csvCell = (v: unknown) => { const s = String(v ?? ''); const t = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

export function reportBuilderRoutes(app: FastifyInstance) {
  const base = `${P}/hotels/:hotelId/insights/builder`;
  app.get(`${base}/catalog`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'reports.read');
    return { datasets: datasetCatalog(permsIn(op, hotelId)) };
  });
  app.post(`${base}/run`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'reports.read');
    return runReport(hotelId, Spec.parse(req.body) as ReportSpec, permsIn(op, hotelId));
  });
  app.post(`${base}/csv`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'reports.read');
    const r = await runReport(hotelId, Spec.parse(req.body) as ReportSpec, permsIn(op, hotelId));
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'report.exported', details: { report: 'builder', dataset: r.dataset.id, rows: r.rows.length } });
    const head = [r.groupBy, ...r.series];
    reply.header('content-type', 'text/csv; charset=utf-8').header('cache-control', 'private, no-store');
    return '﻿' + [head.map(csvCell).join(','), ...r.rows.map((x) => [x.label, ...x.values].map(csvCell).join(','))].join('\r\n');
  });

  // Saved reports: your own, plus those others shared with everyone who can read reports.
  const rbase = `${P}/hotels/:hotelId/insights/reports`;
  app.get(rbase, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'reports.read');
    return many(pool, `SELECT r.id, r.name, r.spec, r.pinned, r.shared, r.created_by = $2 AS mine, o.display_name AS owner, r.updated_at
      FROM insight_reports r JOIN operators o ON o.id=r.created_by WHERE r.hotel_id=$1 AND (r.created_by=$2 OR r.shared) ORDER BY r.pinned DESC, r.position, r.created_at`, [hotelId, op.id]);
  });
  app.post(rbase, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'reports.read');
    const b = Saved.parse(req.body);
    const n = await one(pool, `SELECT count(*)::int AS n FROM insight_reports WHERE hotel_id=$1 AND created_by=$2`, [hotelId, op.id]);
    if (n!.n >= 50) throw new ApiError(409, 'TOO_MANY', 'You have 50 saved reports; delete one first.');
    const r = await one(pool, `INSERT INTO insight_reports (hotel_id, name, spec, pinned, shared, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [hotelId, b.name, b.spec, b.pinned, b.shared, op.id]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'report.saved', targetType: 'report', targetId: r!.id, details: { name: b.name, dataset: b.spec.dataset, shared: b.shared } });
    return { id: r!.id };
  });
  app.put(`${rbase}/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'reports.read');
    const b = Saved.parse(req.body);
    const r = await one(pool, `UPDATE insight_reports SET name=$4, spec=$5, pinned=$6, shared=$7, updated_at=now() WHERE id=$1 AND hotel_id=$2 AND created_by=$3 RETURNING id`,
      [z.string().uuid().parse((req.params as any).id), hotelId, op.id, b.name, b.spec, b.pinned, b.shared]);
    if (!r) throw notFound('Report (only its author can change it)');
    return { ok: true };
  });
  app.delete(`${rbase}/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'reports.read');
    const r = await one(pool, `DELETE FROM insight_reports WHERE id=$1 AND hotel_id=$2 AND created_by=$3 RETURNING name`, [z.string().uuid().parse((req.params as any).id), hotelId, op.id]);
    if (!r) throw notFound('Report (only its author can delete it)');
    return { ok: true };
  });
}
