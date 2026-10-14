/**
 * Visionline Web API wire contract — the SINGLE place for vendor-specific names.
 *
 * Source: ASSA ABLOY Global Solutions "Web API", DocNo 61 1100 080, revision 74 (valid from 2022-08-15).
 * Section numbers are given as [§x.y]. Items the document leaves open for STAFF mobile keys are listed
 * in VENDOR_CONFIRMATION_REQUIRED and are surfaced in the portal readiness checklist.
 */
export const VL_DOC = 'ASSA ABLOY Web API 61 1100 080 rev 74';

/** Battery-related lock events [§7.14.1 event table], by meaning. */
const BATTERY_EVENTS = {
  /** 304 battery level low, 306 IR battery low, 529 battery alarm in lock, 533 backup battery low. */
  low: [304, 306, 529, 533],
  /** 305 critically low, 307 IR critical, 530/532 status changed to Access Denied, 531 IR alarm,
   *  534 backup critical, 53 access denied due to battery alarm. */
  critical: [53, 305, 307, 530, 531, 532, 534],
  /** 528 battery exchanged, 535 IR battery exchanged, 536 backup battery exchanged. */
  exchanged: [528, 535, 536],
  /** 1056–1071 "below 6.0 … 9.0 volts", 1072–1081 "below 3.0 … 4.8 volts" (0.2 V steps). */
  voltageFrom: 1056, voltageTo: 1081,
} as const;

/** Volts in a "Battery level below X volts" event, or null for other codes [§7.14.1]. */
export function batteryVoltsBelow(code: number): number | null {
  if (code >= 1056 && code <= 1071) return Math.round((6.0 + 0.2 * (code - 1056)) * 10) / 10;
  if (code >= 1072 && code <= 1081) return Math.round((3.0 + 0.2 * (code - 1072)) * 10) / 10;
  return null;
}

export const VL = {
  /** Per-hotel configuration value, never a global constant (spec §12.1.1). Version id is v1 [§4.2]. */
  defaultBaseUrl: 'https://127.0.0.1/api/v1',
  paths: {
    sessions: '/sessions', // [§5.24] POST, unsigned
    session: (id: string) => `/sessions/${encodeURIComponent(id)}`, // [§5.25] DELETE
    resources: '/resources', // [§5.22] GET (details=true)
    doors: '/doors', // [§5.12] GET (?doorGroup=, ?details=true)
    door: (id: string) => `/doors/${encodeURIComponent(id)}`, // [§5.13] POST commands (checkout)
    userGroup: (id: string) => `/userGroups/${encodeURIComponent(id)}`, // [§5.29] no collection GET is documented
    users: '/users', // [§5.30] GET (?userGroup=)
    user: (id: string) => `/users/${encodeURIComponent(id)}`, // [§5.31] GET, PUT create, POST modify
    timeSchedules: '/timeSchedules', // [§5.26]
    mobileAccessAccounts: '/mobileaccess', // [§5.16] credential services accounts (name, description, systemID)
    cards: '/cards', // [§5.9]
    card: (id: string) => `/cards/${encodeURIComponent(id)}`, // [§5.10]
    callback: '/callback', // [§5.7]
    callbackById: (id: string) => `/callback/${encodeURIComponent(id)}`, // [§5.8] long-poll GET, DELETE
  },
  query: {
    action: 'action',
    mobileAccess: 'mobileAccess', // [§5.9.4, §7.5.1]
    returnCredential: 'returnCredential', // [§7.5.7] NOT used in Phase 1 (spec §12.5)
    override: 'override',
  },
  fields: {
    // session [§5.24.2]
    username: 'username', password: 'password', encoder: 'encoder',
    accessId: 'accessID', clientUuid: 'uuid',
    sessionId: 'id', accessKey: 'accessKey', webClientId: 'webClientID',
    // staff mobile key [§7.5.2, §7.5.6]
    cardHolder: 'cardHolder', format: 'format', formatTLCode: 'TLCode',
    endpointId: 'endPointID', expireTime: 'expireTime', startTime: 'startTime',
    doorOperations: 'doorOperations', operation: 'operation', operationNormal: 'normal',
    doors: 'doors', doorGroups: 'doorGroups', accountName: 'accountName', timeSchedule: 'timeSchedule',
    label: 'label', description: 'description',
    credentialId: 'credentialID', // response of mobile key creation; a number [§7.5.6]
    // revocation via checkout [§5.13.4, §7.13.5]
    checkedOut: 'checkedOut',
    // users [§5.31.2]
    surname: 'surname', givenName: 'givenName', userGroup: 'userGroup',
  },
  contentType: 'application/json; charset=utf-8', // [§4.3, §6.1]
  auth: {
    scheme: 'AWS', // "AWS sessionId:signature" [§4.5]
    dateHeader: 'x-aah-date', // takes precedence over Date; the only canonicalized header [§4.5.5]
  },
  maxClockSkewMs: 15 * 60 * 1000, // [§4.5.7]
  defaultSessionTtlMs: 30 * 60 * 1000, // [§4.6] Tomcat default
  errors: {
    invalidDate: 40001,
    missingProperty: 40006,
    illegalOperation: 40011,
    expireInPast: 40048,
    endpointNotFound: 40052,
    clockSkew: 40101,
    badCredentials: 40102,
    sessionNotFound: 40103, // also used for an expired session [§4.6]
    badSignature: 40104,
    badContentMd5: 40105,
    malformedAuthorization: 40106,
    notAuthorized: 40107,
    validityTooLong: 40308,
    mobileTlcodeNotLicensed: 40328,
    doorNotFound: 40406,
    userGroupNotFound: 40404,
    cardHolderNotFound: 40405,
    resourceNotFound: 40401,
    validStaffCardExists: 40902,
    maxStaffCards: 40904,
    unavailable: 50301,
  },
  /** Visionline exchanges local hotel time without zone designator [§4.3.2], minutes precision in examples. */
  timeFormat: 'YYYYMMDDTHHmm',
  batteryEvents: BATTERY_EVENTS,
  /** Every battery event code, for the /callback events filter [§7.14]. */
  batteryEventCodes: [...BATTERY_EVENTS.low, ...BATTERY_EVENTS.critical, ...BATTERY_EVENTS.exchanged,
    ...Array.from({ length: BATTERY_EVENTS.voltageTo - BATTERY_EVENTS.voltageFrom + 1 }, (_, i) => BATTERY_EVENTS.voltageFrom + i)],
  callbackRecordTtlMs: 12 * 60 * 60 * 1000, // [§7.16]
  /** GET /callback/{id} hangs for up to 4 minutes when the queue is empty [§7.16]. */
  callbackLongPollMs: 4 * 60 * 1000,
  /** Lock events where a card was refused [§7.14.1 event table]. The platform decides which count as "wrong door". */
  denialEventCodes: [320, 322, 323, 325, 327, 368, 369],
  /** 320 "No access to this room", 323 "Card can only access Common rooms": door not on the key. */
  wrongDoorEventCodes: [320, 323],
  /** Card status in /callback cards [§7.14.2]. */
  cardStatus: { cancelled: 0, valid: 1, overridden: 2, notIssued: 3, expired: 4, overwritten: 5, discarded: 6 },
  callbackCardFields: ['registrationNumber', 'status', 'cancelTime', 'cardHolder', 'expireTime'],
  callbackEventFields: ['doorID', 'registrationNumber', 'eventTime', 'eventCode', 'repeatFlags'],
} as const;

/** Error object returned with 4xx/5xx [§4.4]. Unknown properties must be ignored [§4.7]. */
export interface VisionlineError { status?: number; code?: number; message?: string; developerMessage?: string; resource?: string; properties?: string[] }

/**
 * Behaviour the document does not settle for STAFF mobile keys. Each needs written ASSA ABLOY
 * confirmation for the installed K Hotel Bana version before production (spec §9 step 4 "Validate").
 */
export const VENDOR_CONFIRMATION_REQUIRED = [
  {
    id: 'staff-start-time',
    question: 'May a staff mobile key be created with a future startTime in K Hotel Bana\'s Visionline version?',
    documented: 'For staff cards startTime "should not be in the future" [§7.6.2]; for mobile keys startTime defaults to the current time [§7.5.2].',
    decided: 'Answer received 13 Oct: the API has startTime, but staff keys are expected to start immediately; treat future start as not supported unless validated on the installed build.',
    implemented: 'Start and end are set per key; the platform holds a future key and creates it at its start time (default). "Send future start time" stays available for a validation test only.',
  },
  {
    id: 'cs-tenant',
    question: 'Credential Services password for the K Hotel Bana account, and the mobile SDK configuration for UUID 9.',
    documented: 'Base URL is not in AAH Credential Services API V2.5.1; the account is set in Visionline Options → Mobile Access.',
    decided: 'Received 13 Oct: URL https://hospitality.credential-services.api.assaabloy.com, user k_-_hotel_bana-…, System ID 3460, account hma-cs-92a0dc3e-…, UUID 9. The password is entered only into the platform secret store.',
    implemented: 'System ID 3460 and the account name are configured and checked against Visionline. Run scripts/windows/cs-check.ps1 to test the user and password read-only. The SDK setup arrives with the licensed ASSA ABLOY mobile SDK.',
  },
] as const;

/** Points the hotel or ASSA ABLOY have settled; shown in the portal for reference. */
export const VENDOR_DECISIONS = [
  { id: 'staff-revocation', decision: 'Cancelling or checking out a mobile staff key in Visionline revokes it from the phone through Credential Services (answer received 13 Oct). The platform also revokes it in the app as soon as the connector reports the cancellation.' },
  { id: 'wrong-doors', decision: 'More than 5 wrong-door attempts (events 320/323) cancel the card automatically (hotel, 13 Oct).' },
  { id: 'staff-time-schedule', decision: 'timeSchedule is honoured on staff mobile keys (answer received 13 Oct); used only when the access template sets one (hotel).' },
  { id: 'reg-number', decision: 'credentialID is NOT the card registration number (answer received 13 Oct). The connector looks up the reg. no. with GET /cards?cardHolder=… after creating the key; callbacks, lock events and card cancel use it; check-out uses the credentialID.' },
  { id: 'operator-card', decision: 'The Web API client is set to "Ignore operator card" (hotel, 13 Oct).' },
  { id: 'one-staff-card', decision: 'One live key per person; Change doors uses override=true and gets a new reg. no. (hotel, 13 Oct).' },
  { id: 'mobile-access-uuid', decision: 'Mobile Access UUID 9 identifies the SEOS channel used to issue keys (hotel, 12–13 Oct).' },
] as const;
