import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { permissionsFor, type Permission, type Role } from '@smk/shared';
import { config } from './config.ts';
import { pool, many, one } from './db.ts';
import { ApiError, forbidden } from './lib/errors.ts';

// ---- Passwords (local development accounts; production federates to the hotel IdP, spec §13.4.4) --------
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [alg, n, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const h = scryptSync(pw, Buffer.from(salt, 'base64'), 32, { N: Number(n), r: 8, p: 1 });
  const ref = Buffer.from(hash, 'base64');
  return h.length === ref.length && timingSafeEqual(h, ref);
}

// ---- TOTP (RFC 6238) for operator MFA --------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret(): string {
  return Array.from(randomBytes(20)).map((b) => B32[b % 32]).join('');
}
function b32decode(s: string): Buffer {
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totp(secret: string, t = Date.now(), step = 30): string {
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / step)));
  const h = createHmac('sha1', b32decode(secret)).update(ctr).digest();
  const o = h[h.length - 1]! & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}
export function verifyTotp(secret: string, code: string): boolean {
  return [-1, 0, 1].some((w) => totp(secret, Date.now() + w * 30_000) === code.trim());
}

// ---- Brute-force throttling ----------------------------------------------------------------------
const failures = new Map<string, { n: number; until: number }>();
export function checkThrottle(key: string) {
  const f = failures.get(key);
  if (f && f.until > Date.now()) throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts. Try again in 15 minutes.');
}
export function recordFailure(key: string) {
  const f = failures.get(key) ?? { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 15 * 60_000; f.n = 0; }
  failures.set(key, f);
}
export const clearFailures = (key: string) => failures.delete(key);

// ---- Tokens ------------------------------------------------------------------------------------
const key = new TextEncoder().encode(config.jwtSecret);
export type TokenClaims =
  | { typ: 'op'; sub: string; mfa: boolean }
  | { typ: 'staff'; sub: string; hid: string };

export async function signToken(claims: TokenClaims, ttl = '8h') {
  return new SignJWT({ ...claims }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(ttl).setIssuer('smk').sign(key);
}
async function readToken(req: FastifyRequest): Promise<TokenClaims> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in required.');
  try {
    const { payload } = await jwtVerify(h.slice(7), key, { issuer: 'smk' });
    return payload as unknown as TokenClaims;
  } catch {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Session expired. Sign in again.');
  }
}

// ---- Operator context ------------------------------------------------------------------------------
export interface OperatorCtx {
  id: string; email: string; displayName: string; isPlatformAdmin: boolean;
  roles: Map<string, Role[]>; // hotelId -> roles
}

export async function requireOperator(req: FastifyRequest): Promise<OperatorCtx> {
  if ((req as any).operator) return (req as any).operator;
  const t = await readToken(req);
  if (t.typ !== 'op') throw new ApiError(401, 'UNAUTHENTICATED', 'Operator sign-in required.');
  const op = await one(pool, 'SELECT id, email, display_name, is_platform_admin, status FROM operators WHERE id=$1', [t.sub]);
  if (!op || op.status !== 'ACTIVE') throw new ApiError(401, 'UNAUTHENTICATED', 'Account is disabled.');
  const roles = new Map<string, Role[]>();
  for (const m of await many(pool, 'SELECT hotel_id, role FROM memberships WHERE operator_id=$1', [op.id])) {
    roles.set(m.hotel_id, [...(roles.get(m.hotel_id) ?? []), m.role]);
  }
  const ctx: OperatorCtx = { id: op.id, email: op.email, displayName: op.display_name, isPlatformAdmin: op.is_platform_admin, roles };
  (req as any).operator = ctx;
  return ctx;
}

export function permsIn(op: OperatorCtx, hotelId: string): Set<Permission> {
  if (op.isPlatformAdmin) return permissionsFor(['PLATFORM_ADMIN']);
  return permissionsFor(op.roles.get(hotelId) ?? []);
}

/** Enforces hotel membership (tenant isolation) and a permission. Returns the operator. */
export async function requirePerm(req: FastifyRequest, hotelId: string, perm: Permission): Promise<OperatorCtx> {
  const op = await requireOperator(req);
  if (!op.isPlatformAdmin && !op.roles.has(hotelId)) throw forbidden('You are not a member of this hotel.');
  if (!permsIn(op, hotelId).has(perm)) throw forbidden(`Missing permission: ${perm}`);
  return op;
}

export async function requireStaff(req: FastifyRequest): Promise<{ staffId: string; hotelId: string }> {
  const t = await readToken(req);
  if (t.typ !== 'staff') throw new ApiError(401, 'UNAUTHENTICATED', 'Staff sign-in required.');
  const s = await one(pool, 'SELECT status FROM staff WHERE id=$1 AND hotel_id=$2', [t.sub, t.hid]);
  if (!s || s.status !== 'ACTIVE') throw new ApiError(401, 'UNAUTHENTICATED', 'Your access has been suspended. Contact your supervisor.');
  return { staffId: t.sub, hotelId: t.hid };
}
