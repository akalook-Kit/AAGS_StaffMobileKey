import { describe, it, expect } from 'vitest';
import { WebApiAdapter, firstText } from './adapter.ts';

/** A stand-in Visionline client answering from a fixed table of paths. */
function fakeClient(table: Record<string, unknown>) {
  return {
    skewMs: 0, tlsState: 'verified',
    async request(_m: string, path: string) {
      const key = Object.keys(table).find((k) => path.endsWith(k));
      if (!key) { const e: any = new Error('not found'); e.status = 404; e.code = 40401; throw e; }
      return table[key];
    },
  } as any;
}

describe('discovery on real Visionline shapes', () => {
  it('keeps every door when the detailed list has no id (uses the door name)', async () => {
    const doors = Array.from({ length: 449 }, (_, i) => ({ doorName: `Room ${1000 + i}`, doorGroup: `${(i % 34) + 1}th Floor`, doorID: i + 1, online: false }));
    const vl = fakeClient({ '/resources': [{ id: 'doors' }], '/doors?details=true': doors, '/timeSchedules': [{ timeSchedule: '', description: '' }, { timeSchedule: 'Dayshift08.00-05.30' }], '/mobileaccess': [{ name: 'Marriott', systemID: 3152 }] });
    const a = new WebApiAdapter(vl, () => 'Africa/Nairobi', 'checkoutPerDoor');
    const { resources } = await a.discover([]);
    expect(resources.filter((r) => r.kind === 'door')).toHaveLength(449);
    expect(resources.filter((r) => r.kind === 'doorgroup')).toHaveLength(34);
    expect(resources.filter((r) => r.kind === 'timeschedule').map((r) => r.name)).toEqual(['Dayshift08.00-05.30']);
  });
  it('firstText skips empty values', () => {
    expect(firstText(undefined, '', '  ', 'A')).toBe('A');
    expect(firstText(null, 0)).toBe('0');
    expect(firstText(undefined)).toBeNull();
  });
});
