import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 2.33 La Falaise Hotel Bonapriso (Douala), light edition (SMK_TENANT=la-falaise): the name, time zone, country, logo
 * and colours the installation starts with. Everything can still be changed in the portal (Branding and logo).
 */
const logoFile = process.env.SMK_BRAND_DIR ? join(process.env.SMK_BRAND_DIR, 'la-falaise', 'la-falaise-logo.png') : fileURLToPath(new URL('../../../../brand/la-falaise/la-falaise-logo.png', import.meta.url));
export const LA_FALAISE = {
  id: 'la-falaise',
  name: 'La Falaise Hotel Bonapriso',
  timezone: 'Africa/Douala',
  country: 'CM',
  logo: () => (existsSync(logoFile) ? `data:image/png;base64,${readFileSync(logoFile).toString('base64')}` : null),
  branding: { appName: 'La Falaise Bonapriso', portalTitle: 'La Falaise Hotel Bonapriso · Reports', primaryColor: '#1D3A6E', secondaryColor: '#C9A43C', backgroundColor: '#F7F5EF', textOnPrimary: '#FFFFFF' },
  /** Offline hotel, no mobile keys. Battery monitoring is switched on in Settings -> Modules once the connector runs
   *  (it needs connector 0.5.0 or newer, checked when it is switched on). */
  features: { staffMobileKeys: false },
};
export const tenantPreset = (env: NodeJS.ProcessEnv = process.env) => (env.SMK_TENANT === 'la-falaise' ? LA_FALAISE : null);
