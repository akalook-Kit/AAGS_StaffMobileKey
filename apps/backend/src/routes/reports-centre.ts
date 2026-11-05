import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, many, one } from '../db.ts';
import { audit } from '../audit.ts';
import { permsIn, requireOperator, requirePerm } from '../auth.ts';
import { ApiError, forbidden, notFound } from '../lib/errors.ts';
import { buildReportPdf } from '../pdf.ts';
import { channels } from '../monitoring/monitor.ts';
import { sendEmail } from '../monitoring/channels.ts';
import { REPORTS, allowedReport, buildReport, reportCsv, reportDef, reportText, siteName, siteTz, type Period, type ReportOut } from '../reports-centre.ts';

/** 2.27 Reports: list, view, PDF, CSV, e-mail now, and e-mail on a schedule. */
const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Site');
  return id;
};
const Q = z.object({ period: z.enum(['day', 'month']).default('day'), date: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional() });
const Emails = z.array(z.string().trim().email().max(160)).min(1).max(20);

async function access(req: FastifyRequest, hotelId: string, reportId: string) {
  const op = await requireOperator(req);
  if (!op.isPlatformAdmin && !op.roles.has(hotelId)) throw forbidden('You are not a member of this site.');
  const def = reportDef(reportId);
  if (!def) throw notFound('Report');
  if (!allowedReport(def, permsIn(op, hotelId))) throw forbidden(`Missing permission: ${def.perms.join(' or ')}`);
  return { op, def };
}
/** Yesterday (day) or last month (month) in the site's time zone, when no date is given. */
export function defaultDate(period: Period, tz: string, now = new Date()) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  if (period === 'day') return ymd;
  return ymd.slice(0, 7);
}
const previous = (period: Period, tz: string, now = new Date()) => {
  if (period === 'day') return defaultDate('day', tz, new Date(now.getTime() - 86_400_000));
  const [y, m] = defaultDate('month', tz, now).split('-').map(Number);
  return m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, '0')}`;
};

async function pdfOf(hotelId: string, r: ReportOut, operatorId: string | null, operatorName: string) {
  return buildReportPdf({ hotelId, report: `report-${r.id}`, title: r.title, subtitle: r.period, selection: [`Period: ${r.period} (${r.timezone})`],
    summary: r.summary.slice(0, 6), columns: r.columns, rows: r.rows, tones: r.tones, note: r.note ?? null, operatorId, operatorName, filters: { report: r.id, from: r.from, to: r.to } });
}

export async function emailReport(hotelId: string, reportId: string, period: Period, date: string, emails: string[], operatorId: string | null, operatorName: string) {
  const ch = await channels(hotelId);
  if (!ch.email?.enabled) throw new ApiError(409, 'EMAIL_OFF', 'E-mail is not set up (Settings → Alerts & notifications). Download the PDF or CSV instead.');
  const r = await buildReport(hotelId, reportId, period, date);
  const pdf = await pdfOf(hotelId, r, operatorId, operatorName);
  const name = await siteName(hotelId);
  const file = `${r.id}-${(date || 'now').replace(/[^0-9-]/g, '')}`;
  const failed: string[] = [];
  for (const to of emails) {
    try {
      await sendEmail(ch.email, to, `[${name}] ${r.title}: ${r.period}`, reportText(name, r), hotelId, [
        { filename: `${file}.pdf`, content: pdf.bytes, contentType: 'application/pdf' },
        { filename: `${file}.csv`, content: reportCsv(r), contentType: 'text/csv; charset=utf-8' }]);
    } catch (e) { failed.push(`${to}: ${(e as Error).message.slice(0, 120)}`); }
  }
  await audit(null, { hotelId, actorType: operatorId ? 'operator' : 'system', actorId: operatorId, action: 'report.emailed', targetType: 'report', targetId: pdf.reportId,
    details: { report: r.id, period: r.period, to: emails.length, failed: failed.length, sha256: pdf.sha256 } });
  return { sent: emails.length - failed.length, failed, reportId: pdf.reportId };
}

export function reportsCentreRoutes(app: FastifyInstance) {
  app.get(`${P}/hotels/:hotelId/reports-centre`, async (req) => {
    const hotelId = hid(req);
    const op = await requireOperator(req);
    if (!op.isPlatformAdmin && !op.roles.has(hotelId)) throw forbidden('You are not a member of this site.');
    const perms = permsIn(op, hotelId);
    const tz = await siteTz(hotelId);
    const reports = REPORTS.filter((r) => allowedReport(r, perms)).map(({ perms: _p, ...r }) => r);
    const schedules = perms.has('settings.manage') ? await many(pool, `SELECT id, report, frequency, send_time, emails, enabled, last_period, last_sent_at, last_error FROM report_schedules WHERE hotel_id=$1 ORDER BY created_at`, [hotelId]) : null;
    return { timezone: tz, today: defaultDate('day', tz), month: defaultDate('month', tz), yesterday: previous('day', tz), lastMonth: previous('month', tz), reports, schedules,
      canSchedule: perms.has('settings.manage'), emailOn: Boolean((await channels(hotelId)).email?.enabled) };
  });

  app.get(`${P}/hotels/:hotelId/reports-centre/:report`, async (req) => {
    const hotelId = hid(req);
    const reportId = (req.params as any).report as string;
    await access(req, hotelId, reportId);
    const q = Q.parse(req.query);
    const date = q.date ?? defaultDate(q.period, await siteTz(hotelId));
    return buildReport(hotelId, reportId, q.period, date).catch((e) => { throw new ApiError(400, 'BAD_PERIOD', (e as Error).message); });
  });
  // PDF and CSV downloads (separate routes so the reply can carry the file).
  for (const ext of ['pdf', 'csv'] as const) {
    app.get(`${P}/hotels/:hotelId/reports-centre/:report/${ext}`, async (req, reply) => {
      const hotelId = hid(req);
      const reportId = (req.params as any).report as string;
      const { op } = await access(req, hotelId, reportId);
      const q = Q.parse(req.query);
      const date = q.date ?? defaultDate(q.period, await siteTz(hotelId));
      const r = await buildReport(hotelId, reportId, q.period, date).catch((e) => { throw new ApiError(400, 'BAD_PERIOD', (e as Error).message); });
      const file = `${r.id}-${date}`;
      if (ext === 'csv') {
        await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'report.exported', details: { report: r.id, period: r.period, rows: r.rows.length } });
        reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${file}.csv"`).header('cache-control', 'private, no-store');
        return reportCsv(r);
      }
      const pdf = await pdfOf(hotelId, r, op.id, op.displayName);
      await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'report.printed', targetType: 'report', targetId: pdf.reportId, details: { report: r.id, rows: r.rows.length, pages: pdf.pages, sha256: pdf.sha256 } });
      reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${file}.pdf"`).header('cache-control', 'private, no-store')
        .header('x-report-id', pdf.reportId).header('x-report-sha256', pdf.sha256);
      return reply.send(pdf.bytes);
    });
  }

  app.post(`${P}/hotels/:hotelId/reports-centre/:report/send`, async (req) => {
    const hotelId = hid(req);
    const reportId = (req.params as any).report as string;
    const { op } = await access(req, hotelId, reportId);
    const b = z.object({ period: z.enum(['day', 'month']).default('day'), date: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional(), emails: Emails }).parse(req.body);
    return emailReport(hotelId, reportId, b.period, b.date ?? defaultDate(b.period, await siteTz(hotelId)), b.emails, op.id, op.displayName);
  });

  // ---- schedules (administrators) ----------------------------------------------------------------------------------
  app.post(`${P}/hotels/:hotelId/report-schedules`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const b = z.object({ report: z.string().max(60), frequency: z.enum(['daily', 'monthly']), sendTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('07:00'), emails: Emails }).parse(req.body);
    const def = reportDef(b.report);
    if (!def) throw notFound('Report');
    if (def.periods.includes('now') && b.frequency === 'monthly') { /* "as of now" reports can go monthly too: a snapshot */ }
    const r = await one(pool, `INSERT INTO report_schedules (hotel_id, report, frequency, send_time, emails, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [hotelId, b.report, b.frequency, b.sendTime, b.emails, op.id]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'report.schedule_created', targetType: 'report_schedule', targetId: r!.id, details: { report: b.report, frequency: b.frequency, to: b.emails.length } });
    return { id: r!.id };
  });
  app.delete(`${P}/hotels/:hotelId/report-schedules/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const id = z.string().uuid().parse((req.params as any).id);
    const r = await pool.query(`DELETE FROM report_schedules WHERE id=$1 AND hotel_id=$2`, [id, hotelId]);
    if (!r.rowCount) throw notFound('Schedule');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'report.schedule_deleted', targetType: 'report_schedule', targetId: id });
    return { ok: true };
  });
}

/** Called every minute: daily reports (yesterday) after their time; monthly reports (last month) on the 1st. */
export async function sendScheduledReports(now = new Date()) {
  const due = await many(pool, `SELECT s.*, h.is_demo FROM report_schedules s JOIN hotels h ON h.id=s.hotel_id WHERE s.enabled`);
  for (const s of due) {
    if (s.is_demo) continue;
    const tz = await siteTz(s.hotel_id);
    const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    if (hhmm < s.send_time) continue;
    const period: Period = s.frequency === 'monthly' ? 'month' : 'day';
    if (period === 'month' && defaultDate('day', tz, now).slice(8) !== '01') continue;
    const target = previous(period, tz, now);
    if (s.last_period === target) continue;
    // Claim this period first, so two workers never send the same report twice.
    const claimed = await pool.query(`UPDATE report_schedules SET last_period=$2, last_sent_at=now(), last_error=NULL WHERE id=$1 AND last_period IS DISTINCT FROM $2`, [s.id, target]);
    if (!claimed.rowCount) continue;
    try {
      const r = await emailReport(s.hotel_id, s.report, period, target, s.emails, null, 'Scheduled e-mail');
      if (r.failed.length) await pool.query(`UPDATE report_schedules SET last_error=$2 WHERE id=$1`, [s.id, r.failed.join('; ').slice(0, 500)]);
    } catch (e) { await pool.query(`UPDATE report_schedules SET last_error=$2 WHERE id=$1`, [s.id, (e as Error).message.slice(0, 500)]); }
  }
}
