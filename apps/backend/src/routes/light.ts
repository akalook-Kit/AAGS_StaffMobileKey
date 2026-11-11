import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SealedSecret } from '@smk/shared';
import { pool, one } from '../db.ts';
import { audit } from '../audit.ts';
import { requirePerm } from '../auth.ts';
import { enqueue, newCorrelationId } from '../commands.ts';
import { getConfig, saveConfig, validateConfig } from '../hotel-config.ts';
import { requestDiscovery } from '../visionline-sync.ts';
import { edition } from '../edition.ts';
import { ApiError, conflict, notFound } from '../lib/errors.ts';
import { isOnline } from './portal.ts';

/**
 * 2.34 Light edition (Armel, 11 Nov: "doesn't request any configuration except the credentials for Visionline, and
 * then it connects automatically"). The connector is installed with the platform on the Visionline server and
 * registered by the installer; the hotel team only gives the Visionline account here, on the hotel network, without
 * signing in. The password is encrypted in the browser for the connector (the platform never sees it), the connector
 * tests it with Visionline before using it, and then the doors are read and battery monitoring is switched on by
 * itself.
 */
const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Site');
  return id;
};
/** A command's error is stored as { code, message }: the portal shows the message. */
const errText = (e: any): string | null => (e == null ? null : typeof e === 'string' ? e : typeof e.message === 'string' ? e.message : String(e.code ?? 'Error'));
const lightOnly = () => { if (edition() !== 'light') throw notFound('Page'); };

async function connectorRow(hotelId: string) {
  return one(pool, `SELECT id, name, seal_public_key, seal_key_id, last_seen_at, health FROM connectors WHERE hotel_id=$1 AND status='ACTIVE' ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [hotelId]);
}

/** Once Visionline answers with the account: read the doors (first time) and switch battery monitoring on. */
async function settle(hotelId: string, health: any) {
  if (!health?.credentialsConfigured || !health?.visionlineReachable) return;
  const doors = await one(pool, `SELECT count(*)::int AS n FROM resources WHERE hotel_id=$1 AND kind='door' AND active`, [hotelId]);
  const recent = await one(pool, `SELECT 1 FROM commands WHERE hotel_id=$1 AND type='DISCOVER_RESOURCES' AND created_at > now() - interval '15 minutes' LIMIT 1`, [hotelId]);
  if (!doors?.n && !recent) await requestDiscovery(pool, hotelId, null, 'light edition: first connection');
  const f = await getConfig(pool, hotelId, 'features');
  if (f && (!f.batteryMonitoring || !f.maintenance)) {
    // Battery monitoring needs a connector that reads battery events (validateConfig checks it); maintenance alone otherwise.
    for (const next of [{ ...f, batteryMonitoring: true, maintenance: true }, { ...f, maintenance: true }]) {
      try { await saveConfig(pool, hotelId, 'features', await validateConfig(pool, hotelId, 'features', next), null); break; } catch { /* not yet possible: try the next, or again later */ }
    }
  }
}

export function lightRoutes(app: FastifyInstance) {
  /** Where the connection to Visionline stands, and the connector's encryption key for the form. */
  app.get(`${P}/hotels/:hotelId/light/connection`, async (req) => {
    lightOnly();
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'battery.read');
    const c = await connectorRow(hotelId);
    const h = (c?.health ?? {}) as any;
    if (c) await settle(hotelId, h);
    const doors = await one(pool, `SELECT count(*)::int AS n FROM resources WHERE hotel_id=$1 AND kind='door' AND active`, [hotelId]);
    const disc = await one(pool, `SELECT status, error, created_at, completed_at FROM commands WHERE hotel_id=$1 AND type='DISCOVER_RESOURCES' ORDER BY created_at DESC LIMIT 1`, [hotelId]);
    const last = await one(pool, `SELECT id, status, error, created_at FROM commands WHERE hotel_id=$1 AND type='SET_PROPERTY_CREDENTIALS' ORDER BY created_at DESC LIMIT 1`, [hotelId]);
    const hotel = await one(pool, `SELECT name FROM hotels WHERE id=$1`, [hotelId]);
    const online = Boolean(c && isOnline(c.last_seen_at));
    const ok = online && Boolean(h.credentialsConfigured) && Boolean(h.visionlineReachable);
    return {
      hotelName: hotel?.name ?? null,
      state: !c ? 'no-connector' : !online ? 'connector-offline' : !h.credentialsConfigured ? 'needs-account' : !h.visionlineReachable ? 'visionline-unreachable' : 'connected',
      connected: ok,
      connector: c ? { online, lastSeen: c.last_seen_at, version: h.connectorVersion ?? null } : null,
      visionline: { url: h.visionlineBaseUrl ?? null, reachable: Boolean(h.visionlineReachable), username: h.propertyUsername ?? null, lastError: errText(h.lastError) },
      sealingKey: c?.seal_key_id ? { keyId: c.seal_key_id, publicKey: c.seal_public_key } : null,
      doors: doors?.n ?? 0,
      discovery: disc ? { status: disc.status, error: errText(disc.error), at: disc.completed_at ?? disc.created_at } : null,
      lastAccount: last ? { commandId: last.id, status: last.status, error: errText(last.error), at: last.created_at } : null,
    };
  });

  /** The Visionline account, encrypted in the browser for the connector; the connector tests it before using it. */
  app.put(`${P}/hotels/:hotelId/light/connection`, async (req) => {
    lightOnly();
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'battery.manage');
    const b = z.object({ username: z.string().trim().min(1).max(100), sealed: SealedSecret }).parse(req.body);
    const c = await connectorRow(hotelId);
    if (!c?.seal_key_id) throw conflict('CONNECTOR_NOT_READY', 'The connector on this server has not started yet. Wait a minute and try again.');
    if (c.seal_key_id !== b.sealed.keyId) throw conflict('STALE_SEALING_KEY', 'The connector key changed while you were typing. Reload the page and try again.');
    const busy = await one(pool, `SELECT 1 FROM commands WHERE hotel_id=$1 AND type='SET_PROPERTY_CREDENTIALS' AND status IN ('PENDING','LEASED') AND expires_at > now() LIMIT 1`, [hotelId]);
    if (busy) throw new ApiError(409, 'BUSY', 'The connector is already testing an account. Wait a minute.');
    const corr = newCorrelationId();
    const cmd = await enqueue(pool, { hotelId, type: 'SET_PROPERTY_CREDENTIALS', payload: b, idempotencyKey: `property-creds:${randomUUID()}`, correlationId: corr, ttlSec: 300 });
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'visionline.property_credentials_submitted', targetType: 'command', targetId: cmd.id, correlationId: corr, details: { username: b.username, via: 'light edition' } });
    return { commandId: cmd.id };
  });

  /** Whether the connector accepted the account (only that command can be followed here). */
  app.get(`${P}/hotels/:hotelId/light/connection/:commandId`, async (req) => {
    lightOnly();
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'battery.read');
    const c = await one(pool, `SELECT id, status, error, completed_at FROM commands WHERE id=$1 AND hotel_id=$2 AND type='SET_PROPERTY_CREDENTIALS'`, [z.string().uuid().parse((req.params as any).commandId), hotelId]);
    if (!c) throw notFound('Command');
    if (c.status === 'SUCCEEDED') { const r = await connectorRow(hotelId); if (r) await settle(hotelId, { ...(r.health ?? {}), credentialsConfigured: true, visionlineReachable: true }); }
    return { id: c.id, status: c.status, error: errText(c.error), completedAt: c.completed_at };
  });

  /** The hotel's name and logo, as shown on the portal and on the printed reports. */
  app.put(`${P}/hotels/:hotelId/light/hotel`, async (req) => {
    lightOnly();
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'battery.manage');
    const b = z.object({ name: z.string().trim().min(2).max(80).optional(), logo: z.string().max(800_000).nullable().optional() }).parse(req.body);
    if (b.name) {
      await pool.query(`UPDATE hotels SET name=$2 WHERE id=$1`, [hotelId, b.name]);
    }
    const br = await getConfig(pool, hotelId, 'branding');
    if (br && (b.name || b.logo !== undefined)) {
      const next = { ...br, ...(b.name ? { appName: b.name.slice(0, 30), portalTitle: b.name.slice(0, 60) } : {}), ...(b.logo !== undefined ? { logo: b.logo || undefined } : {}) };
      if (next.appName.length < 2) next.appName = br.appName;
      await saveConfig(pool, hotelId, 'branding', await validateConfig(pool, hotelId, 'branding', next), op.id);
    }
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'hotel.light_details_changed', targetType: 'hotel', targetId: hotelId, details: { name: b.name ?? null, logo: b.logo === undefined ? 'unchanged' : b.logo ? 'set' : 'removed' } });
    return { ok: true };
  });
}
