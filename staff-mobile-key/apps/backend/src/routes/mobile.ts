import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CS } from '@smk/shared';
import { pool, tx, one, many } from '../db.ts';
import { audit } from '../audit.ts';
import { checkThrottle, clearFailures, recordFailure, requireStaff, signToken, verifyPassword } from '../auth.ts';
import { csForHotel, CsError } from '../credential-services.ts';
import { getConfig } from '../hotel-config.ts';
import { ApiError, conflict } from '../lib/errors.ts';

/**
 * Staff mobile app API. The app never talks to Visionline or holds vendor credentials (spec §4.4, §13.3).
 * The invitation code is passed straight to the vendor SDK on the phone and is never stored or logged.
 */
export function mobileRoutes(app: FastifyInstance) {
  app.post('/mobile/v1/login', async (req) => {
    const b = z.object({ hotel: z.string(), email: z.string().email(), password: z.string() }).parse(req.body);
    const tkey = `staff:${b.hotel}:${b.email.toLowerCase()}`;
    checkThrottle(tkey);
    const s = await one(pool, `SELECT s.*, h.slug FROM staff s JOIN hotels h ON h.id=s.hotel_id WHERE h.slug=$1 AND lower(s.email)=lower($2)`, [b.hotel, b.email]);
    if (!s || !verifyPassword(b.password, s.password_hash)) {
      recordFailure(tkey);
      throw new ApiError(401, 'BAD_CREDENTIALS', 'Email or password is incorrect.');
    }
    if (s.status !== 'ACTIVE') throw new ApiError(403, 'SUSPENDED', 'Your access has been suspended. Contact your supervisor.');
    clearFailures(tkey);
    await audit(null, { hotelId: s.hotel_id, actorType: 'staff', actorId: s.id, action: 'staff.signed_in' });
    return { token: await signToken({ typ: 'staff', sub: s.id, hid: s.hotel_id }, '12h') };
  });

  /** Runtime hotel configuration for the white-label app (spec §13.5: server-driven, versioned values). */
  app.get('/mobile/v1/config', async (req) => {
    const hotelSlug = (req.query as any).hotel as string | undefined;
    let hotelId: string;
    if (hotelSlug) {
      const h = await one(pool, 'SELECT id FROM hotels WHERE slug=$1', [hotelSlug]);
      if (!h) throw new ApiError(404, 'NOT_FOUND', 'Unknown hotel');
      hotelId = h.id;
    } else hotelId = (await requireStaff(req)).hotelId;
    const [hotel, branding, property, appPolicy, features, vl] = await Promise.all([
      one(pool, 'SELECT slug, name FROM hotels WHERE id=$1', [hotelId]),
      getConfig(pool, hotelId, 'branding'), getConfig(pool, hotelId, 'property'), getConfig(pool, hotelId, 'app_policy'), getConfig(pool, hotelId, 'features'),
      getConfig(pool, hotelId, 'visionline'),
    ]);
    const versions = await many(pool, `SELECT kind, MAX(version) AS v FROM hotel_config_versions WHERE hotel_id=$1 GROUP BY kind`, [hotelId]);
    return {
      hotel, branding, features,
      property: property && { displayName: property.displayName, supportEmail: property.supportEmail, supportPhone: property.supportPhone, homepage: property.homepage, timezone: property.timezone, address: property.address ?? null, buildings: property.buildings ?? [] },
      // For the vendor SDK: the site's Mobile Access UUID as configured in Visionline Options → Mobile Access.
      mobileAccess: { uuid: vl?.mobileAccessUuid ?? null },
      appPolicy: appPolicy && { privacyText: appPolicy.privacyText, supportEscalation: appPolicy.supportEscalation, partnerLinks: appPolicy.partnerLinks, allowedLinkHosts: appPolicy.allowedLinkHosts },
      configVersion: Object.fromEntries(versions.map((v) => [v.kind, Number(v.v)])),
    };
  });

  app.get('/mobile/v1/me', async (req) => {
    const { staffId, hotelId } = await requireStaff(req);
    const s = await one(pool, 'SELECT id, full_name, email, job_role FROM staff WHERE id=$1 AND hotel_id=$2', [staffId, hotelId]);
    const ep = await one(pool, `SELECT endpoint_id, status, vendor_status, invitation_expires_at, activated_at FROM endpoints
      WHERE hotel_id=$1 AND staff_id=$2 AND status IN ('INVITED','ACTIVE') ORDER BY created_at DESC LIMIT 1`, [hotelId, staffId]);
    return { staff: { id: s.id, name: s.full_name, email: s.email, jobRole: s.job_role }, endpoint: ep ? { endpointId: ep.endpoint_id, status: ep.status, vendorStatus: ep.vendor_status, invitationExpiresAt: ep.invitation_expires_at, activatedAt: ep.activated_at } : null };
  });

  /**
   * Device onboarding (spec §12.3 step 2, §13.2 step 3): create/reuse an endpoint id and request an
   * invitation from Credential Services. The code goes straight to the vendor SDK on the phone.
   */
  app.post('/mobile/v1/onboarding', async (req, reply) => {
    const { staffId, hotelId } = await requireStaff(req);
    const b = z.object({ deviceLabel: z.string().max(60).optional() }).parse(req.body ?? {});
    const { client } = await csForHotel(hotelId);
    const result = await tx(async (c) => {
      await c.query('SELECT 1 FROM staff WHERE id=$1 FOR UPDATE', [staffId]);
      const existing = await one(c, `SELECT * FROM endpoints WHERE hotel_id=$1 AND staff_id=$2 AND status IN ('INVITED','ACTIVE')`, [hotelId, staffId]);
      if (existing?.status === 'ACTIVE') throw conflict('ENDPOINT_ALREADY_ACTIVE', 'This account already has an active phone. Ask an administrator to remove the old phone first.');
      const endpointId = existing?.endpoint_id ?? randomUUID();
      if (!CS.endpointIdPattern.test(endpointId)) throw new Error('bad endpoint id');
      let inv: { invitationCode: string };
      try { inv = await client.createInvitation(endpointId); } catch (e) {
        if (e instanceof CsError && e.code === CS.errorIdInUse) throw conflict('ENDPOINT_IN_USE', 'Credential Services reports this endpoint is already active.');
        throw new ApiError(502, 'CS_UNAVAILABLE', 'Credential Services could not create an invitation. Try again shortly.');
      }
      const expiresAt = new Date(Date.now() + CS.invitationTtlMs);
      if (existing) await c.query(`UPDATE endpoints SET invitation_expires_at=COALESCE(invitation_expires_at, $2), device_label=COALESCE($3, device_label), updated_at=now() WHERE id=$1`, [existing.id, expiresAt, b.deviceLabel ?? null]);
      else await c.query(`INSERT INTO endpoints (hotel_id, staff_id, endpoint_id, status, vendor_status, device_label, invitation_expires_at) VALUES ($1,$2,$3,'INVITED','INVITATION_PENDING',$4,$5)`, [hotelId, staffId, endpointId, b.deviceLabel ?? null, expiresAt]);
      await audit(c, { hotelId, actorType: 'staff', actorId: staffId, action: 'endpoint.invitation_created', targetType: 'endpoint', targetId: endpointId, details: { deviceLabel: b.deviceLabel } });
      return { endpointId, invitationCode: inv.invitationCode, expiresAt: (existing?.invitation_expires_at ?? expiresAt) };
    });
    reply.header('cache-control', 'no-store');
    return result;
  });

  /** Today's keys for the signed-in staff member (spec §13.7: surface only approved, current assignments). */
  app.get('/mobile/v1/keys', async (req) => {
    const { staffId, hotelId } = await requireStaff(req);
    const rows = await many(pool, `SELECT k.id, k.status, k.starts_at, k.expires_at, k.requested_scope, k.resolved_scope, k.credential_id, k.failure_code, k.first_used_at, k.revoke_source, k.card_reg_no, t.name AS template_name
      FROM key_requests k LEFT JOIN access_templates t ON t.id=k.template_id
      WHERE k.hotel_id=$1 AND k.staff_id=$2 AND (k.status IN ('SCHEDULED','QUEUED','ISSUING','ISSUED','REVOKING') OR k.updated_at > now() - interval '24 hours')
        AND k.status NOT IN ('PENDING_APPROVAL','REJECTED')
      ORDER BY k.created_at DESC LIMIT 20`, [hotelId, staffId]);
    const doorNames = new Map((await many(pool, `SELECT external_id, name, data->>'doorGroup' AS g FROM resources WHERE hotel_id=$1 AND kind='door'`, [hotelId])).map((d) => [d.external_id, { name: d.name, group: d.g }]));
    return rows.map((k) => {
      const ids: string[] = k.resolved_scope?.doorIds ?? k.requested_scope.resolvedDoorIds;
      return {
        id: k.id, status: k.status, validFrom: k.starts_at, validUntil: k.expires_at, title: k.template_name ?? 'Assigned doors',
        doors: ids.map((id) => ({ id, name: doorNames.get(id)?.name ?? id, group: doorNames.get(id)?.group ?? null })),
        credentialId: k.credential_id, regNo: k.card_reg_no ?? null, failureCode: k.failure_code, usedAtLock: Boolean(k.first_used_at), endedBy: k.revoke_source ?? null,
      };
    });
  });

  app.get('/mobile/v1/notifications', async (req) => {
    const { staffId, hotelId } = await requireStaff(req);
    return many(pool, `SELECT id, title, body, read_at, created_at FROM notifications WHERE hotel_id=$1 AND staff_id=$2 ORDER BY created_at DESC LIMIT 30`, [hotelId, staffId]);
  });
  app.post('/mobile/v1/notifications/read', async (req) => {
    const { staffId, hotelId } = await requireStaff(req);
    await pool.query('UPDATE notifications SET read_at=now() WHERE hotel_id=$1 AND staff_id=$2 AND read_at IS NULL', [hotelId, staffId]);
    return { ok: true };
  });
}
