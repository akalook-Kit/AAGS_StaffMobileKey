import { z } from 'zod';
import { pool, one, many, type Db } from './db.ts';
import { badRequest } from './lib/errors.ts';
import { validateImageDataUrl, contrastRatio } from './lib/images.ts';

/**
 * Versioned tenant configuration (spec §5, §13.4.3, §13.5). Each save creates a new immutable version;
 * the latest version is live. Rollback publishes an older version again. Secrets are never stored here:
 * only references to them (e.g. tenantPasswordRef) are.
 */
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour such as #0F4C3A');
const httpsUrl = z.string().url().refine((u) => u.startsWith('https://'), 'Links must use https://');
const imageField = z.string().startsWith('data:image/').optional().nullable();

export const SCHEMAS = {
  branding: z.object({
    appName: z.string().min(2).max(30),
    portalTitle: z.string().min(2).max(60),
    primaryColor: hex,
    secondaryColor: hex,
    backgroundColor: hex.default('#F7F5F0'),
    textOnPrimary: hex.default('#FFFFFF'),
    darkPrimaryColor: hex.optional(),
    fontFamily: z.enum(['system', 'serif', 'rounded']).default('system'),
    logo: imageField,
    heroImage: imageField,
    wording: z.object({
      keysTitle: z.string().max(30).default('Mobile Keys'),
      accessAreas: z.string().max(30).default('Access Areas'),
      validUntil: z.string().max(30).default('Valid Until'),
      lockStatus: z.string().max(30).default('Lock Status'),
      support: z.string().max(30).default('Support'),
      tapInstruction: z.string().max(60).default('Hold your phone near the lock'),
    }).default({} as any),
    languages: z.array(z.string().min(2).max(8)).min(1).default(['en']),
  }),
  property: z.object({
    displayName: z.string().min(2),
    homepage: httpsUrl.optional().nullable(),
    supportEmail: z.string().email(),
    supportPhone: z.string().min(5),
    address: z.string().optional().nullable(),
    country: z.string().length(2),
    timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown IANA time zone'),
    checkInTime: z.string().regex(/^\d{2}:\d{2}$/).default('14:00'),
    checkOutTime: z.string().regex(/^\d{2}:\d{2}$/).default('11:00'),
    /** Extra building addresses shown in the app for keys on these door groups (vendor portal: Building addresses). */
    buildings: z.array(z.object({
      address: z.string().min(3).max(200),
      mapUrl: httpsUrl.optional().nullable(),
      doorGroups: z.array(z.string()).default([]),
    })).max(50).default([]),
  }),
  features: z.object({
    staffMobileKeys: z.boolean(),
    batteryMonitoring: z.boolean().default(false),
    maintenance: z.boolean().default(false),
    guestKeys: z.boolean().default(false),
    pmsOccupancy: z.boolean().default(false),
    partnerLinks: z.boolean().default(false),
  }),
  policy: z.object({
    maxValidityHours: z.number().int().min(1).max(24 * 31).default(24),
    broadDoorThreshold: z.number().int().min(2).default(15),
    broadMaxValidityHours: z.number().int().min(1).max(72).default(12),
    maxFutureStartDays: z.number().int().min(0).max(30).default(7),
    requireApprovalForBroad: z.boolean().default(true),
    /** Hotel decision (13 Oct): cancel the card after MORE than this many attempts at doors not on the key. 0 = off. */
    wrongDoorLimit: z.number().int().min(0).max(50).default(5),
    /** Visionline lock events that count as a wrong-door attempt [Web API §7.14.1]: 320, 323. */
    wrongDoorEventCodes: z.array(z.number().int()).default([320, 323]),
    assetLimitsKb: z.object({ logo: z.number().int().default(500), heroImage: z.number().int().default(1500) }).default({ logo: 500, heroImage: 1500 }),
    /** Phase 2 battery monitoring. Alarms come from the locks' own battery events [Web API §7.14.1]. */
    battery: z.object({
      /** A door's battery reading is "stale" when nothing was reported for this many days. */
      staleAfterDays: z.number().int().min(1).max(365).default(30),
      /** Open a maintenance request automatically for: critical alarms, any alarm, or never. */
      autoTicket: z.enum(['critical', 'any', 'off']).default('critical'),
      /** Optional voltage thresholds for "Battery level below X volts" events, per battery range. Empty = show the
       *  value only. Set them from the lock models' documentation (hotel-defined, not from the Web API). */
      voltage: z.object({
        highRange: z.object({ low: z.number().min(6).max(9).nullable().default(null), critical: z.number().min(6).max(9).nullable().default(null) }).default({ low: null, critical: null }),
        lowRange: z.object({ low: z.number().min(3).max(4.8).nullable().default(null), critical: z.number().min(3).max(4.8).nullable().default(null) }).default({ low: null, critical: null }),
      }).default({ highRange: { low: null, critical: null }, lowRange: { low: null, critical: null } }),
    }).default({ staleAfterDays: 30, autoTicket: 'critical', voltage: { highRange: { low: null, critical: null }, lowRange: { low: null, critical: null } } }),
    /** Phase 2 maintenance requests. */
    maintenance: z.object({
      /** Due time given to a new request by priority, in hours. */
      dueHours: z.object({ low: z.number().int().min(1).default(168), normal: z.number().int().min(1).default(72), high: z.number().int().min(1).default(24), urgent: z.number().int().min(1).default(4) })
        .default({ low: 168, normal: 72, high: 24, urgent: 4 }),
      /** Staff with these job roles are told in the app about new unassigned requests and battery alarms. */
      notifyJobRoles: z.array(z.string().min(1).max(60)).default(['Maintenance']),
      /** Staff may report a problem from the app. */
      staffCanReport: z.boolean().default(true),
    }).default({ dueHours: { low: 168, normal: 72, high: 24, urgent: 4 }, notifyJobRoles: ['Maintenance'], staffCanReport: true }),
  }),
  visionline: z.object({
    accountName: z.string().optional().nullable(), // null = Visionline default credential services account [§7.5.2]
    /** Visionline user groups this hotel uses for staff (Housekeeping, Maintenance, Security…). */
    userGroups: z.array(z.string().min(1).max(60)).default([]),
    defaultUserGroup: z.string().min(1),
    keyLabel: z.string().max(32).optional().nullable(),
    /** Mirror of Visionline Options → Mobile Access → UUID (site BLE UUID number). K Hotel: 9. */
    mobileAccessUuid: z.number().int().min(0).max(65535).optional().nullable(),
    /** Mirror of Visionline Options → Mobile Access: "Revoke mobile key when overridden" or "… when expired". */
    revokeMode: z.enum(['overridden', 'expired']).default('overridden'),
    /** Like the vendor portal: operators must store personal Visionline credentials before issuing keys. */
    requirePersonalCredentials: z.boolean().default(false),
    /** Future start times: "hold" = the platform creates the key in Visionline at its start time (Web API §7.6.2);
     *  "send" = create it now with startTime in the future (only once ASSA ABLOY confirms Visionline accepts it). */
    startTimeMode: z.enum(['hold', 'send']).default('hold'),
  }).transform((v) => ({ ...v, userGroups: [...new Set([v.defaultUserGroup, ...v.userGroups])] })),
  credential_services: z.object({
    baseUrl: z.string().url(),
    systemId: z.number().int(),
    tenantUserRef: z.string().min(1),
    tenantPasswordRef: z.string().min(1),
  }),
  app_policy: z.object({
    notifyBeforeExpiryMinutes: z.number().int().min(0).default(30),
    deviceReplacement: z.enum(['operator-only', 'self-service-with-approval']).default('operator-only'),
    privacyText: z.string().max(2000).default(''),
    supportEscalation: z.string().max(500).default(''),
    partnerLinks: z.array(z.object({ label: z.string().min(1).max(40), url: httpsUrl })).max(12).default([]),
    allowedLinkHosts: z.array(z.string()).default([]),
  }),
} as const;
export type ConfigKind = keyof typeof SCHEMAS;
export const CONFIG_KINDS = Object.keys(SCHEMAS) as ConfigKind[];

/** Modules that exist in this release. Phase 3 modules cannot be switched on yet (spec §13.4.3). */
const AVAILABLE_FEATURES = new Set(['staffMobileKeys', 'batteryMonitoring', 'maintenance']);

export async function validateConfig(db: Db, hotelId: string, kind: ConfigKind, raw: unknown) {
  const parsed = SCHEMAS[kind].safeParse(raw);
  if (!parsed.success) throw badRequest('INVALID_CONFIG', 'Configuration is invalid.', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const data: any = parsed.data;
  if (kind === 'features') {
    for (const [k, v] of Object.entries(data)) if (v && !AVAILABLE_FEATURES.has(k))
      throw badRequest('FEATURE_UNAVAILABLE', `${k} is not available in this release. It requires its module, licence and connector capability.`);
    // Battery monitoring needs a connector whose Visionline watch reads battery events (connector 0.5.0+).
    const before = await getConfig(db, hotelId, 'features');
    if (data.batteryMonitoring && !before?.batteryMonitoring) {
      const c = await one(db, `SELECT 1 FROM connectors WHERE hotel_id=$1 AND status='ACTIVE' AND health->'capabilities' ? 'battery-events'`, [hotelId]);
      if (!c) throw badRequest('CONNECTOR_CAPABILITY', 'Battery monitoring needs connector 0.5.0 or newer with the Visionline watch switched on. Update the connector, then try again.');
    }
  }
  if (kind === 'branding') {
    const policy = await getConfig(db, hotelId, 'policy');
    const limits = policy?.assetLimitsKb ?? { logo: 500, heroImage: 1500 };
    const ratio = contrastRatio(data.primaryColor, data.textOnPrimary);
    if (ratio < 4.5) throw badRequest('LOW_CONTRAST', `Text on the primary colour has contrast ${ratio.toFixed(2)}:1. WCAG AA needs at least 4.5:1.`);
    if (data.logo) validateImageDataUrl(data.logo, { maxKb: limits.logo, minWidth: 64, maxAspect: 4, label: 'Logo' });
    if (data.heroImage) validateImageDataUrl(data.heroImage, { maxKb: limits.heroImage, minWidth: 600, maxAspect: 3, label: 'Hero image' });
  }
  if (kind === 'app_policy') {
    for (const l of data.partnerLinks) {
      const host = new URL(l.url).hostname;
      if (!data.allowedLinkHosts.includes(host)) throw badRequest('LINK_NOT_ALLOWED', `${host} is not in the allow-list of link hosts.`);
    }
  }
  return data;
}

export async function getConfig(db: Db, hotelId: string, kind: ConfigKind): Promise<any | null> {
  const r = await one(db, 'SELECT data FROM hotel_config_versions WHERE hotel_id=$1 AND kind=$2 ORDER BY version DESC LIMIT 1', [hotelId, kind]);
  return r?.data ?? null;
}

export async function getConfigWithVersion(hotelId: string, kind: ConfigKind) {
  const latest = await one(pool, 'SELECT version, data, created_at, created_by FROM hotel_config_versions WHERE hotel_id=$1 AND kind=$2 ORDER BY version DESC LIMIT 1', [hotelId, kind]);
  const history = await many(pool, `SELECT v.version, v.created_at, o.display_name AS created_by FROM hotel_config_versions v
    LEFT JOIN operators o ON o.id=v.created_by WHERE v.hotel_id=$1 AND v.kind=$2 ORDER BY v.version DESC LIMIT 20`, [hotelId, kind]);
  return { kind, version: latest?.version ?? 0, data: latest?.data ?? null, history };
}

export async function saveConfig(db: Db, hotelId: string, kind: ConfigKind, data: unknown, operatorId: string | null) {
  const r = await one(db, `INSERT INTO hotel_config_versions (hotel_id, kind, version, data, created_by)
    VALUES ($1, $2, COALESCE((SELECT MAX(version) FROM hotel_config_versions WHERE hotel_id=$1 AND kind=$2), 0) + 1, $3, $4)
    RETURNING version`, [hotelId, kind, data, operatorId]);
  return r!.version as number;
}
