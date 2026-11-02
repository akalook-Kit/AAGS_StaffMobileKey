/**
 * Passwords and API keys a hotel administrator enters in the portal (2.9): Credential Services account,
 * SMTP password, SMS API key. Stored per hotel in platform_secrets, sealed with AES-256-GCM under
 * SMK_SECRET_KEY (32 random bytes, base64url). On-premises that key sits in the server's DPAPI-encrypted
 * settings file, never in the database, so a copy of the database alone does not reveal the passwords.
 *
 * Rules:
 *  - a server environment variable SECRET_<REF> always wins (hosted platforms, set-platform-secrets.ps1);
 *  - the portal can set or remove a value and see whether one is set, never read it;
 *  - values are never logged or written to the audit trail.
 * getSecret() stays synchronous: the sealed values are opened once into memory and refreshed after a change.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { pool, many } from './db.ts';
import { ApiError } from './lib/errors.ts';

const cache = new Map<string, string>();
const k = (hotelId: string, ref: string) => `${hotelId}|${ref}`;
export const normRef = (ref: string) => ref.toUpperCase().replace(/[^A-Z0-9]/g, '_');

function key(): Buffer | null {
  const raw = process.env.SMK_SECRET_KEY?.trim();
  if (!raw) return null;
  const b = Buffer.from(raw, 'base64url');
  if (b.length !== 32) throw new Error('SMK_SECRET_KEY must be 32 random bytes, base64url-encoded.');
  return b;
}
export const secretStoreEnabled = () => key() !== null;

export function seal(hotelId: string, ref: string, value: string, kk: Buffer = key()!): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kk, iv);
  c.setAAD(Buffer.from(k(hotelId, ref)));
  const body = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]);
}
export function open(hotelId: string, ref: string, sealed: Buffer, kk: Buffer = key()!): string {
  if (sealed[0] !== 1) throw new Error('Unknown sealed format');
  const d = createDecipheriv('aes-256-gcm', kk, sealed.subarray(1, 13));
  d.setAAD(Buffer.from(k(hotelId, ref)));
  d.setAuthTag(sealed.subarray(13, 29));
  return Buffer.concat([d.update(sealed.subarray(29)), d.final()]).toString('utf8');
}

/** Opens every stored value into memory (start-up, and every few minutes in case another process changed one). */
export async function loadStoredSecrets(log: (m: string) => void = console.error) {
  const kk = key();
  if (!kk) { cache.clear(); return; }
  const rows = await many(pool, 'SELECT hotel_id, ref, sealed FROM platform_secrets');
  const next = new Map<string, string>();
  for (const r of rows) {
    try { next.set(k(r.hotel_id, r.ref), open(r.hotel_id, r.ref, r.sealed, kk)); }
    catch { log(`[secrets] The stored value ${r.ref} cannot be opened with this server's key; enter it again in the portal.`); }
  }
  cache.clear();
  for (const [a, b] of next) cache.set(a, b);
}

export const storedSecret = (hotelId: string | undefined, ref: string) => (hotelId ? cache.get(k(hotelId, normRef(ref))) : undefined);
export const envSecret = (ref: string) => process.env[`SECRET_${normRef(ref)}`] || undefined;

export async function setStoredSecret(hotelId: string, ref: string, value: string, operatorId: string | null) {
  const kk = key();
  if (!kk) throw new ApiError(409, 'SECRET_STORE_OFF', 'This server keeps its passwords in its own settings (environment). Ask the server administrator.');
  const r = normRef(ref);
  await pool.query(`INSERT INTO platform_secrets (hotel_id, ref, sealed, updated_by) VALUES ($1,$2,$3,$4)
    ON CONFLICT (hotel_id, ref) DO UPDATE SET sealed=EXCLUDED.sealed, updated_at=now(), updated_by=EXCLUDED.updated_by`, [hotelId, r, seal(hotelId, r, value, kk), operatorId]);
  cache.set(k(hotelId, r), value);
}
export async function deleteStoredSecret(hotelId: string, ref: string) {
  const r = normRef(ref);
  await pool.query('DELETE FROM platform_secrets WHERE hotel_id=$1 AND ref=$2', [hotelId, r]);
  cache.delete(k(hotelId, r));
}

/** A secret by reference: the server's environment first, then the value entered in the portal for this hotel. */
export function getSecret(ref: string | undefined, hotelId?: string): string | undefined {
  if (!ref) return undefined;
  return envSecret(ref) ?? storedSecret(hotelId, ref);
}
