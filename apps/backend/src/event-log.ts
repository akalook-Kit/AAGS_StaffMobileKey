import { VL } from '@smk/shared/node';
import { pool, many, one } from './db.ts';
import { getConfig } from './hotel-config.ts';
import { EVENT_NAMES } from './visionline-events.ts';
import { batteryEventName, isBatteryEvent } from './battery.ts';

/**
 * Event log (2.6): one time-ordered list of everything that happened at the doors and in the platform.
 *
 *   class      entrances = doors opened (lock events in the hotel's entrance codes, first use of a mobile key)
 *              errors    = severity error or warning (refused entries, lock alarms, battery low/critical, failed keys,
 *                          failed connector commands)
 *              all       = everything, including card changes and key life cycle
 *   category   entrance | refused | alarm | battery | card | key | system | lock (any other lock event)
 *
 * Sources: lock events and card changes from the connector's Visionline watch (visionline_events), Visionline alarms
 * from the directory read (vl_alarms), key life cycle from the audit trail, failed connector commands.
 */
export const CATEGORIES = ['entrance', 'refused', 'alarm', 'battery', 'card', 'key', 'system', 'lock'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABELS: Record<Category, string> = {
  entrance: 'Entrance', refused: 'Refused entry', alarm: 'Lock alarm', battery: 'Battery', card: 'Card change', key: 'Mobile key', system: 'System error', lock: 'Other lock event',
};
export type EventClass = 'all' | 'entrances' | 'errors';
export interface EventFilter { from: Date; to: Date; cls: EventClass; categories: Category[] | null; door: string | null; q: string | null; limit: number }
export interface EventRow {
  id: string; at: string; category: Category; severity: 'error' | 'warning' | 'info'; code: number | null; event: string;
  door: string | null; doorId: string | null; person: string | null; card: string | null; source: string; detail: string | null;
}

const TASK_NAMES: Record<string, string> = {
  ISSUE_STAFF_KEY: 'issue a mobile key', REVOKE_STAFF_KEY: 'remove a mobile key', DISCOVER_RESOURCES: 'read doors from Visionline', VALIDATE_SETUP: 'check the Visionline setup',
  SET_PROPERTY_CREDENTIALS: 'change the Visionline credentials', VERIFY_OPERATOR_CREDENTIALS: "check an operator's Visionline credentials", CREATE_USER_GROUP: 'create a user group',
  SYNC_DIRECTORY: 'read people and keycards',
};
const CARD_STATUS: Record<number, string> = { 0: 'Card cancelled in Visionline', 1: 'Card valid', 2: 'Card overridden by a newer card', 3: 'Card not issued', 4: 'Card expired', 5: 'Card overwritten', 6: 'Card discarded' };
const KEY_ACTIONS: Record<string, { event: string; severity: EventRow['severity']; category: Category }> = {
  'key.created_in_visionline': { event: 'Mobile key issued', severity: 'info', category: 'key' },
  'key.failed': { event: 'Mobile key could not be issued', severity: 'error', category: 'key' },
  'key.revoke_failed': { event: 'Mobile key could not be removed', severity: 'error', category: 'key' },
  'key.revoke_confirmed_by_visionline': { event: 'Mobile key removed', severity: 'info', category: 'key' },
  'key.expired': { event: 'Mobile key expired', severity: 'info', category: 'key' },
  'key.overridden_in_visionline': { event: 'Mobile key replaced in Visionline', severity: 'info', category: 'key' },
  'key.wrong_door_limit_reached': { event: 'Card cancelled after repeated wrong-door attempts', severity: 'warning', category: 'key' },
  'key.first_use_at_door': { event: 'Door opened with mobile key (first use)', severity: 'info', category: 'entrance' },
};

export async function eventLogContext(hotelId: string) {
  const [policy, property, hotel] = await Promise.all([getConfig(pool, hotelId, 'policy'), getConfig(pool, hotelId, 'property'), one(pool, 'SELECT timezone FROM hotels WHERE id=$1', [hotelId])]);
  const entranceCodes: number[] = policy?.eventLog?.entranceEventCodes ?? [64];
  return { tz: (property?.timezone ?? hotel?.timezone ?? 'UTC') as string, entranceCodes };
}

export async function queryEvents(hotelId: string, f: EventFilter) {
  const { tz, entranceCodes } = await eventLogContext(hotelId);
  const denial = [...VL.denialEventCodes, 53];
  const batteryAlarm = [...VL.batteryEvents.low, ...VL.batteryEvents.critical];
  const batteryCritical = [...VL.batteryEvents.critical];
  const all = `
    WITH doors AS (SELECT external_id, name FROM resources WHERE hotel_id=$1 AND kind='door'),
    ev AS (
      SELECT 'v' || e.id AS id,
        COALESCE(CASE WHEN e.event_time ~ '^\\d{8}T\\d{4}' THEN (to_timestamp(substr(e.event_time, 1, 13), 'YYYYMMDD"T"HH24MI')::timestamp AT TIME ZONE $4) END, e.received_at) AS at,
        CASE WHEN e.event_code = ANY($5::int[]) THEN 'entrance' WHEN e.event_code = ANY($6::int[]) THEN 'refused'
             WHEN e.event_code = ANY($7::int[]) OR e.event_code = ANY($10::int[]) OR e.event_code BETWEEN ${VL.batteryEvents.voltageFrom} AND ${VL.batteryEvents.voltageTo} THEN 'battery'
             ELSE 'lock' END AS category,
        CASE WHEN e.event_code = ANY($6::int[]) OR e.event_code = ANY($8::int[]) THEN 'error' WHEN e.event_code = ANY($7::int[]) THEN 'warning' ELSE 'info' END AS severity,
        e.event_code AS code, NULL::text AS event, e.door_id AS door_ref, e.registration_number AS card,
        COALESCE(s.full_name, (SELECT NULLIF(trim(coalesce(u.given_name, '') || ' ' || coalesce(u.surname, '')), '') FROM vl_cards vc JOIN vl_users u ON u.hotel_id=vc.hotel_id AND u.user_id=vc.card_holder
          WHERE vc.hotel_id=e.hotel_id AND vc.reg_no=e.registration_number LIMIT 1)) AS person,
        'Lock (Visionline)' AS source, NULL::text AS detail
      FROM visionline_events e LEFT JOIN key_requests k ON k.id=e.key_id LEFT JOIN staff s ON s.id=k.staff_id
      WHERE e.hotel_id=$1 AND e.kind='event' AND e.received_at BETWEEN $2::timestamptz - interval '2 days' AND $3::timestamptz + interval '2 days'
      UNION ALL
      SELECT 'c' || e.id, e.received_at, 'card', CASE WHEN e.card_status IN (0, 6) THEN 'warning' ELSE 'info' END, e.card_status, NULL, NULL, e.registration_number,
        COALESCE(s.full_name, (SELECT NULLIF(trim(coalesce(u.given_name, '') || ' ' || coalesce(u.surname, '')), '') FROM vl_cards vc JOIN vl_users u ON u.hotel_id=vc.hotel_id AND u.user_id=vc.card_holder
          WHERE vc.hotel_id=e.hotel_id AND vc.reg_no=e.registration_number LIMIT 1)),
        'Visionline', NULL
      FROM visionline_events e LEFT JOIN key_requests k ON k.id=e.key_id LEFT JOIN staff s ON s.id=k.staff_id
      WHERE e.hotel_id=$1 AND e.kind='card' AND e.received_at BETWEEN $2 AND $3
      UNION ALL
      SELECT 'a' || a.alarm_id, COALESCE(a.alarm_at, a.received_at), 'alarm', CASE WHEN a.completed THEN 'warning' ELSE 'error' END, NULL,
        COALESCE(a.type_name, a.alarm_type, 'Alarm'), COALESCE(a.door_id, a.door_raw), NULL,
        (SELECT NULLIF(trim(coalesce(u.given_name, '') || ' ' || coalesce(u.surname, '')), '') FROM vl_users u WHERE u.hotel_id=a.hotel_id AND u.user_id=a.card_holder),
        'Visionline alarm', CASE WHEN a.completed THEN 'Confirmed' ELSE 'Open' END || COALESCE(' · ' || NULLIF(a.alarm_text, ''), '')
      FROM vl_alarms a WHERE a.hotel_id=$1 AND COALESCE(a.alarm_at, a.received_at) BETWEEN $2 AND $3
      UNION ALL
      SELECT 'k' || l.seq, l.at, CASE WHEN l.action='key.first_use_at_door' THEN 'entrance' ELSE 'key' END, 'info', NULL, l.action,
        CASE WHEN l.action='key.first_use_at_door' THEN l.details->>'door' END, k.card_reg_no, s.full_name,
        CASE WHEN l.action='key.first_use_at_door' THEN 'Mobile key (ASSA ABLOY)' ELSE 'Platform' END,
        COALESCE(l.details->>'reason', l.details->>'message', l.details->'error'->>'message', k.failure_message)
      FROM audit_log l LEFT JOIN key_requests k ON k.id::text=l.target_id LEFT JOIN staff s ON s.id=k.staff_id
      WHERE l.hotel_id=$1 AND l.action = ANY($9::text[]) AND l.at BETWEEN $2 AND $3
      UNION ALL
      SELECT 'x' || c.id, COALESCE(c.completed_at, c.expires_at), 'system', 'error', NULL,
        c.status || ':' || c.type, NULL, NULL, NULL, 'Connector',
        COALESCE(c.error->>'code', '') || COALESCE(' · ' || (c.error->>'message'), '')
      FROM commands c WHERE c.hotel_id=$1 AND c.status IN ('FAILED', 'EXPIRED') AND COALESCE(c.completed_at, c.expires_at) BETWEEN $2 AND $3
    )
    SELECT ev.*, COALESCE(d1.name, d2.name, ev.door_ref) AS door_name, COALESCE(d1.external_id, d2.external_id) AS door_id
    FROM ev LEFT JOIN doors d1 ON d1.external_id=ev.door_ref LEFT JOIN LATERAL (SELECT * FROM doors d WHERE d.name=ev.door_ref LIMIT 1) d2 ON d1.external_id IS NULL
    WHERE ev.at BETWEEN $2 AND $3`;
  const params = [hotelId, f.from, f.to, tz, entranceCodes, denial, batteryAlarm, batteryCritical, Object.keys(KEY_ACTIONS), [...VL.batteryEvents.exchanged]];
  const rows = await many(pool, `${all} ORDER BY ev.at DESC, ev.id DESC`, params);
  const mapped: EventRow[] = rows.map((r) => {
    let category = r.category as string;
    let event = r.event as string | null;
    let severity = r.severity as EventRow['severity'];
    if (r.id.startsWith('v')) event = r.code != null && isBatteryEvent(r.code) ? batteryEventName(r.code) : EVENT_NAMES[r.code] ?? `Lock event ${r.code}`; else if (r.id.startsWith('c')) event = CARD_STATUS[r.code] ?? `Card status ${r.code}`;
    else if (r.id.startsWith('x')) { const [st, type] = String(r.event).split(':'); event = `${st === 'EXPIRED' ? 'Connector did not answer in time' : 'Connector could not'}${st === 'EXPIRED' ? ': ' : ' '}${TASK_NAMES[type!] ?? type}`; }
    else if (r.id.startsWith('k')) { const a = KEY_ACTIONS[r.event]!; event = a.event; severity = a.severity; category = a.category; }
    return {
      id: r.id, at: new Date(r.at).toISOString(), category: category as Category, severity, code: r.code ?? null, event: event ?? '',
      door: r.door_name ?? null, doorId: r.door_id ?? null, person: r.person ?? null, card: r.card && r.card !== '0' ? r.card : null, source: r.source, detail: r.detail ?? null,
    };
  });
  const isErr = (e: EventRow) => e.severity === 'error' || e.severity === 'warning';
  const inClass = (e: EventRow, c: EventClass) => c === 'all' || (c === 'entrances' ? e.category === 'entrance' : isErr(e));
  const q = f.q?.trim().toLowerCase() || null;
  const selected = mapped.filter((e) => (!f.categories || f.categories.includes(e.category))
    && (!f.door || e.doorId === f.door || e.door === f.door)
    && (!q || [e.person, e.card, e.event, e.door, e.detail].some((v) => v?.toLowerCase().includes(q))));
  const counts = { all: selected.length, entrances: selected.filter((e) => inClass(e, 'entrances')).length, errors: selected.filter((e) => inClass(e, 'errors')).length };
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, selected.filter((e) => e.category === c && inClass(e, f.cls)).length]));
  const inCls = selected.filter((e) => inClass(e, f.cls));
  return { tz, counts, byCategory, total: inCls.length, truncated: inCls.length > f.limit, events: inCls.slice(0, f.limit) };
}
