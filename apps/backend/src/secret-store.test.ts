import { randomBytes, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normRef, open, seal } from './secret-store.ts';
import { normaliseCode } from './routes/setup.ts';

describe('portal secrets (2.9)', () => {
  const key = randomBytes(32);
  const hotel = '6f1d2c3a-0000-4000-8000-000000000001';

  it('seals and opens a value for one hotel and reference', () => {
    const s = seal(hotel, 'CS_TENANT_PASSWORD', 'pässwörd-123', key);
    expect(s.includes(Buffer.from('pässwörd-123'))).toBe(false);
    expect(open(hotel, 'CS_TENANT_PASSWORD', s, key)).toBe('pässwörd-123');
  });

  it('a sealed value cannot be moved to another hotel or reference, or opened with another key', () => {
    const s = seal(hotel, 'SMTP_PASSWORD', 'x', key);
    expect(() => open('6f1d2c3a-0000-4000-8000-000000000002', 'SMTP_PASSWORD', s, key)).toThrow();
    expect(() => open(hotel, 'CS_TENANT_PASSWORD', s, key)).toThrow();
    expect(() => open(hotel, 'SMTP_PASSWORD', s, randomBytes(32))).toThrow();
  });

  it('detects any change to the sealed bytes', () => {
    const s = seal(hotel, 'SMS_API_KEY', 'abc', key);
    s[s.length - 1]! ^= 1;
    expect(() => open(hotel, 'SMS_API_KEY', s, key)).toThrow();
  });

  it('uses a fresh nonce every time', () => {
    expect(seal(hotel, 'SMS_API_KEY', 'abc', key).equals(seal(hotel, 'SMS_API_KEY', 'abc', key))).toBe(false);
  });

  it('normalises reference names', () => { expect(normRef('cs-tenant.user')).toBe('CS_TENANT_USER'); });
});

describe('first-run setup code', () => {
  it('ignores case, spaces and dashes, like the installer hashes it', () => {
    expect(normaliseCode(' abcd-efgh jkm2 ')).toBe('ABCDEFGHJKM2');
    // install-onprem.ps1: SHA-256 of the code without dashes (upper case).
    expect(createHash('sha256').update(normaliseCode('abcd-efgh-jkm2')).digest('hex')).toBe(createHash('sha256').update('ABCDEFGHJKM2').digest('hex'));
  });
});
