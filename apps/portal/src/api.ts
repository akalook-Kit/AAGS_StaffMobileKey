import { sealInBrowser } from '@smk/shared';
// Thin API client. The token lives in sessionStorage (cleared when the tab closes) — never localStorage.
const KEY = 'smk.token';
export const auth = {
  get token() { try { return sessionStorage.getItem(KEY); } catch { return null; } },
  set(t: string | null) { try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* private mode */ } },
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const r = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}), ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await r.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (r.status === 401 && path !== '/api/v1/auth/login') { auth.set(null); window.dispatchEvent(new Event('smk:signed-out')); }
  if (!r.ok) throw new ApiError(r.status, json?.error?.code ?? 'ERROR', json?.error?.message ?? `Request failed (${r.status})`, json?.error?.details);
  return json as T;
}

export async function download(path: string, filename: string) {
  const r = await fetch(path, { headers: { authorization: `Bearer ${auth.token}` } });
  if (!r.ok) throw new ApiError(r.status, 'ERROR', 'Download failed');
  const url = URL.createObjectURL(await r.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Encrypts a Visionline username/password in this browser for the hotel connector (RSA-OAEP + AES-GCM).
 * The platform stores and forwards only the sealed blob; only the connector on the Visionline PC can open it.
 */
export async function sealCredential(base: string, hotelId: string, purpose: 'property' | 'operator', username: string, password: string, operatorId?: string, accessId?: string) {
  if (!window.isSecureContext || !window.crypto?.subtle) throw new ApiError(0, 'INSECURE_CONTEXT', 'Open the portal via http://localhost or https:// to enter Visionline passwords (the browser only encrypts on secure pages).');
  const k = await api<{ keyId: string; publicKey: string }>(`${base}/connector/sealing-key`);
  const plain = JSON.stringify({ purpose, hotelId, operatorId, username, password, ...(accessId ? { accessId } : {}), ts: new Date().toISOString() });
  return sealInBrowser(window.crypto, k.publicKey, k.keyId, plain);
}

/**
 * 2.34 Save a table as a CSV file that opens in Excel (the lock register, the day report). A byte-order mark keeps the
 * accents; French Excel expects ";" between columns.
 */
export function saveCsv(head: string[], rows: (string | number | null | undefined)[][], filename: string, sep = (document.documentElement.lang || '').startsWith('fr') ? ';' : ',') {
  const cell = (v: string | number | null | undefined) => { const s = v == null ? '' : String(v); return /["\n\r;,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const text = '﻿' + [head, ...rows].map((r) => r.map(cell).join(sep)).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 2.34 A photo for upload: images wider than 1600 px are made smaller (JPEG) so they stay well under 3 MB. */
export async function photoDataUrl(file: File): Promise<string> {
  const raw = await new Promise<string>((ok, ko) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => ko(r.error); r.readAsDataURL(file); });
  if (!/^data:image\/(png|jpeg|webp)/.test(raw)) throw new ApiError(400, 'FILE_TYPE', 'Attach a photo or screenshot (PNG, JPEG or WebP).');
  const img = await new Promise<HTMLImageElement>((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new ApiError(400, 'FILE_TYPE', 'This file is not a valid image.')); i.src = raw; });
  if (img.width <= 1600 && raw.length < 2_500_000) return raw;
  const k = Math.min(1, 1600 / img.width);
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

/** 2.34 An image the server sends only with the session token, as a URL the page can show. */
export async function blobUrl(path: string) {
  const r = await fetch(path, { headers: auth.token ? { authorization: `Bearer ${auth.token}` } : {} });
  if (!r.ok) throw new ApiError(r.status, 'ERROR', 'Download failed');
  return URL.createObjectURL(await r.blob());
}

/** 2.34 Light edition: the Visionline account encrypted with the key the connector published (no settings page). */
export async function sealWithKey(key: { keyId: string; publicKey: string }, hotelId: string, username: string, password: string) {
  if (!window.isSecureContext || !window.crypto?.subtle) throw new ApiError(0, 'INSECURE_CONTEXT', 'Open the portal on the server itself (http://localhost) or with https:// to enter the Visionline password (the browser only encrypts on secure pages).');
  return sealInBrowser(window.crypto, key.publicKey, key.keyId, JSON.stringify({ purpose: 'property', hotelId, username, password, ts: new Date().toISOString() }));
}

export interface LightConnection {
  hotelName: string | null; state: 'no-connector' | 'connector-offline' | 'needs-account' | 'visionline-unreachable' | 'connected'; connected: boolean;
  connector: { online: boolean; lastSeen: string | null; version: string | null } | null;
  visionline: { url: string | null; reachable: boolean; username: string | null; lastError: string | null };
  sealingKey: { keyId: string; publicKey: string } | null; doors: number;
  discovery: { status: string; error: string | null; at: string } | null;
  lastAccount: { commandId: string; status: string; error: string | null; at: string } | null;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * 2.34 Give the Visionline account to the connector and wait until it answers: waits for the connector's key (it
 * starts with the server), encrypts the password here, sends it, then follows the connector's test.
 */
export async function connectVisionline(hotelId: string, username: string, password: string, step: (s: string) => void) {
  const base = `/api/v1/hotels/${hotelId}`;
  let c = await api<LightConnection>(`${base}/light/connection`);
  for (let i = 0; !c.sealingKey && i < 40; i++) { step('Waiting for the connector on this server to start…'); await wait(3000); c = await api<LightConnection>(`${base}/light/connection`); }
  if (!c.sealingKey) throw new ApiError(0, 'CONNECTOR_NOT_READY', 'The connector on this server has not started. Restart the server (or the "Access Monitoring Tool" services) and try again.');
  step('Encrypting the password in this browser…');
  const sealed = await sealWithKey(c.sealingKey, hotelId, username, password);
  const { commandId } = await api<{ commandId: string }>(`${base}/light/connection`, { method: 'PUT', body: { username, sealed } });
  step('Testing the account with Visionline…');
  for (let i = 0; i < 100; i++) {
    await wait(3000);
    const r = await api<{ status: string; error: string | null }>(`${base}/light/connection/${commandId}`);
    if (r.status === 'SUCCEEDED') { step('Connected. Reading the doors…'); return; }
    if (r.status === 'FAILED' || r.status === 'EXPIRED') throw new ApiError(400, 'VISIONLINE_ACCOUNT', r.error || (r.status === 'EXPIRED' ? 'The connector did not answer in time. Check that its service is running, then try again.' : 'Visionline did not accept this account.'));
  }
  throw new ApiError(0, 'TIMEOUT', 'The connector did not answer in time. Check that its service is running, then try again.');
}
