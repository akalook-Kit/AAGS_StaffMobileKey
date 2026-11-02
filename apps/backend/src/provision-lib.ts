/**
 * Production provisioning (Render, on-premises, any hosted deployment). Safe to run on every start:
 *  - applies database migrations;
 *  - creates the hotel, if missing: from HOTEL_NAME / HOTEL_TIMEZONE / HOTEL_COUNTRY ... (tenants/generic.ts, any hotel),
 *    or the K Hotel Bana reference profile when PROVISION_HOTEL=k-hotel-bana and no HOTEL_NAME is given;
 *  - on-premises 2.9 (SMK_SETUP_MODE=1): without HOTEL_NAME nothing is created here; the hotel and the first
 *    administrator come from the first-run setup page in the portal (routes/setup.ts);
 *  - creates the FIRST platform administrator from BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD, only
 *    while the database has no operator at all. Remove both variables after the first sign-in;
 *  - registers the connector installed on the same server (SMK_LOCAL_CONNECTOR_TOKEN, made by the installer).
 *
 * Unlike seed.ts it creates no test accounts, no staff, no doors, and it never prints a password.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { pool, one } from './db.ts';
import { migrate } from './migrate.ts';
import { hashPassword } from './auth.ts';
import { saveConfig, validateConfig, type ConfigKind } from './hotel-config.ts';
import { audit } from './audit.ts';
import { KHB } from './tenants/k-hotel-bana.ts';
import { genericProfile, CS_PRODUCTION_URL, type HotelProfile } from './tenants/generic.ts';

export const setupMode = (env: NodeJS.ProcessEnv = process.env) => env.SMK_SETUP_MODE === '1' && !env.HOTEL_NAME?.trim();

/** Which hotel this installation provisions. */
export function hotelProfile(env: NodeJS.ProcessEnv = process.env): HotelProfile {
  if (!env.HOTEL_NAME && (env.PROVISION_HOTEL ?? KHB.slug) === KHB.slug)
    return { slug: KHB.slug, name: KHB.name, timezone: KHB.timezone, config: KHB.config(env.CS_BASE_URL ?? KHB.csBaseUrl ?? CS_PRODUCTION_URL) };
  return genericProfile(env);
}

/** Creates the hotel of a profile if missing and adds any of its settings that are not there yet. */
export async function createHotel(db: pg.Pool | pg.PoolClient, profile: HotelProfile) {
  let h = await one(db, 'SELECT id FROM hotels WHERE slug=$1', [profile.slug]);
  const created = !h;
  if (!h) h = await one(db, 'INSERT INTO hotels (slug, name, timezone) VALUES ($1,$2,$3) RETURNING id', [profile.slug, profile.name, profile.timezone]);
  const hotelId = h!.id as string;
  const added: string[] = [];
  for (const [kind, data] of Object.entries(profile.config) as [ConfigKind, unknown][]) {
    if (await one(db, 'SELECT 1 FROM hotel_config_versions WHERE hotel_id=$1 AND kind=$2', [hotelId, kind])) continue;
    await saveConfig(db, hotelId, kind, await validateConfig(db, hotelId, kind, data), null);
    added.push(kind);
  }
  if (created || added.length) await audit(db === pool ? null : (db as pg.PoolClient), { hotelId, actorType: 'system', action: 'hotel.provisioned', details: { slug: profile.slug, configs: added } });
  return { hotelId, slug: profile.slug, created, added };
}

/** The connector installed on this same server by the on-premises installer, registered without a typed token. */
export async function ensureLocalConnector(db: pg.Pool | pg.PoolClient, hotelId: string, log: (m: string) => void = console.log) {
  const token = process.env.SMK_LOCAL_CONNECTOR_TOKEN?.trim();
  if (!token) return false;
  const hash = createHash('sha256').update(token).digest('hex');
  if (await one(db, 'SELECT 1 FROM connectors WHERE token_hash=$1', [hash])) return false;
  const c = await one(db, `INSERT INTO connectors (hotel_id, name, token_hash) VALUES ($1,$2,$3) RETURNING id`, [hotelId, 'Visionline server (this server)', hash]);
  await audit(db === pool ? null : (db as pg.PoolClient), { hotelId, actorType: 'system', action: 'connector.registered', targetType: 'connector', targetId: c!.id, details: { name: 'Visionline server (this server)', via: 'on-premises installer' } });
  log('[provision] Registered the connector installed on this server.');
  return true;
}

export async function provision(log: (m: string) => void = console.log): Promise<{ hotelId: string; slug: string } | null> {
  await migrate();
  if (setupMode()) {
    const h = await one(pool, 'SELECT id, slug FROM hotels ORDER BY created_at LIMIT 1');
    if (!h) { log('[provision] New installation: open the portal on this server to enter the hotel details (first-run setup).'); return null; }
    await ensureLocalConnector(pool, h.id, log);
    return { hotelId: h.id, slug: h.slug };
  }

  const profile = hotelProfile();
  const { hotelId, slug, created, added } = await createHotel(pool, profile);

  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const anyOperator = await one(pool, 'SELECT 1 FROM operators LIMIT 1');
  if (!anyOperator) {
    if (!email || !password) {
      log('[provision] No operator exists yet. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (12+ characters) and restart.');
    } else if (password.length < 12) {
      log('[provision] BOOTSTRAP_ADMIN_PASSWORD must have at least 12 characters. No administrator was created.');
    } else {
      const op = await one(pool, `INSERT INTO operators (email, display_name, password_hash, is_platform_admin) VALUES ($1,$2,$3,true) RETURNING id`,
        [email, 'Platform Administrator', hashPassword(password)]);
      await pool.query('INSERT INTO memberships VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [op!.id, hotelId, 'HOTEL_ADMIN']);
      await audit(null, { hotelId: null, actorType: 'system', action: 'operator.bootstrapped', targetType: 'operator', targetId: op!.id, details: { email } });
      log(`[provision] Created the first platform administrator ${email}. Sign in, turn on two-step sign-in, then remove BOOTSTRAP_ADMIN_PASSWORD.`);
    }
  } else if (password) {
    log('[provision] Operators already exist; BOOTSTRAP_ADMIN_PASSWORD is ignored. Remove it from the environment.');
  }
  await ensureLocalConnector(pool, hotelId, log);
  log(`[provision] ${profile.name} (${slug}): ${created ? 'created' : 'present'}${added.length ? `; settings added: ${added.join(', ')}` : ''}.`);
  return { hotelId, slug };
}
