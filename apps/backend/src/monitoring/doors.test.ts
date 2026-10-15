import { describe, expect, it } from 'vitest';
import { classifyDoor, type DoorFacts } from './doors.ts';

const now = new Date('2026-10-15T08:00:00Z');
const h = (n: number) => new Date(now.getTime() - n * 3600_000);
const p = { silentHours: 24, learnDays: 7, minEvents: 3 };
const base: DoorFacts = { lastEventAt: h(1), eventsInLearnWindow: 40, lastExplicit: null, eventAfterExplicit: false, openOfflineAlarm: null };

describe('door contact', () => {
  it('a lock that reported recently is online', () => expect(classifyDoor(base, p, now, true).state).toBe('online'));
  it('a busy lock silent for longer than the limit is offline (warning)', () => {
    const v = classifyDoor({ ...base, lastEventAt: h(30) }, p, now, true);
    expect(v).toMatchObject({ state: 'offline', severity: 'warning' });
    expect(v.reason).toMatch(/No contact for 30 hours/);
  });
  it('a quiet lock (few events) is never called offline for silence', () => expect(classifyDoor({ ...base, lastEventAt: h(300), eventsInLearnWindow: 1 }, p, now, true).state).toBe('unknown'));
  it('silence does not count while the connector watch is not running', () => expect(classifyDoor({ ...base, lastEventAt: h(30) }, p, now, false).state).toBe('unknown'));
  it('an explicit offline event is critical until the lock reports again', () => {
    expect(classifyDoor({ ...base, lastExplicit: { kind: 'offline', at: h(0.5) } }, p, now, true)).toMatchObject({ state: 'offline', severity: 'critical' });
    expect(classifyDoor({ ...base, lastExplicit: { kind: 'offline', at: h(2) }, eventAfterExplicit: true }, p, now, true).state).toBe('online');
  });
  it('an open Visionline "communication" alarm marks the door offline', () => {
    expect(classifyDoor({ ...base, openOfflineAlarm: { title: 'Lost contact', at: h(1) } }, p, now, true)).toMatchObject({ state: 'offline', severity: 'critical' });
  });
  it('a lock never heard from is unknown', () => expect(classifyDoor({ ...base, lastEventAt: null, eventsInLearnWindow: 0 }, p, now, true).state).toBe('unknown'));
});
