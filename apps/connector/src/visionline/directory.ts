import { VL, toVisionlineLocal } from '@smk/shared/node';
import type { DirectoryChunk, SyncDirectoryPayload } from '@smk/shared';
import { VisionlineApiError, type VisionlineClient } from './client.ts';
import { firstText, isNotFound } from './adapter.ts';
import { utcForms, withTimeForms } from './time-forms.ts';

/**
 * Read-only snapshot of Visionline's people, valid keycards and lock alarms for management reports.
 *   users  [§5.30 GET /users(?userGroup=), §5.31 GET /users/{id}]
 *   cards  [§5.9.3 GET /cards?cardHolder=&validTime=, §5.10 GET /cards/{id}]
 *   alarms [§5.1 GET /alarmTypes, §5.3 GET /alarms?updatedSince=, §5.4 GET /alarms/{id}]
 * GET requests only; nothing in Visionline changes. It runs on the hotel's live server, so it is deliberately
 * slow: at most two requests at a time with a short pause between them.
 *
 * Kept: user id, surname, given name, user group; card validity, state flags, doors, door groups, time schedule.
 * Never kept or forwarded: PIN, e-mail, phone, user details, card serial numbers, sectors, track 2, metadata.
 */
const CHUNK = 400;
/** The people/keycard read is the lowest priority on the shared Visionline (key issuing and the GRMS go first). */
const LOW = { priority: 'low' as const };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>, pauseMs: number): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]!);
      if (pauseMs) await sleep(pauseMs);
    }
  }));
  return out;
}

const bool = (v: unknown) => v === true || v === 'true';
/**
 * Deadbolt override as Visionline reports it on the card: a property whose name mentions the deadbolt (on the card or
 * on one of its door operations), or an operation named that way. null when Visionline says nothing about it.
 */
export function deadbolt(c: any): boolean | null {
  let found: boolean | null = null;
  const look = (o: any) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) if (/dead.?bolt/i.test(k) && (typeof v === 'boolean' || v === 'true' || v === 'false')) found = found === true || v === true || v === 'true';
    if (typeof o.operation === 'string' && /dead.?bolt/i.test(o.operation)) found = true;
  };
  look(c);
  for (const o of Array.isArray(c?.doorOperations) ? c.doorOperations : []) look(o);
  return found;
}

/** Adds the request to a Visionline error so the portal says which read failed (no secrets in paths). */
function where(path: string, e: unknown): never {
  if (e instanceof VisionlineApiError && !e.message.startsWith('GET ')) e.message = `GET ${path}: ${e.message}`;
  throw e;
}

export async function readDirectory(vl: VisionlineClient, p: SyncDirectoryPayload, timeZone: string, send: (c: Omit<DirectoryChunk, 'syncId'>) => Promise<void>,
  opts: { pauseMs?: number; onProgress?: (s: string) => void } = {}) {
  const pause = opts.pauseMs ?? 25;
  const notes: string[] = [];
  const counts = { users: 0, cards: 0, alarms: 0 };

  // ---- users
  let ids: string[] = [];
  if (p.userIds?.length) {
    // 2.10 A card was just issued or changed for these people: read only them (no alarms, no full snapshot).
    ids = p.userIds;
  } else if (p.userGroups === null) {
    ids = ((await vl.request<{ id: unknown }[]>('GET', VL.paths.users, undefined, LOW)) ?? []).map((u) => firstText(u.id)).filter((x): x is string => Boolean(x));
  } else {
    for (const g of p.userGroups) {
      try {
        const r = await vl.request<{ id: unknown }[]>('GET', `${VL.paths.users}?userGroup=${encodeURIComponent(g)}`, undefined, LOW);
        ids.push(...(r ?? []).map((u) => firstText(u.id)).filter((x): x is string => Boolean(x)));
      } catch (e) {
        if (!isNotFound(e)) throw e;
        notes.push(`User group "${g}" does not exist in Visionline.`);
      }
    }
  }
  ids = [...new Set(ids)];
  if (ids.length > p.maxUsers) { notes.push(`${ids.length} users found; only the first ${p.maxUsers} were read (Settings → Reports & sync).`); ids = ids.slice(0, p.maxUsers); }

  let users: DirectoryChunk['users'] = [];
  let cards: DirectoryChunk['cards'] = [];
  /** Sends a part once enough has been read. The arrays are swapped before awaiting so parallel readers never lose rows. */
  const flush = async () => {
    if (users.length < CHUNK && cards.length < CHUNK) return;
    const u = users, c = cards;
    users = []; cards = [];
    await send({ final: false, users: u, cards: c, alarms: [], notes: [] });
  };

  const nowDate = new Date();
  const cardTimeForms = [toVisionlineLocal(nowDate, timeZone), ...utcForms(nowDate)];
  let done = 0;
  await pool(ids, 2, async (id) => {
    let u: any;
    try { u = await vl.request<any>('GET', VL.paths.user(id), undefined, LOW); } catch (e) { if (isNotFound(e)) return; throw e; }
    users.push({ id, surname: firstText(u?.surname), givenName: firstText(u?.givenName), userGroup: firstText(u?.userGroup) });
    counts.users++;
    if (p.includeCards) {
      let found: { id: unknown }[] = [];
      try {
        found = (await withTimeForms('cards.validTime', cardTimeForms, (t) => vl.request<{ id: unknown }[]>('GET', `${VL.paths.cards}?cardHolder=${encodeURIComponent(id)}&validTime=${t}`, undefined, LOW))) ?? [];
      } catch (e) { if (!isNotFound(e)) where(`${VL.paths.cards}?validTime=…`, e); }
      for (const f of found) {
        const reg = firstText(f.id);
        if (!reg) continue;
        let c: any;
        try { c = await vl.request<any>('GET', VL.paths.card(reg), undefined, LOW); } catch (e) { if (isNotFound(e) || (e as any)?.code === 40411) continue; throw e; }
        const ops = Array.isArray(c?.doorOperations) ? c.doorOperations : [];
        cards.push({
          regNo: reg, cardHolder: firstText(c?.cardHolder) ?? id, format: firstText(c?.format),
          startTime: firstText(c?.startTime), expireTime: firstText(c?.expireTime),
          cancelled: bool(c?.cancelled), discarded: bool(c?.discarded), overridden: bool(c?.overridden), expired: bool(c?.expired), notIssued: bool(c?.notIssued),
          issuedCount: Number.isFinite(Number(c?.numberOfIssuedCards)) ? Number(c.numberOfIssuedCards) : null,
          doors: [...new Set(ops.flatMap((o: any) => (Array.isArray(o?.doors) ? o.doors : []).map(String)))].slice(0, 300) as string[],
          doorGroups: [...new Set(ops.flatMap((o: any) => (Array.isArray(o?.doorGroups) ? o.doorGroups : []).map(String)))].slice(0, 100) as string[],
          timeSchedule: firstText(c?.timeSchedule),
          operations: [...new Set(ops.map((o: any) => firstText(o?.operation)).filter((x: unknown): x is string => Boolean(x)))].slice(0, 20) as string[],
          deadboltOverride: deadbolt(c),
        });
        counts.cards++;
      }
    }
    if (++done % 50 === 0) opts.onProgress?.(`${done}/${ids.length} users`);
    await flush();
  }, pause);

  // ---- alarms (needs the Visionline option "Web service for checking and confirming alarms")
  const alarms: DirectoryChunk['alarms'] = [];
  if (p.includeAlarms && !p.userIds?.length) {
    try {
      const types = new Map<string, string>();
      try { for (const t of (await vl.request<any[]>('GET', '/alarmTypes', undefined, LOW)) ?? []) { const k = firstText(t?.id); if (k) types.set(k, firstText(t?.name) ?? k); } } catch (e) { if (!isNotFound(e)) throw e; }
      const since = new Date(p.alarmsSince ?? Date.now() - 30 * 86_400_000);
      // updatedSince is UTC [§5.3.2], with the "Z" (without it Visionline answers "Time must be in UTC.").
      const list = (await withTimeForms('alarms.updatedSince', utcForms(Number.isNaN(since.getTime()) ? new Date(Date.now() - 30 * 86_400_000) : since),
        (t) => vl.request<{ id: unknown }[]>('GET', `/alarms?updatedSince=${t}`, undefined, LOW)).catch((e) => where('/alarms?updatedSince=…', e))) ?? [];
      const idsA = list.map((a) => firstText(a.id)).filter((x): x is string => Boolean(x)).slice(-1500);
      if (list.length > idsA.length) notes.push(`${list.length} alarms since the last sync; the newest 1500 were read.`);
      await pool(idsA, 2, async (aid) => {
        let a: any;
        try { a = await vl.request<any>('GET', `/alarms/${encodeURIComponent(aid)}`, undefined, LOW); } catch (e) { if (isNotFound(e)) return; throw e; }
        const type = firstText(a?.alarmType);
        alarms.push({
          id: aid, alarmType: type, alarmTypeName: type ? types.get(type) ?? null : null, alarmText: firstText(a?.alarmText)?.slice(0, 500) ?? null,
          alarmTime: firstText(a?.alarmTime), door: firstText(a?.door?.id, a?.door), cardHolder: firstText(a?.cardHolder?.id, a?.cardHolder),
          completed: bool(a?.completed), completionTime: firstText(a?.completionTime), updateTime: firstText(a?.updateTime),
        });
        counts.alarms++;
      }, pause);
    } catch (e) {
      // Alarms never spoil the people and keycards read: a problem here becomes a note in the sync result.
      if (!(e instanceof VisionlineApiError) || e.status === 0 || e.status === 401) throw e;
      if (isNotFound(e) || e.status === 403) notes.push('Lock alarms are not available from this Visionline (option "Web service for checking and confirming alarms" not licensed).');
      else notes.push(`Lock alarms could not be read: ${e.message}`);
    }
  }
  // Last part carries the alarms and the notes, and tells the platform the snapshot is complete.
  for (let i = 0; i < alarms.length || i === 0; i += CHUNK) {
    const last = i + CHUNK >= alarms.length;
    if (last) await send({ final: true, users, cards, alarms: alarms.slice(i, i + CHUNK), notes });
    else await send({ final: false, users: [], cards: [], alarms: alarms.slice(i, i + CHUNK), notes: [] });
  }
  return { ...counts, notes };
}
