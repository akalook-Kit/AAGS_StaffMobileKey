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
