import { VisionlineApiError } from './client.ts';

/**
 * Time formats in queries. The Web API document gives local "yyyyMMddTHHmm" for card times and UTC for alarm
 * times, but Visionline versions differ in the exact form they accept ("Time must be in UTC."). Each query tries its
 * forms in order and remembers the first one this Visionline accepts, so the hotel never has to set anything.
 */
const chosenForm = new Map<string, number>();
export const isTimeFormatError = (e: unknown) => e instanceof VisionlineApiError && e.status >= 400 && e.status < 500 && ![401, 403, 404].includes(e.status) && /\b(utc|time|date)\b/i.test(`${e.message} ${e.developerMessage ?? ''}`);
export function utcForms(d: Date) {
  const iso = d.toISOString().replace(/\.\d+Z$/, 'Z');           // 2026-10-17T12:40:00Z
  const compact = iso.replace(/[-:]/g, '');                       // 20261017T124000Z
  return [`${compact.slice(0, 13)}Z`, compact, iso];               // minutes+Z, seconds+Z, ISO
}
export async function withTimeForms<T>(key: string, forms: string[], fn: (t: string) => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = chosenForm.get(key) ?? 0; i < forms.length; i++) {
    try { const r = await fn(forms[i]!); chosenForm.set(key, i); return r; }
    catch (e) { if (!isTimeFormatError(e)) throw e; last = e; }
  }
  throw last;
}
