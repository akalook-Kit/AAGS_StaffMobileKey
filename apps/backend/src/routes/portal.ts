import { EVENT_NAMES } from '../visionline-events.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MODULES, MODULE_IDS, ROLES, ROLE_LABELS, type ModuleId, type Role } from '@smk/shared';
import { pool, tx, one, many } from '../db.ts';
import { audit, verifyAuditChain } from '../audit.ts';
import {
  checkThrottle, clearFailures, hashPassword, newTotpSecret, permsIn, recordFailure, requireOperator, requirePerm,
  signToken, verifyPassword, verifyTotp,
} from '../auth.ts';
import { enqueue, newCorrelationId } from '../commands.ts';
import { csForHotel } from '../credential-services.ts';
import { CONFIG_KINDS, getConfigWithVersion, saveConfig, validateConfig, type ConfigKind } from '../hotel-config.ts';
import { approveKey, getKey, KEY_SELECT, keyView, requestKey, revokeKey } from '../keys.ts';
import { getCallbackState } from '../jobs.ts';
import { config } from '../config.ts';
import { hashToken } from './connector.ts';
import { TemplateBody } from './portal-admin.ts';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';

const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Hotel');
  return id;
};

export function portalRoutes(app: FastifyInstance) {
  // ---- Authentication ---------------------------------------------------------------------------
  app.post(`${P}/auth/login`, async (req) => {
    const b = z.object({ email: z.string().email(), password: z.string(), totp: z.string().optional() }).parse(req.body);
    const tkey = `op:${b.email.toLowerCase()}`;
    checkThrottle(tkey);
    const op = await one(pool, 'SELECT * FROM operators WHERE lower(email)=lower($1)', [b.email]);
    if (!op || op.status !== 'ACTIVE' || !verifyPassword(b.password, op.password_hash)) {
      recordFailure(tkey);
      throw new ApiError(401, 'BAD_CREDENTIALS', 'Email or password is incorrect.');
    }
    if (op.mfa_enabled) {
      if (!b.totp) return { mfaRequired: true };
      if (!verifyTotp(op.totp_secret, b.totp)) { recordFailure(tkey); throw new ApiError(401, 'BAD_TOTP', 'The authentication code is incorrect.'); }
    }
    clearFailures(tkey);
    await pool.query('UPDATE operators SET last_sign_in_at=now() WHERE id=$1', [op.id]);
    await audit(null, { hotelId: null, actorType: 'operator', actorId: op.id, action: 'operator.signed_in', details: { mfa: op.mfa_enabled } });
    return { token: await signToken({ typ: 'op', sub: op.id, mfa: op.mfa_enabled }), mfaEnabled: op.mfa_enabled };
  });

  app.post(`${P}/auth/mfa/setup`, async (req) => {
    const op = await requireOperator(req);
    const secret = newTotpSecret();
    await pool.query('UPDATE operators SET totp_secret=$2, mfa_enabled=false WHERE id=$1', [op.id, secret]);
    return { secret, otpauthUrl: `otpauth://totp/StaffMobileKey:${encodeURIComponent(op.email)}?secret=${secret}&issuer=StaffMobileKey` };
  });
  app.post(`${P}/auth/mfa/enable`, async (req) => {
    const op = await requireOperator(req);
    const { code } = z.object({ code: z.string() }).parse(req.body);
    const r = await one(pool, 'SELECT totp_secret FROM operators WHERE id=$1', [op.id]);
    if (!r?.totp_secret || !verifyTotp(r.totp_secret, code)) throw badRequest('BAD_TOTP', 'The code did not match. Check the time on your phone and try again.');
    await pool.query('UPDATE operators SET mfa_enabled=true WHERE id=$1', [op.id]);
    await audit(null, { hotelId: null, actorType: 'operator', actorId: op.id, action: 'operator.mfa_enabled' });
    return { ok: true };
  });

  app.get(`${P}/me`, async (req) => {
    const op = await requireOperator(req);
    const hotels = op.isPlatformAdmin
      ? await many(pool, 'SELECT id, slug, name FROM hotels ORDER BY name')
      : await many(pool, 'SELECT id, slug, name FROM hotels WHERE id = ANY($1) ORDER BY name', [[...op.roles.keys()]]);
    const r = await one(pool, 'SELECT mfa_enabled FROM operators WHERE id=$1', [op.id]);
    return {
      id: op.id, email: op.email, displayName: op.displayName, isPlatformAdmin: op.isPlatformAdmin, mfaEnabled: r.mfa_enabled,
      hotels: hotels.map((h) => ({ ...h, roles: op.isPlatformAdmin ? ['PLATFORM_ADMIN'] : op.roles.get(h.id), permissions: [...permsIn(op, h.id)], hiddenModules: op.hidden?.get(h.id) ?? [] })),
      roleLabels: ROLE_LABELS,
      modules: Object.fromEntries(MODULE_IDS.map((m) => [m, MODULES[m].label])),
    };
  });

  // ---- Hotels (platform administration) ----------------------------------------------------------
  app.post(`${P}/hotels`, async (req) => {
    const op = await requireOperator(req);
    if (!op.isPlatformAdmin) throw forbidden('Only platform administrators can create hotels.');
    const b = z.object({ slug: z.string().regex(/^[a-z0-9-]+$/), name: z.string().min(2), timezone: z.string() }).parse(req.body);
    const h = await one(pool, 'INSERT INTO hotels (slug, name, timezone) VALUES ($1,$2,$3) RETURNING *', [b.slug, b.name, b.timezone]);
    await audit(null, { hotelId: h.id, actorType: 'operator', actorId: op.id, action: 'hotel.created', details: b });
    return h;
  });

  // ---- Dashboard ----------------------------------------------------------------------------------
  app.get(`${P}/hotels/:hotelId/summary`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'key.read');
    const counts = await many(pool, `SELECT status, count(*)::int AS n FROM key_requests WHERE hotel_id=$1 GROUP BY status`, [hotelId]);
    const staff = await one(pool, `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM endpoints e WHERE e.staff_id=s.id AND e.status='ACTIVE'))::int AS onboarded
      FROM staff s WHERE hotel_id=$1 AND status='ACTIVE'`, [hotelId]);
    const conn = await one(pool, `SELECT name, last_seen_at, health FROM connectors WHERE hotel_id=$1 AND status='ACTIVE' ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [hotelId]);
    const recent = await many(pool, `${KEY_SELECT} WHERE k.hotel_id=$1 ORDER BY k.updated_at DESC LIMIT 8`, [hotelId]);
    return {
      keys: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      staff,
      connector: conn ? { name: conn.name, lastSeenAt: conn.last_seen_at, online: isOnline(conn.last_seen_at), health: conn.health } : null,
      recent: recent.map(keyView),
    };
  });

  // ---- Staff ----------------------------------------------------------------------------------------
  app.get(`${P}/hotels/:hotelId/staff`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'staff.read');
    const rows = await many(pool, `SELECT s.id, s.full_name, s.email, s.employee_no, s.job_role, s.visionline_user, s.visionline_user_group, s.status, s.created_at, s.source,
        (SELECT (ug.data->>'uniformAccess')::boolean FROM resources ug WHERE ug.hotel_id=s.hotel_id AND ug.kind='usergroup' AND ug.external_id=s.visionline_user_group AND ug.active) AS uniform_access,
        e.endpoint_id, e.status AS endpoint_status, e.vendor_status AS endpoint_vendor_status, e.device_label, e.activated_at,
        k.id AS key_id, k.status AS key_status, k.expires_at AS key_expires_at, k.credential_id, k.failure_message, t.name AS template_name, k.updated_at AS key_updated_at
      FROM staff s
      LEFT JOIN LATERAL (SELECT * FROM endpoints WHERE staff_id=s.id AND status IN ('INVITED','ACTIVE') ORDER BY created_at DESC LIMIT 1) e ON true
      LEFT JOIN LATERAL (SELECT * FROM key_requests WHERE staff_id=s.id ORDER BY created_at DESC LIMIT 1) k ON true
      LEFT JOIN access_templates t ON t.id=k.template_id
      WHERE s.hotel_id=$1 ORDER BY s.full_name`, [hotelId]);
    return rows;
  });

  const StaffBody = z.object({
    fullName: z.string().min(2), email: z.string().email(), employeeNo: z.string().optional().nullable(),
    jobRole: z.string().min(2).default('Housekeeper'), visionlineUser: z.string().min(1).max(100).optional().nullable(),
    visionlineUserGroup: z.string().min(1).optional().nullable(), appPassword: z.string().min(8).optional(),
  });
  app.post(`${P}/hotels/:hotelId/staff`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'staff.manage');
    const b = StaffBody.parse(req.body);
    const vlUser = b.visionlineUser ?? `smk-${(b.employeeNo ?? randomBytes(4).toString('hex')).toLowerCase()}`;
    return tx(async (c) => {
      const s = await one(c, `INSERT INTO staff (hotel_id, full_name, email, employee_no, job_role, visionline_user, visionline_user_group, password_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (hotel_id, email) DO NOTHING RETURNING *`,
        [hotelId, b.fullName, b.email, b.employeeNo ?? null, b.jobRole, vlUser, b.visionlineUserGroup ?? null, b.appPassword ? hashPassword(b.appPassword) : null]);
      if (!s) throw conflict('DUPLICATE_EMAIL', 'A staff member with this email already exists in this hotel.');
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'staff.created', targetType: 'staff', targetId: s.id, details: { fullName: b.fullName, jobRole: b.jobRole, visionlineUser: vlUser, userGroup: b.visionlineUserGroup } });
      return { id: s.id };
    });
  });
  app.patch(`${P}/hotels/:hotelId/staff/:staffId`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'staff.manage');
    const b = StaffBody.partial().extend({ status: z.enum(['ACTIVE', 'SUSPENDED', 'LEFT']).optional() }).parse(req.body);
    const id = (req.params as any).staffId;
    return tx(async (c) => {
      const s = await one(c, 'SELECT * FROM staff WHERE id=$1 AND hotel_id=$2 FOR UPDATE', [id, hotelId]);
      if (!s) throw notFound('Staff member');
      await c.query(`UPDATE staff SET full_name=COALESCE($3, full_name), job_role=COALESCE($4, job_role), visionline_user_group=COALESCE($5, visionline_user_group),
        status=COALESCE($6, status), password_hash=COALESCE($7, password_hash) WHERE id=$1 AND hotel_id=$2`,
        [id, hotelId, b.fullName ?? null, b.jobRole ?? null, b.visionlineUserGroup ?? null, b.status ?? null, b.appPassword ? hashPassword(b.appPassword) : null]);
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'staff.updated', targetType: 'staff', targetId: id, details: { ...b, appPassword: b.appPassword ? 'changed' : undefined } });
      return { ok: true, note: b.status && b.status !== 'ACTIVE' ? 'Suspending a person does not revoke live keys automatically. Revoke them from Mobile Keys.' : undefined };
    });
  });

  /** Device replacement (spec §12.3 step 3): delete the old endpoint in Credential Services first. */
  app.post(`${P}/hotels/:hotelId/staff/:staffId/endpoint/remove`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'endpoint.delete');
    const staffId = (req.params as any).staffId;
    const ep = await one(pool, `SELECT * FROM endpoints WHERE hotel_id=$1 AND staff_id=$2 AND status IN ('INVITED','ACTIVE')`, [hotelId, staffId]);
    if (!ep) throw notFound('Active phone');
    const { client } = await csForHotel(hotelId);
    try { await client.deleteEndpoint(ep.endpoint_id); } catch (e: any) { if (e.status !== 404) throw new ApiError(502, 'CS_UNAVAILABLE', `Credential Services did not delete the endpoint: ${e.message}`); }
    await tx(async (c) => {
      await c.query(`UPDATE endpoints SET status='DELETED', vendor_status='TERMINATED', updated_at=now() WHERE id=$1`, [ep.id]);
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'endpoint.deleted', targetType: 'endpoint', targetId: ep.endpoint_id, details: { staffId } });
    });
    return { ok: true };
  });

  // ---- Visionline resources ------------------------------------------------------------------------
  app.get(`${P}/hotels/:hotelId/resources`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'resources.read');
    const kind = (req.query as any).kind as string | undefined;
    const rows = await many(pool, `SELECT kind, external_id, name, data, active, discovered_at FROM resources WHERE hotel_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY kind, name`, [hotelId, kind ?? null]);
    return rows;
  });
  app.post(`${P}/hotels/:hotelId/resources/discover`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'resources.discover');
    const corr = newCorrelationId();
    const vl = (await getConfigWithVersion(hotelId, 'visionline')).data;
    const groups = await many(pool, `SELECT DISTINCT visionline_user_group AS g FROM staff WHERE hotel_id=$1 AND visionline_user_group IS NOT NULL`, [hotelId]);
    const userGroups = [...new Set([vl?.defaultUserGroup, ...(vl?.userGroups ?? []), ...groups.map((g) => g.g)].filter(Boolean))] as string[];
    const cmd = await enqueue(pool, { hotelId, type: 'DISCOVER_RESOURCES', payload: { userGroups }, idempotencyKey: `discover:${randomUUID()}`, correlationId: corr, ttlSec: 300 });
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'resources.discovery_requested', targetType: 'command', targetId: cmd.id, correlationId: corr });
    return { commandId: cmd.id };
  });
  app.post(`${P}/hotels/:hotelId/connector/validate`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'connector.manage');
    const corr = newCorrelationId();
    const cmd = await enqueue(pool, { hotelId, type: 'VALIDATE_SETUP', payload: {}, idempotencyKey: `validate:${randomUUID()}`, correlationId: corr, ttlSec: 120 });
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'connector.validation_requested', targetType: 'command', targetId: cmd.id, correlationId: corr });
    return { commandId: cmd.id };
  });
  app.get(`${P}/hotels/:hotelId/commands/:commandId`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'connector.read');
    const c = await one(pool, 'SELECT id, type, status, attempts, result, error, correlation_id, created_at, completed_at FROM commands WHERE id=$1 AND hotel_id=$2', [(req.params as any).commandId, hotelId]);
    if (!c) throw notFound('Command');
    return c;
  });
  app.get(`${P}/hotels/:hotelId/commands`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'connector.read');
    return many(pool, `SELECT id, type, status, attempts, error, correlation_id, created_at, completed_at FROM commands WHERE hotel_id=$1 ORDER BY created_at DESC LIMIT 50`, [hotelId]);
  });

  // ---- Access templates -------------------------------------------------------------------------
  app.get(`${P}/hotels/:hotelId/templates`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'resources.read');
    return many(pool, 'SELECT * FROM access_templates WHERE hotel_id=$1 ORDER BY is_broad, name', [hotelId]);
  });
  app.post(`${P}/hotels/:hotelId/templates`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'templates.manage');
    const b = TemplateBody.parse(req.body);
    if (!b.doorIds.length && !b.doorGroupIds.length && !b.userGroupIds.length) throw badRequest('EMPTY_SCOPE', 'A template needs at least one door, door group or user group.');
    const t = await one(pool, `INSERT INTO access_templates (hotel_id, name, description, door_ids, door_group_ids, user_group_ids, allowed_job_roles, is_broad, max_validity_hours, time_schedule)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (hotel_id, name) DO NOTHING RETURNING *`,
      [hotelId, b.name, b.description ?? null, b.doorIds, b.doorGroupIds, b.userGroupIds, b.allowedJobRoles, b.isBroad, b.maxValidityHours, b.timeSchedule ?? null]);
    if (!t) throw conflict('DUPLICATE', 'A template with this name exists.');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'template.created', targetType: 'template', targetId: t.id, details: b });
    return t;
  });
  app.delete(`${P}/hotels/:hotelId/templates/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'templates.manage');
    const id = (req.params as any).id;
    const used = await one(pool, `SELECT 1 FROM key_requests WHERE template_id=$1 LIMIT 1`, [id]);
    if (used) throw conflict('IN_USE', 'This template has been used for keys and is kept for the audit trail.');
    await pool.query('DELETE FROM access_templates WHERE id=$1 AND hotel_id=$2', [id, hotelId]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'template.deleted', targetType: 'template', targetId: id });
    return { ok: true };
  });

  // ---- Keys -------------------------------------------------------------------------------------------
  app.get(`${P}/hotels/:hotelId/keys`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'key.read');
    const q = z.object({ status: z.string().optional(), staffId: z.string().uuid().optional(), limit: z.coerce.number().int().max(500).default(100) }).parse(req.query);
    const statuses = q.status ? q.status.split(',') : null;
    const rows = await many(pool, `${KEY_SELECT} WHERE k.hotel_id=$1 AND ($2::text[] IS NULL OR k.status = ANY($2)) AND ($3::uuid IS NULL OR k.staff_id=$3) ORDER BY k.created_at DESC LIMIT $4`,
      [hotelId, statuses, q.staffId ?? null, q.limit]);
    return rows.map(keyView);
  });
  app.get(`${P}/hotels/:hotelId/keys/:id`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'key.read');
    const k = await getKey(pool, hotelId, (req.params as any).id);
    if (!k) throw notFound('Key');
    const trail = await many(pool, `SELECT a.seq, a.at, a.actor_type, a.action, a.details, o.display_name AS actor_name FROM audit_log a LEFT JOIN operators o ON o.id::text=a.actor_id
      WHERE a.hotel_id=$1 AND (a.target_id=$2 OR a.correlation_id=$3) ORDER BY a.seq`, [hotelId, k.id, k.correlationId]);
    const lockEvents = (await many(pool, `SELECT received_at, kind, card_status, event_code, door_id, event_time FROM visionline_events WHERE hotel_id=$1 AND key_id=$2 ORDER BY received_at DESC LIMIT 50`, [hotelId, k.id]))
      .map((e) => ({ ...e, eventName: e.event_code != null ? EVENT_NAMES[e.event_code] ?? `Event ${e.event_code}` : null }));
    return { ...k, trail, lockEvents };
  });
  app.post(`${P}/hotels/:hotelId/keys`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'key.issue');
    const idem = String(req.headers['idempotency-key'] ?? '');
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(idem)) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8–100 characters) so a retried request cannot issue twice.');
    const b = z.object({
      staffId: z.string().uuid(), templateId: z.string().uuid().optional().nullable(), doorIds: z.array(z.string()).default([]), doorGroupIds: z.array(z.string()).default([]),
      userGroupIds: z.array(z.string()).default([]), startsAt: z.string().datetime().optional().nullable(), expiresAt: z.string().datetime(), reason: z.string().max(300).optional().nullable(),
    }).parse(req.body);
    const r = await requestKey(op, hotelId, b, idem);
    return reply.code(r.replayed ? 200 : 201).header('idempotent-replay', String(r.replayed)).send(r.key);
  });
  app.post(`${P}/hotels/:hotelId/keys/:id/approve`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'key.approve_broad');
    const b = z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {});
    return approveKey(op, hotelId, (req.params as any).id, true, b.note);
  });
  app.post(`${P}/hotels/:hotelId/keys/:id/reject`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'key.approve_broad');
    const b = z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {});
    return approveKey(op, hotelId, (req.params as any).id, false, b.note);
  });
  app.post(`${P}/hotels/:hotelId/keys/:id/revoke`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'key.revoke');
    const b = z.object({ reason: z.string().min(3).max(300), method: z.enum(['checkout', 'cancelCard']).default('checkout') }).parse(req.body);
    return revokeKey(op, hotelId, (req.params as any).id, b.reason, b.method);
  });

  // ---- Operators and roles ------------------------------------------------------------------------
  app.get(`${P}/hotels/:hotelId/operators`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'operators.manage');
    return many(pool, `SELECT o.id, o.email, o.display_name, o.status, o.mfa_enabled, o.last_sign_in_at, o.idp_subject, array_agg(m.role ORDER BY m.role) AS roles,
        COALESCE((SELECT a.hidden_modules FROM operator_module_access a WHERE a.operator_id=o.id AND a.hotel_id=$1), '{}') AS hidden_modules
      FROM operators o JOIN memberships m ON m.operator_id=o.id WHERE m.hotel_id=$1 GROUP BY o.id ORDER BY o.display_name`, [hotelId]);
  });
  /** 2.8: hide portal modules from one person (menu and permissions). */
  app.put(`${P}/hotels/:hotelId/operators/:operatorId/modules`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'operators.manage');
    const b = z.object({ hidden: z.array(z.enum(MODULE_IDS as [ModuleId, ...ModuleId[]])).max(MODULE_IDS.length) }).parse(req.body);
    const target = (req.params as any).operatorId as string;
    if (target === op.id) throw forbidden('You cannot hide modules from yourself.');
    if (!(await one(pool, 'SELECT 1 FROM memberships WHERE operator_id=$1 AND hotel_id=$2', [target, hotelId]))) throw notFound('Operator');
    const before = (await one(pool, 'SELECT hidden_modules FROM operator_module_access WHERE operator_id=$1 AND hotel_id=$2', [target, hotelId]))?.hidden_modules ?? [];
    await pool.query(`INSERT INTO operator_module_access (operator_id, hotel_id, hidden_modules) VALUES ($1,$2,$3)
      ON CONFLICT (operator_id, hotel_id) DO UPDATE SET hidden_modules=EXCLUDED.hidden_modules, updated_at=now()`, [target, hotelId, [...new Set(b.hidden)]]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'operator.modules_changed', targetType: 'operator', targetId: target, details: { before, after: b.hidden } });
    return { ok: true };
  });
  app.post(`${P}/hotels/:hotelId/operators`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'operators.manage');
    const b = z.object({ email: z.string().email(), displayName: z.string().min(2), roles: z.array(z.enum(ROLES)).min(1), tempPassword: z.string().min(10) }).parse(req.body);
    if (b.roles.includes('PLATFORM_ADMIN')) throw forbidden('Platform administrators are created by the platform team.');
    return tx(async (c) => {
      let o = await one(c, 'SELECT id FROM operators WHERE lower(email)=lower($1)', [b.email]);
      if (!o) o = await one(c, `INSERT INTO operators (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id`, [b.email, b.displayName, hashPassword(b.tempPassword)]);
      for (const r of b.roles) await c.query('INSERT INTO memberships (operator_id, hotel_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [o.id, hotelId, r]);
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'operator.added', targetType: 'operator', targetId: o.id, details: { email: b.email, roles: b.roles } });
      return { id: o.id };
    });
  });
  app.put(`${P}/hotels/:hotelId/operators/:operatorId/roles`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'operators.manage');
    const b = z.object({ roles: z.array(z.enum(ROLES)) }).parse(req.body);
    const target = (req.params as any).operatorId;
    if (target === op.id) throw forbidden('You cannot change your own roles.');
    if (b.roles.includes('PLATFORM_ADMIN')) throw forbidden('Platform administrators are created by the platform team.');
    return tx(async (c) => {
      const before = (await many(c, 'SELECT role FROM memberships WHERE operator_id=$1 AND hotel_id=$2', [target, hotelId])).map((r) => r.role as Role);
      await c.query('DELETE FROM memberships WHERE operator_id=$1 AND hotel_id=$2', [target, hotelId]);
      for (const r of b.roles) await c.query('INSERT INTO memberships (operator_id, hotel_id, role) VALUES ($1,$2,$3)', [target, hotelId, r]);
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'operator.roles_changed', targetType: 'operator', targetId: target, details: { before, after: b.roles } });
      return { ok: true };
    });
  });

  // ---- Connectors ---------------------------------------------------------------------------------
  app.get(`${P}/hotels/:hotelId/connectors`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'connector.read');
    const rows = await many(pool, `SELECT id, name, status, installation_uuid, last_seen_at, health, created_at FROM connectors WHERE hotel_id=$1 ORDER BY created_at`, [hotelId]);
    const queue = await one(pool, `SELECT count(*) FILTER (WHERE status='PENDING')::int AS pending, count(*) FILTER (WHERE status='LEASED')::int AS leased,
      count(*) FILTER (WHERE status='EXPIRED' AND created_at > now() - interval '24 hours')::int AS expired24h,
      count(*) FILTER (WHERE status='FAILED' AND created_at > now() - interval '24 hours')::int AS failed24h FROM commands WHERE hotel_id=$1`, [hotelId]);
    return { connectors: rows.map((r) => ({ ...r, online: isOnline(r.last_seen_at) })), queue, callbacks: getCallbackState(hotelId) };
  });
  app.post(`${P}/hotels/:hotelId/connectors`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'connector.manage');
    const b = z.object({ name: z.string().min(2) }).parse(req.body);
    const token = `smkc_${randomBytes(32).toString('base64url')}`;
    const c = await one(pool, 'INSERT INTO connectors (hotel_id, name, token_hash) VALUES ($1,$2,$3) RETURNING id', [hotelId, b.name, hashToken(token)]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'connector.registered', targetType: 'connector', targetId: c.id, details: { name: b.name } });
    return { id: c.id, token, note: 'Copy this token into the connector setup now. It is shown only once.' };
  });
  app.post(`${P}/hotels/:hotelId/connectors/:id/disable`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'connector.manage');
    await pool.query(`UPDATE connectors SET status='DISABLED' WHERE id=$1 AND hotel_id=$2`, [(req.params as any).id, hotelId]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'connector.disabled', targetType: 'connector', targetId: (req.params as any).id });
    return { ok: true };
  });

  // ---- Configuration (branding, property, features, policy, integrations) -------------------------
  const configPerm = (kind: ConfigKind) => (kind === 'branding' || kind === 'app_policy' ? 'branding.manage' : 'settings.manage');
  app.get(`${P}/hotels/:hotelId/config/:kind`, async (req) => {
    const hotelId = hid(req);
    const kind = (req.params as any).kind as ConfigKind;
    if (!CONFIG_KINDS.includes(kind)) throw notFound('Configuration');
    await requirePerm(req, hotelId, 'staff.read');
    return getConfigWithVersion(hotelId, kind);
  });
  app.put(`${P}/hotels/:hotelId/config/:kind`, async (req) => {
    const hotelId = hid(req);
    const kind = (req.params as any).kind as ConfigKind;
    if (!CONFIG_KINDS.includes(kind)) throw notFound('Configuration');
    const op = await requirePerm(req, hotelId, configPerm(kind));
    const data = await validateConfig(pool, hotelId, kind, req.body);
    const version = await tx(async (c) => {
      const v = await saveConfig(c, hotelId, kind, data, op.id);
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'config.published', targetType: 'config', targetId: kind, details: { version: v, data: kind === 'branding' ? { ...data, logo: data.logo ? '[image]' : null, heroImage: data.heroImage ? '[image]' : null } : data } });
      return v;
    });
    return { kind, version };
  });
  app.post(`${P}/hotels/:hotelId/config/:kind/rollback/:version`, async (req) => {
    const hotelId = hid(req);
    const kind = (req.params as any).kind as ConfigKind;
    if (!CONFIG_KINDS.includes(kind)) throw notFound('Configuration');
    const op = await requirePerm(req, hotelId, configPerm(kind));
    const old = await one(pool, 'SELECT data FROM hotel_config_versions WHERE hotel_id=$1 AND kind=$2 AND version=$3', [hotelId, kind, Number((req.params as any).version)]);
    if (!old) throw notFound('Configuration version');
    const data = await validateConfig(pool, hotelId, kind, old.data);
    const v = await tx(async (c) => {
      const nv = await saveConfig(c, hotelId, kind, data, op.id);
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'config.rolled_back', targetType: 'config', targetId: kind, details: { from: Number((req.params as any).version), newVersion: nv } });
      return nv;
    });
    return { kind, version: v };
  });

  /** Guided Visionline/Mobile Access readiness checklist (spec §13.4.5). */
  app.get(`${P}/hotels/:hotelId/readiness`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'connector.read');
    const conn = await one(pool, `SELECT last_seen_at, health FROM connectors WHERE hotel_id=$1 AND status='ACTIVE' ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [hotelId]);
    const h = conn?.health ?? {};
    const res = await many(pool, `SELECT kind, count(*) FILTER (WHERE active)::int AS n FROM resources WHERE hotel_id=$1 GROUP BY kind`, [hotelId]);
    const n = (k: string) => res.find((r) => r.kind === k)?.n ?? 0;
    const vl = (await getConfigWithVersion(hotelId, 'visionline')).data;
    const ugs = await many(pool, `SELECT external_id FROM resources WHERE hotel_id=$1 AND kind='usergroup' AND active`, [hotelId]);
    const cb = getCallbackState(hotelId);
    const { VENDOR_CONFIRMATION_REQUIRED, VENDOR_DECISIONS } = await import('@smk/shared/node');
    const csCfg = (await getConfigWithVersion(hotelId, 'credential_services')).data;
    const accounts = await many(pool, `SELECT name, data FROM resources WHERE hotel_id=$1 AND kind='mobileaccessaccount' AND active`, [hotelId]);
    const account = accounts.find((a) => !vl?.accountName || a.name === vl.accountName) ?? accounts[0];
    const accountSystemId = account?.data?.systemID != null ? Number(account.data.systemID) : null;
    const item = (id: string, label: string, ok: boolean, detail: string) => ({ id, label, ok, detail });
    return {
      checks: [
        item('connector', 'Hotel connector online', isOnline(conn?.last_seen_at), conn?.last_seen_at ? `Last seen ${Math.round((Date.now() - new Date(conn.last_seen_at).getTime()) / 1000)} s ago` : 'No connector has checked in'),
        item('credentials', 'Property Visionline credentials stored on the connector', Boolean(h.credentialsConfigured), h.credentialsConfigured ? `Operator ${h.propertyUsername ?? ''} · encrypted on the Visionline PC` : 'Enter them under Settings → Visionline (or on the connector page)'),
        item('tls', 'Visionline certificate trusted', String(h.tlsTrust ?? '').startsWith('verified'), h.tlsTrust ?? 'unknown'),
        item('api', 'Visionline Web API reachable and session created', Boolean(h.visionlineReachable && h.lastSuccessfulSessionAt), h.visionlineReachable && h.lastSuccessfulSessionAt ? `Last session ${h.lastSuccessfulSessionAt}` : h.lastError ?? 'No session yet'),
        item('clock', 'Clock within 15 minutes of Visionline', Math.abs(h.clockOffsetMs ?? 0) < 5 * 60_000, `Offset ${Math.round((h.clockOffsetMs ?? 0) / 1000)} s`),
        item('discovery', 'Doors, user groups and accounts discovered', n('door') > 0 && n('mobileaccessaccount') > 0, `${n('door')} doors, ${n('timeschedule')} time schedules, ${n('mobileaccessaccount')} mobile access accounts`),
        item('mobileAccess', 'Visionline Mobile Access options recorded', vl?.mobileAccessUuid != null, vl?.mobileAccessUuid != null ? `UUID ${vl.mobileAccessUuid} · revoke mobile key when ${vl.revokeMode ?? 'overridden'}` : 'Copy them from Visionline → Options → Mobile Access into Settings → Visionline'),
        item('staffGroup', 'Staff user group exists in Visionline', Boolean(vl?.defaultUserGroup && ugs.some((u) => u.external_id === vl.defaultUserGroup)), vl?.defaultUserGroup ?? 'Not configured'),
        item('watch', 'Visionline watch running (cancelled cards, wrong doors)', String(h.visionlineWatch ?? '').startsWith('watching'), h.visionlineWatch ?? 'Connector 0.3.0 or newer needed'),
        item('systemId', 'Credential Services System ID matches Visionline', accountSystemId != null && Number(csCfg?.systemId) === accountSystemId,
          accountSystemId == null ? 'Run discovery to read the mobile access account from Visionline' : Number(csCfg?.systemId) === accountSystemId ? `System ID ${accountSystemId} (${account.name})` : `Settings → Credential Services has ${csCfg?.systemId ?? 'none'}; Visionline account ${account.name} uses ${accountSystemId}`),
        item('cs', 'Credential Services callbacks registered', Boolean(cb?.ok), cb?.ok ? cb.url ?? '' : cb?.error ?? 'Not attempted yet'),
      ],
      vendorConfirmations: VENDOR_CONFIRMATION_REQUIRED,
      vendorDecisions: VENDOR_DECISIONS,
      connectorHealth: h,
    };
  });

  // ---- Audit --------------------------------------------------------------------------------------
  app.get(`${P}/hotels/:hotelId/audit`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'audit.read');
    const q = z.object({ before: z.coerce.number().optional(), action: z.string().optional(), limit: z.coerce.number().int().max(200).default(50) }).parse(req.query);
    return many(pool, `SELECT a.seq, a.at, a.actor_type, a.actor_id, a.action, a.target_type, a.target_id, a.correlation_id, a.details, a.hash,
        COALESCE(o.display_name, s.full_name, c.name) AS actor_name
      FROM audit_log a LEFT JOIN operators o ON a.actor_type='operator' AND o.id::text=a.actor_id
      LEFT JOIN staff s ON a.actor_type='staff' AND s.id::text=a.actor_id LEFT JOIN connectors c ON a.actor_type='connector' AND c.id::text=a.actor_id
      WHERE a.hotel_id=$1 AND ($2::bigint IS NULL OR a.seq < $2) AND ($3::text IS NULL OR a.action LIKE $3 || '%')
      ORDER BY a.seq DESC LIMIT $4`, [hotelId, q.before ?? null, q.action ?? null, q.limit]);
  });
  app.get(`${P}/hotels/:hotelId/audit/verify`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'audit.read');
    return verifyAuditChain(hotelId);
  });
  app.get(`${P}/hotels/:hotelId/audit/export`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'audit.export');
    const rows = await many(pool, `SELECT seq, at, actor_type, actor_id, action, target_type, target_id, correlation_id, details, prev_hash, hash FROM audit_log WHERE hotel_id=$1 ORDER BY seq`, [hotelId]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'audit.exported', details: { records: rows.length } });
    const esc = (v: unknown) => { const s = typeof v === 'string' ? v : v == null ? '' : v instanceof Date ? v.toISOString() : JSON.stringify(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = 'seq,at,actor_type,actor_id,action,target_type,target_id,correlation_id,details,prev_hash,hash';
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="audit-${hotelId}.csv"`);
    return [head, ...rows.map((r) => [r.seq, r.at, r.actor_type, r.actor_id, r.action, r.target_type, r.target_id, r.correlation_id, r.details, r.prev_hash, r.hash].map(esc).join(','))].join('\n');
  });
}

export function isOnline(lastSeen: string | Date | null | undefined) {
  return Boolean(lastSeen && Date.now() - new Date(lastSeen).getTime() < config.connectorOfflineAfterSec * 1000);
}
