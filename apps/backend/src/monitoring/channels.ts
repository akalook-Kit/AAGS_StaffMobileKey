import nodemailer from 'nodemailer';
import { getSecret } from '../config.ts';

/**
 * How alerts leave the platform: e-mail through the hotel's own mail server (SMTP) and SMS through a gateway.
 * Passwords and API keys are secret references (SECRET_<ref> on the server), never stored in the database and
 * never shown in the portal. TLS certificates are always verified.
 */
export interface EmailSettings { enabled: boolean; host: string; port: number; security: 'starttls' | 'tls' | 'none'; user: string; passwordRef: string; from: string }
export interface SmsSettings {
  enabled: boolean; provider: 'android-gateway' | 'africastalking' | 'http'; url: string; username: string; secretRef: string; sender: string;
  contentType: 'json' | 'form'; bodyTemplate: string; authHeader: string;
}
export interface Channels { email: EmailSettings; sms: SmsSettings }

export async function sendEmail(s: EmailSettings, to: string, subject: string, text: string) {
  const pass = getSecret(s.passwordRef);
  const t = nodemailer.createTransport({
    host: s.host, port: s.port, secure: s.security === 'tls', requireTLS: s.security === 'starttls', ignoreTLS: s.security === 'none',
    auth: s.user ? { user: s.user, pass: pass ?? '' } : undefined,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  try { await t.sendMail({ from: s.from, to, subject, text }); } finally { t.close(); }
}

/** Phone numbers in international form: +254712345678. */
export function normalisePhone(p: string) {
  const n = p.replace(/[\s().-]/g, '');
  if (!/^\+\d{8,15}$/.test(n)) throw new Error(`"${p}" is not a phone number in international form (e.g. +254712345678).`);
  return n;
}

const jsonEscape = (v: string) => JSON.stringify(v).slice(1, -1);
function fill(template: string, vars: Record<string, string>, json: boolean) {
  return template.replace(/\{(to|text|sender|key|username)\}/g, (_m, k: string) => (json ? jsonEscape(vars[k] ?? '') : encodeURIComponent(vars[k] ?? '')));
}

/** SMS text is kept short: one or two SMS parts. */
export const smsText = (t: string) => (t.length > 300 ? `${t.slice(0, 297)}...` : t);

export async function sendSms(s: SmsSettings, to: string, text: string, fetchFn: typeof fetch = fetch) {
  const phone = normalisePhone(to);
  const key = getSecret(s.secretRef) ?? '';
  const msg = smsText(text);
  let url: string; const init: RequestInit = { method: 'POST', headers: {} as Record<string, string>, signal: AbortSignal.timeout(20_000) };
  const headers = init.headers as Record<string, string>;
  if (s.provider === 'android-gateway') {
    // "SMS Gateway for Android" (local server mode): POST <phone address>/message, basic authentication with the
    // user name and password shown in the app.
    url = `${s.url.replace(/\/+$/, '')}/message`;
    headers['content-type'] = 'application/json';
    headers.authorization = `Basic ${Buffer.from(`${s.username}:${key}`).toString('base64')}`;
    init.body = JSON.stringify({ message: msg, phoneNumbers: [phone] });
  } else if (s.provider === 'africastalking') {
    url = s.url || 'https://api.africastalking.com/version1/messaging';
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers.accept = 'application/json';
    headers.apiKey = key;
    const f = new URLSearchParams({ username: s.username, to: phone, message: msg });
    if (s.sender) f.set('from', s.sender);
    init.body = f.toString();
  } else {
    url = s.url;
    const json = s.contentType === 'json';
    headers['content-type'] = json ? 'application/json' : 'application/x-www-form-urlencoded';
    const vars = { to: phone, text: msg, sender: s.sender, key, username: s.username };
    init.body = fill(s.bodyTemplate, vars, json);
    const h = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(s.authHeader.trim());
    if (h && key) headers[h[1]!.toLowerCase()] = h[2]!.replace('{key}', key);
  }
  const r = await fetchFn(url, init);
  const body = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`SMS gateway answered ${r.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
  if (s.provider === 'africastalking' && /"status"\s*:\s*"(?!Success)/.test(body) && !/Success/.test(body)) throw new Error(`Africa's Talking: ${body.slice(0, 160)}`);
}

/** For the message log: never keep full addresses. */
export function maskRecipient(channel: 'email' | 'sms', v: string) {
  if (channel === 'email') { const [u, d] = v.split('@'); return `${(u ?? '').slice(0, 2)}***@${d ?? ''}`; }
  return v.length > 6 ? `${v.slice(0, 4)}*****${v.slice(-3)}` : '***';
}
