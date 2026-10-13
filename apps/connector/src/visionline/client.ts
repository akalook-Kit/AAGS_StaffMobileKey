import https from 'node:https';
import { readFileSync } from 'node:fs';
import { visionlineTrust } from './trust.ts';
import { VL, contentMd5, sign, authorizationHeader, type VisionlineError } from '@smk/shared/node';

/**
 * Low-level Visionline Web API client [Web API 61 1100 080 rev 74].
 * - HTTPS, TLS 1.2+, certificate ALWAYS verified against the configured trust (CA file and/or SHA-256 pin) [§1, spec §12.1.1]
 * - Session creation [§5.24] with optional accessID + stable client uuid [§7.1.2]
 * - Every other request signed with HMAC-SHA1 [§4.5]
 * - 40101 clock skew: adopt the server Date and resend [§4.5.7]; 40103 expired session: new session and resend once [§4.6]
 *   Both responses mean "request not carried out" [§3.2], so resending is safe.
 * - Unknown response properties are ignored [§4.7]
 * Secrets (password, access key, signatures) are never logged.
 */
export class VisionlineApiError extends Error {
  constructor(public status: number, public code: number | undefined, message: string, public developerMessage?: string, public notSent = false) { super(message); }
}

export interface VlTrust { caFile?: string; pinSha256?: string; servername?: string }
export interface VlCredentials { username: string; password: string; accessId?: string; clientUuid: string }

export class VisionlineClient {
  private agent: https.Agent;
  private base: URL;
  private session: { id: string; accessKey: string } | null = null;
  private sessionPromise: Promise<void> | null = null;
  skewMs = 0;
  lastSessionAt: string | null = null;
  tlsState = 'unknown';
  trustMode: 'ca' | 'exact' | 'system' = 'system';

  constructor(baseUrl: string, private trust: VlTrust, private creds: () => VlCredentials | null) {
    this.base = new URL(baseUrl.replace(/\/$/, ''));
    if (this.base.protocol !== 'https:') throw new Error('Visionline Web API must be reached over HTTPS');
    const t = visionlineTrust(trust.caFile ? readFileSync(trust.caFile) : undefined, { servername: trust.servername, pinSha256: trust.pinSha256 });
    this.trustMode = t.mode;
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 4, minVersion: 'TLSv1.2', servername: trust.servername, ...t.tlsOptions } as https.AgentOptions);
  }

  private raw(method: string, path: string, body?: unknown, signed = true, timeoutMs = 30_000): Promise<{ status: number; json: any; date: string | undefined }> {
    const json = body === undefined ? undefined : JSON.stringify(body);
    const url = this.base.pathname + path; // e.g. /api/v1/cards?action=mobileAccess
    const headers: Record<string, string> = { date: new Date(Date.now() + this.skewMs).toUTCString(), accept: 'application/json' };
    if (json !== undefined) {
      headers['content-type'] = VL.contentType;
      headers['content-md5'] = contentMd5(json);
      headers['content-length'] = String(Buffer.byteLength(json));
    }
    if (signed) {
      if (!this.session) throw new VisionlineApiError(401, VL.errors.sessionNotFound, 'No session', undefined, true);
      const sig = sign(this.session.accessKey, { method, contentMd5: headers['content-md5'], contentType: headers['content-type'], date: headers.date, url });
      headers.authorization = authorizationHeader(this.session.id, sig);
    }
    return new Promise((resolve, reject) => {
      const req = https.request({ protocol: 'https:', hostname: this.base.hostname, port: this.base.port || 443, method, path: url, headers, agent: this.agent, timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          this.tlsState = this.trustMode === 'exact' ? 'verified (exact certificate)' : 'verified';
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: any = {};
          try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { message: text.slice(0, 200) }; }
          resolve({ status: res.statusCode ?? 0, json: parsed, date: res.headers.date });
        });
      });
      req.on('timeout', () => req.destroy(new Error('Visionline request timed out')));
      req.on('error', (e: NodeJS.ErrnoException) => {
        if (/certificate|self.signed|fingerprint|altnames|CERT_/i.test(e.message + (e.code ?? ''))) this.tlsState = `failed: ${e.message}`;
        // A connection that was never established cannot have reached Visionline: safe to retry.
        const notSent = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH'].includes(e.code ?? '') || this.tlsState.startsWith('failed');
        reject(new VisionlineApiError(0, undefined, `Visionline unreachable: ${e.message}`, undefined, notSent));
      });
      if (json !== undefined) req.write(json);
      req.end();
    });
  }

  private async createSession() {
    const c = this.creds();
    if (!c) throw new VisionlineApiError(0, undefined, 'Visionline operator credentials are not configured', undefined, true);
    const body: Record<string, string> = { [VL.fields.username]: c.username, [VL.fields.password]: c.password };
    if (c.accessId) { body[VL.fields.accessId] = c.accessId; body[VL.fields.clientUuid] = c.clientUuid; }
    for (let i = 0; i < 2; i++) {
      const r = await this.raw('POST', VL.paths.sessions, body, false);
      if (r.status === 201 || r.status === 200) {
        this.session = { id: String(r.json[VL.fields.sessionId]), accessKey: String(r.json[VL.fields.accessKey]) };
        this.lastSessionAt = new Date().toISOString();
        return;
      }
      if (r.json?.code === VL.errors.clockSkew && r.date) { this.adoptServerTime(r.date); continue; }
      throw new VisionlineApiError(r.status, r.json?.code, r.json?.message ?? `HTTP ${r.status}`, r.json?.developerMessage, true);
    }
  }

  private adoptServerTime(serverDate: string) {
    const t = Date.parse(serverDate);
    if (Number.isFinite(t)) this.skewMs = t - Date.now();
  }

  private async ensureSession() {
    if (this.session) return;
    this.sessionPromise ??= this.createSession().finally(() => { this.sessionPromise = null; });
    await this.sessionPromise;
  }

  /** Signed request with the reference implementation's recovery loop (at most 3 sends) [§6.1]. */
  async request<T = any>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    let last: { status: number; json: VisionlineError } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.ensureSession();
      const r = await this.raw(method, path, body, true, opts.timeoutMs);
      if (r.date) { const t = Date.parse(r.date); if (Number.isFinite(t) && Math.abs(t - Date.now() - this.skewMs) > 60_000) this.adoptServerTime(r.date); }
      if (r.status >= 200 && r.status < 300) return r.json as T;
      last = { status: r.status, json: r.json };
      if (r.status === 401 && r.json?.code === VL.errors.clockSkew && r.date) { this.adoptServerTime(r.date); continue; }
      if (r.status === 401 && r.json?.code === VL.errors.sessionNotFound) { this.session = null; continue; }
      break;
    }
    const j = last!.json;
    throw new VisionlineApiError(last!.status, j?.code, j?.message ?? `HTTP ${last!.status}`, j?.developerMessage);
  }

  /** Forget the session (e.g. after operator credentials change). */
  reset() { this.session = null; }

  /** Terminate the session explicitly when no longer needed [§7.1.5]. */
  async close() {
    if (this.session) { try { await this.raw('DELETE', VL.paths.session(this.session.id)); } catch { /* ignore */ } this.session = null; }
    this.agent.destroy();
  }
}
