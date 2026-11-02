import { VL } from '@smk/shared/node';
import { many, pool } from './db.ts';
import { eventLogContext } from './event-log.ts';
import { ApiError, badRequest } from './lib/errors.ts';

/**
 * 2.12 "Build your own report". Each dataset is a fixed, read-only SQL view of one hotel's data; a report picks one
 * dataset, one dimension to group by, optionally a second to split by, a measure and filters. Dimensions and measures
 * are whitelisted expressions, filter values are parameters: nothing typed by a user reaches the SQL text.
 */
export interface Dim { label: string; sql: string; order?: 'value' | 'key' }
export interface Measure { label: string; sql: string; unit?: string }
export interface Dataset { label: string; about: string; perm: 'reports.read' | 'events.read' | 'maintenance.read' | 'key.read' | 'breakfast.read'; time: boolean; dims: Record<string, Dim>; measures: Record<string, Measure>; base: string }

const DAY = (col: string) => `to_char(${col} AT TIME ZONE $tz, 'YYYY-MM-DD')`;
const WEEKDAY = (col: string) => `to_char(${col} AT TIME ZONE $tz, 'ID Dy')`;
const HOUR = (col: string) => `to_char(${col} AT TIME ZONE $tz, 'HH24":00"')`;
const MONTH = (col: string) => `to_char(${col} AT TIME ZONE $tz, 'YYYY-MM')`;

export const DATASETS: Record<string, Dataset> = {
  doorEvents: {
    label: 'Door events', about: 'Entrances, refused entries and other lock events reported by Visionline.', perm: 'events.read', time: true,
    base: `SELECT e.received_at AS t, e.registration_number AS card,
        CASE WHEN e.event_code = ANY($entrance::int[]) THEN 'Entrance' WHEN e.event_code = ANY($denial::int[]) THEN 'Refused' ELSE 'Other lock event' END AS category,
        COALESCE(d.name, e.door_id, '—') AS door, COALESCE(d.data->>'floor', '—') AS floor,
        COALESCE(s.full_name, NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), ''), 'Unknown holder') AS person,
        COALESCE(u.user_group, vc.user_group, '—') AS user_group,
        CASE WHEN k.id IS NOT NULL THEN 'Mobile key' WHEN vc.reg_no IS NOT NULL THEN 'Keycard' ELSE 'Not matched' END AS card_kind,
        COALESCE(o.display_name, CASE WHEN vc.reg_no IS NOT NULL THEN 'Visionline desk' END, 'Unknown (not matched)') AS issued_by,
        COALESCE(e.registration_number, '—') AS card_no
      FROM visionline_events e
      LEFT JOIN resources d ON d.hotel_id=e.hotel_id AND d.kind='door' AND (d.external_id=e.door_id OR d.data->>'doorID'=e.door_id)
      LEFT JOIN vl_cards vc ON vc.hotel_id=e.hotel_id AND vc.reg_no=e.registration_number AND e.registration_number <> '0'
      LEFT JOIN vl_users u ON u.hotel_id=e.hotel_id AND u.user_id=vc.card_holder
      LEFT JOIN key_requests k ON k.id=e.key_id
      LEFT JOIN staff s ON s.id=k.staff_id
      LEFT JOIN operators o ON o.id=k.requested_by
      WHERE e.hotel_id=$hotel AND e.kind='event' AND e.received_at >= $from AND e.received_at < $to`,
    dims: {
      category: { label: 'Event type', sql: 'category' }, door: { label: 'Door', sql: 'door' }, floor: { label: 'Floor', sql: 'floor' },
      person: { label: 'Person', sql: 'person' }, userGroup: { label: 'User group', sql: 'user_group' }, cardKind: { label: 'Keycard or mobile key', sql: 'card_kind' },
      issuedBy: { label: 'Issued by', sql: 'issued_by' }, card: { label: 'Card number', sql: 'card_no' },
      day: { label: 'Day', sql: DAY('t'), order: 'key' }, weekday: { label: 'Day of the week', sql: WEEKDAY('t'), order: 'key' }, hour: { label: 'Hour of the day', sql: HOUR('t'), order: 'key' }, month: { label: 'Month', sql: MONTH('t'), order: 'key' },
    },
    measures: { events: { label: 'Events', sql: 'count(*)' }, people: { label: 'Different people', sql: `count(DISTINCT NULLIF(person, 'Unknown holder'))` }, doors: { label: 'Different doors', sql: 'count(DISTINCT door)' } },
  },
  keycards: {
    label: 'Keycards', about: 'Keycards and mobile keys read from Visionline (people in the synchronised user groups).', perm: 'reports.read', time: false,
    base: `SELECT COALESCE(u.user_group, k.user_group, '—') AS user_group,
        CASE WHEN k.key_id IS NOT NULL THEN 'Mobile key' ELSE 'Keycard' END AS kind,
        CASE WHEN k.active AND NOT k.cancelled AND NOT k.discarded AND NOT k.overridden AND (k.expires_at IS NULL OR k.expires_at > now()) THEN 'Valid' ELSE 'Ended' END AS state,
        CASE WHEN k.deadbolt_override THEN 'Overrides deadbolt' WHEN k.deadbolt_override = false THEN 'No deadbolt override' ELSE 'Not reported' END AS deadbolt,
        COALESCE(o.display_name, CASE WHEN k.key_id IS NULL THEN 'Visionline desk' END, '—') AS issued_by,
        CASE WHEN k.expires_at IS NULL THEN 'No end' WHEN k.expires_at < now() THEN 'Ended' WHEN k.expires_at < now() + interval '7 days' THEN 'Within 7 days'
             WHEN k.expires_at < now() + interval '30 days' THEN 'Within 30 days' WHEN k.expires_at < now() + interval '1 year' THEN 'Within a year' ELSE 'Later' END AS ends,
        CASE WHEN k.door_count = 0 THEN 'Door groups only' WHEN k.door_count <= 5 THEN '1-5 doors' WHEN k.door_count <= 20 THEN '6-20 doors' ELSE 'More than 20 doors' END AS doors_band,
        k.card_holder AS holder, COALESCE(k.time_schedule, 'None') AS schedule
      FROM vl_cards k LEFT JOIN vl_users u ON u.hotel_id=k.hotel_id AND u.user_id=k.card_holder
      LEFT JOIN key_requests r ON r.id=k.key_id LEFT JOIN operators o ON o.id=r.requested_by
      WHERE k.hotel_id=$hotel`,
    dims: {
      userGroup: { label: 'User group', sql: 'user_group' }, kind: { label: 'Keycard or mobile key', sql: 'kind' }, state: { label: 'Valid or ended', sql: 'state' },
      deadbolt: { label: 'Deadbolt override', sql: 'deadbolt' }, issuedBy: { label: 'Issued by', sql: 'issued_by' }, ends: { label: 'Ends', sql: 'ends' },
      doors: { label: 'Doors on the card', sql: 'doors_band' }, schedule: { label: 'Time schedule', sql: 'schedule' },
    },
    measures: { cards: { label: 'Keycards', sql: 'count(*)' }, people: { label: 'People', sql: 'count(DISTINCT holder)' } },
  },
  mobileKeys: {
    label: 'Mobile keys issued', about: 'Staff mobile keys issued from this platform.', perm: 'key.read', time: true,
    base: `SELECT r.created_at AS t, r.status, o.display_name AS issued_by, COALESCE(s.visionline_user_group, '—') AS user_group, s.job_role AS role,
        COALESCE(t.name, 'Custom doors') AS template, CASE WHEN r.is_broad THEN 'Broad (approved)' ELSE 'Normal' END AS breadth,
        COALESCE(r.revoke_source, CASE WHEN r.status IN ('ISSUED','SCHEDULED') THEN 'Still active' ELSE '—' END) AS ended_by, r.staff_id
      FROM key_requests r JOIN operators o ON o.id=r.requested_by JOIN staff s ON s.id=r.staff_id LEFT JOIN access_templates t ON t.id=r.template_id
      WHERE r.hotel_id=$hotel AND r.created_at >= $from AND r.created_at < $to`,
    dims: {
      status: { label: 'Status', sql: 'status' }, issuedBy: { label: 'Issued by', sql: 'issued_by' }, userGroup: { label: 'User group', sql: 'user_group' }, role: { label: 'Job', sql: 'role' },
      template: { label: 'Access template', sql: 'template' }, breadth: { label: 'Normal or broad', sql: 'breadth' }, endedBy: { label: 'How it ended', sql: 'ended_by' },
      day: { label: 'Day', sql: DAY('t'), order: 'key' }, weekday: { label: 'Day of the week', sql: WEEKDAY('t'), order: 'key' }, month: { label: 'Month', sql: MONTH('t'), order: 'key' },
    },
    measures: { keys: { label: 'Keys', sql: 'count(*)' }, people: { label: 'Different staff', sql: 'count(DISTINCT staff_id)' } },
  },
  alarms: {
    label: 'Lock alarms', about: 'Alarms read from Visionline (option "Web service for checking and confirming alarms").', perm: 'reports.read', time: true,
    base: `SELECT COALESCE(a.alarm_at, a.received_at) AS t, COALESCE(a.type_name, a.alarm_type, 'Alarm') AS type, COALESCE(d.name, a.door_raw, '—') AS door,
        CASE WHEN a.completed THEN 'Confirmed' ELSE 'Open' END AS state
      FROM vl_alarms a LEFT JOIN resources d ON d.hotel_id=a.hotel_id AND d.kind='door' AND d.external_id=a.door_id
      WHERE a.hotel_id=$hotel AND COALESCE(a.alarm_at, a.received_at) >= $from AND COALESCE(a.alarm_at, a.received_at) < $to`,
    dims: { type: { label: 'Alarm type', sql: 'type' }, door: { label: 'Door', sql: 'door' }, state: { label: 'Open or confirmed', sql: 'state' },
      day: { label: 'Day', sql: DAY('t'), order: 'key' }, weekday: { label: 'Day of the week', sql: WEEKDAY('t'), order: 'key' }, month: { label: 'Month', sql: MONTH('t'), order: 'key' } },
    measures: { alarms: { label: 'Alarms', sql: 'count(*)' }, doors: { label: 'Different doors', sql: 'count(DISTINCT door)' } },
  },
  maintenance: {
    label: 'Maintenance requests', about: 'Requests from the portal, the staff app and battery alarms.', perm: 'maintenance.read', time: true,
    base: `SELECT m.created_at AS t, m.category, m.priority, m.status, m.source, COALESCE(s.full_name, 'Unassigned') AS assignee, COALESCE(d.name, m.location, '—') AS place,
        CASE WHEN m.resolved_at IS NOT NULL THEN extract(epoch FROM m.resolved_at - m.created_at) / 3600 END AS hours,
        CASE WHEN m.resolved_at IS NULL AND m.due_at < now() AND m.status NOT IN ('CANCELLED') THEN 'Overdue' WHEN m.resolved_at IS NULL THEN 'Open' WHEN m.resolved_at <= COALESCE(m.due_at, m.resolved_at) THEN 'On time' ELSE 'Late' END AS timeliness
      FROM maintenance_tickets m LEFT JOIN staff s ON s.hotel_id=m.hotel_id AND s.id=m.assignee_staff_id LEFT JOIN resources d ON d.hotel_id=m.hotel_id AND d.kind='door' AND d.external_id=m.door_id
      WHERE m.hotel_id=$hotel AND m.created_at >= $from AND m.created_at < $to`,
    dims: { category: { label: 'Category', sql: 'category' }, priority: { label: 'Priority', sql: 'priority' }, status: { label: 'Status', sql: 'status' }, source: { label: 'Reported from', sql: 'source' },
      assignee: { label: 'Assigned to', sql: 'assignee' }, place: { label: 'Door or place', sql: 'place' }, timeliness: { label: 'On time', sql: 'timeliness' },
      day: { label: 'Day', sql: DAY('t'), order: 'key' }, month: { label: 'Month', sql: MONTH('t'), order: 'key' } },
    measures: { requests: { label: 'Requests', sql: 'count(*)' }, hours: { label: 'Average hours to resolve', sql: 'round(avg(hours)::numeric, 1)', unit: ' h' } },
  },
  breakfast: {
    label: 'Breakfast served', about: 'Breakfasts recorded at the restaurant (undone entries left out).', perm: 'breakfast.read', time: true,
    base: `SELECT b.served_at AS t, b.day::text AS bday, CASE b.kind WHEN 'included' THEN 'In the rate' WHEN 'paying' THEN 'Paying' ELSE 'Walk-in' END AS kind,
        COALESCE(b.room, '—') AS room, COALESCE(o.display_name, '—') AS served_by, b.persons
      FROM bf_served b LEFT JOIN operators o ON o.id=b.served_by WHERE b.hotel_id=$hotel AND b.voided_at IS NULL AND b.served_at >= $from AND b.served_at < $to`,
    dims: { kind: { label: 'In the rate, paying or walk-in', sql: 'kind' }, room: { label: 'Room', sql: 'room' }, servedBy: { label: 'Recorded by', sql: 'served_by' },
      day: { label: 'Breakfast day', sql: 'bday', order: 'key' }, weekday: { label: 'Day of the week', sql: WEEKDAY('t'), order: 'key' }, hour: { label: 'Hour', sql: HOUR('t'), order: 'key' } },
    measures: { persons: { label: 'Guests served', sql: 'sum(persons)' }, entries: { label: 'Entries', sql: 'count(*)' } },
  },
};

export interface ReportSpec {
  dataset: string; groupBy: string; splitBy?: string | null; measure: string; days: number;
  filters?: { dim: string; values: string[] }[]; limit?: number; chart?: 'bars' | 'columns' | 'lines' | 'table'; sort?: 'value' | 'key';
}

export function datasetCatalog(perms: Set<string>) {
  return Object.entries(DATASETS).filter(([, d]) => perms.has(d.perm)).map(([id, d]) => ({
    id, label: d.label, about: d.about, time: d.time,
    dims: Object.entries(d.dims).map(([k, v]) => ({ id: k, label: v.label, ordered: v.order === 'key' })),
    measures: Object.entries(d.measures).map(([k, v]) => ({ id: k, label: v.label, unit: v.unit ?? '' })),
  }));
}

export async function runReport(hotelId: string, spec: ReportSpec, perms: Set<string>) {
  const ds = DATASETS[spec.dataset];
  if (!ds) throw badRequest('VALIDATION', 'Unknown data.');
  if (!perms.has(ds.perm)) throw new ApiError(403, 'FORBIDDEN', `This data needs the permission ${ds.perm}.`);
  const g = ds.dims[spec.groupBy]; const sp = spec.splitBy ? ds.dims[spec.splitBy] : null; const m = ds.measures[spec.measure];
  if (!g || (spec.splitBy && !sp) || !m) throw badRequest('VALIDATION', 'Choose what to group by and what to count from the list.');
  const { tz, entranceCodes } = await eventLogContext(hotelId);
  const to = new Date(); const from = new Date(to.getTime() - Math.min(Math.max(spec.days, 1), 731) * 86_400_000);
  // Named values are numbered as the SQL uses them (PostgreSQL refuses parameters a statement does not use).
  const values: Record<string, unknown> = { hotel: hotelId, tz, from, to, entrance: entranceCodes, denial: [...VL.denialEventCodes, 53] };
  const params: unknown[] = [];
  const pos: Record<string, string> = {};
  const fill = (sql: string) => sql.replace(/\$(hotel|tz|from|to|entrance|denial)\b/g, (_x, k: string) => {
    if (!pos[k]) { params.push(values[k]); pos[k] = `$${params.length}`; }
    return pos[k]!;
  });
  const baseSql = fill(ds.base);
  const where: string[] = [];
  for (const f of spec.filters ?? []) {
    const d = ds.dims[f.dim];
    if (!d || !f.values?.length) continue;
    params.push(f.values.slice(0, 200).map(String));
    where.push(`(${fill(d.sql)}) = ANY($${params.length}::text[])`);
  }
  const limit = Math.min(Math.max(spec.limit ?? 25, 1), 400);
  const gsql = fill(g.sql), ssql = sp ? fill(sp.sql) : null, msql = m.sql;
  const sql = `WITH base AS (${baseSql})
    SELECT (${gsql})::text AS k${ssql ? `, (${ssql})::text AS s` : ''}, (${msql})::float8 AS v
    FROM base ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY 1${ssql ? ', 2' : ''}`;
  const rows = await many(pool, sql, params);
  // Group rows, keep the biggest groups (or the first ones in time order), fold the rest into "Other".
  const keys = new Map<string, number>();
  for (const r of rows) keys.set(r.k ?? '—', (keys.get(r.k ?? '—') ?? 0) + Number(r.v ?? 0));
  const byKey = (spec.sort ?? (g.order === 'key' ? 'key' : 'value')) === 'key';
  const ordered = [...keys.entries()].sort((a, b) => (byKey ? a[0].localeCompare(b[0]) : b[1] - a[1]));
  const kept = new Set(ordered.slice(0, limit).map(([k]) => k));
  const series = ssql ? [...new Set(rows.map((r) => r.s ?? '—'))].sort() : [m.label];
  const SERIES_MAX = 6;
  const sTotals = new Map<string, number>(); for (const r of rows) sTotals.set(r.s ?? '—', (sTotals.get(r.s ?? '—') ?? 0) + Number(r.v ?? 0));
  const topS = ssql ? [...sTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, SERIES_MAX).map(([s]) => s) : series;
  const seriesOut = ssql && series.length > SERIES_MAX ? [...topS, 'Other'] : topS;
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const k = r.k ?? '—';
    if (!kept.has(k)) continue;
    const vals = out.get(k) ?? new Array(seriesOut.length).fill(0);
    const si = ssql ? (topS.includes(r.s ?? '—') ? topS.indexOf(r.s ?? '—') : seriesOut.length - 1) : 0;
    vals[si] += Number(r.v ?? 0);
    out.set(k, vals);
  }
  const result = ordered.filter(([k]) => kept.has(k)).map(([k]) => ({ key: k, label: k.replace(/^\d \b/, ''), values: (out.get(k) ?? []).map((v) => Math.round(v * 10) / 10) }));
  const others = ordered.length - kept.size;
  return {
    spec: { ...spec, limit }, dataset: { id: spec.dataset, label: ds.label }, groupBy: g.label, splitBy: sp?.label ?? null, measure: m.label, unit: m.unit ?? '',
    from: ds.time ? from.toISOString() : null, to: to.toISOString(), tz, series: seriesOut, rows: result, hiddenGroups: others,
    total: /^(count\(\*\)|sum\()/.test(m.sql) ? Math.round([...keys.values()].reduce((a, b) => a + b, 0) * 10) / 10 : null,
  };
}
