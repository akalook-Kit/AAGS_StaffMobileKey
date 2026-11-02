export * from './permissions.ts';
export * from './commands.ts';
export * from './status.ts';
export * from './credential-services.ts';
export * from './sealing-browser.ts';

/**
 * 2.17 A Visionline operator shared by many people (the PMS interface user, "sym", "admin"...): whatever the portal
 * does in Visionline is then logged under that name, so nobody can tell later who made a keycard.
 */
export function sharedVisionlineOperator(username: string | null | undefined): boolean {
  const u = String(username ?? '').trim().toLowerCase();
  if (!u) return false;
  return /(^|[^a-z])(pms|opera|fidelio|protel|interface|ifc|sym|admin|administrator|system|default|service|web ?service|webapi|api|user|test|guest|frontdesk|front ?office|reception)([^a-z]|$)/.test(u) || u.length <= 3;
}
