import { isMobileCard } from './mobile.ts';
import { VL, toVisionlineLocal, VL_DOC } from '@smk/shared/node';
import type { DiscoveredResource, DoorCommandsPayload, EncodeKeycardPayload, ErrorInfo, IssueStaffKeyPayload, RevokeStaffKeyPayload } from '@smk/shared';
import { VisionlineClient, VisionlineApiError } from './client.ts';
import { utcForms, withTimeForms } from './time-forms.ts';

/**
 * Versioned Visionline adapter (spec §4.2, §13.1). Translates platform commands into the documented
 * Web API operations. Everything vendor-specific stays behind this interface.
 */
/** Key issuing, revoking and card reads at the encoder go first on the shared Visionline (2.13). */
const HIGH = { priority: 'high' as const };
export const ADAPTER_VERSION = `visionline-webapi-v1 (${VL_DOC})`;

/** Visionline answers "not found" with 40404 for user groups in the document, and 40401 on some installations. */
export const isNotFound = (e: unknown) => e instanceof VisionlineApiError && (e.status === 404 || e.code === 40404 || e.code === 40401);

/** First value that is a non-empty string or a number, as text. */
export function firstText(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/** [§5.16] The document's path is /mobileaccess; installations list the resource as "mobileAccess". Try both. */
export async function getMobileAccessAccounts(vl: VisionlineClient): Promise<any[]> {
  let base: string = VL.paths.mobileAccessAccounts;
  let list: any[];
  try { list = await vl.request<any[]>('GET', base); } catch (e) {
    if (!isNotFound(e)) throw e;
    base = '/mobileAccess';
    list = await vl.request<any[]>('GET', base);
  }
  // Some installations list names only; the systemID is in the account details [§5.17].
  const out: any[] = [];
  for (const a of list ?? []) {
    const id = String(a?.name ?? a?.id ?? (typeof a === 'string' ? a : ''));
    if (a?.systemID === undefined && id) {
      try { out.push({ ...(typeof a === 'object' ? a : {}), ...(await vl.request<any>('GET', `${base}/${encodeURIComponent(id)}`)), name: id }); continue; } catch { /* keep what the list gave */ }
    }
    out.push(typeof a === 'object' ? a : { name: id });
  }
  return out;
}

/** Names of all user groups, if the installation offers GET /userGroups (not in the document, §5.29); else null. */
export async function listUserGroupNames(vl: VisionlineClient): Promise<string[] | null> {
  try {
    const r = await vl.request<any>('GET', '/userGroups');
    if (!Array.isArray(r)) return null;
    return r.map((g) => String(typeof g === 'string' ? g : g?.id ?? g?.name ?? '')).filter(Boolean);
  } catch { return null; }
}

export type RevokeStrategy = 'checkoutPerDoor' | 'cancelCard';

export interface VisionlineAdapter {
  createUserGroup(name: string, uniformAccess: boolean): Promise<{ id: string; uniformAccess: boolean; doorOperations: unknown[] }>;
  discover(userGroups: string[]): Promise<{ resources: DiscoveredResource[]; apiResources: string[] }>;
  validate(): Promise<Record<string, unknown>>;
  issueStaffMobileKey(p: IssueStaffKeyPayload, onBeforeNonIdempotentCall: () => void): Promise<{ credentialId: string; cardRegNo: string | null; resolvedScope: Record<string, unknown> }>;
  revokeStaffMobileKey(p: RevokeStaffKeyPayload): Promise<Record<string, unknown>>;
  /** [§7.14] Register a callback for card changes and refused-door lock events; returns its id. */
  registerWatch(extraEventCodes?: number[]): Promise<string>;
  deleteWatch(id: string): Promise<void>;
  /** [§7.16] Long poll; returns queued card changes and events (empty after up to 4 minutes). */
  pollWatch(id: string): Promise<{ cards: any[]; events: any[] }>;
  /** [§5.9.3] Cards cancelled since a moment (catch-up after downtime), with their details [§5.10.2]. */
  cancelledSince(since: Date): Promise<any[]>;
  /** 2.12 pilot: the card on an encoder, read-only. */
  readCardAtEncoder(encoder: string, action: 'read' | 'readCard'): Promise<Record<string, unknown>>;
  /** 2.14 Encode a staff / expire-now / emergency / stand-open card at an encoder [§7.6.1, §7.22]. */
  encodeKeycard(p: EncodeKeycardPayload): Promise<Record<string, unknown>>;
  /** 2.14 Cancel a physical keycard [§5.10]. */
  cancelKeycard(regNo: string, cardHolder?: string): Promise<Record<string, unknown>>;
  /** 2.14 Commands to online locks [§5.13.4, §7.12]. */
  doorCommands(p: DoorCommandsPayload): Promise<{ results: { door: string; ok: boolean; error?: string; code?: number }[] }>;
  listEncoders(): Promise<{ encoders: string[] }>;
  countGuestCards(rooms: string[]): Promise<{ counts: { room: string; n: number }[]; errors: { room: string; error: string }[]; readAt: string }>;
}

export class WebApiAdapter implements VisionlineAdapter {
  constructor(private vl: VisionlineClient, private timeZone: () => string, private revokeStrategy: RevokeStrategy) {}

  async discover(userGroups: string[]) {
    const out: DiscoveredResource[] = [];
    const apiResources = ((await this.vl.request<{ id: string }[]>('GET', VL.paths.resources)) ?? []).map((r) => r.id);
    // Doors with details give door group membership [§5.12.2]; floors are door groups [spec §12.4].
    const doors = await this.vl.request<any[]>('GET', `${VL.paths.doors}?details=true`);
    const groups = new Map<string, unknown>();
    const seen = new Set<string>();
    for (const d of doors ?? []) {
      // [§5.13.2] id is the door's number or name. Some Visionline builds leave id out of the detailed
      // list, so fall back to the door name; never key doors on a missing value (they would merge into one).
      const id = firstText(d.id, d.doorName, d.localName, d.doorID);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ kind: 'door', externalId: id, name: firstText(d.doorName, d.id, d.localName) ?? id, data: { doorGroup: d.doorGroup ?? null, doorGroupID: d.doorGroupID ?? null, doorCategory: d.doorCategory ?? null, doorID: d.doorID ?? null, online: d.online ?? null } });
      if (d.doorGroup) groups.set(String(d.doorGroup), d.doorGroupID ?? null);
    }
    for (const [name, id] of groups) out.push({ kind: 'doorgroup', externalId: name, name, data: { doorGroupID: id } });
    try { for (const e of (await this.listEncoders()).encoders) out.push({ kind: 'encoder', externalId: e, name: e, data: {} }); } catch { /* older Visionline: no list */ }
    // Configured groups, plus every group Visionline lists (when it offers the list).
    const allGroups = [...new Set([...userGroups, ...((await listUserGroupNames(this.vl)) ?? [])])];
    for (const g of allGroups) {
      try {
        const ug = await this.vl.request<any>('GET', VL.paths.userGroup(g));
        out.push({ kind: 'usergroup', externalId: String(ug.id ?? g), name: String(ug.id ?? g), data: { uniformAccess: ug.uniformAccess ?? false, doorOperations: ug.doorOperations ?? [], timeSchedule: ug.timeSchedule ?? null,
          // 0.13.1 [§5.29.2] override rights of the group: deadbolt and privacy (null = Visionline did not say)
          ignoreDeadbolt: typeof ug.ignoreDeadbolt === 'boolean' ? ug.ignoreDeadbolt : null, ignorePrivacy: typeof ug.ignorePrivacy === 'boolean' ? ug.ignorePrivacy : null,
          autoBlockInRentedRoom: typeof ug.autoBlockInRentedRoom === 'boolean' ? ug.autoBlockInRentedRoom : null,
          maxStaffCardsPerUser: Number.isInteger(ug.maxStaffCardsPerUser) ? ug.maxStaffCardsPerUser : null, validation: ug.validation ?? null } });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    }
    try {
      for (const t of await this.vl.request<any[]>('GET', VL.paths.timeSchedules)) {
        // An unnamed schedule cannot be referenced on a card, so it is not offered.
        const name = firstText(t.timeSchedule, t.id);
        if (!name) continue;
        out.push({ kind: 'timeschedule', externalId: name, name, data: { description: t.description ?? null } });
      }
    } catch (e) { if (!(e instanceof VisionlineApiError && e.status === 404)) throw e; }
    for (const a of await getMobileAccessAccounts(this.vl)) {
      const name = String(a.name ?? a.id);
      out.push({ kind: 'mobileaccessaccount', externalId: name, name, data: { description: a.description ?? null, systemID: a.systemID ?? null } });
    }
    return { resources: out, apiResources };
  }

  /** [§5.29] PUT /userGroups/{id} creates a group; read it back to confirm. */
  async createUserGroup(name: string, uniformAccess: boolean) {
    try {
      await this.vl.request('PUT', VL.paths.userGroup(name), { uniformAccess });
    } catch (e) {
      if (!(e instanceof VisionlineApiError && e.code === 40901)) throw e; // already exists: fine
    }
    const g = await this.vl.request<any>('GET', VL.paths.userGroup(name));
    return { id: String(g.id ?? name), uniformAccess: Boolean(g.uniformAccess), doorOperations: g.doorOperations ?? [] };
  }

  /** 2.26.1 How each encoder's name must be written in the query (learned on the first read that works). */
  static encoderStyles = new Map<string, 'encoded' | 'plus'>();
  static encoderParam(encoder: string) {
    const e = encodeURIComponent(encoder);
    return WebApiAdapter.encoderStyles.get(encoder) === 'plus' ? e.replace(/%20/g, '+') : e;
  }

  async readCardAtEncoder(encoder: string, action: 'read' | 'readCard', encoderStyle: 'encoded' | 'plus' = WebApiAdapter.encoderStyles.get(encoder) ?? 'encoded') {
    // 2.26 / 2.26.1 Bana, 2 Nov: Visionline answers "Invalid query parameter value" to reading a card on "Encoder .96".
    // Which query value it refuses is not said. Reading changes nothing, so up to four forms are tried, the hotel's
    // setting first: the read action named "read" or "readCard", and the encoder name with its space written as %20
    // or as +. The form that works is reported (the platform keeps it); if none works, every answer is reported.
    const enc = (style: string) => (style === 'plus' ? encodeURIComponent(encoder).replace(/%20/g, '+') : encodeURIComponent(encoder));
    const other = action === 'read' ? 'readCard' : 'read';
    const otherStyle = encoderStyle === 'plus' ? 'encoded' : 'plus';
    const tries: [('read' | 'readCard'), ('encoded' | 'plus')][] = [[action, encoderStyle], [other, encoderStyle]];
    if (/\s/.test(encoder)) tries.push([action, otherStyle], [other, otherStyle]);
    const refused = (e: unknown) => e instanceof VisionlineApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 409
      && /query parameter|parameter value|(invalid|unknown|illegal)[^.]*(action|encoder)/i.test(`${e.message} ${e.developerMessage ?? ''}`) && !/no card/i.test(e.message);
    const answers: string[] = [];
    let r: any; let actionUsed: 'read' | 'readCard' = action; let encoderStyleUsed: 'encoded' | 'plus' = encoderStyle;
    for (const [i, [a, st]] of tries.entries()) {
      const q = `?action=${a}&encoder=${enc(st)}`;
      try { r = await this.vl.request<any>('POST', `${VL.paths.cards}${q}`, {}, HIGH); actionUsed = a; encoderStyleUsed = st; WebApiAdapter.encoderStyles.set(encoder, st); break; } catch (e) {
        if (!refused(e)) throw e;
        const v = e as VisionlineApiError;
        answers.push(`${q} → ${v.status}${v.code ? ` ${v.code}` : ''} ${v.message}${v.developerMessage && v.developerMessage !== v.message ? ` (${v.developerMessage})` : ''}`);
        if (i === tries.length - 1) throw new VisionlineApiError(v.status, v.code, `Visionline refused every form of "read the card on encoder ${encoder}": ${answers.join('; ')}`, v.developerMessage);
      }
    }
    const id = firstText(r?.id, r?.registrationNumber, r?.cardID);
    // Details of the card as Visionline knows it (validity, holder, doors). Serial numbers, PINs and tracks are never kept.
    let d: any = r;
    if (id) { try { d = { ...r, ...(await this.vl.request<any>('GET', VL.paths.card(id), undefined, HIGH)) }; } catch { /* the read itself is enough */ } }
    const ops = Array.isArray(d?.doorOperations) ? d.doorOperations : [];
    return {
      regNo: id ?? null, cardHolder: firstText(d?.cardHolder), format: firstText(d?.format), startTime: firstText(d?.startTime), expireTime: firstText(d?.expireTime),
      cancelled: d?.cancelled === true, expired: d?.expired === true, overridden: d?.overridden === true, timeSchedule: firstText(d?.timeSchedule),
      doors: [...new Set(ops.flatMap((o: any) => (Array.isArray(o?.doors) ? o.doors : []).map(String)))].slice(0, 300),
      doorGroups: [...new Set(ops.flatMap((o: any) => (Array.isArray(o?.doorGroups) ? o.doorGroups : []).map(String)))].slice(0, 100),
      // 2.23 The door operations as Visionline has them, so the card can be written again with a new expiry.
      operations: ops.slice(0, 10).map((o: any) => ({ operation: String(o?.operation ?? 'normal').slice(0, 30),
        doors: (Array.isArray(o?.doors) ? o.doors : []).map(String).slice(0, 2000), doorGroups: (Array.isArray(o?.doorGroups) ? o.doorGroups : []).map(String).slice(0, 200) })),
      encoder, readAt: new Date().toISOString(), actionUsed, encoderStyleUsed,
      // 2.17 a phone's mobile key reads as serial FFFFFFFF; only this yes/no is passed on
      mobile: isMobileCard(d),
    };
  }

  async encodeKeycard(p: EncodeKeycardPayload) {
    if (p.user) await this.ensureUser({ cardHolder: p.cardHolder, user: p.user } as IssueStaffKeyPayload);
    const tz = this.timeZone();
    const F = VL.fields;
    const ops = (normal: string[], onOff: string[] = []) => [
      ...(normal.length ? [{ [F.operation]: F.operationNormal, [F.doors]: normal }] : []),
      ...(onOff.length ? [{ [F.operation]: 'on/off', [F.doors]: onOff }] : []),
    ];
    const body: Record<string, unknown> = { [F.cardHolder]: p.cardHolder, [F.format]: F.formatTLCode };
    const q = [`${VL.query.action}=encode`, `encoder=${WebApiAdapter.encoderParam(p.encoder)}`];
    if (p.kind === 'emergency') q.push('type=emergency'); // [§7.22.2] all doors, always valid: no doors, no times
    else if (p.kind === 'clearance') { // [§7.22.1] rfid48, all doors, expireTime only
      q.push('type=clearance'); body[F.format] = 'rfid48';
      body[F.expireTime] = toVisionlineLocal(p.expireTime ? new Date(p.expireTime) : new Date(Date.now() + 86_400_000), tz);
    } else if (p.kind === 'guestBlock') {
      // Guest card for the room that overrides every older guest card [§5.9.4 override] and is dead a minute later:
      // placed in an offline lock, the lock stops accepting the previous guest's cards.
      body[F.format] = 'rfid48';
      if (!p.doorIds.length) throw Object.assign(new Error('Choose the room.'), { code: 'NO_DOORS' });
      body[F.doorOperations] = [{ [F.operation]: 'guest', [F.doors]: [p.doorIds[0]] }];
      body[F.expireTime] = toVisionlineLocal(new Date(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000), tz);
    } else {
      if (p.kind === 'oneTime') { q.push('type=oneTime'); body[F.format] = 'rfid48'; } // [§7.22.3]
      if (p.kind === 'standOpen') q.push('type=standOpen'); // [§7.22.5] doors with operation normal only
      // 2.23 Extending a card: its door operations exactly as read from Visionline (doors, door groups, operation).
      const doors = p.kind === 'staff' && p.operations?.length
        ? p.operations.filter((o) => o.doors.length || o.doorGroups.length).map((o) => ({ [F.operation]: o.operation, ...(o.doors.length ? { [F.doors]: o.doors } : {}), ...(o.doorGroups.length ? { doorGroups: o.doorGroups } : {}) }))
        : ops(p.doorIds, p.kind === 'staff' ? p.onOffDoorIds : []);
      if (!doors.length) throw Object.assign(new Error('Choose at least one door for this card.'), { code: 'NO_DOORS' });
      body[F.doorOperations] = doors;
      // expireNow: the next whole minute + 1 (Visionline times have minute precision), so the card is dead a minute later.
      const exp = p.kind === 'expireNow' ? new Date(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000) : p.expireTime ? new Date(p.expireTime) : null;
      if (!exp) throw Object.assign(new Error('The card needs an end time.'), { code: 'NO_EXPIRY' });
      body[F.expireTime] = toVisionlineLocal(exp, tz);
      if (p.timeSchedule && p.kind === 'staff') body[F.timeSchedule] = p.timeSchedule;
    }
    if (p.override || p.kind === 'expireNow' || p.kind === 'guestBlock') q.push(`${VL.query.override}=true`);
    if (p.overwriteValidCard || p.kind === 'expireNow' || p.kind === 'guestBlock') q.push('overwriteValidCard=true');
    const r = await this.vl.request<any>('POST', `${VL.paths.cards}?${q.join('&')}`, body, { ...HIGH, timeoutMs: 60_000 });
    const regNo = firstText(r?.id, r?.registrationNumber);
    // Serial numbers of the physical card are not kept (privacy rule since 2.5).
    return { kind: p.kind, regNo, cardHolder: firstText(r?.cardHolder) ?? p.cardHolder, startTime: firstText(r?.startTime), expireTime: firstText(r?.expireTime) ?? (body[F.expireTime] as string | undefined) ?? null,
      doors: p.doorIds.length, encoder: p.encoder, encodedAt: new Date().toISOString() };
  }

  /** 2.14 Valid guest keycards per room [§5.9.3]: background reads, one room at a time (the PMS and GRMS go first). */
  async countGuestCards(rooms: string[]) {
    const at = toVisionlineLocal(new Date(), this.timeZone());
    const counts: { room: string; n: number }[] = [];
    const errors: { room: string; error: string }[] = [];
    for (const room of rooms) {
      try {
        const r = await this.vl.request<{ id: string }[]>('GET', `${VL.paths.cards}?guestDoor=${encodeURIComponent(room)}&validTime=${at}`, undefined, { priority: 'low' });
        counts.push({ room, n: (r ?? []).length });
      } catch (e) { errors.push({ room, error: (e as Error).message.slice(0, 120) }); }
    }
    return { counts, errors, readAt: new Date().toISOString() };
  }

  /** 2.14 Encoders configured in Visionline [§5.14]. */
  async listEncoders() {
    const r = await this.vl.request<{ id: string }[]>('GET', '/encoders', undefined, HIGH);
    return { encoders: (r ?? []).map((e) => String(e.id)).filter(Boolean) };
  }

  async cancelKeycard(regNo: string, cardHolder?: string) {
    const card = await this.vl.request<any>('GET', VL.paths.card(regNo), undefined, HIGH);
    if (cardHolder && card?.cardHolder && card.cardHolder !== cardHolder) throw new VisionlineApiError(409, undefined, `Card ${regNo} belongs to ${card.cardHolder}, not ${cardHolder}; not cancelled`);
    if (card?.cancelled === true) return { regNo, alreadyCancelled: true, cardHolder: card?.cardHolder ?? null };
    await this.vl.request('POST', VL.paths.card(regNo), { cancelled: true }, HIGH);
    return { regNo, cancelled: true, cardHolder: card?.cardHolder ?? null };
  }

  async doorCommands(p: DoorCommandsPayload) {
    const tz = this.timeZone();
    const body = p.command === 'emergencyOpen' ? { emergencyOpen: true } : p.command === 'emergencyClose' ? { emergencyOpen: false }
      : p.command === 'open' ? { open: true } : p.command === 'clearStandOpen' ? { standOpenTime: null } : p.command === 'checkout' ? { checkedOut: true }
      : { standOpenTime: p.standOpenUntil ? toVisionlineLocal(new Date(p.standOpenUntil), tz) : 'forever' };
    // Emergency commands skip the queue (the GRMS waits a few seconds); other commands go first in the high lane.
    const prio = p.command === 'emergencyOpen' || p.command === 'emergencyClose' ? 'emergency' as const : 'high' as const;
    const results: { door: string; ok: boolean; error?: string; code?: number }[] = [];
    const queue = [...p.doors];
    const worker = async () => {
      for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
        try {
          await this.vl.request('POST', `${VL.paths.door(d)}?timeout=${p.timeoutSec}`, body, { priority: prio, timeoutMs: (p.timeoutSec + 15) * 1000 });
          results.push({ door: d, ok: true });
        } catch (e) {
          results.push({ door: d, ok: false, error: (e as Error).message.slice(0, 200), code: e instanceof VisionlineApiError ? e.code : undefined });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(p.parallel, p.doors.length) }, worker));
    return { results };
  }

  async validate() {
    const resources = ((await this.vl.request<{ id: string }[]>('GET', VL.paths.resources)) ?? []).map((r) => r.id);
    const accounts = await getMobileAccessAccounts(this.vl);
    return { resources, mobileAccessAccounts: accounts.map((a) => ({ name: a.name, systemID: a.systemID })), clockOffsetMs: this.vl.skewMs, tls: this.vl.tlsState };
  }

  /** Ensure the card holder exists in the right user group [§5.31, spec §12.3 step 1]. Idempotent. */
  private async ensureUser(p: IssueStaffKeyPayload) {
    try {
      const u = await this.vl.request<any>('GET', VL.paths.user(p.cardHolder), undefined, HIGH);
      if (u.userGroup !== p.user.userGroup) await this.vl.request('POST', VL.paths.user(p.cardHolder), { [VL.fields.userGroup]: p.user.userGroup }, HIGH);
    } catch (e) {
      if (!(e instanceof VisionlineApiError && e.status === 404)) throw e;
      await this.vl.request('PUT', VL.paths.user(p.cardHolder), {
        [VL.fields.surname]: p.user.surname, [VL.fields.givenName]: p.user.givenName, [VL.fields.userGroup]: p.user.userGroup, autoDelete: false,
      }, HIGH);
    }
  }

  async issueStaffMobileKey(p: IssueStaffKeyPayload, onBeforeNonIdempotentCall: () => void) {
    await this.ensureUser(p);
    const tz = this.timeZone();
    const expireLocal = toVisionlineLocal(new Date(p.expireTime), tz);
    const F = VL.fields;
    // [§7.5.6] Create mobile key for staff. No startTime: staff keys start now [§7.6.2].
    const body: Record<string, unknown> = {
      [F.cardHolder]: p.cardHolder,
      [F.expireTime]: expireLocal,
      [F.format]: F.formatTLCode,
      [F.endpointId]: p.endpointId,
    };
    // Uniform-access groups: the client may not supply doorOperations; Visionline uses the group's doors [§5.29.3].
    if (!p.useUserGroupDoors) body[F.doorOperations] = [{ [F.operation]: F.operationNormal, [F.doors]: p.doorIds }];
    if (p.startTime) body[F.startTime] = toVisionlineLocal(new Date(p.startTime), tz);
    if (p.accountName) body[F.accountName] = p.accountName;
    if (p.timeSchedule) body[F.timeSchedule] = p.timeSchedule;
    if (p.label) body[F.label] = p.label;
    onBeforeNonIdempotentCall();
    // override=true replaces the holder's current staff card (Visionline 40902 says to use it); with
    // "Revoke mobile key when overridden" in Visionline Options, the old key is removed from the phone.
    const query = `${VL.query.action}=${VL.query.mobileAccess}${p.override ? `&${VL.query.override}=true` : ''}`;
    const r = await this.vl.request<any>('POST', `${VL.paths.cards}?${query}`, body, HIGH);
    if (r?.[F.credentialId] === undefined) throw new VisionlineApiError(500, undefined, 'Visionline did not return a credentialID');
    // The credentialID identifies the mobile key; the card's registration number (used by /cards/{id}, card
    // callbacks and lock events, §5.10.2, §7.14) is different. Look it up now; failure here is not fatal.
    const cardRegNo = await this.findCardRegNo(p.cardHolder, body[F.startTime] as string | undefined, expireLocal).catch(() => null);
    return { credentialId: String(r[F.credentialId]), cardRegNo, resolvedScope: { doorIds: p.doorIds, expireTimeLocal: expireLocal, startTimeLocal: body[F.startTime] ?? null, timeZone: tz, accountName: p.accountName ?? '(Visionline default)', timeSchedule: p.timeSchedule ?? null, userGroupDoors: Boolean(p.useUserGroupDoors), override: Boolean(p.override) } };
  }

  async revokeStaffMobileKey(p: RevokeStaffKeyPayload) {
    if (p.method === 'cancelCard' || (!p.method && this.revokeStrategy === 'cancelCard')) return this.cancelCard(p);
    // [§5.13.4, §7.13.5] check out this credential at every door it can open; the key leaves the phone
    // after all of them are checked out.
    const ok: string[] = [];
    const failed: { door: string; code?: number; message: string }[] = [];
    for (const door of p.doorIds) {
      try {
        await this.vl.request('POST', VL.paths.door(door), { [VL.fields.checkedOut]: true, [VL.fields.credentialId]: Number(p.credentialId) }, HIGH);
        ok.push(door);
      } catch (e) {
        const ve = e as VisionlineApiError;
        failed.push({ door, code: ve.code, message: ve.message });
      }
    }
    if (failed.length) {
      const err = new VisionlineApiError(failed[0]!.code ? Math.floor(failed[0]!.code / 100) : 0, failed[0]!.code, `Checkout failed for ${failed.length} of ${p.doorIds.length} doors: ${failed.map((f) => f.door).join(', ')}`);
      (err as any).partial = { checkedOut: ok, failed };
      throw err;
    }
    return { strategy: 'checkoutPerDoor', checkedOut: ok };
  }

  /**
   * [§7.7.4] Cancel exactly this key's card by its registration number (= credentialID), after checking it
   * belongs to the card holder. Other cards of the same person (e.g. a plastic staff card) are not touched.
   */
  private async cancelCard(p: RevokeStaffKeyPayload) {
    // Without a stored reg. no., use the holder's only valid card (Visionline allows one staff card per user, §7.6.4).
    const regNo = p.cardRegNo ?? await this.onlyValidCard(p.cardHolder);
    let card: any;
    try { card = await this.vl.request<any>('GET', VL.paths.card(regNo), undefined, HIGH); } catch (e) {
      if (e instanceof VisionlineApiError && e.status === 404) throw new VisionlineApiError(404, 40411, `Visionline has no card with reg. no. ${regNo}`);
      throw e;
    }
    if (card?.cardHolder && card.cardHolder !== p.cardHolder) throw new VisionlineApiError(409, undefined, `Card ${regNo} belongs to ${card.cardHolder}, not ${p.cardHolder}; not cancelled`);
    if (card?.cancelled === true) return { strategy: 'cancelCard', regNo, alreadyCancelled: true };
    await this.vl.request('POST', VL.paths.card(regNo), { cancelled: true }, HIGH);
    return { strategy: 'cancelCard', regNo };
  }

  /** [§5.9.3] The holder's cards valid in the key's period; the newest one not cancelled is the key just created. */
  private async findCardRegNo(cardHolder: string, startLocal: string | undefined, expireLocal: string): Promise<string | null> {
    const from = startLocal ?? toVisionlineLocal(new Date(Date.now() - 60_000), this.timeZone());
    const list = await this.vl.request<{ id: string | number }[]>('GET', `${VL.paths.cards}?cardHolder=${encodeURIComponent(cardHolder)}&startTime=${from}&expireTime=${expireLocal}`, undefined, HIGH);
    let best: { id: string; created: string } | null = null;
    for (const c of list ?? []) {
      const d = await this.vl.request<any>('GET', VL.paths.card(String(c.id)), undefined, HIGH);
      if (d?.cancelled === true || (d?.cardHolder && d.cardHolder !== cardHolder)) continue;
      const created = String(d?.created ?? '');
      if (!best || created > best.created) best = { id: String(d?.id ?? c.id), created };
    }
    return best?.id ?? null;
  }

  private async onlyValidCard(cardHolder: string): Promise<string> {
    const d = new Date();
    const list = await withTimeForms('cards.validTime', [toVisionlineLocal(d, this.timeZone()), ...utcForms(d)],
      (t) => this.vl.request<{ id: string | number }[]>('GET', `${VL.paths.cards}?cardHolder=${encodeURIComponent(cardHolder)}&validTime=${t}`, undefined, HIGH));
    if (!list?.length) throw new VisionlineApiError(404, 40411, `Visionline has no valid card for ${cardHolder}`);
    if (list.length > 1) throw new VisionlineApiError(409, undefined, `${cardHolder} has ${list.length} valid cards in Visionline; cannot tell which one is the mobile key. Use check-out instead.`);
    return String(list[0]!.id);
  }

  /** Event codes the watch asks for: refused doors, battery events and the platform's extra codes (entrances). */
  static watchCodes(extra: number[] = []) {
    return [...new Set<number>([...VL.denialEventCodes, ...VL.batteryEventCodes, ...extra])].sort((a, b) => a - b);
  }

  async registerWatch(extra: number[] = []) {
    const r = await this.vl.request<{ id: string }>('POST', VL.paths.callback, {
      resources: {
        cards: { fields: [...VL.callbackCardFields] },
        // Refused doors (wrong-door counting), battery alarms (Phase 2) and door entrances (2.6 event log) [§7.14.1].
        events: { eventCode: WebApiAdapter.watchCodes(extra), fields: [...VL.callbackEventFields] },
      },
    });
    if (!r?.id) throw new VisionlineApiError(500, undefined, 'Visionline did not return a callback id');
    return String(r.id);
  }

  async deleteWatch(id: string) {
    await this.vl.request('DELETE', VL.paths.callbackById(id));
  }

  async pollWatch(id: string) {
    const r = await this.vl.request<any>('GET', VL.paths.callbackById(id), undefined, { timeoutMs: VL.callbackLongPollMs + 60_000 });
    return { cards: r?.resources?.cards ?? [], events: r?.resources?.events ?? [] };
  }

  async cancelledSince(since: Date) {
    const list = await withTimeForms('cards.cancelTimeSince', [toVisionlineLocal(since, this.timeZone()), ...utcForms(since)],
      (t) => this.vl.request<{ id: string }[]>('GET', `${VL.paths.cards}?cancelTimeSince=${t}`));
    const out: any[] = [];
    for (const c of list ?? []) {
      try {
        const d = await this.vl.request<any>('GET', VL.paths.card(String(c.id)));
        out.push({ registrationNumber: String(d.id ?? c.id), cancelled: d.cancelled === true, status: d.cancelled === true ? VL.cardStatus.cancelled : undefined, cardHolder: d.cardHolder, expireTime: d.expireTime });
      } catch { out.push({ registrationNumber: String(c.id), cancelled: true, status: VL.cardStatus.cancelled }); }
    }
    return out;
  }
}

/** Maps Visionline error codes [§4.4.1] to actionable platform codes (shared/status.ts ERROR_HELP). */
export function toErrorInfo(e: unknown): ErrorInfo {
  if (!(e instanceof VisionlineApiError)) return { code: 'CONNECTOR_ERROR', message: (e as Error)?.message ?? String(e), retryable: false };
  const E = VL.errors;
  const map: Record<number, [string, boolean]> = {
    [E.badCredentials]: ['VISIONLINE_AUTH_FAILED', false],
    [E.clockSkew]: ['VISIONLINE_CLOCK_SKEW', true],
    [E.doorNotFound]: ['UNKNOWN_DOOR', false],
    [E.endpointNotFound]: ['ENDPOINT_NOT_ACTIVE', false],
    [E.validStaffCardExists]: ['VALID_STAFF_CARD_EXISTS', false],
    [E.maxStaffCards]: ['VALID_STAFF_CARD_EXISTS', false],
    [E.validityTooLong]: ['VALIDITY_TOO_LONG', false],
    [E.mobileTlcodeNotLicensed]: ['MOBILE_OPTION_NOT_LICENSED', false],
    [E.userGroupNotFound]: ['CARD_HOLDER_INVALID', false],
    [E.cardHolderNotFound]: ['CARD_HOLDER_INVALID', false],
    [E.unavailable]: ['VISIONLINE_UNREACHABLE', true],
    40411: ['CARD_NOT_FOUND', false],
  };
  const m = e.code !== undefined ? map[e.code] : undefined;
  // 2.26 Visionline's own detail (which parameter or property) is part of the message: it tells the hotel what to fix.
  const msg = e.developerMessage && !e.message.includes(e.developerMessage) ? `${e.message} (${e.developerMessage})` : e.message;
  if (m) return { code: m[0], message: msg, retryable: m[1], vendorStatus: e.status, vendorCode: String(e.code) };
  if (e.status === 0) return { code: e.message.includes('credentials are not configured') ? 'NOT_CONFIGURED' : 'VISIONLINE_UNREACHABLE', message: e.message, retryable: true };
  return { code: 'VISIONLINE_REJECTED', message: msg, retryable: e.status >= 500, vendorStatus: e.status, vendorCode: e.code !== undefined ? String(e.code) : undefined };
}
