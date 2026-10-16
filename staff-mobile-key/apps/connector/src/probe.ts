/**
 * Visionline read-only probe. Run it on (or next to) the Visionline PC BEFORE installing the connector, to
 * check that everything the platform needs is reachable and correctly set up. It changes nothing in Visionline:
 * it opens one session [§5.24], sends GET requests only, and closes the session [§5.25].
 *
 *   npx tsx src/probe.ts --url https://localhost/api/v1 --user sym [--ca C:\path\visionline.crt | --pin <sha256>]
 *
 * The password is asked for on the console (not echoed) and is never written anywhere. The report contains
 * no password, session id, access key or signature.
 */
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { VL, VL_DOC } from '@smk/shared/node';
import { VisionlineClient, VisionlineApiError } from './visionline/client.ts';
import { visionlineTrust } from './visionline/trust.ts';
import { isNotFound, getMobileAccessAccounts, listUserGroupNames } from './visionline/adapter.ts';

type Level = 'PASS' | 'WARN' | 'FAIL' | 'INFO';
interface Check { level: Level; area: string; message: string; detail?: unknown }

function args() {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
  return {
    url: get('url') ?? process.env.VL_BASE_URL ?? 'https://localhost/api/v1',
    user: get('user') ?? process.env.VL_USERNAME,
    accessId: get('access-id') ?? process.env.VL_ACCESS_ID,
    clientUuid: get('client-uuid'),
    ca: get('ca') ?? process.env.VL_CA_FILE,
    pin: get('pin') ?? process.env.VL_PIN_SHA256,
    servername: get('servername') ?? process.env.VL_TLS_SERVERNAME,
    groups: (get('groups') ?? 'Housekeeping,Maintenance,Security,Management,Front Office').split(',').map((s) => s.trim()).filter(Boolean),
    uuid: get('uuid') ? Number(get('uuid')) : 9,
    out: get('out') ?? 'visionline-probe-report',
    saveCert: get('save-cert'),
    tlsOnly: a.includes('--tls-only'),
  };
}

/** Hidden console prompt (characters are not echoed). Falls back to one line on stdin when not a console. */
async function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  if (!stdin.isTTY) {
    return new Promise((res) => { let buf = ''; stdin.setEncoding('utf8'); stdin.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { stdin.pause(); res(buf.slice(0, i).replace(/\r$/, '')); } }); });
  }
  return new Promise((res) => {
    let pw = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); res(pw); return; }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (c === '\u0008' || c === '\u007f') pw = pw.slice(0, -1); else pw += c;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * Reads the certificate the server presents, WITHOUT sending anything over that connection, and separately
 * checks whether it is trusted under the configured trust. Inspection only: all Visionline traffic later
 * uses the normal client, which always verifies the certificate.
 */
function inspectCertificate(url: URL, ca: Buffer | undefined, servername?: string) {
  const port = Number(url.port || 443);
  const peek = () => new Promise<tls.DetailedPeerCertificate>((res, rej) => {
    const s = tls.connect({ host: url.hostname, port, servername: servername ?? (/^[\d.]+$/.test(url.hostname) ? undefined : url.hostname), rejectUnauthorized: false, minVersion: 'TLSv1.2' }, () => { const c = s.getPeerCertificate(true); s.end(); res(c); });
    s.setTimeout(10_000, () => s.destroy(new Error('timed out')));
    s.on('error', rej);
  });
  const verify = () => new Promise<string | null>((res) => {
    let t: ReturnType<typeof visionlineTrust>;
    try { t = visionlineTrust(ca, { servername }); } catch (e) { res((e as Error).message); return; }
    const s = tls.connect({ host: url.hostname, port, servername: servername ?? (/^[\d.]+$/.test(url.hostname) ? undefined : url.hostname), minVersion: 'TLSv1.2', ...t.tlsOptions } as tls.ConnectionOptions, () => { s.end(); res(null); });
    s.setTimeout(10_000, () => s.destroy(new Error('timed out')));
    s.on('error', (e) => res(e.message));
  });
  return Promise.all([peek(), verify()]);
}
const toPem = (raw: Buffer) => `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;

async function main() {
  const o = args();
  const checks: Check[] = [];
  const add = (level: Level, area: string, message: string, detail?: unknown) => { checks.push({ level, area, message, detail }); console.log(`  [${level}] ${area}: ${message}`); };
  const url = new URL(o.url);
  console.log(`\nVisionline probe (read-only) · ${VL_DOC}\nTarget: ${o.url}\n`);

  // ---- 1. TLS ------------------------------------------------------------------------------------------
  if (url.protocol !== 'https:') { add('FAIL', 'TLS', 'The Visionline Web API must be reached over https://'); return finish(o, checks); }
  const ca = o.ca ? readFileSync(o.ca) : undefined;
  let trusted = false;
  try {
    const [cert, verifyError] = await inspectCertificate(url, ca, o.servername);
    const fp = cert.fingerprint256;
    add('INFO', 'TLS', 'Certificate presented by the server', {
      subject: cert.subject, issuer: cert.issuer, subjectAltName: cert.subjectaltname ?? null,
      validFrom: cert.valid_from, validTo: cert.valid_to, sha256: fp, selfSigned: JSON.stringify(cert.subject) === JSON.stringify(cert.issuer),
    });
    console.log(`         SHA-256 fingerprint: ${fp}`);
    if (new Date(cert.valid_to) < new Date()) add('FAIL', 'TLS', `The certificate expired on ${cert.valid_to}. Renew it on the Visionline server.`);
    else if (new Date(cert.valid_to).getTime() - Date.now() < 30 * 86400_000) add('WARN', 'TLS', `The certificate expires soon (${cert.valid_to}).`);
    // The chain the server sent: leaf first. A trust file must hold the top (self-signed) certificate.
    const chain: tls.DetailedPeerCertificate[] = [];
    for (let c: tls.DetailedPeerCertificate | undefined = cert; c && !chain.some((x) => x.fingerprint256 === c!.fingerprint256); c = c.issuerCertificate) chain.push(c);
    const top = chain[chain.length - 1]!;
    const topSelfSigned = JSON.stringify(top.subject) === JSON.stringify(top.issuer);
    if (chain.length > 1) add('INFO', 'TLS', `The server sent ${chain.length} certificates; top: ${top.subject?.CN ?? JSON.stringify(top.subject)}${topSelfSigned ? ' (root)' : ''}.`);
    if (o.saveCert) {
      writeFileSync(o.saveCert, toPem(top.raw));
      if (!topSelfSigned) add('WARN', 'TLS', 'The server did not send its root certificate. Export the issuing CA certificate from the Visionline server and use that file with --ca instead.');
      add('INFO', 'TLS', `Saved the ${chain.length > 1 ? 'top certificate of the chain' : 'certificate'} to ${resolve(o.saveCert)}. Trust it only after confirming its SHA-256 fingerprint (${top.fingerprint256}) matches the certificate installed on the Visionline server (docs/VISIONLINE-PROBE.md explains how).`);
    }
    if (o.pin && fp.replace(/:/g, '').toLowerCase() !== o.pin.replace(/:/g, '').toLowerCase()) add('FAIL', 'TLS', 'The certificate does not match the pinned fingerprint (--pin).');
    if (verifyError) {
      add('FAIL', 'TLS', `Not trusted with the current settings: ${verifyError}`,
        { fix: ca ? 'Check that --ca points to the Visionline certificate (or its issuing CA) and that the host name matches its subject/SAN; use --servername if Visionline’s certificate is issued to another name.' : 'Export the Visionline server certificate (or its CA) to a .crt file and pass it with --ca, or run with --save-cert to capture it and verify the fingerprint first.' });
    } else {
      trusted = true;
      const mode = visionlineTrust(ca, { servername: o.servername }).mode;
      add('PASS', 'TLS', mode === 'exact'
        ? `Visionline's own certificate in ${o.ca} is trusted exactly (fingerprint match; its issuing CA is not needed).`
        : `Certificate trusted${ca ? ` via ${o.ca}` : ' by the Node.js trust store'}; host name matches.`);
    }
  } catch (e) {
    add('FAIL', 'Network', `Cannot open a TLS connection to ${url.host}: ${(e as Error).message}`, { fix: 'Check the URL and port, that the Visionline Web API service is running, and the Windows firewall.' });
    return finish(o, checks);
  }
  if (o.tlsOnly || !trusted) return finish(o, checks);

  // ---- 2. Session and read-only discovery ---------------------------------------------------------------
  const username = o.user ?? (await askHidden('Visionline operator username (shown): ')) ;
  if (!username) { add('FAIL', 'Credentials', 'No username given.'); return finish(o, checks); }
  o.user = username;
  const password = await askHidden(`Password for ${username} (not shown): `);
  // With an access ID, Visionline knows this client by accessID + uuid (a "web client" that an administrator
  // must Allow, §5.24.2, §7.1.2). Keep the uuid stable so the probe does not create a new entry on every run.
  let clientUuid = o.clientUuid;
  if (o.accessId && !clientUuid) {
    mkdirSync(o.out, { recursive: true });
    const f = join(o.out, 'probe-client-uuid.txt');
    try { clientUuid = readFileSync(f, 'utf8').trim(); } catch { clientUuid = randomUUID(); writeFileSync(f, clientUuid); }
  }
  if (o.accessId) add('INFO', 'Web client', `Signing in with access ID "${o.accessId}" and uuid ${clientUuid}. If Visionline answers 40318, allow this uuid in Visionline: Lists → Web clients → Allow (and set Ignore operator card).`);
  const vl = new VisionlineClient(o.url, { caFile: o.ca, pinSha256: o.pin, servername: o.servername },
    () => ({ username, password, accessId: o.accessId, clientUuid: clientUuid ?? randomUUID() }));
  try {
    const resources = ((await vl.request<{ id: string }[]>('GET', VL.paths.resources)) ?? []).map((r) => r.id);
    add('PASS', 'Session', `Signed in as ${username}. Clock difference with Visionline: ${Math.round(vl.skewMs / 1000)} s.`);
    if (Math.abs(vl.skewMs) > 5 * 60_000) add('WARN', 'Clock', 'This PC’s clock differs from Visionline by more than 5 minutes. Sync both with the same time server.');
    const needed = ['cards', 'doors', 'users', 'userGroups', 'mobileaccess'];
    const missing = needed.filter((r) => !resources.some((x) => x.toLowerCase() === r.toLowerCase()));
    if (missing.length) add('FAIL', 'API resources', `Missing: ${missing.join(', ')}. The operator may lack rights, or a licence/option is not enabled.`, { available: resources });
    else add('PASS', 'API resources', `Available: ${resources.join(', ')}`);

    const doors = await vl.request<any[]>('GET', `${VL.paths.doors}?details=true`);
    const groups = new Map<string, number>();
    for (const d of doors) groups.set(String(d.doorGroup ?? '(no door group)'), (groups.get(String(d.doorGroup ?? '(no door group)')) ?? 0) + 1);
    const offline = doors.filter((d) => d.online === false).length;
    add(doors.length ? 'PASS' : 'FAIL', 'Doors', `${doors.length} doors in ${groups.size} door groups${offline ? `, ${offline} offline` : ''}.`, { doorGroups: Object.fromEntries(groups) });
    const noId = doors.filter((d) => d.id == null || d.id === '').length;
    if (noId) add('INFO', 'Doors', `${noId} of ${doors.length} doors have no "id" in the detailed list; the connector uses the door name instead. Fields seen: ${Object.keys(doors[0] ?? {}).sort().join(', ')}.`);
    if (groups.has('(no door group)')) add('WARN', 'Doors', `${groups.get('(no door group)')} doors have no door group. Floors are door groups in the platform; put rooms in floor groups.`);

    const listed = await listUserGroupNames(vl);
    if (listed) add('INFO', 'User groups', `${listed.length} user groups in Visionline: ${listed.join(', ')}`);
    else add('INFO', 'User groups', 'This Visionline does not list user groups; only the names below are checked.');
    for (const g of o.groups) {
      try {
        const ug = await vl.request<any>('GET', VL.paths.userGroup(g));
        const ops = (ug.doorOperations ?? []) as any[];
        const nDoors = ops.reduce((n, x) => n + (x.doors?.length ?? 0), 0), nGroups = ops.reduce((n, x) => n + (x.doorGroups?.length ?? 0), 0);
        add('PASS', 'User groups', `"${g}" exists${ug.uniformAccess ? ' (uniform access)' : ''}: ${nDoors} doors, ${nGroups} door groups.`);
      } catch (e) {
        if (isNotFound(e)) add('WARN', 'User groups', `"${g}" does not exist in Visionline. Create it there, or from the portal (Settings → Visionline).`);
        else throw e;
      }
    }

    try {
      const accounts = await getMobileAccessAccounts(vl);
      if (!accounts.length) add('FAIL', 'Mobile access', 'No Credential Services account is configured in Visionline (Options → Mobile Access).');
      else add('PASS', 'Mobile access', `Credential Services accounts: ${accounts.map((a) => `${a.name ?? a.id}${a.systemID ? ` (systemID ${a.systemID})` : ''}`).join(', ')}. Use the systemID in Settings → Credential Services.`);
    } catch (e) { add('FAIL', 'Mobile access', `Cannot read mobile access accounts: ${(e as Error).message}`); }

    try {
      const ts = await vl.request<any[]>('GET', VL.paths.timeSchedules);
      add('INFO', 'Time schedules', `${ts.length} time schedules.`, { names: ts.map((t) => t.timeSchedule ?? t.id) });
    } catch { add('INFO', 'Time schedules', 'Not available to this operator (optional).'); }

    add('INFO', 'Mobile Access UUID', `Expected UUID ${o.uuid}. The Web API does not expose it: confirm in Visionline Options → Mobile Access that UUID is ${o.uuid} and “Revoke mobile key when overridden” is selected, and that Settings → Visionline in the portal shows the same.`);
  } catch (e) {
    const ve = e as VisionlineApiError;
    if (ve.code === VL.errors.badCredentials) add('FAIL', 'Session', 'Visionline rejected the username or password (40102).');
    else if (ve.code === 40318) add('FAIL', 'Session', 'Visionline has not allowed this web client yet (40318). In Visionline: Lists → Web clients → select the new entry for this access ID → Allow, then run the probe again.');
    else if (ve.code === VL.errors.notAuthorized) add('FAIL', 'Session', 'This operator is not allowed to use the Web API (40107). Give the operator Web API rights in Visionline.');
    else add('FAIL', 'Session', `${ve.message}${ve.code ? ` (${ve.code})` : ''}`);
  } finally {
    await vl.close(); // DELETE /sessions/{id} [§5.25]
  }
  return finish(o, checks);
}

function finish(o: ReturnType<typeof args>, checks: Check[]) {
  mkdirSync(o.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = { tool: 'smk visionline-probe', doc: VL_DOC, at: new Date().toISOString(), target: o.url, operator: o.user ?? '(prompted)', checks };
  const jsonFile = join(o.out, `probe-${stamp}.json`);
  writeFileSync(jsonFile, JSON.stringify(report, null, 2));
  const txt = [`Visionline probe ${report.at}`, `Target ${o.url}`, '', ...checks.map((c) => `[${c.level}] ${c.area}: ${c.message}${c.detail ? `\n        ${JSON.stringify(c.detail)}` : ''}`)].join('\n');
  writeFileSync(join(o.out, `probe-${stamp}.txt`), txt);
  const fails = checks.filter((c) => c.level === 'FAIL').length, warns = checks.filter((c) => c.level === 'WARN').length;
  console.log(`\n${fails ? `${fails} problem(s)` : 'No problems'}${warns ? `, ${warns} warning(s)` : ''}. Report: ${resolve(jsonFile)} (no passwords or keys inside).\n`);
  process.exitCode = fails ? 1 : 0;
}

void main();
