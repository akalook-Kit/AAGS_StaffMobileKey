/**
 * 2.10 Visionline data arrives by itself (hotel request, 16 Oct): the portal follows Visionline, not the other way round.
 *
 *  - Doors, door groups, user groups, time schedules: read every `discoveryEveryHours` (6 h), as soon as the
 *    connector has its Visionline account, and whenever a sync finds a user group the portal does not know.
 *  - User groups: Visionline's Web API has no list of all groups (§5.29 documents GET /userGroups/{id} only), so
 *    the names come from the people read from Visionline (every user carries its group) and are then read one by
 *    one for their doors. Groups found in Visionline join the staff user groups automatically; the placeholder
 *    names a new installation starts with are dropped once Visionline's own groups are known.
 *  - People and keycards: synced every `directorySync.everyHours` (6 h on new installations), and a card made or
 *    changed at the Visionline desk is recorded within seconds from the live feed, then its holder is re-read.
 * Nothing here changes Visionline: GET requests only.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pool, one, many, type Db } from './db.ts';
import { audit } from './audit.ts';
import { enqueue, newCorrelationId } from './commands.ts';
import { getConfig, saveConfig, validateConfig } from './hotel-config.ts';
import { isOnline } from './routes/portal.ts';

/** The connector that can do Visionline work for a hotel right now (online, with the property account). */
export async function readyConnector(db: Db, hotelId: string) {
  const c = await one(db, `SELECT id, last_seen_at, health FROM connectors WHERE hotel_id=$1 AND status='ACTIVE' ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [hotelId]);
  if (!c || !isOnline(c.last_seen_at) || !c.health?.credentialsConfigured) return null;
  return c as { id: string; last_seen_at: string; health: any };
}

/** Every user group name worth asking Visionline about: configured, used by staff, seen on Visionline people. */
export async function knownGroupNames(db: Db, hotelId: string) {
  const vl = await getConfig(db, hotelId, 'visionline');
  const rows = await many(db, `SELECT g FROM (
      SELECT DISTINCT visionline_user_group AS g FROM staff WHERE hotel_id=$1 AND visionline_user_group IS NOT NULL
      UNION SELECT DISTINCT user_group FROM vl_users WHERE hotel_id=$1 AND active AND user_group IS NOT NULL
      UNION SELECT external_id FROM resources WHERE hotel_id=$1 AND kind='usergroup' AND active) x WHERE g <> ''`, [hotelId]);
  return [...new Set([vl?.defaultUserGroup, ...(vl?.userGroups ?? []), ...rows.map((r) => r.g as string)].filter(Boolean))].slice(0, 400) as string[];
}

/** Asks the connector to read doors, groups and schedules. One at a time per hotel. */
export async function requestDiscovery(db: Db, hotelId: string, operatorId: string | null, reason: string) {
  const busy = await one(db, `SELECT id FROM commands WHERE hotel_id=$1 AND type='DISCOVER_RESOURCES' AND status IN ('PENDING','LEASED') AND expires_at > now() LIMIT 1`, [hotelId]);
  if (busy) return { commandId: busy.id as string, alreadyQueued: true };
  const corr = newCorrelationId();
  const cmd = await enqueue(db, { hotelId, type: 'DISCOVER_RESOURCES', payload: { userGroups: await knownGroupNames(db, hotelId) }, idempotencyKey: `discover:${randomUUID()}`, correlationId: corr, ttlSec: 300 });
  await audit(db === pool ? null : (db as pg.PoolClient), { hotelId, actorType: operatorId ? 'operator' : 'system', actorId: operatorId, action: 'resources.discovery_requested', targetType: 'command', targetId: cmd.id, correlationId: corr, details: { reason } });
  return { commandId: cmd.id as string, alreadyQueued: false };
}

/**
 * After a discovery: groups found in Visionline join the staff user groups. While the Visionline settings were
 * never saved by a person, the placeholder groups a new installation starts with are replaced by Visionline's.
 */
export async function adoptUserGroups(c: pg.PoolClient, hotelId: string) {
  const latest = await one(c, `SELECT data, created_by FROM hotel_config_versions WHERE hotel_id=$1 AND kind='visionline' ORDER BY version DESC LIMIT 1`, [hotelId]);
  if (!latest) return null;
  const found = (await many(c, `SELECT external_id AS g FROM resources WHERE hotel_id=$1 AND kind='usergroup' AND active ORDER BY external_id`, [hotelId])).map((r) => r.g as string);
  if (!found.length) return null;
  const cur = latest.data as { userGroups: string[]; defaultUserGroup: string };
  const systemMade = latest.created_by === null;
  const keep = systemMade ? cur.userGroups.filter((g) => found.includes(g)) : cur.userGroups;
  const next = [...new Set([...keep, ...found])];
  const def = found.includes(cur.defaultUserGroup) || !systemMade ? cur.defaultUserGroup : (found.find((g) => /housekeep/i.test(g)) ?? found[0]!);
  if (def === cur.defaultUserGroup && next.length === cur.userGroups.length && next.every((g) => cur.userGroups.includes(g))) return null;
  const data = await validateConfig(c, hotelId, 'visionline', { ...latest.data, userGroups: next, defaultUserGroup: def });
  await saveConfig(c, hotelId, 'visionline', data, null);
  const added = next.filter((g) => !cur.userGroups.includes(g)), removed = cur.userGroups.filter((g) => !next.includes(g));
  await audit(c, { hotelId, actorType: 'system', action: 'visionline.user_groups_adopted', details: { added, removed, defaultUserGroup: def } });
  return { added, removed, defaultUserGroup: def };
}

/**
 * Installations made before 2.10 (settings created by the installer or setup page, never saved by a person):
 * switch on the automatic people and keycard sync, for every Visionline user, every 6 hours.
 */
async function adoptAutoSyncDefaults(hotelId: string) {
  if (process.env.SMK_SETUP_MODE !== '1') return; // on-premises installations only (the hotel's own Visionline)
  const latest = await one(pool, `SELECT data, created_by FROM hotel_config_versions WHERE hotel_id=$1 AND kind='visionline' ORDER BY version DESC LIMIT 1`, [hotelId]);
  if (!latest || latest.created_by !== null || latest.data?.directorySync?.enabled) return;
  // 2.20 People and keycards are read on request (readMode), not every few hours.
  const data = await validateConfig(pool, hotelId, 'visionline', { ...latest.data, discoveryEveryHours: latest.data.discoveryEveryHours ?? 6,
    directorySync: { ...(latest.data.directorySync ?? {}), enabled: true, scope: 'all', everyHours: 24, maxUsers: Math.max(latest.data.directorySync?.maxUsers ?? 0, 5000) } });
  await saveConfig(pool, hotelId, 'visionline', data, null);
  await audit(null, { hotelId, actorType: 'system', action: 'visionline.auto_sync_enabled', details: { everyHours: 6, scope: 'all' } });
}

const adopted = new Set<string>();
/** Every minute (jobs.ts): read doors and groups when due. The people/keycard sync has its own schedule (directory.ts). */
export async function scheduleDiscovery() {
  for (const h of await many(pool, `SELECT id FROM hotels WHERE status='ACTIVE'`)) {
    if (!adopted.has(h.id)) { adopted.add(h.id); await adoptAutoSyncDefaults(h.id).catch((e) => console.error('[visionline-sync]', (e as Error).message)); }
    const vl = await getConfig(pool, h.id, 'visionline');
    const every = Number(vl?.discoveryEveryHours ?? 6);
    if (!every || !(await readyConnector(pool, h.id))) continue;
    const last = await one(pool, `SELECT max(completed_at) AS t FROM commands WHERE hotel_id=$1 AND type='DISCOVER_RESOURCES' AND status='SUCCEEDED'`, [h.id]);
    // 2.20 On request: only the very first read happens by itself; after that, Refresh from Visionline.
    if ((vl?.readMode ?? 'onRequest') === 'onRequest' && last?.t) continue;
    const lastTry = await one(pool, `SELECT max(created_at) AS t FROM commands WHERE hotel_id=$1 AND type='DISCOVER_RESOURCES'`, [h.id]);
    const due = !last?.t || Date.now() - new Date(last.t).getTime() > every * 3600_000;
    // After an attempt that did not succeed, wait 15 minutes before the next one.
    const cooled = !lastTry?.t || Date.now() - new Date(lastTry.t).getTime() > 15 * 60_000;
    if (due && cooled) await requestDiscovery(pool, h.id, null, last?.t ? 'scheduled' : 'first connection').catch(() => {});
  }
}
