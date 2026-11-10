import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { EditionId } from '@smk/shared';
import { pool, one } from './db.ts';
import { hashPassword } from './auth.ts';

/**
 * 2.33 The edition of this installation (SMK_EDITION, written by the installer of an edition MSI) and, for the light
 * edition, open access (SMK_OPEN_ACCESS=lan): people on the hotel's own network open the reports without signing in.
 * Open access is read-only (the Auditor role), only through the gateway's LAN listener from a private address, never
 * from the external (internet) listener; administration still needs a password.
 */
export const edition = (): EditionId => (process.env.SMK_EDITION === 'light' ? 'light' : 'full');
export const openAccessOn = () => edition() === 'light' && process.env.SMK_OPEN_ACCESS === 'lan';
export const OPEN_ACCESS_EMAIL = 'open-access@reports.local';

const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^127\./, /^::1$/, /^f[cd][0-9a-f]{2}:/i, /^fe80:/i];
export const isPrivateIp = (ip: string) => PRIVATE.some((r) => r.test(ip.replace(/^::ffff:/, '')));

/** Whether this request may open the portal without signing in. */
export function openAccessAllowed(req: FastifyRequest) {
  if (!openAccessOn()) return { ok: false as const, why: 'Open access is not switched on in this installation.' };
  const listener = String(req.headers['x-smk-listener'] ?? '');
  // Through the gateway: only its LAN listener. Directly (development, or a service on this server): only loopback,
  // and only when SMK_OPEN_ACCESS_DIRECT=1.
  const viaGateway = listener !== '';
  if (viaGateway && listener !== 'lan') return { ok: false as const, why: 'Sign in: open access is only on the hotel network.' };
  if (!viaGateway && !(process.env.SMK_OPEN_ACCESS_DIRECT === '1' && /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress ?? ''))) return { ok: false as const, why: 'Sign in: open access is only on the hotel network.' };
  if (!isPrivateIp(req.ip)) return { ok: false as const, why: 'Sign in: open access is only on the hotel network.' };
  return { ok: true as const };
}

/** The built-in read-only account used by open access (Auditor on every site of this installation). */
export async function openAccessOperator() {
  let op = await one(pool, `SELECT id FROM operators WHERE lower(email)=$1`, [OPEN_ACCESS_EMAIL]);
  if (!op) op = await one(pool, `INSERT INTO operators (email, display_name, password_hash, is_platform_admin) VALUES ($1,'Reports (no sign-in)',$2,false) ON CONFLICT DO NOTHING RETURNING id`,
    [OPEN_ACCESS_EMAIL, hashPassword(randomBytes(32).toString('base64url'))]) ?? await one(pool, `SELECT id FROM operators WHERE lower(email)=$1`, [OPEN_ACCESS_EMAIL]);
  await pool.query(`INSERT INTO memberships (operator_id, hotel_id, role) SELECT $1, h.id, 'AUDITOR' FROM hotels h WHERE NOT h.is_demo ON CONFLICT DO NOTHING`, [op!.id]);
  return op!.id as string;
}
