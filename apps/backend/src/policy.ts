/**
 * Policy engine for staff key requests (spec §3, §12.4, §13.2 step 6, §13.4.4).
 * Pure function: everything it needs is passed in, so it is easy to test.
 */
export interface PolicyConfig {
  maxValidityHours: number;
  broadDoorThreshold: number;
  broadMaxValidityHours: number;
  maxFutureStartDays: number;
  requireApprovalForBroad: boolean;
}
export const DEFAULT_POLICY: PolicyConfig = { maxValidityHours: 24, broadDoorThreshold: 15, broadMaxValidityHours: 12, maxFutureStartDays: 7, requireApprovalForBroad: true };

export interface DoorResource { externalId: string; name: string; doorGroup: string | null; active: boolean }
export interface TemplateLike { id: string; name: string; doorIds: string[]; doorGroupIds: string[]; userGroupIds?: string[]; allowedJobRoles: string[]; isBroad: boolean; maxValidityHours: number; timeSchedule: string | null }
/** Doors attached to a Visionline user group (its doorOperations), from resource discovery. */
export interface UserGroupDoors { doors: string[]; doorGroups: string[]; uniformAccess: boolean }

export interface IssueInput {
  template?: TemplateLike | null;
  doorIds: string[];
  doorGroupIds: string[];
  userGroupIds?: string[];
  startsAt: Date;
  expiresAt: Date;
  jobRole: string;
  now: Date;
}

export interface PolicyResult {
  ok: boolean;
  errors: { code: string; message: string }[];
  resolvedDoorIds: string[];
  isBroad: boolean;
  requiresApproval: boolean;
  timeSchedule: string | null;
  maxValidityHours: number;
}

export function evaluateIssue(input: IssueInput, doors: DoorResource[], policy: PolicyConfig, userGroups: Map<string, UserGroupDoors> = new Map()): PolicyResult {
  const errors: PolicyResult['errors'] = [];
  const byId = new Map(doors.map((d) => [d.externalId, d]));
  const groups = new Set(doors.map((d) => d.doorGroup).filter(Boolean) as string[]);
  const t = input.template;

  const wantedDoors = [...(t?.doorIds ?? []), ...input.doorIds];
  const wantedGroups = [...(t?.doorGroupIds ?? []), ...input.doorGroupIds];
  // Role-based access: a user group contributes the doors and door groups configured on it in Visionline.
  for (const ug of [...(t?.userGroupIds ?? []), ...(input.userGroupIds ?? [])]) {
    const g = userGroups.get(ug);
    if (!g) { errors.push({ code: 'UNKNOWN_USER_GROUP', message: `User group "${ug}" was not found in Visionline. Run resource discovery.` }); continue; }
    wantedDoors.push(...g.doors);
    wantedGroups.push(...g.doorGroups);
  }

  // Unknown identifiers are rejected, never ignored (spec §13.3).
  for (const d of wantedDoors) {
    const r = byId.get(d);
    if (!r) errors.push({ code: 'UNKNOWN_DOOR', message: `Door "${d}" is not known in Visionline. Run resource discovery.` });
    else if (!r.active) errors.push({ code: 'UNKNOWN_DOOR', message: `Door "${d}" is no longer present in Visionline.` });
  }
  for (const g of wantedGroups) if (!groups.has(g)) errors.push({ code: 'UNKNOWN_DOOR_GROUP', message: `Door group "${g}" is not known in Visionline.` });

  // Floors / door groups are resolved to explicit doors (spec §12.4: no separate floor credential object).
  const resolved = new Set<string>(wantedDoors.filter((d) => byId.get(d)?.active));
  for (const d of doors) if (d.active && d.doorGroup && wantedGroups.includes(d.doorGroup)) resolved.add(d.externalId);
  if (resolved.size === 0 && errors.length === 0) errors.push({ code: 'EMPTY_SCOPE', message: 'Select at least one door, floor or access template.' });

  if (t && t.allowedJobRoles.length && !t.allowedJobRoles.includes(input.jobRole))
    errors.push({ code: 'TEMPLATE_NOT_ALLOWED', message: `Template "${t.name}" is not allowed for the role ${input.jobRole}.` });

  const isBroad = Boolean(t?.isBroad) || resolved.size >= policy.broadDoorThreshold;
  const maxH = Math.min(policy.maxValidityHours, t?.maxValidityHours ?? Infinity, isBroad ? policy.broadMaxValidityHours : Infinity);
  const hours = (input.expiresAt.getTime() - input.startsAt.getTime()) / 3_600_000;
  if (!(input.expiresAt > input.startsAt)) errors.push({ code: 'INVALID_VALIDITY', message: 'Expiry must be after the start time.' });
  if (input.expiresAt <= input.now) errors.push({ code: 'INVALID_VALIDITY', message: 'Expiry must be in the future.' });
  if (hours > maxH + 1e-9) errors.push({ code: 'VALIDITY_TOO_LONG', message: `Validity ${hours.toFixed(1)} h exceeds the ${maxH} h allowed for this ${isBroad ? 'broad-access ' : ''}key.` });
  if (input.startsAt.getTime() - input.now.getTime() > policy.maxFutureStartDays * 86_400_000)
    errors.push({ code: 'START_TOO_FAR', message: `Start time can be at most ${policy.maxFutureStartDays} days ahead.` });

  return {
    ok: errors.length === 0,
    errors,
    resolvedDoorIds: [...resolved].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    isBroad,
    requiresApproval: isBroad && policy.requireApprovalForBroad,
    timeSchedule: t?.timeSchedule ?? null,
    maxValidityHours: maxH,
  };
}
