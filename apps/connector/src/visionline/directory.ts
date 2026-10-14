import { VL, toVisionlineLocal } from '@smk/shared/node';
import type { DirectoryChunk, SyncDirectoryPayload } from '@smk/shared';
import type { VisionlineClient } from './client.ts';
import { firstText, isNotFound } from './adapter.ts';

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

export async function readDirectory(vl: VisionlineClient, p: SyncDirectoryPayload, timeZone: string, send: (c: Omit<DirectoryChunk, 'syncId'>) => Promise<void>,
  opts: { pauseMs?: number; onProgress?: (s: string) => void } = {}) {
  const pause = opts.pauseMs ?? 25;
  const notes: string[] = [];
  const counts = { users: 0, cards: 0, alarms: 0 };

  // ---- users
  let ids: string[] = [];
  if (p.userGroups === null) {
    ids = ((await vl.request<{ id: unknown }[]>('GET', VL.paths.users)) ?? []).map((u) => firstText(u.id)).filter((x): x is string => Boolean(x));
  } else {
    for (const g of p.userGroups) {
      try {
        const r = await vl.request<{ id: unknown }[]>('GET', `${VL.paths.users}?userGroup=${encodeURIComponent(g)}`);
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

  const now = toVisionlineLocal(new Date(), timeZone);
  let done = 0;
  await pool(ids, 2, async (id) => {
    let u: any;
    try { u = await vl.request<any>('GET', VL.paths.user(id)); } catch (e) { if (isNotFound(e)) return; throw e; }
    users.push({ id, surname: firstText(u?.surname), givenName: firstText(u?.givenName), userGroup: firstText(u?.userGroup) });
    counts.users++;
    if (p.includeCards) {
      let found: { id: unknown }[] = [];
      try { found = (await vl.request<{ id: unknown }[]>('GET', `${VL.paths.cards}?cardHolder=${encodeURIComponent(id)}&validTime=${now}`)) ?? []; }
      catch (e) { if (!isNotFound(e)) throw e; }
      for (const f of found) {
        const reg = firstText(f.id);
        if (!reg) continue;
        let c: any;
        try { c = await vl.request<any>('GET', VL.paths.card(reg)); } catch (e) { if (isNotFound(e) || (e as any)?.code === 40411) continue; throw e; }
        const ops = Array.isArray(c?.doorOperations) ? c.doorOperations : [];
        cards.push({
          regNo: reg, cardHolder: firstText(c?.cardHolder) ?? id, format: firstText(c?.format),
          startTime: firstText(c?.startTime), expireTime: firstText(c?.expireTime),
          cancelled: bool(c?.cancelled), discarded: bool(c?.discarded), overridden: bool(c?.overridden), expired: bool(c?.expired), notIssued: bool(c?.notIssued),
          issuedCount: Number.isFinite(Number(c?.numberOfIssuedCards)) ? Number(c.numberOfIssuedCards) : null,
          doors: [...new Set(ops.flatMap((o: any) => (Array.isArray(o?.doors) ? o.doors : []).map(String)))].slice(0, 300) as string[],
          doorGroups: [...new Set(ops.flatMap((o: any) => (Array.isArray(o?.doorGroups) ? o.doorGroups : []).map(String)))].slice(0, 100) as string[],
          timeSchedule: firstText(c?.timeSchedule),
        });
        counts.cards++;
      }
    }
    if (++done % 50 === 0) opts.onProgress?.(`${done}/${ids.length} users`);
    await flush();
  }, pause);

  // ---- alarms (needs the Visionline option "Web service for checking and confirming alarms")
  const alarms: DirectoryChunk['alarms'] = [];
  if (p.includeAlarms) {
    try {
      const types = new Map<string, string>();
      try { for (const t of (await vl.request<any[]>('GET', '/alarmTypes')) ?? []) { const k = firstText(t?.id); if (k) types.set(k, firstText(t?.name) ?? k); } } catch (e) { if (!isNotFound(e)) throw e; }
      const since = p.alarmsSince ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
      // updatedSince is UTC [§5.3.2]; the document's examples use the compact form.
      const utc = since.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').slice(0, 13);
      const list = (await vl.request<{ id: unknown }[]>('GET', `/alarms?updatedSince=${utc}`)) ?? [];
      const idsA = list.map((a) => firstText(a.id)).filter((x): x is string => Boolean(x)).slice(-1500);
      if (list.length > idsA.length) notes.push(`${list.length} alarms since the last sync; the newest 1500 were read.`);
      await pool(idsA, 2, async (aid) => {
        let a: any;
        try { a = await vl.request<any>('GET', `/alarms/${encodeURIComponent(aid)}`); } catch (e) { if (isNotFound(e)) return; throw e; }
        const type = firstText(a?.alarmType);
        alarms.push({
          id: aid, alarmType: type, alarmTypeName: type ? types.get(type) ?? null : null, alarmText: firstText(a?.alarmText)?.slice(0, 500) ?? null,
          alarmTime: firstText(a?.alarmTime), door: firstText(a?.door?.id, a?.door), cardHolder: firstText(a?.cardHolder?.id, a?.cardHolder),
          completed: bool(a?.completed), completionTime: firstText(a?.completionTime), updateTime: firstText(a?.updateTime),
        });
        counts.alarms++;
      }, pause);
    } catch (e) {
      if (!isNotFound(e) && (e as any)?.status !== 403) throw e;
      notes.push('Lock alarms are not available from this Visionline (option "Web service for checking and confirming alarms" not licensed).');
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
