import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, many } from '../db.ts';
import { audit } from '../audit.ts';
import { requirePerm } from '../auth.ts';
import { insights, batteryInsights } from '../insights.ts';
import { requestDirectorySync } from '../directory.ts';
import { maintenancePolicy } from '../maintenance.ts';
import { notFound } from '../lib/errors.ts';

/** Management reports (Insights). Read-only; personal data limited to names and user groups. */
const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Hotel');
  return id;
};
const Filters = z.object({
  days: z.coerce.number().int().refine((d) => [1, 7, 30, 90, 180, 365].includes(d), 'days must be 1, 7, 30, 90, 180 or 365').default(30),
  group: z.string().max(100).optional().transform((v) => v || null),
  floor: z.string().max(100).optional().transform((v) => v || null),
});
const VALID = `NOT (k.cancelled OR k.discarded OR k.overridden OR k.expired)`;
const csvCell = (v: unknown) => {
  let s = typeof v === 'string' ? v : v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (head: string[], rows: unknown[][]) => [head.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');

/** Valid Visionline keycards with holder and group (directory snapshot). */
async function validCards(hotelId: string, o: { group?: string | null; q?: string | null; expiringDays?: number | null; limit: number }) {
  const rows = await many(pool, `SELECT k.reg_no, k.card_holder, COALESCE(u.given_name || ' ' || u.surname, u.surname, u.given_name, k.card_holder) AS holder_name,
      COALESCE(k.user_group, u.user_group) AS user_group, k.format, k.starts_at, k.expires_at, k.door_count, k.door_groups, k.time_schedule, k.not_issued, k.key_id IS NOT NULL AS mobile
    FROM vl_cards k LEFT JOIN vl_users u ON u.hotel_id=k.hotel_id AND u.user_id=k.card_holder
    WHERE k.hotel_id=$1 AND k.active AND ${VALID} AND ($2::text IS NULL OR COALESCE(k.user_group, u.user_group)=$2)
      AND ($3::int IS NULL OR k.expires_at < now() + make_interval(days => $3))
      AND ($4::text IS NULL OR lower(concat_ws(' ', k.reg_no, k.card_holder, u.given_name, u.surname)) LIKE $4)
    ORDER BY COALESCE(k.user_group, u.user_group) NULLS LAST, holder_name LIMIT $5`,
    [hotelId, o.group ?? null, o.expiringDays ?? null, o.q?.trim() ? `%${o.q.trim().toLowerCase().replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null, o.limit]);
  return rows.map((r) => ({ regNo: r.reg_no, holder: r.card_holder, name: r.holder_name, group: r.user_group, format: r.format, mobile: r.mobile, from: r.starts_at, until: r.expires_at,
    doors: r.door_count, doorGroups: r.door_groups, timeSchedule: r.time_schedule, notEncoded: r.not_issued }));
}

export function insightsRoutes(app: FastifyInstance) {
  app.get(`${P}/hotels/:hotelId/insights`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'reports.read');
    return insights(hotelId, Filters.parse(req.query));
  });

  /** People in one Visionline user group, with their valid keycards. */
  app.get(`${P}/hotels/:hotelId/insights/user-groups/:group`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'reports.read');
    const group = decodeURIComponent((req.params as any).group as string);
    const people = await many(pool, `SELECT u.user_id, u.given_name, u.surname, u.user_group,
        (SELECT s.id FROM staff s WHERE s.hotel_id=u.hotel_id AND s.visionline_user=u.user_id LIMIT 1) AS staff_id,
        COALESCE(json_agg(json_build_object('regNo', k.reg_no, 'until', k.expires_at, 'from', k.starts_at, 'doors', k.door_count, 'mobile', k.key_id IS NOT NULL, 'format', k.format)
          ORDER BY k.expires_at) FILTER (WHERE k.reg_no IS NOT NULL AND ${VALID}), '[]') AS cards
      FROM vl_users u LEFT JOIN vl_cards k ON k.hotel_id=u.hotel_id AND k.card_holder=u.user_id AND k.active
      WHERE u.hotel_id=$1 AND u.active AND COALESCE(u.user_group,'(no group)')=$2 GROUP BY u.hotel_id, u.user_id, u.given_name, u.surname, u.user_group ORDER BY u.surname NULLS LAST, u.given_name`, [hotelId, group]);
    return people.map((p) => ({ userId: p.user_id, name: [p.given_name, p.surname].filter(Boolean).join(' ') || p.user_id, onPlatform: Boolean(p.staff_id), cards: p.cards }));
  });

  app.get(`${P}/hotels/:hotelId/insights/valid-cards`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'reports.read');
    const q = z.object({ group: z.string().max(100).optional(), q: z.string().max(100).optional(), expiringDays: z.coerce.number().int().min(0).max(365).optional() }).parse(req.query);
    return validCards(hotelId, { group: q.group || null, q: q.q ?? null, expiringDays: q.expiringDays ?? null, limit: 2000 });
  });

  app.get(`${P}/hotels/:hotelId/insights/export/:report`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'reports.read');
    const report = (req.params as any).report as string;
    const f = Filters.parse(req.query);
    let body: string;
    if (report === 'valid-cards') {
      const rows = await validCards(hotelId, { group: f.group, limit: 50_000 });
      body = csv(['reg_no', 'holder_id', 'holder', 'user_group', 'type', 'valid_from', 'valid_until', 'doors', 'door_groups', 'time_schedule', 'not_encoded'],
        rows.map((r) => [r.regNo, r.holder, r.name, r.group, r.mobile ? 'mobile key (platform)' : 'Visionline card', r.from, r.until, r.doors, (r.doorGroups ?? []).join(' | '), r.timeSchedule, r.notEncoded]));
    } else if (report === 'user-groups') {
      const d = await insights(hotelId, f);
      body = csv(['user_group', 'people', 'valid_cards', 'mobile_keys', 'other_cards', 'people_without_card', 'expiring_7_days'],
        (d.cards?.byGroup ?? []).map((g) => [g.group, g.people, g.validCards, g.mobileKeys, g.otherCards, g.peopleWithoutCard, g.expiring7d]));
    } else if (report === 'lock-activity') {
      const d = await insights(hotelId, f);
      body = csv(['door', 'door_group', 'alarms', 'open_alarms', 'refused_entries', 'battery_events', 'total'], d.locks.byDoor.map((r) => [r.name, r.group, r.alarms, r.open, r.denials, r.battery, r.total]));
    } else if (report === 'battery-life') {
      const names = new Map((await many(pool, `SELECT external_id, name, data->>'doorGroup' AS g FROM resources WHERE hotel_id=$1 AND kind='door'`, [hotelId])).map((d) => [d.external_id, { name: d.name, group: d.g }]));
      const p = await maintenancePolicy(pool, hotelId);
      const b = await batteryInsights(hotelId, null, names, p.battery.staleAfterDays);
      const all = [...b.draining.map((d: any) => ({ ...d, list: 'draining fast' })), ...b.dueSoon.map((d: any) => ({ ...d, list: 'due soon' })), ...b.healthy.map((d: any) => ({ ...d, list: 'doing well' }))];
      body = csv(['list', 'door', 'door_group', 'state', 'last_exchange', 'days_to_low_last_cycle', 'average_days_to_low', 'alarms_90_days', 'volts_per_30_days', 'predicted_low'],
        all.map((d) => [d.list, d.name, d.group, d.state, d.lastExchange, d.lifeDays, d.avgLifeDays, d.alarms90, d.voltsPer30d, d.predictedLowAt]));
    } else if (report === 'departments') {
      const d = await insights(hotelId, f);
      body = csv(['department', 'staff', 'phones_set_up', 'active_mobile_keys', `keys_issued_last_${f.days}_days`], d.keys.byDepartment.map((r) => [r.department, r.staff, r.withPhone, r.activeKeys, r.issued]));
    } else if (report === 'maintenance-workload') {
      const d = await insights(hotelId, f);
      body = csv(['person', 'open', 'overdue', `resolved_last_${f.days}_days`, 'average_hours_to_resolve'], d.maintenance.workload.map((r: any) => [r.person, r.open, r.overdue, r.resolved, r.avg_hours]));
    } else throw notFound('Report');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'reports.exported', details: { report, days: f.days, group: f.group, floor: f.floor } });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${report}.csv"`).header('cache-control', 'private, no-store');
    return '﻿' + body; // BOM so Excel opens accented names correctly
  });

  /** Read people, keycards and alarms from Visionline now (also runs on the hotel's schedule). */
  app.post(`${P}/hotels/:hotelId/insights/sync`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'resources.discover');
    return requestDirectorySync(hotelId, op.id);
  });

  app.get(`${P}/hotels/:hotelId/insights/syncs`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'reports.read');
    return many(pool, `SELECT s.id, s.started_at, s.finished_at, s.status, s.users, s.cards, s.alarms, s.notes, s.error, o.display_name AS requested_by
      FROM directory_syncs s LEFT JOIN operators o ON o.id=s.requested_by WHERE s.hotel_id=$1 ORDER BY s.started_at DESC LIMIT 20`, [hotelId]);
  });
}
