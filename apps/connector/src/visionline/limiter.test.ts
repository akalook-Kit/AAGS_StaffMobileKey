import { describe, expect, it } from 'vitest';
import { VisionlineLimiter } from './client.ts';

describe('Visionline limiter (sharing Visionline with the GRMS and PMS)', () => {
  it('never runs more than the cap at once and serves key operations before the people read', async () => {
    const l = new VisionlineLimiter(2, 0);
    const order: string[] = [];
    let running = 0, peak = 0;
    const job = async (name: string, p: 'high' | 'normal' | 'low') => {
      await l.acquire(p); running++; peak = Math.max(peak, running); order.push(name);
      await new Promise((r) => setTimeout(r, 15)); running--; l.release(15, false);
    };
    await Promise.all([job('low1', 'low'), job('low2', 'low'), job('low3', 'low'), job('low4', 'low'), job('key', 'high')]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(order.indexOf('key')).toBeLessThan(order.indexOf('low3'));
  });
  it('pauses the low lane after Visionline says it is busy, but not key operations', async () => {
    const l = new VisionlineLimiter(2, 0);
    await l.acquire('normal'); l.release(10, true);
    let lowStarted = false, highStarted = false;
    void l.acquire('low').then(() => { lowStarted = true; });
    void l.acquire('high').then(() => { highStarted = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(highStarted).toBe(true);
    expect(lowStarted).toBe(false);
  });
});
