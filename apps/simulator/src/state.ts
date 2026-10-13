import { randomBytes, randomUUID } from 'node:crypto';
import type { CsCredentialStatus } from '@smk/shared';

export interface Door { id: string; doorID: number; doorName: string; doorGroup: string; doorGroupID: number; doorCategory: string; online: boolean; battery: 'GOOD' | 'LOW' | 'CRITICAL' | null }
export interface Session { id: string; accessKey: string; username: string; webClientID?: number; expiresAt: number; ttlMs: number }
export interface Card {
  cardId: string; credentialID: number; cardHolder: string; issuedBy: string; endpointId: string; doors: string[];
  startTime: number; expireTime: number; status: CsCredentialStatus; cancelled: boolean;
  checkedOut: Set<string>; createdAt: number; accountName: string; timeSchedule?: string; label: string;
  usedAt: Set<string>;
  /** Visionline card status [Web API §7.14.2]: 0 cancelled, 1 valid, 2 overridden, 4 expired. */
  vlStatus?: number; cancelTime?: number;
}
export interface VlCallback { id: string; eventCodes: number[] | null; wantCards: boolean; wantEvents: boolean; cards: any[]; events: any[]; waiters: (() => void)[]; lastPoll: number }
export type EndpointStatus = 'INVITATION_PENDING' | 'INVITATION_INVALID' | 'ACKNOWLEDGED' | 'ACTIVATING' | 'ACTIVATION_FAILURE' | 'ACTIVE' | 'TERMINATED';
export interface Endpoint { endpointId: string; endpointStatus: EndpointStatus; invitationCode?: string; invitationExpiresAt?: number; deviceModel?: string; activatedAt?: number }
export interface LockEvent { at: string; doorId: string; doorName: string; endpointId: string; credentialID?: number; result: 'OPENED' | 'DENIED'; reason: string }
export interface VlUser { id: string; surname?: string; givenName?: string; userGroup: string; email?: string }
export interface CsCallbackReg { type: 'ENDPOINT' | 'CREDENTIAL' | 'READBACK'; url: string; username?: string; password?: string }

const rooms = (floor: number) => Array.from({ length: 10 }, (_, i): Door => {
  const n = `${floor}${String(i + 1).padStart(2, '0')}`;
  return { id: n, doorID: Number(n), doorName: n, doorGroup: `Floor ${floor}`, doorGroupID: floor, doorCategory: 'guest', online: true, battery: i === 3 ? 'LOW' : 'GOOD' };
});

export const KHB_ACCOUNT = 'hma-cs-92a0dc3e-6379-4b84-999c-aedb582c1b63';

/** Seed resembling a small hotel. In production all of this comes from the hotel's Visionline database. */
export function createState() {
  const doors: Door[] = [
    ...rooms(1), ...rooms(2), ...rooms(3),
    { id: 'Main Entrance', doorID: 900, doorName: 'Main Entrance', doorGroup: 'Common Areas', doorGroupID: 9, doorCategory: 'entrance', online: true, battery: 'GOOD' },
    { id: 'Staff Entrance', doorID: 901, doorName: 'Staff Entrance', doorGroup: 'Common Areas', doorGroupID: 9, doorCategory: 'entrance', online: true, battery: 'GOOD' },
    { id: 'Gym', doorID: 902, doorName: 'Gym', doorGroup: 'Common Areas', doorGroupID: 9, doorCategory: 'common', online: false, battery: null },
    { id: 'Linen Store', doorID: 950, doorName: 'Linen Store', doorGroup: 'Back of House', doorGroupID: 10, doorCategory: 'common', online: true, battery: 'CRITICAL' },
    { id: 'GM Office', doorID: 951, doorName: 'GM Office', doorGroup: 'Back of House', doorGroupID: 10, doorCategory: 'common', online: true, battery: 'GOOD' },
  ];
  const op = (ds: string[]) => [{ operation: 'normal', doors: ds, doorGroups: [] as string[] }];
  return {
    doors,
    userGroups: new Map<string, { id: string; uniformAccess: boolean; doorOperations: ReturnType<typeof op>; timeSchedule?: string }>([
      ['Housekeeping', { id: 'Housekeeping', uniformAccess: false, doorOperations: op(['Staff Entrance', 'Linen Store']) }],
      ['Maintenance', { id: 'Maintenance', uniformAccess: false, doorOperations: op(['Staff Entrance', 'Linen Store', 'Gym']) }],
      ['Management', { id: 'Management', uniformAccess: false, doorOperations: op(['Staff Entrance', 'GM Office']) }],
      // Uniform access: Visionline forces these doors on every card of the group [Web API §5.29.3].
      ['Security', { id: 'Security', uniformAccess: true, doorOperations: op(['Main Entrance', 'Staff Entrance', 'Linen Store', 'GM Office']) }],
      ['Front Office', { id: 'Front Office', uniformAccess: false, doorOperations: op(['Main Entrance']) }],
    ]),
    timeSchedules: [{ id: 'Card always', timeSchedule: 'Card always', description: 'No restriction' }, { id: 'Day shift', timeSchedule: 'Day shift', description: '06:00–18:00 every day' }],
    // Mirrors K Hotel Bana's real Mobile Access account in Visionline (name and System ID; no secrets).
    mobileAccessAccounts: [{ id: KHB_ACCOUNT, name: KHB_ACCOUNT, description: 'K Hotel Bana (simulated copy of the Visionline Mobile Access account)', systemID: 3460, default: true }],
    users: new Map<string, VlUser>(),
    sessions: new Map<string, Session>(),
    cards: new Map<number, Card>(),
    nextCredentialId: 1000170,
    nextCardId: 135790,
    endpoints: new Map<string, Endpoint>(),
    csCallbacks: [] as CsCallbackReg[],
    events: [] as LockEvent[],
    /** Visionline /callback registrations [Web API §7.14–7.16]. */
    vlCallbacks: new Map<string, VlCallback>(),
    /** Visionline Options → Mobile Access (UUID, revoke mode). */
    mobileAccessOptions: { uuid: 9, revokeWhen: 'overridden' as 'overridden' | 'expired' },
    faults: { visionlineDown: false, failNextCard: null as number | null, deliveryDelayMs: 1500, clockOffsetSec: 0, sessionTtlSec: 1800, enforceOneStaffCard: true },
    stats: { sessionsCreated: 0, signedRequests: 0, rejectedSignatures: 0, cardsCreated: 0, callbacksSent: 0 },
  };
}
export type SimState = ReturnType<typeof createState>;

/** Queue a Visionline card change or lock event for every registered callback that wants it. */
export function vlPublish(st: SimState, kind: 'cards' | 'events', rec: Record<string, unknown>) {
  for (const cb of st.vlCallbacks.values()) {
    if (kind === 'cards' && !cb.wantCards) continue;
    if (kind === 'events' && (!cb.wantEvents || (cb.eventCodes && !cb.eventCodes.includes(Number(rec.eventCode))))) continue;
    cb[kind].push(rec);
    for (const w of cb.waiters.splice(0)) w();
  }
}

export const newId = () => randomUUID().replace(/-/g, '');
export const newSecret = () => randomBytes(16).toString('hex');
export const invitationCode = () =>
  Array.from(randomBytes(16)).map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('').replace(/(.{4})(?!$)/g, '$1-');

/** Sends Credential Services callbacks to every registered URL of that type [CS §8.1], with Basic auth when set. */
export function makeCallbackSender(st: SimState, log: (m: string) => void) {
  return async function send(type: CsCallbackReg['type'], body: Record<string, unknown>) {
    const json = JSON.stringify(body);
    for (const reg of st.csCallbacks.filter((c) => c.type === type)) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (reg.username) headers.authorization = 'Basic ' + Buffer.from(`${reg.username}:${reg.password ?? ''}`).toString('base64');
      for (let attempt = 1; attempt <= 6; attempt++) {
        try {
          const r = await fetch(reg.url, { method: 'POST', headers, body: json });
          st.stats.callbacksSent++;
          if (r.ok) break;
          log(`callback ${type} → HTTP ${r.status}`);
          break; // CS accepts any HTTP response [§8.1]
        } catch (e) {
          log(`callback ${type} failed (${(e as Error).message}); retrying`);
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }
  };
}
export { randomUUID };
