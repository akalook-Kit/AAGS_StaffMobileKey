/**
 * Staff Mobile Key gateway: the only part of an on-premises installation that listens on the network.
 * The platform itself listens on 127.0.0.1 only; the gateway forwards to it.
 *
 * Two kinds of entrance, each its own listener:
 *  - "lan": the hotel's own network (staff PCs, staff phones on hotel Wi-Fi). Allowed: private address ranges.
 *  - "external": the hotel's public IP, forwarded by the hotel firewall to this server. Three locks, all needed:
 *      1. the source address must be on the allow-list (the hotel's own offices / VPN); anything else is dropped
 *         before TLS, without an answer;
 *      2. the request must start with the secret path (e.g. /k-3f9c…/), or carry the pass cookie that the secret
 *         path hands out; anything else gets an empty 404, and repeated misses ban the address for a while;
 *      3. then the normal portal sign-in (with two-step sign-in).
 * The connector API and Credential Services callbacks are never reachable from outside (on-premises installs
 * run Credential Services in polling mode). Everything else is forwarded unchanged to the platform.
 *
 * Node.js built-ins only. Config: GATEWAY_CONFIG (JSON file, see gateway.config.template.json).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { dirname, join } from 'node:path';

export interface ListenerConfig {
  name: string;
  host: string;
  port: number;
  /** PFX file (+ passphrase from the environment variable named here) or PEM cert/key. Omit for plain HTTP (LAN tests only). */
  tls?: { pfx?: string; passphraseEnv?: string; cert?: string; key?: string } | null;
  /** IPv4/IPv6 addresses or CIDR ranges allowed to connect. "private" = 10/8, 172.16/12, 192.168/16, 127/8, fc00::/7, ::1. */
  allow: string[];
  /** Require the secret path (or its pass cookie) before anything is forwarded. */
  requireSecretPath: boolean;
  /** Allow the staff app API (/mobile/...). Default true. */
  mobileApi?: boolean;
}
export interface GatewayConfig {
  upstream: string;            // http://127.0.0.1:4000
  secretPath: string;          // "/k-<at least 20 random characters>"
  cookieKeyEnv?: string;       // environment variable holding the key that signs pass cookies (generated if absent)
  passHours?: number;          // how long a pass cookie lasts (default 12)
  listeners: ListenerConfig[];
  logFile?: string;
  banAfter?: number;           // misses before an address is banned (default 20 in 10 minutes)
  banMinutes?: number;         // default 30
}

// ---- address matching ------------------------------------------------------------------------------------
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', 'fc00::/7', '::1/128', 'fe80::/10'];
function toBytes(ip: string): Buffer | null {
  const v4 = ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) return Buffer.from(v4.split('.').map(Number));
  if (!net.isIPv6(ip)) return null;
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return b;
}
export function compileAllow(list: string[]) {
  const rules = list.flatMap((r) => (r === 'private' ? PRIVATE : [r])).map((r) => {
    const [addr, bits] = r.split('/');
    const b = toBytes(addr!.trim());
    if (!b) throw new Error(`Not an address or range: ${r}`);
    return { b, bits: bits === undefined ? b.length * 8 : Number(bits) };
  });
  return (ip: string | undefined) => {
    const x = ip ? toBytes(ip) : null;
    if (!x) return false;
    return rules.some(({ b, bits }) => {
      if (b.length !== x.length) return false;
      for (let i = 0; i < bits; i++) if (((b[i >> 3]! >> (7 - (i & 7))) & 1) !== ((x[i >> 3]! >> (7 - (i & 7))) & 1)) return false;
      return true;
    });
  };
}

// ---- pass cookie --------------------------------------------------------------------------------------------
const COOKIE = 'smk_gw';
function passFor(key: Buffer, hours: number) {
  const exp = Math.floor(Date.now() / 1000) + hours * 3600;
  return `${exp}.${createHmac('sha256', key).update(String(exp)).digest('base64url')}`;
}
function passValid(key: Buffer, cookieHeader: string | undefined) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9]+)\\.([A-Za-z0-9_-]+)`).exec(cookieHeader ?? '');
  if (!m) return false;
  if (Number(m[1]) < Date.now() / 1000) return false;
  const want = Buffer.from(createHmac('sha256', key).update(m[1]!).digest('base64url'));
  const got = Buffer.from(m[2]!);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ---- logging (no query strings, never the secret path) -------------------------------------------------------
function logger(file: string | undefined) {
  return (line: string) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    if (!file) { process.stdout.write(text); return; }
    try {
      if (existsSync(file) && statSync(file).size > 10 * 1024 * 1024) {
        for (let i = 4; i >= 1; i--) { const a = `${file}.${i}`, b = i === 1 ? file : `${file}.${i - 1}`; if (existsSync(a)) unlinkSync(a); if (existsSync(b)) renameSync(b, a); }
      }
      appendFileSync(file, text);
    } catch { process.stdout.write(text); }
  };
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

export function startGateway(cfg: GatewayConfig, env: NodeJS.ProcessEnv = process.env) {
  if (!/^\/[A-Za-z0-9_-]{20,}$/.test(cfg.secretPath)) throw new Error('secretPath must be "/" followed by at least 20 letters, digits, - or _.');
  const up = new URL(cfg.upstream);
  if (!['127.0.0.1', 'localhost', '::1'].includes(up.hostname)) throw new Error('upstream must be the platform on this machine (127.0.0.1).');
  const key = cfg.cookieKeyEnv && env[cfg.cookieKeyEnv] ? Buffer.from(env[cfg.cookieKeyEnv]!, 'utf8') : randomBytes(32);
  const hours = cfg.passHours ?? 12;
  const log = logger(cfg.logFile);
  const banAfter = cfg.banAfter ?? 20, banMs = (cfg.banMinutes ?? 30) * 60_000;
  const misses = new Map<string, { n: number; first: number; bannedUntil?: number }>();
  const banned = (ip: string) => { const m = misses.get(ip); return Boolean(m?.bannedUntil && m.bannedUntil > Date.now()); };
  const miss = (ip: string) => {
    const now = Date.now();
    const m = misses.get(ip) ?? { n: 0, first: now };
    if (now - m.first > 10 * 60_000) { m.n = 0; m.first = now; }
    m.n++;
    if (m.n >= banAfter) { m.bannedUntil = now + banMs; log(`ban ${ip} for ${banMs / 60_000} min after ${m.n} misses`); }
    misses.set(ip, m);
  };
  setInterval(() => { const now = Date.now(); for (const [ip, m] of misses) if ((m.bannedUntil ?? 0) < now && now - m.first > 10 * 60_000) misses.delete(ip); }, 60_000).unref();

  const servers: (http.Server | https.Server)[] = [];
  for (const l of cfg.listeners) {
    const allowed = compileAllow(l.allow);
    const secure = Boolean(l.tls);
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const t0 = Date.now();
      const ip = req.socket.remoteAddress ?? '?';
      const url = req.url ?? '/';
      const path = url.split('?')[0]!;
      const done = (status: number, note = '') => log(`${l.name} ${ip} ${req.method} ${path.startsWith(cfg.secretPath) ? '/<secret>' + path.slice(cfg.secretPath.length) : path} ${status} ${Date.now() - t0}ms${note ? ' ' + note : ''}`);
      const deny = (status = 404) => { res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store', ...SECURITY_HEADERS }); res.end(status === 404 ? 'Not found' : ''); done(status, 'denied'); };
      if (!allowed(ip) || banned(ip)) { req.socket.destroy(); return; }

      let target = url;
      let setPass = false;
      if (l.requireSecretPath) {
        if (path === cfg.secretPath || path.startsWith(cfg.secretPath + '/')) {
          target = url.slice(cfg.secretPath.length) || '/';
          if (!target.startsWith('/')) target = '/' + target;
          setPass = true;
        } else if (!passValid(key, req.headers.cookie)) { miss(ip); return deny(); }
      }
      const tpath = target.split('?')[0]!;
      // Never from outside: the connector runs on this machine; Credential Services is polled, not called back.
      if (/^\/(connector|integrations)\//.test(tpath)) return deny();
      if (l.mobileApi === false && tpath.startsWith('/mobile/')) return deny();
      // Opening the secret path itself: hand out the pass and go to the portal.
      if (setPass && (tpath === '/' || tpath === '') && req.method === 'GET') {
        res.writeHead(302, { location: '/', 'set-cookie': `${COOKIE}=${passFor(key, hours)}; Path=/; Max-Age=${hours * 3600}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
        res.end(); done(302, 'pass issued'); return;
      }
      const headers = { ...req.headers };
      delete headers['x-forwarded-for']; delete headers['x-real-ip']; delete headers['forwarded'];
      headers['x-forwarded-for'] = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
      headers['x-forwarded-proto'] = secure ? 'https' : 'http';
      headers.host = up.host;
      const preq = http.request({ hostname: up.hostname, port: up.port || 80, method: req.method, path: target, headers }, (pres) => {
        const h: Record<string, any> = { ...pres.headers, ...SECURITY_HEADERS };
        if (secure) h['strict-transport-security'] = 'max-age=31536000';
        if (setPass) {
          const c = `${COOKIE}=${passFor(key, hours)}; Path=/; Max-Age=${hours * 3600}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
          h['set-cookie'] = [...(Array.isArray(h['set-cookie']) ? h['set-cookie'] : h['set-cookie'] ? [h['set-cookie']] : []), c];
        }
        res.writeHead(pres.statusCode ?? 502, h);
        pres.pipe(res);
        pres.on('end', () => done(pres.statusCode ?? 0));
      });
      preq.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain', ...SECURITY_HEADERS }); res.end('The platform is not answering.'); } done(502, e.message); });
      req.pipe(preq);
      res.on('close', () => preq.destroy());
    };
    let server: http.Server | https.Server;
    if (l.tls) {
      const opts: https.ServerOptions = { minVersion: 'TLSv1.2' };
      if (l.tls.pfx) { opts.pfx = readFileSync(l.tls.pfx); opts.passphrase = l.tls.passphraseEnv ? env[l.tls.passphraseEnv] : undefined; }
      else { opts.cert = readFileSync(l.tls.cert!); opts.key = readFileSync(l.tls.key!); }
      server = https.createServer(opts, handler);
    } else server = http.createServer(handler);
    // Drop addresses that are not allowed (or banned) before any TLS handshake: no answer at all.
    server.on('connection', (sock: net.Socket) => { if (!allowed(sock.remoteAddress) || banned(sock.remoteAddress ?? '')) sock.destroy(); });
    server.headersTimeout = 30_000;
    server.requestTimeout = 0; // staff app and connector use long polls
    server.keepAliveTimeout = 30_000;
    server.on('clientError', (_e, sock) => sock.destroy());
    server.listen(l.port, l.host, () => log(`listening ${l.name} ${secure ? 'https' : 'http'}://${l.host}:${l.port} allow=${l.allow.join(',')}${l.requireSecretPath ? ' secret-path=yes' : ''}`));
    servers.push(server);
  }
  return { close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null))))), servers };
}

// CLI: node gateway.mjs (GATEWAY_CONFIG=path)
if (/[\\/]gateway\.(ts|mjs)$/.test(process.argv[1] ?? '')) {
  const file = process.env.GATEWAY_CONFIG ?? join(dirname(process.argv[1] ?? '.'), 'gateway.config.json');
  const cfg = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as GatewayConfig;
  const g = startGateway(cfg);
  const stop = () => { void g.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  if (process.env.SMK_SERVICE_STDIN_SHUTDOWN === '1') { process.stdin.resume(); process.stdin.on('end', stop); }
}
