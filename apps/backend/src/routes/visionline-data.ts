/**
 * 2.10 What the portal has read from Visionline, as lists: keycards, people, user groups, plus how fresh it is
 * and "Refresh now". Read-only views of data that arrives by itself (visionline-sync.ts, directory.ts).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sharedVisionlineOperator } from '@smk/shared';
import { pool, one, many } from '../db.ts';
import { requirePerm } from '../auth.ts';
import { getConfig } from '../hotel-config.ts';
import { requestDirectorySync } from '../directory.ts';
import { readyConnector, requestDiscovery } from '../visionline-sync.ts';
import { isOnline } from './portal.ts';
import { ApiError, notFound } from '../lib/errors.ts';
import { randomUUID } from 'node:crypto';
import { enqueue } from '../commands.ts';
import { audit } from '../audit.ts';
import { queryEvents } from '../event-log.ts';

const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Site');
  return id;
};
const VALID = `NOT (k.cancelled OR k.discarded OR k.overridden OR k.expired OR k.not_issued) AND k.active AND (k.expires_at IS NULL OR k.expires_at > now())`;

export function visionlineDataRoutes(app: FastifyInstance) {
  app.get(`${P}/hotels/:hotelId/visionline/overview`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'reports.read');
    const vl = await getConfig(pool, hotelId, 'visionline');
    const res = await many(pool, `SELECT kind, count(*)::int AS n FROM resources WHERE hotel_id=$1 AND active GROUP BY kind`, [hotelId]);
    const n = (k: string) => res.find((r) => r.kind === k)?.n ?? 0;
    const people = await one(pool, `SELECT count(*)::int AS n FROM vl_users WHERE hotel_id=$1 AND active`, [hotelId]);
    const cards = await one(pool, `SELECT count(*) FILTER (WHERE ${VALID})::int AS valid, count(*) FILTER (WHERE ${VALID} AND (k.key_id IS NOT NULL OR k.mobile IS TRUE))::int AS mobile,
        count(*) FILTER (WHERE k.first_seen_at > now() - interval '24 hours')::int AS new24h FROM vl_cards k WHERE k.hotel_id=$1`, [hotelId]);
    const lastDiscovery = await one(pool, `SELECT status, created_at, completed_at, error FROM commands WHERE hotel_id=$1 AND type='DISCOVER_RESOURCES' ORDER BY created_at DESC LIMIT 1`, [hotelId]);
    const lastOkDiscovery = await one(pool, `SELECT max(completed_at) AS t FROM commands WHERE hotel_id=$1 AND type='DISCOVER_RESOURCES' AND status='SUCCEEDED'`, [hotelId]);
    const lastSync = await one(pool, `SELECT id, status, started_at, finished_at, users, cards, alarms, notes, error FROM directory_syncs WHERE hotel_id=$1 AND NOT partial ORDER BY started_at DESC LIMIT 1`, [hotelId]);
    const lastOkSync = await one(pool, `SELECT max(finished_at) AS t FROM directory_syncs WHERE hotel_id=$1 AND NOT partial AND status='SUCCEEDED'`, [hotelId]);
    const conn = await one(pool, `SELECT name, last_seen_at, health FROM connectors WHERE hotel_id=$1 AND status='ACTIVE' ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [hotelId]);
    const caps: string[] = conn?.health?.capabilities ?? [];
    return {
      counts: { doors: n('door'), doorGroups: n('doorgroup'), userGroups: n('usergroup'), timeSchedules: n('timeschedule'), people: people!.n, validCards: cards!.valid, mobileKeys: cards!.mobile, newCards24h: cards!.new24h },
      discovery: { everyHours: vl?.discoveryEveryHours ?? 6, last: lastDiscovery ?? null, lastOkAt: lastOkDiscovery?.t ?? null },
      sync: { enabled: Boolean(vl?.directorySync?.enabled), everyHours: vl?.directorySync?.everyHours ?? 24, scope: vl?.directorySync?.scope ?? 'staffGroups', last: lastSync ?? null, lastOkAt: lastOkSync?.t ?? null },
      connector: conn ? { name: conn.name, online: isOnline(conn.last_seen_at), credentials: Boolean(conn.health?.credentialsConfigured), visionlineReachable: Boolean(conn.health?.visionlineReachable),
        version: conn.health?.connectorVersion ?? null, canSync: caps.includes('directory-sync'), liveCards: caps.includes('directory-sync-users'), watch: conn.health?.visionlineWatch ?? null, canReadCards: caps.includes('encoder-read') } : null,
      encoders: vl?.encoderRead?.enabled ? [...new Set([...(vl.encoderRead.encoders ?? []), ...(await many(pool, `SELECT external_id FROM resources WHERE hotel_id=$1 AND kind='encoder' AND active ORDER BY external_id`, [hotelId])).map((r) => r.external_id as string)])] : [],
      // 2.17 Cards made from the portal are logged in Visionline under the connector's Visionline user: a shared one
      // (PMS interface user, "sym"...) hides who made them.
      visionlineOperator: conn?.health?.propertyUsername ? { name: conn.health.propertyUsername, shared: sharedVisionlineOperator(conn.health.propertyUsername),
        personalRequired: Boolean(vl?.requirePersonalCredentials) } : null,
    };
  });

  /** 2.20 When Visionline was last read (for the Refresh from Visionline button on several pages). */
  app.get(`${P}/hotels/:hotelId/visionline/last-read`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'resources.read');
    const vl = await getConfig(pool, hotelId, 'visionline');
    const d = await one(pool, `SELECT max(completed_at) FILTER (WHERE status='SUCCEEDED') AS done, max(created_at) AS asked,
        bool_or(status IN ('PENDING','LEASED') AND expires_at > now()) AS running FROM commands WHERE hotel_id=$1 AND type='DISCOVER_RESOURCES'`, [hotelId]);
    const s2 = await one(pool, `SELECT max(finished_at) FILTER (WHERE status='SUCCEEDED' AND NOT partial) AS done, bool_or(status='RUNNING' AND started_at > now() - interval '40 minutes') AS running
      FROM directory_syncs WHERE hotel_id=$1`, [hotelId]);
    return { readMode: vl?.readMode ?? 'onRequest', doors: d?.done ?? null, people: s2?.done ?? null, running: Boolean(d?.running || s2?.running), lastAsked: d?.asked ?? null };
  });

  app.post(`${P}/hotels/:hotelId/visionline/refresh`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'resources.discover');
    if (!(await readyConnector(pool, hotelId))) throw new ApiError(409, 'CONNECTOR_NOT_READY', 'The connector is offline or has no Visionline account yet (Settings → Visionline).');
    // 2.20 Spare Visionline: one full read every 5 minutes at most, however often the button is pressed.
    // Counted from the last time someone pressed the button (automatic reads do not block a person).
    const recent = await one(pool, `SELECT max(at) AS t FROM audit_log WHERE hotel_id=$1 AND action='resources.discovery_requested' AND details->>'reason'='refresh now'`, [hotelId]);
    if (recent?.t && Date.now() - new Date(recent.t).getTime() < 5 * 60_000) {
      const wait = Math.ceil((5 * 60_000 - (Date.now() - new Date(recent.t).getTime())) / 60_000);
      throw new ApiError(429, 'READ_RECENTLY', `Visionline was read less than 5 minutes ago; the lists are being updated. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`);
    }
    const d = await requestDiscovery(pool, hotelId, op.id, 'refresh now');
    let sync: { syncId?: string; alreadyRunning?: boolean; skipped?: string } = {};
    try { sync = await requestDirectorySync(hotelId, op.id); } catch (e) { sync = { skipped: (e as Error).message }; }
    return { discovery: d, sync };
  });

  app.get(`${P}/hotels/:hotelId/visionline/cards`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'reports.read');
    const q = z.object({
      q: z.string().trim().max(80).optional(), group: z.string().max(80).optional(),
      state: z.enum(['valid', 'ended', 'all']).default('valid'), kind: z.enum(['all', 'mobile', 'card']).default('all'),
      deadbolt: z.enum(['any', 'yes', 'no', 'unknown']).default('any'),
      /** 2.16.1 "Who can open this door?" (door id or name) and "who has a master keycard" (opens every room). */
      door: z.string().trim().max(120).optional(),
      master: z.enum(['any', 'yes']).default('any'),
      limit: z.coerce.number().int().min(1).max(2000).default(500),
    }).parse(req.query);
    const ROOM = `(d.data->>'doorCategory' = 'guest' OR d.name ~ '^[0-9]{2,5}[A-Za-z]?$')`;
    // Does card k open door d? Its own doors and door groups, and those of a uniform-access user group.
    const OPENS = `(d.external_id = ANY(k.doors) OR d.name = ANY(k.doors) OR (d.data->>'doorGroup') = ANY(k.door_groups) OR EXISTS (
        SELECT 1 FROM resources g, jsonb_array_elements(COALESCE(g.data->'doorOperations', '[]'::jsonb)) o
        WHERE g.hotel_id=k.hotel_id AND g.kind='usergroup' AND g.active AND g.external_id = COALESCE(u.user_group, k.user_group) AND (g.data->>'uniformAccess')::boolean
          AND (COALESCE(o->'doors', '[]'::jsonb) ? d.external_id OR COALESCE(o->'doors', '[]'::jsonb) ? d.name OR COALESCE(o->'doorGroups', '[]'::jsonb) ? (d.data->>'doorGroup'))))`;
    const DOORS = `SELECT 1 FROM resources d WHERE d.hotel_id=k.hotel_id AND d.kind='door' AND d.active`;
    const doorSql = q.door ? `AND EXISTS (${DOORS} AND (d.external_id = $5 OR d.name = $5) AND ${OPENS})` : 'AND $5::text IS NULL';
    // A master keycard opens every room.
    const masterSql = q.master === 'yes' ? `AND EXISTS (${DOORS} AND ${ROOM}) AND NOT EXISTS (${DOORS} AND ${ROOM} AND NOT ${OPENS})` : '';
    const state = q.state === 'valid' ? `AND ${VALID}` : q.state === 'ended' ? `AND NOT (${VALID})` : '';
    const kind = q.kind === 'mobile' ? 'AND (k.key_id IS NOT NULL OR k.mobile IS TRUE)' : q.kind === 'card' ? 'AND k.key_id IS NULL AND k.mobile IS NOT TRUE' : '';
    const db = q.deadbolt === 'yes' ? 'AND k.deadbolt_override' : q.deadbolt === 'no' ? 'AND k.deadbolt_override = false' : q.deadbolt === 'unknown' ? 'AND k.deadbolt_override IS NULL' : '';
    const rows = await many(pool, `SELECT k.reg_no, k.card_holder, COALESCE(u.user_group, k.user_group) AS user_group, NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), '') AS holder_name,
        k.format, k.starts_at, k.expires_at, k.cancelled, k.discarded, k.overridden, k.expired, k.not_issued, k.active, k.door_count, k.door_groups, k.time_schedule,
        (k.key_id IS NOT NULL OR k.mobile IS TRUE) AS mobile_key, k.source, k.first_seen_at, k.last_seen_at, ${VALID} AS valid, k.operations, k.deadbolt_override,
        COALESCE((SELECT o.display_name FROM key_requests r JOIN operators o ON o.id=r.requested_by WHERE r.id=k.key_id),
          (SELECT p.operator_name FROM portal_encoded_cards p WHERE p.hotel_id=k.hotel_id AND p.reg_no=k.reg_no),
          vl_issuer_label(k.hotel_id, k.reg_no),
          (SELECT o.display_name FROM keycard_requests q JOIN operators o ON o.id=COALESCE(q.issued_by, q.handled_by) WHERE q.hotel_id=k.hotel_id AND q.card_reg_no=k.reg_no ORDER BY q.updated_at DESC LIMIT 1)) AS issued_by
      FROM vl_cards k LEFT JOIN vl_users u ON u.hotel_id=k.hotel_id AND u.user_id=k.card_holder
      WHERE k.hotel_id=$1 ${state} ${kind} ${db} ${doorSql} ${masterSql}
        AND ($2::text IS NULL OR COALESCE(u.user_group, k.user_group) = $2)
        AND ($3::text IS NULL OR k.reg_no ILIKE '%'||$3||'%' OR k.card_holder ILIKE '%'||$3||'%' OR u.given_name ILIKE '%'||$3||'%' OR u.surname ILIKE '%'||$3||'%')
      ORDER BY k.first_seen_at DESC, k.reg_no LIMIT $4`, [hotelId, q.group ?? null, q.q || null, q.limit, q.door || null]);
    return rows;
  });

  /** 2.16.1 Doors for the "who can open…" filter (names only). */
  app.get(`${P}/hotels/:hotelId/visionline/doors`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'reports.read');
    return many(pool, `SELECT external_id AS id, name, data->>'doorGroup' AS "group" FROM resources WHERE hotel_id=$1 AND kind='door' AND active ORDER BY name`, [hotelId]);
  });

  app.get(`${P}/hotels/:hotelId/visionline/people`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'reports.read');
    const q = z.object({ q: z.string().trim().max(80).optional(), group: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(5000).default(1000) }).parse(req.query);
    return many(pool, `SELECT u.user_id, u.given_name, u.surname, u.user_group, u.first_seen_at, u.last_seen_at,
        (SELECT count(*)::int FROM vl_cards k WHERE k.hotel_id=u.hotel_id AND k.card_holder=u.user_id AND ${VALID}) AS valid_cards,
        (SELECT max(k.expires_at) FROM vl_cards k WHERE k.hotel_id=u.hotel_id AND k.card_holder=u.user_id AND ${VALID}) AS valid_until,
        (SELECT s.full_name FROM staff s WHERE s.hotel_id=u.hotel_id AND s.visionline_user=u.user_id LIMIT 1) AS staff_name,
        (SELECT o.display_name FROM operator_vl_links l JOIN operators o ON o.id=l.operator_id WHERE l.hotel_id=u.hotel_id AND l.vl_user_id=u.user_id LIMIT 1) AS portal_user
      FROM vl_users u WHERE u.hotel_id=$1 AND u.active AND ($2::text IS NULL OR u.user_group=$2)
        AND ($3::text IS NULL OR u.user_id ILIKE '%'||$3||'%' OR u.given_name ILIKE '%'||$3||'%' OR u.surname ILIKE '%'||$3||'%')
      ORDER BY u.surname NULLS LAST, u.given_name LIMIT $4`, [hotelId, q.group ?? null, q.q || null, q.limit]);
  });

  app.get(`${P}/hotels/:hotelId/visionline/user-groups`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'reports.read');
    const vl = await getConfig(pool, hotelId, 'visionline');
    const staffGroups: string[] = vl?.userGroups ?? [];
    const rows = await many(pool, `SELECT g.name, r.data, r.discovered_at, r.active AS in_visionline,
        (SELECT count(*)::int FROM vl_users u WHERE u.hotel_id=$1 AND u.active AND u.user_group=g.name) AS people,
        (SELECT count(*)::int FROM vl_cards k JOIN vl_users u ON u.hotel_id=k.hotel_id AND u.user_id=k.card_holder WHERE k.hotel_id=$1 AND u.user_group=g.name AND ${VALID}) AS valid_cards
      FROM (SELECT external_id AS name FROM resources WHERE hotel_id=$1 AND kind='usergroup'
            UNION SELECT DISTINCT user_group FROM vl_users WHERE hotel_id=$1 AND active AND user_group IS NOT NULL) g
      LEFT JOIN resources r ON r.hotel_id=$1 AND r.kind='usergroup' AND r.external_id=g.name
      ORDER BY g.name`, [hotelId]);
    return rows.map((r) => {
      const ops = (r.data?.doorOperations ?? []) as any[];
      return { name: r.name, inVisionline: Boolean(r.in_visionline), staffGroup: staffGroups.includes(r.name), default: vl?.defaultUserGroup === r.name,
        uniformAccess: Boolean(r.data?.uniformAccess), doors: ops.reduce((n, o) => n + (o.doors?.length ?? 0), 0), doorGroups: ops.reduce((n, o) => n + (o.doorGroups?.length ?? 0), 0),
        people: r.people, validCards: r.valid_cards, readAt: r.discovered_at };
    });
  });

  // ---- 2.12 Card lookup: everything known about one keycard; optionally read from an encoder (pilot) ------------------
  app.get(`${P}/hotels/:hotelId/visionline/cards/:regNo/lookup`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'reports.read');
    const regNo = z.string().trim().min(1).max(64).parse((req.params as any).regNo);
    const k = await one(pool, `SELECT k.*, NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), '') AS holder_name, COALESCE(u.user_group, k.user_group) AS group_name,
        COALESCE((SELECT o.display_name FROM key_requests r JOIN operators o ON o.id=r.requested_by WHERE r.id=k.key_id),
          (SELECT p.operator_name FROM portal_encoded_cards p WHERE p.hotel_id=k.hotel_id AND p.reg_no=k.reg_no),
          vl_issuer_label(k.hotel_id, k.reg_no),
          (SELECT o.display_name FROM keycard_requests q JOIN operators o ON o.id=COALESCE(q.issued_by, q.handled_by) WHERE q.hotel_id=k.hotel_id AND q.card_reg_no=k.reg_no ORDER BY q.updated_at DESC LIMIT 1)) AS issued_by_name,
        (SELECT s.full_name FROM key_requests r JOIN staff s ON s.id=r.staff_id WHERE r.id=k.key_id) AS staff_name
      FROM vl_cards k LEFT JOIN vl_users u ON u.hotel_id=k.hotel_id AND u.user_id=k.card_holder WHERE k.hotel_id=$1 AND k.reg_no=$2`, [hotelId, regNo]);
    const key = k ? null : await one(pool, `SELECT r.id, r.status, r.starts_at, r.expires_at, s.full_name, o.display_name AS issued_by FROM key_requests r JOIN staff s ON s.id=r.staff_id JOIN operators o ON o.id=r.requested_by
      WHERE r.hotel_id=$1 AND r.card_reg_no=$2 ORDER BY r.created_at DESC LIMIT 1`, [hotelId, regNo]);
    if (!k && !key) return { known: false, regNo };
    const doorNames = k ? await many(pool, `SELECT name FROM resources WHERE hotel_id=$1 AND kind='door' AND (external_id = ANY($2::text[]) OR data->>'doorID' = ANY($2::text[])) ORDER BY name`, [hotelId, k.doors ?? []]) : [];
    const to = new Date(); const ev = await queryEvents(hotelId, { from: new Date(to.getTime() - 90 * 86_400_000), to, cls: 'all', categories: ['entrance', 'refused'], door: null, q: regNo, limit: 200 });
    const uses = ev.events.filter((e) => e.card === regNo).slice(0, 30);
    const now = Date.now();
    return {
      known: true, regNo,
      card: k ? { kind: k.key_id || k.mobile ? 'Mobile key' : 'Keycard', mobile: Boolean(k.key_id || k.mobile), holderId: k.card_holder, holder: k.holder_name ?? k.staff_name ?? k.card_holder, group: k.group_name,
        startsAt: k.starts_at, expiresAt: k.expires_at, valid: k.active && !k.cancelled && !k.discarded && !k.overridden && (!k.expires_at || new Date(k.expires_at).getTime() > now),
        cancelled: k.cancelled, overridden: k.overridden, deadbolt: k.deadbolt_override, operations: k.operations, timeSchedule: k.time_schedule,
        doors: doorNames.map((d) => d.name), doorCount: k.door_count, doorGroups: k.door_groups, issuedBy: k.issued_by_name ?? null, firstSeen: k.first_seen_at, lastSeen: k.last_seen_at }
        : { kind: 'Mobile key', mobile: true, holder: key!.full_name, startsAt: key!.starts_at, expiresAt: key!.expires_at, valid: ['ISSUED'].includes(key!.status), issuedBy: key!.issued_by, doors: [], doorGroups: [], deadbolt: null },
      uses: uses.map((e) => ({ at: e.at, door: e.door, category: e.category, event: e.event })),
    };
  });

  app.post(`${P}/hotels/:hotelId/visionline/encoder/read`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'reports.read');
    const b = z.object({ encoder: z.string().max(40) }).parse(req.body);
    const er = (await getConfig(pool, hotelId, 'visionline'))?.encoderRead;
    if (!er?.enabled) throw new ApiError(409, 'ENCODER_READ_OFF', 'Reading cards at an encoder is switched off (Settings → Reports & sync → Encoders).');
    // 2.17 Any encoder listed in Settings or read from Visionline (Staff keycards → Encoders & special cards).
    const known = new Set([...(er.encoders ?? []), ...(await many(pool, `SELECT external_id FROM resources WHERE hotel_id=$1 AND kind='encoder' AND active`, [hotelId])).map((r) => r.external_id as string)]);
    if (!known.has(b.encoder)) throw new ApiError(400, 'UNKNOWN_ENCODER', 'Unknown encoder: choose one from the list (Settings → Reports & sync → Encoders, or read them from Visionline in Staff keycards → Encoders).');
    const conn = await one(pool, `SELECT id, last_seen_at FROM connectors WHERE hotel_id=$1 AND status='ACTIVE' AND health->'capabilities' ? 'encoder-read' ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [hotelId]);
    if (!conn) throw new ApiError(409, 'CONNECTOR_CAPABILITY', 'Reading cards at an encoder needs connector 0.10.0 or newer.');
    if (!isOnline(conn.last_seen_at)) throw new ApiError(409, 'CONNECTOR_OFFLINE', 'The connector is offline.');
    // 2.13: card reads share Visionline with the GRMS and the desk: at most one every 3 seconds per hotel.
    const recent = await one(pool, `SELECT count(*) FILTER (WHERE created_at > now() - interval '3 seconds')::int AS s3, count(*)::int AS m1 FROM commands WHERE hotel_id=$1 AND type='READ_CARD' AND created_at > now() - interval '1 minute'`, [hotelId]);
    if (recent!.s3 > 0 || recent!.m1 >= 20) throw new ApiError(429, 'TOO_FAST', 'A card was just read. Wait a few seconds before reading the next one.');
    const corr = `smk-${randomUUID()}`;
    const cmd = await enqueue(pool, { hotelId, type: 'READ_CARD', payload: { encoder: b.encoder, action: er.action }, idempotencyKey: `read-card:${randomUUID()}`, correlationId: corr, ttlSec: 60 });
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'card.read_at_encoder_requested', targetType: 'command', targetId: cmd.id, correlationId: corr, details: { encoder: b.encoder } });
    return { commandId: cmd.id };
  });
  app.get(`${P}/hotels/:hotelId/visionline/encoder/read/:commandId`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'reports.read');
    const c = await one(pool, `SELECT id, status, result, error FROM commands WHERE id=$1 AND hotel_id=$2 AND type='READ_CARD'`, [z.string().uuid().parse((req.params as any).commandId), hotelId]);
    if (!c) throw notFound('Card read');
    return c;
  });
}
