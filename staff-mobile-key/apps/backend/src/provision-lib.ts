/**
 * Production provisioning (Render, or any hosted deployment). Safe to run on every start:
 *  - applies database migrations;
 *  - creates the hotel named by PROVISION_HOTEL (default k-hotel-bana) with its real settings, if missing;
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

export async function provision(log: (m: string) => void = console.log) {
  await migrate();
  async function cfg(hotelId: string, kind: ConfigKind, data: unknown) {
    const exists = await one(pool, 'SELECT 1 FROM hotel_config_versions WHERE hotel_id=$1 AND kind=$2', [hotelId, kind]);
    if (exists) return false;
    await saveConfig(pool, hotelId, kind, await validateConfig(pool, hotelId, kind, data), null);
    return true;
  }

  const slug = process.env.PROVISION_HOTEL ?? KHB.slug;
  if (slug !== KHB.slug) throw new Error(`No provisioning profile for hotel "${slug}". Create other hotels from the portal.`);

  let h = await one(pool, 'SELECT id FROM hotels WHERE slug=$1', [slug]);
  const created = !h;
  if (!h) h = await one(pool, 'INSERT INTO hotels (slug, name, timezone) VALUES ($1,$2,$3) RETURNING id', [slug, KHB.name, KHB.timezone]);
  const hotelId = h!.id as string;
  const added: string[] = [];
  for (const [kind, data] of Object.entries(KHB.config(process.env.CS_BASE_URL ?? KHB.csBaseUrl)) as [ConfigKind, unknown][]) {
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
  log(`[provision] ${KHB.name}: ${created ? 'created' : 'present'}${added.length ? `; settings added: ${added.join(', ')}` : ''}.`);
}
