/**
 * First-run setup (2.9, on-premises): instead of typing the hotel's details into PowerShell, the installer
 * starts the platform in setup mode and opens the portal, where the hotel, the first administrator and
 * (optionally) the Credential Services account are entered once.
 *
 * Who may do it: whoever has the setup code. The installer makes a random code, shows it at the end of the
 * installation and opens the setup page with it filled in; only its SHA-256 is given to the platform
 * (SMK_SETUP_CODE_SHA256). Wrong codes are throttled. Once a hotel and an administrator exist the setup
 * page is closed for good: every later change is made in the portal by an administrator who signs in.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, one } from '../db.ts';
import { audit } from '../audit.ts';
import { hashPassword } from '../auth.ts';
import { createHotel, ensureLocalConnector, setupMode } from '../provision-lib.ts';
import { genericProfile, slugify } from '../tenants/generic.ts';
import { setStoredSecret, secretStoreEnabled } from '../secret-store.ts';
import { PLATFORM_VERSION } from '../version.ts';
import { tenantPreset } from '../tenants/la-falaise.ts';
import { edition } from '../edition.ts';
import { ApiError } from '../lib/errors.ts';
import { randomBytes } from 'node:crypto';

/** 2.34 Country of a time zone (light edition setup asks nothing but the Visionline account). */
const TZ_COUNTRY: Record<string, string> = { 'Africa/Douala': 'CM', 'Africa/Luanda': 'AO', 'Africa/Nairobi': 'KE', 'Africa/Kigali': 'RW', 'Africa/Lagos': 'NG', 'Africa/Kinshasa': 'CD',
  'Africa/Lubumbashi': 'CD', 'Africa/Libreville': 'GA', 'Africa/Brazzaville': 'CG', 'Africa/Malabo': 'GQ', 'Africa/Abidjan': 'CI', 'Africa/Dakar': 'SN', 'Africa/Accra': 'GH',
  'Africa/Kampala': 'UG', 'Africa/Dar_es_Salaam': 'TZ', 'Africa/Addis_Ababa': 'ET', 'Africa/Johannesburg': 'ZA', 'Africa/Casablanca': 'MA', 'Africa/Cairo': 'EG', 'Africa/Bangui': 'CF',
  'Africa/Ndjamena': 'TD', 'Africa/Bujumbura': 'BI', 'Africa/Lusaka': 'ZM', 'Africa/Harare': 'ZW', 'Africa/Maputo': 'MZ', 'Europe/Paris': 'FR', 'Europe/London': 'GB' };
/** 2.34 The account the light edition makes for itself at setup (nobody signs in with it: the team uses open access). */
export const LIGHT_SUPPORT_EMAIL = 'support@light.local';

const P = '/api/v1/setup';
const tries: number[] = [];
const MAX_TRIES = 10; const WINDOW_MS = 15 * 60_000;

export const normaliseCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
function codeMatches(given: string) {
  const want = process.env.SMK_SETUP_CODE_SHA256?.trim().toLowerCase();
  if (!want || !/^[0-9a-f]{64}$/.test(want)) return false;
  const got = createHash('sha256').update(normaliseCode(given)).digest();
  return timingSafeEqual(got, Buffer.from(want, 'hex'));
}

export async function setupNeeded() {
  if (!setupMode()) return false;
  const h = await one(pool, 'SELECT 1 FROM hotels LIMIT 1');
  // 2.33 The built-in open-access account (light edition) is not an administrator: it does not end the setup.
  const o = await one(pool, `SELECT 1 FROM operators WHERE lower(email)<>'open-access@reports.local' LIMIT 1`);
  return !h || !o;
}

const tz = z.string().trim().min(3).max(64).refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, 'Not a known time zone');
const Body = z.object({
  code: z.string().trim().min(6).max(40),
  hotel: z.object({
    /** 2.16 A hotel or an institution. */
    kind: z.enum(['hotel', 'institution']).default('hotel'),
    name: z.string().trim().min(2).max(80),
    code: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'Lower-case letters, digits and dashes (2-40)').optional().or(z.literal('').transform(() => undefined)),
    timeZone: tz,
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Two letters, e.g. KE'),
    systemId: z.coerce.number().int().min(0).max(2_147_483_647).default(0),
    systemNumber: z.string().trim().max(40).optional(),
    supportEmail: z.string().trim().email().max(120).optional().or(z.literal('').transform(() => undefined)),
    supportPhone: z.string().trim().max(40).optional(),
  }).optional(),
  admin: z.object({
    name: z.string().trim().min(2).max(80),
    email: z.string().trim().email().max(160),
    password: z.string().min(12, 'At least 12 characters').max(200),
  }).optional(),
  /** 2.34 Light edition: only the hotel's name (optional); the Visionline account is entered right after. */
  light: z.object({ hotelName: z.string().trim().max(80).optional() }).optional(),
  credentialServices: z.object({ user: z.string().trim().max(200), password: z.string().max(400) }).partial().optional(),
});

export function setupRoutes(app: FastifyInstance) {
  app.get(P, async () => {
    const needed = await setupNeeded();
    const hotel = needed ? await one(pool, 'SELECT name FROM hotels ORDER BY created_at LIMIT 1') : null;
    return {
      needed,
      version: PLATFORM_VERSION,
      // Suggestions for the form: the server's own time zone. A hotel that already exists is not asked again.
      // 2.33 An edition made for one hotel fills in its name, time zone and country.
      ...(needed && tenantPreset() ? { suggest: { name: tenantPreset()!.name, timeZone: tenantPreset()!.timezone, country: tenantPreset()!.country } } : {}),
      edition: edition(),
      ...(needed ? { serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, codeRequired: true, secretStore: secretStoreEnabled(), hotel: hotel ? { name: hotel.name } : null } : {}),
    };
  });

  app.post(P, async (req, reply) => {
    if (!(await setupNeeded())) throw new ApiError(409, 'SETUP_DONE', 'This installation is already set up. Sign in instead.');
    const now = Date.now();
    while (tries.length && tries[0]! < now - WINDOW_MS) tries.shift();
    if (tries.length >= MAX_TRIES) throw new ApiError(429, 'TOO_MANY_TRIES', 'Too many wrong setup codes. Wait 15 minutes, then try again.');
    const b = Body.parse(req.body);
    if (!codeMatches(b.code)) {
      tries.push(now);
      throw new ApiError(403, 'BAD_SETUP_CODE', 'The setup code is not right. It was shown at the end of the installation. To see it again on the server: Start menu → "Access Monitoring Tool - setup code" (Windows asks for administrator permission).');
    }
    const cs = b.credentialServices;
    if ((cs?.user && !cs.password) || (!cs?.user && cs?.password)) throw new ApiError(400, 'CS_INCOMPLETE', 'Give both the Credential Services user and password, or neither (you can add them later).');
    if (cs?.user && !secretStoreEnabled()) throw new ApiError(409, 'SECRET_STORE_OFF', 'This server cannot store passwords from the portal. Leave the Credential Services account empty.');

    // 2.34 Light edition: the hotel and the administrator account are made from what the server knows; nobody types
    // anything but (optionally) the hotel's name. The administrator gets a random password that is not shown: the
    // team uses the portal without signing in, on the hotel network.
    if (edition() === 'light' && !b.admin) {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const preset = tenantPreset();
      const timeZone = zone && zone !== 'UTC' && zone !== 'Etc/UTC' ? zone : preset?.timezone ?? 'Africa/Douala';
      const name = b.light?.hotelName && b.light.hotelName.length >= 2 ? b.light.hotelName : preset?.name ?? 'Hotel';
      b.hotel ??= { kind: 'hotel', name, timeZone, country: TZ_COUNTRY[timeZone] ?? preset?.country ?? 'CM', systemId: 0 };
      b.admin = { name: 'Support', email: LIGHT_SUPPORT_EMAIL, password: randomBytes(24).toString('base64url') };
    }
    if (!b.admin) throw new ApiError(400, 'VALIDATION', 'admin: Enter the first administrator.');
    const admin = b.admin;
    const existingHotel = await one(pool, 'SELECT id FROM hotels LIMIT 1');
    if (!existingHotel && !b.hotel) throw new ApiError(400, 'VALIDATION', 'hotel: Enter the name and details.');
    const profile = b.hotel && genericProfile({
      HOTEL_KIND: b.hotel.kind, HOTEL_NAME: b.hotel.name, PROVISION_HOTEL: b.hotel.code || slugify(b.hotel.name) || 'hotel', HOTEL_TIMEZONE: b.hotel.timeZone, HOTEL_COUNTRY: b.hotel.country,
      HOTEL_SYSTEM_ID: String(b.hotel.systemId), HOTEL_SYSTEM_NUMBER: b.hotel.systemNumber || undefined,
      HOTEL_SUPPORT_EMAIL: b.hotel.supportEmail, HOTEL_SUPPORT_PHONE: b.hotel.supportPhone || undefined, SMK_TENANT: process.env.SMK_TENANT, SMK_BRAND_DIR: process.env.SMK_BRAND_DIR,
    });
    const result = await tx(async (c) => {
      // Two people submitting at once: only the first one wins.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['smk:first-run-setup']);
      if (await one(c, 'SELECT 1 FROM operators LIMIT 1')) throw new ApiError(409, 'SETUP_DONE', 'This installation is already set up. Sign in instead.');
      if (await one(c, 'SELECT 1 FROM operators WHERE lower(email)=lower($1)', [admin.email])) throw new ApiError(409, 'EMAIL_TAKEN', 'This e-mail is already used.');
      const existing = await one(c, 'SELECT id, slug FROM hotels ORDER BY created_at LIMIT 1');
      const h = existing ? { hotelId: existing.id as string, slug: existing.slug as string } : await createHotel(c, profile!);
      const op = await one(c, `INSERT INTO operators (email, display_name, password_hash, is_platform_admin) VALUES ($1,$2,$3,true) RETURNING id`,
        [admin.email, admin.name, hashPassword(admin.password)]);
      await c.query('INSERT INTO memberships VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [op!.id, h.hotelId, 'HOTEL_ADMIN']);
      await audit(c, { hotelId: null, actorType: 'system', action: 'operator.bootstrapped', targetType: 'operator', targetId: op!.id, details: { email: admin.email, via: 'first-run setup' } });
      await audit(c, { hotelId: h.hotelId, actorType: 'operator', actorId: op!.id, action: 'hotel.setup_completed', details: { slug: h.slug, ...(b.hotel && !existing ? { name: b.hotel.name, timeZone: b.hotel.timeZone, country: b.hotel.country, systemId: b.hotel.systemId } : {}), credentialServices: Boolean(cs?.user) } });
      await ensureLocalConnector(c, h.hotelId, (m) => req.log.info(m));
      const name = (await one(c, 'SELECT name FROM hotels WHERE id=$1', [h.hotelId]))!.name as string;
      return { hotelId: h.hotelId, slug: h.slug, name, operatorId: op!.id as string };
    });
    if (cs?.user && cs.password) {
      await setStoredSecret(result.hotelId, 'CS_TENANT_USER', cs.user, result.operatorId);
      await setStoredSecret(result.hotelId, 'CS_TENANT_PASSWORD', cs.password, result.operatorId);
    }
    tries.length = 0;
    req.log.info({ hotel: result.slug }, 'first-run setup completed');
    return reply.code(201).send({ ok: true, hotel: { id: result.hotelId, slug: result.slug, name: result.name }, admin: { email: admin.email } });
  });
}
