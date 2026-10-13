import { describe, expect, it } from 'vitest';
import { redact, stableStringify } from './redact.ts';

describe('redact', () => {
  it('removes secrets but keeps identifiers and dates', () => {
    const d = new Date('2026-10-11T10:00:00Z');
    expect(redact({ password: 'x', nested: { accessKey: 'k', credentialId: '1000177' }, expiresAt: d, invitationCode: 'ABCD' }))
      .toEqual({ password: '[REDACTED]', nested: { accessKey: '[REDACTED]', credentialId: '1000177' }, expiresAt: '2026-10-11T10:00:00.000Z', invitationCode: '[REDACTED]' });
  });
  it('stable stringify ignores key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });
});
