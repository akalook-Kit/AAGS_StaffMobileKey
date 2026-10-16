import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Journal } from './journal.ts';
import { toErrorInfo } from './visionline/adapter.ts';
import { VisionlineApiError } from './visionline/client.ts';

const cmd = () => ({ id: randomUUID(), hotelId: randomUUID(), type: 'ISSUE_STAFF_KEY' as const, payload: {}, idempotencyKey: 'k', correlationId: 'c', expiresAt: new Date(Date.now() + 60_000).toISOString(), attempt: 1 });

describe('connector journal', () => {
  it('turns an in-flight command from a crashed process into UNCERTAIN_OUTCOME and never retries it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smkj-'));
    const key = randomBytes(32);
    const j1 = new Journal(dir, key);
    const c = cmd();
    j1.put(c, 'IN_FLIGHT');
    // simulate a different process reading the journal after a crash
    const raw = new Journal(dir, key);
    (raw as any).entries.get(c.id).pid = -1;
    expect(raw.recover()).toBe(1);
    const e = raw.get(c.id)!;
    expect(e.state).toBe('DONE');
    expect(e.result?.error?.code).toBe('UNCERTAIN_OUTCOME');
    expect(raw.outbox().map((x) => x.cmd.id)).toEqual([c.id]);
  });
  it('is unreadable without the master key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smkj-'));
    new Journal(dir, randomBytes(32)).put(cmd(), 'RECEIVED');
    expect(() => new Journal(dir, randomBytes(32))).toThrow();
  });
});

describe('Visionline error mapping', () => {
  it.each([
    [40902, 'VALID_STAFF_CARD_EXISTS'], [40406, 'UNKNOWN_DOOR'], [40052, 'ENDPOINT_NOT_ACTIVE'],
    [40102, 'VISIONLINE_AUTH_FAILED'], [40328, 'MOBILE_OPTION_NOT_LICENSED'], [40999, 'VISIONLINE_REJECTED'],
  ])('%i → %s', (code, expected) => {
    expect(toErrorInfo(new VisionlineApiError(Math.floor(code / 100), code, 'x')).code).toBe(expected);
  });
});
