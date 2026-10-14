import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SealedSecret } from '@smk/shared';
import { pool, tx, one, many } from '../db.ts';
import { audit } from '../audit.ts';
import { hashPassword, requireOperator, requirePerm, verifyPassword } from '../auth.ts';
import { enqueue, newCorrelationId } from '../commands.ts';
import { getConfig } from '../hotel-config.ts';
import { requestKey } from '../keys.ts';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors.ts';

const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Hotel');
  return id;
};
async function activeConnector(hotelId: string) {
  return one(pool, `SELECT id, seal_public_key, seal_key_id, last_seen_at FROM connectors WHERE hotel_id=$1 AND status='ACTIVE' AND seal_key_id IS NOT NULL ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [hotelId]);
}
async function requireCurrentKey(hotelId: string, sealed: z.infer<typeof SealedSecret>) {
  const c = await activeConnector(hotelId);
  if (!c) throw conflict('CONNECTOR_NOT_READY', 'The hotel connector has not registered its encryption key yet. Check Connector health.');
  if (c.seal_key_id !== sealed.keyId) throw conflict('STALE_SEALING_KEY', 'The connector key changed while you were typing. Reload the page and try again.');
  return c;
}

/**
 * Iteration 2 endpoints: sealed Visionline credentials (property and personal), operator self-service,
 * Visionline user groups, "change doors" (key replacement), and staff import.
 */
export function portalAdminRoutes(app: FastifyInstance) {
  // ---- Connector sealing key (public) --------------------------------------------------------------
  app.get(`${P}/hotels/:hotelId/connector/sealing-key`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'staff.read');
    const c = await activeConnector(hotelId);
    if (!c) throw conflict('CONNECTOR_NOT_READY', 'The hotel connector has not registered its encryption key yet.');
    return { keyId: c.seal_key_id, publicKey: c.seal_public_key };
  });

  // ---- Property Visionline credentials (vendor portal: Settings → Visionline settings) ----------------
  app.put(`${P}/hotels/:hotelId/visionline/property-credentials`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'connector.manage');
    const b = z.object({ username: z.string().min(1).max(100), sealed: SealedSecret }).parse(req.body);
    await requireCurrentKey(hotelId, b.sealed);
    const corr = newCorrelationId();
    const cmd = await enqueue(pool, { hotelId, type: 'SET_PROPERTY_CREDENTIALS', payload: b, idempotencyKey: `property-creds:${randomUUID()}`, correlationId: corr, ttlSec: 300 });
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'visionline.property_credentials_submitted', targetType: 'command', targetId: cmd.id, correlationId: corr, details: { username: b.username } });
    return { commandId: cmd.id };
  });

  // ---- Personal Visionline credentials (vendor portal: User → Visionline credentials) ----------------
  app.get(`${P}/hotels/:hotelId/me/visionline-credentials`, async (req) => {
    const hotelId = hid(req);
    const op = await requireOperator(req);
    if (!op.isPlatformAdmin && !op.roles.has(hotelId)) throw notFound('Hotel');
    const r = await one(pool, 'SELECT username, status, status_detail, verified_at, updated_at, key_id FROM operator_vl_credentials WHERE operator_id=$1 AND hotel_id=$2', [op.id, hotelId]);
    const vl = await getConfig(pool, hotelId, 'visionline');
    return { credential: r ? { username: r.username, status: r.status, statusDetail: r.status_detail, verifiedAt: r.verified_at, updatedAt: r.updated_at } : null, required: Boolean(vl?.requirePersonalCredentials) };
  });
  app.put(`${P}/hotels/:hotelId/me/visionline-credentials`, async (req) => {
    const hotelId = hid(req);
    const op = await requireOperator(req);
    if (!op.isPlatformAdmin && !op.roles.has(hotelId)) throw notFound('Hotel');
    const b = z.object({ username: z.string().min(1).max(100), sealed: SealedSecret }).parse(req.body);
    await requireCurrentKey(hotelId, b.sealed);
    const corr = newCorrelationId();
    const cmd = await tx(async (c) => {
      await c.query(`INSERT INTO operator_vl_credentials (operator_id, hotel_id, username, sealed, key_id, status, status_detail, updated_at)
        VALUES ($1,$2,$3,$4,$5,'PENDING',NULL,now())
        ON CONFLICT (operator_id, hotel_id) DO UPDATE SET username=EXCLUDED.username, sealed=EXCLUDED.sealed, key_id=EXCLUDED.key_id, status='PENDING', status_detail=NULL, updated_at=now()`,
        [op.id, hotelId, b.username, b.sealed, b.sealed.keyId]);
      const cmd = await enqueue(c, { hotelId, type: 'VERIFY_OPERATOR_CREDENTIALS', payload: { operatorId: op.id, username: b.username, sealed: b.sealed }, idempotencyKey: `verify-op:${randomUUID()}`, correlationId: corr, ttlSec: 300 });
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'operator.visionline_credentials_saved', targetType: 'operator', targetId: op.id, correlationId: corr, details: { username: b.username } });
      return cmd;
    });
    return { commandId: cmd.id };
  });
  app.delete(`${P}/hotels/:hotelId/me/visionline-credentials`, async (req) => {
    const hotelId = hid(req);
    const op = await requireOperator(req);
    await pool.query('DELETE FROM operator_vl_credentials WHERE operator_id=$1 AND hotel_id=$2', [op.id, hotelId]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'operator.visionline_credentials_removed', targetType: 'operator', targetId: op.id });
    return { ok: true };
  });

  // ---- Operator self-service (vendor portal: User settings) ------------------------------------------
  app.patch(`${P}/me`, async (req) => {
    const op = await requireOperator(req);
    const b = z.object({ displayName: z.string().min(2).max(80) }).parse(req.body);
    await pool.query('UPDATE operators SET display_name=$2 WHERE id=$1', [op.id, b.displayName]);
    await audit(null, { hotelId: null, actorType: 'operator', actorId: op.id, action: 'operator.profile_updated', details: { displayName: b.displayName } });
    return { ok: true };
  });
  app.post(`${P}/me/password`, async (req) => {
    const op = await requireOperator(req);
    const b = z.object({ current: z.string(), next: z.string().min(10, 'Use at least 10 characters.') }).parse(req.body);
    const r = await one(pool, 'SELECT password_hash FROM operators WHERE id=$1', [op.id]);
    if (!verifyPassword(b.current, r?.password_hash)) throw new ApiError(400, 'BAD_PASSWORD', 'Your current password is not correct.');
    await pool.query('UPDATE operators SET password_hash=$2 WHERE id=$1', [op.id, hashPassword(b.next)]);
    await audit(null, { hotelId: null, actorType: 'operator', actorId: op.id, action: 'operator.password_changed' });
    return { ok: true };
  });

  // ---- Visionline user groups ------------------------------------------------------------------------
  app.post(`${P}/hotels/:hotelId/visionline/user-groups`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const b = z.object({ userGroup: z.string().min(1).max(60).regex(/^[^/?#%\\]+$/, 'Avoid / ? # % \\ in group names'), uniformAccess: z.boolean().default(false) }).parse(req.body);
    const corr = newCorrelationId();
    const cmd = await enqueue(pool, { hotelId, type: 'CREATE_USER_GROUP', payload: b, idempotencyKey: `create-ug:${b.userGroup}:${randomUUID()}`, correlationId: corr, ttlSec: 300 });
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'visionline.user_group_create_requested', targetType: 'command', targetId: cmd.id, correlationId: corr, details: b });
    return { commandId: cmd.id };
  });

  // ---- Change doors: replace an active key using Visionline override -----------------------------------
  app.post(`${P}/hotels/:hotelId/keys/:keyId/replace`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'key.issue');
    const idem = String(req.headers['idempotency-key'] ?? '');
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(idem)) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8–100 characters).');
    const old = await one(pool, 'SELECT staff_id FROM key_requests WHERE id=$1 AND hotel_id=$2', [(req.params as any).keyId, hotelId]);
    if (!old) throw notFound('Key');
    const b = z.object({
      templateId: z.string().uuid().optional().nullable(), doorIds: z.array(z.string()).default([]), doorGroupIds: z.array(z.string()).default([]),
      userGroupIds: z.array(z.string()).default([]), expiresAt: z.string().datetime(), reason: z.string().max(300).optional().nullable(),
    }).parse(req.body);
    const r = await requestKey(op, hotelId, { ...b, staffId: old.staff_id, replacesKeyId: (req.params as any).keyId }, idem);
    return reply.code(r.replayed ? 200 : 201).send(r.key);
  });

  // ---- Templates: edit -------------------------------------------------------------------------------
  app.put(`${P}/hotels/:hotelId/templates/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'templates.manage');
    const b = TemplateBody.parse(req.body);
    if (!b.doorIds.length && !b.doorGroupIds.length && !b.userGroupIds.length) throw badRequest('EMPTY_SCOPE', 'A template needs at least one door, door group or user group.');
    const t = await one(pool, `UPDATE access_templates SET name=$3, description=$4, door_ids=$5, door_group_ids=$6, user_group_ids=$7, allowed_job_roles=$8, is_broad=$9, max_validity_hours=$10, time_schedule=$11
      WHERE id=$1 AND hotel_id=$2 RETURNING *`, [(req.params as any).id, hotelId, b.name, b.description ?? null, b.doorIds, b.doorGroupIds, b.userGroupIds, b.allowedJobRoles, b.isBroad, b.maxValidityHours, b.timeSchedule ?? null]);
    if (!t) throw notFound('Template');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'template.updated', targetType: 'template', targetId: t.id, details: b });
    return t;
  });

  // ---- Staff import (vendor portal: Import settings) --------------------------------------------------
  const ImportRow = z.object({
    fullName: z.string().trim().min(2, 'Name is missing'), email: z.string().trim().toLowerCase().email('Email is not valid'),
    employeeNo: z.string().trim().max(40).optional().nullable(), jobRole: z.string().trim().max(60).optional().nullable(),
    userGroup: z.string().trim().max(60).optional().nullable(), visionlineUser: z.string().trim().max(100).optional().nullable(),
  });
  app.post(`${P}/hotels/:hotelId/staff/import`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'staff.manage');
    const b = z.object({ rows: z.array(z.unknown()).min(1).max(5000), mode: z.enum(['skip', 'update']).default('skip'), dryRun: z.boolean().default(true) }).parse(req.body);
    const vl = await getConfig(pool, hotelId, 'visionline');
    const groups = new Set<string>(vl?.userGroups ?? []);
    const existing = new Map((await many(pool, 'SELECT id, lower(email) AS email FROM staff WHERE hotel_id=$1', [hotelId])).map((r) => [r.email, r.id]));
    const seen = new Set<string>();
    const results = b.rows.map((raw, i) => {
      const p = ImportRow.safeParse(raw);
      if (!p.success) return { row: i + 1, outcome: 'invalid' as const, message: p.error.issues.map((x) => x.message).join('; ') };
      const r = p.data;
      if (seen.has(r.email)) return { row: i + 1, outcome: 'invalid' as const, message: 'Email appears twice in the file', email: r.email };
      seen.add(r.email);
      if (r.userGroup && !groups.has(r.userGroup)) return { row: i + 1, outcome: 'invalid' as const, message: `User group "${r.userGroup}" is not in Settings → Visionline user groups`, email: r.email };
      const id = existing.get(r.email);
      return { row: i + 1, outcome: id ? (b.mode === 'update' ? 'update' as const : 'skip' as const) : 'create' as const, email: r.email, data: r, id };
    });
    const summary = { create: 0, update: 0, skip: 0, invalid: 0 };
    for (const r of results) summary[r.outcome]++;
    if (!b.dryRun) {
      await tx(async (c) => {
        for (const r of results) {
          if (r.outcome === 'create') {
            const d = r.data!;
            await c.query(`INSERT INTO staff (hotel_id, full_name, email, employee_no, job_role, visionline_user, visionline_user_group, source) VALUES ($1,$2,$3,$4,$5,$6,$7,'import')`,
              [hotelId, d.fullName, d.email, d.employeeNo ?? null, d.jobRole || 'Housekeeper', d.visionlineUser || `smk-${(d.employeeNo || randomUUID().slice(0, 8)).toLowerCase()}`, d.userGroup || null]);
          } else if (r.outcome === 'update') {
            const d = r.data!;
            await c.query(`UPDATE staff SET full_name=$3, employee_no=COALESCE($4, employee_no), job_role=COALESCE($5, job_role), visionline_user_group=COALESCE($6, visionline_user_group) WHERE id=$1 AND hotel_id=$2`,
              [r.id, hotelId, d.fullName, d.employeeNo || null, d.jobRole || null, d.userGroup || null]);
          }
        }
        await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'staff.imported', details: { mode: b.mode, ...summary } });
      });
    }
    return { dryRun: b.dryRun, summary, results: results.map(({ data: _d, id: _id, ...r }) => r) };
  });
}

export const TemplateBody = z.object({
  name: z.string().min(2), description: z.string().optional().nullable(), doorIds: z.array(z.string()).default([]), doorGroupIds: z.array(z.string()).default([]),
  userGroupIds: z.array(z.string()).default([]), allowedJobRoles: z.array(z.string()).default([]), isBroad: z.boolean().default(false),
  maxValidityHours: z.number().int().min(1).max(744).default(12), timeSchedule: z.string().optional().nullable(),
});
