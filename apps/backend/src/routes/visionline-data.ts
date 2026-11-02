/**
 * 2.10 What the portal has read from Visionline, as lists: keycards, people, user groups, plus how fresh it is
 * and "Refresh now". Read-only views of data that arrives by itself (visionline-sync.ts, directory.ts).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
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
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Hotel');
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
    const cards = await one(pool, `SELECT count(*) FILTER (WHERE ${VALID})::int AS valid, count(*) FILTER (WHERE ${VALID} AND k.key_id IS NOT NULL)::int AS mobile,
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
      encoders: vl?.encoderRead?.enabled ? (vl.encoderRead.encoders ?? []) : [],
    };
  });

  app.post(`${P}/hotels/:hotelId/visionline/refresh`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'resources.discover');
    if (!(await readyConnector(pool, hotelId))) throw new ApiError(409, 'CONNECTOR_NOT_READY', 'The connector is offline or has no Visionline account yet (Settings → Visionline).');
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
      limit: z.coerce.number().int().min(1).max(2000).default(500),
    }).parse(req.query);
    const state = q.state === 'valid' ? `AND ${VALID}` : q.state === 'ended' ? `AND NOT (${VALID})` : '';
    const kind = q.kind === 'mobile' ? 'AND k.key_id IS NOT NULL' : q.kind === 'card' ? 'AND k.key_id IS NULL' : '';
    const db = q.deadbolt === 'yes' ? 'AND k.deadbolt_override' : q.deadbolt === 'no' ? 'AND k.deadbolt_override = false' : q.deadbolt === 'unknown' ? 'AND k.deadbolt_override IS NULL' : '';
    const rows = await many(pool, `SELECT k.reg_no, k.card_holder, COALESCE(u.user_group, k.user_group) AS user_group, NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), '') AS holder_name,
        k.format, k.starts_at, k.expires_at, k.cancelled, k.discarded, k.overridden, k.expired, k.not_issued, k.active, k.door_count, k.door_groups, k.time_schedule,
        k.key_id IS NOT NULL AS mobile_key, k.source, k.first_seen_at, k.last_seen_at, ${VALID} AS valid, k.operations, k.deadbolt_override,
        (SELECT o.display_name FROM key_requests r JOIN operators o ON o.id=r.requested_by WHERE r.id=k.key_id) AS issued_by
      FROM vl_cards k LEFT JOIN vl_users u ON u.hotel_id=k.hotel_id AND u.user_id=k.card_holder
      WHERE k.hotel_id=$1 ${state} ${kind} ${db}
        AND ($2::text IS NULL OR COALESCE(u.user_group, k.user_group) = $2)
        AND ($3::text IS NULL OR k.reg_no ILIKE '%'||$3||'%' OR k.card_holder ILIKE '%'||$3||'%' OR u.given_name ILIKE '%'||$3||'%' OR u.surname ILIKE '%'||$3||'%')
      ORDER BY k.first_seen_at DESC, k.reg_no LIMIT $4`, [hotelId, q.group ?? null, q.q || null, q.limit]);
    return rows;
  });

  app.get(`${P}/hotels/:hotelId/visionline/people`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'reports.read');
    const q = z.object({ q: z.string().trim().max(80).optional(), group: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(5000).default(1000) }).parse(req.query);
    return many(pool, `SELECT u.user_id, u.given_name, u.surname, u.user_group, u.first_seen_at, u.last_seen_at,
        (SELECT count(*)::int FROM vl_cards k WHERE k.hotel_id=u.hotel_id AND k.card_holder=u.user_id AND ${VALID}) AS valid_cards,
        (SELECT max(k.expires_at) FROM vl_cards k WHERE k.hotel_id=u.hotel_id AND k.card_holder=u.user_id AND ${VALID}) AS valid_until,
        (SELECT s.full_name FROM staff s WHERE s.hotel_id=u.hotel_id AND s.visionline_user=u.user_id LIMIT 1) AS staff_name
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
        (SELECT o.display_name FROM key_requests r JOIN operators o ON o.id=r.requested_by WHERE r.id=k.key_id) AS issued_by_name,
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
      card: k ? { kind: k.key_id ? 'Mobile key' : 'Keycard', holderId: k.card_holder, holder: k.holder_name ?? k.staff_name ?? k.card_holder, group: k.group_name,
        startsAt: k.starts_at, expiresAt: k.expires_at, valid: k.active && !k.cancelled && !k.discarded && !k.overridden && (!k.expires_at || new Date(k.expires_at).getTime() > now),
        cancelled: k.cancelled, overridden: k.overridden, deadbolt: k.deadbolt_override, operations: k.operations, timeSchedule: k.time_schedule,
        doors: doorNames.map((d) => d.name), doorCount: k.door_count, doorGroups: k.door_groups, issuedBy: k.issued_by_name ?? (k.key_id ? null : 'Visionline desk'), firstSeen: k.first_seen_at, lastSeen: k.last_seen_at }
        : { kind: 'Mobile key', holder: key!.full_name, startsAt: key!.starts_at, expiresAt: key!.expires_at, valid: ['ISSUED'].includes(key!.status), issuedBy: key!.issued_by, doors: [], doorGroups: [], deadbolt: null },
      uses: uses.map((e) => ({ at: e.at, door: e.door, category: e.category, event: e.event })),
    };
  });

  app.post(`${P}/hotels/:hotelId/visionline/encoder/read`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'reports.read');
    const b = z.object({ encoder: z.string().max(40) }).parse(req.body);
    const er = (await getConfig(pool, hotelId, 'visionline'))?.encoderRead;
    if (!er?.enabled) throw new ApiError(409, 'ENCODER_READ_OFF', 'Reading cards at an encoder is switched off (Settings → Reports & sync → Encoders).');
    if (!er.encoders.includes(b.encoder)) throw new ApiError(400, 'UNKNOWN_ENCODER', 'This encoder is not in Settings → Reports & sync → Encoders.');
    const conn = await one(pool, `SELECT id, last_seen_at FROM connectors WHERE hotel_id=$1 AND status='ACTIVE' AND health->'capabilities' ? 'encoder-read' ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [hotelId]);
    if (!conn) throw new ApiError(409, 'CONNECTOR_CAPABILITY', 'Reading cards at an encoder needs connector 0.10.0 or newer.');
    if (!isOnline(conn.last_seen_at)) throw new ApiError(409, 'CONNECTOR_OFFLINE', 'The hotel connector is offline.');
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
