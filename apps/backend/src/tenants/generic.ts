/**
 * Any hotel: the settings a new installation starts with, from the installer's answers (environment variables).
 * Everything else (logo, colours, details, user groups, templates) is set afterwards in the portal.
 *
 *   HOTEL_NAME            "Lakeview Resort Kigali"            (required)
 *   PROVISION_HOTEL       hotel code used in links and the app (default: made from the name, e.g. lakeview-resort-kigali)
 *   HOTEL_TIMEZONE        IANA time zone, e.g. Africa/Nairobi  (required)
 *   HOTEL_COUNTRY         two letters, e.g. KE                 (required)
 *   HOTEL_SUPPORT_EMAIL / HOTEL_SUPPORT_PHONE                  (shown in the app; can be changed in the portal)
 *   HOTEL_SYSTEM_ID       ASSA ABLOY Credential Services System ID (Visionline Options -> Mobile Access); 0 = set later
 *   HOTEL_SYSTEM_NUMBER   number printed on reports (default: the System ID)
 *   HOTEL_VL_ACCOUNT      Visionline Mobile Access account name (optional)
 *   HOTEL_MA_UUID         Visionline Mobile Access UUID (optional)
 *   CS_BASE_URL           Credential Services URL (default: ASSA ABLOY hospitality production)
 */
export const CS_PRODUCTION_URL = 'https://hospitality.credential-services.api.assaabloy.com';

export function slugify(name: string) {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export interface HotelProfile { slug: string; name: string; timezone: string; config: Record<string, unknown> }

export function genericProfile(env: NodeJS.ProcessEnv = process.env): HotelProfile {
  const name = env.HOTEL_NAME?.trim();
  if (!name || name.length < 2) throw new Error('HOTEL_NAME is required (the hotel\'s name as shown in the portal, the app and on reports).');
  const slug = (env.PROVISION_HOTEL?.trim() || slugify(name));
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(slug)) throw new Error(`Hotel code "${slug}" may only contain lower-case letters, digits and dashes (2-40 characters).`);
  const timezone = env.HOTEL_TIMEZONE?.trim() ?? '';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error(`HOTEL_TIMEZONE "${timezone}" is not an IANA time zone (for example Africa/Nairobi).`); }
  if (!timezone) throw new Error('HOTEL_TIMEZONE is required (for example Africa/Nairobi).');
  const country = (env.HOTEL_COUNTRY ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('HOTEL_COUNTRY must be a two-letter country code (for example KE).');
  const systemId = Number(env.HOTEL_SYSTEM_ID ?? 0);
  if (!Number.isInteger(systemId) || systemId < 0) throw new Error('HOTEL_SYSTEM_ID must be a whole number (0 = set later in the portal).');
  const uuid = env.HOTEL_MA_UUID ? Number(env.HOTEL_MA_UUID) : null;
  const short = name.length <= 20 ? name : name.split(/\s+/).slice(0, 2).join(' ').slice(0, 20);
  const branding = {
    appName: `${short} Staff Key`.slice(0, 30), portalTitle: `${name} · Staff Access`.slice(0, 60),
    primaryColor: '#1F2933', secondaryColor: '#C9A86A', backgroundColor: '#F7F5F0', textOnPrimary: '#FFFFFF', fontFamily: 'system', logo: null,
    logoSize: { portal: 'medium', app: 'medium', reports: 'medium' },
  };
  return {
    slug, name, timezone,
    config: {
      policy: {},
      property: {
        displayName: name, supportEmail: env.HOTEL_SUPPORT_EMAIL?.trim() || `frontdesk@${slug}.invalid`, supportPhone: env.HOTEL_SUPPORT_PHONE?.trim() || '+000 000 000',
        country, timezone, homepage: null, address: null, systemNumber: env.HOTEL_SYSTEM_NUMBER?.trim() || (systemId ? String(systemId) : null),
      },
      branding,
      features: { staffMobileKeys: true },
      visionline: {
        defaultUserGroup: 'Housekeeping', userGroups: ['Housekeeping', 'Maintenance', 'Security', 'Management', 'Front Office'],
        accountName: env.HOTEL_VL_ACCOUNT?.trim() || null, keyLabel: null, mobileAccessUuid: Number.isInteger(uuid) ? uuid : null,
        revokeMode: 'overridden', requirePersonalCredentials: false,
      },
      credential_services: { baseUrl: env.CS_BASE_URL?.trim() || CS_PRODUCTION_URL, systemId, tenantUserRef: 'CS_TENANT_USER', tenantPasswordRef: 'CS_TENANT_PASSWORD' },
      app_policy: { privacyText: `${name} uses your work account to deliver door keys to this phone. No location is collected.`, supportEscalation: 'Call the duty manager if a door will not open.', partnerLinks: [], allowedLinkHosts: [] },
    },
  };
}
