import { many, pool } from './db.ts';

/**
 * 2.19 Gateways of the online locks (Armel, 27 Oct: "we need to see the gateways and their EEID", offline alarms that
 * close by themselves when the gateway or lock is back). Pure decision here (unit-tested); monitor.ts applies it.
 *
 * A gateway is offline when
 *   1. an open Visionline alarm names it (its EEID, or its name together with a word such as "gateway"/"offline"), or
 *   2. it serves at least two locks and they are all offline (none online),
 * online when at least one of its locks is in contact and no alarm names it, and unknown otherwise. Live state from the
 * network integrator (Ruckus/Cisco) can be added as a third source once its API is available.
 */
export interface GatewayFacts {
  name: string; eeid: string | null;
  doorStates: ('online' | 'offline' | 'unknown')[];
  alarms: { title: string; text: string }[];
}
export interface GatewayVerdict { state: 'online' | 'offline' | 'unknown'; reason: string | null }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function alarmNamesGateway(g: { name: string; eeid: string | null }, a: { title: string; text: string }) {
  const t = `${a.title} ${a.text}`;
  if (g.eeid && g.eeid.length >= 4 && new RegExp(`(^|[^0-9A-Za-z])${esc(g.eeid)}($|[^0-9A-Za-z])`, 'i').test(t)) return true;
  return g.name.length >= 3 && new RegExp(`(^|[^0-9A-Za-z])${esc(g.name)}($|[^0-9A-Za-z])`, 'i').test(t)
    && /gateway|bridge|router|coordinator|offline|communication|no contact|lost contact/i.test(t);
}

export function classifyGateway(f: GatewayFacts): GatewayVerdict {
  const a = f.alarms.find((x) => alarmNamesGateway(f, x));
  if (a) return { state: 'offline', reason: `Visionline alarm: ${a.title || a.text}` };
  const on = f.doorStates.filter((s) => s === 'online').length, off = f.doorStates.filter((s) => s === 'offline').length;
  if (f.doorStates.length >= 2 && off === f.doorStates.length) return { state: 'offline', reason: `All ${off} locks behind it are offline` };
  if (on > 0) return { state: 'online', reason: off ? `${off} of its ${f.doorStates.length} locks offline` : null };
  return { state: 'unknown', reason: f.doorStates.length ? 'Its locks have not reported yet' : 'No locks linked to it' };
}

/** Reads the facts of every gateway of a site. */
export async function gatewayFacts(hotelId: string) {
  const gws = await many(pool, 'SELECT * FROM gateways WHERE hotel_id=$1 ORDER BY name', [hotelId]);
  if (!gws.length) return [];
  const states = new Map((await many(pool, 'SELECT door_id, state FROM door_status WHERE hotel_id=$1', [hotelId])).map((r) => [r.door_id as string, r.state as GatewayFacts['doorStates'][number]]));
  const alarms = (await many(pool, `SELECT COALESCE(type_name, alarm_type, '') AS title, COALESCE(alarm_text, '') AS text FROM vl_alarms WHERE hotel_id=$1 AND NOT completed`, [hotelId]))
    .map((a) => ({ title: a.title as string, text: a.text as string }));
  return gws.map((g) => ({ gateway: g, facts: { name: g.name, eeid: g.eeid, doorStates: (g.doors as string[]).map((d) => states.get(d) ?? 'unknown'), alarms } as GatewayFacts }));
}

export async function setGatewayState(id: string, v: GatewayVerdict) {
  await pool.query(`UPDATE gateways SET checked_at=now(), reason=$3, changed_at = CASE WHEN state <> $2 THEN now() ELSE changed_at END, state=$2 WHERE id=$1`, [id, v.state, v.reason]);
}
