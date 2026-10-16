import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';

const norm = (fp: string) => fp.replace(/:/g, '').toLowerCase();

/**
 * How the connector decides to trust the Visionline certificate. Verification is never switched off.
 *
 *  - "ca": the file holds the CA that issued Visionline's certificate (one or more CA certificates).
 *    Normal TLS rules: the chain must lead to that CA and the host name (or -ServerName) must match.
 *  - "exact": the file holds Visionline's own server certificate only (not a CA). Typical for Visionline,
 *    whose certificate is issued by a private "VisionlineRootCA" that is not sent and often not installed.
 *    Then exactly that certificate is trusted, as a pin: the server must present a certificate with the
 *    same SHA-256 fingerprint. The host name check is replaced by this exact match, because the certificate
 *    is usually issued to "Visionline WebService", which is not a resolvable host name.
 */
export function visionlineTrust(caPem: Buffer | undefined, opts: { servername?: string; pinSha256?: string }) {
  const blocks = caPem ? (caPem.toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) : [];
  const certs = blocks.map((b) => new X509Certificate(b));
  const exact = certs.length === 1 && certs[0]!.ca === false ? certs[0]! : null;
  const pin = opts.pinSha256 ? norm(opts.pinSha256) : null;
  if (exact) {
    const [maj, min] = process.versions.node.split('.').map(Number);
    if (maj! < 22 || (maj === 22 && min! < 9))
      throw new Error(`Trusting Visionline's own certificate needs Node.js 22.9 or newer (this is ${process.versions.node}). Update Node.js 22 LTS, or give the issuing CA certificate instead.`);
  }
  return {
    mode: exact ? 'exact' as const : caPem ? 'ca' as const : 'system' as const,
    exactFingerprint: exact?.fingerprint256 ?? null,
    tlsOptions: {
      ca: caPem,
      // Lets OpenSSL accept the non-CA certificate in the file as the trust anchor (Node ≥ 22.9).
      ...(exact ? { allowPartialTrustChain: true } : {}),
      checkServerIdentity: (host: string, cert: tls.PeerCertificate): Error | undefined => {
        if (exact) {
          if (norm(cert.fingerprint256) !== norm(exact.fingerprint256)) return new Error('Visionline presented a different certificate than the trusted one (fingerprint mismatch)');
        } else {
          const err = tls.checkServerIdentity(opts.servername ?? host, cert);
          if (err) return err;
        }
        if (pin && norm(cert.fingerprint256) !== pin) return new Error('Visionline certificate fingerprint does not match the pinned value');
        return undefined;
      },
    },
  };
}
