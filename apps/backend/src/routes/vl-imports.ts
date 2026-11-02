import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sharedVisionlineOperator } from '@smk/shared';
import { pool, many, one, tx } from '../db.ts';
import { audit } from '../audit.ts';
import { requirePerm } from '../auth.ts';
import { ApiError, notFound } from '../lib/errors.ts';
import { getConfig } from '../hotel-config.ts';
import { binaryWorkbook, cardLogColumns, decodeReport, detectKind, operatorColumns, parseSystemSettings, parseTable, type ImportKind } from '../vl-reports.ts';

/**
 * 2.17 Reports exported from Visionline and uploaded here (Setup report → Visionline reports): the System settings
 * report, the list of Visionline operators, a card log. The Web API gives none of them. Nothing else in Visionline
 * changes; uploads are kept per kind (newest shown) and in the audit trail.
 */
const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Site');
  return id;
};

export function vlImportRoutes(app: FastifyInstance) {
  app.post(`${P}/hotels/:hotelId/visionline-imports`, { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const b = z.object({ fileName: z.string().trim().min(1).max(200), data: z.string().max(11_000_000), kind: z.enum(['auto', 'system_settings', 'operators', 'card_log', 'user_groups', 'other']).default('auto') }).parse(req.body);
    const buf = Buffer.from(b.data, 'base64');
    if (!buf.length) throw new ApiError(400, 'EMPTY', 'The file is empty.');
    if (binaryWorkbook(buf)) throw new ApiError(400, 'WORKBOOK', 'This is an Excel workbook. In Excel choose File → Save As → "Unicode Text (*.txt)" or "CSV", or upload the file exactly as Visionline saved it (its .xls reports are text).');
    const text = decodeReport(buf);
    const table = parseTable(text);
    const kind: ImportKind = b.kind === 'auto' ? detectKind(text, table.head) : b.kind;
    let data: any; let rows = 0;
    if (kind === 'system_settings') { data = parseSystemSettings(text); rows = data.sections.length; }
    else {
      if (table.head.length < 2 || !table.rows.length) throw new ApiError(400, 'NOT_A_TABLE', 'No table found: the first line must hold the column names (tab-, comma- or semicolon-separated).');
      data = table; rows = table.rows.length;
      if (kind === 'card_log' && cardLogColumns(table.head).reg < 0) throw new ApiError(400, 'NO_CARD_COLUMN', 'No card number column (e.g. "Reg. no" or "Card number").');
    }
    const r = await tx(async (c) => {
      const row = await one(c, `INSERT INTO vl_imports (hotel_id, kind, file_name, data, rows, imported_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, imported_at`, [hotelId, kind, b.fileName, data, rows, op.id]);
      let issuers = 0;
      if (kind === 'card_log') {
        const col = cardLogColumns(table.head);
        if (col.op >= 0) {
          for (const x of table.rows) {
            const reg = (x[col.reg] ?? '').replace(/\D/g, ''); const who = (x[col.op] ?? '').trim();
            if (!reg || !who) continue;
            const at = col.at >= 0 && x[col.at] && !Number.isNaN(Date.parse(x[col.at]!)) ? new Date(x[col.at]!) : null;
            await c.query(`INSERT INTO vl_card_issuers (hotel_id, reg_no, operator, issued_at, import_id) VALUES ($1,$2,$3,$4,$5)
              ON CONFLICT (hotel_id, reg_no) DO UPDATE SET operator=EXCLUDED.operator, issued_at=COALESCE(EXCLUDED.issued_at, vl_card_issuers.issued_at), import_id=EXCLUDED.import_id`, [hotelId, reg, who.slice(0, 80), at, row!.id]);
            issuers++;
          }
        }
      }
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'visionline.report_imported', targetType: 'import', targetId: row!.id, details: { kind, fileName: b.fileName, rows, issuers } });
      return { id: row!.id, importedAt: row!.imported_at, issuers };
    });
    return { ...r, kind, rows };
  });

  app.get(`${P}/hotels/:hotelId/visionline-imports`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'settings.manage');
    return many(pool, `SELECT DISTINCT ON (i.kind) i.id, i.kind, i.file_name, i.rows, i.imported_at, o.display_name AS imported_by FROM vl_imports i LEFT JOIN operators o ON o.id=i.imported_by
      WHERE i.hotel_id=$1 ORDER BY i.kind, i.imported_at DESC`, [hotelId]);
  });

  app.delete(`${P}/hotels/:hotelId/visionline-imports/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const r = await one(pool, `DELETE FROM vl_imports WHERE id=$1 AND hotel_id=$2 RETURNING kind, file_name`, [z.string().uuid().parse((req.params as any).id), hotelId]);
    if (!r) throw notFound('Import');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'visionline.report_removed', details: { kind: r.kind, fileName: r.file_name } });
    return { ok: true };
  });
}

/** What the setup report shows from the imports (newest of each kind) and from the portal itself. */
export async function importedForSetupReport(hotelId: string) {
  const rows = await many(pool, `SELECT DISTINCT ON (kind) id, kind, file_name, data, rows, imported_at FROM vl_imports WHERE hotel_id=$1 ORDER BY kind, imported_at DESC`, [hotelId]);
  const by = (k: string) => rows.find((r) => r.kind === k);
  const ss = by('system_settings');
  const ops = by('operators');
  const opsTable = ops ? (() => {
    const c = operatorColumns(ops.data.head ?? []);
    return { file: ops.file_name, importedAt: ops.imported_at, head: ops.data.head, rows: (ops.data.rows ?? []).slice(0, 500),
      shared: c.name >= 0 ? (ops.data.rows ?? []).map((r: string[]) => r[c.name]).filter((n: string) => sharedVisionlineOperator(n)).slice(0, 20) : [] };
  })() : null;
  const card = by('card_log');
  const vl = await getConfig(pool, hotelId, 'visionline');
  return {
    systemSettings: ss ? { file: ss.file_name, importedAt: ss.imported_at, facts: ss.data.facts, options: ss.data.options, events: ss.data.events, sections: ss.data.sections } : null,
    operators: opsTable,
    cardLog: card ? { file: card.file_name, importedAt: card.imported_at, rows: card.rows } : null,
    personalCredentialsRequired: Boolean(vl?.requirePersonalCredentials),
  };
}
