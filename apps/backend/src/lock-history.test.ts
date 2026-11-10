import { describe, expect, it } from 'vitest';
import { judgeWorks, nextStep, type Reading } from './lock-history.ts';

const o = { top: 4.8, alarmLevel: 4.0, today: '2026-11-09' };
// "below X V" steps of a 4.8 V lock: a draining set loses 0.2 V every 10 days.
const draining = (from: string, days: number, start = 4.8, perTenDays = 0.2): Reading[] =>
  Array.from({ length: Math.floor(days / 10) + 1 }, (_, i) => ({ t: new Date(Date.parse(`${from}T08:00:00Z`) + i * 10 * 86_400_000).toISOString().slice(0, 16), volts: Math.round((start - i * perTenDays) * 10) / 10 }));

describe('lock history: judging work from the reports after it (2.30)', () => {
  it('waits for a report after the work', () => {
    const [j] = judgeWorks([{ id: 'a', on: '2026-11-01', parts: ['battery-cable'], batteryType: null }], draining('2026-09-01', 50), [], [], o);
    expect(j!.verdict).toBe('waiting');
    expect(j!.waitUntil).toBe('2026-11-22');
  });
  it('fixed: battery use falls by more than half after the swap', () => {
    const before = draining('2026-06-01', 60, 4.8, 0.2);           // 0.6 V / 30 days
    const after = draining('2026-08-02', 90, 4.8, 0.02);           // ~0.06 V / 30 days: a set lasts over a year
    const [j] = judgeWorks([{ id: 'a', on: '2026-08-01', parts: ['batteries', 'battery-holder'], batteryType: 'industrial-alkaline' }], [...before, ...after], ['2026-06-01'], [], o);
    expect(j!.verdict).toBe('fixed');
    expect(j!.before!.per30Days).toBeGreaterThan(j!.after!.per30Days * 2);
  });
  it('same drain after the swap: that part was not the cause', () => {
    const before = draining('2026-06-01', 60), after = draining('2026-08-02', 60);
    const [j] = judgeWorks([{ id: 'a', on: '2026-08-01', parts: ['batteries', 'reader'], batteryType: 'industrial-alkaline' }], [...before, ...after], ['2026-06-01'], [], o);
    expect(j!.verdict).toBe('same');
    expect(j!.title).toMatch(/not the cause/);
  });
  it('batteries needed again soon after = still draining', () => {
    const [j] = judgeWorks([{ id: 'a', on: '2026-08-01', parts: ['batteries'], batteryType: 'alkaline' }], [], ['2026-09-10'], [], o);
    expect(j!.verdict).toBe('draining');
    expect(j!.againInDays).toBe(40);
  });
  it('next step: skips what was tried and what the technician found OK, likely causes first', () => {
    const j = judgeWorks([{ id: 'a', on: '2026-08-01', parts: ['batteries'], batteryType: 'industrial-alkaline' }], [], ['2026-09-10'], [], o);
    const n = nextStep(j, 'signature-rfid', [{ id: 'contacts', suggests: 'unlikely' }, { id: 'door', suggests: 'likely' }], { contacts: 'ok' }, true);
    expect(n.state).toBe('draining');
    expect(n.next?.group).toBe('mechanics');
    expect(n.next?.parts).toContain('Lockcase (mortise) replaced');
    const unknown = judgeWorks([{ id: 'b', on: '2026-08-01', parts: ['batteries', 'lcu'], batteryType: 'unknown' }], [], ['2026-09-10'], [], o);
    expect(nextStep(unknown, 'classic-alfa', null, null, true).next?.group).toBe('batteries');
    const nn = nextStep(j, 'novel', null, { contacts: 'ok', door: 'ok' }, true);
    expect(nn.next?.group).toBe('reader');
    expect(nn.next?.parts).toEqual(['Novel reader unit (outside, RFID/BLE) replaced']);
  });
});
