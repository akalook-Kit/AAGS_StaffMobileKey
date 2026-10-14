/**
 * The only door into the vendor mobile-access component (spec §13.7). Credentials stay inside the
 * ASSA ABLOY SDK and OS secure storage; this app never decodes, exports or copies them.
 */
export interface DoorAttempt { result: 'OPENED' | 'DENIED'; reason: string; door: string }
export interface SdkKey { credentialId: string; validUntil: string; label?: string }

export interface MobileAccess {
  readonly mode: 'simulated' | 'assaabloy';
  /** Apply the Credential Services invitation code: personalizes this phone as an endpoint [CS §6]. */
  personalize(invitationCode: string, deviceModel: string): Promise<void>;
  /** Keys currently held in the secure component. */
  listKeys(endpointId: string): Promise<SdkKey[]>;
  /** Bluetooth / readiness state shown to the user. */
  readiness(): Promise<{ bluetooth: 'on' | 'off' | 'unknown'; ready: boolean; note?: string }>;
  /**
   * Real SDK: starts BLE so the lock reads the key when the phone is held near it (no door choice).
   * Simulator: there is no radio, so the user picks the door to emulate holding the phone to it.
   */
  openDoor(endpointId: string, doorId?: string): Promise<DoorAttempt>;
}
