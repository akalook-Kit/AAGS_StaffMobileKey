/**
 * TEST ENVIRONMENT ONLY: adds ~6 months of made-up history so the Insights dashboard can be tried before the
 * hotel has real data — battery cycles, lock alarms, refused doors, maintenance requests and past keys.
 * Every row it creates is tagged "demo" and removed again with --remove. Refuses to run in production.
 *
 *   npx tsx src/tools/demo-history.ts --hotel k-hotel-bana --yes
 *   npx tsx src/tools/demo-history.ts --hotel k-hotel-bana --remove
 */
import { randomUUID } from 'node:crypto';
import { pool, one, many } from '../db.ts';
import { config } from '../config.ts';

const arg = (k: string) => { const a = process.argv.slice(2); const i = a.indexOf(`--${k}`); return i >= 0 ? (a[i + 1] ?? true) : undefined; };
if (!config.isDev) { console.error('demo-history refuses to run with NODE_ENV=production.'); process.exit(1); }
const slug = String(arg('hotel') ?? 'k-hotel-bana');
const h = await one(pool, 'SELECT id FROM hotels WHERE slug=$1', [slug]);
if (!h) { console.error(`Unknown hotel ${slug}`); process.exit(1); }
const hotelId = h.id as string;
const DAY = 86_400_000;
const now = Date.now();
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
const at = (daysAgo: number, hour = 8 + Math.floor(rnd() * 10)) => new Date(now - daysAgo * DAY + (hour - 12) * 3600_000);

async function remove() {
  await pool.query(`UPDATE battery_alerts SET ticket_id=NULL WHERE hotel_id=$1 AND resolved_reason LIKE 'demo%'`, [hotelId]);
  await pool.query(`DELETE FROM maintenance_activity WHERE ticket_id IN (SELECT id FROM maintenance_tickets WHERE hotel_id=$1 AND created_by_id='demo')`, [hotelId]);
  await pool.query(`UPDATE battery_alerts SET ticket_id=NULL WHERE ticket_id IN (SELECT id FROM maintenance_tickets WHERE hotel_id=$1 AND created_by_id='demo')`, [hotelId]);
  await pool.query(`DELETE FROM maintenance_tickets WHERE hotel_id=$1 AND created_by_id='demo'`, [hotelId]);
  await pool.query(`DELETE FROM battery_alerts WHERE hotel_id=$1 AND resolved_reason LIKE 'demo%'`, [hotelId]);
  await pool.query(`DELETE FROM battery_readings WHERE hotel_id=$1 AND reporting_registration_number='demo'`, [hotelId]);
  await pool.query(`DELETE FROM battery_status s WHERE hotel_id=$1 AND NOT EXISTS (SELECT 1 FROM battery_readings r WHERE r.hotel_id=s.hotel_id AND r.door_id=s.door_id)`, [hotelId]);
  await pool.query(`DELETE FROM vl_alarms WHERE hotel_id=$1 AND alarm_id LIKE 'demo-%'`, [hotelId]);
  await pool.query(`DELETE FROM visionline_events WHERE hotel_id=$1 AND batch_id='demo'`, [hotelId]);
  await pool.query(`DELETE FROM key_requests WHERE hotel_id=$1 AND idempotency_key LIKE 'demo-%'`, [hotelId]);
  console.log('Demo history removed.');
}

if (arg('remove')) { await remove(); await pool.end(); process.exit(0); }
if (!arg('yes')) { console.error('Adds made-up history to the TEST database. Run again with --yes (or --remove to take it out).'); process.exit(1); }
await remove();

const doors = await many(pool, `SELECT external_id AS id, name, data->>'doorGroup' AS g FROM resources WHERE hotel_id=$1 AND kind='door' AND active ORDER BY external_id`, [hotelId]);
if (!doors.length) { console.error('No doors yet: run resource discovery first (Connector health).'); process.exit(1); }
const staff = await many(pool, `SELECT id, job_role FROM staff WHERE hotel_id=$1 AND status='ACTIVE'`, [hotelId]);
const op = await one(pool, `SELECT o.id FROM operators o JOIN memberships m ON m.operator_id=o.id WHERE m.hotel_id=$1 LIMIT 1`, [hotelId]);

// ---- batteries: a few fast-draining locks, most average, some long-lived ------------------------
const profile = (i: number) => (i % 9 === 3 ? 70 : i % 9 === 6 ? 95 : i % 7 === 0 ? 420 : 210 + (i % 5) * 20);
let readings = 0;
for (const [i, d] of doors.entries()) {
  if (i % 4 === 1) continue; // some locks never report (offline, never read)
  const life = profile(i);
  let t = 360 - (i * 13) % 120; // first exchange this many days ago
  let state = 'GOOD', last = { code: 528, at: at(t), volts: null as number | null };
  while (t > 0) {
    await pool.query(`INSERT INTO battery_readings (hotel_id, door_id, event_code, state, reported_at, reporting_registration_number) VALUES ($1,$2,528,'GOOD',$3,'demo')`, [hotelId, d.id, at(t)]);
    readings++; state = 'GOOD'; last = { code: 528, at: at(t), volts: null };
    const lowAt = t - Math.round(life * (0.85 + rnd() * 0.3));
    if (lowAt > 0 || lowAt > -30) {
      const v1 = t - Math.round(life * 0.6);
      if (v1 > 0) { await pool.query(`INSERT INTO battery_readings (hotel_id, door_id, event_code, state, volts_below, reported_at, reporting_registration_number) VALUES ($1,$2,1063,'REPORTED',7.4,$3,'demo')`, [hotelId, d.id, at(v1)]); readings++; last = { code: 1063, at: at(v1), volts: 7.4 }; }
      if (lowAt > 0) {
        await pool.query(`INSERT INTO battery_readings (hotel_id, door_id, event_code, state, reported_at, reporting_registration_number) VALUES ($1,$2,304,'LOW',$3,'demo')`, [hotelId, d.id, at(lowAt)]);
        readings++; state = 'LOW'; last = { code: 304, at: at(lowAt), volts: null };
        const replaced = lowAt - (5 + Math.floor(rnd() * 20));
        const critical = life < 100 && rnd() < 0.6 ? lowAt - 4 : null;
        if (critical && critical > 0 && critical > replaced) {
          await pool.query(`INSERT INTO battery_readings (hotel_id, door_id, event_code, state, reported_at, reporting_registration_number) VALUES ($1,$2,305,'CRITICAL',$3,'demo')`, [hotelId, d.id, at(critical)]);
          readings++; state = 'CRITICAL'; last = { code: 305, at: at(critical), volts: null };
        }
        const alertOpen = replaced <= 0;
        await pool.query(`INSERT INTO battery_alerts (hotel_id, door_id, severity, status, opened_at, last_seen_at, occurrences, resolved_at, resolved_reason) VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8)`,
          [hotelId, d.id, state === 'CRITICAL' ? 'CRITICAL' : 'LOW', alertOpen ? 'OPEN' : 'RESOLVED', at(lowAt), 1 + Math.floor(rnd() * 3), alertOpen ? null : at(Math.max(replaced, 0)), alertOpen ? 'demo (open)' : 'demo: battery exchanged']);
        t = replaced;
        continue;
      }
    }
    break;
  }
  await pool.query(`INSERT INTO battery_status (hotel_id, door_id, state, last_event_code, volts_below, reported_at) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (hotel_id, door_id) DO UPDATE SET state=EXCLUDED.state, last_event_code=EXCLUDED.last_event_code, volts_below=EXCLUDED.volts_below, reported_at=EXCLUDED.reported_at`,
    [hotelId, d.id, state, last.code, last.volts, last.at]);
}

// ---- lock alarms and refused doors ------------------------------------------------------------
const busy = doors.filter((_, i) => i % 6 === 0).concat(doors.filter((d) => /entrance|store|gym/i.test(d.name)));
const alarmKinds: [string, string, string][] = [['2', 'Door left open', 'Door left open too long'], ['3', 'Tamper', 'Tamper alarm'], ['4', 'Emergency open', 'Emergency open is activated'], ['5', 'Forced door', 'Door forced open']];
let alarms = 0;
for (let k = 0; k < 140; k++) {
  const d = rnd() < 0.7 ? pick(busy) : pick(doors);
  const kind = rnd() < 0.72 ? alarmKinds[0]! : pick(alarmKinds.slice(1));
  const daysAgo = Math.floor(rnd() * 180);
  const done = daysAgo > 1 || rnd() < 0.5;
  await pool.query(`INSERT INTO vl_alarms (hotel_id, alarm_id, alarm_type, type_name, alarm_text, alarm_at, door_id, door_raw, completed, completed_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$9)`,
    [hotelId, `demo-${k}`, kind[0], kind[1], kind[2], at(daysAgo), d.id, done, done ? new Date(at(daysAgo).getTime() + 3600_000) : null]);
  alarms++;
}
let events = 0;
for (let k = 0; k < 260; k++) {
  const d = rnd() < 0.5 ? pick(busy) : pick(doors);
  const code = pick([320, 320, 320, 323, 368, 322, 325]);
  await pool.query(`INSERT INTO visionline_events (hotel_id, batch_id, source, kind, registration_number, event_code, door_id, received_at, dedupe) VALUES ($1,'demo','callback','event','0',$2,$3,$4,$5)`,
    [hotelId, code, d.id, at(Math.floor(rnd() * 180)), `demo:${k}`]);
  events++;
}

// ---- maintenance requests ---------------------------------------------------------------------
const techs = staff.filter((s) => s.job_role === 'Maintenance');
const cats = ['lock', 'door', 'room', 'electrical', 'plumbing', 'battery', 'other'];
const titles: Record<string, string[]> = {
  lock: ['Lock slow to respond', 'Lock beeps but does not open'], door: ['Door closer leaking', 'Door does not latch'], room: ['Curtain rail loose', 'Wardrobe hinge broken'],
  electrical: ['Bathroom light flickers', 'Socket not working'], plumbing: ['Shower drains slowly', 'Tap dripping'], battery: ['Replace lock battery'], other: ['Minibar not cooling', 'TV remote missing'],
};
let tickets = 0;
let number = ((await one(pool, `SELECT COALESCE(max(number),0) AS n FROM maintenance_tickets WHERE hotel_id=$1`, [hotelId]))!.n as number) + 1;
for (let k = 0; k < 120; k++) {
  const cat = pick(cats);
  const d = pick(doors);
  const created = at(Math.floor(rnd() * 180));
  const prio = pick(['low', 'normal', 'normal', 'normal', 'high', 'urgent']);
  const dueH = { low: 168, normal: 72, high: 24, urgent: 4 }[prio]!;
  const ageDays = (now - created.getTime()) / DAY;
  const resolvedAfterH = cat === 'plumbing' ? 30 + rnd() * 90 : cat === 'electrical' ? 10 + rnd() * 50 : 4 + rnd() * 60;
  const resolved = ageDays * 24 > resolvedAfterH && rnd() < 0.93 ? new Date(created.getTime() + resolvedAfterH * 3600_000) : null;
  const status = resolved ? (ageDays > 5 ? 'CLOSED' : 'RESOLVED') : pick(['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ON_HOLD']);
  const assignee = techs.length && (resolved || rnd() < 0.7) ? pick(techs).id : null;
  const t = await one(pool, `INSERT INTO maintenance_tickets (hotel_id, number, title, category, priority, status, door_id, location, source, assignee_staff_id, created_by_type, created_by_id,
      due_at, acknowledged_at, resolved_at, closed_at, resolution, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'portal',$9,'system','demo',$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [hotelId, number++, `${pick(titles[cat]!)}${cat === 'battery' ? `: ${d.name}` : ''}`, cat, prio, status, d.id, d.g ? `${d.name} · ${d.g}` : d.name, assignee,
      new Date(created.getTime() + dueH * 3600_000), resolved ? new Date(created.getTime() + 3600_000) : null, resolved, status === 'CLOSED' ? new Date(resolved!.getTime() + DAY) : null,
      resolved ? 'Fixed (demo)' : null, created, resolved ?? created]);
  await pool.query(`INSERT INTO maintenance_activity (hotel_id, ticket_id, at, actor_type, actor_name, kind, body) VALUES ($1,$2,$3,'system','Demo data','created',NULL)`, [hotelId, t!.id, created]);
  tickets++;
}

// ---- past mobile keys -----------------------------------------------------------------------------
let keys = 0;
if (op && staff.length) {
  for (let k = 0; k < 220; k++) {
    const s = pick(staff);
    const created = at(Math.floor(rnd() * 180) + 1, 7);
    const ended = new Date(created.getTime() + (8 + rnd() * 3) * 3600_000);
    const src = rnd() < 0.82 ? null : pick(['operator', 'operator', 'visionline', 'wrong_door', 'replaced']);
    const doorIds = [pick(doors).id, pick(doors).id];
    await pool.query(`INSERT INTO key_requests (hotel_id, staff_id, endpoint_id, requested_by, status, requested_scope, resolved_scope, starts_at, expires_at, credential_id,
        correlation_id, idempotency_key, revoke_source, created_at, updated_at, wrong_door_count)
      VALUES ($1,$2,'demo',$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$6,$7,$12)`,
      [hotelId, s.id, op.id, src ? 'REVOKED' : 'EXPIRED', { resolvedDoorIds: doorIds, doorIds }, created, ended, String(800000 + k), `demo-${randomUUID()}`, `demo-${k}-${randomUUID()}`, src,
        src === 'wrong_door' ? 6 : Math.floor(rnd() * 2)]);
    keys++;
  }
}
console.log(`Demo history added for ${slug}: ${readings} battery reports on ${doors.length} doors, ${alarms} lock alarms, ${events} refused entries, ${tickets} maintenance requests, ${keys} past keys.`);
console.log('Remove it with: npx tsx src/tools/demo-history.ts --hotel ' + slug + ' --remove');
await pool.end();
