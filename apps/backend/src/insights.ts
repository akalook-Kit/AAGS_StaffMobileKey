import { VL } from '@smk/shared/node';
import { pool, one, many } from './db.ts';
import { getConfig } from './hotel-config.ts';
import { maintenancePolicy } from './maintenance.ts';
import { EVENT_NAMES } from './visionline-events.ts';

/**
 * Management reports ("Insights"). Everything is computed from what the platform already holds:
 * its own keys and audit, lock events and battery readings from the connector's Visionline watch, maintenance
 * requests, and, when the hotel switches it on, the read-only Visionline directory snapshot (people, valid
 * keycards, lock alarms). Slicers: period (days), Visionline user group, door group (floor).
 */
export interface InsightFilters { days: number; group: string | null; floor: string | null }

const DAY = 86_400_000;
const VALID = `NOT (k.cancelled OR k.discarded OR k.overridden OR k.expired)`;
const LIVE_KEYS = `('ISSUING','ISSUED','REVOKING')`;

export async function insights(hotelId: string, f: InsightFilters) {
  const to = new Date();
  const from = new Date(to.getTime() - f.days * DAY);
  const prevFrom = new Date(from.getTime() - f.days * DAY);
  const bucket = f.days > 45 ? 'week' : 'day';
  const [features, policy, vlCfg] = await Promise.all([getConfig(pool, hotelId, 'features'), maintenancePolicy(pool, hotelId), getConfig(pool, hotelId, 'visionline')]);

  // Door scope for the floor slicer (null = every door).
  const floorDoors: string[] | null = f.floor
    ? (await many(pool, `SELECT external_id FROM resources WHERE hotel_id=$1 AND kind='door' AND active AND data->>'doorGroup'=$2`, [hotelId, f.floor])).map((r) => r.external_id)
    : null;
  const doorRows = await many(pool, `SELECT external_id, name, data->>'doorGroup' AS g, data->>'doorID' AS vid FROM resources WHERE hotel_id=$1 AND kind='door'`, [hotelId]);
  const doorNames = new Map(doorRows.map((d) => [d.external_id as string, { name: d.name as string, group: d.g as string | null }]));
  // Lock events carry Visionline's numeric doorID, which can differ from the door's id in the door list.
  const byVid = new Map(doorRows.filter((d) => d.vid).map((d) => [String(d.vid), d.external_id as string]));
  const doorIn = (id: string | null) => !floorDoors || (id != null && floorDoors.includes(id));
  // Staff scope for the user-group slicer.
  const staffGroup = f.group;

  // ---- keys -------------------------------------------------------------------------------------
  const kp = [hotelId, from, to, staffGroup];
  const keyScope = `k.hotel_id=$1 AND ($4::text IS NULL OR s.visionline_user_group=$4)`;
  const keys = await one(pool, `SELECT
      count(*) FILTER (WHERE k.status IN ${LIVE_KEYS})::int AS active,
      count(*) FILTER (WHERE k.status='SCHEDULED')::int AS scheduled,
      count(*) FILTER (WHERE k.status='PENDING_APPROVAL')::int AS awaiting,
      count(*) FILTER (WHERE k.credential_id IS NOT NULL AND k.created_at BETWEEN $2 AND $3)::int AS issued,
      count(*) FILTER (WHERE k.status IN ('REVOKED','EXPIRED') AND k.updated_at BETWEEN $2 AND $3)::int AS ended,
      count(*) FILTER (WHERE k.status='FAILED' AND k.updated_at BETWEEN $2 AND $3)::int AS failed,
      count(*) FILTER (WHERE k.status IN ${LIVE_KEYS} AND k.expires_at < now() + interval '24 hours')::int AS expiring24h,
      COALESCE(sum(k.wrong_door_count) FILTER (WHERE k.updated_at BETWEEN $2 AND $3), 0)::int AS wrong_door
    FROM key_requests k JOIN staff s ON s.id=k.staff_id WHERE ${keyScope}`, kp);
  const keysPrev = await one(pool, `SELECT count(*) FILTER (WHERE k.credential_id IS NOT NULL AND k.created_at BETWEEN $2 AND $3)::int AS issued
    FROM key_requests k JOIN staff s ON s.id=k.staff_id WHERE ${keyScope}`, [hotelId, prevFrom, from, staffGroup]);
  const staff = await one(pool, `SELECT count(*)::int AS total,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM endpoints e WHERE e.staff_id=s.id AND e.status='ACTIVE'))::int AS with_phone
    FROM staff s WHERE s.hotel_id=$1 AND s.status='ACTIVE' AND ($2::text IS NULL OR s.visionline_user_group=$2)`, [hotelId, staffGroup]);
  const byDepartment = await many(pool, `SELECT s.job_role AS department, count(DISTINCT s.id)::int AS staff,
      count(DISTINCT s.id) FILTER (WHERE EXISTS (SELECT 1 FROM endpoints e WHERE e.staff_id=s.id AND e.status='ACTIVE'))::int AS with_phone,
      count(k.id) FILTER (WHERE k.status IN ${LIVE_KEYS})::int AS active_keys,
      count(k.id) FILTER (WHERE k.credential_id IS NOT NULL AND k.created_at BETWEEN $2 AND $3)::int AS issued
    FROM staff s LEFT JOIN key_requests k ON k.staff_id=s.id
    WHERE s.hotel_id=$1 AND s.status='ACTIVE' AND ($4::text IS NULL OR s.visionline_user_group=$4)
    GROUP BY s.job_role ORDER BY active_keys DESC, staff DESC`, kp);
  const revokeSources = await many(pool, `SELECT COALESCE(k.revoke_source, CASE WHEN k.status='EXPIRED' THEN 'expired' ELSE 'other' END) AS source, count(*)::int AS n
    FROM key_requests k JOIN staff s ON s.id=k.staff_id WHERE ${keyScope} AND k.status IN ('REVOKED','EXPIRED') AND k.updated_at BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 2 DESC`, kp);
  const failures = await many(pool, `SELECT COALESCE(k.failure_code,'UNKNOWN') AS code, count(*)::int AS n FROM key_requests k JOIN staff s ON s.id=k.staff_id
    WHERE ${keyScope} AND k.status='FAILED' AND k.updated_at BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, kp);
  const byTemplate = await many(pool, `SELECT COALESCE(t.name, 'Custom doors') AS template, count(*)::int AS n FROM key_requests k JOIN staff s ON s.id=k.staff_id
    LEFT JOIN access_templates t ON t.id=k.template_id WHERE ${keyScope} AND k.credential_id IS NOT NULL AND k.created_at BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, kp);

  // ---- Visionline snapshot: people and valid keycards per user group ---------------------------
  const lastSync = await one(pool, `SELECT id, started_at, finished_at, status, users, cards, alarms, notes, error FROM directory_syncs WHERE hotel_id=$1 ORDER BY started_at DESC LIMIT 1`, [hotelId]);
  const lastGood = await one(pool, `SELECT finished_at FROM directory_syncs WHERE hotel_id=$1 AND status='SUCCEEDED' ORDER BY started_at DESC LIMIT 1`, [hotelId]);
  const groups = await many(pool, `SELECT COALESCE(u.user_group,'(no group)') AS user_group, count(DISTINCT u.user_id)::int AS people,
      count(DISTINCT k.reg_no) FILTER (WHERE ${VALID})::int AS valid_cards,
      count(DISTINCT k.reg_no) FILTER (WHERE ${VALID} AND k.key_id IS NOT NULL)::int AS mobile_keys,
      count(DISTINCT u.user_id) FILTER (WHERE k.reg_no IS NULL)::int AS people_without_card,
      count(DISTINCT k.reg_no) FILTER (WHERE ${VALID} AND k.expires_at < now() + interval '7 days')::int AS expiring7d
    FROM vl_users u LEFT JOIN vl_cards k ON k.hotel_id=u.hotel_id AND k.card_holder=u.user_id AND k.active
    WHERE u.hotel_id=$1 AND u.active AND ($2::text IS NULL OR u.user_group=$2) GROUP BY 1 ORDER BY valid_cards DESC, people DESC`, [hotelId, staffGroup]);
  const cardTotals = await one(pool, `SELECT count(*) FILTER (WHERE ${VALID})::int AS valid,
      count(*) FILTER (WHERE ${VALID} AND k.key_id IS NOT NULL)::int AS mobile,
      count(*) FILTER (WHERE ${VALID} AND k.expires_at < now() + interval '7 days')::int AS expiring7d,
      count(*) FILTER (WHERE ${VALID} AND k.not_issued)::int AS not_encoded,
      count(*) FILTER (WHERE ${VALID} AND k.door_count >= 15)::int AS broad,
      count(*) FILTER (WHERE ${VALID} AND k.expires_at > now() + interval '180 days')::int AS long_validity
    FROM vl_cards k WHERE k.hotel_id=$1 AND k.active AND ($2::text IS NULL OR k.user_group=$2)`, [hotelId, staffGroup]);
  const cardTrend = await many(pool, `SELECT s.finished_at AS at, sum(c.valid_cards)::int AS valid_cards, sum(c.users)::int AS people
    FROM directory_syncs s JOIN vl_card_counts c ON c.sync_id=s.id WHERE s.hotel_id=$1 AND s.status='SUCCEEDED' AND s.finished_at > now() - interval '120 days'
      AND ($2::text IS NULL OR c.user_group=$2) GROUP BY s.id ORDER BY s.finished_at`, [hotelId, staffGroup]);

  // ---- locks: alarms and refused doors per door -------------------------------------------------
  const vlAlarms = await many(pool, `SELECT door_id, door_raw, COALESCE(type_name, alarm_type, 'Alarm') AS type, completed, alarm_at FROM vl_alarms
    WHERE hotel_id=$1 AND alarm_at BETWEEN $2 AND $3`, [hotelId, from, to]);
  const openAlarms = (await one(pool, `SELECT count(*)::int AS n FROM vl_alarms WHERE hotel_id=$1 AND NOT completed AND alarm_at > now() - interval '90 days'`, [hotelId])).n;
  const prevAlarms = (await one(pool, `SELECT count(*)::int AS n FROM vl_alarms WHERE hotel_id=$1 AND alarm_at BETWEEN $2 AND $3`, [hotelId, prevFrom, from])).n;
  const events = await many(pool, `SELECT door_id, event_code, count(*)::int AS n FROM visionline_events WHERE hotel_id=$1 AND kind='event' AND received_at BETWEEN $2 AND $3 GROUP BY 1,2`, [hotelId, from, to]);
  const denialCodes = new Set<number>(VL.denialEventCodes as readonly number[]);
  const perDoor = new Map<string, { alarms: number; denials: number; battery: number; open: number }>();
  const resolveEventDoor = (raw: string | null) => {
    if (!raw) return null;
    if (doorNames.has(raw)) return raw;
    if (byVid.has(raw)) return byVid.get(raw)!;
    for (const [id, d] of doorNames) if (d.name === raw) return id;
    return raw;
  };
  const bump = (door: string | null, k: 'alarms' | 'denials' | 'battery', n = 1, open = false) => {
    if (!door || !doorIn(door)) return;
    const d = perDoor.get(door) ?? { alarms: 0, denials: 0, battery: 0, open: 0 };
    d[k] += n; if (open) d.open += n;
    perDoor.set(door, d);
  };
  const alarmTypes = new Map<string, number>();
  for (const a of vlAlarms) {
    const door = a.door_id ?? resolveEventDoor(a.door_raw);
    if (!doorIn(door)) continue;
    bump(door, 'alarms', 1, !a.completed);
    alarmTypes.set(a.type, (alarmTypes.get(a.type) ?? 0) + 1);
  }
  let denials = 0;
  const denialTypes = new Map<string, number>();
  for (const e of events) {
    const door = resolveEventDoor(e.door_id);
    if (denialCodes.has(e.event_code)) {
      if (!doorIn(door)) continue;
      bump(door, 'denials', e.n); denials += e.n;
      const name = EVENT_NAMES[e.event_code] ?? `Event ${e.event_code}`;
      denialTypes.set(name, (denialTypes.get(name) ?? 0) + e.n);
    } else if ((VL.batteryEventCodes as readonly number[]).includes(e.event_code)) bump(door, 'battery', e.n);
  }
  const lockRows = [...perDoor.entries()].map(([id, v]) => ({ doorId: id, name: doorNames.get(id)?.name ?? id, group: doorNames.get(id)?.group ?? null, ...v, total: v.alarms + v.denials + v.battery }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, undefined, { numeric: true }));

  // ---- batteries: which locks drain fast and which do well -------------------------------------
  const battery = await batteryInsights(hotelId, floorDoors, doorNames, policy.battery.staleAfterDays);

  // ---- maintenance ------------------------------------------------------------------------------
  const maintFloor = floorDoors ? 'AND t.door_id = ANY($4)' : '';
  const mp: unknown[] = [hotelId, from, to, ...(floorDoors ? [floorDoors] : [])];
  const maint = await one(pool, `SELECT
      count(*) FILTER (WHERE t.status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','ON_HOLD'))::int AS open,
      count(*) FILTER (WHERE t.status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','ON_HOLD') AND t.due_at < now())::int AS overdue,
      count(*) FILTER (WHERE t.status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','ON_HOLD') AND t.assignee_staff_id IS NULL)::int AS unassigned,
      count(*) FILTER (WHERE t.created_at BETWEEN $2 AND $3)::int AS created,
      count(*) FILTER (WHERE t.resolved_at BETWEEN $2 AND $3)::int AS resolved,
      round(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600) FILTER (WHERE t.resolved_at BETWEEN $2 AND $3)::numeric, 1)::float AS avg_hours,
      count(*) FILTER (WHERE t.resolved_at BETWEEN $2 AND $3 AND t.due_at IS NOT NULL AND t.resolved_at <= t.due_at)::int AS on_time
    FROM maintenance_tickets t WHERE t.hotel_id=$1 ${maintFloor}`, mp);
  const maintPrev = (await one(pool, `SELECT count(*)::int AS n FROM maintenance_tickets t WHERE t.hotel_id=$1 AND t.created_at BETWEEN $2 AND $3 ${floorDoors ? 'AND t.door_id = ANY($4)' : ''}`,
    [hotelId, prevFrom, from, ...(floorDoors ? [floorDoors] : [])])).n;
  const maintByCategory = await many(pool, `SELECT t.category, count(*)::int AS created,
      count(*) FILTER (WHERE t.status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','ON_HOLD'))::int AS open,
      round(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600) FILTER (WHERE t.resolved_at IS NOT NULL)::numeric, 1)::float AS avg_hours
    FROM maintenance_tickets t WHERE t.hotel_id=$1 AND (t.created_at BETWEEN $2 AND $3 OR t.status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','ON_HOLD')) ${maintFloor}
    GROUP BY 1 ORDER BY created DESC`, mp);
  const maintByStatus = await many(pool, `SELECT t.status, count(*)::int AS n FROM maintenance_tickets t WHERE t.hotel_id=$1 AND t.status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','ON_HOLD') ${floorDoors ? 'AND t.door_id = ANY($2)' : ''} GROUP BY 1`,
    [hotelId, ...(floorDoors ? [floorDoors] : [])]);
  const workload = await many(pool, `SELECT COALESCE(s.full_name, 'Unassigned') AS person,
      count(*) FILTER (WHERE t.status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','ON_HOLD'))::int AS open,
      count(*) FILTER (WHERE t.status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','ON_HOLD') AND t.due_at < now())::int AS overdue,
      count(*) FILTER (WHERE t.resolved_at BETWEEN $2 AND $3)::int AS resolved,
      round(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600) FILTER (WHERE t.resolved_at BETWEEN $2 AND $3)::numeric, 1)::float AS avg_hours
    FROM maintenance_tickets t LEFT JOIN staff s ON s.id=t.assignee_staff_id WHERE t.hotel_id=$1 ${maintFloor}
    GROUP BY 1 HAVING count(*) FILTER (WHERE t.status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','ON_HOLD')) > 0 OR count(*) FILTER (WHERE t.resolved_at BETWEEN $2 AND $3) > 0
    ORDER BY open DESC, resolved DESC LIMIT 12`, mp);

  // ---- trends (one bucket per day, or per week for long periods) --------------------------------
  // Buckets are days (or weeks) in the hotel's own time zone.
  const tz = (await getConfig(pool, hotelId, 'property'))?.timezone ?? 'UTC';
  const L = (col: string) => `date_trunc('${bucket}', ${col} AT TIME ZONE $7)`;
  const series = await many(pool, `WITH b AS (SELECT generate_series(date_trunc('${bucket}', $2::timestamptz AT TIME ZONE $7), date_trunc('${bucket}', $3::timestamptz AT TIME ZONE $7), interval '1 ${bucket}') AS t)
    SELECT to_char(b.t, 'YYYY-MM-DD') AS t,
      (SELECT count(*) FROM key_requests k JOIN staff s ON s.id=k.staff_id WHERE k.hotel_id=$1 AND ($4::text IS NULL OR s.visionline_user_group=$4) AND k.credential_id IS NOT NULL AND ${L('k.created_at')}=b.t)::int AS keys_issued,
      (SELECT count(*) FROM key_requests k JOIN staff s ON s.id=k.staff_id WHERE k.hotel_id=$1 AND ($4::text IS NULL OR s.visionline_user_group=$4) AND k.status IN ('REVOKED','EXPIRED') AND ${L('k.updated_at')}=b.t)::int AS keys_ended,
      (SELECT count(*) FROM vl_alarms a WHERE a.hotel_id=$1 AND ${L('a.alarm_at')}=b.t AND ($5::text[] IS NULL OR a.door_id = ANY($5)))::int AS alarms,
      (SELECT count(*) FROM visionline_events e WHERE e.hotel_id=$1 AND e.kind='event' AND e.event_code = ANY($6) AND ($5::text[] IS NULL OR e.door_id = ANY($5)) AND ${L('e.received_at')}=b.t)::int AS denials,
      (SELECT count(*) FROM maintenance_tickets t WHERE t.hotel_id=$1 AND ${L('t.created_at')}=b.t AND ($5::text[] IS NULL OR t.door_id = ANY($5)))::int AS maint_created,
      (SELECT count(*) FROM maintenance_tickets t WHERE t.hotel_id=$1 AND ${L('t.resolved_at')}=b.t AND ($5::text[] IS NULL OR t.door_id = ANY($5)))::int AS maint_resolved
    FROM b ORDER BY b.t`, [hotelId, from, to, staffGroup, floorDoors, [...denialCodes], tz]);

  const floors = (await many(pool, `SELECT DISTINCT data->>'doorGroup' AS g FROM resources WHERE hotel_id=$1 AND kind='door' AND active AND data->>'doorGroup' IS NOT NULL`, [hotelId]))
    .map((r) => r.g as string).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const userGroupOptions = [...new Set([...(vlCfg?.userGroups ?? []),
    ...(await many(pool, `SELECT DISTINCT user_group FROM vl_users WHERE hotel_id=$1 AND active AND user_group IS NOT NULL`, [hotelId])).map((r) => r.user_group as string),
    ...(await many(pool, `SELECT DISTINCT visionline_user_group FROM staff WHERE hotel_id=$1 AND visionline_user_group IS NOT NULL`, [hotelId])).map((r) => r.visionline_user_group as string)])].sort();

  return {
    period: { from, to, days: f.days, bucket, timeZone: tz },
    filters: { group: f.group, floor: f.floor, floors, userGroups: userGroupOptions },
    modules: { battery: Boolean(features?.batteryMonitoring), maintenance: Boolean(features?.maintenance), directorySync: Boolean(vlCfg?.directorySync?.enabled) },
    sync: lastSync ? { status: lastSync.status, startedAt: lastSync.started_at, finishedAt: lastSync.finished_at, lastSuccessAt: lastGood?.finished_at ?? null,
      users: lastSync.users, cards: lastSync.cards, alarms: lastSync.alarms, notes: lastSync.notes, error: lastSync.error } : null,
    kpis: {
      activeMobileKeys: keys.active, scheduledKeys: keys.scheduled, awaitingApproval: keys.awaiting, keysIssued: keys.issued, keysIssuedPrev: keysPrev.issued,
      keysEnded: keys.ended, keysFailed: keys.failed, expiring24h: keys.expiring24h, wrongDoor: keys.wrong_door,
      staff: staff.total, staffWithPhone: staff.with_phone,
      validCards: lastGood ? cardTotals.valid : null, validMobile: lastGood ? cardTotals.mobile : null,
      lockAlarms: vlAlarms.filter((a) => doorIn(a.door_id ?? resolveEventDoor(a.door_raw))).length, lockAlarmsPrev: prevAlarms, openLockAlarms: openAlarms, refusedAtDoors: denials,
      batteryCritical: battery.states.CRITICAL, batteryLow: battery.states.LOW,
      maintOpen: maint.open, maintOverdue: maint.overdue, maintUnassigned: maint.unassigned, maintCreated: maint.created, maintCreatedPrev: maintPrev,
      maintResolved: maint.resolved, maintAvgHours: maint.avg_hours, maintOnTime: maint.on_time,
    },
    trend: series.map((r) => ({ t: r.t, keysIssued: r.keys_issued, keysEnded: r.keys_ended, alarms: r.alarms, denials: r.denials, maintCreated: r.maint_created, maintResolved: r.maint_resolved })),
    keys: {
      byDepartment: byDepartment.map((d) => ({ department: d.department, staff: d.staff, withPhone: d.with_phone, activeKeys: d.active_keys, issued: d.issued })),
      revokeSources: revokeSources.map((r) => ({ source: r.source, n: r.n })), failures: failures.map((r) => ({ code: r.code, n: r.n })), byTemplate: byTemplate.map((r) => ({ template: r.template, n: r.n })),
    },
    cards: lastGood ? {
      totals: { valid: cardTotals.valid, mobile: cardTotals.mobile, other: cardTotals.valid - cardTotals.mobile, expiring7d: cardTotals.expiring7d, notEncoded: cardTotals.not_encoded, broad: cardTotals.broad, longValidity: cardTotals.long_validity },
      byGroup: groups.map((g) => ({ group: g.user_group, people: g.people, validCards: g.valid_cards, mobileKeys: g.mobile_keys, otherCards: g.valid_cards - g.mobile_keys, peopleWithoutCard: g.people_without_card, expiring7d: g.expiring7d })),
      trend: cardTrend.map((r) => ({ at: r.at, validCards: r.valid_cards, people: r.people })),
    } : null,
    locks: { byDoor: lockRows.slice(0, 15), alarmTypes: [...alarmTypes.entries()].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n),
      denialTypes: [...denialTypes.entries()].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n), doorsWithActivity: lockRows.length },
    battery,
    maintenance: { byCategory: maintByCategory, byStatus: maintByStatus, workload },
  };
}

/**
 * Battery life per lock from its own reports. A "cycle" starts at a battery exchange (528/535/536, or a
 * technician's "battery replaced") and ends at the next exchange. Life = days from the exchange to the first
 * Low/Critical report. Doors are ranked by how fast they reach Low (fewest days) and how often they alarm.
 */
export async function batteryInsights(hotelId: string, floorDoors: string[] | null, doorNames: Map<string, { name: string; group: string | null }>, staleAfterDays: number) {
  const status = await many(pool, `SELECT door_id, state, reported_at, volts_below FROM battery_status WHERE hotel_id=$1`, [hotelId]);
  const readings = await many(pool, `SELECT door_id, event_code, state, volts_below, reported_at FROM battery_readings WHERE hotel_id=$1 AND reported_at > now() - interval '730 days' ORDER BY door_id, reported_at`, [hotelId]);
  const alerts = await many(pool, `SELECT door_id, count(*)::int AS n FROM battery_alerts WHERE hotel_id=$1 AND opened_at > now() - interval '90 days' GROUP BY 1`, [hotelId]);
  const alerts90 = new Map(alerts.map((a) => [a.door_id as string, a.n as number]));
  const inScope = (id: string) => !floorDoors || floorDoors.includes(id);
  const known = [...doorNames.keys()].filter(inScope);
  const states: Record<string, number> = { CRITICAL: 0, LOW: 0, GOOD: 0, REPORTED: 0, NEVER: 0, STALE: 0 };
  const statusBy = new Map(status.map((s) => [s.door_id as string, s]));
  const staleBefore = Date.now() - staleAfterDays * DAY;
  for (const id of known) {
    const s = statusBy.get(id);
    states[s ? s.state : 'NEVER']!++;
    if (s && new Date(s.reported_at).getTime() < staleBefore) states.STALE!++;
  }

  const exchangedCodes = new Set<number>([...(VL.batteryEvents.exchanged as readonly number[]), 0]);
  const byDoor = new Map<string, any[]>();
  for (const r of readings) if (inScope(r.door_id)) byDoor.set(r.door_id, [...(byDoor.get(r.door_id) ?? []), r]);
  const lives: number[] = [];
  const doors = [...byDoor.entries()].map(([id, rs]) => {
    const cycles: { start: Date | null; firstLow: Date | null }[] = [];
    let cur: { start: Date | null; firstLow: Date | null } = { start: null, firstLow: null };
    let volts: { t: number; v: number }[] = [];
    let lastSlope: number | null = null;
    for (const r of rs) {
      const t = new Date(r.reported_at);
      if (exchangedCodes.has(r.event_code) && r.state === 'GOOD') {
        if (cur.start || cur.firstLow) cycles.push(cur);
        cur = { start: t, firstLow: null }; volts = [];
        continue;
      }
      if ((r.state === 'LOW' || r.state === 'CRITICAL') && !cur.firstLow) cur.firstLow = t;
      if (r.volts_below != null) volts.push({ t: t.getTime(), v: Number(r.volts_below) });
    }
    cycles.push(cur);
    if (volts.length >= 2) {
      const a = volts[0]!, b = volts[volts.length - 1]!;
      if (b.t > a.t) lastSlope = Math.round(((b.v - a.v) / ((b.t - a.t) / (30 * DAY))) * 100) / 100; // volts per 30 days
    }
    const done = cycles.filter((c) => c.start && c.firstLow).map((c) => Math.round((c.firstLow!.getTime() - c.start!.getTime()) / DAY));
    lives.push(...done);
    const last = cycles[cycles.length - 1]!;
    return {
      doorId: id, name: doorNames.get(id)?.name ?? id, group: doorNames.get(id)?.group ?? null,
      state: (statusBy.get(id)?.state as string) ?? 'NEVER', lastExchange: last.start, lowSince: last.firstLow,
      lifeDays: done.length ? done[done.length - 1]! : null, avgLifeDays: done.length ? Math.round(done.reduce((x, y) => x + y, 0) / done.length) : null, cycles: done.length,
      alarms90: alerts90.get(id) ?? 0, reports: rs.length, voltsPer30d: lastSlope,
      daysSinceExchange: last.start ? Math.round((Date.now() - last.start.getTime()) / DAY) : null,
    };
  });
  lives.sort((a, b) => a - b);
  const median = lives.length ? lives[Math.floor(lives.length / 2)]! : null;
  for (const d of doors as any[]) {
    // Expected next "low" for a door that has not reached it yet in its current cycle.
    d.predictedLowAt = d.lastExchange && !d.lowSince && (d.avgLifeDays ?? median) ? new Date(new Date(d.lastExchange).getTime() + (d.avgLifeDays ?? median) * DAY) : null;
  }
  // Fast drainers: shortest life, or repeated alarms within 90 days, or a steep voltage drop.
  const draining = (doors as any[]).filter((d) => (d.lifeDays != null && median != null && d.lifeDays < median * 0.75) || d.alarms90 >= 2 || (d.voltsPer30d != null && d.voltsPer30d <= -0.4)
    || ((d.state === 'LOW' || d.state === 'CRITICAL') && d.daysSinceExchange != null && median != null && d.daysSinceExchange < median * 0.75))
    .sort((a, b) => (a.lifeDays ?? a.daysSinceExchange ?? 9999) - (b.lifeDays ?? b.daysSinceExchange ?? 9999) || b.alarms90 - a.alarms90).slice(0, 12);
  const drainingIds = new Set(draining.map((d) => d.doorId));
  // Doing well: longest time since the last exchange without a low report, and no alarms in 90 days.
  const healthy = (doors as any[]).filter((d) => !drainingIds.has(d.doorId) && d.alarms90 === 0 && !d.lowSince && d.daysSinceExchange != null && d.state === 'GOOD')
    .sort((a, b) => (b.daysSinceExchange ?? 0) - (a.daysSinceExchange ?? 0)).slice(0, 12);
  // Expected to reach "low" within the next 30 days (or in the last two weeks without having reported it yet).
  const dueSoon = (doors as any[]).filter((d) => d.predictedLowAt && !drainingIds.has(d.doorId)
      && new Date(d.predictedLowAt).getTime() < Date.now() + 30 * DAY && new Date(d.predictedLowAt).getTime() > Date.now() - 14 * DAY)
    .sort((a, b) => new Date(a.predictedLowAt).getTime() - new Date(b.predictedLowAt).getTime()).slice(0, 12);
  return { states, doorsTracked: known.length, medianLifeDays: median, cyclesMeasured: lives.length, draining, healthy, dueSoon };
}
