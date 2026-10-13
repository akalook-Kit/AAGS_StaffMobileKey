import type { MobileAccess } from './types';

/**
 * Placeholder for the licensed ASSA ABLOY Mobile Access SDK (Android + iOS), which is not public.
 * Integration steps once ASSA ABLOY supplies the SDK and licence (spec §13.9):
 *  1. Add the SDK as a native module (Expo config plugin + `npx expo prebuild`; dev build, not Expo Go).
 *  2. Map personalize() to the SDK's invitation/endpoint setup call.
 *  3. Map listKeys() to the SDK key store; openDoor() to its BLE scanning / "open closest lock" API.
 *  4. Surface SDK readiness (Bluetooth, location permission on Android, endpoint health) in readiness().
 * Never log or persist anything the SDK returns about the credential itself.
 *
 * ASSA ABLOY Hospitality app rules (received 13 Oct, docs/MOBILE-ACCESS-SDK.md) — an app that breaks them
 * is not approved:
 *  - Scan for locks only while the app is in the foreground and the user has asked to open a door
 *    (the "Hold your phone near the lock" button). No continuous background scanning, and never with the
 *    screen off: a phone scanning in a pocket could open the door from inside the room.
 *  - The SDK's "seamless" mode may only be switched on for short, controlled windows (for example ~10 s
 *    after a deliberate action), and only in a design ASSA ABLOY has approved.
 *  - Reading distance is set on the lock (Lock Service: -52/-58/-64/-70 dBm ≈ 1/1.5/3/5 m, approximate),
 *    not by the app.
 */
const notAvailable = () => { throw new Error('ASSA ABLOY Mobile Access SDK is not integrated in this build.'); };
export const assaAbloyMobileAccess: MobileAccess = {
  mode: 'assaabloy',
  personalize: async () => notAvailable(),
  listKeys: async () => notAvailable(),
  readiness: async () => ({ bluetooth: 'unknown', ready: false, note: 'Vendor SDK not installed in this build' }),
  openDoor: async () => notAvailable(),
};
