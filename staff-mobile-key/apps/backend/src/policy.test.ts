import { describe, expect, it } from 'vitest';
import { evaluateIssue, DEFAULT_POLICY, type DoorResource } from './policy.ts';

const doors: DoorResource[] = [
  ...Array.from({ length: 10 }, (_, i) => ({ externalId: `1${String(i + 1).padStart(2, '0')}`, name: '', doorGroup: 'Floor 1', active: true })),
  ...Array.from({ length: 10 }, (_, i) => ({ externalId: `2${String(i + 1).padStart(2, '0')}`, name: '', doorGroup: 'Floor 2', active: true })),
  { externalId: 'Staff Entrance', name: '', doorGroup: 'Common Areas', active: true },
  { externalId: 'Old Door', name: '', doorGroup: 'Floor 1', active: false },
];
const now = new Date('2026-10-12T06:00:00Z');
const h = (n: number) => new Date(now.getTime() + n * 3_600_000);
const base = { doorIds: [], doorGroupIds: [], startsAt: now, expiresAt: h(8), jobRole: 'Housekeeper', now };

describe('policy engine', () => {
  it('resolves a floor to its doors and keeps it narrow', () => {
    const r = evaluateIssue({ ...base, doorGroupIds: ['Floor 1'], doorIds: ['Staff Entrance'] }, doors, DEFAULT_POLICY);
    expect(r.ok).toBe(true);
    expect(r.resolvedDoorIds).toHaveLength(11);
    expect(r.resolvedDoorIds).not.toContain('Old Door');
    expect(r.isBroad).toBe(false);
  });
  it('rejects unknown and removed doors', () => {
    const r = evaluateIssue({ ...base, doorIds: ['999', 'Old Door'] }, doors, DEFAULT_POLICY);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(['UNKNOWN_DOOR', 'UNKNOWN_DOOR']);
  });
  it('flags broad access, requires approval and caps validity', () => {
    const r = evaluateIssue({ ...base, doorGroupIds: ['Floor 1', 'Floor 2'], expiresAt: h(13) }, doors, DEFAULT_POLICY);
    expect(r.isBroad).toBe(true);
    expect(r.requiresApproval).toBe(true);
    expect(r.errors[0]?.code).toBe('VALIDITY_TOO_LONG');
  });
  it('enforces template role restrictions', () => {
    const t = { id: 't', name: 'Back office', doorIds: ['Staff Entrance'], doorGroupIds: [], allowedJobRoles: ['Manager'], isBroad: false, maxValidityHours: 12, timeSchedule: null };
    expect(evaluateIssue({ ...base, template: t }, doors, DEFAULT_POLICY).errors[0]?.code).toBe('TEMPLATE_NOT_ALLOWED');
  });
  it('adds the doors of a Visionline user group (role-based templates)', () => {
    const groups = new Map([['Housekeeping', { doors: ['Staff Entrance'], doorGroups: ['Floor 2'], uniformAccess: false }]]);
    const r = evaluateIssue({ ...base, userGroupIds: ['Housekeeping'] }, doors, DEFAULT_POLICY, groups);
    expect(r.ok).toBe(true);
    expect(r.resolvedDoorIds).toHaveLength(11);
    expect(evaluateIssue({ ...base, userGroupIds: ['Nope'] }, doors, DEFAULT_POLICY, groups).errors[0]?.code).toBe('UNKNOWN_USER_GROUP');
  });
  it('rejects expiry in the past', () => {
    expect(evaluateIssue({ ...base, doorIds: ['101'], startsAt: h(-3), expiresAt: h(-1) }, doors, DEFAULT_POLICY).ok).toBe(false);
  });
});
