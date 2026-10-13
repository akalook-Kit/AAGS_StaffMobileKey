import { z } from 'zod';

/**
 * Cloud ⇄ connector command contract, version 2.
 * Every command has a unique id, an idempotency key, an expiry and a correlation id (spec §4.3).
 * Payloads never contain readable Visionline secrets. Passwords entered in the portal travel as
 * SealedSecret blobs encrypted in the browser with the connector's public key; only the connector can open them.
 */
export const CONTRACT_VERSION = 'smk.connector.v2';

/** Hybrid encryption: random AES-256-GCM key wrapped with the connector's RSA-OAEP-SHA256 public key. */
export const SealedSecret = z.object({
  v: z.literal(1),
  alg: z.literal('RSA-OAEP-256+A256GCM'),
  keyId: z.string().min(8),
  ek: z.string().min(16), // base64 wrapped AES key
  iv: z.string().min(8), // base64 12-byte IV
  ct: z.string().min(8), // base64 ciphertext + 16-byte GCM tag (WebCrypto layout)
});
export type SealedSecret = z.infer<typeof SealedSecret>;
/** What is inside a SealedSecret. Bound to its purpose, hotel and operator so a blob cannot be reused elsewhere. */
export interface SealedCredentialPlain {
  purpose: 'property' | 'operator';
  hotelId: string;
  operatorId?: string;
  username: string;
  password: string;
  accessId?: string;
  ts: string;
}
export const OperatorCredential = z.object({ operatorId: z.string().uuid(), username: z.string().min(1), sealed: SealedSecret });

export const DoorOperationSchema = z.object({
  doors: z.array(z.string().min(1)).min(1),
  operation: z.literal('normal'),
});

export const IssueStaffKeyPayload = z.object({
  keyRequestId: z.string().uuid(),
  /** Visionline user id used as cardHolder [Web API §7.5.6]; created with PUT /users/{id} if missing [§5.31]. */
  cardHolder: z.string().min(1).max(100),
  user: z.object({ givenName: z.string(), surname: z.string(), userGroup: z.string().min(1) }),
  endpointId: z.string().regex(/^[A-Za-z0-9_-]{1,50}$/),
  /** Visionline door ids, already resolved and policy-checked by the cloud (operation normal). */
  doorIds: z.array(z.string().min(1)).min(1),
  timeSchedule: z.string().optional(),
  /** UTC; converted to hotel local time by the connector. */
  expireTime: z.string().datetime(),
  /** Sent only when the hotel enables future start times; otherwise Visionline starts the key now [§7.5.2, §7.6.2]. */
  startTime: z.string().datetime().optional(),
  accountName: z.string().optional(),
  label: z.string().max(32).optional(),
  /** Card holder's user group has uniform access: Visionline applies the group's doors, so doorOperations is omitted [§5.29.3]. */
  useUserGroupDoors: z.boolean().optional(),
  /** Replace the holder's current staff key; Visionline cancels the previous staff card(s) [§4.4.1 40902]. */
  override: z.boolean().optional(),
  /** Issue under the requesting operator's personal Visionline identity instead of the property operator. */
  operatorCredential: OperatorCredential.optional(),
});
export type IssueStaffKeyPayload = z.infer<typeof IssueStaffKeyPayload>;

export const RevokeStaffKeyPayload = z.object({
  keyRequestId: z.string().uuid(),
  credentialId: z.string().min(1),
  cardHolder: z.string().min(1),
  /** Doors in the key's resolved scope; checkout is sent per door [Web API §7.13.5]. */
  doorIds: z.array(z.string().min(1)).min(1),
  /** Visionline card registration number (card id, §5.10.2) of this key, when known. Not the credentialID. */
  cardRegNo: z.string().min(1).optional(),
  /** checkout = per-door checkout with credentialID [§7.13.5] (default); cancelCard = cancel the card by its reg. no. [§7.7.4]. */
  method: z.enum(['checkout', 'cancelCard']).optional(),
  operatorCredential: OperatorCredential.optional(),
});
export type RevokeStaffKeyPayload = z.infer<typeof RevokeStaffKeyPayload>;

/** Visionline documents GET /userGroups/{id} but no collection [Web API §5.29], so the cloud names the groups to probe. */
export const DiscoverResourcesPayload = z.object({ userGroups: z.array(z.string()).default([]) });
export const ValidateSetupPayload = z.object({});
/** Property Visionline operator entered in the portal (sealed); the connector stores it in its own secret store. */
export const SetPropertyCredentialsPayload = z.object({ username: z.string().min(1), sealed: SealedSecret });
/** Check an operator's personal Visionline credentials by opening (and closing) a session. */
export const VerifyOperatorCredentialsPayload = OperatorCredential;
/** Create a user group in Visionline [§5.29 PUT /userGroups/{id}]. */
export const CreateUserGroupPayload = z.object({ userGroup: z.string().min(1).max(60), uniformAccess: z.boolean().default(false) });

export const CommandType = z.enum(['ISSUE_STAFF_KEY', 'REVOKE_STAFF_KEY', 'DISCOVER_RESOURCES', 'VALIDATE_SETUP', 'SET_PROPERTY_CREDENTIALS', 'VERIFY_OPERATOR_CREDENTIALS', 'CREATE_USER_GROUP']);
export type CommandType = z.infer<typeof CommandType>;

export const PAYLOAD_SCHEMAS = {
  ISSUE_STAFF_KEY: IssueStaffKeyPayload,
  REVOKE_STAFF_KEY: RevokeStaffKeyPayload,
  DISCOVER_RESOURCES: DiscoverResourcesPayload,
  VALIDATE_SETUP: ValidateSetupPayload,
  SET_PROPERTY_CREDENTIALS: SetPropertyCredentialsPayload,
  VERIFY_OPERATOR_CREDENTIALS: VerifyOperatorCredentialsPayload,
  CREATE_USER_GROUP: CreateUserGroupPayload,
} as const;

export const CommandEnvelope = z.object({
  id: z.string().uuid(),
  hotelId: z.string().uuid(),
  type: CommandType,
  payload: z.unknown(),
  idempotencyKey: z.string().min(1),
  correlationId: z.string().min(1),
  expiresAt: z.string(),
  attempt: z.number().int(),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;

export const ErrorInfo = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().default(false),
  vendorStatus: z.number().optional(),
  vendorCode: z.string().optional(),
});
export type ErrorInfo = z.infer<typeof ErrorInfo>;

export const CommandResult = z.object({
  status: z.enum(['SUCCEEDED', 'FAILED']),
  result: z.record(z.string(), z.unknown()).optional(),
  error: ErrorInfo.optional(),
});
export type CommandResult = z.infer<typeof CommandResult>;

/**
 * Visionline changes the connector forwards from /callback [Web API §7.14] or its catch-up query
 * (GET /cards?cancelTimeSince [§5.9.3]). Times are Visionline local time strings, passed through as is.
 */
export const VisionlineCardChange = z.object({
  registrationNumber: z.union([z.string(), z.number()]).transform(String),
  status: z.number().int().optional(),
  cancelled: z.boolean().optional(),
  cancelTime: z.string().optional(),
  cardHolder: z.string().optional(),
  expireTime: z.string().optional(),
});
export const VisionlineLockEvent = z.object({
  doorID: z.union([z.string(), z.number()]).transform(String).optional(),
  registrationNumber: z.union([z.string(), z.number()]).transform(String).optional(),
  eventCode: z.coerce.number().int(),
  eventTime: z.string().optional(),
  repeatFlags: z.coerce.number().int().optional(),
});
export const VisionlineEventsBatch = z.object({
  batchId: z.string().min(8),
  source: z.enum(['callback', 'catchup']),
  cards: z.array(VisionlineCardChange).max(1000).default([]),
  events: z.array(VisionlineLockEvent).max(1000).default([]),
});
export type VisionlineEventsBatch = z.infer<typeof VisionlineEventsBatch>;

export const DiscoveredResource = z.object({
  kind: z.enum(['door', 'doorgroup', 'usergroup', 'timeschedule', 'mobileaccessaccount']),
  externalId: z.string(),
  name: z.string(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type DiscoveredResource = z.infer<typeof DiscoveredResource>;

export const ConnectorHealth = z.object({
  connectorVersion: z.string(),
  contractVersion: z.string(),
  status: z.enum(['OK', 'DEGRADED', 'ERROR']),
  adapter: z.string(),
  credentialsConfigured: z.boolean(),
  visionlineReachable: z.boolean(),
  visionlineApiVersion: z.string().nullable(),
  tlsTrust: z.string(),
  lastSuccessfulSessionAt: z.string().nullable(),
  lastError: z.string().nullable(),
  queueDepth: z.number(),
  inFlight: z.number(),
  clockOffsetMs: z.number(),
  callbackHealth: z.string(),
  uptimeSec: z.number(),
  /** Non-secret: the property operator name in use, and the connector's sealing-key id. */
  propertyUsername: z.string().nullable().optional(),
  visionlineBaseUrl: z.string().optional(),
  sealKeyId: z.string().optional(),
  /** Visionline /callback watch for cancelled cards and refused doors. */
  visionlineWatch: z.string().optional(),
  /** Connector refuses commands that change Visionline (testing against a live system). */
  readOnly: z.boolean().optional(),
  /** What this connector can do beyond Phase 1, e.g. "battery-events" (battery alarms in its Visionline watch). */
  capabilities: z.array(z.string()).optional(),
});
export type ConnectorHealth = z.infer<typeof ConnectorHealth>;
