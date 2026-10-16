/**
 * Roles and granular permissions (spec §13.4.4).
 * Roles are assigned per hotel membership; Platform Administrator is global.
 */
export const PERMISSIONS = [
  'staff.read',
  'staff.manage',
  'endpoint.onboard',
  'endpoint.delete',
  'key.read',
  'key.issue',
  'key.approve_broad',
  'key.revoke',
  'resources.read',
  'resources.discover',
  'templates.manage',
  'connector.read',
  'connector.manage',
  'branding.manage',
  'settings.manage',
  'operators.manage',
  'audit.read',
  'audit.export',
  'battery.read',
  'battery.manage',
  'maintenance.read',
  'maintenance.work',
  'maintenance.manage',
  /** Insights: management reports, including Visionline people and keycards per user group. */
  'reports.read',
  /** Event log: lock entrances, refused entries, alarms, battery, key and system events; PDF printing only. */
  'events.read',
  /** Monitoring: alerts (doors offline, VIP doors, lock alarms, disk, database, connector) and system health. */
  'alerts.read',
  /** Acknowledge alerts, manage e-mail/SMS contacts and watched (VIP) doors. */
  'alerts.manage',
  /** Time & attendance: timesheets and payroll reports. */
  'attendance.read',
  /** Check people in and out at the desk (time clock). */
  'attendance.clock',
  /** People, shifts, leave, corrections, approving periods for payroll, attendance settings. */
  'attendance.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  'PLATFORM_ADMIN',
  'HOTEL_ADMIN',
  'SECURITY_MANAGER',
  'KEY_ISSUER',
  'APPROVER',
  'MAINTENANCE_MANAGER',
  'TECHNICIAN',
  'HOTEL_MANAGEMENT',
  'HR_MANAGER',
  'TIMEKEEPER',
  'AUDITOR',
  'READ_ONLY',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  PLATFORM_ADMIN: 'Platform Administrator',
  HOTEL_ADMIN: 'Hotel Administrator',
  SECURITY_MANAGER: 'Security Manager',
  KEY_ISSUER: 'Key Issuer',
  APPROVER: 'Approver',
  MAINTENANCE_MANAGER: 'Maintenance Manager',
  TECHNICIAN: 'Technician',
  HOTEL_MANAGEMENT: 'Hotel Management (reports)',
  HR_MANAGER: 'HR Manager (time & attendance)',
  TIMEKEEPER: 'Timekeeper (check-in desk)',
  AUDITOR: 'Auditor',
  READ_ONLY: 'Read Only',
};

const ALL = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  PLATFORM_ADMIN: ALL,
  HOTEL_ADMIN: ALL.filter((p) => p !== 'key.approve_broad'),
  SECURITY_MANAGER: [
    'staff.read', 'key.read', 'key.approve_broad', 'key.revoke', 'endpoint.delete',
    'resources.read', 'templates.manage', 'connector.read', 'audit.read', 'audit.export', 'battery.read', 'maintenance.read', 'reports.read', 'events.read', 'alerts.read', 'alerts.manage',
  ],
  KEY_ISSUER: ['staff.read', 'staff.manage', 'endpoint.onboard', 'key.read', 'key.issue', 'key.revoke', 'resources.read'],
  APPROVER: ['staff.read', 'key.read', 'key.approve_broad', 'resources.read'],
  // Phase 2. "work" = report, comment, attach and move a request up to Resolved; "manage" = assign, prioritise,
  // set due dates, close, cancel and reopen.
  MAINTENANCE_MANAGER: ['staff.read', 'resources.read', 'battery.read', 'battery.manage', 'maintenance.read', 'maintenance.work', 'maintenance.manage', 'connector.read', 'alerts.read'],
  TECHNICIAN: ['resources.read', 'battery.read', 'maintenance.read', 'maintenance.work'],
  // Read-only view for the general manager and department heads: every report, nothing they can change.
  HOTEL_MANAGEMENT: ['staff.read', 'key.read', 'resources.read', 'connector.read', 'battery.read', 'maintenance.read', 'reports.read', 'audit.export', 'events.read', 'alerts.read', 'attendance.read'],
  // Time & attendance: HR runs it; the timekeeper only checks people in and out at the desk.
  HR_MANAGER: ['staff.read', 'resources.read', 'attendance.read', 'attendance.clock', 'attendance.manage'],
  TIMEKEEPER: ['attendance.clock'],
  AUDITOR: ['staff.read', 'key.read', 'resources.read', 'connector.read', 'audit.read', 'audit.export', 'battery.read', 'maintenance.read', 'reports.read', 'events.read', 'alerts.read', 'attendance.read'],
  READ_ONLY: ['staff.read', 'key.read', 'resources.read', 'connector.read', 'battery.read', 'maintenance.read'],
};

/**
 * Portal modules that can be hidden from people (2.8): per person (Operators page) and, for mobile keys while the
 * hotel finalises them, for everyone except administrators (Settings -> Modules). Hiding removes the module's
 * permissions on the server too, not only the menu item.
 */
export const MODULES = {
  mobileKeys: { label: 'Staff mobile keys (keys, phones, app settings, key policy)', permissions: ['key.read', 'key.issue', 'key.approve_broad', 'key.revoke', 'endpoint.onboard', 'endpoint.delete', 'branding.manage', 'templates.manage'] },
  insights: { label: 'Insights (reports)', permissions: ['reports.read'] },
  eventLog: { label: 'Event log', permissions: ['events.read'] },
  monitoring: { label: 'Monitoring', permissions: ['alerts.read', 'alerts.manage'] },
  attendance: { label: 'Time & attendance', permissions: ['attendance.read', 'attendance.clock', 'attendance.manage'] },
  battery: { label: 'Battery status', permissions: ['battery.read', 'battery.manage'] },
  maintenance: { label: 'Maintenance', permissions: ['maintenance.read', 'maintenance.work', 'maintenance.manage'] },
  audit: { label: 'Audit trail', permissions: ['audit.read', 'audit.export'] },
} as const satisfies Record<string, { label: string; permissions: readonly Permission[] }>;
export type ModuleId = keyof typeof MODULES;
export const MODULE_IDS = Object.keys(MODULES) as ModuleId[];

export function withoutModules(perms: Set<Permission>, hidden: readonly string[]): Set<Permission> {
  const out = new Set(perms);
  for (const m of hidden) for (const p of (MODULES as Record<string, { permissions: readonly Permission[] }>)[m]?.permissions ?? []) out.delete(p);
  return out;
}

export function permissionsFor(roles: readonly Role[]): Set<Permission> {
  const s = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r] ?? []) s.add(p);
  return s;
}
