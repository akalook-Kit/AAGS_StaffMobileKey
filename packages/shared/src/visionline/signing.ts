import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { VL } from './contract.ts';

/**
 * Visionline request signing [Web API §4.5], verified against the document's worked examples
 * (§7.1.3 and §7.1.4, see signing.test.ts):
 *
 *   VERB \n Content-MD5 \n Content-Type \n Date \n CanonicalizedHeaders CanonicalizedResource
 *
 * - Date line is empty when X-Aah-Date is present [§4.5.4]
 * - CanonicalizedHeaders is "x-aah-date:<value>\n" when present, otherwise empty [§4.5.5]
 * - CanonicalizedResource is the raw path, plus "?" and the query parts sorted lexicographically [§4.5.6]
 * - HMAC-SHA1 keyed with the UTF-8 bytes of the session access key, Base64 [§4.5, §6.1]
 * - Authorization: "AWS <sessionId>:<signature>"
 */
export interface SignInput {
  method: string;
  contentMd5?: string;
  contentType?: string;
  date?: string;
  xAahDate?: string;
  /** Raw request target, e.g. "/api/v1/cards?cardHolder=jdoe&validTime=20130105T1200" */
  url: string;
}

export function contentMd5(body: string | Buffer | undefined): string {
  if (body === undefined || body.length === 0) return '';
  return createHash('md5').update(body).digest('base64');
}

export function canonicalizedResource(url: string): string {
  const i = url.indexOf('?');
  if (i < 0) return url;
  const path = url.slice(0, i);
  const query = url.slice(i + 1);
  return path + '?' + query.split('&').sort().join('&');
}

export function stringToSign(i: SignInput): string {
  const dateLine = i.xAahDate ? '' : (i.date ?? '');
  const headers = i.xAahDate ? `${VL.auth.dateHeader}:${i.xAahDate.trim()}\n` : '';
  return `${i.method.toUpperCase()}\n${i.contentMd5 ?? ''}\n${i.contentType ?? ''}\n${dateLine}\n${headers}${canonicalizedResource(i.url)}`;
}

export function sign(accessKey: string, i: SignInput): string {
  return createHmac('sha1', Buffer.from(accessKey, 'utf8')).update(stringToSign(i), 'utf8').digest('base64');
}

export function authorizationHeader(sessionId: string, signature: string): string {
  return `${VL.auth.scheme} ${sessionId}:${signature}`;
}

export function parseAuthorization(value: string | undefined): { sessionId: string; signature: string } | null {
  if (!value) return null;
  const m = /^AWS ([^:\s]+):(\S+)$/.exec(value);
  return m ? { sessionId: m[1]!, signature: m[2]! } : null;
}

export function signaturesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
