import { createHash, createPublicKey, verify } from 'node:crypto';
import { one, pool, type Db } from './db.ts';
import { getConfig } from './hotel-config.ts';
import { ApiError, badRequest } from './lib/errors.ts';

/**
 * Licences (2.12). A licence is "SMK1.<payload>.<signature>" (base64url), the payload signed with the vendor's Ed25519
 * key in the License Manager on the vendor's own PC. The platform only holds the public key: it can check a licence,
 * never make one. Licences are checked offline; nothing is sent anywhere.
 *
 * Enforced only where the installer switches it on (SMK_LICENSING=on, on-premises). Without a licence a hotel runs as
 * a trial for TRIAL_DAYS. When a licence or trial ends, there are GRACE_DAYS of warnings, then the portal becomes
 * read-only for changes - except what keeps the hotel safe: signing in, revoking keys, the licence page itself.
 */
export const TRIAL_DAYS = 60;
export const GRACE_DAYS = 14;
/** Optional modules a licence can include. Everything else (Visionline data, Insights, Event log, Monitoring, Audit) is in every licence. */
export const LICENSED_MODULES = {
  staffMobileKeys: 'Staff mobile keys',
  batteryMonitoring: 'Battery status',
  maintenance: 'Maintenance',
  timeAttendance: 'Time & attendance',
  breakfast: 'Breakfast',
} as const;
export type LicensedModule = keyof typeof LICENSED_MODULES;

/** The vendor's public key (raw Ed25519, base64url). Its private half never leaves the vendor's PC. */
const VENDOR_KEYS = ['1tY44EOwtvCT_gsbkZHsrDzMsBRoO-8g6Y_FsvP6sV8'];

declare const __SMK_PACKAGED__: boolean | undefined;
function trustedKeys(): string[] {
  const packaged = typeof __SMK_PACKAGED__ !== 'undefined' && __SMK_PACKAGED__;
  // Test keys are accepted only in the development build (never in the installed package).
  const test = !packaged && process.env.SMK_LICENCE_TEST_KEY ? [process.env.SMK_LICENCE_TEST_KEY] : [];
  return [...VENDOR_KEYS, ...test];
}
export const licensingEnforced = () => process.env.SMK_LICENSING === 'on';

export interface LicencePayload {
  v: 1; id: string; customer: string; hotel: string; systemId?: number | null;
  modules: string[]; maxDoors?: number | null; issued: string; expires?: string | null; support?: string | null; note?: string | null;
}

const b64u = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** Checks the signature and the shape. Throws a readable error; returns the payload. */
export function parseLicence(raw: string): LicencePayload {
  const key = raw.replace(/\s+/g, '').replace(/^-+BEGIN[^-]+-+|-+END[^-]+-+$/g, '');
  const parts = key.split('.');
  if (parts.length !== 3 || parts[0] !== 'SMK1') throw badRequest('LICENCE_INVALID', 'This is not a Staff Mobile Key licence. Paste the whole key, starting with SMK1.');
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = b64u(parts[2]!);
  const ok = sig.length === 64 && trustedKeys().some((k) => {
    try { return verify(null, data, createPublicKey({ key: Buffer.concat([SPKI_ED25519, b64u(k)]), format: 'der', type: 'spki' }), sig); } catch { return false; }
  });
  if (!ok) throw badRequest('LICENCE_INVALID', 'The licence signature is not valid. It was changed, or it was not issued for this product.');
  let p: LicencePayload;
  try { p = JSON.parse(b64u(parts[1]!).toString('utf8')); } catch { throw badRequest('LICENCE_INVALID', 'The licence cannot be read.'); }
  if (p.v !== 1 || !p.id || !p.hotel || !Array.isArray(p.modules) || !/^\d{4}-\d{2}-\d{2}$/.test(p.issued)) throw badRequest('LICENCE_INVALID', 'The licence is incomplete.');
  return p;
}

const day = 86_400_000;
const endOfDay = (d: string) => Date.parse(`${d}T23:59:59Z`);

export async function licenceStatus(db: Db, hotelId: string) {
  const [h, lic, cs] = await Promise.all([
    one(db, `SELECT name, licence_trial_from FROM hotels WHERE id=$1`, [hotelId]),
    one(db, `SELECT payload, installed_at FROM hotel_licences WHERE hotel_id=$1`, [hotelId]),
    getConfig(db, hotelId, 'credential_services'),
  ]);
  const now = Date.now();
  const installationId = createHash('sha256').update(`smk-installation:${hotelId}`).digest('hex').slice(0, 16).toUpperCase().replace(/(.{4})(?!$)/g, '$1-');
  const enforced = licensingEnforced();
  const base = { enforced, installationId, hotel: h?.name ?? null, systemId: cs?.systemId ?? null };
  if (lic) {
    const p = lic.payload as LicencePayload;
    const ends = p.expires ? endOfDay(p.expires) : null;
    const systemMismatch = Boolean(p.systemId && cs?.systemId && Number(p.systemId) !== Number(cs.systemId));
    const state = systemMismatch ? 'mismatch' : ends === null || now <= ends ? 'licensed' : now <= ends + GRACE_DAYS * day ? 'grace' : 'expired';
    return { ...base, state, licence: { id: p.id, customer: p.customer, hotel: p.hotel, systemId: p.systemId ?? null, modules: p.modules, maxDoors: p.maxDoors ?? null,
      issued: p.issued, expires: p.expires ?? null, support: p.support ?? null, installedAt: lic.installed_at },
      daysLeft: ends === null ? null : Math.ceil((ends - now) / day), modules: moduleList(p.modules) };
  }
  const from = new Date(h?.licence_trial_from ?? now).getTime();
  const ends = from + TRIAL_DAYS * day;
  const state = now <= ends ? 'trial' : now <= ends + GRACE_DAYS * day ? 'grace' : 'expired';
  return { ...base, state, licence: null, trialEnds: new Date(ends).toISOString(), daysLeft: Math.ceil((ends - now) / day), modules: Object.keys(LICENSED_MODULES) };
}
const moduleList = (m: string[]) => (m.includes('*') ? Object.keys(LICENSED_MODULES) : m.filter((x) => x in LICENSED_MODULES));

/** May this hotel switch the module on? (only checked when licensing is enforced) */
export async function assertModuleLicensed(db: Db, hotelId: string, feature: string) {
  if (!licensingEnforced() || !(feature in LICENSED_MODULES)) return;
  const s = await licenceStatus(db, hotelId);
  if (s.state === 'expired' || s.state === 'mismatch') throw new ApiError(402, 'LICENCE_REQUIRED', 'The licence has ended. Enter a new licence key in Settings → Licence.');
  if (!s.modules.includes(feature)) throw new ApiError(402, 'LICENCE_REQUIRED', `${LICENSED_MODULES[feature as LicensedModule]} is not in this hotel's licence. Ask your supplier to add it.`);
}

/** Changes are refused once the licence (or trial) and its grace period are over. Reads, sign-in, revocation and the licence page stay open. */
const ALWAYS_ALLOWED = [/^\/api\/v1\/hotels\/[^/]+\/(emergency|emergency\/[^/]+\/(confirm|end|roll|keys)|usage\/ping)$/, /^\/api\/v1\/hotels\/[^/]+\/licence$/, /^\/api\/v1\/hotels\/[^/]+\/keys\/[^/]+\/revoke$/, /^\/api\/v1\/hotels\/[^/]+\/me\//];
export async function licenceGate(method: string, url: string, hotelId: string) {
  if (!licensingEnforced() || method === 'GET' || method === 'HEAD' || ALWAYS_ALLOWED.some((r) => r.test(url.split('?')[0]!))) return;
  const s = await licenceStatus(pool, hotelId);
  if (s.state === 'expired' || s.state === 'mismatch')
    throw new ApiError(402, 'LICENCE_REQUIRED', s.state === 'mismatch' ? 'This licence was issued for another ASSA ABLOY System ID. Enter the licence for this hotel in Settings → Licence.'
      : 'The licence has ended, so changes are paused (keys can still be revoked). Enter a new licence key in Settings → Licence.');
}
