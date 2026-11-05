import { randomUUID } from 'node:crypto';
import { toVisionlineLocal } from '@smk/shared/node';
import { pool, one, many, tx } from './db.ts';
import { audit } from './audit.ts';
import { createHotel } from './provision-lib.ts';
import { SCHEMAS, saveConfig } from './hotel-config.ts';
import { applyDirectoryChunk } from './directory.ts';
import { processVisionlineBatch } from './visionline-events.ts';

/**
 * 2.25 The Demo Hotel: a site with made-up doors, people, keycards, door events and battery alarms, so that people
 * can try the portal and give feedback without seeing any real hotel's data. It has no connector and no Visionline:
 * commands are refused with an explanation (commands.ts). The data goes through the same code as real Visionline
 * data (directory read, live events, battery rules), so every page behaves as in a hotel.
 */
export const DEMO_SLUG = 'demo-hotel';
const TZ = 'Africa/Douala';

/** Seeded random numbers: the same demo every time it is reset. */
function rng(seed = 20261102) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

const FLOORS = [1, 2, 3];
const rooms = FLOORS.flatMap((f) => Array.from({ length: 10 }, (_, i) => `${f}${String(i + 1).padStart(2, '0')}`));
const AREAS: [string, string, string][] = [
  ['Main Entrance', 'Common Areas', 'entrance'], ['Staff Entrance', 'Back of House', 'entrance'], ['Linen Store', 'Back of House', 'service'],
  ['Kitchen', 'Back of House', 'service'], ['Back Office', 'Back of House', 'office'], ['Server Room', 'Back of House', 'technical'],
  ['Gym', 'Common Areas', 'common'], ['Spa', 'Common Areas', 'common'], ['Cashier', 'Back of House', 'office'],
];
const GROUPS: { name: string; doors?: string[]; doorGroups?: string[]; uniform?: boolean }[] = [
  { name: 'Housekeeping', doorGroups: ['Floor 1', 'Floor 2', 'Floor 3'], doors: ['Linen Store', 'Staff Entrance'] },
  { name: 'Front Office', doors: ['Main Entrance', 'Back Office', 'Cashier'] },
  { name: 'Engineering', doorGroups: ['Floor 1', 'Floor 2', 'Floor 3', 'Back of House', 'Common Areas'] },
  { name: 'Security', doorGroups: ['Floor 1', 'Floor 2', 'Floor 3', 'Back of House', 'Common Areas'] },
  { name: 'Management', doors: ['Main Entrance', 'Staff Entrance', 'Back Office', 'Gym'] },
  { name: 'Food & Beverage', doors: ['Kitchen', 'Staff Entrance'] },
];
// Made-up names (no real person intended).
const PEOPLE: [string, string, string][] = [
  ['Aline', 'Mbarga', 'Housekeeping'], ['Brice', 'Ndzana', 'Housekeeping'], ['Carine', 'Ewondo', 'Housekeeping'], ['Diane', 'Fotso', 'Housekeeping'],
  ['Estelle', 'Nana', 'Housekeeping'], ['Flore', 'Onana', 'Housekeeping'], ['Gaelle', 'Tchami', 'Housekeeping'], ['Hortense', 'Abega', 'Housekeeping'],
  ['Ivan', 'Kamga', 'Front Office'], ['Josiane', 'Mballa', 'Front Office'], ['Kevin', 'Ngono', 'Front Office'], ['Laure', 'Essomba', 'Front Office'],
  ['Marc', 'Tsala', 'Engineering'], ['Nadege', 'Bella', 'Engineering'], ['Olivier', 'Mvondo', 'Engineering'],
  ['Pascal', 'Owona', 'Security'], ['Quentin', 'Ateba', 'Security'], ['Rose', 'Biya', 'Management'], ['Serge', 'Eto', 'Management'],
  ['Thierry', 'Manga', 'Food & Beverage'], ['Ursule', 'Nkoulou', 'Food & Beverage'], ['Valerie', 'Zambo', 'Food & Beverage'],
  ['Staff', '2', 'Housekeeping'], ['Spare', 'card', 'Front Office'],
];

const DEMO_CONFIG = {
  property: { kind: 'hotel', displayName: 'Demo Hotel', timezone: TZ, country: 'CM', checkInTime: '14:00', checkOutTime: '11:00', supportEmail: 'help@demo-hotel.invalid', supportPhone: '+000 000 000', homepage: null, address: null, buildings: [] },
  branding: { appName: 'Demo Hotel', portalTitle: 'Demo Hotel · Access Monitoring Tool', primaryColor: '#16302B', secondaryColor: '#D9B26F', textOnPrimary: '#F3EFE6', backgroundColor: '#F4F2EC' },
  features: { batteryMonitoring: true, maintenance: true, timeAttendance: false, breakfast: false, staffMobileKeys: false, guestKeys: false, partnerLinks: false, pmsOccupancy: false, portalFocus: 'full' },
};

/** Creates the Demo Hotel if missing; the platform administrator who asks becomes its administrator. */
export async function ensureDemoSite(operatorId: string) {
  const existing = await one(pool, `SELECT id FROM hotels WHERE slug=$1`, [DEMO_SLUG]);
  // Idempotent: a half-made demo (an earlier attempt that stopped) is completed.
  const { hotelId } = await createHotel(pool, { slug: DEMO_SLUG, name: 'Demo Hotel', timezone: TZ, config: { property: DEMO_CONFIG.property, branding: DEMO_CONFIG.branding } as any });
  await pool.query(`UPDATE hotels SET is_demo=true WHERE id=$1`, [hotelId]);
  // No connector and no licence checks for the demo: the modules are switched on directly.
  if (!(await one(pool, `SELECT 1 FROM hotel_config_versions WHERE hotel_id=$1 AND kind='features'`, [hotelId])))
    await saveConfig(pool, hotelId, 'features', SCHEMAS.features.parse(DEMO_CONFIG.features), null);
  if (!(await one(pool, `SELECT 1 FROM hotel_config_versions WHERE hotel_id=$1 AND kind='visionline'`, [hotelId])))
    await saveConfig(pool, hotelId, 'visionline', SCHEMAS.visionline.parse({ userGroups: GROUPS.map((g) => g.name), defaultUserGroup: 'Housekeeping',
      directorySync: { enabled: true, scope: 'all', includeCards: true, includeAlarms: true }, readMode: 'onRequest' }), null);
  await pool.query(`INSERT INTO memberships (operator_id, hotel_id, role) VALUES ($1,$2,'HOTEL_ADMIN') ON CONFLICT DO NOTHING`, [operatorId, hotelId]);
  const seeded = await one(pool, `SELECT 1 FROM resources WHERE hotel_id=$1 AND kind='door' LIMIT 1`, [hotelId]);
  if (!seeded) { await seedDemo(hotelId); await audit(null, { hotelId, actorType: 'operator', actorId: operatorId, action: 'demo.created' }); }
  return { hotelId, created: !existing || !seeded };
}

/** Tables holding a site's operational data, emptied on reset (people's accounts, settings, audit trail and feedback stay). */
const KEEP = new Set(['hotels', 'memberships', 'operators', 'hotel_config_versions', 'audit_log', 'feedback', 'operator_invites', 'connectors', 'operator_vl_credentials',
  'operator_vl_links', 'vl_operator_links', 'usage_events', 'operator_prefs', 'licences', 'schema_migrations']);

export async function resetDemo(hotelId: string, operatorId: string) {
  const h = await one(pool, `SELECT is_demo FROM hotels WHERE id=$1`, [hotelId]);
  if (!h?.is_demo) throw new Error('Only the Demo Hotel can be reset.');
  const tables = (await many(pool, `SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='hotel_id'`)).map((r) => r.table_name as string).filter((t) => !KEEP.has(t));
  await tx(async (c) => {
    // Battery alerts and maintenance tickets point at each other: unlink them first.
    await c.query(`UPDATE battery_alerts SET ticket_id=NULL WHERE hotel_id=$1`, [hotelId]);
    await c.query(`UPDATE maintenance_tickets SET battery_alert_id=NULL WHERE hotel_id=$1`, [hotelId]);
    // Several passes: tables that others refer to empty once those are empty.
    let left = [...tables];
    for (let pass = 0; pass < 8 && left.length; pass++) {
      const next: string[] = [];
      for (const t of left) {
        await c.query('SAVEPOINT d');
        try { await c.query(`DELETE FROM "${t.replace(/"/g, '')}" WHERE hotel_id=$1`, [hotelId]); await c.query('RELEASE SAVEPOINT d'); }
        catch { await c.query('ROLLBACK TO SAVEPOINT d'); next.push(t); }
      }
      left = next;
    }
    if (left.length) throw new Error(`Could not empty: ${left.join(', ')}`);
  });
  await seedDemo(hotelId);
  await audit(null, { hotelId, actorType: 'operator', actorId: operatorId, action: 'demo.reset' });
}

const fmt = (d: Date) => toVisionlineLocal(d, TZ);
const ago = (days: number, h = 0, m = 0) => new Date(Date.now() - days * 86_400_000 - h * 3_600_000 - m * 60_000);

async function seedDemo(hotelId: string) {
  const r = rng();
  // ---- doors, door groups, user groups (as Visionline's discovery would store them)
  const res: { kind: string; id: string; name: string; data: unknown }[] = [];
  for (const d of rooms) res.push({ kind: 'door', id: d, name: d, data: { doorGroup: `Floor ${d[0]}`, doorCategory: 'guest', doorID: d, online: d[0] !== '3' } });
  for (const [n, g, cat] of AREAS) res.push({ kind: 'door', id: n, name: n, data: { doorGroup: g, doorCategory: cat, doorID: n, online: g === 'Common Areas' || n === 'Staff Entrance' } });
  for (const g of ['Floor 1', 'Floor 2', 'Floor 3', 'Back of House', 'Common Areas']) res.push({ kind: 'doorgroup', id: g, name: g, data: {} });
  for (const g of GROUPS) res.push({ kind: 'usergroup', id: g.name, name: g.name, data: { uniformAccess: false, doorOperations: [{ operation: 'normal', doors: g.doors ?? [], doorGroups: g.doorGroups ?? [] }], timeSchedule: null, deadboltOverride: g.name === 'Security' || g.name === 'Engineering' } });
  for (const e of ['Front desk encoder', 'Back office encoder']) res.push({ kind: 'encoder', id: e, name: e, data: {} });
  for (const x of res) await pool.query(`INSERT INTO resources (hotel_id, kind, external_id, name, data, active, discovered_at) VALUES ($1,$2,$3,$4,$5,true,now())
    ON CONFLICT (hotel_id, kind, external_id) DO UPDATE SET name=EXCLUDED.name, data=EXCLUDED.data, active=true`, [hotelId, x.kind, x.id, x.name, x.data]);

  // ---- people and keycards (as the directory read stores them)
  const groupOf = new Map(GROUPS.map((g) => [g.name, g]));
  let reg = 480100;
  const cards: any[] = [];
  const people = PEOPLE.map(([g, s, grp], i) => ({ id: `demo-${String(i + 1).padStart(3, '0')}`, givenName: g, surname: s, userGroup: grp }));
  for (const [i, p] of people.entries()) {
    const ug = groupOf.get(p.userGroup)!;
    const days = i % 9 === 3 ? 6 + i : i % 11 === 5 ? -4 : 120 + i * 9;     // a few end soon, one has ended
    cards.push({ regNo: String(reg++), cardHolder: p.id, format: 'TLCode', startTime: fmt(ago(60 + i)), expireTime: fmt(new Date(Date.now() + days * 86_400_000)),
      cancelled: false, discarded: false, overridden: false, expired: days < 0, notIssued: false, issuedCount: 1, doors: ug.doors ?? [], doorGroups: ug.doorGroups ?? [], timeSchedule: null,
      operations: ['normal'], deadboltOverride: p.userGroup === 'Security' || p.userGroup === 'Engineering', mobile: false });
  }
  // Two people hold a second valid card (shows under Renewals & duplicates).
  for (const i of [1, 9]) cards.push({ ...cards[i], regNo: String(reg++), startTime: fmt(ago(5)) });
  const syncId = randomUUID();
  await pool.query(`INSERT INTO directory_syncs (id, hotel_id, partial) VALUES ($1,$2,false)`, [syncId, hotelId]);
  await applyDirectoryChunk(hotelId, { syncId, final: true, users: people, cards, notes: ['Demo Hotel sample data'],
    alarms: [
      { id: 'demo-a1', alarmType: 'door', alarmTypeName: 'Door left open', alarmText: 'Kitchen door left open for more than 5 minutes', alarmTime: fmt(ago(0, 3)), door: 'Kitchen', cardHolder: null, completed: false, completionTime: null, updateTime: null },
      { id: 'demo-a2', alarmType: 'communication', alarmTypeName: 'Lock offline', alarmText: 'Communication lost with lock 210', alarmTime: fmt(ago(0, 6)), door: '210', cardHolder: null, completed: false, completionTime: null, updateTime: null },
    ] } as any);

  // ---- 14 days of door events, then battery stories, through the same code as Visionline's live feed
  const validCards = cards.filter((c) => !c.expired);
  const byGroup = (g: string) => validCards.filter((c) => people.find((p) => p.id === c.cardHolder)?.userGroup === g);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const events: { doorID: string; registrationNumber: string; eventCode: number; eventTime: string; at: number }[] = [];
  const ev = (door: string, regNo: string, code: number, d: Date) => events.push({ doorID: door, registrationNumber: regNo, eventCode: code, eventTime: fmt(d), at: d.getTime() });
  for (let day = 13; day >= 0; day--) {
    for (const c of validCards) {
      if (r() < 0.2) continue;                               // day off
      const start = 6 + Math.floor(r() * 3);
      ev('Staff Entrance', c.regNo, 64, ago(day, 24 - start, Math.floor(r() * 50)));
      const grp = people.find((p) => p.id === c.cardHolder)!.userGroup;
      const n = grp === 'Housekeeping' ? 8 : grp === 'Engineering' ? 4 : 2;
      for (let k = 0; k < n; k++) {
        const h = start + 1 + Math.floor(r() * 8);
        const door = grp === 'Housekeeping' ? pick(rooms.filter((x) => x[0] !== '3' || r() < 0.6)) : grp === 'Front Office' ? pick(['Main Entrance', 'Back Office', 'Cashier'])
          : grp === 'Food & Beverage' ? 'Kitchen' : grp === 'Management' ? pick(['Back Office', 'Main Entrance', 'Gym']) : pick([...rooms, 'Server Room', 'Linen Store']);
        ev(door, c.regNo, 64, ago(day, 24 - h, Math.floor(r() * 59)));
      }
      if (r() < 0.04) ev(pick(['Server Room', 'Cashier', '305']), c.regNo, 320, ago(day, 24 - (start + 3), 10));   // a door not on the card
    }
  }
  // 2.27 Guests: every day a few check-ins (one or two keycards per room, made at the desk), first used at the room;
  // now and then a keycard that no longer opens (stay over), so the guest keycard reports have something to show.
  const guestIssued: { regNo: string; at: Date }[] = [];
  let gReg = 700100;
  for (let day = 13; day >= 0; day--) {
    const n = 6 + Math.floor(r() * 7);
    for (let k = 0; k < n; k++) {
      const room = pick(rooms);
      const made = ago(day, 24 - (13 + Math.floor(r() * 8)), Math.floor(r() * 59));
      if (made.getTime() > Date.now() - 600_000) continue;
      const cardsN = r() < 0.55 ? 2 : 1;
      for (let q = 0; q < cardsN; q++) {
        const regNo = String(gReg++);
        guestIssued.push({ regNo, at: made });
        const first = new Date(made.getTime() + (8 + Math.floor(r() * 40)) * 60_000);
        if (first.getTime() < Date.now()) { ev(room, regNo, 64, first); if (r() < 0.5) ev('Main Entrance', regNo, 64, new Date(first.getTime() + 3 * 3_600_000)); }
        if (r() < 0.06) { const late = new Date(made.getTime() + 2 * 86_400_000); if (late.getTime() < Date.now()) ev(room, regNo, 325, late); }
        if (r() < 0.03) ev(pick(rooms), regNo, 320, new Date(first.getTime() + 3_600_000));
      }
    }
  }
  events.sort((a, b) => a.at - b.at);
  // Battery stories: 105 low, 207 critical, 302 two sets of batteries, 109 alarm after new batteries (firmware), 118 cleared by cards.
  const bat: { doorID: string; registrationNumber: string; eventCode: number; eventTime: string; at: number }[] = [];
  const b = (door: string, code: number, d: Date, regNo = validCards[0].regNo) => bat.push({ doorID: door, registrationNumber: regNo, eventCode: code, eventTime: fmt(d), at: d.getTime() });
  b('302', 528, ago(40)); b('302', 529, ago(14)); b('302', 528, ago(10));
  // Alarms after the last cards of the day (two accepted cards without the low flag would clear them, as in a hotel).
  b('105', 529, ago(0, 2));
  b('207', 529, ago(0, 3)); b('207', 530, ago(0, 1));
  b('109', 528, ago(5)); b('109', 529, ago(4, 2));
  b('110', 529, ago(0, 0, 40));
  const all = [...events, ...bat].sort((a, x) => a.at - x.at);
  for (let i = 0; i < all.length; i += 500) {
    await processVisionlineBatch(hotelId, { batchId: `demo-${Date.now()}-${i}`, source: 'catchup', cards: [], events: all.slice(i, i + 500).map(({ at: _a, ...e }) => e) } as any);
  }

  // As if the connector had been running all along: each event received when it happened.
  await pool.query(`UPDATE visionline_events SET received_at = (to_timestamp(substr(event_time, 1, 13), 'YYYYMMDD"T"HH24MI')::timestamp AT TIME ZONE $2)
    WHERE hotel_id=$1 AND kind='event' AND event_time ~ '^\\d{8}T\\d{4}'`, [hotelId, TZ]);
  // Guest keycards made at the desk, as Visionline's live feed reports them (status 1), at the time they were made.
  for (const g of guestIssued) {
    await pool.query(`INSERT INTO visionline_events (hotel_id, batch_id, source, kind, registration_number, card_status, dedupe, received_at) VALUES ($1,'demo-guests','catchup','card',$2,1,$3,$4) ON CONFLICT DO NOTHING`,
      [hotelId, g.regNo, `card:${g.regNo}:1:demo`, g.at]);
  }

  // ---- gateways, keycard requests and register, notices
  await pool.query(`INSERT INTO gateways (hotel_id, name, eeid, location, doors, source) VALUES ($1,'GW Floor 1','0004A3F1','Floor 1 corridor',$2,'manual'), ($1,'GW Floor 2','0004A3F2','Floor 2 corridor',$3,'manual')`,
    [hotelId, rooms.filter((x) => x[0] === '1'), rooms.filter((x) => x[0] === '2')]);
  const hist = (by: string, what: string, d: Date) => JSON.stringify([{ at: d.toISOString(), by, what }]);
  const reqs: [string, string, string, string, string, string, string | null, string | null][] = [
    ['KR2026-9001', 'new', 'SUBMITTED', 'Clarisse', 'Ngo', 'Housekeeping', null, null],
    ['KR2026-9002', 'new', 'ISSUED', 'Marc', 'Tsala', 'Engineering', 'ENG 001', cards[12].regNo],
    ['KR2026-9003', 'cancel', 'SUBMITTED', 'Gaelle', 'Tchami', 'Housekeeping', 'HK 007', cards[6].regNo],
  ];
  for (const [num, kind, st, g, s, dep, label, regNo] of reqs) {
    await pool.query(`INSERT INTO keycard_requests (hotel_id, number, kind, staff_type, status, given_name, surname, department, card_label, reason, manager_name, source, card_reg_no, issue_method, history, issued_at)
      VALUES ($1,$2,$3,'permanent',$4,$5,$6,$7,$8,$9,$10,'portal',$11,$12,$13,$14)`,
      [hotelId, num, kind, st, g, s, dep, label, kind === 'cancel' ? 'Leaving the hotel at the end of the month' : 'New team member', `${dep} manager`, regNo, st === 'ISSUED' ? 'visionline_desk' : null,
        hist(`${dep} manager`, 'Requested (portal)', ago(kind === 'cancel' ? 1 : 3)), st === 'ISSUED' ? ago(2) : null]);
  }
  const labels: [string, number][] = [['HK 001', 0], ['HK 002', 1], ['HK 003', 2], ['HK 007', 6], ['FO 001', 8], ['ENG 001', 12], ['SEC 001', 15]];
  for (const [label, i] of labels) {
    const p = people[i]!;
    await pool.query(`INSERT INTO keycard_register (hotel_id, label, department, staff_type, holder_name, vl_user_id, card_reg_no, status) VALUES ($1,$2,$3,'permanent',$4,$5,$6,'in_use') ON CONFLICT DO NOTHING`,
      [hotelId, label, p.userGroup, `${p.givenName} ${p.surname}`, p.id, cards[i].regNo]);
  }
  await pool.query(`INSERT INTO notices (hotel_id, title, body, kind, public, pinned) VALUES
    ($1,'Welcome to the Demo Hotel','Everything here is made up: doors, people, keycards and alarms. Try any page, then press Feedback to tell us what works and what does not.','important',true,true),
    ($1,'Return your keycard when you leave','Your manager asks for it on Staff keycards; it is cancelled at once.','tip',false,false)`, [hotelId]);
}

/** The demo site, if there is one. */
export async function demoSite() {
  return one(pool, `SELECT id, name, slug FROM hotels WHERE is_demo LIMIT 1`);
}
