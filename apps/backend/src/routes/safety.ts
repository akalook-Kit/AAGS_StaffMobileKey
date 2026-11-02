/**
 * 2.13 Safety and people:
 *  - Live occupancy (muster): who is on site (staff seen at a door or checked in at attendance) and which rooms are in
 *    use (the in-house list plus recent door activity), for a screen at the security desk and for evacuations.
 *  - Emergencies: started by one person, confirmed by a second (both re-enter their password), roll call, emergency
 *    mobile keys for responders, everything in the audit trail. The live list never needs an emergency to be started.
 *  - Staff ID profiles (photo, name, department, ID number) printed on CR80 keycards.
 *  - Portal usage (pages opened per day) for the hotel, and an anonymous signed summary for the supplier.
 *
 * Locks record entries, not exits: "on site" and "room in use" are estimates from the last door activity and the
 * attendance check-out, and the screen says so.
 */
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, many, one, tx } from '../db.ts';
import { audit } from '../audit.ts';
import { permsIn, requireOperator, requirePerm, requireReauth } from '../auth.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { getConfig } from '../hotel-config.ts';
import { queryEvents } from '../event-log.ts';
import { attendanceOn, today as attendanceToday, hotelTz } from '../attendance/service.ts';
import { requestKey, enqueueIssue } from '../keys.ts';
import { enqueue, newCorrelationId } from '../commands.ts';
import { buildReportPdf } from '../pdf.ts';
import { licenceStatus } from '../licence.ts';
import { PLATFORM_VERSION } from '../version.ts';
import { secretStoreEnabled, setStoredSecret, storedSecret } from '../secret-store.ts';

const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Hotel');
  return id;
};
const uuid = z.string().uuid();
const member = async (req: FastifyRequest, hotelId: string) => {
  const op = await requireOperator(req);
  if (!op.isPlatformAdmin && !op.roles.has(hotelId)) throw forbidden('You are not a member of this hotel.');
  return op;
};

// ---------------------------------------------------------------------------------------------------------------
// Live occupancy (muster)
// ---------------------------------------------------------------------------------------------------------------
async function safetyPolicy(hotelId: string) {
  const p = (await getConfig(pool, hotelId, 'policy'))?.safety ?? {};
  return { staffOnSiteHours: 10, roomActivityHours: 12, visitorGroups: [] as string[], emergencyTemplateId: null as string | null, emergencyKeyHours: 4, floorDigits: 0, ...p };
}
const ROOM = /^\s*(?:room\s*|rm\s*|chambre\s*)?(\d{2,5}[A-Z]?)\s*$/i;
const floorOf = (room: string, digits: number) => (digits > 0 ? room.slice(0, digits) : room.replace(/[A-Z]$/i, '').length > 2 ? room.replace(/[A-Z]$/i, '').slice(0, -2) : '0');

export async function musterView(hotelId: string) {
  const [pol, tz] = await Promise.all([safetyPolicy(hotelId), hotelTz(hotelId)]);
  const now = new Date();
  const hours = Math.max(pol.staffOnSiteHours, pol.roomActivityHours);
  // At most 5,000 most recent entrances are read (same safe limit as the event log).
  const ev = await queryEvents(hotelId, { from: new Date(now.getTime() - hours * 3_600_000), to: now, cls: 'all', categories: ['entrance'], door: null, q: null, limit: 5_000 });
  const visitors = new Set(pol.visitorGroups.map((g: string) => g.toLowerCase()));
  const staffCut = now.getTime() - pol.staffOnSiteHours * 3_600_000;
  const roomCut = now.getTime() - pol.roomActivityHours * 3_600_000;

  // People seen at doors (known cards and mobile keys), newest event first.
  const people = new Map<string, { key: string; name: string; group: string | null; kind: 'staff' | 'visitor'; lastAt: string; lastDoor: string | null; source: string[] }>();
  const roomsSeen = new Map<string, { at: string; by: string | null; known: boolean }>();
  for (const e of ev.events) {
    const t = Date.parse(e.at);
    const known = Boolean(e.match?.known);
    if (known && t >= staffCut) {
      const key = e.match?.holderId ? `vl:${e.match.holderId}` : `name:${e.person ?? e.card}`;
      if (!people.has(key)) {
        const group = e.match?.group ?? null;
        people.set(key, { key, name: e.person ?? e.card ?? 'Unknown', group, kind: group && visitors.has(group.toLowerCase()) ? 'visitor' : 'staff', lastAt: e.at, lastDoor: e.door, source: ['door'] });
      }
    }
    const m = e.door ? ROOM.exec(e.door) : null;
    if (m && t >= roomCut && !roomsSeen.has(m[1]!.toUpperCase())) roomsSeen.set(m[1]!.toUpperCase(), { at: e.at, by: known ? e.person : null, known });
  }

  // Attendance: checked in (and not out) counts as on site; a check-out after the last door event removes the person.
  let attendance: { on: boolean; in: number } = { on: false, in: 0 };
  if (await attendanceOn(hotelId)) {
    const t = await attendanceToday(hotelId);
    attendance = { on: true, in: t.counts.in };
    const ta = await many(pool, `SELECT id, vl_user_id, full_name, department FROM ta_people WHERE hotel_id=$1 AND active`, [hotelId]);
    const byId = new Map(ta.map((p) => [p.id, p]));
    for (const p of t.people) {
      const row = byId.get(p.id);
      const key = row?.vl_user_id ? `vl:${row.vl_user_id}` : `name:${row?.full_name ?? p.id}`;
      const seen = people.get(key) ?? [...people.values()].find((x) => x.name === row?.full_name);
      if (p.state === 'in') {
        if (seen) { if (!seen.source.includes('attendance')) seen.source.push('attendance'); }
        else people.set(key, { key, name: row?.full_name ?? 'Unknown', group: row?.department ?? null, kind: 'staff', lastAt: p.lastAt ?? now.toISOString(), lastDoor: null, source: ['attendance'] });
      } else if (p.state === 'out' && seen && p.lastAt && Date.parse(p.lastAt) > Date.parse(seen.lastAt)) people.delete(seen.key);
    }
  }

  // Rooms: the in-house list (PMS import / front office) and doors opened recently.
  const doors = await many(pool, `SELECT external_id, name FROM resources WHERE hotel_id=$1 AND kind='door' AND active`, [hotelId]);
  const roomDoors = doors.map((d) => ROOM.exec(d.name)?.[1]?.toUpperCase()).filter(Boolean) as string[];
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const stays = await many(pool, `SELECT room, guest_name, adults, children, departure::text FROM bf_stays WHERE hotel_id=$1 AND arrival <= $2::date AND departure > $2::date
      AND (ended_on IS NULL OR ended_on > $2::date) AND checked_out_at IS NULL`, [hotelId, day]);
  const rooms = new Map<string, { room: string; floor: string; guests: number; names: string[]; departure: string | null; lastEntry: string | null; lastBy: string | null; status: 'in_house' | 'activity' | 'empty' }>();
  const room = (r: string) => {
    let x = rooms.get(r);
    if (!x) { x = { room: r, floor: floorOf(r, pol.floorDigits), guests: 0, names: [], departure: null, lastEntry: null, lastBy: null, status: 'empty' }; rooms.set(r, x); }
    return x;
  };
  for (const r of roomDoors) room(r);
  for (const s of stays) {
    const x = room(String(s.room).toUpperCase());
    x.guests += s.adults + s.children; if (s.guest_name) x.names.push(s.guest_name); x.departure = s.departure; x.status = 'in_house';
  }
  for (const [r, s] of roomsSeen) {
    const x = room(r);
    x.lastEntry = s.at; x.lastBy = s.by;
    if (x.status === 'empty') x.status = 'activity';
  }
  const list = [...rooms.values()].sort((a, b) => a.floor.localeCompare(b.floor, undefined, { numeric: true }) || a.room.localeCompare(b.room, undefined, { numeric: true }));
  const floors = new Map<string, { floor: string; rooms: number; inHouse: number; activity: number; guests: number }>();
  for (const r of list) {
    const f = floors.get(r.floor) ?? { floor: r.floor, rooms: 0, inHouse: 0, activity: 0, guests: 0 };
    f.rooms++; if (r.status === 'in_house') f.inHouse++; if (r.status === 'activity') f.activity++; f.guests += r.guests;
    floors.set(r.floor, f);
  }
  const ppl = [...people.values()].sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.name.localeCompare(b.name));
  const em = await one(pool, `SELECT id, kind, status, reason, requested_at, activated_at, roll FROM emergencies WHERE hotel_id=$1 AND status IN ('REQUESTED','ACTIVE') ORDER BY requested_at DESC LIMIT 1`, [hotelId]);
  return {
    at: now.toISOString(), tz, policy: { staffOnSiteHours: pol.staffOnSiteHours, roomActivityHours: pol.roomActivityHours },
    totals: {
      staff: ppl.filter((p) => p.kind === 'staff').length, visitors: ppl.filter((p) => p.kind === 'visitor').length,
      guests: list.reduce((a, r) => a + r.guests, 0), roomsInHouse: list.filter((r) => r.status === 'in_house').length,
      roomsActivity: list.filter((r) => r.status === 'activity').length, rooms: list.length,
    },
    sources: { doorEvents: ev.events.length, doorEventsCapped: ev.truncated, attendance, inHouseList: stays.length > 0 },
    people: ppl, rooms: list, floors: [...floors.values()],
    emergency: em ? { id: em.id, kind: em.kind, status: em.status, reason: em.reason, requestedAt: em.requested_at, activatedAt: em.activated_at, roll: em.roll ?? {} } : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------------------------------------------
const AREAS = ['overview', 'insights', 'access', 'events', 'monitoring', 'visionline', 'staff', 'keys', 'attendance', 'breakfast', 'battery', 'maintenance',
  'operators', 'connector', 'branding', 'settings', 'audit', 'account', 'idcards', 'muster', 'emergency', 'usage', 'help', 'keycards', 'setup-report'] as const;
const recentPings = new Map<string, number>();
/** What a page view or action is worth in minutes saved (editable in the Usage page, these are starting points). */
const OUTCOMES: Record<string, { label: string; actions?: string[]; table?: string }> = {
  keysIssued: { label: 'Mobile keys issued', actions: ['key.created_in_visionline'] },
  keysRemoved: { label: 'Mobile keys removed', actions: ['key.revoke_confirmed_by_visionline'] },
  cardReads: { label: 'Keycards read at the encoder', actions: ['card.read_at_encoder_requested'] },
  reportsPrinted: { label: 'Reports printed (PDF)', actions: ['report.printed'] },
  reportsExported: { label: 'Reports exported (CSV)', actions: ['report.exported', 'reports.exported', 'attendance.exported', 'breakfast.exported', 'battery.exported', 'maintenance.exported', 'audit.exported'] },
  reportsSaved: { label: 'Own reports saved', actions: ['report.saved'] },
  directorySyncs: { label: 'Visionline people & cards read', actions: ['directory.synced'] },
  alertsHandled: { label: 'Alerts acknowledged or resolved', actions: ['monitor.alert_acknowledged', 'monitor.alert_resolved', 'battery.alert_acknowledged', 'battery.alert_resolved'] },
  maintenance: { label: 'Maintenance requests', actions: ['maintenance.created'] },
  attendanceRecords: { label: 'Attendance records (desk / HR)', actions: ['attendance.record_added'] },
  breakfastServed: { label: 'Breakfast rooms served', table: 'bf_served' },
  idCardsPrinted: { label: 'ID cards printed', actions: ['idcard.printed'] },
};

async function usageSummary(hotelId: string, days: number) {
  const since = `now() - make_interval(days => ${Math.trunc(Number(days)) || 30})`;
  const [areas, daily, people, actions, bf, ops, punches] = await Promise.all([
    many(pool, `SELECT area, sum(n)::int AS views, count(DISTINCT operator_id)::int AS people FROM usage_daily WHERE hotel_id=$1 AND day > (${since})::date GROUP BY area ORDER BY views DESC`, [hotelId]),
    many(pool, `SELECT day::text, sum(n)::int AS views, count(DISTINCT operator_id)::int AS people FROM usage_daily WHERE hotel_id=$1 AND day > (${since})::date GROUP BY day ORDER BY day`, [hotelId]),
    many(pool, `SELECT o.id, o.display_name, o.last_sign_in_at, count(DISTINCT u.day)::int AS active_days, sum(u.n)::int AS views,
        (SELECT array_agg(area ORDER BY s DESC) FROM (SELECT area, sum(n) s FROM usage_daily x WHERE x.hotel_id=$1 AND x.operator_id=o.id AND x.day > (${since})::date GROUP BY area ORDER BY s DESC LIMIT 3) t) AS top
      FROM operators o JOIN memberships m ON m.operator_id=o.id AND m.hotel_id=$1
      LEFT JOIN usage_daily u ON u.operator_id=o.id AND u.hotel_id=$1 AND u.day > (${since})::date
      GROUP BY o.id ORDER BY views DESC NULLS LAST, o.display_name`, [hotelId]),
    many(pool, `SELECT action, count(*)::int AS n FROM audit_log WHERE hotel_id=$1 AND at > ${since} GROUP BY action`, [hotelId]),
    one(pool, `SELECT count(*)::int AS n FROM bf_served WHERE hotel_id=$1 AND served_at > ${since} AND voided_at IS NULL`, [hotelId]),
    one(pool, `SELECT count(DISTINCT operator_id)::int AS n FROM memberships WHERE hotel_id=$1`, [hotelId]),
    one(pool, `SELECT count(*)::int AS n FROM ta_punches WHERE hotel_id=$1 AND source='door' AND at > ${since} AND voided_at IS NULL`, [hotelId]),
  ]);
  const byAction = new Map(actions.map((a) => [a.action, a.n]));
  const outcomes = Object.entries(OUTCOMES).map(([id, o]) => ({
    id, label: o.label, n: o.table === 'bf_served' ? bf?.n ?? 0 : (o.actions ?? []).reduce((a, x) => a + (byAction.get(x) ?? 0), 0),
  }));
  outcomes.push({ id: 'attendanceDoor', label: 'Attendance records from doors (automatic)', n: punches?.n ?? 0 });
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const activeWeek = new Set((await many(pool, `SELECT DISTINCT operator_id FROM usage_daily WHERE hotel_id=$1 AND day >= $2::date`, [hotelId, weekAgo])).map((r) => r.operator_id)).size;
  return {
    days, operators: ops?.n ?? 0, activeLast7Days: activeWeek,
    areas, daily, outcomes,
    people: people.map((p) => ({ id: p.id, name: p.display_name, lastSignIn: p.last_sign_in_at, activeDays: p.active_days, views: p.views ?? 0, top: p.top ?? [] })),
  };
}

/** Installation key that signs usage summaries (kept encrypted in the platform secret store, never shown). */
async function usageKey(hotelId: string) {
  if (!secretStoreEnabled()) return null;
  let pem = storedSecret(hotelId, 'SMK_USAGE_SIGNING_KEY');
  if (!pem) {
    pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    await setStoredSecret(hotelId, 'SMK_USAGE_SIGNING_KEY', pem, null);
  }
  const priv = createPrivateKey(pem);
  const pub = (createPublicKey(priv).export({ format: 'jwk' }) as any).x as string;
  return { priv, pub };
}

// ---------------------------------------------------------------------------------------------------------------
// Staff ID profiles
// ---------------------------------------------------------------------------------------------------------------
const Photo = z.string().max(400_000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, 'The photo must be a JPEG image.').refine((v) => {
  const b = Buffer.from(v.slice(23, 23 + 8), 'base64');
  return b[0] === 0xff && b[1] === 0xd8;
}, 'The photo is not a valid JPEG image.');
const ProfileIn = z.object({
  fullName: z.string().trim().min(1).max(120), idNumber: z.string().trim().max(40).regex(/^[A-Za-z0-9 ._/-]*$/, 'Use letters, numbers and . _ / - only').optional().nullable(),
  department: z.string().trim().max(80).optional().nullable(), jobTitle: z.string().trim().max(80).optional().nullable(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(), photo: Photo.optional().nullable(),
  vlUserId: z.string().max(200).optional().nullable(), staffId: uuid.optional().nullable(), taPersonId: uuid.optional().nullable(),
});
const profileOut = (p: any, withPhoto = false) => ({
  id: p.id, fullName: p.full_name, idNumber: p.id_number, department: p.department, jobTitle: p.job_title, validUntil: p.valid_until,
  hasPhoto: Boolean(p.has_photo ?? p.photo), photo: withPhoto ? p.photo ?? null : undefined, vlUserId: p.vl_user_id, staffId: p.staff_id, taPersonId: p.ta_person_id,
  printedAt: p.printed_at, printCount: p.print_count, updatedAt: p.updated_at,
});
const PROFILE_COLS = `id, full_name, id_number, department, job_title, valid_until::text, (photo IS NOT NULL) AS has_photo, vl_user_id, staff_id, ta_person_id, printed_at, print_count, updated_at`;
const nullish = (v: string | null | undefined) => (v === undefined ? undefined : v === '' ? null : v);

export function safetyRoutes(app: FastifyInstance) {
  // ---- Muster -------------------------------------------------------------------------------------------------
  app.get(`${P}/hotels/:hotelId/muster`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'muster.read');
    return musterView(hotelId);
  });
  /** Evacuation list (PDF): everyone thought to be on site and every room in house, with a tick box column. */
  app.get(`${P}/hotels/:hotelId/muster/pdf`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'muster.read');
    const v = await musterView(hotelId);
    const t = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: v.tz, hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }).format(new Date(iso)) : '');
    const roll = (v.emergency?.roll ?? {}) as Record<string, any>;
    const out = await buildReportPdf({
      hotelId, report: 'muster', title: 'Evacuation list (muster)', operatorId: op.id, operatorName: op.displayName,
      selection: [`Printed ${t(v.at)} (${v.tz}). Staff seen at a door in the last ${v.policy.staffOnSiteHours} h or checked in; rooms on the in-house list or opened in the last ${v.policy.roomActivityHours} h.`,
        'Locks record entries, not exits: check every room and area, this list is a starting point.'],
      summary: [['Staff on site', String(v.totals.staff)], ['Visitors / contractors', String(v.totals.visitors)], ['Guests in house', String(v.totals.guests)], ['Rooms in house', String(v.totals.roomsInHouse)], ['Other rooms opened', String(v.totals.roomsActivity)]],
      columns: [{ label: 'Safe', width: 6 }, { label: 'Type', width: 10 }, { label: 'Room / name', width: 22 }, { label: 'Floor / group', width: 14 }, { label: 'Guests / last door', width: 26 }, { label: 'Last seen', width: 12 }],
      rows: [
        ...v.rooms.filter((r) => r.status !== 'empty').map((r) => [roll[`room:${r.room}`]?.safe ? 'SAFE' : '[  ]', r.status === 'in_house' ? 'Room' : 'Room (door)', r.room, `Floor ${r.floor}`,
          r.status === 'in_house' ? `${r.guests} guest(s)${r.names.length ? ` - ${r.names.join(' / ')}` : ''}` : `Door opened${r.lastBy ? ` by ${r.lastBy}` : ''}`, t(r.lastEntry)]),
        ...v.people.map((p) => [roll[`person:${p.key}`]?.safe ? 'SAFE' : '[  ]', p.kind === 'staff' ? 'Staff' : 'Visitor', p.name, p.group ?? '', p.lastDoor ?? (p.source.includes('attendance') ? 'Checked in (attendance)' : ''), t(p.lastAt)]),
      ],
      filters: { emergency: v.emergency?.id ?? null },
    });
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'report.printed', targetType: 'report', targetId: out.reportId, details: { report: 'muster', sha256: out.sha256, emergency: v.emergency?.id ?? null } });
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="evacuation-list.pdf"`).header('cache-control', 'private, no-store').header('x-report-id', out.reportId);
    return reply.send(out.bytes);
  });

  // ---- Emergencies --------------------------------------------------------------------------------------------
  /** Is an emergency open? (menu badge, polled by every open portal of people with the muster permission) */
  app.get(`${P}/hotels/:hotelId/emergency/status`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'muster.read');
    const e = await one(pool, `SELECT id, kind, status FROM emergencies WHERE hotel_id=$1 AND status IN ('REQUESTED','ACTIVE') ORDER BY requested_at DESC LIMIT 1`, [hotelId]);
    return { open: e ? { id: e.id, kind: e.kind, status: e.status } : null };
  });
  app.get(`${P}/hotels/:hotelId/emergency`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'muster.read');
    const pol = await safetyPolicy(hotelId);
    const [list, emergencyCards, responders, template] = await Promise.all([
      many(pool, `SELECT e.*, a.display_name AS requested_name, b.display_name AS confirmed_name, c.display_name AS ended_name FROM emergencies e
          LEFT JOIN operators a ON a.id=e.requested_by LEFT JOIN operators b ON b.id=e.confirmed_by LEFT JOIN operators c ON c.id=e.ended_by
          WHERE e.hotel_id=$1 ORDER BY e.requested_at DESC LIMIT 20`, [hotelId]),
      one(pool, `SELECT count(*)::int AS n FROM vl_cards WHERE hotel_id=$1 AND active AND NOT cancelled AND NOT expired AND NOT discarded
          AND (user_group ILIKE '%emergenc%' OR 'emergency' = ANY(operations) OR format ILIKE '%emergenc%')`, [hotelId]),
      many(pool, `SELECT s.id, s.full_name, s.job_role FROM staff s JOIN endpoints e ON e.staff_id=s.id AND e.status='ACTIVE' WHERE s.hotel_id=$1 AND s.status='ACTIVE' ORDER BY s.full_name`, [hotelId]),
      pol.emergencyTemplateId ? one(pool, `SELECT id, name FROM access_templates WHERE id=$1 AND hotel_id=$2`, [pol.emergencyTemplateId, hotelId]) : null,
    ]);
    return {
      emergencies: list.map((e) => ({ id: e.id, kind: e.kind, status: e.status, reason: e.reason, requestedBy: e.requested_name, confirmedBy: e.confirmed_name, endedBy: e.ended_name,
        requestedAt: e.requested_at, activatedAt: e.activated_at, endedAt: e.ended_at, roll: e.roll, actions: e.actions, requestedById: e.requested_by })),
      readiness: {
        emergencyCards: emergencyCards?.n ?? 0, responders: responders.map((r) => ({ id: r.id, name: r.full_name, role: r.job_role })),
        template: template ? { id: template.id, name: template.name } : null, keyHours: pol.emergencyKeyHours,
        remoteOpen: await (async () => {
          const dc = (await getConfig(pool, hotelId, 'policy'))?.safety?.doorCommands ?? {};
          const rooms = await many(pool, `SELECT data FROM resources WHERE hotel_id=$1 AND kind='door' AND active AND (data->>'doorCategory'='guest' OR name ~ '^[0-9]{2,5}[A-Za-z]?$')`, [hotelId]);
          const online = rooms.filter((d) => d.data?.online === true).length;
          return { available: Boolean(dc.enabled) && online > 0, enabled: Boolean(dc.enabled), online, offline: rooms.length - online,
            reason: 'Online locks get the emergency open command from Visionline; offline locks need the emergency card (encode one in Staff keycards -> Encoders & special cards).' };
        })(),
      },
    };
  });
  app.post(`${P}/hotels/:hotelId/emergency`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'emergency.manage');
    await requireReauth(req, op);
    const b = z.object({ kind: z.enum(['fire', 'evacuation', 'drill', 'other']), reason: z.string().trim().min(3).max(300) }).parse(req.body);
    const r = await tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`emergency:${hotelId}`]);
      if (await one(c, `SELECT 1 FROM emergencies WHERE hotel_id=$1 AND status IN ('REQUESTED','ACTIVE')`, [hotelId])) throw conflict('EMERGENCY_OPEN', 'An emergency is already open. Confirm or end it first.');
      const e = await one(c, `INSERT INTO emergencies (hotel_id, kind, status, reason, requested_by) VALUES ($1,$2,'REQUESTED',$3,$4) RETURNING id`, [hotelId, b.kind, b.reason, op.id]);
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'emergency.requested', targetType: 'emergency', targetId: e!.id, details: { kind: b.kind, reason: b.reason } });
      return e!;
    });
    return reply.code(201).send({ id: r.id, status: 'REQUESTED' });
  });
  app.post(`${P}/hotels/:hotelId/emergency/:id/confirm`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'emergency.manage');
    await requireReauth(req, op);
    const id = uuid.parse((req.params as any).id);
    return tx(async (c) => {
      const e = await one(c, `SELECT * FROM emergencies WHERE id=$1 AND hotel_id=$2 FOR UPDATE`, [id, hotelId]);
      if (!e) throw notFound('Emergency');
      if (e.status !== 'REQUESTED') throw conflict('NOT_REQUESTED', 'This emergency is not waiting for confirmation.');
      if (e.requested_by === op.id) throw forbidden('A second person must confirm the emergency.');
      await c.query(`UPDATE emergencies SET status='ACTIVE', confirmed_by=$2, activated_at=now() WHERE id=$1`, [id, op.id]);
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'emergency.activated', targetType: 'emergency', targetId: id, details: { kind: e.kind, requestedBy: e.requested_by } });
      return { id, status: 'ACTIVE' };
    });
  });
  app.post(`${P}/hotels/:hotelId/emergency/:id/end`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'emergency.manage');
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ note: z.string().trim().min(3).max(300) }).parse(req.body);
    return tx(async (c) => {
      const e = await one(c, `SELECT * FROM emergencies WHERE id=$1 AND hotel_id=$2 FOR UPDATE`, [id, hotelId]);
      if (!e) throw notFound('Emergency');
      if (!['REQUESTED', 'ACTIVE'].includes(e.status)) throw conflict('NOT_OPEN', 'This emergency is already closed.');
      const status = e.status === 'REQUESTED' ? 'CANCELLED' : 'ENDED';
      await c.query(`UPDATE emergencies SET status=$2, ended_by=$3, ended_at=now(), actions = actions || $4::jsonb WHERE id=$1`, [id, status, op.id, JSON.stringify([{ at: new Date().toISOString(), by: op.displayName, what: `${status === 'ENDED' ? 'Ended' : 'Cancelled'}: ${b.note}` }])]);
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: status === 'ENDED' ? 'emergency.ended' : 'emergency.cancelled', targetType: 'emergency', targetId: id, details: { note: b.note } });
      // 2.14 Doors opened remotely go back to normal when the emergency ends (Settings -> Safety: closeOnEnd).
      const runs = await many(c, `SELECT doors FROM emergency_door_runs WHERE emergency_id=$1 AND command='emergencyOpen'`, [id]);
      const pol = (await getConfig(c, hotelId, 'policy'))?.safety?.doorCommands ?? {};
      const opened = [...new Set(runs.flatMap((r: any) => r.doors as string[]))];
      if (opened.length && pol.closeOnEnd !== false) {
        const ids: string[] = [];
        for (let i = 0; i < opened.length; i += 60) ids.push((await enqueue(c, { hotelId, type: 'DOOR_COMMANDS', payload: { command: 'emergencyClose', doors: opened.slice(i, i + 60), parallel: pol.parallel ?? 6, timeoutSec: 30 }, idempotencyKey: `em:${id}:close:${i}`, correlationId: newCorrelationId(), ttlSec: 300 })).id);
        await c.query(`INSERT INTO emergency_door_runs (hotel_id, emergency_id, command, doors, command_ids, created_by) VALUES ($1,$2,'emergencyClose',$3,$4,$5)`, [hotelId, id, opened, ids, op.id]);
      }
      return { id, status };
    });
  });
  /**
   * 2.14 Emergency open (or back to normal) of the guest rooms with online locks [Web API §5.13.4, §7.12]: sent in
   * batches during a confirmed emergency (never a drill). Offline locks cannot be reached: they are listed so staff
   * use the emergency card.
   */
  app.post(`${P}/hotels/:hotelId/emergency/:id/doors`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'emergency.manage');
    await requireReauth(req, op);
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ command: z.enum(['emergencyOpen', 'emergencyClose']) }).parse(req.body);
    const e = await one(pool, `SELECT * FROM emergencies WHERE id=$1 AND hotel_id=$2`, [id, hotelId]);
    if (!e) throw notFound('Emergency');
    if (b.command === 'emergencyOpen' && (e.status !== 'ACTIVE' || e.kind === 'drill')) throw conflict('NOT_ACTIVE', e.kind === 'drill' ? 'Doors are not opened during a drill.' : 'A second person must confirm the emergency first.');
    const pol = (await getConfig(pool, hotelId, 'policy'))?.safety?.doorCommands ?? {};
    if (!pol.enabled) throw conflict('DOOR_COMMANDS_OFF', 'Remote door commands are switched off (Settings -> Safety & emergency). Test them on one door first.');
    const doors = await many(pool, `SELECT external_id, name, data FROM resources WHERE hotel_id=$1 AND kind='door' AND active`, [hotelId]);
    const scope = pol.scope ?? 'rooms';
    const chosen = doors.filter((d) => scope === 'all' || (scope === 'groups' ? (pol.doorGroups ?? []).includes(d.data?.doorGroup) : (d.data?.doorCategory === 'guest' || ROOM.test(d.name))));
    const online = chosen.filter((d) => d.data?.online === true).map((d) => d.external_id);
    const offline = chosen.filter((d) => d.data?.online !== true).map((d) => d.name);
    const ids: string[] = [];
    for (let i = 0; i < online.length; i += 60) {
      const cmd = await enqueue(pool, { hotelId, type: 'DOOR_COMMANDS', payload: { command: b.command, doors: online.slice(i, i + 60), parallel: pol.parallel ?? 6, timeoutSec: 30 },
        idempotencyKey: `em:${id}:${b.command}:${i}:${Date.now()}`, correlationId: newCorrelationId(), ttlSec: 300 });
      ids.push(cmd.id);
    }
    await pool.query(`INSERT INTO emergency_door_runs (hotel_id, emergency_id, command, doors, skipped, command_ids, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [hotelId, id, b.command, online, offline, ids, op.id]);
    await pool.query(`UPDATE emergencies SET actions = actions || $2::jsonb WHERE id=$1`, [id, JSON.stringify([{ at: new Date().toISOString(), by: op.displayName, what: `${b.command === 'emergencyOpen' ? 'Emergency open' : 'Back to normal'} sent to ${online.length} online door(s); ${offline.length} offline (emergency card)` }])]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: b.command === 'emergencyOpen' ? 'emergency.doors_opened' : 'emergency.doors_normal', targetType: 'emergency', targetId: id, details: { online: online.length, offline: offline.length } });
    return { online: online.length, offline, commandIds: ids };
  });
  /** Results of the door commands of an emergency (which doors answered). */
  app.get(`${P}/hotels/:hotelId/emergency/:id/doors`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'muster.read');
    const id = uuid.parse((req.params as any).id);
    const runs = await many(pool, `SELECT r.*, (SELECT json_agg(json_build_object('status', c.status, 'result', c.result)) FROM commands c WHERE c.id = ANY(r.command_ids)) AS cmds FROM emergency_door_runs r WHERE r.hotel_id=$1 AND r.emergency_id=$2 ORDER BY r.created_at`, [hotelId, id]);
    return runs.map((r) => {
      const results = (r.cmds ?? []).flatMap((c: any) => c.result?.results ?? []);
      return { command: r.command, at: r.created_at, doors: r.doors.length, offline: r.skipped, pending: (r.cmds ?? []).filter((c: any) => !['SUCCEEDED', 'FAILED', 'EXPIRED'].includes(c.status)).length,
        reached: results.filter((x: any) => x.ok).length, failed: results.filter((x: any) => !x.ok).map((x: any) => ({ door: x.door, error: x.error })) };
    });
  });
  /** Roll call: tick a person or a room as safe (or undo). */
  app.post(`${P}/hotels/:hotelId/emergency/:id/roll`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'muster.read');
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ key: z.string().regex(/^(person|room):.{1,220}$/), safe: z.boolean() }).parse(req.body);
    const r = await one(pool, `UPDATE emergencies SET roll = CASE WHEN $3 THEN roll || jsonb_build_object($2::text, jsonb_build_object('safe', true, 'by', $4::text, 'at', now()))
        ELSE roll - $2::text END WHERE id=$1 AND hotel_id=$5 AND status IN ('REQUESTED','ACTIVE') AND (NOT $3 OR (SELECT count(*) FROM jsonb_object_keys(roll)) < 5000) RETURNING roll`, [id, b.key, b.safe, op.displayName, hotelId]);
    if (!r) throw conflict('NOT_OPEN', 'Start an emergency (or a drill) to keep a roll call.');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'emergency.roll_call', targetType: 'emergency', targetId: id, details: { key: b.key, safe: b.safe } });
    return { roll: r.roll };
  });
  /**
   * Emergency mobile keys for responders (staff with an active phone), with the emergency template, for a few hours.
   * The emergency was started and confirmed by two people, which counts as the approval for broad access.
   */
  app.post(`${P}/hotels/:hotelId/emergency/:id/keys`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'emergency.manage');
    if (!permsIn(op, hotelId).has('key.issue')) throw forbidden('Issuing keys needs the permission to issue mobile keys.');
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ staffIds: z.array(uuid).min(1).max(30) }).parse(req.body);
    const e = await one(pool, `SELECT * FROM emergencies WHERE id=$1 AND hotel_id=$2`, [id, hotelId]);
    if (!e) throw notFound('Emergency');
    if (e.status !== 'ACTIVE' || e.kind === 'drill') throw conflict('NOT_ACTIVE', e.kind === 'drill' ? 'Emergency keys are not issued during a drill.' : 'A second person must confirm the emergency first.');
    const pol = await safetyPolicy(hotelId);
    if (!pol.emergencyTemplateId) throw badRequest('NO_TEMPLATE', 'Choose the emergency key template first (Settings -> Safety).');
    const expiresAt = new Date(Date.now() + pol.emergencyKeyHours * 3_600_000).toISOString();
    const results: { staffId: string; ok: boolean; status?: string; error?: string }[] = [];
    for (const staffId of b.staffIds) {
      try {
        const r = await requestKey(op, hotelId, { staffId, templateId: pol.emergencyTemplateId, doorIds: [], doorGroupIds: [], expiresAt, reason: `Emergency ${e.kind}: ${e.reason}` }, `emergency:${id}:${staffId}`);
        let status = r.key!.status as string;
        if (status === 'PENDING_APPROVAL') {
          await tx(async (c) => {
            const k = await one(c, `UPDATE key_requests SET status='QUEUED', approved_by=$3, approved_at=now(), updated_at=now() WHERE id=$1 AND hotel_id=$2 AND status='PENDING_APPROVAL' RETURNING *`, [r.key!.id, hotelId, e.confirmed_by]);
            if (k) {
              await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'key.approved', targetType: 'key_request', targetId: k.id, details: { by: 'emergency two-person confirmation', emergency: id, requestedBy: e.requested_by, confirmedBy: e.confirmed_by } });
              await enqueueIssue(c, k);
            }
          });
          status = 'QUEUED';
        }
        results.push({ staffId, ok: true, status });
      } catch (err: any) { results.push({ staffId, ok: false, error: err?.message ?? 'Failed' }); }
    }
    await pool.query(`UPDATE emergencies SET actions = actions || $2::jsonb WHERE id=$1`, [id, JSON.stringify([{ at: new Date().toISOString(), by: op.displayName, what: `Emergency keys: ${results.filter((r) => r.ok).length} issued, ${results.filter((r) => !r.ok).length} failed` }])]);
    return { results };
  });

  // ---- Usage --------------------------------------------------------------------------------------------------
  app.post(`${P}/hotels/:hotelId/usage/ping`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await member(req, hotelId);
    const b = z.object({ area: z.enum(AREAS) }).parse(req.body);
    const k = `${op.id}:${hotelId}:${b.area}`;
    const last = recentPings.get(k) ?? 0;
    if (Date.now() - last > 60_000) {
      recentPings.set(k, Date.now());
      if (recentPings.size > 20_000) recentPings.clear();
      const tz = await hotelTz(hotelId);
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      await pool.query(`INSERT INTO usage_daily (hotel_id, day, area, operator_id, n) VALUES ($1,$2,$3,$4,1) ON CONFLICT (hotel_id, day, area, operator_id) DO UPDATE SET n = usage_daily.n + 1`, [hotelId, day, b.area, op.id]);
    }
    return reply.code(204).send();
  });
  app.get(`${P}/hotels/:hotelId/usage`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'settings.manage');
    const q = z.object({ days: z.coerce.number().int().min(7).max(366).default(30) }).parse(req.query);
    return usageSummary(hotelId, q.days);
  });
  /**
   * Anonymous usage summary for the supplier (.smkusage): counts only, no names, e-mails or guest data. Signed with
   * this installation's key so the License Manager can tell it was not edited. Nothing is sent anywhere: the hotel
   * downloads it and e-mails it with the licence renewal.
   */
  app.get(`${P}/hotels/:hotelId/usage/export`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const q = z.object({ days: z.coerce.number().int().min(7).max(366).default(90) }).parse(req.query);
    const [u, lic, doors, vlUsers] = await Promise.all([
      usageSummary(hotelId, q.days), licenceStatus(pool, hotelId),
      one(pool, `SELECT count(*)::int AS n FROM resources WHERE hotel_id=$1 AND kind='door' AND active`, [hotelId]),
      one(pool, `SELECT count(*)::int AS n FROM vl_users WHERE hotel_id=$1 AND active`, [hotelId]),
    ]);
    const body = {
      v: 1, kind: 'smk-usage', id: randomUUID(), generatedAt: new Date().toISOString(), days: q.days, version: PLATFORM_VERSION,
      installationId: lic.installationId, hotel: lic.hotel, systemId: lic.systemId, licence: lic.licence?.id ?? null, licenceState: lic.state,
      size: { doors: doors?.n ?? 0, visionlineUsers: vlUsers?.n ?? 0, portalUsers: u.operators },
      activity: { activeLast7Days: u.activeLast7Days, activeDays: u.daily.length, pageViews: u.areas.reduce((a, x) => a + x.views, 0), areas: Object.fromEntries(u.areas.map((a) => [a.area, { views: a.views, people: a.people }])) },
      outcomes: Object.fromEntries(u.outcomes.map((o) => [o.id, o.n])),
    };
    const k = await usageKey(hotelId);
    const canon = JSON.stringify(body);
    const file = { ...body, sha256: createHash('sha256').update(canon).digest('hex'), signer: k?.pub ?? null, sig: k ? edSign(null, Buffer.from(canon), k.priv).toString('base64url') : null };
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'usage.exported', details: { days: q.days, id: body.id } });
    const name = `usage-${(lic.hotel ?? 'hotel').replace(/[^A-Za-z0-9]+/g, '-')}-${body.generatedAt.slice(0, 10)}.smkusage`;
    reply.header('content-type', 'application/json').header('content-disposition', `attachment; filename="${name}"`).header('cache-control', 'private, no-store');
    return JSON.stringify(file, null, 2);
  });

  // ---- Staff ID profiles --------------------------------------------------------------------------------------
  const pbase = `${P}/hotels/:hotelId/idcards`;
  /** Card layout (Settings -> Safety & people) and what is printed on the back. */
  app.get(`${pbase}/layout`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'idcards.manage');
    const [pol, prop] = await Promise.all([getConfig(pool, hotelId, 'policy'), getConfig(pool, hotelId, 'property')]);
    return {
      layout: { orientation: 'portrait', title: 'STAFF', showDepartment: true, showJobTitle: true, showIdNumber: true, showValidUntil: false, showBarcode: true,
        backText: 'This card is the property of the hotel. If found, please return it to reception.', safeMarginMm: 1.5, ...(pol?.idCard ?? {}) },
      hotel: { name: prop?.displayName ?? null, phone: prop?.supportPhone ?? null, address: prop?.address ?? null, website: prop?.homepage ?? null },
    };
  });
  app.get(`${pbase}/profiles`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'idcards.manage');
    const q = z.object({ q: z.string().max(80).optional(), department: z.string().max(80).optional() }).parse(req.query);
    const rows = await many(pool, `SELECT ${PROFILE_COLS} FROM id_profiles WHERE hotel_id=$1 AND active
        AND ($2::text IS NULL OR full_name ILIKE $2 OR id_number ILIKE $2) AND ($3::text IS NULL OR department = $3) ORDER BY department NULLS LAST, full_name LIMIT 2000`,
      [hotelId, q.q ? `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null, q.department ?? null]);
    const depts = await many(pool, `SELECT department, count(*)::int AS n FROM id_profiles WHERE hotel_id=$1 AND active AND department IS NOT NULL GROUP BY department ORDER BY department`, [hotelId]);
    return { profiles: rows.map((r) => profileOut(r)), departments: depts };
  });
  /** Profiles with their photos, for printing (at most 60 at a time). */
  app.post(`${pbase}/profiles/batch`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'idcards.manage');
    const b = z.object({ ids: z.array(uuid).min(1).max(60) }).parse(req.body);
    const rows = await many(pool, `SELECT *, valid_until::text FROM id_profiles WHERE hotel_id=$1 AND id = ANY($2) AND active`, [hotelId, b.ids]);
    const order = new Map(b.ids.map((x, i) => [x, i]));
    return rows.sort((a, c) => order.get(a.id)! - order.get(c.id)!).map((r) => profileOut(r, true));
  });
  app.post(`${pbase}/profiles`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'idcards.manage');
    const b = ProfileIn.parse(req.body);
    try {
      const r = await one(pool, `INSERT INTO id_profiles (hotel_id, full_name, id_number, department, job_title, valid_until, photo, vl_user_id, staff_id, ta_person_id, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${PROFILE_COLS}`,
        [hotelId, b.fullName, nullish(b.idNumber) ?? null, nullish(b.department) ?? null, nullish(b.jobTitle) ?? null, b.validUntil ?? null, b.photo ?? null, b.vlUserId ?? null, b.staffId ?? null, b.taPersonId ?? null, op.id]);
      await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'idcard.profile_created', targetType: 'id_profile', targetId: r!.id, details: { fullName: b.fullName, idNumber: b.idNumber, department: b.department, photo: Boolean(b.photo) } });
      return reply.code(201).send(profileOut(r));
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('DUPLICATE', 'Another profile already has this ID number or Visionline person.');
      throw e;
    }
  });
  app.patch(`${pbase}/profiles/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'idcards.manage');
    const id = uuid.parse((req.params as any).id);
    const b = ProfileIn.partial().parse(req.body);
    const sets: string[] = []; const vals: unknown[] = [id, hotelId];
    const col: Record<string, string> = { fullName: 'full_name', idNumber: 'id_number', department: 'department', jobTitle: 'job_title', validUntil: 'valid_until', photo: 'photo', vlUserId: 'vl_user_id' };
    for (const [k, c] of Object.entries(col)) if ((b as any)[k] !== undefined) { vals.push(nullish((b as any)[k])); sets.push(`${c}=$${vals.length}`); }
    if (!sets.length) throw badRequest('NOTHING_TO_CHANGE', 'Nothing to change.');
    try {
      const r = await one(pool, `UPDATE id_profiles SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 AND hotel_id=$2 AND active RETURNING ${PROFILE_COLS}`, vals);
      if (!r) throw notFound('Profile');
      await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'idcard.profile_changed', targetType: 'id_profile', targetId: id, details: { fields: Object.keys(b).filter((k) => (b as any)[k] !== undefined) } });
      return profileOut(r);
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('DUPLICATE', 'Another profile already has this ID number or Visionline person.');
      throw e;
    }
  });
  app.delete(`${pbase}/profiles/:id`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'idcards.manage');
    const id = uuid.parse((req.params as any).id);
    const r = await one(pool, `UPDATE id_profiles SET active=false, photo=NULL, updated_at=now() WHERE id=$1 AND hotel_id=$2 AND active RETURNING full_name`, [id, hotelId]);
    if (!r) throw notFound('Profile');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'idcard.profile_removed', targetType: 'id_profile', targetId: id, details: { fullName: r.full_name } });
    return { ok: true };
  });
  /** Create profiles for people who do not have one yet: Visionline people (by group), attendance people or mobile-key staff. */
  app.post(`${pbase}/profiles/import`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'idcards.manage');
    const b = z.object({ from: z.enum(['visionline', 'attendance', 'staff']), groups: z.array(z.string().max(60)).max(50).default([]) }).parse(req.body);
    let n = 0;
    if (b.from === 'visionline') {
      n = (await pool.query(`INSERT INTO id_profiles (hotel_id, full_name, department, vl_user_id, created_by)
          SELECT u.hotel_id, COALESCE(NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), ''), u.user_id), u.user_group, u.user_id, $3
          FROM vl_users u WHERE u.hotel_id=$1 AND u.active AND (cardinality($2::text[]) = 0 OR u.user_group = ANY($2))
          AND NOT EXISTS (SELECT 1 FROM id_profiles p WHERE p.hotel_id=u.hotel_id AND p.vl_user_id=u.user_id AND p.active)`, [hotelId, b.groups, op.id])).rowCount ?? 0;
    } else if (b.from === 'attendance') {
      n = (await pool.query(`INSERT INTO id_profiles (hotel_id, full_name, id_number, department, job_title, vl_user_id, staff_id, ta_person_id, created_by)
          SELECT t.hotel_id, t.full_name, CASE WHEN EXISTS (SELECT 1 FROM id_profiles q WHERE q.hotel_id=t.hotel_id AND q.active AND lower(q.id_number)=lower(t.employee_no)) THEN NULL ELSE t.employee_no END,
            t.department, t.job_title, CASE WHEN EXISTS (SELECT 1 FROM id_profiles q WHERE q.hotel_id=t.hotel_id AND q.active AND q.vl_user_id=t.vl_user_id) THEN NULL ELSE t.vl_user_id END, t.staff_id, t.id, $3
          FROM ta_people t WHERE t.hotel_id=$1 AND t.active AND (cardinality($2::text[]) = 0 OR t.department = ANY($2))
          AND NOT EXISTS (SELECT 1 FROM id_profiles p WHERE p.hotel_id=t.hotel_id AND p.ta_person_id=t.id AND p.active)`, [hotelId, b.groups, op.id])).rowCount ?? 0;
    } else {
      n = (await pool.query(`INSERT INTO id_profiles (hotel_id, full_name, id_number, department, job_title, staff_id, created_by)
          SELECT s.hotel_id, s.full_name, CASE WHEN EXISTS (SELECT 1 FROM id_profiles q WHERE q.hotel_id=s.hotel_id AND q.active AND lower(q.id_number)=lower(s.employee_no)) THEN NULL ELSE s.employee_no END,
            s.visionline_user_group, s.job_role, s.id, $3
          FROM staff s WHERE s.hotel_id=$1 AND s.status='ACTIVE' AND (cardinality($2::text[]) = 0 OR s.visionline_user_group = ANY($2))
          AND NOT EXISTS (SELECT 1 FROM id_profiles p WHERE p.hotel_id=s.hotel_id AND p.staff_id=s.id AND p.active)`, [hotelId, b.groups, op.id])).rowCount ?? 0;
    }
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'idcard.profiles_imported', details: { from: b.from, groups: b.groups, created: n } });
    return { created: n };
  });
  /** Record that cards were sent to the printer (for the reprint count and the audit trail). */
  app.post(`${pbase}/printed`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'idcards.manage');
    const b = z.object({ ids: z.array(uuid).min(1).max(60) }).parse(req.body);
    const r = await many(pool, `UPDATE id_profiles SET printed_at=now(), print_count=print_count+1 WHERE hotel_id=$1 AND id = ANY($2) AND active RETURNING id, full_name, print_count`, [hotelId, b.ids]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'idcard.printed', details: { cards: r.map((x) => ({ id: x.id, name: x.full_name, copy: x.print_count })) } });
    return { printed: r.length };
  });
}
