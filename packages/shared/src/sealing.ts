import { constants, createDecipheriv, createPublicKey, generateKeyPairSync, privateDecrypt, createHash, publicEncrypt, randomBytes, createCipheriv } from 'node:crypto';
import type { SealedSecret } from './commands.ts';

/**
 * Sealed secrets (Node side). The browser seals with WebCrypto (RSA-OAEP SHA-256 + AES-256-GCM);
 * the connector opens them with its private key. Layout matches WebCrypto: ct = ciphertext || 16-byte tag.
 */
export function generateSealingKey() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
  const spki = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { publicKeyPem: spki, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), keyId: sealingKeyId(spki) };
}

export function sealingKeyId(publicKeyPem: string) {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export function openSealed(privateKeyPem: string, s: SealedSecret): string {
  const aesKey = privateDecrypt({ key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(s.ek, 'base64'));
  const data = Buffer.from(s.ct, 'base64');
  const d = createDecipheriv('aes-256-gcm', aesKey, Buffer.from(s.iv, 'base64'));
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString('utf8');
}

/** Node equivalent of the browser's sealing; used by tests and scripts. */
export function sealForConnector(publicKeyPem: string, plaintext: string): SealedSecret {
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', aesKey, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]);
  const ek = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey);
  return { v: 1, alg: 'RSA-OAEP-256+A256GCM', keyId: sealingKeyId(publicKeyPem), ek: ek.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') };
}
