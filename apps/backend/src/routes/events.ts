import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, many, one } from '../db.ts';
import { audit } from '../audit.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { permsIn, requireOperator, requirePerm } from '../auth.ts';
import { CATEGORIES, CATEGORY_LABELS, queryEvents, type Category, type EventClass } from '../event-log.ts';
import { buildReportPdf, hotelHeader, type Tone } from '../pdf.ts';
import { getConfig } from '../hotel-config.ts';

/**
 * Event log (2.6). The list is shown on screen and leaves the platform only as a server-made PDF (no spreadsheet
 * export), recorded with its SHA-256 so a copy can be verified later.
 */
const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Hotel');
  return id;
};
const MAX_DAYS = 366;
const Filter = z.object({
  from: z.coerce.date(), to: z.coerce.date(),
  cls: z.enum(['all', 'entrances', 'errors']).default('all'),
  categories: z.union([z.array(z.enum(CATEGORIES)), z.string()]).optional()
    .transform((v) => { const a = typeof v === 'string' ? v.split(',').filter(Boolean) : v; return a?.length ? (a as Category[]) : null; })
    .refine((a) => !a || a.every((c) => (CATEGORIES as readonly string[]).includes(c)), 'Unknown category'),
  door: z.string().max(120).optional().transform((v) => v || null),
  q: z.string().max(100).optional().transform((v) => v?.trim() || null),
}).refine((f) => f.to > f.from, 'The end must be after the start').refine((f) => f.to.getTime() - f.from.getTime() <= MAX_DAYS * 86400_000, `At most ${MAX_DAYS} days at a time`);

const CLASS_TITLE: Record<EventClass, string> = { all: 'Event log - all events', entrances: 'Event log - entrance events', errors: 'Event log - error events' };
const SEVERITY_LABEL = { error: 'Error', warning: 'Warning', info: '' } as const;

/** Read events or reports: either permission lets someone verify a printed PDF. */
async function requireAny(req: FastifyRequest, hotelId: string, perms: ('events.read' | 'reports.read')[]) {
  const op = await requireOperator(req);
  if (!op.isPlatformAdmin && !op.roles.has(hotelId)) throw forbidden('You are not a member of this hotel.');
  const have = permsIn(op, hotelId);
  if (!perms.some((p) => have.has(p))) throw forbidden(`Missing permission: ${perms.join(' or ')}`);
  return op;
}

export function eventRoutes(app: FastifyInstance) {
  app.get(`${P}/hotels/:hotelId/events`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'events.read');
    const f = Filter.parse(req.query);
    const limit = z.coerce.number().int().min(1).max(2000).default(500).parse((req.query as any).limit);
    const r = await queryEvents(hotelId, { ...f, limit });
    const doors = await many(pool, `SELECT external_id AS id, name, data->>'doorGroup' AS "group" FROM resources WHERE hotel_id=$1 AND kind='door' ORDER BY name`, [hotelId]);
    return { ...r, categories: CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABELS[c] })), doors };
  });

  /** The only way the event log leaves the platform: a PDF made here, with the hotel header on every page. */
  app.post(`${P}/hotels/:hotelId/events/pdf`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'events.read');
    const f = Filter.parse(req.body ?? {});
    const LIMIT = 5000;
    const r = await queryEvents(hotelId, { ...f, limit: LIMIT });
    const { timezone } = await hotelHeader(hotelId);
    const dt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const d = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
    const doorName = f.door ? ((await one(pool, `SELECT name FROM resources WHERE hotel_id=$1 AND kind='door' AND external_id=$2`, [hotelId, f.door]))?.name ?? f.door) : null;
    const selection = [
      `Period: ${d.format(f.from)} to ${d.format(f.to)} (${timezone})`,
      `Events: ${f.cls === 'all' ? 'all events' : f.cls === 'entrances' ? 'entrance events only' : 'error events only (errors and warnings)'}`
        + (f.categories ? ` · types: ${f.categories.map((c) => CATEGORY_LABELS[c]).join(', ')}` : ' · all types')
        + (doorName ? ` · door: ${doorName}` : '') + (f.q ? ` · search: "${f.q}"` : ''),
    ];
    const tones: Tone[] = r.events.map((e) => e.severity === 'error' ? 'error' : e.severity === 'warning' ? 'warning' : e.category === 'entrance' ? 'ok' : null);
    const out = await buildReportPdf({
      hotelId, report: `events-${f.cls}`, title: CLASS_TITLE[f.cls], selection, operatorId: op.id, operatorName: op.displayName,
      summary: [['Shown', String(r.events.length)], ['Entrances', String(r.counts.entrances)], ['Errors and warnings', String(r.counts.errors)], ['All events', String(r.counts.all)]],
      note: r.truncated ? `Only the newest ${LIMIT} of ${r.total} events are printed. Narrow the period or the selection to print the rest.` : null,
      columns: [{ label: 'Time', width: 15 }, { label: 'Type', width: 11 }, { label: 'Event', width: 25 }, { label: 'Door', width: 13 }, { label: 'Person / card', width: 17 }, { label: 'Source', width: 11 }, { label: 'Details', width: 18 }],
      rows: r.events.map((e) => [
        dt.format(new Date(e.at)), [CATEGORY_LABELS[e.category], SEVERITY_LABEL[e.severity]].filter(Boolean).join(' · '), e.event, `${e.door ?? ''}${e.watched ? ` (watched: ${e.watched})` : ''}`,
        [e.person, e.card ? `card ${e.card}` : null].filter(Boolean).join(' · '), e.source, e.detail ?? '',
      ]),
      tones, filters: { ...f, from: f.from.toISOString(), to: f.to.toISOString() },
    });
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'report.printed', targetType: 'report', targetId: out.reportId,
      details: { report: `events-${f.cls}`, rows: r.events.length, pages: out.pages, sha256: out.sha256 } });
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="event-log-${f.cls}-${stamp}.pdf"`)
      .header('cache-control', 'private, no-store').header('x-report-id', out.reportId).header('x-report-sha256', out.sha256);
    return reply.send(out.bytes);
  });

  /** Is this PDF one the platform printed, unchanged? The browser sends only the file's SHA-256, never the file. */
  app.post(`${P}/hotels/:hotelId/reports/verify`, async (req) => {
    const hotelId = hid(req);
    const op = await requireAny(req, hotelId, ['events.read', 'reports.read']);
    const { sha256 } = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/i) }).parse(req.body);
    const p = await one(pool, `SELECT p.id, p.report, p.title, p.rows, p.pages, p.created_at, o.display_name AS printed_by FROM report_prints p LEFT JOIN operators o ON o.id=p.created_by
      WHERE p.hotel_id=$1 AND p.sha256=$2 ORDER BY p.created_at LIMIT 1`, [hotelId, sha256.toLowerCase()]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'report.verified', details: { genuine: Boolean(p), reportId: p?.id ?? null } });
    return p ? { genuine: true, report: { id: p.id, title: p.title, rows: p.rows, pages: p.pages, printedAt: p.created_at, printedBy: p.printed_by } } : { genuine: false };
  });

  app.get(`${P}/hotels/:hotelId/reports/prints`, async (req) => {
    const hotelId = hid(req);
    await requireAny(req, hotelId, ['events.read', 'reports.read']);
    return many(pool, `SELECT p.id, p.title, p.rows, p.pages, p.created_at, o.display_name AS printed_by FROM report_prints p LEFT JOIN operators o ON o.id=p.created_by
      WHERE p.hotel_id=$1 ORDER BY p.created_at DESC LIMIT 50`, [hotelId]);
  });

  /** Header printed on browser-printed reports (Insights): logo, hotel, system number, version. */
  app.get(`${P}/hotels/:hotelId/reports/header`, async (req) => {
    const hotelId = hid(req);
    await requireAny(req, hotelId, ['events.read', 'reports.read']);
    const h = await hotelHeader(hotelId);
    const branding = await getConfig(pool, hotelId, 'branding');
    return { ...h, logo: branding?.logo ?? null };
  });
}
