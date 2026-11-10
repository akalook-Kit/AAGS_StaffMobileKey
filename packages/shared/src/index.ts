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

/**
 * 2.20 A keycard holder name that is not a person (Armel, 31 Oct): "Staff", "Housekeeping 2", "Maid", "Master", "Spare",
 * "Test card", "FO 01", a number... Such cards cannot be traced to someone; the portal flags them to the administrators.
 * A name with at least one word that is not a generic word (e.g. "Koffi Team") counts as a person.
 */
const GENERIC_WORDS = new Set(('staff team card cards key keys keycard keycards user users spare spares temp temporary test testing demo sample dummy '
  + 'guest guests visitor visitors contractor contractors daily day night shift general generic common shared public master grand grandmaster '
  + 'submaster sub floor floors wing block building housekeeping hk hsk maid maids room rooms attendant attendants cleaner cleaners cleaning laundry '
  + 'linen minibar turndown reception receptionist front desk office fo frontoffice concierge bell bellboy porter porters security guard guards '
  + 'engineering engineer engineers eng maintenance tech technician technicians it f&b fb food beverage kitchen chef cook bar restaurant waiter '
  + 'spa gym pool supervisor supervisors manager managers management mgr duty gm admin administrator sym pms system emergency fire backup '
  + 'new old extra other unknown none na n/a tbd vacant noname no name employee employees worker workers department dept the of and a').split(' '));
export function genericCardName(name: string | null | undefined): boolean {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return true;
  const words = n.split(/[\s,.;:_\-/#()]+/).filter(Boolean);
  if (!words.length) return true;
  return words.every((w) => GENERIC_WORDS.has(w) || /^[0-9]+$/.test(w) || /^[a-z]{1,2}[0-9]*$/.test(w) || /^[0-9]+[a-z]{0,2}$/.test(w));
}
export * from './edition.ts';
