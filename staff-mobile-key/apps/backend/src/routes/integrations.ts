import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool, one } from '../db.ts';
import { callbackAuthFor } from '../credential-services.ts';
import { getConfig } from '../hotel-config.ts';
import { handleCsCallback } from '../keys.ts';

/**
 * Credential Services callback receiver [CS §8]. Authenticated with the per-hotel Basic credentials we
 * registered. Credential Services ignores our response code and retries only on network failure, so
 * we always answer 200 once the payload is stored.
 */
export function integrationRoutes(app: FastifyInstance) {
  app.post('/integrations/credential-services/callback/:slug', async (req, reply) => {
    const hotel = await one(pool, 'SELECT id FROM hotels WHERE slug=$1', [(req.params as any).slug]);
    if (!hotel) return reply.code(404).send();
    const want = callbackAuthFor(hotel.id);
    const got = Buffer.from(String(req.headers.authorization ?? ''));
    const exp = Buffer.from('Basic ' + Buffer.from(`${want.username}:${want.password}`).toString('base64'));
    if (got.length !== exp.length || !timingSafeEqual(got, exp)) return reply.code(401).send();
    const cs = await getConfig(pool, hotel.id, 'credential_services');
    const outcome = await handleCsCallback(hotel.id, cs?.systemId ?? null, req.body ?? {});
    return reply.send({ ok: true, outcome });
  });
}
