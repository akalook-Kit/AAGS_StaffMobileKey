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
  AUDITOR: 'Auditor',
  READ_ONLY: 'Read Only',
};

const ALL = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  PLATFORM_ADMIN: ALL,
  HOTEL_ADMIN: ALL.filter((p) => p !== 'key.approve_broad'),
  SECURITY_MANAGER: [
    'staff.read', 'key.read', 'key.approve_broad', 'key.revoke', 'endpoint.delete',
    'resources.read', 'templates.manage', 'connector.read', 'audit.read', 'audit.export', 'battery.read', 'maintenance.read',
  ],
  KEY_ISSUER: ['staff.read', 'staff.manage', 'endpoint.onboard', 'key.read', 'key.issue', 'key.revoke', 'resources.read'],
  APPROVER: ['staff.read', 'key.read', 'key.approve_broad', 'resources.read'],
  // Phase 2. "work" = report, comment, attach and move a request up to Resolved; "manage" = assign, prioritise,
  // set due dates, close, cancel and reopen.
  MAINTENANCE_MANAGER: ['staff.read', 'resources.read', 'battery.read', 'battery.manage', 'maintenance.read', 'maintenance.work', 'maintenance.manage', 'connector.read'],
  TECHNICIAN: ['resources.read', 'battery.read', 'maintenance.read', 'maintenance.work'],
  AUDITOR: ['staff.read', 'key.read', 'resources.read', 'connector.read', 'audit.read', 'audit.export', 'battery.read', 'maintenance.read'],
  READ_ONLY: ['staff.read', 'key.read', 'resources.read', 'connector.read', 'battery.read', 'maintenance.read'],
};

export function permissionsFor(roles: readonly Role[]): Set<Permission> {
  const s = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r] ?? []) s.add(p);
  return s;
}
