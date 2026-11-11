import type { Permission } from './permissions.ts';

/**
 * 2.33 Editions. "full" is everything. "light" (La Falaise Hotel Bonapriso, Armel 10 Nov: "a version specific to La
 * Falaise without any need to log in, minimize the module to just the reports, remove issuing keycards staff or mobile
 * staff keycards and remove door & safety since the hotel is offline; the administration should be limited as well")
 * keeps the reports, lock troubleshooting and batteries, the Visionline cards & people (read only) and a short
 * administration. What it removes is removed on the server too (the permissions), not only from the menu.
 */
export type EditionId = 'full' | 'light';

/** Permissions that do not exist in the light edition. */
export const LIGHT_REMOVED_PERMISSIONS: readonly Permission[] = [
  // mobile keys and the staff app
  'key.read', 'key.issue', 'key.approve_broad', 'key.revoke', 'endpoint.onboard', 'endpoint.delete', 'templates.manage', 'staff.manage',
  // (staff.read stays: it also guards reading the settings of the short administration)
  // issuing / changing staff keycards, lock-outs
  'keycards.request', 'keycards.manage', 'lockout.request', 'lockout.approve',
  // doors & safety (offline hotel): live occupancy, emergency; time & attendance, breakfast, ID cards
  'muster.read', 'emergency.manage', 'attendance.read', 'attendance.clock', 'attendance.manage', 'breakfast.read', 'breakfast.serve', 'breakfast.manage', 'idcards.manage',
];

/** Portal pages of the light edition (anything else is not shown and not routed). */
/**
 * 2.34 Light edition (Armel, 11 Nov): only what the hotel team needs to diagnose its locks. The landing page (locks,
 * forecast, reminders), the lock register and troubleshooting (with the day report), battery status, the locks and
 * batteries report, and help. No users, connector, settings or administration pages.
 */
export const LIGHT_PAGES = ['/', '/lock-troubleshoot', '/battery', '/reports', '/help'] as const;

/** Reports of the reports page left out of the light edition: all but the locks and batteries report. */
export const LIGHT_HIDDEN_REPORTS = ['daily-summary', 'guest-keycards', 'staff-keycards-issued', 'keycard-holders', 'keycard-requests', 'door-activity', 'refused-entries'] as const;

export function withoutEdition(perms: Set<Permission>, edition: EditionId): Set<Permission> {
  if (edition !== 'light') return perms;
  const out = new Set(perms);
  for (const p of LIGHT_REMOVED_PERMISSIONS) out.delete(p);
  return out;
}
