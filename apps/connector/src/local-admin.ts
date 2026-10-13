import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Connector } from './connector.ts';

/**
 * Local administration page (spec §12.1.1, §13.4.5): health/diagnostics and the setup form.
 * - Binds to 127.0.0.1 by default: reachable only on the Visionline PC itself.
 * - Protected by a local admin password (Basic auth).
 * - Password fields write straight into the encrypted secret store and are never shown again.
 */
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function page(c: Connector, msg = '') {
  const h = c.health();
  const row = (k: string, v: unknown, ok?: boolean) => `<tr><th>${esc(k)}</th><td class="${ok === undefined ? '' : ok ? 'ok' : 'bad'}">${esc(v)}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hotel Connector</title><style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#f5f3ef;color:#1c1a17}header{background:#050505;color:#DCAE99;padding:14px 20px}
h1{font-size:16px;margin:0}main{max-width:820px;margin:0 auto;padding:16px}section{background:#fff;border:1px solid #e2ddd3;border-radius:8px;padding:14px 16px;margin-bottom:14px}
h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6d665b;margin:0 0 8px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:5px 6px;border-bottom:1px solid #f0ece5;vertical-align:top}
th{width:42%;font-weight:500;color:#4a453d}.ok{color:#11703a;font-weight:600}.bad{color:#a3261b;font-weight:600}
label{display:block;margin:8px 0 2px;font-weight:500}input{font:inherit;padding:6px 8px;width:100%;box-sizing:border-box;border:1px solid #cfc8bb;border-radius:6px}
button{margin-top:12px;font:inherit;padding:7px 14px;border-radius:6px;border:0;background:#050505;color:#DCAE99;cursor:pointer}.msg{padding:8px 12px;background:#e7f3ec;border-radius:6px;margin-bottom:12px}
small{color:#6d665b}</style></head><body><header><h1>Hotel connector · ${esc(c.hotel?.name ?? 'not connected')}</h1></header><main>
${msg ? `<div class="msg">${esc(msg)}</div>` : ''}
<section><h2>Health</h2><table>
${row('Overall', h.status, h.status === 'OK')}
${row('Platform connection', c.platformReachable ? `connected (last contact ${c.lastPlatformContact})` : 'not connected', c.platformReachable)}
${row('Visionline Web API', `${c.cfg.visionline.baseUrl} — ${h.visionlineReachable ? 'reachable' : 'not reachable'}`, h.visionlineReachable)}
${row('Certificate trust', h.tlsTrust, String(h.tlsTrust ?? '').startsWith('verified'))}
${row('Operator credentials stored', h.credentialsConfigured ? 'yes (encrypted)' : 'no', h.credentialsConfigured)}
${row('Last Visionline session', h.lastSuccessfulSessionAt ?? 'never')}
${row('Clock offset to Visionline', `${Math.round(h.clockOffsetMs / 1000)} s`, Math.abs(h.clockOffsetMs) < 300_000)}
${row('Queue depth / in flight', `${h.queueDepth} / ${h.inFlight}`)}
${row('Last error', h.lastError ?? 'none', !h.lastError)}
${row('Adapter', h.adapter)}${row('Versions', `connector ${h.connectorVersion}, contract ${h.contractVersion}`)}${row('Installation UUID', c.installationUuid)}
</table></section>
<section><h2>Setup</h2><form method="post" action="/setup">
<small>Values are encrypted on this computer. Leave a field empty to keep the stored value. Stored passwords are never displayed.</small>
<label>Platform connector token</label><input name="platformToken" type="password" autocomplete="off" placeholder="${c.secrets.has('platformToken') ? '•••••• stored' : 'paste the token from the portal'}">
<label>Visionline Web API operator name</label><input name="vlUsername" autocomplete="off" placeholder="${c.secrets.has('vlUsername') ? '•••••• stored' : ''}">
<label>Visionline operator password</label><input name="vlPassword" type="password" autocomplete="off" placeholder="${c.secrets.has('vlPassword') ? '•••••• stored' : ''}">
<label>Visionline access ID (web client, optional)</label><input name="vlAccessId" type="password" autocomplete="off" placeholder="${c.secrets.has('vlAccessId') ? '•••••• stored' : 'optional'}">
<button type="submit">Save and test</button></form></section>
<section><h2>Diagnostics</h2><small>Machine-readable health: <a href="/health.json">/health.json</a>. Contains no secrets.</small></section>
</main></body></html>`;
}

export function startLocalAdmin(c: Connector) {
  const adminPw = () => c.secrets.get('adminPassword') ?? process.env.CONNECTOR_ADMIN_PASSWORD;
  const server = http.createServer(async (req, res) => {
    const pw = adminPw();
    const got = Buffer.from(String(req.headers.authorization ?? ''));
    const want = Buffer.from('Basic ' + Buffer.from(`admin:${pw ?? ''}`).toString('base64'));
    if (!pw || got.length !== want.length || !timingSafeEqual(got, want)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Hotel connector"', 'content-type': 'text/plain' });
      return res.end(pw ? 'Sign in as "admin" with the connector admin password.' : 'Set CONNECTOR_ADMIN_PASSWORD (or run the installer) to enable this page.');
    }
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" };
    if (req.method === 'GET' && req.url === '/health.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(c.health(), null, 2)); }
    if (req.method === 'POST' && req.url === '/setup') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 10_000) return res.destroy(); }
      const f = new URLSearchParams(body);
      const pick = (k: string) => (f.get(k) ?? '').trim() || undefined;
      c.secrets.set({ platformToken: pick('platformToken'), vlUsername: pick('vlUsername'), vlPassword: pick('vlPassword'), vlAccessId: pick('vlAccessId') });
      c.vl.reset();
      if (pick('platformToken')) c.hotel = null; // reconnect with the new token
      await c.probeVisionline();
      res.writeHead(200, headers);
      return res.end(page(c, c.visionlineReachable ? 'Saved. Visionline session created successfully.' : `Saved. Visionline test failed: ${c.lastError}`));
    }
    res.writeHead(200, headers);
    res.end(page(c));
  });
  server.listen(c.cfg.localAdmin.port, c.cfg.localAdmin.host, () => console.log(`[connector] local admin page http://${c.cfg.localAdmin.host}:${c.cfg.localAdmin.port}/`));
  return server;
}
