import { createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { permissionsFor, withoutModules, type Permission, type Role } from '@smk/shared';
import { config } from './config.ts';
import { pool, many, one } from './db.ts';
import { ApiError, forbidden } from './lib/errors.ts';

// ---- Passwords (local development accounts; production federates to the hotel IdP, spec §13.4.4) --------
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${h.toString('base64')}`;
}
const scryptAsync = (pw: string, salt: Buffer, n: number) => new Promise<Buffer>((res, rej) => scrypt(pw, salt, 32, { N: n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
const DUMMY_HASH = hashPassword('not-a-real-password');
/**
 * 2.13 (security review) Sign-in check that takes the same time whether or not the account exists (no e-mail
 * guessing from response times) and does not block the server while hashing (scrypt runs in the thread pool).
 */
export async function checkPassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  const use = stored && stored.startsWith('scrypt$') ? stored : DUMMY_HASH;
  const [, n, salt, hash] = use.split('$');
  const h = await scryptAsync(pw, Buffer.from(salt!, 'base64'), Number(n));
  const ref = Buffer.from(hash!, 'base64');
  return use === stored && h.length === ref.length && timingSafeEqual(h, ref);
}
/** Failed sign-ins per address too, so one computer cannot try a password on many accounts. */
const ipFailures = new Map<string, { n: number; since: number }>();
export function checkIpThrottle(ip: string) {
  const f = ipFailures.get(ip);
  if (f && Date.now() - f.since < 15 * 60_000 && f.n >= 30) throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts from this computer. Try again in 15 minutes.');
}
export function recordIpFailure(ip: string) {
  const f = ipFailures.get(ip);
  if (!f || Date.now() - f.since >= 15 * 60_000) ipFailures.set(ip, { n: 1, since: Date.now() }); else f.n++;
  if (ipFailures.size > 50_000) ipFailures.clear();
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
  return totpStep(secret, code) != null;
}
/** 2.20 The time step the code belongs to (to refuse a code used before), or null. Constant-time comparison. */
export function totpStep(secret: string, code: string, step = 30): number | null {
  const c = Buffer.from(code.trim());
  for (const w of [-1, 0, 1]) {
    const t = Date.now() + w * step * 1000;
    const want = Buffer.from(totp(secret, t, step));
    if (want.length === c.length && timingSafeEqual(want, c)) return Math.floor(t / 1000 / step);
  }
  return null;
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
  | { typ: 'op'; sub: string; mfa: boolean; ver?: number }
  | { typ: 'staff'; sub: string; hid: string }
  /** 2.13 Proof that the operator re-entered the password a few minutes ago (sensitive actions). */
  | { typ: 'reauth'; sub: string };

/** 2.20 An operator session carrying the account's current session version. */
export async function operatorToken(operatorId: string, mfa: boolean) {
  const r = await one(pool, 'SELECT token_version FROM operators WHERE id=$1', [operatorId]);
  return signToken({ typ: 'op', sub: operatorId, mfa, ver: r?.token_version ?? 0 });
}
export async function signToken(claims: TokenClaims, ttl = '8h') {
  return new SignJWT({ ...claims }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(ttl).setIssuer('smk').sign(key);
}
async function readToken(req: FastifyRequest): Promise<TokenClaims> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in required.');
  try {
    const { payload } = await jwtVerify(h.slice(7), key, { issuer: 'smk', algorithms: ['HS256'] });
    return payload as unknown as TokenClaims;
  } catch {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Session expired. Sign in again.');
  }
}

// ---- Operator context ------------------------------------------------------------------------------
export interface OperatorCtx {
  id: string; email: string; displayName: string; isPlatformAdmin: boolean;
  roles: Map<string, Role[]>; // hotelId -> roles
  /** hotelId -> portal modules hidden from this person (2.8). */
  hidden?: Map<string, string[]>;
  /** 2.13 Two-step sign-in switched on for this account; hotels that require it for administrators. */
  mfa?: boolean;
  mfaRequiredIn?: Set<string>;
}

export async function requireOperator(req: FastifyRequest): Promise<OperatorCtx> {
  if ((req as any).operator) return (req as any).operator;
  const t = await readToken(req);
  if (t.typ !== 'op') throw new ApiError(401, 'UNAUTHENTICATED', 'Operator sign-in required.');
  const op = await one(pool, 'SELECT id, email, display_name, is_platform_admin, status, mfa_enabled, token_version FROM operators WHERE id=$1', [t.sub]);
  if (!op || op.status !== 'ACTIVE') throw new ApiError(401, 'UNAUTHENTICATED', 'Account is disabled.');
  // 2.20 A session from before the last password change / password link / two-step reset is no longer valid.
  if ((t.ver ?? 0) !== (op.token_version ?? 0)) throw new ApiError(401, 'UNAUTHENTICATED', 'Session ended (password or two-step sign-in changed). Sign in again.');
  const roles = new Map<string, Role[]>();
  for (const m of await many(pool, 'SELECT hotel_id, role FROM memberships WHERE operator_id=$1', [op.id])) {
    roles.set(m.hotel_id, [...(roles.get(m.hotel_id) ?? []), m.role]);
  }
  // Modules hidden from this person (Operators page) and mobile keys limited to administrators (Settings -> Modules).
  const hidden = new Map<string, string[]>();
  for (const h of await many(pool, `SELECT hotel_id, hidden_modules FROM operator_module_access WHERE operator_id=$1`, [op.id])) hidden.set(h.hotel_id, h.hidden_modules ?? []);
  if (!op.is_platform_admin && roles.size) {
    for (const f of await many(pool, `SELECT DISTINCT ON (hotel_id) hotel_id, data FROM hotel_config_versions WHERE kind='features' AND hotel_id = ANY($1) ORDER BY hotel_id, version DESC`, [[...roles.keys()]])) {
      // 2.17 Mobile keys switched off (the default): hidden from everyone; switch on in Settings -> Modules.
      const off = f.data?.staffMobileKeys !== true;
      const adminsOnly = f.data?.mobileKeysVisibleTo === 'administrators';
      if (off || (adminsOnly && !(roles.get(f.hotel_id) ?? []).includes('HOTEL_ADMIN'))) hidden.set(f.hotel_id, [...new Set([...(hidden.get(f.hotel_id) ?? []), 'mobileKeys'])]);
      // 2.13 Visionline focus: the portal shows only the Visionline side to everyone but hotel administrators.
      if (f.data?.portalFocus === 'visionline' && !(roles.get(f.hotel_id) ?? []).includes('HOTEL_ADMIN'))
        hidden.set(f.hotel_id, [...new Set([...(hidden.get(f.hotel_id) ?? []), 'mobileKeys', 'attendance', 'breakfast', 'battery', 'maintenance'])]);
    }
  }
  // 2.13 Hotels that require two-step sign-in for administrators (Settings -> Policy -> Administrator protection).
  const mfaRequiredIn = new Set<string>();
  if (!op.mfa_enabled && roles.size)
    for (const p of await many(pool, `SELECT DISTINCT ON (hotel_id) hotel_id, data->'adminSecurity'->>'requireAdminMfa' AS req FROM hotel_config_versions WHERE kind='policy' AND hotel_id = ANY($1) ORDER BY hotel_id, version DESC`, [[...roles.keys()]]))
      if (p.req === 'true') mfaRequiredIn.add(p.hotel_id);
  const ctx: OperatorCtx = { id: op.id, email: op.email, displayName: op.display_name, isPlatformAdmin: op.is_platform_admin, roles, hidden, mfa: op.mfa_enabled, mfaRequiredIn };
  (req as any).operator = ctx;
  return ctx;
}

export function permsIn(op: OperatorCtx, hotelId: string): Set<Permission> {
  if (op.isPlatformAdmin) return withoutModules(permissionsFor(['PLATFORM_ADMIN']), op.hidden?.get(hotelId) ?? []);
  return withoutModules(permissionsFor(op.roles.get(hotelId) ?? []), op.hidden?.get(hotelId) ?? []);
}

/** Enforces hotel membership (tenant isolation) and a permission. Returns the operator. */
export async function requirePerm(req: FastifyRequest, hotelId: string, perm: Permission): Promise<OperatorCtx> {
  const op = await requireOperator(req);
  if (!op.isPlatformAdmin && !op.roles.has(hotelId)) throw forbidden('You are not a member of this site.');
  if (!permsIn(op, hotelId).has(perm)) throw forbidden(`Missing permission: ${perm}`);
  if (ADMIN_AREAS.has(perm) && !op.mfa && op.mfaRequiredIn?.has(hotelId) && (op.isPlatformAdmin || (op.roles.get(hotelId) ?? []).includes('HOTEL_ADMIN')))
    throw new ApiError(403, 'MFA_REQUIRED', 'Two-step sign-in is required for administrators here. Turn it on in Your account -> Two-step sign-in, then sign in again.');
  return op;
}
const ADMIN_AREAS = new Set<Permission>(['settings.manage', 'operators.manage', 'connector.manage', 'branding.manage']);

/** 2.13 A short-lived proof that the person re-entered the password (sent as the X-SMK-Reauth header). */
export async function requireReauth(req: FastifyRequest, op: OperatorCtx) {
  const t = String(req.headers['x-smk-reauth'] ?? '');
  try {
    const { payload } = await jwtVerify(t, key, { issuer: 'smk', algorithms: ['HS256'] });
    if (payload.typ === 'reauth' && payload.sub === op.id) return;
  } catch { /* fall through */ }
  throw new ApiError(401, 'REAUTH_REQUIRED', 'Confirm your password to continue.');
}

export async function requireStaff(req: FastifyRequest): Promise<{ staffId: string; hotelId: string }> {
  const t = await readToken(req);
  if (t.typ !== 'staff') throw new ApiError(401, 'UNAUTHENTICATED', 'Staff sign-in required.');
  const s = await one(pool, 'SELECT status FROM staff WHERE id=$1 AND hotel_id=$2', [t.sub, t.hid]);
  if (!s || s.status !== 'ACTIVE') throw new ApiError(401, 'UNAUTHENTICATED', 'Your access has been suspended. Contact your supervisor.');
  return { staffId: t.sub, hotelId: t.hid };
}
