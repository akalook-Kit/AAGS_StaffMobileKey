import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Role } from '@smk/shared';
import { pool, one, many, tx } from '../db.ts';
import { audit } from '../audit.ts';
import { requireOperator, requirePerm } from '../auth.ts';
import { ApiError, forbidden, notFound } from '../lib/errors.ts';
import { DEMO_SLUG, demoSite, ensureDemoSite, resetDemo } from '../demo.ts';
import { outsideUrl } from './invites.ts';
import { channels } from '../monitoring/monitor.ts';
import { sendEmail } from '../monitoring/channels.ts';

/**
 * 2.25 Testers and feedback.
 *  - Platform administrators create the Demo Hotel (made-up data), reset it, and invite testers: each tester gets a
 *    one-time link (valid 72 hours) and access for a chosen number of days (7 by default) from the moment they accept.
 *    Testers belong to the Demo Hotel only, so they can never see a real site.
 *  - Everyone can send feedback from any page (Feedback button); administrators read it per site.
 */
const P = '/api/v1';
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
/** What a tester can do in the Demo Hotel: see and try everything a hotel team does, but not settings or users. */
export const TESTER_ROLES: Role[] = ['SECURITY_MANAGER', 'KEY_ISSUER', 'MAINTENANCE_MANAGER', 'HOTEL_MANAGEMENT'];

async function platformAdmin(req: FastifyRequest) {
  const op = await requireOperator(req);
  if (!op.isPlatformAdmin) throw forbidden('Only platform administrators manage the Demo Hotel and its testers.');
  return op;
}
async function demoOrThrow() {
  const d = await demoSite();
  if (!d) throw notFound('Demo Hotel');
  return d;
}
const signInLink = () => { const o = outsideUrl(); return o ? `${o}/?hotel=${DEMO_SLUG}` : null; };

export function demoRoutes(app: FastifyInstance) {
  app.get(`${P}/platform/demo`, async (req) => {
    await platformAdmin(req);
    const d = await demoSite();
    if (!d) return { exists: false };
    const testers = await many(pool, `SELECT o.id, o.display_name, o.email, o.status, o.access_until, o.last_sign_in_at,
        (SELECT max(created_at) FROM operator_invites i WHERE i.operator_id=o.id AND i.hotel_id=$1) AS invited_at,
        (SELECT i.access_days FROM operator_invites i WHERE i.operator_id=o.id AND i.hotel_id=$1 ORDER BY created_at DESC LIMIT 1) AS days,
        (SELECT count(*)::int FROM feedback f WHERE f.operator_id=o.id AND f.hotel_id=$1) AS feedback
      FROM operators o WHERE NOT o.is_platform_admin AND EXISTS (SELECT 1 FROM memberships m WHERE m.operator_id=o.id AND m.hotel_id=$1)
        AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.operator_id=o.id AND m.hotel_id<>$1)
      ORDER BY invited_at DESC NULLS LAST LIMIT 500`, [d.id]);
    const feedback = await many(pool, `SELECT f.id, f.page, f.rating, f.text, f.created_at, o.display_name AS who, h.name AS site FROM feedback f
        LEFT JOIN operators o ON o.id=f.operator_id JOIN hotels h ON h.id=f.hotel_id ORDER BY f.created_at DESC LIMIT 500`);
    return { exists: true, hotelId: d.id, name: d.name, signInLink: signInLink(),
      testers: testers.map((t) => ({ id: t.id, name: t.display_name, email: t.email, invitedAt: t.invited_at, days: t.days, accessUntil: t.access_until, lastSignIn: t.last_sign_in_at, feedback: t.feedback,
        state: t.access_until && new Date(t.access_until) <= new Date() ? 'ended' : t.status === 'INVITED' ? 'invited' : 'active' })),
      feedback: feedback.map((f) => ({ id: f.id, page: f.page, rating: f.rating, text: f.text, at: f.created_at, who: f.who ?? 'Removed account', site: f.site })) };
  });

  app.post(`${P}/platform/demo`, async (req) => {
    const op = await platformAdmin(req);
    return ensureDemoSite(op.id);
  });
  app.post(`${P}/platform/demo/reset`, async (req) => {
    const op = await platformAdmin(req);
    const d = await demoOrThrow();
    await resetDemo(d.id, op.id);
    return { ok: true };
  });

  /** Invite a tester: one-time link (72 hours), access for N days from acceptance, Demo Hotel only. */
  app.post(`${P}/platform/demo/testers`, async (req) => {
    const op = await platformAdmin(req);
    const d = await demoOrThrow();
    const b = z.object({ displayName: z.string().trim().min(2).max(80), email: z.string().trim().email().max(160), days: z.number().int().min(1).max(30).default(7),
      sendEmail: z.boolean().default(false), portalUrl: z.string().url().max(200).optional() }).parse(req.body);
    const r = await tx(async (c) => {
      let o = await one(c, `SELECT id, status, is_platform_admin FROM operators WHERE lower(email)=lower($1)`, [b.email]);
      if (o && (o.is_platform_admin || await one(c, `SELECT 1 FROM memberships WHERE operator_id=$1 AND hotel_id<>$2`, [o.id, d.id])))
        throw new ApiError(409, 'REAL_ACCOUNT', 'This e-mail already has access to a real site. Use another e-mail address for testing.');
      if (o?.status === 'DISABLED') throw new ApiError(409, 'DISABLED', 'This account is disabled on this server.');
      if (!o) o = await one(c, `INSERT INTO operators (email, display_name, status) VALUES ($1,$2,'INVITED') RETURNING id, status`, [b.email, b.displayName]);
      for (const role of TESTER_ROLES) await c.query(`INSERT INTO memberships (operator_id, hotel_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [o.id, d.id, role]);
      // A tester invited again starts afresh: a new link, a new period from acceptance.
      await c.query(`UPDATE operators SET access_until=NULL, status=CASE WHEN status='ACTIVE' THEN 'INVITED' ELSE status END, password_hash=NULL, token_version=token_version+1 WHERE id=$1`, [o.id]);
      await c.query(`UPDATE operator_invites SET revoked_at=now() WHERE operator_id=$1 AND used_at IS NULL AND revoked_at IS NULL`, [o.id]);
      const token = randomBytes(32).toString('base64url');
      await c.query(`INSERT INTO operator_invites (hotel_id, operator_id, token_hash, created_by, expires_at, access_days) VALUES ($1,$2,$3,$4, now() + interval '72 hours', $5)`, [d.id, o.id, sha(token), op.id, b.days]);
      await audit(c, { hotelId: d.id, actorType: 'operator', actorId: op.id, action: 'demo.tester_invited', targetType: 'operator', targetId: o.id, details: { email: b.email, days: b.days } });
      return { id: o.id as string, token };
    });
    const o = outsideUrl();
    const link = b.portalUrl ? `${b.portalUrl.replace(/\/$/, '')}/invite#${r.token}` : null;
    let mail: { emailed: boolean; emailError?: string } = { emailed: false };
    if (b.sendEmail && (o || link)) {
      const ch = await channels(d.id);
      // The Demo Hotel has no e-mail settings of its own: the first real site's are used.
      const real = ch.email?.enabled ? ch : await channels((await one(pool, `SELECT id FROM hotels WHERE NOT is_demo ORDER BY created_at LIMIT 1`))?.id ?? d.id);
      if (!real.email?.enabled) mail = { emailed: false, emailError: 'E-mail is not set up. Copy the link instead.' };
      else try {
        await sendEmail(real.email, b.email, 'Try the Access Monitoring Tool (Demo Hotel)', `Hello ${b.displayName},\n\nYou are invited to try the Access Monitoring Tool with the Demo Hotel: made-up doors, people and keycards.\nOpen this link within 72 hours and choose a password (it works once):\n\n${o ? `${o}/invite#${r.token}` : link}\n\nYour access lasts ${b.days} day${b.days === 1 ? '' : 's'} from then. Use the Feedback button on any page to tell us what you think.\n`, d.id);
        mail = { emailed: true };
      } catch (e) { mail = { emailed: false, emailError: (e as Error).message.slice(0, 160) }; }
    }
    return { id: r.id, token: r.token, expiresHours: 72, days: b.days, outsideLink: o ? `${o}/invite#${r.token}` : null, signInLink: signInLink(), ...mail };
  });

  app.post(`${P}/platform/demo/testers/:id/end`, async (req) => {
    const op = await platformAdmin(req);
    const d = await demoOrThrow();
    const id = z.string().uuid().parse((req.params as any).id);
    const t = await one(pool, `SELECT o.id FROM operators o WHERE o.id=$1 AND NOT o.is_platform_admin AND EXISTS (SELECT 1 FROM memberships m WHERE m.operator_id=o.id AND m.hotel_id=$2)
      AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.operator_id=o.id AND m.hotel_id<>$2)`, [id, d.id]);
    if (!t) throw notFound('Tester');
    await pool.query(`UPDATE operators SET access_until=now(), token_version=token_version+1 WHERE id=$1`, [id]);
    await pool.query(`UPDATE operator_invites SET revoked_at=now() WHERE operator_id=$1 AND used_at IS NULL AND revoked_at IS NULL`, [id]);
    await audit(null, { hotelId: d.id, actorType: 'operator', actorId: op.id, action: 'demo.tester_ended', targetType: 'operator', targetId: id });
    return { ok: true };
  });

  app.get(`${P}/platform/demo/feedback.csv`, async (req, reply) => {
    await platformAdmin(req);
    const rows = await many(pool, `SELECT f.created_at, h.name AS site, o.display_name AS who, f.page, f.rating, f.text FROM feedback f LEFT JOIN operators o ON o.id=f.operator_id JOIN hotels h ON h.id=f.hotel_id ORDER BY f.created_at DESC LIMIT 5000`);
    const cell = (v: unknown) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="feedback.csv"');
    return '﻿' + ['When,Site,Who,Page,Rating,Feedback', ...rows.map((r) => [r.created_at?.toISOString?.(), r.site, r.who, r.page, r.rating, r.text].map(cell).join(','))].join('\r\n');
  });

  // ---- Feedback from any page -----------------------------------------------------------------------------------
  const sent = new Map<string, number[]>();
  app.post(`${P}/hotels/:hotelId/feedback`, async (req) => {
    const hotelId = z.string().uuid().parse((req.params as any).hotelId);
    const op = await requireOperator(req);
    if (!op.isPlatformAdmin && !op.roles.has(hotelId)) throw forbidden('You are not a member of this site.');
    const b = z.object({ text: z.string().trim().min(2).max(3000), rating: z.number().int().min(1).max(5).nullable().optional(), page: z.string().max(200).optional() }).parse(req.body);
    const now = Date.now(); const mine = (sent.get(op.id) ?? []).filter((t) => now - t < 3_600_000);
    if (mine.length >= 20) throw new ApiError(429, 'TOO_MANY', 'Thank you! That is a lot of feedback for one hour; try again later.');
    sent.set(op.id, [...mine, now]);
    const f = await one(pool, `INSERT INTO feedback (hotel_id, operator_id, page, rating, text) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [hotelId, op.id, b.page ?? null, b.rating ?? null, b.text]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'feedback.sent', targetType: 'feedback', targetId: f!.id, details: { page: b.page ?? null, rating: b.rating ?? null } });
    return { ok: true };
  });
  app.get(`${P}/hotels/:hotelId/feedback`, async (req) => {
    const hotelId = z.string().uuid().parse((req.params as any).hotelId);
    await requirePerm(req, hotelId, 'settings.manage');
    return many(pool, `SELECT f.id, f.page, f.rating, f.text, f.created_at AS at, o.display_name AS who FROM feedback f LEFT JOIN operators o ON o.id=f.operator_id WHERE f.hotel_id=$1 ORDER BY f.created_at DESC LIMIT 500`, [hotelId]);
  });
}
