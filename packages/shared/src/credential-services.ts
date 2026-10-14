/**
 * AAH Credential Services API V2.5.1 (23 March 2017) — tenant-level contract used by the cloud backend.
 * Basic authentication [§3]; vendor media type [§4.2]; error object {code, message|messages} [§4.3.2].
 */
export const CS_DOC = 'AAH Credential Services API V2.5.1';
export const CS = {
  mediaType: 'application/vnd.assaabloy-com.credential-2.x+json',
  paths: {
    invitation: '/endpoint/invitation', // POST {endpointId} -> 201 {invitationCode, endpointId} [§6.2]
    endpoint: (id: string) => `/endpoint/${encodeURIComponent(id)}`, // GET details, DELETE [§5.3, §5.4]
    credential: (systemId: string | number, id: string) => `/system/${encodeURIComponent(String(systemId))}/credential/${encodeURIComponent(id)}`, // GET [§7.2]
    callback: '/callback', // POST {type,url,username?,password?}, GET list [§8.2, §8.3]
    callbackType: (t: string) => `/callback/${t}`, // DELETE removes ALL of that type [§8.4]
  },
  invitationTtlMs: 10 * 60 * 60 * 1000, // [§6.1]
  errorIdInUse: '10008', // active endpoint already exists [§6.1]
  endpointIdPattern: /^[A-Za-z0-9_-]{1,50}$/, // [§6.2.3] + Visionline 50-char limit (40507)
  callbackTypes: ['ENDPOINT', 'CREDENTIAL', 'READBACK'] as const,
} as const;

export const ENDPOINT_STATUSES_CS = ['INVITATION_PENDING', 'INVITATION_INVALID', 'ACKNOWLEDGED', 'ACTIVATING', 'ACTIVATION_FAILURE', 'ACTIVE', 'TERMINATED', 'TERMINATING_FAILURE'] as const;
export const CREDENTIAL_STATUSES_CS = ['ISSUING', 'ISSUING_FAILURE', 'ISSUED', 'UPDATING', 'UPDATING_FAILURE', 'REVOKING', 'REVOKING_FAILURE', 'REVOKED'] as const;
export type CsCredentialStatus = (typeof CREDENTIAL_STATUSES_CS)[number];

/** Callback bodies [§8.5]. Only the transition to ACTIVE produces an endpoint callback. */
export interface CsEndpointCallback { callbackType: 'endpointStatusChanged'; endpointId: string; endpointStatus: 'ACTIVE' }
export interface CsCredentialCallback {
  callbackType: 'credentialStatusChanged' | 'sessionTransceived';
  systemId: number; endpointId: string; credentialId: string; credentialStatus: CsCredentialStatus;
  label?: string; description?: string; validity?: { startDate?: string; endDate?: string };
}
export type CsCallback = CsEndpointCallback | CsCredentialCallback;
