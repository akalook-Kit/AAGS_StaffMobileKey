/**
 * Read-only check of a Credential Services (SEOS) account, e.g. the one configured in Visionline
 * Options → Mobile Access. It sends only GET requests [AAH Credential Services API V2.5.1]:
 *   GET [url base]/callback                      (§8.3 list callbacks)  → are the credentials accepted?
 *   GET [url base]/endpoint/<random id>          (§5.3)                 → expected "not found"
 *   GET [url base]/system/<id>/credential/0      (§7.2, with --system)  → is the System ID known to this user?
 * It creates, changes and deletes nothing. The password is typed (not shown), never stored or printed.
 *
 *   npx tsx src/tools/cs-check.ts --url https://hospitality.credential-services.api.assaabloy.com --user <user> --system 3460
 */
import { randomUUID } from 'node:crypto';
import { CS } from '@smk/shared';

function arg(k: string) { const a = process.argv.slice(2); const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; }

async function askHidden(q: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(q);
  if (!stdin.isTTY) return new Promise((res) => { let b = ''; stdin.setEncoding('utf8'); stdin.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) { stdin.pause(); res(b.slice(0, i).replace(/\r$/, '')); } }); });
  return new Promise((res) => {
    let pw = ''; stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const on = (ch: string) => { for (const c of ch) {
      if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); process.stdout.write('\n'); res(pw); return; }
      if (c === '\u0003') process.exit(130);
      if (c === '\u0008' || c === '\u007f') pw = pw.slice(0, -1); else pw += c;
    } };
    stdin.on('data', on);
  });
}

async function main() {
  const url = (arg('url') ?? 'https://hospitality.credential-services.api.assaabloy.com').replace(/\/$/, '');
  const user = arg('user');
  const system = arg('system');
  if (!url.startsWith('https://') && !url.startsWith('http://localhost') && !url.startsWith('http://simulator')) { console.log('Use an https:// address.'); process.exit(2); }
  if (!user) { console.log('Give --user (the Credential Services user from Visionline Options → Mobile Access).'); process.exit(2); }
  const password = await askHidden(`Password for ${user} (not shown): `);
  const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  let problems = 0;
  const get = async (path: string) => {
    try {
      const r = await fetch(url + path, { headers: { accept: CS.mediaType, authorization: auth }, signal: AbortSignal.timeout(15_000) });
      const text = await r.text();
      let json: any = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json, isJson: json !== null, ctype: r.headers.get('content-type') ?? '' };
    } catch (e) { return { status: 0, json: null, isJson: false, ctype: '', error: (e as Error).message }; }
  };
  console.log(`\nCredential Services check (read-only) · ${url}\n`);

  const cb = await get('/callback');
  if (cb.status === 0) { console.log(`  [FAIL] Cannot reach ${url}: ${(cb as any).error}`); process.exit(1); }
  if (cb.status === 401 || cb.status === 403) { console.log(`  [FAIL] Credentials refused (HTTP ${cb.status}). Check the user and password from Visionline → Options → Mobile Access.`); problems++; }
  else if (cb.status === 200) {
    const list = Array.isArray(cb.json) ? cb.json : [];
    console.log(`  [PASS] Credentials accepted. Registered callbacks: ${list.length ? list.map((c: any) => `${c.type} → ${c.url}`).join('; ') : 'none'}`);
    if (list.length) console.log('         (Several URLs per type are allowed (§8.2): the platform adds its own and never removes these.)');
  } else if (cb.status === 404 && !cb.isJson) { console.log(`  [FAIL] HTTP 404 without an API answer: the URL may need a path after the host. Ask ASSA ABLOY for the full "url base".`); problems++; }
  else { console.log(`  [WARN] /callback answered HTTP ${cb.status} (${cb.ctype}).`); }

  const ep = await get(`/endpoint/${randomUUID()}`);
  if (ep.status === 404 && ep.isJson) console.log('  [PASS] Endpoint lookup works (a random endpoint is reported as not found, as expected).');
  else if (ep.status === 401 || ep.status === 403) { console.log(`  [FAIL] Endpoint lookup refused (HTTP ${ep.status}).`); problems++; }
  else console.log(`  [INFO] Endpoint lookup answered HTTP ${ep.status}.`);

  if (system) {
    const cr = await get(`/system/${encodeURIComponent(system)}/credential/0`);
    if (cr.status === 401 || cr.status === 403) { console.log(`  [FAIL] System ID ${system} is not accessible with this user (HTTP ${cr.status}).`); problems++; }
    else if (cr.status === 404) console.log(`  [PASS] System ID ${system} accepted (credential 0 not found, as expected).`);
    else console.log(`  [INFO] System ${system} lookup answered HTTP ${cr.status}.`);
  }
  console.log(`\n${problems ? `${problems} problem(s).` : 'No problems.'} Nothing was changed. The password was not stored.\n`);
  process.exit(problems ? 1 : 0);
}
void main();
