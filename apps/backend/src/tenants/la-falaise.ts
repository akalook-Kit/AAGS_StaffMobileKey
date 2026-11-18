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
/** 2.35 K Hotel Douala (Light build, Armel 16 Nov: "another build for K Hotel Douala with the logo and colour"). */
const kLogoFile = process.env.SMK_BRAND_DIR ? join(process.env.SMK_BRAND_DIR, 'k-hotel', 'k-hotel-logo.png') : fileURLToPath(new URL('../../../../brand/k-hotel/k-hotel-logo.png', import.meta.url));
export const K_HOTEL_DOUALA = {
  id: 'k-hotel-douala',
  name: 'K Hotel Douala',
  timezone: 'Africa/Douala',
  country: 'CM',
  logo: () => (existsSync(kLogoFile) ? `data:image/png;base64,${readFileSync(kLogoFile).toString('base64')}` : null),
  branding: { appName: 'K Hotel Douala', portalTitle: 'K Hotel Douala · Lock diagnosis', primaryColor: '#050505', secondaryColor: '#DCAE99', backgroundColor: '#F7F2EF', textOnPrimary: '#DCAE99' },
  features: { staffMobileKeys: false },
};
const PRESETS: Record<string, typeof LA_FALAISE> = { 'la-falaise': LA_FALAISE, 'k-hotel-douala': K_HOTEL_DOUALA };
export const tenantPreset = (env: NodeJS.ProcessEnv = process.env) => (env.SMK_TENANT ? PRESETS[env.SMK_TENANT] ?? null : null);
