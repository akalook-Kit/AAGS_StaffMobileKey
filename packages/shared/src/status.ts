/** Key-request lifecycle shown in portal and app. Mirrors Credential Services states (spec §12.3.8). */
export const KEY_STATUSES = [
  'PENDING_APPROVAL', // broad scope awaiting a second person
  'REJECTED',
  'SCHEDULED', // approved, held until its start time (staff keys cannot start in the future, Web API §7.6.2)
  'QUEUED', // command waiting for the hotel connector
  'ISSUING', // Visionline accepted; Credential Services delivering to the phone
  'ISSUED', // credential delivered to the endpoint
  'FAILED',
  'REVOKING',
  'REVOKED',
  'EXPIRED',
] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];

export const KEY_STATUS_LABEL: Record<KeyStatus, string> = {
  PENDING_APPROVAL: 'Awaiting approval',
  REJECTED: 'Rejected',
  SCHEDULED: 'Scheduled',
  QUEUED: 'Waiting for hotel connector',
  ISSUING: 'Delivering to phone',
  ISSUED: 'Active',
  FAILED: 'Failed',
  REVOKING: 'Revoking',
  REVOKED: 'Revoked',
  EXPIRED: 'Expired',
};

export const ENDPOINT_STATUSES = ['INVITED', 'ACTIVE', 'DELETED', 'FAILED'] as const;
export type EndpointStatus = (typeof ENDPOINT_STATUSES)[number];

/** Actionable messages for known error codes (spec §3: "actionable error messages"). */
export const ERROR_HELP: Record<string, string> = {
  CONNECTOR_OFFLINE: 'The hotel connector has not checked in. Check that the Visionline PC is on and the connector service is running.',
  COMMAND_EXPIRED: 'The request expired before the hotel connector could process it. Check connector health, then issue again.',
  VISIONLINE_AUTH_FAILED: 'Visionline rejected the operator login. Re-enter the operator credentials on the connector setup page.',
  VISIONLINE_UNREACHABLE: 'The connector cannot reach the Visionline Web API. Check the Visionline service and certificate trust.',
  VISIONLINE_CLOCK_SKEW: 'The connector clock differs from Visionline by more than 15 minutes. Synchronise Windows time.',
  VISIONLINE_REJECTED: 'Visionline rejected the request. See the vendor code for details.',
  UNKNOWN_DOOR: 'One or more doors are not known in Visionline. Run resource discovery and select doors again.',
  ENDPOINT_NOT_ACTIVE: 'The staff member’s phone is not an active mobile-key endpoint yet. Ask them to finish onboarding in the app.',
  UNCERTAIN_OUTCOME: 'The connector restarted during a Visionline call, so the result is unknown. It was not retried automatically. Check Visionline, then reconcile or issue again.',
  CREDENTIAL_DELIVERY_FAILED: 'Credential Services could not deliver the key to the phone. Ask the staff member to open the app with internet on, then retry.',
  VALID_STAFF_CARD_EXISTS: 'Visionline already holds a valid staff key for this person (40902). Revoke the current key, then issue again.',
  VALIDITY_TOO_LONG: 'Visionline refused the validity period as longer than allowed (40308). Shorten the key validity.',
  MOBILE_OPTION_NOT_LICENSED: 'Visionline mobile access (TLCode) option is not enabled (40328). Contact ASSA ABLOY.',
  CARD_HOLDER_INVALID: 'The Visionline user or user group for this staff member is missing. Check the staff record and the Visionline staff user group.',
  NOT_CONFIGURED: 'The connector is missing Visionline settings or credentials. Complete the setup wizard.',
};
