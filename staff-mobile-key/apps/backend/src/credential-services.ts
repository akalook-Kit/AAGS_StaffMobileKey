import { createHmac } from 'node:crypto';
import { CS } from '@smk/shared';
import { config, getSecret } from './config.ts';
import { getConfig } from './hotel-config.ts';
import { pool, one } from './db.ts';
import { ApiError } from './lib/errors.ts';

/**
 * Credential Services adapter (AAH Credential Services API V2.5.1). Tenant-level calls made by the cloud:
 * endpoint invitation, endpoint lookup/deletion, credential lookup, callback registration.
 * Credentials are issued by Visionline (through the hotel connector), never by this service.
 */
export class CsError extends Error {
  constructor(public status: number, public code: string | undefined, message: string) { super(message); }
}

export class CredentialServicesClient {
  constructor(private baseUrl: string, private user: string, private password: string) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: 'Basic ' + Buffer.from(`${this.user}:${this.password}`).toString('base64'),
      accept: CS.mediaType,
    };
    if (body !== undefined) headers['content-type'] = CS.mediaType;
    let r: Response;
    try {
      r = await fetch(this.baseUrl.replace(/\/$/, '') + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw new CsError(0, 'UNREACHABLE', `Credential Services unreachable: ${(e as Error).message}`);
    }
    const text = await r.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return { message: text }; } })() : {};
    if (!r.ok) throw new CsError(r.status, json.code, json.message ?? json.messages?.join('; ') ?? `HTTP ${r.status}`);
    return json as T;
  }

  createInvitation(endpointId: string) {
    return this.req<{ invitationCode: string; endpointId: string }>('POST', CS.paths.invitation, { endpointId });
  }
  getEndpoint(endpointId: string) { return this.req<{ endpointStatus: string; deviceModel?: string; osVersion?: string; bleCapability?: boolean }>('GET', CS.paths.endpoint(endpointId)); }
  deleteEndpoint(endpointId: string) { return this.req<unknown>('DELETE', CS.paths.endpoint(endpointId)); }
  getCredential(systemId: number, credentialId: string) {
    return this.req<{ status: string; endpointId: string; validity?: { startDate?: string; endDate?: string } }>('GET', CS.paths.credential(systemId, credentialId));
  }
  listCallbacks() { return this.req<{ type: string; url: string; username?: string }[]>('GET', CS.paths.callback); }
  registerCallback(type: string, url: string, username: string, password: string) {
    return this.req<unknown>('POST', CS.paths.callback, { type, url, username, password });
  }
}

export async function csForHotel(hotelId: string) {
  const c = await getConfig(pool, hotelId, 'credential_services');
  if (!c) throw new ApiError(503, 'CS_NOT_CONFIGURED', 'Credential Services is not configured for this hotel.');
  const user = getSecret(c.tenantUserRef);
  const pw = getSecret(c.tenantPasswordRef);
  if (!user || !pw) throw new ApiError(503, 'CS_SECRET_MISSING', 'Credential Services credentials are not available in the secret store.');
  return { client: new CredentialServicesClient(c.baseUrl, user, pw), systemId: c.systemId as number };
}

/** Per-hotel Basic-auth credentials Credential Services uses when calling us back [CS §8.2]. */
export function callbackAuthFor(hotelId: string) {
  return { username: `smk-${hotelId.slice(0, 8)}`, password: createHmac('sha256', config.callbackSecret).update(hotelId).digest('base64url') };
}
export const callbackUrlFor = (slug: string) => `${config.publicUrl}/integrations/credential-services/callback/${slug}`;

/** Ensure ENDPOINT, CREDENTIAL and READBACK callbacks point at this platform. Idempotent. */
export async function ensureCallbacks(hotelId: string) {
  const hotel = await one(pool, 'SELECT slug FROM hotels WHERE id=$1', [hotelId]);
  const { client } = await csForHotel(hotelId);
  const url = callbackUrlFor(hotel.slug);
  const auth = callbackAuthFor(hotelId);
  const existing = await client.listCallbacks();
  const registered: string[] = [];
  for (const type of CS.callbackTypes) {
    if (existing.some((c) => c.type === type && c.url === url)) { registered.push(type); continue; }
    await client.registerCallback(type, url, auth.username, auth.password);
    registered.push(type);
  }
  return { url, registered };
}
