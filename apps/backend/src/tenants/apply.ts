import { pool, many } from '../db.ts';
import { getConfig, saveConfig, validateConfig } from '../hotel-config.ts';
import { tenantPreset } from './la-falaise.ts';

/**
 * 2.35 An installer made for one hotel (SMK_TENANT) also gives its logo and colours to a hotel that was set up before
 * (an upgrade over the standard version), as long as that hotel has no logo of its own yet: a logo or colours chosen
 * in Settings -> Branding are never replaced.
 */
export async function applyTenantLook(log: (m: string) => void = () => {}) {
  const preset = tenantPreset();
  if (!preset) return;
  const logo = preset.logo();
  for (const h of await many(pool, `SELECT id FROM hotels WHERE NOT is_demo`)) {
    try {
      const br = await getConfig(pool, h.id, 'branding');
      if (!br || br.logo) continue;
      const next = { ...br, primaryColor: preset.branding.primaryColor, secondaryColor: preset.branding.secondaryColor, backgroundColor: preset.branding.backgroundColor,
        textOnPrimary: preset.branding.textOnPrimary, ...(logo ? { logo } : {}) };
      await saveConfig(pool, h.id, 'branding', await validateConfig(pool, h.id, 'branding', next), null);
      log(`${preset.name}: logo and colours applied to the existing hotel`);
    } catch (e) { log(`${preset.name}: could not apply the logo and colours (${(e as Error).message})`); }
  }
}
