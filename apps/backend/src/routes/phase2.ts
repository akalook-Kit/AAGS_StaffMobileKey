import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, tx, one, many, lockHotel } from '../db.ts';
import { audit } from '../audit.ts';
import { permsIn, requirePerm, requireStaff, type OperatorCtx } from '../auth.ts';
import { getConfig } from '../hotel-config.ts';
import { acknowledgeAlert, batteryEventName, resolveAlertManually } from '../battery.ts';
import {
  CATEGORIES, PRIORITIES, TICKET_STATUSES, OPEN_STATUSES, TICKET_SELECT, assignTicket, changeStatus, checkAttachment, commentTicket, createTicket,
  lockTicket, maintenancePolicy, ticketDetail, ticketView, activity, type Actor,
} from '../maintenance.ts';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors.ts';

/**
 * Phase 2 API: lock battery monitoring and maintenance requests, for the portal and the staff app.
 * Both modules are tenant features: nothing here works until the hotel switches the module on.
 */
const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Hotel');
  return id;
};
const opActor = (op: OperatorCtx): Actor => ({ type: 'operator', id: op.id, name: op.displayName });

async function requireModule(hotelId: string, m: 'batteryMonitoring' | 'maintenance') {
  const f = await getConfig(pool, hotelId, 'features');
  if (!f?.[m]) throw new ApiError(409, 'MODULE_OFF', m === 'batteryMonitoring'
    ? 'Battery monitoring is switched off for this hotel (Settings → Modules).' : 'Maintenance is switched off for this hotel (Settings → Modules).');
}

/** CSV cell, with spreadsheet formula injection neutralised. */
const csv = (v: unknown) => {
  let s = typeof v === 'string' ? v : v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const TicketBody = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().max(4000).optional(),
  category: z.enum(CATEGORIES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  doorId: z.string().max(100).nullable().optional(),
  location: z.string().max(120).nullable().optional(),
  asset: z.string().max(120).nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  assigneeStaffId: z.string().uuid().nullable().optional(),
});
const StatusBody = z.object({ status: z.enum(TICKET_STATUSES), note: z.string().max(2000).nullable().optional(), batteryReplaced: z.boolean().optional() });

export function phase2Routes(app: FastifyInstance) {
  // ---- What needs attention (navigation badges, overview) -----------------------------------------
  app.get(`${P}/hotels/:hotelId/attention`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'resources.read');
    const perms = permsIn(op, hotelId);
    const f = (await getConfig(pool, hotelId, 'features')) ?? {};
    const p = await maintenancePolicy(pool, hotelId);
    const out: Record<string, unknown> = { batteryMonitoring: Boolean(f.batteryMonitoring), maintenance: Boolean(f.maintenance) };
    if (f.batteryMonitoring && perms.has('battery.read')) {
      out.battery = await one(pool, `SELECT
          count(*) FILTER (WHERE a.severity='CRITICAL')::int AS critical, count(*) FILTER (WHERE a.severity='LOW')::int AS low,
          count(*) FILTER (WHERE a.status='OPEN')::int AS unacknowledged,
          (SELECT count(*)::int FROM battery_status s WHERE s.hotel_id=$1 AND s.reported_at < now() - make_interval(days => $2)) AS stale
        FROM battery_alerts a WHERE a.hotel_id=$1 AND a.status IN ('OPEN','ACKNOWLEDGED')`, [hotelId, p.battery.staleAfterDays]);
    }
    if (f.maintenance && perms.has('maintenance.read')) {
      out.maintenance = await one(pool, `SELECT count(*)::int AS open,
          count(*) FILTER (WHERE assignee_staff_id IS NULL)::int AS unassigned,
          count(*) FILTER (WHERE due_at < now())::int AS overdue,
          count(*) FILTER (WHERE priority='urgent')::int AS urgent
        FROM maintenance_tickets WHERE hotel_id=$1 AND status = ANY($2)`, [hotelId, OPEN_STATUSES]);
    }
    return out;
  });

  // ---- Battery ------------------------------------------------------------------------------------
  /** Door inventory with battery state (spec §13.4 Battery screen). Includes doors that never reported. */
  app.get(`${P}/hotels/:hotelId/battery`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'battery.read');
    await requireModule(hotelId, 'batteryMonitoring');
    const p = await maintenancePolicy(pool, hotelId);
    const rows = await many(pool, `
      WITH doors AS (
        SELECT external_id AS door_id, name, data->>'doorGroup' AS door_group, (data->>'online')::boolean AS online, true AS known
          FROM resources WHERE hotel_id=$1 AND kind='door' AND active
        UNION ALL
        SELECT s.door_id, s.door_id, NULL, NULL, false FROM battery_status s
          WHERE s.hotel_id=$1 AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.hotel_id=$1 AND r.kind='door' AND r.active AND r.external_id=s.door_id))
      SELECT d.*, s.state, s.last_event_code, s.volts_below, s.reported_at, s.received_at,
        a.id AS alert_id, a.severity, a.status AS alert_status, a.opened_at, a.occurrences, a.acknowledged_at, ao.display_name AS acknowledged_by,
        t.id AS ticket_id, t.number AS ticket_number, t.status AS ticket_status, ts.full_name AS ticket_assignee
      FROM doors d
      LEFT JOIN battery_status s ON s.hotel_id=$1 AND s.door_id=d.door_id
      LEFT JOIN battery_alerts a ON a.hotel_id=$1 AND a.door_id=d.door_id AND a.status IN ('OPEN','ACKNOWLEDGED')
      LEFT JOIN operators ao ON ao.id=a.acknowledged_by
      LEFT JOIN maintenance_tickets t ON t.id=a.ticket_id
      LEFT JOIN staff ts ON ts.id=t.assignee_staff_id
      ORDER BY d.door_group NULLS LAST, d.name`, [hotelId]);
    const staleBefore = Date.now() - p.battery.staleAfterDays * 86_400_000;
    const doors = rows.map((r) => ({
      doorId: r.door_id, name: r.name, doorGroup: r.door_group, online: r.online, known: r.known,
      state: r.state ?? 'NEVER', stale: Boolean(r.reported_at && new Date(r.reported_at).getTime() < staleBefore),
      lastEvent: r.last_event_code != null ? { code: r.last_event_code, name: batteryEventName(r.last_event_code) } : null,
      voltsBelow: r.volts_below != null ? Number(r.volts_below) : null, reportedAt: r.reported_at, receivedAt: r.received_at,
      alert: r.alert_id ? { id: r.alert_id, severity: r.severity, status: r.alert_status, openedAt: r.opened_at, occurrences: r.occurrences, acknowledgedAt: r.acknowledged_at, acknowledgedBy: r.acknowledged_by } : null,
      ticket: r.ticket_id ? { id: r.ticket_id, number: r.ticket_number, status: r.ticket_status, assignee: r.ticket_assignee } : null,
    }));
    const count = (pred: (d: (typeof doors)[number]) => boolean) => doors.filter(pred).length;
    return {
      doors,
      summary: { total: doors.length, good: count((d) => d.state === 'GOOD'), low: count((d) => d.state === 'LOW'), critical: count((d) => d.state === 'CRITICAL'),
        reported: count((d) => d.state === 'REPORTED'), never: count((d) => d.state === 'NEVER'), stale: count((d) => d.stale) },
      policy: p.battery,
    };
  });

  app.get(`${P}/hotels/:hotelId/battery/doors/:doorId/history`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'battery.read');
    const doorId = (req.params as any).doorId as string;
    const readings = await many(pool, `SELECT event_code, state, volts_below, reported_at, received_at FROM battery_readings WHERE hotel_id=$1 AND door_id=$2 ORDER BY reported_at DESC, id DESC LIMIT 100`, [hotelId, doorId]);
    const alerts = await many(pool, `SELECT a.id, a.severity, a.status, a.opened_at, a.last_seen_at, a.occurrences, a.resolved_at, a.resolved_reason, t.number AS ticket_number
      FROM battery_alerts a LEFT JOIN maintenance_tickets t ON t.id=a.ticket_id WHERE a.hotel_id=$1 AND a.door_id=$2 ORDER BY a.opened_at DESC LIMIT 20`, [hotelId, doorId]);
    return {
      readings: readings.map((r) => ({ code: r.event_code, event: batteryEventName(r.event_code), state: r.state, voltsBelow: r.volts_below != null ? Number(r.volts_below) : null, reportedAt: r.reported_at, receivedAt: r.received_at })),
      alerts: alerts.map((a) => ({ id: a.id, severity: a.severity, status: a.status, openedAt: a.opened_at, lastSeenAt: a.last_seen_at, occurrences: a.occurrences, resolvedAt: a.resolved_at, resolvedReason: a.resolved_reason, ticketNumber: a.ticket_number })),
    };
  });

  app.post(`${P}/hotels/:hotelId/battery/alerts/:alertId/acknowledge`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'battery.manage');
    const a = await tx(async (c) => { await lockHotel(c, hotelId); return acknowledgeAlert(c, hotelId, (req.params as any).alertId, op.id); });
    if (!a) throw badRequest('NOT_OPEN', 'This alert is not open (already acknowledged or resolved).');
    return { ok: true };
  });

  app.post(`${P}/hotels/:hotelId/battery/alerts/:alertId/resolve`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'battery.manage');
    const b = z.object({ reason: z.string().trim().min(3).max(500), batteryReplaced: z.boolean().default(false) }).parse(req.body);
    const a = await tx(async (c) => { await lockHotel(c, hotelId); return resolveAlertManually(c, hotelId, (req.params as any).alertId, opActor(op), b.reason, b.batteryReplaced); });
    if (!a) throw badRequest('NOT_OPEN', 'This alert is already resolved.');
    return { ok: true };
  });

  /** Open a maintenance request for a battery alert that has none (when automatic requests are off). */
  app.post(`${P}/hotels/:hotelId/battery/alerts/:alertId/ticket`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'maintenance.manage');
    await requireModule(hotelId, 'maintenance');
    const b = z.object({ assigneeStaffId: z.string().uuid().nullable().optional(), priority: z.enum(PRIORITIES).optional() }).parse(req.body ?? {});
    return tx(async (c) => {
      await lockHotel(c, hotelId);
      const a = await one(c, `SELECT a.*, r.name, r.data->>'doorGroup' AS g, (r.external_id IS NOT NULL) AS known FROM battery_alerts a
        LEFT JOIN resources r ON r.hotel_id=a.hotel_id AND r.kind='door' AND r.external_id=a.door_id WHERE a.hotel_id=$1 AND a.id=$2 FOR UPDATE OF a`, [hotelId, (req.params as any).alertId]);
      if (!a) throw notFound('Battery alert');
      if (a.ticket_id) throw badRequest('HAS_TICKET', 'This alert already has a maintenance request.');
      if (a.status === 'RESOLVED') throw badRequest('NOT_OPEN', 'This alert is resolved.');
      const name = a.name ?? a.door_id;
      const t = await createTicket(c, hotelId, { title: `Replace lock battery: ${name}`, description: `Battery alert (${a.severity.toLowerCase()}) opened ${new Date(a.opened_at).toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
        category: 'battery', priority: b.priority ?? (a.severity === 'CRITICAL' ? 'high' : 'normal'), doorId: a.known ? a.door_id : null, location: a.g ? `${name} · ${a.g}` : name,
        assigneeStaffId: b.assigneeStaffId ?? null, source: 'battery', batteryAlertId: a.id }, opActor(op));
      await c.query('UPDATE battery_alerts SET ticket_id=$2 WHERE id=$1', [a.id, t.id]);
      return t;
    }).then((t) => ticketDetail(pool, hotelId, t.id));
  });

  app.get(`${P}/hotels/:hotelId/battery/export`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'battery.read');
    const rows = await many(pool, `SELECT b.reported_at, b.received_at, b.door_id, r.name AS door_name, r.data->>'doorGroup' AS door_group, b.event_code, b.state, b.volts_below
      FROM battery_readings b LEFT JOIN resources r ON r.hotel_id=b.hotel_id AND r.kind='door' AND r.external_id=b.door_id WHERE b.hotel_id=$1 ORDER BY b.reported_at, b.id`, [hotelId]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'battery.exported', details: { records: rows.length } });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="battery-history.csv"');
    return ['reported_at,received_at,door_id,door_name,door_group,event_code,event,state,volts_below',
      ...rows.map((r) => [r.reported_at, r.received_at, r.door_id, r.door_name, r.door_group, r.event_code, batteryEventName(r.event_code), r.state, r.volts_below].map(csv).join(','))].join('\n');
  });

  // ---- Maintenance (portal) ----------------------------------------------------------------------
  app.get(`${P}/hotels/:hotelId/maintenance/tickets`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'maintenance.read');
    await requireModule(hotelId, 'maintenance');
    const q = z.object({ view: z.enum(['open', 'closed', 'all']).default('open'), q: z.string().max(100).optional(), assignee: z.string().optional(), priority: z.enum(PRIORITIES).optional(), category: z.enum(CATEGORIES).optional() }).parse(req.query);
    const where = ['t.hotel_id=$1'];
    const params: unknown[] = [hotelId];
    if (q.view === 'open') where.push(`t.status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','ON_HOLD')`);
    if (q.view === 'closed') where.push(`t.status IN ('RESOLVED','CLOSED','CANCELLED')`);
    if (q.priority) { params.push(q.priority); where.push(`t.priority=$${params.length}`); }
    if (q.category) { params.push(q.category); where.push(`t.category=$${params.length}`); }
    if (q.assignee === 'none') where.push('t.assignee_staff_id IS NULL');
    else if (q.assignee && /^[0-9a-f-]{36}$/.test(q.assignee)) { params.push(q.assignee); where.push(`t.assignee_staff_id=$${params.length}`); }
    if (q.q?.trim()) {
      // Search by number, title, room/door, location, asset or staff member (spec §13.4 Maintenance screen).
      params.push(`%${q.q.trim().toLowerCase().replace(/[%_\\]/g, (m) => `\\${m}`)}%`, q.q.trim().replace(/^#/, ''));
      const n = params.length - 1;
      where.push(`(t.number::text = $${n + 1} OR lower(t.title) LIKE $${n} OR lower(coalesce(t.location,'')) LIKE $${n} OR lower(coalesce(t.asset,'')) LIKE $${n}
        OR lower(coalesce(t.door_id,'')) LIKE $${n} OR lower(coalesce(d.name,'')) LIKE $${n} OR lower(coalesce(s.full_name,'')) LIKE $${n} OR lower(t.description) LIKE $${n})`);
    }
    const rows = await many(pool, `${TICKET_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.due_at NULLS LAST, t.number DESC LIMIT 500`, params);
    return rows.map(ticketView);
  });

  app.post(`${P}/hotels/:hotelId/maintenance/tickets`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'maintenance.work');
    await requireModule(hotelId, 'maintenance');
    const b = TicketBody.parse(req.body);
    if ((b.assigneeStaffId || b.dueAt || b.priority === 'urgent') && !permsIn(op, hotelId).has('maintenance.manage'))
      throw forbidden('Only a maintenance manager can assign a request, set its due date or mark it urgent.');
    const t = await tx(async (c) => { await lockHotel(c, hotelId); return createTicket(c, hotelId, { ...b, source: 'portal' }, opActor(op)); });
    return ticketDetail(pool, hotelId, t.id);
  });

  app.get(`${P}/hotels/:hotelId/maintenance/tickets/:id`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'maintenance.read');
    const id = (req.params as any).id as string;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Maintenance request');
    return ticketDetail(pool, hotelId, id);
  });

  /** Edit fields. Assignment, priority and due date need maintenance.manage; wording needs maintenance.work. */
  app.patch(`${P}/hotels/:hotelId/maintenance/tickets/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'maintenance.work');
    const manager = permsIn(op, hotelId).has('maintenance.manage');
    const b = TicketBody.partial().parse(req.body);
    const id = (req.params as any).id as string;
    await tx(async (c) => {
      await lockHotel(c, hotelId);
      let t = await lockTicket(c, hotelId, id);
      const actor = opActor(op);
      if (b.assigneeStaffId !== undefined) { if (!manager) throw forbidden('Only a maintenance manager can assign requests.'); t = await assignTicket(c, hotelId, t, b.assigneeStaffId, actor); }
      if (b.priority && b.priority !== t.priority) {
        if (!manager) throw forbidden('Only a maintenance manager can change the priority.');
        await c.query('UPDATE maintenance_tickets SET priority=$2, updated_at=now() WHERE id=$1', [t.id, b.priority]);
        await activity(c, hotelId, t.id, actor, 'priority', null, { from: t.priority, to: b.priority });
      }
      if (b.dueAt !== undefined && String(b.dueAt) !== String(t.due_at?.toISOString?.() ?? t.due_at)) {
        if (!manager) throw forbidden('Only a maintenance manager can change the due date.');
        await c.query('UPDATE maintenance_tickets SET due_at=$2, updated_at=now() WHERE id=$1', [t.id, b.dueAt]);
        await activity(c, hotelId, t.id, actor, 'due', null, { from: t.due_at, to: b.dueAt });
      }
      const edits: Record<string, unknown> = {};
      for (const [k, col] of [['title', 'title'], ['description', 'description'], ['category', 'category'], ['location', 'location'], ['asset', 'asset']] as const) {
        const v = (b as any)[k];
        if (v !== undefined && v !== t[col]) { edits[k] = v; await c.query(`UPDATE maintenance_tickets SET ${col}=$2, updated_at=now() WHERE id=$1`, [t.id, v ?? (col === 'description' ? '' : null)]); }
      }
      if (b.doorId !== undefined && b.doorId !== t.door_id) {
        if (b.doorId && !(await one(c, `SELECT 1 FROM resources WHERE hotel_id=$1 AND kind='door' AND external_id=$2`, [hotelId, b.doorId]))) throw badRequest('UNKNOWN_DOOR', 'That door is not in the discovered Visionline doors.');
        edits.doorId = b.doorId; await c.query('UPDATE maintenance_tickets SET door_id=$2, updated_at=now() WHERE id=$1', [t.id, b.doorId]);
      }
      if (Object.keys(edits).length) {
        await activity(c, hotelId, t.id, actor, 'edited', null, { fields: Object.keys(edits) });
        await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'maintenance.edited', targetType: 'maintenance_ticket', targetId: t.id, details: { number: t.number, fields: Object.keys(edits) } });
      }
    });
    return ticketDetail(pool, hotelId, id);
  });

  app.post(`${P}/hotels/:hotelId/maintenance/tickets/:id/status`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'maintenance.work');
    const b = StatusBody.parse(req.body);
    const id = (req.params as any).id as string;
    await tx(async (c) => {
      await lockHotel(c, hotelId);
      const t = await lockTicket(c, hotelId, id);
      await changeStatus(c, hotelId, t, b.status, opActor(op), { manager: permsIn(op, hotelId).has('maintenance.manage'), note: b.note, batteryReplaced: b.batteryReplaced });
    });
    return ticketDetail(pool, hotelId, id);
  });

  app.post(`${P}/hotels/:hotelId/maintenance/tickets/:id/comments`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'maintenance.work');
    const b = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body);
    const id = (req.params as any).id as string;
    await tx(async (c) => { await lockHotel(c, hotelId); await commentTicket(c, hotelId, await lockTicket(c, hotelId, id), b.body, opActor(op)); });
    return ticketDetail(pool, hotelId, id);
  });

  app.post(`${P}/hotels/:hotelId/maintenance/tickets/:id/attachments`, { bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'maintenance.work');
    const b = z.object({ filename: z.string().min(1).max(200), dataBase64: z.string().min(4).max(4_300_000) }).parse(req.body);
    const f = checkAttachment(b.filename, b.dataBase64);
    const id = (req.params as any).id as string;
    await tx(async (c) => {
      await lockHotel(c, hotelId);
      const t = await lockTicket(c, hotelId, id);
      const n = await one(c, 'SELECT count(*)::int AS n FROM maintenance_attachments WHERE ticket_id=$1', [t.id]);
      if (n.n >= 10) throw badRequest('TOO_MANY_FILES', 'A request can have up to 10 attachments.');
      const a = await one(c, `INSERT INTO maintenance_attachments (hotel_id, ticket_id, filename, content_type, size_bytes, data, uploaded_by_type, uploaded_by_id, uploaded_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,'operator',$7,$8) RETURNING id`, [hotelId, t.id, f.filename, f.type, f.buf.length, f.buf, op.id, op.displayName]);
      await activity(c, hotelId, t.id, opActor(op), 'attachment', f.filename, { attachmentId: a.id, size: f.buf.length, contentType: f.type });
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'maintenance.attachment_added', targetType: 'maintenance_ticket', targetId: t.id, details: { number: t.number, filename: f.filename, size: f.buf.length } });
    });
    return ticketDetail(pool, hotelId, id);
  });

  app.get(`${P}/hotels/:hotelId/maintenance/tickets/:id/attachments/:attId`, async (req, reply) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'maintenance.read');
    const { id, attId } = req.params as any;
    if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f-]{36}$/.test(attId)) throw notFound('Attachment');
    const a = await one(pool, 'SELECT filename, content_type, data FROM maintenance_attachments WHERE hotel_id=$1 AND ticket_id=$2 AND id=$3', [hotelId, id, attId]);
    if (!a) throw notFound('Attachment');
    // Served as a download with a fixed, sniffed type; never rendered as HTML.
    reply.header('content-type', a.content_type).header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename="${a.filename.replace(/[^\w.\- ]/g, '_')}"`).header('cache-control', 'private, no-store');
    return reply.send(a.data);
  });

  app.get(`${P}/hotels/:hotelId/maintenance/export`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'maintenance.read');
    const rows = await many(pool, `${TICKET_SELECT} WHERE t.hotel_id=$1 ORDER BY t.number`, [hotelId]);
    const acts = await many(pool, `SELECT t.number, a.at, a.actor_type, a.actor_name, a.kind, a.body, a.data FROM maintenance_activity a JOIN maintenance_tickets t ON t.id=a.ticket_id WHERE a.hotel_id=$1 ORDER BY t.number, a.id`, [hotelId]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'maintenance.exported', details: { requests: rows.length, activity: acts.length } });
    const kind = (req.query as any).kind === 'history' ? 'history' : 'requests';
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="maintenance-${kind}.csv"`);
    if (kind === 'history') return ['number,at,actor_type,actor,kind,text,details', ...acts.map((a) => [a.number, a.at, a.actor_type, a.actor_name, a.kind, a.body, a.data].map(csv).join(','))].join('\n');
    return ['number,title,category,priority,status,door,location,asset,source,assignee,created_by,created_at,due_at,acknowledged_at,resolved_at,closed_at,resolution',
      ...rows.map(ticketView).map((t) => [t.number, t.title, t.category, t.priority, t.status, t.doorName ?? t.doorId, t.location, t.asset, t.source, t.assigneeName, t.createdBy, t.createdAt, t.dueAt, t.acknowledgedAt, t.resolvedAt, t.closedAt, t.resolution].map(csv).join(','))].join('\n');
  });

  /** People a request can be given to: active staff, maintenance job roles first. */
  app.get(`${P}/hotels/:hotelId/maintenance/assignees`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'maintenance.read');
    const p = await maintenancePolicy(pool, hotelId);
    const rows = await many(pool, `SELECT s.id, s.full_name, s.job_role,
        (SELECT count(*)::int FROM maintenance_tickets t WHERE t.assignee_staff_id=s.id AND t.status = ANY($3)) AS open_tasks,
        EXISTS (SELECT 1 FROM endpoints e WHERE e.staff_id=s.id AND e.status='ACTIVE') AS has_app
      FROM staff s WHERE s.hotel_id=$1 AND s.status='ACTIVE' ORDER BY (s.job_role = ANY($2)) DESC, s.full_name`, [hotelId, p.maintenance.notifyJobRoles, OPEN_STATUSES]);
    return rows.map((r) => ({ id: r.id, name: r.full_name, jobRole: r.job_role, maintenanceRole: p.maintenance.notifyJobRoles.includes(r.job_role), openTasks: r.open_tasks, hasApp: r.has_app }));
  });

  // ---- Staff app: my tasks and problem reports ------------------------------------------------------
  const staffName = async (staffId: string) => (await one(pool, 'SELECT full_name FROM staff WHERE id=$1', [staffId]))?.full_name ?? 'Staff';
  const myTicket = async (c: any, hotelId: string, staffId: string, id: string) => {
    const t = await lockTicket(c, hotelId, id);
    if (t.assignee_staff_id !== staffId) throw forbidden('This task is not assigned to you.');
    return t;
  };

  app.get('/mobile/v1/tasks', async (req) => {
    const { staffId, hotelId } = await requireStaff(req);
    const f = await getConfig(pool, hotelId, 'features');
    if (!f?.maintenance) return { enabled: false, tasks: [], reported: [] };
    const tasks = await many(pool, `${TICKET_SELECT} WHERE t.hotel_id=$1 AND t.assignee_staff_id=$2 AND (t.status = ANY($3) OR t.updated_at > now() - interval '3 days')
      ORDER BY (t.status = ANY($3)) DESC, CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.due_at NULLS LAST LIMIT 50`, [hotelId, staffId, OPEN_STATUSES]);
    const reported = await many(pool, `${TICKET_SELECT} WHERE t.hotel_id=$1 AND t.created_by_type='staff' AND t.created_by_id=$2 AND t.updated_at > now() - interval '14 days' ORDER BY t.created_at DESC LIMIT 20`, [hotelId, staffId]);
    const p = await maintenancePolicy(pool, hotelId);
    return { enabled: true, canReport: p.maintenance.staffCanReport, tasks: tasks.map(ticketView), reported: reported.map(ticketView) };
  });

  app.get('/mobile/v1/tasks/:id', async (req) => {
    const { staffId, hotelId } = await requireStaff(req);
    const id = (req.params as any).id as string;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Task');
    const d = await ticketDetail(pool, hotelId, id);
    const reporter = d.createdByType === 'staff' && (await one(pool, `SELECT 1 FROM maintenance_tickets WHERE id=$1 AND created_by_id=$2`, [id, staffId]));
    if (d.assigneeStaffId !== staffId && !reporter) throw forbidden('This task is not assigned to you.');
    return d;
  });

  app.post('/mobile/v1/tasks/:id/status', async (req) => {
    const { staffId, hotelId } = await requireStaff(req);
    const b = StatusBody.parse(req.body);
    const id = (req.params as any).id as string;
    const actor: Actor = { type: 'staff', id: staffId, name: await staffName(staffId) };
    await tx(async (c) => {
      await lockHotel(c, hotelId);
      await changeStatus(c, hotelId, await myTicket(c, hotelId, staffId, id), b.status, actor, { manager: false, note: b.note, batteryReplaced: b.batteryReplaced });
    });
    return ticketDetail(pool, hotelId, id);
  });

  app.post('/mobile/v1/tasks/:id/comments', async (req) => {
    const { staffId, hotelId } = await requireStaff(req);
    const b = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
    const id = (req.params as any).id as string;
    const actor: Actor = { type: 'staff', id: staffId, name: await staffName(staffId) };
    await tx(async (c) => { await lockHotel(c, hotelId); await commentTicket(c, hotelId, await myTicket(c, hotelId, staffId, id), b.body, actor); });
    return ticketDetail(pool, hotelId, id);
  });

  /** "Report a problem" from the app. Goes to the maintenance team unassigned. */
  app.post('/mobile/v1/reports', async (req) => {
    const { staffId, hotelId } = await requireStaff(req);
    await requireModule(hotelId, 'maintenance');
    const p = await maintenancePolicy(pool, hotelId);
    if (!p.maintenance.staffCanReport) throw forbidden('Reporting problems from the app is switched off for this hotel.');
    const b = z.object({ title: z.string().trim().min(3).max(120), description: z.string().max(2000).optional(), location: z.string().trim().min(1).max(120), category: z.enum(CATEGORIES).optional() }).parse(req.body);
    const actor: Actor = { type: 'staff', id: staffId, name: await staffName(staffId) };
    const t = await tx(async (c) => { await lockHotel(c, hotelId); return createTicket(c, hotelId, { ...b, source: 'app' }, actor); });
    return ticketDetail(pool, hotelId, t.id);
  });
}
