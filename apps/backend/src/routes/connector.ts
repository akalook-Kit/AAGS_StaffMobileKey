import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CONTRACT_VERSION, CommandResult, ConnectorHealth, VisionlineEventsBatch } from '@smk/shared';
import { processVisionlineBatch } from '../visionline-events.ts';
import { pool, one } from '../db.ts';
import { audit } from '../audit.ts';
import { lease, complete } from '../commands.ts';
import { getConfig } from '../hotel-config.ts';
import { ApiError } from '../lib/errors.ts';

/**
 * Connector channel (spec §4.1, §12.1.1): the connector on the Visionline PC makes OUTBOUND HTTPS calls
 * only. It long-polls for commands and reports results and health. Nothing connects inbound to the hotel.
 */
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

async function connectorAuth(req: FastifyRequest) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw new ApiError(401, 'UNAUTHENTICATED', 'Connector token required');
  const c = await one(pool, `SELECT * FROM connectors WHERE token_hash=$1 AND status='ACTIVE'`, [hashToken(h.slice(7))]);
  if (!c) throw new ApiError(401, 'UNAUTHENTICATED', 'Unknown or disabled connector token');
  const inst = req.headers['x-installation-uuid'];
  if (c.installation_uuid && inst !== c.installation_uuid) throw new ApiError(409, 'INSTALLATION_MISMATCH', 'This token is bound to a different connector installation');
  return c;
}

export function connectorRoutes(app: FastifyInstance) {
  app.post('/connector/v1/hello', async (req) => {
    const c = await connectorAuth(req);
    const b = z.object({ installationUuid: z.string().uuid(), version: z.string(), contractVersion: z.string(), sealPublicKey: z.string().startsWith('-----BEGIN PUBLIC KEY-----').optional(), sealKeyId: z.string().optional() }).parse(req.body);
    if (b.contractVersion !== CONTRACT_VERSION) throw new ApiError(426, 'CONTRACT_MISMATCH', `Platform speaks ${CONTRACT_VERSION}; connector speaks ${b.contractVersion}. Update the connector.`);
    if (!c.installation_uuid) {
      // Bind the token to the first installation that uses it; a copied token cannot be used elsewhere.
      await pool.query('UPDATE connectors SET installation_uuid=$2 WHERE id=$1', [c.id, b.installationUuid]);
      await audit(null, { hotelId: c.hotel_id, actorType: 'connector', actorId: c.id, action: 'connector.bound', details: { installationUuid: b.installationUuid, version: b.version } });
    } else if (c.installation_uuid !== b.installationUuid) throw new ApiError(409, 'INSTALLATION_MISMATCH', 'This token is bound to a different connector installation');
    if (b.sealPublicKey && b.sealKeyId && b.sealKeyId !== c.seal_key_id) {
      // New or rotated sealing key: secrets sealed for the old key can no longer be opened.
      await pool.query('UPDATE connectors SET seal_public_key=$2, seal_key_id=$3 WHERE id=$1', [c.id, b.sealPublicKey, b.sealKeyId]);
      await pool.query(`UPDATE operator_vl_credentials SET status='FAILED', status_detail='The hotel connector was reinstalled. Enter your Visionline password again.' WHERE hotel_id=$1 AND key_id<>$2`, [c.hotel_id, b.sealKeyId]);
      await audit(null, { hotelId: c.hotel_id, actorType: 'connector', actorId: c.id, action: 'connector.sealing_key_registered', details: { keyId: b.sealKeyId, previous: c.seal_key_id } });
    }
    const hotel = await one(pool, 'SELECT id, slug, name, timezone FROM hotels WHERE id=$1', [c.hotel_id]);
    const property = await getConfig(pool, c.hotel_id, 'property');
    return { connectorId: c.id, hotel: { ...hotel, timezone: property?.timezone ?? hotel.timezone }, contractVersion: CONTRACT_VERSION, serverTime: new Date().toISOString() };
  });

  app.post('/connector/v1/heartbeat', async (req) => {
    const c = await connectorAuth(req);
    const health = ConnectorHealth.parse(req.body);
    await pool.query('UPDATE connectors SET last_seen_at=now(), health=$2 WHERE id=$1', [c.id, health]);
    return { serverTime: new Date().toISOString() };
  });

  app.post('/connector/v1/commands/lease', async (req) => {
    const c = await connectorAuth(req);
    const b = z.object({ max: z.number().int().min(1).max(10).default(5), waitSec: z.number().int().min(0).max(25).default(20) }).parse(req.body ?? {});
    await pool.query('UPDATE connectors SET last_seen_at=now() WHERE id=$1', [c.id]);
    const deadline = Date.now() + b.waitSec * 1000;
    for (;;) {
      const cmds = await lease(c, b.max);
      if (cmds.length || Date.now() >= deadline) return { commands: cmds, serverTime: new Date().toISOString() };
      await new Promise((r) => setTimeout(r, 500));
      if (req.raw.destroyed) return { commands: [] };
    }
  });

  /** Card changes and lock events the connector saw in Visionline (/callback watch or catch-up). */
  app.post('/connector/v1/visionline-events', async (req) => {
    const c = await connectorAuth(req);
    const b = VisionlineEventsBatch.parse(req.body);
    await pool.query('UPDATE connectors SET last_seen_at=now() WHERE id=$1', [c.id]);
    return { ok: true, ...(await processVisionlineBatch(c.hotel_id, b)) };
  });

  app.post('/connector/v1/commands/:id/result', async (req, reply) => {
    const c = await connectorAuth(req);
    const result = CommandResult.parse(req.body);
    const r = await complete(c, (req.params as any).id, result);
    if (r.status === 404) throw new ApiError(404, 'NOT_FOUND', 'Unknown command');
    return reply.send({ ok: true, duplicate: r.duplicate ?? false });
  });
}
