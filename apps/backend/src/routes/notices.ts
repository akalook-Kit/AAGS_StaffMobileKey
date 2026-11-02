import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, many, one } from '../db.ts';
import { audit } from '../audit.ts';
import { requireOperator, requirePerm } from '../auth.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { resolveHotelSlug } from './mobile.ts';

/**
 * 2.17 Notice board: short posts (with an optional picture) written by administrators. "Public" posts are also shown
 * on the sign-in page, before anyone signs in, so they must never hold anything confidential; the rest is shown on
 * the Overview to people of this site.
 */
const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Site');
  return id;
};
const Body = z.object({
  title: z.string().trim().min(2).max(120),
  body: z.string().trim().max(2000).default(''),
  kind: z.enum(['info', 'important', 'tip', 'event']).default('info'),
  public: z.boolean().default(false),
  pinned: z.boolean().default(false),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  image: z.string().regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/).max(560_000).nullable().optional(),
});
const view = (n: any, full: boolean) => ({
  id: n.id, title: n.title, body: n.body, kind: n.kind, pinned: n.pinned, startsAt: n.starts_at, image: n.image ?? null,
  ...(full ? { public: n.public, endsAt: n.ends_at, author: n.author ?? null } : {}),
});
const ACTIVE = `starts_at <= now() AND (ends_at IS NULL OR ends_at > now())`;

export function noticeRoutes(app: FastifyInstance) {
  /** Sign-in page: public posts only (title, text, picture, date). Nothing else about the site. */
  const hits = new Map<string, { n: number; since: number }>();
  app.get(`${P}/public/notices`, async (req) => {
    const f = hits.get(req.ip);
    if (f && Date.now() - f.since < 60_000 && f.n >= 60) return { notices: [] };
    if (!f || Date.now() - f.since >= 60_000) hits.set(req.ip, { n: 1, since: Date.now() }); else f.n++;
    if (hits.size > 20_000) hits.clear();
    const raw = z.string().max(60).regex(/^[a-z0-9-]+$/).default('default').parse((req.query as any).hotel ?? 'default');
    let slug: string;
    try { slug = await resolveHotelSlug(raw); } catch { return { notices: [] }; }
    const rows = await many(pool, `SELECT n.* FROM notices n JOIN hotels h ON h.id=n.hotel_id WHERE h.slug=$1 AND n.public AND ${ACTIVE.replace(/starts_at|ends_at/g, (m) => `n.${m}`)}
      ORDER BY n.pinned DESC, n.starts_at DESC LIMIT 10`, [slug]);
    return { notices: rows.map((n) => view(n, false)) };
  });

  app.get(`${P}/hotels/:hotelId/notices`, async (req) => {
    const hotelId = hid(req);
    const op = await requireOperator(req);
    if (!op.isPlatformAdmin && !op.roles.has(hotelId)) throw forbidden('You are not a member of this site.');
    const all = (req.query as any).all === '1';
    const rows = await many(pool, `SELECT n.*, o.display_name AS author FROM notices n LEFT JOIN operators o ON o.id=n.created_by
      WHERE n.hotel_id=$1 ${all ? '' : `AND ${ACTIVE.replace(/starts_at|ends_at/g, (m) => `n.${m}`)}`} ORDER BY n.pinned DESC, n.starts_at DESC LIMIT 50`, [hotelId]);
    return rows.map((n) => view(n, true));
  });
  app.post(`${P}/hotels/:hotelId/notices`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const b = Body.parse(req.body);
    const n = await one(pool, `SELECT count(*)::int AS n FROM notices WHERE hotel_id=$1`, [hotelId]);
    if (n!.n >= 500) throw forbidden('Too many posts; delete old ones first.');
    const r = await one(pool, `INSERT INTO notices (hotel_id, title, body, kind, public, pinned, starts_at, ends_at, image, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, now()),$8,$9,$10) RETURNING *`, [hotelId, b.title, b.body, b.kind, b.public, b.pinned, b.startsAt ?? null, b.endsAt ?? null, b.image ?? null, op.id]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'notice.posted', targetType: 'notice', targetId: r!.id, details: { title: b.title, public: b.public } });
    return view(r, true);
  });
  app.put(`${P}/hotels/:hotelId/notices/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const b = Body.parse(req.body);
    const r = await one(pool, `UPDATE notices SET title=$3, body=$4, kind=$5, public=$6, pinned=$7, starts_at=COALESCE($8, starts_at), ends_at=$9, image=$10, updated_at=now()
      WHERE id=$1 AND hotel_id=$2 RETURNING *`, [z.string().uuid().parse((req.params as any).id), hotelId, b.title, b.body, b.kind, b.public, b.pinned, b.startsAt ?? null, b.endsAt ?? null, b.image ?? null]);
    if (!r) throw notFound('Post');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'notice.changed', targetType: 'notice', targetId: r.id, details: { title: b.title, public: b.public } });
    return view(r, true);
  });
  app.delete(`${P}/hotels/:hotelId/notices/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const r = await one(pool, `DELETE FROM notices WHERE id=$1 AND hotel_id=$2 RETURNING title`, [z.string().uuid().parse((req.params as any).id), hotelId]);
    if (!r) throw notFound('Post');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'notice.deleted', targetType: 'notice', details: { title: r.title } });
    return { ok: true };
  });
}
