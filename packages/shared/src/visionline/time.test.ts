import { describe, expect, it } from 'vitest';
import { fromVisionlineLocal, toVisionlineLocal } from './time.ts';

describe('Visionline local time', () => {
  it('formats in hotel time zone (Kigali, UTC+2)', () => {
    expect(toVisionlineLocal(new Date('2026-10-11T21:59:00Z'), 'Africa/Kigali')).toBe('20261011T2359');
  });
  it('round-trips, including across a DST change', () => {
    for (const tz of ['Africa/Kigali', 'Europe/Stockholm', 'America/New_York']) {
      for (const iso of ['2026-03-29T00:30:00Z', '2026-07-01T12:00:00Z', '2026-10-25T02:15:00Z']) {
        const d = new Date(iso);
        expect(fromVisionlineLocal(toVisionlineLocal(d, tz), tz).toISOString()).toBe(d.toISOString());
      }
    }
  });
  it('accepts seconds and extended format in responses', () => {
    expect(fromVisionlineLocal('2026-10-11T23:59:30', 'UTC').toISOString()).toBe('2026-10-11T23:59:30.000Z');
  });
});
