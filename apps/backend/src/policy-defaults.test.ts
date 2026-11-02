import { describe, expect, it } from 'vitest';
import { SCHEMAS } from './hotel-config.ts';

describe('policy defaults (2.19)', () => {
  it('3-4.8 V locks are critical at 3.6 V; firmware window 14 days', () => {
    const p = SCHEMAS.policy.parse({});
    expect(p.battery.voltage.lowRange).toEqual({ low: null, critical: 3.6 });
    expect(p.battery.stillAlarmingDays).toBe(14);
    expect((p.battery as any).lowAlertGraceDays).toBeUndefined();
  });
});
