import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * K Hotel Bana reference tenant: the hotel's real settings (12–13 Oct), shared by the development seed and
 * production provisioning. No secrets here: Credential Services user and password are secret references.
 */
const logoFile = fileURLToPath(new URL('../../../../brand/k-hotel/k-hotel-logo.png', import.meta.url));
const logo = existsSync(logoFile) ? `data:image/png;base64,${readFileSync(logoFile).toString('base64')}` : null;
const timezone = process.env.HOTEL_TIMEZONE ?? 'Africa/Douala';

const branding = {
  appName: 'K Hotel Staff Key', portalTitle: 'K Hotel · Staff Access',
  primaryColor: '#050505', secondaryColor: '#DCAE99', backgroundColor: '#F7F2EF', textOnPrimary: '#DCAE99',
  fontFamily: 'system', logo,
  wording: { keysTitle: 'Mobile Keys', accessAreas: 'Access Areas', validUntil: 'Valid Until', lockStatus: 'Lock Status', support: 'Support', tapInstruction: 'Hold your phone near the lock' },
};
const visionline = {
  defaultUserGroup: 'Housekeeping', userGroups: ['Housekeeping', 'Maintenance', 'Security', 'Management', 'Front Office'],
  accountName: 'hma-cs-92a0dc3e-6379-4b84-999c-aedb582c1b63', keyLabel: 'KHB %ROOMNUM%',
  mobileAccessUuid: 9, revokeMode: 'overridden', requirePersonalCredentials: false, // Visionline Options → Mobile Access at K Hotel
};

export const KHB = {
  slug: 'k-hotel-bana',
  name: 'K Hotel Bana',
  timezone,
  accountName: visionline.accountName,
  /** Production Credential Services URL for the K Hotel Bana Mobile Access account (13 Oct). */
  csBaseUrl: 'https://hospitality.credential-services.api.assaabloy.com',
  branding,
  visionline,
  config: (csBaseUrl: string) => ({
    policy: {},
    property: { displayName: 'K Hotel Bana', supportEmail: 'frontdesk@khotelbana.example', supportPhone: '+000 000 000 000', country: 'CM', timezone, homepage: 'https://www.khoteldouala.com/', address: null },
    branding,
    features: { staffMobileKeys: true },
    visionline,
    credential_services: { baseUrl: csBaseUrl, systemId: 3460, tenantUserRef: 'CS_TENANT_USER', tenantPasswordRef: 'CS_TENANT_PASSWORD' },
    app_policy: { privacyText: 'K Hotel Bana uses your work account to deliver door keys to this phone. No location is collected.', supportEscalation: 'Call the duty manager if a door will not open.', partnerLinks: [], allowedLinkHosts: [] },
  }),
};
