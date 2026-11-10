/**
 * Access Monitoring Tool gateway: the only part of an on-premises installation that listens on the network.
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
 * run Credential Services in polling mode). 2.16: when the connector runs on another computer of the hotel
 * network, the "lan" listener lets that computer's address (and only it, `connectorFrom`) reach the connector
 * API; the connector still signs in with its own token. Everything else is forwarded unchanged to the platform.
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
  /** 2.16 Addresses (or ranges) of a connector on another computer, allowed to use the connector API on this
   *  listener. Never on a listener that needs the secret path (the outside entrance). Default: none. */
  connectorFrom?: string[];
  /** 2.20 Cloudflare Tunnel entrance: the address of the real visitor is in this header (cf-connecting-ip), set by
   *  cloudflared. Only allowed on a listener bound to 127.0.0.1 / ::1 that admits loopback only, so the header cannot be
   *  forged from the network. Used for the log, the ban list and x-forwarded-for. */
  clientIpHeader?: string;
  /** 2.20 The visitor reaches this listener over https elsewhere (Cloudflare's edge): Secure cookies and HSTS. */
  publicHttps?: boolean;
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
  // 2.24 Reachable from the internet (tunnel / public address): search engines must not list the portal.
  'x-robots-tag': 'noindex, nofollow',
  'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

/** Checks a configuration without starting anything (set-external-access.ps1 runs it before saving). */
export function checkGatewayConfig(cfg: GatewayConfig) {
  if (!/^\/[A-Za-z0-9_-]{20,}$/.test(cfg.secretPath ?? '')) throw new Error('secretPath must be "/" followed by at least 20 letters, digits, - or _.');
  if (!Array.isArray(cfg.listeners) || !cfg.listeners.length) throw new Error('No listeners.');
  const ports = new Set<number>();
  for (const l of cfg.listeners) {
    if (!Number.isInteger(l.port) || l.port < 0 || l.port > 65535) throw new Error(`${l.name}: port ${l.port} is not valid.`);
    if (l.port && ports.has(l.port)) throw new Error(`Port ${l.port} is used twice.`);
    ports.add(l.port);
    if (!Array.isArray(l.allow) || !l.allow.length) throw new Error(`${l.name}: the allow-list is empty.`);
    compileAllow(l.allow);
    if (l.clientIpHeader) {
      const loop = ['127.0.0.1', '::1', 'localhost'];
      if (!/^[a-z0-9-]{2,40}$/i.test(l.clientIpHeader)) throw new Error(`${l.name}: clientIpHeader is not a header name.`);
      if (!loop.includes(l.host) || l.allow.some((a) => !/^(127\.0\.0\.1(\/32)?|::1(\/128)?)$/.test(a))) throw new Error(`${l.name}: clientIpHeader is only for a listener on 127.0.0.1 that admits 127.0.0.1 / ::1 only (the tunnel agent on this machine).`);
      if (l.connectorFrom?.length) throw new Error(`${l.name}: the tunnel entrance cannot serve a connector.`);
    }
    if (l.connectorFrom?.length) {
      if (l.requireSecretPath) throw new Error(`${l.name}: a connector cannot use the outside entrance (connectorFrom on a listener with the secret path).`);
      if (l.connectorFrom.includes('private') || l.connectorFrom.some((r) => /\/(0|[1-9])$/.test(r))) throw new Error(`${l.name}: connectorFrom must list the connector computer's own address (or a small range), not "private".`);
      compileAllow(l.connectorFrom);
    }
  }
  return true;
}

export function startGateway(cfg: GatewayConfig, env: NodeJS.ProcessEnv = process.env) {
  checkGatewayConfig(cfg);
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
    const connectorOk = l.connectorFrom?.length && !l.requireSecretPath ? compileAllow(l.connectorFrom) : () => false;
    const secure = Boolean(l.tls) || Boolean(l.publicHttps);
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const t0 = Date.now();
      const sockIp = req.socket.remoteAddress ?? '?';
      // 2.20 Behind the tunnel every request comes from cloudflared on this machine: take the visitor's address from
      // its header (checked to be an address), so one visitor's misses never ban everybody.
      const hdr = l.clientIpHeader ? String(req.headers[l.clientIpHeader.toLowerCase()] ?? '').split(',')[0]!.trim() : '';
      const ip = hdr && net.isIP(hdr) ? hdr : sockIp;
      const url = req.url ?? '/';
      const path = url.split('?')[0]!;
      const done = (status: number, note = '') => log(`${l.name} ${ip} ${req.method} ${path.startsWith(cfg.secretPath) ? '/<secret>' + path.slice(cfg.secretPath.length) : path} ${status} ${Date.now() - t0}ms${note ? ' ' + note : ''}`);
      const deny = (status = 404) => { res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store', ...SECURITY_HEADERS }); res.end(status === 404 ? 'Not found' : ''); done(status, 'denied'); };
      if (!allowed(sockIp) || banned(ip)) { req.socket.destroy(); return; }
      if (l.clientIpHeader && ip === sockIp) { res.writeHead(400, { 'content-type': 'text/plain', ...SECURITY_HEADERS }); res.end('Bad request'); done(400, 'no visitor address from the tunnel'); return; }

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
      // Never from outside: the connector runs on this machine (or on a listed computer of the hotel network);
      // Credential Services is polled, not called back.
      if (/^\/connector\//.test(tpath) && !connectorOk(ip)) return deny();
      if (/^\/integrations\//.test(tpath)) return deny();
      if (l.mobileApi === false && tpath.startsWith('/mobile/')) return deny();
      // Opening the secret path itself: hand out the pass and go to the portal. 2.20 Also for a page under it (e.g. an
      // invitation link /<secret>/invite#…): pass, then the page itself (the browser keeps the #… part).
      const pageUnderSecret = setPass && req.method === 'GET' && !/^\/(api|mobile|connector|integrations|assets)\//.test(tpath) && !/\.[a-z0-9]{1,5}$/i.test(tpath);
      if (pageUnderSecret) {
        const loc = tpath === '' ? '/' : target;
        res.writeHead(302, { location: /^\/(?![\/\\])[^\r\n]*$/.test(loc) ? loc : '/', 'set-cookie': `${COOKIE}=${passFor(key, hours)}; Path=/; Max-Age=${hours * 3600}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
        res.end(); done(302, 'pass issued'); return;
      }
      const headers = { ...req.headers };
      delete headers['x-forwarded-for']; delete headers['x-real-ip']; delete headers['forwarded'];
      headers['x-forwarded-for'] = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
      headers['x-forwarded-proto'] = secure ? 'https' : 'http';
      // 2.33 Which listener the request came in on (the platform allows open access only on "lan"); never from the client.
      delete headers['x-smk-listener']; headers['x-smk-listener'] = l.name;
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
    server.listen(l.port, l.host, () => log(`listening ${l.name} ${secure ? 'https' : 'http'}://${l.host}:${l.port} allow=${l.allow.join(',')}${l.requireSecretPath ? ' secret-path=yes' : ''}${l.connectorFrom?.length && !l.requireSecretPath ? ` connector-from=${l.connectorFrom.join(',')}` : ''}`));
    servers.push(server);
  }
  return { close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null))))), servers };
}

// CLI: node gateway.mjs (GATEWAY_CONFIG=path)
if (/[\\/]gateway\.(ts|mjs)$/.test(process.argv[1] ?? '')) {
  const file = process.env.GATEWAY_CONFIG ?? join(dirname(process.argv[1] ?? '.'), 'gateway.config.json');
  const checkOnly = process.argv.includes('--check');
  const target = checkOnly ? (process.argv[process.argv.indexOf('--check') + 1] ?? file) : file;
  const cfg = JSON.parse(readFileSync(target, 'utf8').replace(/^\uFEFF/, '')) as GatewayConfig;
  if (checkOnly) {
    try { checkGatewayConfig(cfg); console.log('gateway configuration OK'); process.exit(0); } catch (e) { console.error(`gateway configuration invalid: ${(e as Error).message}`); process.exit(1); }
  }
  const g = startGateway(cfg);
  const stop = () => { void g.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  if (process.env.SMK_SERVICE_STDIN_SHUTDOWN === '1') { process.stdin.resume(); process.stdin.on('end', stop); }
}
