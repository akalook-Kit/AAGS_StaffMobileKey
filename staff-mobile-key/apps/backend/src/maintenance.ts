import type pg from 'pg';
import { one, many } from './db.ts';
import { audit } from './audit.ts';
import { getConfig, SCHEMAS } from './hotel-config.ts';
import { notify } from './keys.ts';
import { badRequest, conflict, forbidden, notFound } from './lib/errors.ts';

/**
 * Maintenance requests (spec Phase 2, §13.4 Maintenance screen): create, assign, acknowledge, track and close,
 * with comments, attachments, priority, due dates and a complete resolution history.
 */
export type Actor = { type: 'operator' | 'staff' | 'system'; id: string | null; name: string };
export const SYSTEM: Actor = { type: 'system', id: null, name: 'Platform' };

export const TICKET_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CLOSED', 'CANCELLED'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const OPEN_STATUSES: TicketStatus[] = ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ON_HOLD'];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const CATEGORIES = ['battery', 'lock', 'door', 'room', 'electrical', 'plumbing', 'other'] as const;

const NEXT: Record<TicketStatus, TicketStatus[]> = {
  OPEN: ['ACKNOWLEDGED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CANCELLED'],
  ACKNOWLEDGED: ['IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'RESOLVED', 'CANCELLED'],
  ON_HOLD: ['IN_PROGRESS', 'RESOLVED', 'CANCELLED'],
  RESOLVED: ['CLOSED', 'OPEN'],
  CLOSED: ['OPEN'],
  CANCELLED: ['OPEN'],
};
/** Moves only a maintenance manager may make: close, cancel, reopen. */
const MANAGER_ONLY: TicketStatus[] = ['CLOSED', 'CANCELLED', 'OPEN'];
export const STATUS_LABEL: Record<TicketStatus, string> = {
  OPEN: 'Open', ACKNOWLEDGED: 'Acknowledged', IN_PROGRESS: 'In progress', ON_HOLD: 'On hold', RESOLVED: 'Resolved', CLOSED: 'Closed', CANCELLED: 'Cancelled',
};

export async function maintenancePolicy(db: pg.Pool | pg.PoolClient, hotelId: string) {
  return SCHEMAS.policy.parse((await getConfig(db, hotelId, 'policy')) ?? {});
}

export async function activity(c: pg.PoolClient, hotelId: string, ticketId: string, actor: Actor, kind: string, body: string | null, data: Record<string, unknown> = {}) {
  await c.query(`INSERT INTO maintenance_activity (hotel_id, ticket_id, actor_type, actor_id, actor_name, kind, body, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [hotelId, ticketId, actor.type, actor.id, actor.name, kind, body, data]);
}

const auditActor = (a: Actor) => ({ actorType: a.type, actorId: a.id });
/** "Replace lock battery: 104 · Floor 1" without repeating the door name already in the title. */
const summaryLine = (title: string, location: string | null) => {
  if (!location) return title;
  const extra = location.split(' · ').filter((part) => !title.includes(part)).join(' · ');
  return extra ? `${title} · ${extra}` : title;
};

/** Staff with the hotel's maintenance job roles hear about new unassigned requests and battery alarms. */
export async function notifyMaintenanceTeam(c: pg.PoolClient, hotelId: string, title: string, body: string, exceptStaffId?: string | null) {
  const p = await maintenancePolicy(c, hotelId);
  if (!p.maintenance.notifyJobRoles.length) return 0;
  const rows = await many(c, `SELECT id FROM staff WHERE hotel_id=$1 AND status='ACTIVE' AND job_role = ANY($2)`, [hotelId, p.maintenance.notifyJobRoles]);
  for (const r of rows) if (r.id !== exceptStaffId) await notify(c, hotelId, r.id, title, body);
  return rows.length;
}

export interface NewTicket {
  title: string; description?: string; category?: (typeof CATEGORIES)[number]; priority?: (typeof PRIORITIES)[number];
  doorId?: string | null; location?: string | null; asset?: string | null; dueAt?: string | null; assigneeStaffId?: string | null;
  source: 'portal' | 'app' | 'battery'; batteryAlertId?: string | null;
}

export async function createTicket(c: pg.PoolClient, hotelId: string, t: NewTicket, actor: Actor) {
  const p = await maintenancePolicy(c, hotelId);
  const priority = t.priority ?? 'normal';
  if (t.assigneeStaffId) await requireAssignable(c, hotelId, t.assigneeStaffId);
  let doorId = t.doorId ?? null;
  let location = t.location?.trim() || null;
  if (doorId) {
    const d = await one(c, `SELECT external_id, name, data->>'doorGroup' AS g FROM resources WHERE hotel_id=$1 AND kind='door' AND external_id=$2`, [hotelId, doorId]);
    if (!d) throw badRequest('UNKNOWN_DOOR', 'That door is not in the discovered Visionline doors.');
    location ??= d.g ? `${d.name} · ${d.g}` : d.name;
  } else if (location) {
    // "Room 204" typed in the app: link it to the Visionline door when the name matches exactly.
    const d = await one(c, `SELECT external_id FROM resources WHERE hotel_id=$1 AND kind='door' AND active AND (lower(name)=lower($2) OR lower(external_id)=lower($2)) LIMIT 1`, [hotelId, location.replace(/^room\s+/i, '')]);
    doorId = d?.external_id ?? null;
  }
  const dueAt = t.dueAt ? new Date(t.dueAt) : new Date(Date.now() + p.maintenance.dueHours[priority] * 3600_000);
  if (Number.isNaN(dueAt.getTime())) throw badRequest('BAD_DUE_DATE', 'The due date is not a valid date.');
  const row = await one(c, `INSERT INTO maintenance_tickets (hotel_id, number, title, description, category, priority, door_id, location, asset, source, battery_alert_id,
      assignee_staff_id, created_by_type, created_by_id, due_at)
    VALUES ($1, COALESCE((SELECT MAX(number) FROM maintenance_tickets WHERE hotel_id=$1), 0) + 1, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [hotelId, t.title.trim(), t.description?.trim() ?? '', t.category ?? 'other', priority, doorId, location, t.asset?.trim() || null, t.source, t.batteryAlertId ?? null,
      t.assigneeStaffId ?? null, actor.type, actor.id, dueAt]);
  await activity(c, hotelId, row.id, actor, 'created', t.description?.trim() || null, { title: row.title, priority, category: row.category, source: t.source });
  await audit(c, { hotelId, ...auditActor(actor), action: 'maintenance.created', targetType: 'maintenance_ticket', targetId: row.id, details: { number: row.number, title: row.title, priority, category: row.category, doorId, source: t.source } });
  if (row.assignee_staff_id) {
    const s = await one(c, 'SELECT full_name FROM staff WHERE id=$1', [row.assignee_staff_id]);
    await activity(c, hotelId, row.id, actor, 'assigned', null, { to: row.assignee_staff_id, toName: s?.full_name });
    await notify(c, hotelId, row.assignee_staff_id, `New task #${row.number}`, summaryLine(row.title, location));
  } else {
    await notifyMaintenanceTeam(c, hotelId, `New maintenance request #${row.number}`, summaryLine(row.title, location), actor.type === 'staff' ? actor.id : null);
  }
  return row;
}

async function requireAssignable(c: pg.PoolClient, hotelId: string, staffId: string) {
  const s = await one(c, `SELECT id, status FROM staff WHERE hotel_id=$1 AND id=$2`, [hotelId, staffId]);
  if (!s) throw badRequest('UNKNOWN_STAFF', 'That staff member does not exist.');
  if (s.status !== 'ACTIVE') throw badRequest('STAFF_NOT_ACTIVE', 'That staff member is not active.');
}

export async function lockTicket(c: pg.PoolClient, hotelId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Maintenance request');
  const t = await one(c, 'SELECT * FROM maintenance_tickets WHERE hotel_id=$1 AND id=$2 FOR UPDATE', [hotelId, id]);
  if (!t) throw notFound('Maintenance request');
  return t;
}

/** Change the status. `manager` = the actor may close, cancel and reopen. A resolution note is required to resolve. */
export async function changeStatus(c: pg.PoolClient, hotelId: string, t: any, to: TicketStatus, actor: Actor, opts: { manager: boolean; note?: string | null; batteryReplaced?: boolean }) {
  const from = t.status as TicketStatus;
  if (from === to) return t;
  if (!NEXT[from].includes(to)) throw conflict('BAD_TRANSITION', `A request that is ${STATUS_LABEL[from].toLowerCase()} cannot become ${STATUS_LABEL[to].toLowerCase()}.`);
  if (MANAGER_ONLY.includes(to) && !opts.manager) throw forbidden('Only a maintenance manager can close, cancel or reopen a request.');
  const note = opts.note?.trim() || null;
  if (to === 'RESOLVED' && (!note || note.length < 3)) throw badRequest('RESOLUTION_REQUIRED', 'Say what was done before marking the request resolved.');
  const sets: string[] = ['status=$3', 'updated_at=now()'];
  if (to === 'ACKNOWLEDGED') sets.push('acknowledged_at=COALESCE(acknowledged_at, now())');
  if (to === 'IN_PROGRESS') sets.push('acknowledged_at=COALESCE(acknowledged_at, now())');
  if (to === 'RESOLVED') sets.push('resolved_at=now()', 'resolution=$4');
  if (to === 'CLOSED') sets.push('closed_at=now()');
  if (to === 'OPEN') sets.push('resolved_at=NULL', 'closed_at=NULL');
  const params: unknown[] = [hotelId, t.id, to];
  if (to === 'RESOLVED') params.push(note);
  const row = await one(c, `UPDATE maintenance_tickets SET ${sets.join(', ')} WHERE hotel_id=$1 AND id=$2 RETURNING *`, params);
  await activity(c, hotelId, t.id, actor, 'status', note, { from, to, batteryReplaced: opts.batteryReplaced || undefined });
  await audit(c, { hotelId, ...auditActor(actor), action: 'maintenance.status_changed', targetType: 'maintenance_ticket', targetId: t.id, details: { number: t.number, from, to, note } });
  // Tell the assignee when someone else moves their task.
  if (t.assignee_staff_id && !(actor.type === 'staff' && actor.id === t.assignee_staff_id) && ['CLOSED', 'CANCELLED', 'OPEN'].includes(to))
    await notify(c, hotelId, t.assignee_staff_id, `Task #${t.number} ${STATUS_LABEL[to].toLowerCase()}`, t.title);
  if (t.battery_alert_id && (to === 'RESOLVED' || to === 'CLOSED')) {
    const { resolveAlertFromTicket } = await import('./battery.ts');
    await resolveAlertFromTicket(c, hotelId, row, actor, Boolean(opts.batteryReplaced));
  }
  return row;
}

export async function assignTicket(c: pg.PoolClient, hotelId: string, t: any, staffId: string | null, actor: Actor) {
  if ((t.assignee_staff_id ?? null) === staffId) return t;
  if (staffId) await requireAssignable(c, hotelId, staffId);
  const row = await one(c, `UPDATE maintenance_tickets SET assignee_staff_id=$3, updated_at=now() WHERE hotel_id=$1 AND id=$2 RETURNING *`, [hotelId, t.id, staffId]);
  const s = staffId ? await one(c, 'SELECT full_name FROM staff WHERE id=$1', [staffId]) : null;
  await activity(c, hotelId, t.id, actor, 'assigned', null, { from: t.assignee_staff_id, to: staffId, toName: s?.full_name ?? null });
  await audit(c, { hotelId, ...auditActor(actor), action: 'maintenance.assigned', targetType: 'maintenance_ticket', targetId: t.id, details: { number: t.number, to: staffId } });
  if (staffId) await notify(c, hotelId, staffId, `New task #${t.number}`, summaryLine(t.title, t.location));
  if (t.assignee_staff_id) await notify(c, hotelId, t.assignee_staff_id, `Task #${t.number} reassigned`, `${t.title} was given to ${s?.full_name ?? 'nobody yet'}.`);
  return row;
}

export async function commentTicket(c: pg.PoolClient, hotelId: string, t: any, body: string, actor: Actor) {
  const text = body.trim();
  if (!text) throw badRequest('EMPTY_COMMENT', 'Write a comment first.');
  await activity(c, hotelId, t.id, actor, 'comment', text);
  await c.query('UPDATE maintenance_tickets SET updated_at=now() WHERE id=$1', [t.id]);
  await audit(c, { hotelId, ...auditActor(actor), action: 'maintenance.commented', targetType: 'maintenance_ticket', targetId: t.id, details: { number: t.number } });
  if (t.assignee_staff_id && !(actor.type === 'staff' && actor.id === t.assignee_staff_id))
    await notify(c, hotelId, t.assignee_staff_id, `Comment on task #${t.number}`, text.length > 120 ? `${text.slice(0, 117)}…` : text);
}

/** Attachments: photos and PDFs, checked by their first bytes rather than by the name the browser gives. */
const MAX_ATTACHMENT = 3 * 1024 * 1024;
export function checkAttachment(filename: string, base64: string) {
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) throw badRequest('EMPTY_FILE', 'The file is empty.');
  if (buf.length > MAX_ATTACHMENT) throw badRequest('FILE_TOO_LARGE', 'Attachments can be up to 3 MB.');
  const head = buf.subarray(0, 12);
  const type = head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
    : head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? 'image/jpeg'
    : head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp'
    : head.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf' : null;
  if (!type) throw badRequest('FILE_TYPE', 'Attach a photo (PNG, JPEG or WebP) or a PDF.');
  const clean = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'attachment';
  return { buf, type, filename: clean };
}

export async function ticketDetail(db: pg.Pool | pg.PoolClient, hotelId: string, id: string) {
  const t = await one(db, `${TICKET_SELECT} WHERE t.hotel_id=$1 AND t.id=$2`, [hotelId, id]);
  if (!t) throw notFound('Maintenance request');
  const acts = await many(db, `SELECT id, at, actor_type, actor_name, kind, body, data FROM maintenance_activity WHERE ticket_id=$1 ORDER BY id`, [id]);
  const atts = await many(db, `SELECT id, filename, content_type, size_bytes, uploaded_by_name, created_at FROM maintenance_attachments WHERE ticket_id=$1 ORDER BY created_at`, [id]);
  return { ...ticketView(t), activity: acts.map((a) => ({ id: Number(a.id), at: a.at, actorType: a.actor_type, actorName: a.actor_name, kind: a.kind, body: a.body, data: a.data })),
    attachments: atts.map((a) => ({ id: a.id, filename: a.filename, contentType: a.content_type, size: a.size_bytes, uploadedBy: a.uploaded_by_name, at: a.created_at })) };
}

export const TICKET_SELECT = `SELECT t.*, s.full_name AS assignee_name, d.name AS door_name, d.data->>'doorGroup' AS door_group,
    ba.severity AS alert_severity, ba.status AS alert_status,
    (SELECT count(*)::int FROM maintenance_attachments a WHERE a.ticket_id=t.id) AS attachment_count,
    (SELECT count(*)::int FROM maintenance_activity a WHERE a.ticket_id=t.id AND a.kind='comment') AS comment_count,
    COALESCE(o.display_name, cs.full_name, CASE WHEN t.created_by_type='system' THEN 'Battery monitoring' END) AS created_by_name
  FROM maintenance_tickets t
  LEFT JOIN staff s ON s.id=t.assignee_staff_id
  LEFT JOIN resources d ON d.hotel_id=t.hotel_id AND d.kind='door' AND d.external_id=t.door_id
  LEFT JOIN battery_alerts ba ON ba.id=t.battery_alert_id
  LEFT JOIN operators o ON t.created_by_type='operator' AND o.id::text=t.created_by_id
  LEFT JOIN staff cs ON t.created_by_type='staff' AND cs.id::text=t.created_by_id`;

export function ticketView(t: any) {
  const open = OPEN_STATUSES.includes(t.status);
  return {
    id: t.id, number: t.number, title: t.title, description: t.description, category: t.category, priority: t.priority, status: t.status,
    doorId: t.door_id, doorName: t.door_name ?? null, doorGroup: t.door_group ?? null, location: t.location, asset: t.asset, source: t.source,
    batteryAlertId: t.battery_alert_id, alertSeverity: t.alert_severity ?? null, alertStatus: t.alert_status ?? null,
    assigneeStaffId: t.assignee_staff_id, assigneeName: t.assignee_name ?? null, createdBy: t.created_by_name ?? null, createdByType: t.created_by_type,
    dueAt: t.due_at, overdue: Boolean(open && t.due_at && new Date(t.due_at) < new Date()),
    acknowledgedAt: t.acknowledged_at, resolvedAt: t.resolved_at, closedAt: t.closed_at, resolution: t.resolution,
    createdAt: t.created_at, updatedAt: t.updated_at, attachments: t.attachment_count ?? 0, comments: t.comment_count ?? 0,
  };
}
