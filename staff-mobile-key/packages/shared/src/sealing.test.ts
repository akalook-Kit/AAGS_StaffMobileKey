import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { generateSealingKey, openSealed, sealForConnector } from './sealing.ts';
import { sealInBrowser } from './sealing-browser.ts';

describe('sealed secrets', () => {
  const k = generateSealingKey();
  it('round-trips Node sealing', () => {
    expect(openSealed(k.privateKeyPem, sealForConnector(k.publicKeyPem, 'hello'))).toBe('hello');
  });
  it('opens what the browser (WebCrypto) sealed', async () => {
    const s = await sealInBrowser(webcrypto as unknown as Crypto, k.publicKeyPem, k.keyId, JSON.stringify({ password: 'pä55' }));
    expect(JSON.parse(openSealed(k.privateKeyPem, s)).password).toBe('pä55');
  });
  it('rejects tampering', () => {
    const s = sealForConnector(k.publicKeyPem, 'x');
    const ct = Buffer.from(s.ct, 'base64'); ct[0] ^= 1;
    expect(() => openSealed(k.privateKeyPem, { ...s, ct: ct.toString('base64') })).toThrow();
  });
});
