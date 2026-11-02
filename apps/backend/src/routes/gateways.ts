import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, many, one, tx } from '../db.ts';
import { audit } from '../audit.ts';
import { requirePerm } from '../auth.ts';
import { ApiError, notFound } from '../lib/errors.ts';
import { binaryWorkbook, decodeReport, parseTable } from '../vl-reports.ts';
import { classifyGateway, gatewayFacts, setGatewayState } from '../gateways.ts';

/**
 * 2.19 Online locks and gateways (Building -> Online locks & gateways). The online locks come from Visionline (door
 * "online" flag) with their contact state from monitoring; gateways are typed in or imported from a table exported
 * from Visionline (name, EEID, address, location, doors). Reading needs resources.read; changing settings.manage.
 */
const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Site');
  return id;
};
const Gw = z.object({
  name: z.string().trim().min(1).max(120),
  eeid: z.string().trim().max(64).regex(/^[0-9A-Za-z:._-]*$/, 'EEID: letters, digits and : . _ - only').optional().nullable(),
  address: z.string().trim().max(120).optional().nullable(),
  location: z.string().trim().max(120).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  doors: z.array(z.string().trim().min(1).max(100)).max(2000).default([]),
});
const blank = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

async function doorIndex(hotelId: string) {
  const rows = await many(pool, `SELECT external_id, name, data->>'doorID' AS no FROM resources WHERE hotel_id=$1 AND kind='door' AND active`, [hotelId]);
  const by = new Map<string, string>();
  for (const r of rows) for (const k of [r.external_id, r.name, r.no]) if (k != null && String(k).trim()) by.set(String(k).trim().toLowerCase(), r.external_id);
  return by;
}
/** Re-evaluate the gateways now (the monitor also does it every minute). */
async function refresh(hotelId: string) {
  for (const { gateway, facts } of await gatewayFacts(hotelId)) await setGatewayState(gateway.id, classifyGateway(facts));
}

export function gatewayRoutes(app: FastifyInstance) {
  app.get(`${P}/hotels/:hotelId/online-locks`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'resources.read');
    await refresh(hotelId);
    const doors = await many(pool, `SELECT r.external_id AS id, r.name, r.data->>'doorGroup' AS "group", (r.data->>'online')::boolean AS online,
        s.state, s.last_event_at, s.changed_at, s.reason, b.state AS battery, m.model
      FROM resources r LEFT JOIN door_status s ON s.hotel_id=r.hotel_id AND s.door_id=r.external_id
      LEFT JOIN battery_status b ON b.hotel_id=r.hotel_id AND b.door_id=r.external_id
      LEFT JOIN door_lock_models m ON m.hotel_id=r.hotel_id AND m.door_id=r.external_id
      WHERE r.hotel_id=$1 AND r.kind='door' AND r.active ORDER BY r.name`, [hotelId]);
    const gws = await many(pool, 'SELECT id, name, eeid, address, location, notes, doors, source, state, reason, changed_at, checked_at FROM gateways WHERE hotel_id=$1 ORDER BY name', [hotelId]);
    const gwOf = new Map<string, { id: string; name: string; eeid: string | null; state: string }>();
    for (const g of gws) for (const d of g.doors as string[]) gwOf.set(d, { id: g.id, name: g.name, eeid: g.eeid, state: g.state });
    const alerts = await many(pool, `SELECT kind, subject, opened_at FROM monitor_alerts WHERE hotel_id=$1 AND kind IN ('door_offline','gateway_offline') AND resolved_at IS NULL`, [hotelId]);
    const openAlert = new Set(alerts.map((a) => `${a.kind}|${a.subject}`));
    const resolved = await many(pool, `SELECT kind, subject, title, opened_at, resolved_at FROM monitor_alerts WHERE hotel_id=$1 AND kind IN ('door_offline','gateway_offline')
      AND resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 20`, [hotelId]);
    const locks = doors.filter((d) => d.online === true || gwOf.has(d.id)).map((d) => ({
      id: d.id, name: d.name, group: d.group, onlineLock: d.online === true, state: d.state ?? 'unknown', lastContact: d.last_event_at, since: d.changed_at, reason: d.reason,
      battery: d.battery ?? null, model: d.model ?? null, gateway: gwOf.get(d.id) ?? null, alertOpen: openAlert.has(`door_offline|${d.id}`),
    }));
    const n = (f: (x: any) => boolean) => locks.filter(f).length;
    return {
      summary: { onlineLocks: locks.length, inContact: n((x) => x.state === 'online'), offline: n((x) => x.state === 'offline'), unknown: n((x) => x.state === 'unknown'),
        gateways: gws.length, gatewaysOffline: gws.filter((g) => g.state === 'offline').length, offlineDoorsVisionline: doors.filter((d) => d.online === false).length },
      gateways: gws.map((g) => ({ id: g.id, name: g.name, eeid: g.eeid, address: g.address, location: g.location, notes: g.notes, doors: g.doors, source: g.source,
        state: g.state, reason: g.reason, since: g.changed_at, checkedAt: g.checked_at, alertOpen: openAlert.has(`gateway_offline|${g.id}`) })),
      locks, recentlyResolved: resolved.map((r) => ({ kind: r.kind, title: r.title, openedAt: r.opened_at, resolvedAt: r.resolved_at })),
    };
  });

  app.post(`${P}/hotels/:hotelId/gateways`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const b = Gw.parse(req.body);
    const idx = await doorIndex(hotelId);
    const doors = [...new Set(b.doors.map((d) => idx.get(d.toLowerCase()) ?? d))];
    try {
      const g = await one(pool, `INSERT INTO gateways (hotel_id, name, eeid, address, location, notes, doors, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [hotelId, b.name, blank(b.eeid), blank(b.address), blank(b.location), blank(b.notes), doors, op.id]);
      await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'gateway.added', targetType: 'gateway', targetId: g!.id, details: { name: b.name, eeid: blank(b.eeid), doors: doors.length } });
      return { id: g!.id };
    } catch (e: any) { if (e?.code === '23505') throw new ApiError(409, 'DUPLICATE_EEID', 'A gateway with this EEID already exists.'); throw e; }
  });

  app.put(`${P}/hotels/:hotelId/gateways/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const id = z.string().uuid().parse((req.params as any).id);
    const b = Gw.parse(req.body);
    const idx = await doorIndex(hotelId);
    const doors = [...new Set(b.doors.map((d) => idx.get(d.toLowerCase()) ?? d))];
    try {
      const g = await one(pool, `UPDATE gateways SET name=$3, eeid=$4, address=$5, location=$6, notes=$7, doors=$8 WHERE id=$1 AND hotel_id=$2 RETURNING id`,
        [id, hotelId, b.name, blank(b.eeid), blank(b.address), blank(b.location), blank(b.notes), doors]);
      if (!g) throw notFound('Gateway');
      await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'gateway.changed', targetType: 'gateway', targetId: id, details: { name: b.name, eeid: blank(b.eeid), doors: doors.length } });
      return { ok: true };
    } catch (e: any) { if (e?.code === '23505') throw new ApiError(409, 'DUPLICATE_EEID', 'A gateway with this EEID already exists.'); throw e; }
  });

  app.delete(`${P}/hotels/:hotelId/gateways/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const id = z.string().uuid().parse((req.params as any).id);
    const g = await one(pool, 'DELETE FROM gateways WHERE id=$1 AND hotel_id=$2 RETURNING name, eeid', [id, hotelId]);
    if (!g) throw notFound('Gateway');
    await pool.query(`UPDATE monitor_alerts SET resolved_at=now(), detail='The gateway was removed from the list.' WHERE hotel_id=$1 AND kind='gateway_offline' AND subject=$2 AND resolved_at IS NULL`, [hotelId, id]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'gateway.removed', targetType: 'gateway', targetId: id, details: { name: g.name, eeid: g.eeid } });
    return { ok: true };
  });

  /**
   * Import a table of gateways (exported from Visionline, or typed in Excel and saved as Unicode text / CSV).
   * Columns are recognised by their heading: name, EEID, IP/address, location/floor, doors/rooms (several per cell).
   * Rows are matched on EEID, else on name. preview=true only reports what would change.
   */
  app.post(`${P}/hotels/:hotelId/gateways/import`, { bodyLimit: 6 * 1024 * 1024 }, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const b = z.object({ fileName: z.string().trim().min(1).max(200), data: z.string().min(4).max(5_000_000), preview: z.boolean().default(false) }).parse(req.body);
    const buf = Buffer.from(b.data, 'base64');
    if (binaryWorkbook(buf)) throw new ApiError(400, 'WORKBOOK', 'This is an Excel workbook. In Excel choose File → Save As → "Unicode Text (*.txt)" or "CSV", or upload the file exactly as Visionline saved it.');
    const t = parseTable(decodeReport(buf));
    const h = t.head.map((x) => x.toLowerCase().trim());
    const col = (re: RegExp, not?: RegExp) => h.findIndex((x) => re.test(x) && !(not && not.test(x)));
    const c = { eeid: col(/eeid|eui|extended.?id|mac/), name: col(/name|gateway|description|label/, /eeid|eui/), address: col(/^ip|address|host/), location: col(/location|floor|area|zone|building/), doors: col(/door|room|lock/) };
    if (c.name < 0 && c.eeid < 0) throw new ApiError(400, 'NO_COLUMNS', `No "Name" or "EEID" column found. Columns in the file: ${t.head.slice(0, 12).join(', ') || 'none'}.`);
    const idx = await doorIndex(hotelId);
    const existing = await many(pool, 'SELECT id, name, eeid FROM gateways WHERE hotel_id=$1', [hotelId]);
    const out = { added: 0, updated: 0, skipped: 0, unknownDoors: [] as string[], columns: Object.fromEntries(Object.entries(c).map(([k, i]) => [k, i >= 0 ? t.head[i] : null])), rows: [] as any[] };
    await tx(async (cx) => {
      for (const r of t.rows) {
        const v = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
        const eeid = v(c.eeid).replace(/[^0-9A-Za-z:._-]/g, '').slice(0, 64) || null;
        const name = (v(c.name) || eeid || '').slice(0, 120);
        if (!name) { out.skipped++; continue; }
        const doorNames = v(c.doors) ? v(c.doors).split(/[,;|]+|\s{2,}|\s+(?=\d)/).map((x) => x.trim()).filter(Boolean) : [];
        const doors: string[] = [];
        for (const d of doorNames) { const k = idx.get(d.toLowerCase()); if (k) doors.push(k); else if (out.unknownDoors.length < 30) out.unknownDoors.push(d); }
        const hit = existing.find((g) => (eeid && g.eeid && g.eeid.toUpperCase() === eeid.toUpperCase()) || (!eeid && g.name.toLowerCase() === name.toLowerCase()));
        if (out.rows.length < 200) out.rows.push({ name, eeid, address: v(c.address) || null, location: v(c.location) || null, doors: doors.length, action: hit ? 'update' : 'add' });
        if (b.preview) { hit ? out.updated++ : out.added++; continue; }
        if (hit) {
          await cx.query(`UPDATE gateways SET name=$2, eeid=COALESCE($3, eeid), address=COALESCE($4, address), location=COALESCE($5, location), doors=CASE WHEN cardinality($6::text[]) > 0 THEN $6::text[] ELSE doors END WHERE id=$1`,
            [hit.id, name, eeid, v(c.address) || null, v(c.location) || null, [...new Set(doors)]]);
          out.updated++;
        } else {
          const g = await one(cx, `INSERT INTO gateways (hotel_id, name, eeid, address, location, doors, source, created_by) VALUES ($1,$2,$3,$4,$5,$6,'import',$7) RETURNING id, name, eeid`,
            [hotelId, name, eeid, v(c.address) || null, v(c.location) || null, [...new Set(doors)], op.id]);
          existing.push(g!);
          out.added++;
        }
      }
      if (!b.preview) await audit(cx, { hotelId, actorType: 'operator', actorId: op.id, action: 'gateway.imported', targetType: 'gateway', details: { fileName: b.fileName, added: out.added, updated: out.updated, skipped: out.skipped } });
    });
    return out;
  });
}
