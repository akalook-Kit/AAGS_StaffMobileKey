import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { CommandResult, IssueStaffKeyPayload, KeyStatus } from '@smk/shared';
import { config } from './config.ts';
import { pool, tx, one, many, lockHotel, type Db } from './db.ts';
import { audit } from './audit.ts';
import { enqueue, newCorrelationId } from './commands.ts';
import { getConfig } from './hotel-config.ts';
import { evaluateIssue, DEFAULT_POLICY, type DoorResource, type TemplateLike, type UserGroupDoors } from './policy.ts';
import { ApiError, badRequest, conflict, forbidden, notFound } from './lib/errors.ts';
import { stableStringify } from './lib/redact.ts';
import type { OperatorCtx } from './auth.ts';

export const LIVE_STATUSES: KeyStatus[] = ['PENDING_APPROVAL', 'SCHEDULED', 'QUEUED', 'ISSUING', 'ISSUED', 'REVOKING'];

export async function notify(db: Db, hotelId: string, staffId: string, title: string, body: string) {
  await db.query('INSERT INTO notifications (hotel_id, staff_id, title, body) VALUES ($1,$2,$3,$4)', [hotelId, staffId, title, body]);
  // Push delivery (FCM/APNs) plugs in here; the app also polls /mobile/v1/notifications.
}

export async function loadDoors(db: Db, hotelId: string): Promise<DoorResource[]> {
  const rows = await many(db, `SELECT external_id, name, data->>'doorGroup' AS door_group, active FROM resources WHERE hotel_id=$1 AND kind='door'`, [hotelId]);
  return rows.map((r) => ({ externalId: r.external_id, name: r.name, doorGroup: r.door_group, active: r.active }));
}

function templateFromRow(r: any): TemplateLike {
  return { id: r.id, name: r.name, doorIds: r.door_ids, doorGroupIds: r.door_group_ids, userGroupIds: r.user_group_ids ?? [], allowedJobRoles: r.allowed_job_roles, isBroad: r.is_broad, maxValidityHours: r.max_validity_hours, timeSchedule: r.time_schedule };
}

/** Visionline user groups discovered by the connector, with the doors configured on each [§5.29]. */
export async function loadUserGroups(db: Db, hotelId: string): Promise<Map<string, UserGroupDoors>> {
  const rows = await many(db, `SELECT external_id, data FROM resources WHERE hotel_id=$1 AND kind='usergroup' AND active`, [hotelId]);
  const m = new Map<string, UserGroupDoors>();
  for (const r of rows) {
    const ops = (r.data?.doorOperations ?? []) as { doors?: string[]; doorGroups?: string[] }[];
    m.set(r.external_id, { doors: ops.flatMap((o) => o.doors ?? []), doorGroups: ops.flatMap((o) => o.doorGroups ?? []), uniformAccess: Boolean(r.data?.uniformAccess) });
  }
  return m;
}

/** The operator's verified personal Visionline credentials, if sealed for the current connector key. */
export async function personalCredential(db: Db, hotelId: string, operatorId: string) {
  const r = await one(db, `SELECT v.username, v.sealed FROM operator_vl_credentials v
    JOIN connectors c ON c.hotel_id=v.hotel_id AND c.status='ACTIVE' AND c.seal_key_id=v.key_id
    WHERE v.hotel_id=$1 AND v.operator_id=$2 AND v.status='VERIFIED' LIMIT 1`, [hotelId, operatorId]);
  return r ? { operatorId, username: r.username as string, sealed: r.sealed } : null;
}

export interface KeyRequestInput {
  staffId: string;
  templateId?: string | null;
  doorIds: string[];
  doorGroupIds: string[];
  startsAt?: string | null;
  expiresAt: string;
  reason?: string | null;
  userGroupIds?: string[];
  /** "Change doors": replace this ISSUED key using Visionline override. */
  replacesKeyId?: string | null;
}

/** Future start: held by the platform (default, Web API §7.6.2) or sent to Visionline as startTime (hotel setting). */
const holdsFuture = (vl: any) => (vl?.startTimeMode ?? 'hold') !== 'send';

/** Spec §13.2 steps 5–7: validate, apply policy, then queue an idempotent issue command (or hold for approval). */
export async function requestKey(op: OperatorCtx, hotelId: string, input: KeyRequestInput, idempotencyKey: string) {
  return tx(async (c) => {
    await lockHotel(c, hotelId);
    const prior = await one(c, 'SELECT id FROM key_requests WHERE hotel_id=$1 AND idempotency_key=$2', [hotelId, idempotencyKey]);
    if (prior) return { replayed: true, key: await getKey(c, hotelId, prior.id) };

    const vl = await getConfig(c, hotelId, 'visionline');
    if (vl?.requirePersonalCredentials && !(await personalCredential(c, hotelId, op.id)))
      throw conflict('PERSONAL_CREDENTIALS_REQUIRED', 'This hotel requires your personal Visionline credentials to issue keys. Add them under Your account → Visionline credentials.');
    const staff = await one(c, 'SELECT * FROM staff WHERE id=$1 AND hotel_id=$2 FOR UPDATE', [input.staffId, hotelId]);
    if (!staff) throw notFound('Staff member');
    if (staff.status !== 'ACTIVE') throw conflict('STAFF_NOT_ACTIVE', 'This staff member is suspended or has left.');
    const ep = await one(c, `SELECT * FROM endpoints WHERE hotel_id=$1 AND staff_id=$2 AND status='ACTIVE'`, [hotelId, staff.id]);
    if (!ep) throw conflict('ENDPOINT_NOT_ACTIVE', 'The staff member’s phone is not an active mobile-key endpoint yet. Ask them to finish onboarding in the app.');
    let replaced: any = null;
    if (input.replacesKeyId) {
      replaced = await one(c, 'SELECT * FROM key_requests WHERE id=$1 AND hotel_id=$2 FOR UPDATE', [input.replacesKeyId, hotelId]);
      if (!replaced || replaced.staff_id !== staff.id) throw notFound('Key to replace');
      if (replaced.status !== 'ISSUED') throw conflict('NOT_REPLACEABLE', 'Only an active key can have its doors changed.');
      if (replaced.replaced_by_key_id) throw conflict('ALREADY_REPLACING', 'A replacement for this key is already in progress.');
    }
    const live = await one(c, `SELECT id, status FROM key_requests WHERE hotel_id=$1 AND staff_id=$2 AND status = ANY($3) AND expires_at > now() AND id IS DISTINCT FROM $4`, [hotelId, staff.id, LIVE_STATUSES, replaced?.id ?? null]);
    if (live) throw conflict('KEY_ALREADY_ACTIVE', 'This person already has a live key. Use “Change doors” on that key, or revoke it first (Visionline allows one staff key per user, Web API §7.6.4).');

    const template = input.templateId ? await one(c, 'SELECT * FROM access_templates WHERE id=$1 AND hotel_id=$2', [input.templateId, hotelId]) : null;
    if (input.templateId && !template) throw notFound('Access template');
    const policy = { ...DEFAULT_POLICY, ...(await getConfig(c, hotelId, 'policy')) };
    const now = new Date();
    const startsAt = input.startsAt ? new Date(input.startsAt) : now;
    const expiresAt = new Date(input.expiresAt);
    const doors = await loadDoors(c, hotelId);
    const groups = await loadUserGroups(c, hotelId);
    const holderGroup = staff.visionline_user_group ?? vl?.defaultUserGroup;
    const uniform = holderGroup && groups.get(holderGroup)?.uniformAccess ? holderGroup : null;
    // Uniform-access group: Visionline forces the group's doors on the card [§5.29.3], so the scope IS the group.
    const p = uniform
      ? evaluateIssue({ template: null, doorIds: [], doorGroupIds: [], userGroupIds: [uniform], startsAt: startsAt < now ? now : startsAt, expiresAt, jobRole: staff.job_role, now }, doors, policy, groups)
      : evaluateIssue({ template: template ? templateFromRow(template) : null, doorIds: input.doorIds, doorGroupIds: input.doorGroupIds, userGroupIds: input.userGroupIds ?? [], startsAt: startsAt < now ? now : startsAt, expiresAt, jobRole: staff.job_role, now }, doors, policy, groups);
    if (!p.ok) throw badRequest(p.errors[0]!.code, p.errors[0]!.message, p.errors);

    const status: KeyStatus = p.requiresApproval ? 'PENDING_APPROVAL' : startsAt.getTime() > now.getTime() + 60_000 && holdsFuture(vl) ? 'SCHEDULED' : 'QUEUED';
    const correlationId = newCorrelationId();
    const requestedScope = {
      templateId: uniform ? null : template?.id ?? null, templateName: uniform ? `${uniform} (uniform access)` : template?.name ?? null,
      doorIds: input.doorIds, doorGroupIds: input.doorGroupIds, userGroupIds: input.userGroupIds ?? [], resolvedDoorIds: p.resolvedDoorIds,
      timeSchedule: p.timeSchedule, isBroad: p.isBroad, uniformGroup: uniform, replacesKeyId: replaced?.id ?? null,
    };
    const key = await one(c, `INSERT INTO key_requests (hotel_id, staff_id, endpoint_id, template_id, requested_by, status, is_broad, reason, requested_scope, starts_at, expires_at, correlation_id, idempotency_key, replaces_key_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [hotelId, staff.id, ep.endpoint_id, uniform ? null : template?.id ?? null, op.id, status, p.isBroad, input.reason ?? null, requestedScope, startsAt < now ? now : startsAt, expiresAt, correlationId, idempotencyKey, replaced?.id ?? null]);
    if (replaced) await c.query('UPDATE key_requests SET replaced_by_key_id=$2, updated_at=now() WHERE id=$1', [replaced.id, key.id]);
    await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'key.requested', targetType: 'key_request', targetId: key.id, correlationId,
      details: { staffId: staff.id, recipient: staff.full_name, status, scope: requestedScope, startsAt: key.starts_at, expiresAt: key.expires_at, reason: input.reason, replaces: replaced?.id } });
    if (status === 'QUEUED') await enqueueIssue(c, key);
    return { replayed: false, key: await getKey(c, hotelId, key.id) };
  });
}

export async function enqueueIssue(c: Db, key: any) {
  const staff = await one(c, 'SELECT * FROM staff WHERE id=$1', [key.staff_id]);
  const vl = await getConfig(c, key.hotel_id, 'visionline');
  // Issue under the requesting operator's own Visionline identity when they stored verified credentials.
  const cred = await personalCredential(c, key.hotel_id, key.requested_by);
  if (!cred && vl?.requirePersonalCredentials) {
    await c.query(`UPDATE key_requests SET status='FAILED', failure_code='PERSONAL_CREDENTIALS_REQUIRED', failure_message='The requesting operator has no verified personal Visionline credentials.', updated_at=now() WHERE id=$1`, [key.id]);
    return;
  }
  const [givenName, ...rest] = String(staff.full_name).trim().split(/\s+/);
  const payload: IssueStaffKeyPayload = {
    keyRequestId: key.id,
    cardHolder: staff.visionline_user,
    user: { givenName: givenName ?? '', surname: rest.join(' ') || (givenName ?? ''), userGroup: staff.visionline_user_group ?? vl?.defaultUserGroup ?? 'Housekeeping' },
    endpointId: key.endpoint_id,
    doorIds: key.requested_scope.resolvedDoorIds,
    ...(key.requested_scope.timeSchedule ? { timeSchedule: key.requested_scope.timeSchedule } : {}),
    expireTime: new Date(key.expires_at).toISOString(),
    ...(!holdsFuture(vl) && new Date(key.starts_at).getTime() > Date.now() + 60_000 ? { startTime: new Date(key.starts_at).toISOString() } : {}),
    ...(vl?.accountName ? { accountName: vl.accountName } : {}),
    ...(vl?.keyLabel ? { label: vl.keyLabel } : {}),
    ...(key.requested_scope.uniformGroup ? { useUserGroupDoors: true } : {}),
    ...(key.replaces_key_id ? { override: true } : {}),
    ...(cred ? { operatorCredential: cred } : {}),
  };
  const ttl = Math.max(30, Math.min(config.commandTtlSec, Math.floor((new Date(key.expires_at).getTime() - Date.now()) / 1000)));
  await enqueue(c, { hotelId: key.hotel_id, type: 'ISSUE_STAFF_KEY', payload, idempotencyKey: `issue:${key.id}`, correlationId: key.correlation_id, ttlSec: ttl });
  await c.query(`UPDATE key_requests SET status='QUEUED', issued_as=$2, updated_at=now() WHERE id=$1`, [key.id, cred?.username ?? 'property operator']);
}

export async function approveKey(op: OperatorCtx, hotelId: string, keyId: string, approve: boolean, note?: string) {
  return tx(async (c) => {
    await lockHotel(c, hotelId);
    const key = await one(c, 'SELECT * FROM key_requests WHERE id=$1 AND hotel_id=$2 FOR UPDATE', [keyId, hotelId]);
    if (!key) throw notFound('Key request');
    if (key.status !== 'PENDING_APPROVAL') throw conflict('NOT_PENDING', 'This request is not awaiting approval.');
    if (key.requested_by === op.id) throw forbidden('Separation of duties: the person who requested broad access cannot approve it.');
    if (approve && new Date(key.expires_at) <= new Date()) throw conflict('EXPIRED', 'The requested validity has already passed. Ask for a new request.');
    const next: KeyStatus = !approve ? 'REJECTED' : new Date(key.starts_at).getTime() > Date.now() + 60_000 && holdsFuture(await getConfig(c, hotelId, 'visionline')) ? 'SCHEDULED' : 'QUEUED';
    await c.query('UPDATE key_requests SET status=$2, approved_by=$3, updated_at=now() WHERE id=$1', [key.id, next, op.id]);
    await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: approve ? 'key.approved' : 'key.rejected', targetType: 'key_request', targetId: key.id, correlationId: key.correlation_id, details: { note } });
    if (next === 'QUEUED') await enqueueIssue(c, { ...key, status: next });
    return getKey(c, hotelId, key.id);
  });
}

export async function revokeKey(op: OperatorCtx, hotelId: string, keyId: string, reason: string, method: 'checkout' | 'cancelCard' = 'checkout') {
  return tx(async (c) => {
    await lockHotel(c, hotelId);
    const key = await one(c, 'SELECT * FROM key_requests WHERE id=$1 AND hotel_id=$2 FOR UPDATE', [keyId, hotelId]);
    if (!key) throw notFound('Key request');
    const log = (action: string, details: Record<string, unknown> = {}) => audit(c, { hotelId, actorType: 'operator', actorId: op.id, action, targetType: 'key_request', targetId: key.id, correlationId: key.correlation_id, details: { reason, ...details } });
    switch (key.status as KeyStatus) {
      case 'PENDING_APPROVAL':
      case 'SCHEDULED':
        await c.query(`UPDATE key_requests SET status='REVOKED', revoked_by=$2, revoke_reason=$3, updated_at=now() WHERE id=$1`, [key.id, op.id, reason]);
        await log('key.cancelled_before_issue');
        break;
      case 'QUEUED': {
        const cmd = await one(c, `SELECT * FROM commands WHERE hotel_id=$1 AND idempotency_key=$2 FOR UPDATE`, [hotelId, `issue:${key.id}`]);
        if (cmd?.status === 'PENDING') {
          await c.query(`UPDATE commands SET status='EXPIRED', error=$2, completed_at=now() WHERE id=$1`, [cmd.id, { code: 'CANCELLED', message: 'Cancelled before the connector picked it up', retryable: false }]);
          await c.query(`UPDATE key_requests SET status='REVOKED', revoked_by=$2, revoke_reason=$3, updated_at=now() WHERE id=$1`, [key.id, op.id, reason]);
          await log('key.cancelled_before_issue');
        } else {
          // The connector is talking to Visionline right now: revoke as soon as the credential id is known.
          await c.query(`UPDATE key_requests SET revoke_requested=true, revoked_by=$2, revoke_reason=$3, updated_at=now() WHERE id=$1`, [key.id, op.id, reason]);
          await log('key.revoke_requested_in_flight');
        }
        break;
      }
      case 'ISSUING':
      case 'ISSUED':
        await c.query(`UPDATE key_requests SET status='REVOKING', revoked_by=$2, revoke_reason=$3, revoke_source='operator', revoke_method=$4, updated_at=now() WHERE id=$1`, [key.id, op.id, reason, method]);
        await enqueueRevoke(c, key, op.id, method);
        await log('key.revoke_requested', { method });
        break;
      case 'REVOKING':
        break; // already in progress; repeated clicks are harmless
      default:
        throw conflict('NOT_REVOCABLE', `A key in state ${key.status} cannot be revoked.`);
    }
    return getKey(c, hotelId, key.id);
  });
}

export async function enqueueRevoke(c: Db, key: any, operatorId?: string | null, method?: 'checkout' | 'cancelCard') {
  const staff = await one(c, 'SELECT visionline_user FROM staff WHERE id=$1', [key.staff_id]);
  const cred = operatorId ? await personalCredential(c, key.hotel_id, operatorId) : null;
  const doorIds = key.resolved_scope?.doorIds ?? key.requested_scope.resolvedDoorIds;
  const n = (await one(c, `SELECT count(*)::int AS n FROM commands WHERE hotel_id=$1 AND idempotency_key LIKE $2`, [key.hotel_id, `revoke:${key.id}:%`]))!.n;
  await enqueue(c, { hotelId: key.hotel_id, type: 'REVOKE_STAFF_KEY', idempotencyKey: `revoke:${key.id}:${n + 1}`, correlationId: key.correlation_id,
    payload: { keyRequestId: key.id, credentialId: key.credential_id, cardHolder: staff.visionline_user, doorIds, ...(key.card_reg_no ? { cardRegNo: key.card_reg_no } : {}), ...(method ? { method } : {}), ...(cred ? { operatorCredential: cred } : {}) } });
}

// ---- Results from the connector ---------------------------------------------------------------------

export async function onIssueResult(c: pg.PoolClient, cmd: any, result: CommandResult) {
  const key = await one(c, 'SELECT * FROM key_requests WHERE id=$1 AND hotel_id=$2 FOR UPDATE', [cmd.payload.keyRequestId, cmd.hotel_id]);
  if (!key) return;
  if (result.status === 'FAILED') {
    const e = result.error!;
    await c.query(`UPDATE key_requests SET status='FAILED', failure_code=$2, failure_message=$3, updated_at=now() WHERE id=$1 AND status IN ('QUEUED','ISSUING')`,
      [key.id, e.code, e.vendorCode ? `${e.message} (Visionline ${e.vendorCode})` : e.message]);
    await audit(c, { hotelId: key.hotel_id, actorType: 'system', action: 'key.failed', targetType: 'key_request', targetId: key.id, correlationId: key.correlation_id, details: { error: e } });
    // A failed replacement leaves the original key untouched and replaceable again.
    if (key.replaces_key_id) await c.query('UPDATE key_requests SET replaced_by_key_id=NULL WHERE id=$1 AND replaced_by_key_id=$2', [key.replaces_key_id, key.id]);
    return;
  }
  const r = result.result as { credentialId: string; cardRegNo?: string | null; resolvedScope: Record<string, unknown>; issuedAs?: string };
  await c.query(`UPDATE key_requests SET credential_id=$2, card_reg_no=$5, resolved_scope=$3, issued_as=COALESCE($4, issued_as), status=CASE WHEN status='QUEUED' THEN 'ISSUING' ELSE status END, updated_at=now() WHERE id=$1`,
    [key.id, String(r.credentialId), r.resolvedScope, r.issuedAs ?? null, r.cardRegNo ?? null]);
  await audit(c, { hotelId: key.hotel_id, actorType: 'system', action: 'key.created_in_visionline', targetType: 'key_request', targetId: key.id, correlationId: key.correlation_id, details: { credentialId: String(r.credentialId), regNo: r.cardRegNo ?? null, resolvedScope: r.resolvedScope } });
  // Credential Services callbacks may have arrived before this result: apply them now, in order.
  for (const ev of await many(c, `SELECT * FROM inbound_events WHERE hotel_id=$1 AND credential_id=$2 AND NOT processed ORDER BY received_at`, [key.hotel_id, String(r.credentialId)])) {
    await applyCredentialEvent(c, key.hotel_id, ev.payload);
    await c.query('UPDATE inbound_events SET processed=true WHERE event_hash=$1', [ev.event_hash]);
  }
  if (key.replaces_key_id) {
    // Visionline cancelled the previous staff card (override). With "Revoke mobile key when overridden" set in
    // Visionline Options → Mobile Access, the old key leaves the phone by itself; otherwise revoke it explicitly.
    const old = await one(c, 'SELECT * FROM key_requests WHERE id=$1 FOR UPDATE', [key.replaces_key_id]);
    const vl = await getConfig(c, key.hotel_id, 'visionline');
    if (old && ['ISSUED', 'ISSUING'].includes(old.status)) {
      await c.query(`UPDATE key_requests SET status='REVOKING', revoked_by=$2, revoke_reason='Replaced by a new key (doors changed)', revoke_source='replaced', updated_at=now() WHERE id=$1`, [old.id, key.requested_by]);
      if ((vl?.revokeMode ?? 'overridden') !== 'overridden') await enqueueRevoke(c, old, key.requested_by);
    }
    await audit(c, { hotelId: key.hotel_id, actorType: 'system', action: 'key.replaced', targetType: 'key_request', targetId: key.replaces_key_id, correlationId: key.correlation_id, details: { newKey: key.id, revokeMode: vl?.revokeMode ?? 'overridden' } });
  }
  if (key.revoke_requested) {
    const fresh = await one(c, 'SELECT * FROM key_requests WHERE id=$1', [key.id]);
    if (['ISSUING', 'ISSUED'].includes(fresh.status)) {
      await c.query(`UPDATE key_requests SET status='REVOKING', updated_at=now() WHERE id=$1`, [key.id]);
      await enqueueRevoke(c, fresh);
    }
  }
}

export async function onRevokeResult(c: pg.PoolClient, cmd: any, result: CommandResult) {
  const key = await one(c, 'SELECT * FROM key_requests WHERE id=$1 AND hotel_id=$2 FOR UPDATE', [cmd.payload.keyRequestId, cmd.hotel_id]);
  if (!key) return;
  if (result.status === 'FAILED') {
    const e = result.error!;
    await c.query(`UPDATE key_requests SET status=CASE WHEN status='REVOKING' THEN 'ISSUED' ELSE status END, failure_code=$2, failure_message=$3, updated_at=now() WHERE id=$1`,
      [key.id, e.code, `Revoke failed: ${e.message}${e.vendorCode ? ` (Visionline ${e.vendorCode})` : ''}. The key may still work; retry or use Visionline directly.`]);
    await audit(c, { hotelId: key.hotel_id, actorType: 'system', action: 'key.revoke_failed', targetType: 'key_request', targetId: key.id, correlationId: key.correlation_id, details: { error: e } });
  }
  // Checkout: the key stays REVOKING until Credential Services confirms REVOKED (callback or reconciliation).
  // Cancel card: Visionline has cancelled the card; locks refuse it, so the key ends now and leaves the app.
  else if (cmd.payload.method === 'cancelCard' && key.status === 'REVOKING') {
    await c.query(`UPDATE key_requests SET status='REVOKED', updated_at=now() WHERE id=$1`, [key.id]);
    await audit(c, { hotelId: key.hotel_id, actorType: 'system', action: 'key.card_cancelled_in_visionline', targetType: 'key_request', targetId: key.id, correlationId: key.correlation_id, details: { regNo: (result.result as any)?.regNo ?? key.card_reg_no, source: key.revoke_source } });
    if (key.revoke_source !== 'wrong_door') await notify(c, key.hotel_id, key.staff_id, 'Key removed', 'Your mobile key was removed by the hotel.');
  }
}

// ---- Credential Services callbacks ---------------------------------------------------------------

const CS_TO_KEY: Record<string, { to: KeyStatus | null; from: KeyStatus[] }> = {
  ISSUING: { to: 'ISSUING', from: ['QUEUED', 'ISSUING'] },
  ISSUED: { to: 'ISSUED', from: ['QUEUED', 'ISSUING'] },
  ISSUING_FAILURE: { to: 'FAILED', from: ['QUEUED', 'ISSUING'] },
  REVOKING: { to: 'REVOKING', from: ['ISSUING', 'ISSUED'] },
  REVOKED: { to: 'REVOKED', from: ['QUEUED', 'ISSUING', 'ISSUED', 'REVOKING', 'EXPIRED', 'FAILED'] },
  REVOKING_FAILURE: { to: null, from: [] },
  UPDATING: { to: null, from: [] },
  UPDATING_FAILURE: { to: null, from: [] },
};

export async function applyCredentialEvent(c: pg.PoolClient, hotelId: string, ev: any): Promise<boolean> {
  const key = await one(c, 'SELECT * FROM key_requests WHERE hotel_id=$1 AND credential_id=$2 FOR UPDATE', [hotelId, String(ev.credentialId)]);
  if (!key) return false;
  const staffId = key.staff_id;
  if (ev.callbackType === 'sessionTransceived') {
    await c.query('UPDATE key_requests SET first_used_at=COALESCE(first_used_at, now()), last_used_door=$2 WHERE id=$1', [key.id, ev.description ?? null]);
    await audit(c, { hotelId, actorType: 'vendor', action: 'key.first_use_at_door', targetType: 'key_request', targetId: key.id, correlationId: key.correlation_id, details: { door: ev.description, label: ev.label } });
    return true;
  }
  const map = CS_TO_KEY[ev.credentialStatus];
  await c.query('UPDATE key_requests SET vendor_status=$2, updated_at=now() WHERE id=$1', [key.id, ev.credentialStatus]);
  if (map?.to && map.from.includes(key.status)) {
    const failure = ev.credentialStatus === 'ISSUING_FAILURE' ? ['CREDENTIAL_DELIVERY_FAILED', 'Credential Services could not deliver the key to the phone.'] : [null, null];
    await c.query(`UPDATE key_requests SET status=$2, failure_code=COALESCE($3, failure_code), failure_message=COALESCE($4, failure_message) WHERE id=$1`, [key.id, map.to, failure[0], failure[1]]);
    if (map.to === 'ISSUED') {
      const tz = (await getConfig(c, hotelId, 'property'))?.timezone ?? 'UTC';
      const until = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(key.expires_at));
      await notify(c, hotelId, staffId, 'Your key is ready', `Valid until ${until}. Open the app and hold your phone near the lock.`);
    }
    if (map.to === 'REVOKED') await notify(c, hotelId, staffId, 'Key removed', 'Your mobile key was removed by the hotel.');
    if (map.to === 'FAILED') await notify(c, hotelId, staffId, 'Key could not be delivered', 'Open the app with internet on. If this continues, contact your supervisor.');
  } else if (ev.credentialStatus === 'REVOKING_FAILURE') {
    await c.query(`UPDATE key_requests SET failure_code='REVOKE_DELIVERY_FAILED', failure_message='Credential Services could not remove the key from the phone yet. The lock will still refuse it after checkout/expiry.' WHERE id=$1`, [key.id]);
  }
  await audit(c, { hotelId, actorType: 'vendor', action: 'key.vendor_status', targetType: 'key_request', targetId: key.id, correlationId: key.correlation_id, details: { credentialStatus: ev.credentialStatus, previous: key.status } });
  return true;
}

/**
 * Entry point for POST /integrations/credential-services/callback/:hotel. Credential Services does not resend a
 * callback that got an HTTP error [CS §8.1], so the payload is committed first, on its own, and processed after.
 * Anything that fails processing stays unprocessed and is retried by the jobs loop (processPendingEvents).
 */
export async function handleCsCallback(hotelId: string, systemId: number | null, body: any) {
  const hash = createHash('sha256').update(stableStringify(body)).digest('hex');
  const ins = await one(pool, `INSERT INTO inbound_events (event_hash, hotel_id, callback_type, credential_id, endpoint_id, payload)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING event_hash`,
    [hash, hotelId, String(body.callbackType ?? 'unknown'), body.credentialId != null ? String(body.credentialId) : null, body.endpointId ?? null, body]);
  if (!ins) return 'duplicate';
  try {
    return await processEvent(hash, hotelId, systemId, body);
  } catch (e) {
    console.error('[callback] stored for retry:', (e as Error).message);
    return 'stored';
  }
}

async function processEvent(hash: string, hotelId: string, systemId: number | null, body: any) {
  return tx(async (c) => {
    await lockHotel(c, hotelId);
    const ev = await one(c, 'SELECT processed FROM inbound_events WHERE event_hash=$1 FOR UPDATE', [hash]);
    if (!ev || ev.processed) return 'duplicate';
    if (body.callbackType === 'endpointStatusChanged') {
      const ep = await one(c, `UPDATE endpoints SET status='ACTIVE', vendor_status=$3, activated_at=now(), updated_at=now()
        WHERE hotel_id=$1 AND endpoint_id=$2 AND status='INVITED' RETURNING *`, [hotelId, body.endpointId, body.endpointStatus]);
      if (ep) {
        await audit(c, { hotelId, actorType: 'vendor', action: 'endpoint.active', targetType: 'endpoint', targetId: ep.endpoint_id, details: { staffId: ep.staff_id } });
        await notify(c, hotelId, ep.staff_id, 'Phone ready', 'Your phone can now receive mobile keys.');
      }
      await c.query('UPDATE inbound_events SET processed=true WHERE event_hash=$1', [hash]);
      return ep ? 'applied' : 'ignored';
    }
    if (systemId !== null && body.systemId !== undefined && Number(body.systemId) !== systemId) {
      await audit(c, { hotelId, actorType: 'vendor', action: 'callback.system_mismatch', details: { expected: systemId, got: body.systemId } });
      await c.query('UPDATE inbound_events SET processed=true WHERE event_hash=$1', [hash]);
      return 'ignored';
    }
    const applied = await applyCredentialEvent(c, hotelId, body);
    if (applied) await c.query('UPDATE inbound_events SET processed=true WHERE event_hash=$1', [hash]);
    return applied ? 'applied' : 'buffered';
  });
}

/** Retries callbacks that could not be processed yet (errors, or the key was not known at the time). */
export async function processPendingEvents() {
  const rows = await many(pool, `SELECT e.event_hash, e.hotel_id, e.payload FROM inbound_events e
    WHERE NOT e.processed AND e.received_at < now() - interval '3 seconds' AND e.received_at > now() - interval '7 days'
      AND (e.credential_id IS NULL OR EXISTS (SELECT 1 FROM key_requests k WHERE k.hotel_id=e.hotel_id AND k.credential_id=e.credential_id))
    ORDER BY e.received_at LIMIT 100`);
  for (const r of rows) {
    const cs = await getConfig(pool, r.hotel_id, 'credential_services');
    try { await processEvent(r.event_hash, r.hotel_id, cs?.systemId ?? null, r.payload); } catch (e) { console.warn('[callback retry]', (e as Error).message); }
  }
}

// ---- Read model ----------------------------------------------------------------------------------

export async function getKey(db: Db, hotelId: string, id: string) {
  const r = await one(db, `${KEY_SELECT} WHERE k.hotel_id=$1 AND k.id=$2`, [hotelId, id]);
  return r ? keyView(r) : null;
}
export const KEY_SELECT = `SELECT k.*, s.full_name AS staff_name, s.job_role, t.name AS template_name,
  rq.display_name AS requested_by_name, ap.display_name AS approved_by_name, rv.display_name AS revoked_by_name
  FROM key_requests k JOIN staff s ON s.id=k.staff_id
  LEFT JOIN access_templates t ON t.id=k.template_id
  LEFT JOIN operators rq ON rq.id=k.requested_by LEFT JOIN operators ap ON ap.id=k.approved_by LEFT JOIN operators rv ON rv.id=k.revoked_by`;
export function keyView(r: any) {
  return {
    id: r.id, staffId: r.staff_id, staffName: r.staff_name, jobRole: r.job_role, status: r.status, isBroad: r.is_broad,
    templateName: r.template_name, requestedScope: r.requested_scope, resolvedScope: r.resolved_scope,
    startsAt: r.starts_at, expiresAt: r.expires_at, credentialId: r.credential_id, vendorStatus: r.vendor_status,
    failureCode: r.failure_code, failureMessage: r.failure_message, correlationId: r.correlation_id,
    requestedBy: r.requested_by_name, approvedBy: r.approved_by_name, revokedBy: r.revoked_by_name, revokeReason: r.revoke_reason,
    revokeRequested: r.revoke_requested, firstUsedAt: r.first_used_at, lastUsedDoor: r.last_used_door,
    reason: r.reason, createdAt: r.created_at, updatedAt: r.updated_at,
    issuedAs: r.issued_as, replacesKeyId: r.replaces_key_id, replacedByKeyId: r.replaced_by_key_id,
    regNo: r.card_reg_no, revokeSource: r.revoke_source, revokeMethod: r.revoke_method, wrongDoorCount: r.wrong_door_count ?? 0,
  };
}

export const randomIdempotencyKey = () => randomUUID();
export { ApiError };
