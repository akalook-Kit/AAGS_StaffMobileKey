import { VL } from '@smk/shared/node';
import { pool, many, one } from './db.ts';
import { ApiError } from './lib/errors.ts';
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
export interface EventFilter { from: Date; to: Date; cls: EventClass; categories: Category[] | null; door: string | null; q: string | null; limit: number; match?: 'any' | 'known' | 'unknown'; holder?: string | null; person?: string | null }
export interface EventRow {
  id: string; at: string; category: Category; severity: 'error' | 'warning' | 'info'; code: number | null; event: string;
  door: string | null; doorId: string | null; person: string | null; card: string | null; source: string; detail: string | null; watched: string | null;
  /** 2.12 The keycard behind a lock event: is it known, valid at that moment, whose, which group, who issued it. */
  match: { known: boolean; kind: 'mobile' | 'card' | null; holderId: string | null; group: string | null; validThen: boolean | null; issuedBy: string | null; deadbolt: boolean | null } | null;
}

const TASK_NAMES: Record<string, string> = {
  ISSUE_STAFF_KEY: 'issue a mobile key', REVOKE_STAFF_KEY: 'remove a mobile key', DISCOVER_RESOURCES: 'read doors from Visionline', VALIDATE_SETUP: 'check the Visionline setup',
  SET_PROPERTY_CREDENTIALS: 'change the Visionline credentials', VERIFY_OPERATOR_CREDENTIALS: "check an operator's Visionline credentials", CREATE_USER_GROUP: 'create a user group',
  SYNC_DIRECTORY: 'read people and keycards', READ_CARD: 'read a card at an encoder',
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
  const offlineCodes: number[] = policy?.monitoring?.doorOffline?.offlineEventCodes ?? [];
  const onlineCodes: number[] = policy?.monitoring?.doorOffline?.onlineEventCodes ?? [];
  return { tz: (property?.timezone ?? hotel?.timezone ?? 'UTC') as string, entranceCodes, offlineCodes, onlineCodes };
}

/**
 * 2.13 (security review): everything is filtered, counted and limited in PostgreSQL. Before, a year of events was
 * loaded into the platform's memory for every request (any Event log reader could make it use gigabytes and block
 * for half a minute); now at most `limit` rows leave the database and each query has a time limit.
 */
const KEY_CASE = (col: string, field: 'category' | 'severity') =>
  `CASE ${col} ${Object.entries(KEY_ACTIONS).map(([k, v]) => `WHEN '${k}' THEN '${v[field]}'`).join(' ')} ELSE '${field === 'category' ? 'key' : 'info'}' END`;

export async function queryEvents(hotelId: string, f: EventFilter) {
  const { tz, entranceCodes, offlineCodes, onlineCodes } = await eventLogContext(hotelId);
  const denial = [...VL.denialEventCodes, 53];
  const batteryAlarm = [...VL.batteryEvents.low, ...VL.batteryEvents.critical];
  const batteryCritical = [...VL.batteryEvents.critical];
  const params: unknown[] = [hotelId, f.from, f.to, tz, entranceCodes, denial, batteryAlarm, batteryCritical, Object.keys(KEY_ACTIONS), [...VL.batteryEvents.exchanged], offlineCodes];
  // 2.13 Event names are made in the database too, so that searching for "offline" or "battery" finds them.
  const nameCodes = [...new Set([...Object.keys(EVENT_NAMES).map(Number), ...batteryAlarm, ...VL.batteryEvents.exchanged,
    ...Array.from({ length: VL.batteryEvents.voltageTo - VL.batteryEvents.voltageFrom + 1 }, (_, i) => VL.batteryEvents.voltageFrom + i)])].filter((c) => Number.isInteger(c));
  params.push(nameCodes, nameCodes.map((c) => (isBatteryEvent(c) ? batteryEventName(c) : EVENT_NAMES[c] ?? `Lock event ${c}`)), onlineCodes,
    Object.keys(CARD_STATUS).map(Number), Object.values(CARD_STATUS)); // $12..$16
  const base = `
    WITH doormap AS (
      SELECT DISTINCT ON (k) k, external_id, name FROM (
        SELECT external_id AS k, external_id, name, 1 AS pri FROM resources WHERE hotel_id=$1 AND kind='door'
        UNION ALL SELECT data->>'doorID', external_id, name, 2 FROM resources WHERE hotel_id=$1 AND kind='door' AND data->>'doorID' IS NOT NULL
        UNION ALL SELECT name, external_id, name, 3 FROM resources WHERE hotel_id=$1 AND kind='door') m
      ORDER BY k, pri),
    ev AS (
      SELECT 'v' || e.id AS id,
        COALESCE(CASE WHEN e.event_time ~ '^\\d{8}T\\d{4}' THEN (to_timestamp(substr(e.event_time, 1, 13), 'YYYYMMDD"T"HH24MI')::timestamp AT TIME ZONE $4) END, e.received_at) AS at,
        CASE WHEN e.event_code = ANY($5::int[]) THEN 'entrance' WHEN e.event_code = ANY($6::int[]) THEN 'refused'
             WHEN e.event_code = ANY($7::int[]) OR e.event_code = ANY($10::int[]) OR e.event_code BETWEEN ${VL.batteryEvents.voltageFrom} AND ${VL.batteryEvents.voltageTo} THEN 'battery'
             ELSE 'lock' END AS category,
        CASE WHEN e.event_code = ANY($6::int[]) OR e.event_code = ANY($8::int[]) OR e.event_code = ANY($11::int[]) THEN 'error' WHEN e.event_code = ANY($7::int[]) THEN 'warning' ELSE 'info' END AS severity,
        e.event_code AS code,
        CASE WHEN e.event_code = ANY($11::int[]) THEN 'Lock went offline' WHEN e.event_code = ANY($14::int[]) THEN 'Lock back online'
          ELSE COALESCE((SELECT t.n FROM unnest($12::int[], $13::text[]) AS t(c, n) WHERE t.c = e.event_code LIMIT 1), 'Lock event ' || e.event_code) END AS event,
        e.door_id AS door_ref, e.registration_number AS card,
        COALESCE(s.full_name, NULLIF(trim(coalesce(u.given_name, '') || ' ' || coalesce(u.surname, '')), '')) AS person,
        'Lock (Visionline)' AS source, NULL::text AS detail, e.key_id
      FROM visionline_events e LEFT JOIN key_requests k ON k.id=e.key_id LEFT JOIN staff s ON s.id=k.staff_id
        LEFT JOIN vl_cards vcx ON vcx.hotel_id=e.hotel_id AND vcx.reg_no=e.registration_number AND e.registration_number <> '0'
        LEFT JOIN vl_users u ON u.hotel_id=e.hotel_id AND u.user_id=vcx.card_holder
      WHERE e.hotel_id=$1 AND e.kind='event' AND e.received_at BETWEEN $2::timestamptz - interval '2 days' AND $3::timestamptz + interval '2 days'
      UNION ALL
      SELECT 'c' || e.id, e.received_at, 'card', CASE WHEN e.card_status IN (0, 6) THEN 'warning' ELSE 'info' END, e.card_status,
        COALESCE((SELECT t.n FROM unnest($15::int[], $16::text[]) AS t(c, n) WHERE t.c = e.card_status LIMIT 1), 'Card status ' || e.card_status), NULL, e.registration_number,
        COALESCE(s.full_name, NULLIF(trim(coalesce(u.given_name, '') || ' ' || coalesce(u.surname, '')), '')), 'Visionline', NULL, e.key_id
      FROM visionline_events e LEFT JOIN key_requests k ON k.id=e.key_id LEFT JOIN staff s ON s.id=k.staff_id
        LEFT JOIN vl_cards vcx ON vcx.hotel_id=e.hotel_id AND vcx.reg_no=e.registration_number AND e.registration_number <> '0'
        LEFT JOIN vl_users u ON u.hotel_id=e.hotel_id AND u.user_id=vcx.card_holder
      WHERE e.hotel_id=$1 AND e.kind='card' AND e.received_at BETWEEN $2 AND $3
      UNION ALL
      SELECT 'a' || a.alarm_id, COALESCE(a.alarm_at, a.received_at), 'alarm', CASE WHEN a.completed THEN 'warning' ELSE 'error' END, NULL,
        COALESCE(a.type_name, a.alarm_type, 'Alarm'), COALESCE(a.door_id, a.door_raw), NULL,
        NULLIF(trim(coalesce(u.given_name, '') || ' ' || coalesce(u.surname, '')), ''),
        'Visionline alarm', CASE WHEN a.completed THEN 'Confirmed' ELSE 'Open' END || COALESCE(' · ' || NULLIF(a.alarm_text, ''), ''), NULL::uuid
      FROM vl_alarms a LEFT JOIN vl_users u ON u.hotel_id=a.hotel_id AND u.user_id=a.card_holder
      WHERE a.hotel_id=$1 AND COALESCE(a.alarm_at, a.received_at) BETWEEN $2 AND $3
      UNION ALL
      SELECT 'k' || l.seq, l.at, ${KEY_CASE('l.action', 'category')}, ${KEY_CASE('l.action', 'severity')}, NULL, l.action,
        CASE WHEN l.action='key.first_use_at_door' THEN l.details->>'door' END, k.card_reg_no, s.full_name,
        CASE WHEN l.action='key.first_use_at_door' THEN 'Mobile key (ASSA ABLOY)' ELSE 'Platform' END,
        COALESCE(l.details->>'reason', l.details->>'message', l.details->'error'->>'message', k.failure_message), k.id
      FROM audit_log l LEFT JOIN key_requests k ON k.id::text=l.target_id LEFT JOIN staff s ON s.id=k.staff_id
      WHERE l.hotel_id=$1 AND l.action = ANY($9::text[]) AND l.at BETWEEN $2 AND $3
      UNION ALL
      SELECT 'x' || c.id, COALESCE(c.completed_at, c.expires_at), 'system', 'error', NULL,
        c.status || ':' || c.type, NULL, NULL, NULL, 'Connector',
        COALESCE(c.error->>'code', '') || COALESCE(' · ' || (c.error->>'message'), ''), NULL::uuid
      FROM commands c WHERE c.hotel_id=$1 AND c.status IN ('FAILED', 'EXPIRED') AND COALESCE(c.completed_at, c.expires_at) BETWEEN $2 AND $3
    ),
    sel0 AS (
      SELECT ev.*, COALESCE(dm.name, ev.door_ref) AS door_name, dm.external_id AS door_id,
        vc.reg_no AS m_reg, vc.card_holder AS m_holder, vc.user_group AS m_vgroup, vc.deadbolt_override AS m_deadbolt, vc.key_id AS m_vkey,
        vc.starts_at AS m_starts, vc.expires_at AS m_expires, vc.cancelled AS m_cancelled, vc.mobile AS m_vmobile
      FROM ev LEFT JOIN doormap dm ON dm.k = ev.door_ref
        LEFT JOIN vl_cards vc ON vc.hotel_id=$1 AND vc.reg_no=ev.card AND ev.card <> '0' AND ev.id ~ '^[vc]'
      WHERE ev.at BETWEEN $2 AND $3),
    sel AS (SELECT * FROM sel0 WHERE true`;
  const where: string[] = [];
  if (f.categories?.length) { params.push(f.categories); where.push(`category = ANY($${params.length}::text[])`); }
  if (f.door) { params.push(f.door); where.push(`(door_id = $${params.length} OR door_name = $${params.length})`); }
  if (f.q?.trim()) {
    params.push(`%${f.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const n = `$${params.length}`;
    where.push(`(person ILIKE ${n} OR card ILIKE ${n} OR door_name ILIKE ${n} OR detail ILIKE ${n} OR event ILIKE ${n} OR m_vgroup ILIKE ${n} OR m_holder ILIKE ${n})`);
  }
  if (f.holder || f.person) {
    params.push(f.holder ?? null, f.person ?? null);
    where.push(`(($${params.length - 1}::text IS NOT NULL AND m_holder = $${params.length - 1}) OR ($${params.length}::text IS NOT NULL AND person = $${params.length}))`);
  }
  if (f.match === 'known') where.push(`card IS NOT NULL AND card <> '0' AND id ~ '^[vc]' AND (m_reg IS NOT NULL OR key_id IS NOT NULL)`);
  if (f.match === 'unknown') where.push(`card IS NOT NULL AND card <> '0' AND id ~ '^[vc]' AND m_reg IS NULL AND key_id IS NULL`);
  const filtered = `${base}${where.length ? ` AND ${where.join(' AND ')}` : ''})`;
  const clsSql = f.cls === 'entrances' ? `category = 'entrance'` : f.cls === 'errors' ? `severity IN ('error','warning')` : 'true';
  const limit = Math.max(1, Math.min(f.limit, 20_000));
  const { counts, byCatRows, rows } = await withTimeLimit(async (c) => {
    const agg = (await c.query(`${filtered} SELECT count(*)::int AS all, count(*) FILTER (WHERE category='entrance')::int AS entrances,
        count(*) FILTER (WHERE severity IN ('error','warning'))::int AS errors FROM sel`, params)).rows[0];
    const byCat = (await c.query(`${filtered} SELECT category, count(*)::int AS n FROM sel WHERE ${clsSql} GROUP BY category`, params)).rows;
    const page = (await c.query(`${filtered}
      SELECT sel.*, wd.label AS watched, COALESCE(op.display_name, pec.operator_name, vl_issuer_label($1, sel.card)) AS m_issued_by, (kr.id IS NOT NULL OR sel.key_id IS NOT NULL OR sel.m_vkey IS NOT NULL OR sel.m_vmobile IS TRUE) AS m_mobile
      FROM (SELECT * FROM sel WHERE ${clsSql} ORDER BY at DESC, id DESC LIMIT ${limit + 1}) sel
        LEFT JOIN watched_doors wd ON wd.hotel_id=$1 AND wd.active AND wd.door_id=sel.door_id
        LEFT JOIN LATERAL (SELECT r.id, r.requested_by FROM key_requests r WHERE r.hotel_id=$1 AND sel.card IS NOT NULL AND sel.card <> '0' AND r.card_reg_no=sel.card ORDER BY r.created_at DESC LIMIT 1) kr ON true
        LEFT JOIN key_requests kk ON kk.id = COALESCE(sel.key_id, sel.m_vkey)
        LEFT JOIN operators op ON op.id = COALESCE(kk.requested_by, kr.requested_by)
        LEFT JOIN portal_encoded_cards pec ON pec.hotel_id=$1 AND pec.reg_no=sel.card
      ORDER BY at DESC, id DESC`, params)).rows;
    return { counts: agg, byCatRows: byCat, rows: page };
  });
  const mapped: EventRow[] = rows.map((r: any) => {
    let event = r.event as string | null;
    let severity = r.severity as EventRow['severity'];
    if (r.id.startsWith('v')) {
      event = r.code != null && isBatteryEvent(r.code) ? batteryEventName(r.code) : EVENT_NAMES[r.code] ?? `Lock event ${r.code}`;
      if (offlineCodes.includes(r.code)) { event = 'Lock went offline'; severity = 'error'; }
      else if (onlineCodes.includes(r.code)) event = 'Lock back online';
    } else if (r.id.startsWith('c')) event = CARD_STATUS[r.code] ?? `Card status ${r.code}`;
    else if (r.id.startsWith('x')) { const [st, type] = String(r.event).split(':'); event = `${st === 'EXPIRED' ? 'Connector did not answer in time' : 'Connector could not'}${st === 'EXPIRED' ? ': ' : ' '}${TASK_NAMES[type!] ?? type}`; }
    else if (r.id.startsWith('k')) event = KEY_ACTIONS[r.event]?.event ?? r.event;
    const at = new Date(r.at);
    const known = Boolean(r.m_reg || r.m_mobile);
    return {
      id: r.id, at: at.toISOString(), category: r.category as Category, severity, code: r.code ?? null, event: event ?? '',
      door: r.door_name ?? null, doorId: r.door_id ?? null, person: r.person ?? null, card: r.card && r.card !== '0' ? r.card : null, source: r.source, detail: r.detail ?? null, watched: r.watched ?? null,
      match: r.card && r.card !== '0' && (r.id.startsWith('v') || r.id.startsWith('c'))
        ? { known, kind: r.m_mobile ? 'mobile' : r.m_reg ? 'card' : null, holderId: r.m_holder ?? null, group: r.m_vgroup ?? null,
          validThen: r.m_reg ? (!r.m_starts || new Date(r.m_starts) <= at) && (!r.m_expires || new Date(r.m_expires) > at) && !r.m_cancelled : null,
          issuedBy: r.m_issued_by ?? (r.m_reg ? (r.m_mobile ? 'Visionline (mobile key)' : 'Issued from Visionline') : null), deadbolt: r.m_deadbolt ?? null }
        : null,
    };
  });
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, byCatRows.find((x: any) => x.category === c)?.n ?? 0]));
  const total = f.cls === 'entrances' ? counts.entrances : f.cls === 'errors' ? counts.errors : counts.all;
  return { tz, counts: { all: counts.all, entrances: counts.entrances, errors: counts.errors }, byCategory, total, truncated: mapped.length > limit, events: mapped.slice(0, limit) };
}

/** Event queries get a time limit, so one heavy request can never hold the database for long. */
async function withTimeLimit<T>(fn: (c: import('pg').PoolClient) => Promise<T>, ms = 20_000): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query(`SET LOCAL statement_timeout = ${Math.round(ms)}`);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    if ((e as any)?.code === '57014') throw new ApiError(503, 'QUERY_TOO_LONG', 'This selection is too large to read at once. Choose a shorter period or narrow it down (door, person, type).');
    throw e;
  } finally { c.release(); }
}
