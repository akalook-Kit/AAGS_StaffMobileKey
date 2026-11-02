/**
 * 2.17 A Visionline mobile key has no plastic card: its serial number reads FFFFFFFF (or it carries a mobile-access
 * endpoint / credential id). Only this yes/no leaves the connector; serial numbers themselves are never kept.
 */
export function isMobileCard(c: any): boolean | null {
  if (!c || typeof c !== 'object') return null;
  if (c.endPointID || c.endpointId || c.credentialID || c.credentialId) return true;
  const sn = Array.isArray(c.serialNumbers) ? c.serialNumbers.map((x: unknown) => String(x).trim()) : [];
  if (sn.some((x: string) => /^f{6,}$/i.test(x))) return true;
  return sn.length ? false : null;
}

