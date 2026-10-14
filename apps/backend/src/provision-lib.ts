/**
 * Production provisioning (Render, or any hosted deployment). Safe to run on every start:
 *  - applies database migrations;
 *  - creates the hotel, if missing: from HOTEL_NAME / HOTEL_TIMEZONE / HOTEL_COUNTRY ... (tenants/generic.ts, any hotel),
 *    or the K Hotel Bana reference profile when PROVISION_HOTEL=k-hotel-bana and no HOTEL_NAME is given;
 *  - creates the FIRST platform administrator from BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD, only
 *    while the database has no operator at all. Remove both variables after the first sign-in.
 *
 * Unlike seed.ts it creates no test accounts, no staff, no doors and no connector token, and it never prints
 * a password.
 */
import { pool, one } from './db.ts';
import { migrate } from './migrate.ts';
import { hashPassword } from './auth.ts';
import { saveConfig, validateConfig, type ConfigKind } from './hotel-config.ts';
import { audit } from './audit.ts';
import { KHB } from './tenants/k-hotel-bana.ts';
import { genericProfile, CS_PRODUCTION_URL, type HotelProfile } from './tenants/generic.ts';

/** Which hotel this installation provisions. */
export function hotelProfile(env: NodeJS.ProcessEnv = process.env): HotelProfile {
  if (!env.HOTEL_NAME && (env.PROVISION_HOTEL ?? KHB.slug) === KHB.slug)
    return { slug: KHB.slug, name: KHB.name, timezone: KHB.timezone, config: KHB.config(env.CS_BASE_URL ?? KHB.csBaseUrl ?? CS_PRODUCTION_URL) };
  return genericProfile(env);
}

export async function provision(log: (m: string) => void = console.log): Promise<{ hotelId: string; slug: string }> {
  await migrate();
  async function cfg(hotelId: string, kind: ConfigKind, data: unknown) {
    const exists = await one(pool, 'SELECT 1 FROM hotel_config_versions WHERE hotel_id=$1 AND kind=$2', [hotelId, kind]);
    if (exists) return false;
    await saveConfig(pool, hotelId, kind, await validateConfig(pool, hotelId, kind, data), null);
    return true;
  }

  const profile = hotelProfile();
  const slug = profile.slug;

  let h = await one(pool, 'SELECT id FROM hotels WHERE slug=$1', [slug]);
  const created = !h;
  if (!h) h = await one(pool, 'INSERT INTO hotels (slug, name, timezone) VALUES ($1,$2,$3) RETURNING id', [slug, profile.name, profile.timezone]);
  const hotelId = h!.id as string;
  const added: string[] = [];
  for (const [kind, data] of Object.entries(profile.config) as [ConfigKind, unknown][]) {
    if (await cfg(hotelId, kind, data)) added.push(kind);
  }
  if (created || added.length) await audit(null, { hotelId, actorType: 'system', action: 'hotel.provisioned', details: { slug, configs: added } });

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
  log(`[provision] ${profile.name} (${slug}): ${created ? 'created' : 'present'}${added.length ? `; settings added: ${added.join(', ')}` : ''}.`);
  return { hotelId, slug };
}
