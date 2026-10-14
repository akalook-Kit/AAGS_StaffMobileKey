import type { SealedSecret } from './commands.ts';

/** Browser-side sealing with WebCrypto. Needs a secure context (https:// or http://localhost). */
export async function sealInBrowser(crypto: Crypto, publicKeyPem: string, keyId: string, plaintext: string): Promise<SealedSecret> {
  const b64 = publicKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const rsa = await crypto.subtle.importKey('spki', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(plaintext)));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', aes));
  const ek = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, rsa, raw));
  const enc = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  return { v: 1, alg: 'RSA-OAEP-256+A256GCM', keyId, ek: enc(ek), iv: enc(iv), ct: enc(ct) };
}
