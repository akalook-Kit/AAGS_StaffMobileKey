import { SIM_URL } from '../config';
import type { MobileAccess } from './types';

/** Development stand-in for the ASSA ABLOY SDK, backed by the local simulator. */
export const simulatedMobileAccess: MobileAccess = {
  mode: 'simulated',
  async personalize(invitationCode, deviceModel) {
    const r = await fetch(`${SIM_URL}/sdk/personalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invitationCode, deviceModel }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? 'Phone set-up failed');
  },
  async listKeys(endpointId) {
    const r = await fetch(`${SIM_URL}/sdk/endpoints/${encodeURIComponent(endpointId)}/keys`);
    return r.ok ? r.json() : [];
  },
  async readiness() {
    return { bluetooth: 'on', ready: true, note: 'Simulated lock: choose the door you are standing at.' };
  },
  async openDoor(endpointId, doorId) {
    const r = await fetch(`${SIM_URL}/sdk/endpoints/${encodeURIComponent(endpointId)}/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doorId }) });
    const j = await r.json();
    return { result: j.result ?? 'DENIED', reason: j.reason ?? 'Lock did not respond', door: j.doorName ?? doorId ?? '' };
  },
};
