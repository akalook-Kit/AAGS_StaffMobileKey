import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import selfsigned from 'selfsigned';

/**
 * Creates a private dev CA and a server certificate for the simulated Visionline Web API.
 * The connector trusts ca.crt explicitly (it never disables TLS verification), which mirrors the
 * production requirement to deploy the Visionline local trust chain (spec §12.1.1).
 */
export async function ensureDevCerts(dir: string, hostnames: string[]) {
  mkdirSync(dir, { recursive: true });
  const caCrt = join(dir, 'ca.crt');
  const crt = join(dir, 'visionline.crt');
  const key = join(dir, 'visionline.key');
  if (!existsSync(caCrt) || !existsSync(crt) || !existsSync(key)) {
    const year = new Date(Date.now() + 365 * 864e5);
    const ca = await selfsigned.generate([{ name: 'commonName', value: 'SMK Dev Visionline CA' }], {
      keySize: 2048, algorithm: 'sha256', notAfterDate: year,
      extensions: [
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
      ],
    } as any);
    const leaf = await selfsigned.generate([{ name: 'commonName', value: hostnames[0] }], {
      keySize: 2048, algorithm: 'sha256', notAfterDate: year,
      ca: { key: ca.private, cert: ca.cert },
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          altNames: [
            ...hostnames.map((h) => ({ type: 2, value: h })),
            { type: 7, ip: '127.0.0.1' },
          ],
        },
      ],
    } as any);
    writeFileSync(caCrt, ca.cert);
    writeFileSync(crt, leaf.cert);
    writeFileSync(key, leaf.private, { mode: 0o600 });
  }
  return { ca: readFileSync(caCrt), cert: readFileSync(crt), key: readFileSync(key), caPath: caCrt };
}
