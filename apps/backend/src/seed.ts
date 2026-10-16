/**
 * Development seed: K Hotel Bana (reference tenant) plus a second hotel to prove isolation.
 * Idempotent: safe to run more than once. NEVER run against production.
 */
import { pool, tx, one } from './db.ts';
import { migrate } from './migrate.ts';
import { hashPassword } from './auth.ts';
import { saveConfig, validateConfig, type ConfigKind } from './hotel-config.ts';
import { hashToken } from './routes/connector.ts';
import { audit } from './audit.ts';
import { KHB } from './tenants/k-hotel-bana.ts';

const PW = process.env.SEED_PASSWORD ?? 'ChangeMe!2026';
const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? 'Staff!2026';
const KHB_CONNECTOR_TOKEN = process.env.KHB_CONNECTOR_TOKEN ?? 'smkc_dev_khb_connector_token_change_me';
const TZ = process.env.HOTEL_TIMEZONE ?? 'Africa/Douala';

const KHB_BRANDING = KHB.branding;

await migrate();

async function hotel(slug: string, name: string) {
  return (await one(pool, `INSERT INTO hotels (slug, name, timezone) VALUES ($1,$2,$3) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [slug, name, TZ]))!.id as string;
}
async function operator(email: string, name: string, platform = false) {
  return (await one(pool, `INSERT INTO operators (email, display_name, password_hash, is_platform_admin) VALUES ($1,$2,$3,$4)
    ON CONFLICT (email) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`, [email, name, hashPassword(PW), platform]))!.id as string;
}
async function member(op: string, hotelId: string, ...roles: string[]) {
  for (const r of roles) await pool.query('INSERT INTO memberships VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [op, hotelId, r]);
}
async function cfg(hotelId: string, kind: ConfigKind, data: unknown) {
  const exists = await one(pool, 'SELECT 1 FROM hotel_config_versions WHERE hotel_id=$1 AND kind=$2', [hotelId, kind]);
  if (exists) return;
  await saveConfig(pool, hotelId, kind, await validateConfig(pool, hotelId, kind, data), null);
}
async function staff(hotelId: string, name: string, email: string, role: string, vlUser: string, group: string) {
  await pool.query(`INSERT INTO staff (hotel_id, full_name, email, job_role, employee_no, visionline_user, visionline_user_group, password_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (hotel_id, email) DO NOTHING`, [hotelId, name, email, role, vlUser.toUpperCase(), vlUser, group, hashPassword(STAFF_PW)]);
}
async function template(hotelId: string, t: { name: string; description: string; doorIds?: string[]; doorGroupIds?: string[]; userGroupIds?: string[]; roles?: string[]; broad?: boolean; hours: number }) {
  await pool.query(`INSERT INTO access_templates (hotel_id, name, description, door_ids, door_group_ids, user_group_ids, allowed_job_roles, is_broad, max_validity_hours)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (hotel_id, name) DO NOTHING`,
    [hotelId, t.name, t.description, t.doorIds ?? [], t.doorGroupIds ?? [], t.userGroupIds ?? [], t.roles ?? [], t.broad ?? false, t.hours]);
}

// ---- K Hotel Bana -----------------------------------------------------------------------------
const khb = await hotel('k-hotel-bana', 'K Hotel Bana');
await cfg(khb, 'policy', {});
await cfg(khb, 'property', { displayName: 'K Hotel Bana', supportEmail: 'frontdesk@khotelbana.example', supportPhone: '+000 000 000 000', country: 'CM', timezone: TZ, homepage: 'https://www.khoteldouala.com/', address: null });
await cfg(khb, 'branding', KHB_BRANDING);
{
  // Databases created before the K Hotel brand was supplied still carry the placeholder green: publish the brand once.
  const cur = await one(pool, `SELECT data FROM hotel_config_versions WHERE hotel_id=$1 AND kind='branding' ORDER BY version DESC LIMIT 1`, [khb]);
  if (cur?.data?.primaryColor === '#14463A') await saveConfig(pool, khb, 'branding', await validateConfig(pool, khb, 'branding', KHB_BRANDING), null);
}
await cfg(khb, 'features', { staffMobileKeys: true });
const KHB_VISIONLINE = KHB.visionline;
await cfg(khb, 'visionline', KHB_VISIONLINE);
{
  // Databases from the first release lack the Mobile Access options and user-group list: add them once, keeping edits.
  const cur = await one(pool, `SELECT data FROM hotel_config_versions WHERE hotel_id=$1 AND kind='visionline' ORDER BY version DESC LIMIT 1`, [khb]);
  if (cur && cur.data.mobileAccessUuid === undefined) await saveConfig(pool, khb, 'visionline', await validateConfig(pool, khb, 'visionline', { ...KHB_VISIONLINE, ...cur.data, userGroups: [...new Set([...(cur.data.userGroups ?? []), ...KHB_VISIONLINE.userGroups])], mobileAccessUuid: 9, revokeMode: 'overridden', requirePersonalCredentials: false }), null);
}
// K Hotel Bana Mobile Access account (Visionline Options → Mobile Access, 13 Oct): System ID 3460, account
// hma-cs-92a0dc3e-…; production URL https://hospitality.credential-services.api.assaabloy.com. The test setup
// points the URL at the simulator. User and password are never stored here: they are secrets (SECRET_CS_TENANT_*).
const KHB_CS_ACCOUNT = KHB.accountName;
await cfg(khb, 'credential_services', { baseUrl: process.env.CS_BASE_URL ?? 'http://localhost:8444/cs', systemId: 3460, tenantUserRef: 'CS_TENANT_USER', tenantPasswordRef: 'CS_TENANT_PASSWORD' });
{
  // Databases from earlier releases used placeholder System ID 4711: switch to K Hotel Bana's real values once.
  const cur = await one(pool, `SELECT data FROM hotel_config_versions WHERE hotel_id=$1 AND kind='credential_services' ORDER BY version DESC LIMIT 1`, [khb]);
  if (cur?.data?.systemId === 4711) {
    await saveConfig(pool, khb, 'credential_services', await validateConfig(pool, khb, 'credential_services', { ...cur.data, systemId: 3460 }), null);
    const vl = await one(pool, `SELECT data FROM hotel_config_versions WHERE hotel_id=$1 AND kind='visionline' ORDER BY version DESC LIMIT 1`, [khb]);
    if (vl && !vl.data.accountName) await saveConfig(pool, khb, 'visionline', await validateConfig(pool, khb, 'visionline', { ...vl.data, accountName: KHB_CS_ACCOUNT }), null);
    await pool.query(`UPDATE resources SET active=false WHERE hotel_id=$1 AND kind='mobileaccessaccount' AND external_id='KHB-MOBILE'`, [khb]);
  }
}
// 2.7 Monitoring, test setup only: alert e-mail and SMS go to the simulator's test sinks (nothing leaves the PC).
{
  const simHost = (() => { try { return new URL(process.env.CS_BASE_URL ?? 'http://localhost:8444/cs').hostname; } catch { return 'localhost'; } })();
  await cfg(khb, 'notifications', {
    email: { enabled: true, host: simHost, port: Number(process.env.SIM_SMTP_PORT ?? 2525), security: 'none', user: 'alerts', passwordRef: 'SMTP_PASSWORD', from: 'K Hotel alerts <alerts@khb.test>' },
    sms: { enabled: true, provider: 'android-gateway', url: `http://${simHost}:8444/sms-gateway`, username: 'sms', secretRef: 'SMS_API_KEY' },
  });
  if (!(await one(pool, `SELECT 1 FROM alert_contacts WHERE hotel_id=$1`, [khb]))) {
    await pool.query(`INSERT INTO alert_contacts (hotel_id, name, email, phone, by_email, by_sms, categories) VALUES ($1,'Duty manager (test)','duty@khb.test','+237600000001',true,true,$2)`, [khb, ['doors', 'vip', 'locks', 'system']]);
  }
}
await cfg(khb, 'app_policy', { privacyText: 'K Hotel Bana uses your work account to deliver door keys to this phone. No location is collected.', supportEscalation: 'Call the duty manager if a door will not open.', partnerLinks: [], allowedLinkHosts: [] });

const platform = await operator('platform@smk.test', 'Platform Admin', true);
const admin = await operator('admin@khb.test', 'Grace Admin');
const issuer = await operator('issuer@khb.test', 'Eric Supervisor');
const security = await operator('security@khb.test', 'Sandra Security');
const auditor = await operator('auditor@khb.test', 'Alain Auditor');
const maint = await operator('maint@khb.test', 'Martin Maintenance');
const tech = await operator('tech@khb.test', 'Tina Technician');
const gm = await operator('gm@khb.test', 'Gerald Manager');
const hr = await operator('hr@khb.test', 'Hanna HR');
const desk = await operator('desk@khb.test', 'Daniel Desk');
await member(admin, khb, 'HOTEL_ADMIN');
await member(issuer, khb, 'KEY_ISSUER');
await member(security, khb, 'SECURITY_MANAGER');
await member(auditor, khb, 'AUDITOR');
await member(maint, khb, 'MAINTENANCE_MANAGER');
await member(tech, khb, 'TECHNICIAN');
await member(gm, khb, 'HOTEL_MANAGEMENT');
await member(hr, khb, 'HR_MANAGER');
await member(desk, khb, 'TIMEKEEPER');

await staff(khb, 'Amina Uwase', 'amina@khb.test', 'Housekeeper', 'khb-amina', 'Housekeeping');
await staff(khb, 'Jean Mugisha', 'jean@khb.test', 'Housekeeper', 'khb-jean', 'Housekeeping');
await staff(khb, 'Peter Otieno', 'peter@khb.test', 'Maintenance', 'khb-peter', 'Maintenance');
await staff(khb, 'Brice Ngono', 'brice@khb.test', 'Security', 'khb-brice', 'Security');

// 2.8 Time & attendance, test setup: module on, a day shift, the staff entrance as attendance door, the staff list and
// two daily workers without a keycard. Only added once; later changes in the portal are kept.
{
  const firstTime = !(await one(pool, `SELECT 1 FROM ta_shifts WHERE hotel_id=$1`, [khb]));
  if (firstTime) {
    const f = await one(pool, `SELECT data FROM hotel_config_versions WHERE hotel_id=$1 AND kind='features' ORDER BY version DESC LIMIT 1`, [khb]);
    if (f) await saveConfig(pool, khb, 'features', await validateConfig(pool, khb, 'features', { ...f.data, timeAttendance: true }), null);
    const pol = await one(pool, `SELECT data FROM hotel_config_versions WHERE hotel_id=$1 AND kind='policy' ORDER BY version DESC LIMIT 1`, [khb]);
    if (pol) await saveConfig(pool, khb, 'policy', await validateConfig(pool, khb, 'policy', { ...pol.data, attendance: { ...(pol.data.attendance ?? {}), doorIds: ['Staff Entrance'] } }), null);
  }
  const shift = (await one(pool, `INSERT INTO ta_shifts (hotel_id, name, start_time, end_time, break_minutes, grace_minutes, work_days) VALUES ($1,'Day 08-17','08:00','17:00',60,10,'{1,2,3,4,5,6}')
    ON CONFLICT (hotel_id, name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [khb]))!.id;
  if (!(await one(pool, `SELECT 1 FROM ta_people WHERE hotel_id=$1`, [khb]))) {
    await pool.query(`INSERT INTO ta_people (hotel_id, kind, staff_id, vl_user_id, full_name, employee_no, department, job_title, shift_id, start_date)
      SELECT hotel_id, 'staff', id, visionline_user, full_name, employee_no, COALESCE(visionline_user_group, job_role), job_role, $2, current_date - 7 FROM staff WHERE hotel_id=$1 AND status='ACTIVE'`, [khb, shift]);
    await pool.query(`INSERT INTO ta_people (hotel_id, kind, full_name, employee_no, department, employment, pay_basis, shift_id, start_date) VALUES
      ($1,'manual','Joseph Kamau','DW-001','Gardening','casual','daily',$2, current_date - 7), ($1,'manual','Esther Wanjiru','DW-002','Kitchen','casual','daily',$2, current_date - 7)`, [khb, shift]);
  }
}

await template(khb, { name: 'Floor 1 rooms', description: 'Guest rooms on floor 1 plus staff entrance and linen store', doorGroupIds: ['Floor 1'], doorIds: ['Staff Entrance', 'Linen Store'], roles: ['Housekeeper'], hours: 10 });
await template(khb, { name: 'Floor 2 rooms', description: 'Guest rooms on floor 2 plus staff entrance and linen store', doorGroupIds: ['Floor 2'], doorIds: ['Staff Entrance', 'Linen Store'], roles: ['Housekeeper'], hours: 10 });
await template(khb, { name: 'Common areas', description: 'Entrances and gym', doorGroupIds: ['Common Areas'], hours: 12 });
await template(khb, { name: 'Maintenance rounds', description: 'Doors of the Visionline Maintenance user group plus floor 1', userGroupIds: ['Maintenance'], doorGroupIds: ['Floor 1'], roles: ['Maintenance'], hours: 10 });
await template(khb, { name: 'All guest rooms (broad)', description: 'Every guest room. Needs Security Manager approval; short validity.', doorGroupIds: ['Floor 1', 'Floor 2', 'Floor 3'], doorIds: ['Staff Entrance'], broad: true, hours: 8 });

await pool.query(`INSERT INTO connectors (hotel_id, name, token_hash) VALUES ($1,'Visionline PC (dev)',$2) ON CONFLICT (token_hash) DO NOTHING`, [khb, hashToken(KHB_CONNECTOR_TOKEN)]);

// ---- Second hotel (isolation proof) -------------------------------------------------------------
const lake = await hotel('demo-lakeside', 'Demo Lakeside Hotel');
await cfg(lake, 'policy', {});
await cfg(lake, 'property', { displayName: 'Demo Lakeside Hotel', supportEmail: 'help@lakeside.example', supportPhone: '+000 111 222', country: 'CM', timezone: TZ });
await cfg(lake, 'branding', { appName: 'Lakeside Staff', portalTitle: 'Lakeside · Staff Access', primaryColor: '#1F4E79', secondaryColor: '#7FB3D5', textOnPrimary: '#FFFFFF' });
await cfg(lake, 'features', { staffMobileKeys: true });
await cfg(lake, 'visionline', { defaultUserGroup: 'Housekeeping' });
const lakeAdmin = await operator('admin@lakeside.test', 'Lakeside Admin');
await member(lakeAdmin, lake, 'HOTEL_ADMIN');
await staff(lake, 'Lake Housekeeper', 'hk@lakeside.test', 'Housekeeper', 'lake-hk', 'Housekeeping');

await tx((c) => audit(c, { hotelId: null, actorType: 'system', action: 'seed.applied', details: { hotels: ['k-hotel-bana', 'demo-lakeside'] } }));
console.log(`Seed complete.
  Portal sign-in (password ${PW}): admin@khb.test · issuer@khb.test · security@khb.test · auditor@khb.test · maint@khb.test · tech@khb.test · gm@khb.test · hr@khb.test · desk@khb.test · platform@smk.test · admin@lakeside.test
  Staff app sign-in (hotel k-hotel-bana, password ${STAFF_PW}): amina@khb.test · jean@khb.test · peter@khb.test · brice@khb.test
  K Hotel Bana connector token: ${KHB_CONNECTOR_TOKEN}`);
await pool.end();
void platform;
