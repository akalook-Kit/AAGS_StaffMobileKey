import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ROLES, type Role } from '@smk/shared';
import { pool, many, one, tx } from '../db.ts';
import { audit } from '../audit.ts';
import { hashPassword, operatorToken, requirePerm, requireReauth, signToken } from '../auth.ts';
import { ApiError, forbidden, notFound } from '../lib/errors.ts';
import { getConfig } from '../hotel-config.ts';
import { channels } from '../monitoring/monitor.ts';
import { sendEmail } from '../monitoring/channels.ts';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 2.20 The outside address written by set-tunnel-access.ps1 (Cloudflare Tunnel), e.g. https://portal.example.com/k-…. */
export function outsideUrl(): string | null {
  const dir = process.env.SMK_BACKUP_DIR ? dirname(process.env.SMK_BACKUP_DIR) : null;
  const f = process.env.SMK_OUTSIDE_URL_FILE ?? (dir ? join(dir, 'outside-url.txt') : null);
  if (!f || !existsSync(f)) return null;
  try { const u = readFileSync(f, 'utf8').trim(); return /^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9_-]+)?$/i.test(u) ? u : null; } catch { return null; }
}
const outsideLink = (token: string | null) => { const o = outsideUrl(); return o && token ? `${o}/invite#${token}` : null; };

/**
 * 2.16 Inviting people to the portal without handing out passwords.
 *
 * An administrator enters a name, an e-mail and what the person does (a profile = a set of roles). The platform
 * makes a one-time link (valid 72 hours): the person opens it, chooses their own password and is signed in. Only
 * the SHA-256 of the link's secret is stored; a new link replaces the old one. The link can be copied (WhatsApp,
 * Teams...) or, when e-mail is set up, sent by e-mail. Removing someone takes away their roles here at once.
 */
const P = '/api/v1';
const HOURS = 72;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Site');
  return id;
};

/** What a person does, in plain words; each is a set of roles (Operators → advanced shows the roles themselves). */
export const PROFILES: Record<string, { label: string; hint: string; roles: Role[] }> = {
  admin: { label: 'Administrator', hint: 'Everything, including settings and users.', roles: ['HOTEL_ADMIN'] },
  frontOffice: { label: 'Front office / key desk', hint: 'Issues mobile keys and staff keycards; asks for unpaid-guest lock-outs.', roles: ['KEY_ISSUER'] },
  security: { label: 'Security manager', hint: 'Approves broad keys and lock-outs, emergencies, event log.', roles: ['SECURITY_MANAGER'] },
  deptManager: { label: 'Department manager', hint: 'Asks for keycards for their team.', roles: ['DEPT_MANAGER'] },
  management: { label: 'Management (reports)', hint: 'Reads reports, the event log and keycards per room.', roles: ['HOTEL_MANAGEMENT'] },
  maintenance: { label: 'Maintenance manager', hint: 'Battery status and maintenance requests.', roles: ['MAINTENANCE_MANAGER'] },
  hr: { label: 'HR', hint: 'Time & attendance, staff ID cards.', roles: ['HR_MANAGER'] },
  safety: { label: 'Safety / fire warden', hint: 'Live occupancy and roll call in an emergency.', roles: ['SAFETY'] },
  auditor: { label: 'Auditor (read only)', hint: 'Reads everything, changes nothing.', roles: ['AUDITOR'] },
};

const Invite = z.object({
  email: z.string().trim().email().max(160),
  displayName: z.string().trim().min(2).max(80),
  profile: z.enum(Object.keys(PROFILES) as [string, ...string[]]).optional(),
  roles: z.array(z.enum(ROLES)).max(10).optional(),
  sendEmail: z.boolean().default(false),
  /** Where the person opens the portal (the browser's own address); used only for the e-mail text. */
  portalUrl: z.string().url().max(200).optional(),
}).refine((b) => b.profile || b.roles?.length, 'Choose what the person does.');

async function newLink(c: any, hotelId: string, operatorId: string, by: string) {
  const token = randomBytes(32).toString('base64url');
  await c.query(`UPDATE operator_invites SET revoked_at=now() WHERE operator_id=$1 AND hotel_id=$2 AND used_at IS NULL AND revoked_at IS NULL`, [operatorId, hotelId]);
  await c.query(`INSERT INTO operator_invites (hotel_id, operator_id, token_hash, created_by, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5))`,
    [hotelId, operatorId, sha(token), by, HOURS]);
  return token;
}

async function emailLink(hotelId: string, to: string, name: string, link: string) {
  const ch = await channels(hotelId);
  if (!ch.email?.enabled) return { emailed: false, emailError: 'E-mail is not set up (Settings → Alerts & notifications). Copy the link instead.' };
  const prop = await getConfig(pool, hotelId, 'property');
  try {
    await sendEmail(ch.email, to, `Your access to ${prop?.displayName ?? 'Access Monitoring Tool'}`,
      `Hello ${name},\n\nYou have been given access to the ${prop?.displayName ?? ''} access monitoring portal.\nOpen this link within ${HOURS} hours and choose your password:\n\n${link}\n\nThe link works once. If it has expired, ask your administrator for a new one.`, hotelId);
    return { emailed: true };
  } catch (e) { return { emailed: false, emailError: (e as Error).message.slice(0, 160) }; }
}

export function inviteRoutes(app: FastifyInstance) {
  app.get(`${P}/hotels/:hotelId/operators/profiles`, async (req) => {
    await requirePerm(req, hid(req), 'operators.manage');
    return Object.entries(PROFILES).map(([id, p]) => ({ id, ...p }));
  });

  /** Invite someone (new, or already known on this server): roles here + a one-time link to set a password. */
  app.post(`${P}/hotels/:hotelId/operators/invite`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'operators.manage');
    const b = Invite.parse(req.body);
    const roles = [...new Set(b.profile ? PROFILES[b.profile]!.roles : b.roles!)];
    if (roles.includes('PLATFORM_ADMIN')) throw forbidden('Platform administrators are created by the platform team.');
    const r = await tx(async (c) => {
      let o = await one(c, 'SELECT id, status, password_hash IS NOT NULL AS has_pw FROM operators WHERE lower(email)=lower($1)', [b.email]);
      if (o?.status === 'DISABLED') throw new ApiError(409, 'DISABLED', 'This account is disabled on this server.');
      if (!o) o = await one(c, `INSERT INTO operators (email, display_name, status) VALUES ($1,$2,'INVITED') RETURNING id, status, false AS has_pw`, [b.email, b.displayName]);
      for (const role of roles) await c.query('INSERT INTO memberships (operator_id, hotel_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [o.id, hotelId, role]);
      // Someone who already has a password here just gets the roles; everyone else gets a link.
      const token = o.status === 'ACTIVE' && o.has_pw ? null : await newLink(c, hotelId, o.id, op.id);
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'operator.invited', targetType: 'operator', targetId: o.id,
        details: { email: b.email, roles, profile: b.profile ?? null, link: Boolean(token) } });
      return { id: o.id as string, token };
    });
    const link = r.token && b.portalUrl ? `${b.portalUrl.replace(/\/$/, '')}/invite#${r.token}` : null;
    const mail = r.token && b.sendEmail && link ? await emailLink(hotelId, b.email, b.displayName, link) : { emailed: false };
    return { id: r.id, token: r.token, existing: !r.token, expiresHours: HOURS, outsideLink: outsideLink(r.token), ...mail };
  });

  /** A new link: for someone who has not set a password yet, or (forgotten password) to choose a new one. The
   *  second takes over a working account, so the administrator confirms their own password first. */
  app.post(`${P}/hotels/:hotelId/operators/:operatorId/invite`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'operators.manage');
    const target = z.string().uuid().parse((req.params as any).operatorId);
    const b = z.object({ sendEmail: z.boolean().default(false), portalUrl: z.string().url().max(200).optional() }).parse(req.body ?? {});
    const t = await one(pool, `SELECT o.id, o.email, o.display_name, o.status, o.is_platform_admin FROM operators o JOIN memberships m ON m.operator_id=o.id AND m.hotel_id=$1 WHERE o.id=$2 LIMIT 1`, [hotelId, target]);
    if (!t || (t.is_platform_admin && !op.isPlatformAdmin)) throw notFound('Person');
    if (t.status === 'DISABLED') throw new ApiError(409, 'DISABLED', 'This account is disabled on this server.');
    if (target === op.id) throw forbidden('Change your own password under Your account.');
    if (t.status === 'ACTIVE') {
      await requireReauth(req, op);
      // A password link takes over the whole account: only where this administrator manages every site the person uses.
      const elsewhere = await one(pool, `SELECT 1 FROM memberships m WHERE m.operator_id=$1 AND m.hotel_id <> $2 LIMIT 1`, [target, hotelId]);
      if (elsewhere && !op.isPlatformAdmin) throw forbidden('This person also uses another site; ask a platform administrator for their password link.');
    }
    const token = await tx(async (c) => newLink(c, hotelId, target, op.id));
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: t.status === 'ACTIVE' ? 'operator.password_reset_link' : 'operator.invite_renewed', targetType: 'operator', targetId: target });
    const link = b.portalUrl ? `${b.portalUrl.replace(/\/$/, '')}/invite#${token}` : null;
    const mail = b.sendEmail && link ? await emailLink(hotelId, t.email, t.display_name, link) : { emailed: false };
    return { token, expiresHours: HOURS, outsideLink: outsideLink(token), ...mail };
  });

  /** Take away someone's access to this site (their roles here and any open link). */
  app.post(`${P}/hotels/:hotelId/operators/:operatorId/remove`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'operators.manage');
    const target = z.string().uuid().parse((req.params as any).operatorId);
    if (target === op.id) throw forbidden('You cannot remove yourself. Ask another administrator.');
    const t = await one(pool, `SELECT o.email, o.is_platform_admin FROM operators o JOIN memberships m ON m.operator_id=o.id AND m.hotel_id=$1 WHERE o.id=$2 LIMIT 1`, [hotelId, target]);
    if (!t || (t.is_platform_admin && !op.isPlatformAdmin)) throw notFound('Person');
    const admins = await one(pool, `SELECT count(DISTINCT operator_id)::int AS n FROM memberships WHERE hotel_id=$1 AND role='HOTEL_ADMIN' AND operator_id <> $2`, [hotelId, target]);
    const isAdmin = await one(pool, `SELECT 1 FROM memberships WHERE hotel_id=$1 AND operator_id=$2 AND role='HOTEL_ADMIN'`, [hotelId, target]);
    if (isAdmin && !admins?.n) throw new ApiError(409, 'LAST_ADMIN', 'This is the last administrator. Make someone else an administrator first.');
    await tx(async (c) => {
      const before = (await many(c, 'SELECT role FROM memberships WHERE operator_id=$1 AND hotel_id=$2', [target, hotelId])).map((r) => r.role);
      await c.query('DELETE FROM memberships WHERE operator_id=$1 AND hotel_id=$2', [target, hotelId]);
      await c.query('UPDATE operator_invites SET revoked_at=now() WHERE operator_id=$1 AND hotel_id=$2 AND used_at IS NULL AND revoked_at IS NULL', [target, hotelId]);
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'operator.removed', targetType: 'operator', targetId: target, details: { email: t.email, before } });
    });
    return { ok: true };
  });

  /**
   * 2.17 A portal user can also be a Visionline card holder (an operator with keycards). Linking them shows their
   * keycards next to their portal access, and marks them as a portal user in Visionline cards & people.
   */
  app.put(`${P}/hotels/:hotelId/operators/:operatorId/visionline-person`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'operators.manage');
    const target = z.string().uuid().parse((req.params as any).operatorId);
    const b = z.object({ vlUserId: z.string().trim().min(1).max(80).nullable() }).parse(req.body);
    if (!(await one(pool, 'SELECT 1 FROM memberships WHERE operator_id=$1 AND hotel_id=$2', [target, hotelId]))) throw notFound('Person');
    if (b.vlUserId === null) await pool.query('DELETE FROM operator_vl_links WHERE operator_id=$1 AND hotel_id=$2', [target, hotelId]);
    else {
      if (!(await one(pool, 'SELECT 1 FROM vl_users WHERE hotel_id=$1 AND user_id=$2', [hotelId, b.vlUserId]))) throw notFound('Visionline person');
      await pool.query(`INSERT INTO operator_vl_links (operator_id, hotel_id, vl_user_id, linked_by) VALUES ($1,$2,$3,$4)
        ON CONFLICT (operator_id, hotel_id) DO UPDATE SET vl_user_id=EXCLUDED.vl_user_id, linked_by=EXCLUDED.linked_by, linked_at=now()`, [target, hotelId, b.vlUserId, op.id]);
    }
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'operator.visionline_person_linked', targetType: 'operator', targetId: target, details: { vlUserId: b.vlUserId } });
    return { ok: true };
  });
  /** Visionline people whose name looks like this portal user's (to suggest the link). */
  app.get(`${P}/hotels/:hotelId/operators/:operatorId/visionline-person/suggest`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'operators.manage');
    const target = z.string().uuid().parse((req.params as any).operatorId);
    const o = await one(pool, 'SELECT display_name FROM operators WHERE id=$1', [target]);
    const q = z.string().trim().max(60).optional().parse((req.query as any).q) || o?.display_name || '';
    const words = q.split(/\s+/).filter((w: string) => w.length >= 2).slice(0, 3);
    if (!words.length) return [];
    return many(pool, `SELECT u.user_id, NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), '') AS name, u.user_group
      FROM vl_users u WHERE u.hotel_id=$1 AND u.active AND (${words.map((_: string, i: number) => `(u.given_name ILIKE $${i + 2} OR u.surname ILIKE $${i + 2} OR u.user_id ILIKE $${i + 2})`).join(' OR ')})
      ORDER BY u.surname NULLS LAST LIMIT 15`, [hotelId, ...words.map((w: string) => `%${w.replace(/[\\%_]/g, '')}%`)]);
  });

  // ---- The invited person (no sign-in; the link's secret is the proof) ---------------------------
  const hits = new Map<string, { n: number; since: number }>();
  const limit = (ip: string) => {
    const f = hits.get(ip);
    if (f && Date.now() - f.since < 600_000 && f.n >= 30) throw new ApiError(429, 'TOO_MANY', 'Too many attempts from this device. Try again in a few minutes.');
    if (!f || Date.now() - f.since >= 600_000) hits.set(ip, { n: 1, since: Date.now() }); else f.n++;
    if (hits.size > 20_000) hits.clear();
  };
  const find = async (token: string) => {
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw notFound('Invitation');
    const i = await one(pool, `SELECT i.*, o.email, o.display_name, o.status, h.name AS hotel FROM operator_invites i JOIN operators o ON o.id=i.operator_id JOIN hotels h ON h.id=i.hotel_id WHERE i.token_hash=$1`, [sha(token)]);
    if (!i || i.revoked_at) throw new ApiError(404, 'INVITE_INVALID', 'This link is not valid any more. Ask your administrator for a new one.');
    if (i.used_at) throw new ApiError(410, 'INVITE_USED', 'This link was already used. Sign in with your e-mail and password.');
    if (new Date(i.expires_at) < new Date()) throw new ApiError(410, 'INVITE_EXPIRED', 'This link has expired. Ask your administrator for a new one.');
    return i;
  };
  app.get(`${P}/public/invites/:token`, async (req) => {
    limit(req.ip);
    const i = await find((req.params as any).token);
    return { name: i.display_name, email: i.email, site: i.hotel, expiresAt: i.expires_at, reset: i.status === 'ACTIVE', testDays: i.access_days ?? null };
  });
  app.post(`${P}/public/invites/:token`, async (req) => {
    limit(req.ip);
    const b = z.object({ password: z.string().min(12, 'At least 12 characters').max(200) }).parse(req.body);
    const i = await find((req.params as any).token);
    if (b.password.toLowerCase().includes(String(i.email).split('@')[0]!.toLowerCase())) throw new ApiError(400, 'WEAK_PASSWORD', 'Choose a password that does not contain your e-mail name.');
    const ok = await tx(async (c) => {
      const u = await c.query(`UPDATE operator_invites SET used_at=now() WHERE id=$1 AND used_at IS NULL AND revoked_at IS NULL`, [i.id]);
      if (!u.rowCount) return false;
      await c.query(`UPDATE operators SET password_hash=$2, status='ACTIVE', token_version=token_version+1 WHERE id=$1 AND status <> 'DISABLED'`, [i.operator_id, hashPassword(b.password)]);
      // 2.25 A tester's access runs for the chosen number of days from the moment they accept.
      if (i.access_days) await c.query(`UPDATE operators SET access_until = now() + make_interval(days => $2) WHERE id=$1`, [i.operator_id, i.access_days]);
      await audit(c, { hotelId: i.hotel_id, actorType: 'operator', actorId: i.operator_id, action: 'operator.invite_accepted', targetType: 'operator', targetId: i.operator_id });
      return true;
    });
    if (!ok) throw new ApiError(410, 'INVITE_USED', 'This link was already used. Sign in with your e-mail and password.');
    // With two-step sign-in on (a password reset), the person signs in normally, code included.
    const mfa = (await one(pool, 'SELECT mfa_enabled FROM operators WHERE id=$1', [i.operator_id]))?.mfa_enabled;
    if (mfa) return { signIn: true, email: i.email };
    await pool.query('UPDATE operators SET last_sign_in_at=now() WHERE id=$1', [i.operator_id]);
    return { token: await operatorToken(i.operator_id, false), email: i.email };
  });
}
