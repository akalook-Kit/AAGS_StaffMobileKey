import { describe, it, expect, afterAll } from 'vitest';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { VisionlineClient } from './client.ts';
import { visionlineTrust } from './trust.ts';

/**
 * 2.38.1 Visionline's own certificate expired years ago (Armel, 18 Nov 2026). The administrator may accept exactly that
 * certificate although it is out of date: only the date check is waived, every other certificate is still refused,
 * and nothing (no password) is sent before the check.
 */
const dir = mkdtempSync(join(tmpdir(), 'vl-expired-'));
const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
writeFileSync(join(dir, 'index.txt'), ''); writeFileSync(join(dir, 'serial'), '01\n');
writeFileSync(join(dir, 'ca.cnf'), '[ca]\ndefault_ca=d\n[d]\ndatabase=index.txt\nnew_certs_dir=.\nserial=serial\ndefault_md=sha256\npolicy=p\ncopy_extensions=copy\nunique_subject=no\n[p]\ncommonName=supplied\n');
const make = (name: string, start: string, end: string) => {
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Visionline WebService', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', `${name}.key`, '-out', `${name}.csr`]);
  run(['ca', '-batch', '-notext', '-config', 'ca.cnf', '-selfsign', '-keyfile', `${name}.key`, '-in', `${name}.csr`, '-startdate', start, '-enddate', end, '-out', `${name}.pem`]);
  return { key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.pem`)), file: join(dir, `${name}.pem`) };
};
const old = make('old', '20210101000000Z', '20220101000000Z'); // expired
const other = make('other', '20210101000000Z', '20220101000000Z'); // another expired certificate (same name)
const fp = (pem: Buffer) => new X509Certificate(pem).fingerprint256;

let bodies: string[] = [];
const serve = (k: { key: Buffer; cert: Buffer }) => {
  const server = https.createServer({ key: k.key, cert: k.cert }, (req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      bodies.push(`${req.method} ${req.url} ${b}`);
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST') { res.statusCode = 201; res.end(JSON.stringify({ id: 's1', accessKey: 'k' })); } else res.end(JSON.stringify([{ id: 'r1' }]));
    });
  });
  return { server, port: new Promise<number>((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port))) };
};
const sOld = serve(old), sOther = serve(other);
afterAll(() => { sOld.server.close(); sOther.server.close(); });
const creds = () => ({ username: 'u', password: 'secret-password', clientUuid: 'x' });

describe('expired Visionline certificate accepted by the administrator', () => {
  it('without acceptance the expired certificate is refused, as before', async () => {
    const c = new VisionlineClient(`https://127.0.0.1:${await sOld.port}/api/v1`, { caFile: old.file }, creds);
    await expect(c.request('GET', '/resources')).rejects.toThrow(/expired/i);
  });
  it('accepted: exactly that certificate works, and the portal is told it is expired', async () => {
    bodies = [];
    const c = new VisionlineClient(`https://127.0.0.1:${await sOld.port}/api/v1`, { caFile: old.file, acceptExpiredSha256: fp(old.cert) }, creds);
    expect(await c.request('GET', '/resources')).toEqual([{ id: 'r1' }]);
    expect(c.tlsState).toMatch(/EXPIRED on 2022-01-01, accepted by the administrator/);
  });
  it('another certificate is still refused, and nothing (no password) reaches it', async () => {
    bodies = [];
    const c = new VisionlineClient(`https://127.0.0.1:${await sOther.port}/api/v1`, { caFile: old.file, acceptExpiredSha256: fp(old.cert) }, creds);
    await expect(c.request('GET', '/resources')).rejects.toThrow(/fingerprint mismatch/);
    expect(bodies).toEqual([]);
  });
  it('the acceptance must name the certificate in the trusted file, and only an exact certificate', () => {
    expect(() => visionlineTrust(old.cert, { acceptExpiredSha256: fp(other.cert) })).toThrow(/is not the one in the trusted file/);
    expect(() => visionlineTrust(undefined, { acceptExpiredSha256: fp(old.cert) })).toThrow(/exact certificate/);
  });
});
