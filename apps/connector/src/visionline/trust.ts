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
export function visionlineTrust(caPem: Buffer | undefined, opts: { servername?: string; pinSha256?: string; label?: string; acceptExpiredSha256?: string }) {
  const who = opts.label ?? 'Visionline';
  const blocks = caPem ? (caPem.toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) : [];
  const certs = blocks.map((b) => new X509Certificate(b));
  const exact = certs.length === 1 && certs[0]!.ca === false ? certs[0]! : null;
  const pin = opts.pinSha256 ? norm(opts.pinSha256) : null;
  if (exact) {
    const [maj, min] = process.versions.node.split('.').map(Number);
    if (maj! < 22 || (maj === 22 && min! < 9))
      throw new Error(`Trusting Visionline's own certificate needs Node.js 22.9 or newer (this is ${process.versions.node}). Update Node.js 22 LTS, or give the issuing CA certificate instead.`);
  }
  // 2.38.1 An expired certificate accepted by the administrator (Armel, 18 Nov 2026: Visionline's own certificate expired
  // years ago and the property must work today). Only for an exact certificate, only for that one fingerprint.
  const acceptExpired = opts.acceptExpiredSha256 ? norm(opts.acceptExpiredSha256) : null;
  if (acceptExpired) {
    if (!exact) throw new Error(`An expired certificate can only be accepted as an exact certificate (the file must hold ${who}'s own certificate, not a CA).`);
    if (norm(exact.fingerprint256) !== acceptExpired) throw new Error(`The certificate accepted although expired (${opts.acceptExpiredSha256}) is not the one in the trusted file (${exact.fingerprint256}). Run Trust-Visionline-Certificate again.`);
  }
  const expiredAccepted = acceptExpired && exact ? { validTo: new Date(exact.validTo).toISOString(), fingerprint: exact.fingerprint256 } : null;
  return {
    expiredAccepted,
    /**
     * With an accepted expired certificate the usual check stops at "certificate has expired" before anything else is
     * looked at, so this connection does its own check before the socket is handed to the request: the certificate
     * must be exactly the trusted one (same SHA-256), and the only fault OpenSSL may report is that it expired.
     * Nothing is sent to Visionline before that check (no password, no session).
     */
    createConnection: expiredAccepted ? (o: tls.ConnectionOptions, cb: (err: Error | null, s?: tls.TLSSocket) => void) => {
      const s = tls.connect({ ...o, rejectUnauthorized: false });
      const fail = (e: Error) => { s.destroy(); cb(e); };
      const onError = (e: Error) => cb(e);
      s.once('error', onError);
      s.once('secureConnect', () => {
        s.removeListener('error', onError);
        const cert = s.getPeerCertificate();
        const ae = s.authorizationError as unknown as (Error & { code?: string }) | string | null;
        const code = !ae ? null : typeof ae === 'string' ? ae : (ae.code ?? ae.message);
        if (!cert?.fingerprint256 || norm(cert.fingerprint256) !== acceptExpired) return fail(new Error(`${who} presented a different certificate than the trusted one (fingerprint mismatch)`));
        if (code && code !== 'CERT_HAS_EXPIRED') return fail(new Error(`${who} certificate is not trusted: ${code}`));
        if (pin && norm(cert.fingerprint256) !== pin) return fail(new Error(`${who} certificate fingerprint does not match the pinned value`));
        cb(null, s);
      });
      return undefined;
    } : null,
    mode: exact ? 'exact' as const : caPem ? 'ca' as const : 'system' as const,
    exactFingerprint: exact?.fingerprint256 ?? null,
    tlsOptions: {
      ca: caPem,
      // Lets OpenSSL accept the non-CA certificate in the file as the trust anchor (Node ≥ 22.9).
      ...(exact ? { allowPartialTrustChain: true } : {}),
      checkServerIdentity: (host: string, cert: tls.PeerCertificate): Error | undefined => {
        if (exact) {
          if (norm(cert.fingerprint256) !== norm(exact.fingerprint256)) return new Error(`${who} presented a different certificate than the trusted one (fingerprint mismatch)`);
        } else {
          const err = tls.checkServerIdentity(opts.servername ?? host, cert);
          if (err) return err;
        }
        if (pin && norm(cert.fingerprint256) !== pin) return new Error(`${who} certificate fingerprint does not match the pinned value`);
        return undefined;
      },
    },
  };
}
