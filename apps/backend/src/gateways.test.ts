import { describe, expect, it } from 'vitest';
import { alarmNamesGateway, classifyGateway } from './gateways.ts';

describe('gateway state (2.19)', () => {
  const g = { name: 'GW Floor 1', eeid: '000D6F0012AB34CD' };
  it('is offline when a Visionline alarm names its EEID, and back when the alarm is gone', () => {
    expect(classifyGateway({ ...g, doorStates: ['online'], alarms: [{ title: 'Online unit', text: 'No contact with 000D6F0012AB34CD' }] }).state).toBe('offline');
    expect(classifyGateway({ ...g, doorStates: ['online', 'offline'], alarms: [] }).state).toBe('online');
  });
  it('needs a gateway word with the name, so a room alarm does not match', () => {
    expect(alarmNamesGateway(g, { title: 'Gateway offline', text: 'GW Floor 1' })).toBe(true);
    expect(alarmNamesGateway(g, { title: 'Door left open', text: 'GW Floor 1' })).toBe(false);
    expect(alarmNamesGateway(g, { title: 'x', text: 'EEID 000D6F0012AB34CDEF' })).toBe(false);
  });
  it('is offline when all its locks are offline, unknown when nothing is known', () => {
    expect(classifyGateway({ ...g, doorStates: ['offline', 'offline', 'offline'], alarms: [] })).toEqual({ state: 'offline', reason: 'All 3 locks behind it are offline' });
    expect(classifyGateway({ ...g, doorStates: ['offline'], alarms: [] }).state).toBe('unknown');
    expect(classifyGateway({ ...g, doorStates: [], alarms: [] }).state).toBe('unknown');
  });
});
