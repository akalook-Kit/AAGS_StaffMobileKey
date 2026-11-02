import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db.ts';
import { audit } from '../audit.ts';
import { requirePerm } from '../auth.ts';
import { getConfig, saveConfig, validateConfig } from '../hotel-config.ts';
import { LICENSED_MODULES, licenceGate, licenceStatus, parseLicence } from '../licence.ts';
import { ApiError } from '../lib/errors.ts';

const P = '/api/v1';
const hid = (req: FastifyRequest) => z.string().uuid().parse((req.params as any).hotelId);

export function licenceRoutes(app: FastifyInstance) {
  // Every change inside a hotel passes the licence gate (reads, sign-in, revocation and this page always pass).
  app.addHook('preHandler', async (req) => {
    const id = (req.params as any)?.hotelId;
    if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) && req.url.startsWith(`${P}/hotels/`)) await licenceGate(req.method, req.url, id);
  });

  app.get(`${P}/hotels/:hotelId/licence`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'resources.read').catch((e) => requirePerm(req, hotelId, 'breakfast.read').catch(() => { throw e; }));
    return { ...(await licenceStatus(pool, hotelId)), moduleNames: LICENSED_MODULES };
  });

  app.put(`${P}/hotels/:hotelId/licence`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const b = z.object({ key: z.string().trim().min(20).max(8000) }).parse(req.body);
    const p = parseLicence(b.key);
    const cs = await getConfig(pool, hotelId, 'credential_services');
    if (p.systemId && cs?.systemId && Number(p.systemId) !== Number(cs.systemId))
      throw new ApiError(400, 'LICENCE_OTHER_HOTEL', `This licence is for ASSA ABLOY System ID ${p.systemId}; this hotel uses ${cs.systemId}.`);
    if (p.expires && Date.parse(`${p.expires}T23:59:59Z`) < Date.now()) throw new ApiError(400, 'LICENCE_EXPIRED', `This licence ended on ${p.expires}.`);
    const switchedOff: string[] = [];
    await tx(async (c) => {
      await c.query(`INSERT INTO hotel_licences (hotel_id, licence, payload, installed_by) VALUES ($1,$2,$3,$4)
        ON CONFLICT (hotel_id) DO UPDATE SET licence=EXCLUDED.licence, payload=EXCLUDED.payload, installed_at=now(), installed_by=EXCLUDED.installed_by`, [hotelId, b.key.replace(/\s+/g, ''), p, op.id]);
      // Modules that are on but not in the new licence are switched off (their data is kept).
      const f = (await getConfig(c, hotelId, 'features')) ?? {};
      const allowed = p.modules.includes('*') ? Object.keys(LICENSED_MODULES) : p.modules;
      const next = { ...f };
      for (const k of Object.keys(LICENSED_MODULES)) if (f[k] && !allowed.includes(k)) { next[k] = false; switchedOff.push(LICENSED_MODULES[k as keyof typeof LICENSED_MODULES]); }
      if (switchedOff.length) await saveConfig(c, hotelId, 'features', await validateConfig(c, hotelId, 'features', next), op.id);
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'licence.installed', details: { licence: p.id, customer: p.customer, modules: p.modules, expires: p.expires ?? null, switchedOff } });
    });
    return { ...(await licenceStatus(pool, hotelId)), switchedOff };
  });
}
