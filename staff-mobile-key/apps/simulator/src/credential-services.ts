import type { FastifyInstance, FastifyReply } from 'fastify';
import { CS } from '@smk/shared';
import { invitationCode, vlPublish, type SimState, type Card, type LockEvent, type CsCallbackReg } from './state.ts';
import { toVisionlineLocal } from '@smk/shared/node';

type Send = (type: CsCallbackReg['type'], body: Record<string, unknown>) => Promise<void>;

/**
 * Simulated ASSA ABLOY Credential Services (AAH Credential Services API V2.5.1) + mobile SDK + BLE locks.
 *  /cs/...   tenant API used by the platform backend           [CS §5–§8]
 *  /sdk/...  what the vendor SDK on a phone would do (personalize, hold keys, BLE to a lock)
 *  /sim/...  test controls (fault injection, state view)
 */
export function registerCredentialServices(app: FastifyInstance, st: SimState, opts: {
  tenantUser: string; tenantPassword: string; send: Send; log: (m: string) => void; systemId: number;
  timeZone?: string; onRevoke?: (c: Card) => void;
}) {
  const csErr = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ code, message });
  const expected = 'Basic ' + Buffer.from(`${opts.tenantUser}:${opts.tenantPassword}`).toString('base64');

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/cs/')) return;
    if (req.headers.authorization !== expected) return csErr(reply, 403, '403', 'Forbidden');
    if ((req.method === 'POST' || req.method === 'PUT') && !String(req.headers['content-type'] ?? '').startsWith(CS.mediaType))
      return csErr(reply, 415, '415', 'Unsupported Media Type');
  });
  app.addContentTypeParser(CS.mediaType, { parseAs: 'string' }, (_r, body, done) => {
    try { done(null, body ? JSON.parse(String(body)) : {}); } catch (e) { done(e as Error); }
  });

  const credentialView = (c: Card) => ({
    status: c.status, endpointId: c.endpointId, label: c.label, description: `Credential ID#${c.credentialID}`,
    validity: { startDate: new Date(c.startTime).toISOString(), endDate: new Date(c.expireTime).toISOString() },
  });

  // [§6.2] Create endpoint invitation
  app.post('/cs/endpoint/invitation', async (req, reply) => {
    const { endpointId } = (req.body ?? {}) as { endpointId?: string };
    const id = endpointId ?? crypto.randomUUID();
    if (!CS.endpointIdPattern.test(id)) return csErr(reply, 400, '1104', 'Invalid endpointId');
    const ex = st.endpoints.get(id);
    if (ex && ['ACKNOWLEDGED', 'ACTIVATING', 'ACTIVE'].includes(ex.endpointStatus)) return csErr(reply, 400, CS.errorIdInUse, 'Id already in use');
    if (ex && ex.endpointStatus === 'INVITATION_PENDING' && ex.invitationExpiresAt! > Date.now())
      return reply.code(201).send({ invitationCode: ex.invitationCode, endpointId: id }); // same code while unused [§6.1]
    const ep = { endpointId: id, endpointStatus: 'INVITATION_PENDING' as const, invitationCode: invitationCode(), invitationExpiresAt: Date.now() + CS.invitationTtlMs };
    st.endpoints.set(id, ep);
    return reply.code(201).send({ invitationCode: ep.invitationCode, endpointId: id });
  });

  // [§5.3] Get endpoint details
  app.get('/cs/endpoint/:id', async (req, reply) => {
    const ep = st.endpoints.get((req.params as any).id);
    if (!ep) return csErr(reply, 404, '404', 'Not Found');
    if (ep.endpointStatus === 'INVITATION_PENDING' && ep.invitationExpiresAt! < Date.now()) ep.endpointStatus = 'INVITATION_INVALID';
    return {
      endpointStatus: ep.endpointStatus, seosTsmEndpointId: 1000000 + st.endpoints.size, bleCapability: true, hceCapability: true, nfcCapability: false,
      deviceManufacturer: 'Simulated', applicationVersion: 'Staff Key (dev)', deviceModel: ep.deviceModel ?? null, seosAppletVersion: 'sim', osVersion: null,
    };
  });

  // [§5.4] Delete endpoint — credentials can no longer be issued to it.
  app.delete('/cs/endpoint/:id', async (req, reply) => {
    const ep = st.endpoints.get((req.params as any).id);
    if (!ep) return csErr(reply, 404, '404', 'Not Found');
    ep.endpointStatus = 'TERMINATED';
    for (const c of st.cards.values()) if (c.endpointId === ep.endpointId && c.status !== 'REVOKED') {
      c.status = 'REVOKED';
      const { label, description, validity } = credentialView(c);
      void opts.send('CREDENTIAL', { callbackType: 'credentialStatusChanged', systemId: opts.systemId, endpointId: c.endpointId, credentialId: String(c.credentialID), credentialStatus: 'REVOKED', label, description, validity });
    }
    return reply.code(200).send();
  });

  // [§7.2] Get credential details
  app.get('/cs/system/:systemId/credential/:id', async (req, reply) => {
    const c = st.cards.get(Number((req.params as any).id));
    if (!c || Number((req.params as any).systemId) !== opts.systemId) return csErr(reply, 404, '404', 'Not Found');
    return credentialView(c);
  });

  // [§8.2–8.4] Callback registration
  app.post('/cs/callback', async (req, reply) => {
    const b = (req.body ?? {}) as CsCallbackReg;
    if (!CS.callbackTypes.includes(b.type as any) || !b.url) return csErr(reply, 400, '1104', 'Required data missing');
    st.csCallbacks.push({ type: b.type, url: b.url, username: b.username, password: b.password });
    return reply.code(201).send();
  });
  app.get('/cs/callback', async () => st.csCallbacks.map((c) => ({ type: c.type, url: c.url, username: c.username })));
  app.delete('/cs/callback/:type', async (req, reply) => {
    st.csCallbacks = st.csCallbacks.filter((c) => c.type !== (req.params as any).type);
    return reply.code(200).send();
  });

  // ---- Simulated phone SDK ---------------------------------------------------------------
  app.post('/sdk/personalize', async (req, reply) => {
    const { invitationCode: code, deviceModel } = (req.body ?? {}) as { invitationCode?: string; deviceModel?: string };
    const ep = [...st.endpoints.values()].find((e) => e.invitationCode && e.invitationCode === code?.trim().toUpperCase());
    if (!ep || ep.endpointStatus !== 'INVITATION_PENDING') return reply.code(404).send({ code: 'InvalidInvitation', message: 'Invitation code not recognised' });
    if (ep.invitationExpiresAt! < Date.now()) { ep.endpointStatus = 'INVITATION_INVALID'; return reply.code(410).send({ code: 'InvitationExpired', message: 'Invitation has expired' }); }
    ep.endpointStatus = 'ACKNOWLEDGED'; ep.deviceModel = deviceModel ?? 'Phone'; ep.invitationCode = undefined;
    setTimeout(() => { ep.endpointStatus = 'ACTIVATING'; }, 200);
    setTimeout(() => {
      ep.endpointStatus = 'ACTIVE'; ep.activatedAt = Date.now();
      void opts.send('ENDPOINT', { callbackType: 'endpointStatusChanged', endpointId: ep.endpointId, endpointStatus: 'ACTIVE' });
    }, 700);
    return { endpointId: ep.endpointId, status: 'ACKNOWLEDGED' };
  });

  app.get('/sdk/endpoints/:endpointId', async (req, reply) => {
    const ep = st.endpoints.get((req.params as any).endpointId);
    return ep ? { endpointId: ep.endpointId, status: ep.endpointStatus } : reply.code(404).send({ code: 'NotFound' });
  });

  // Keys held on the phone: only ISSUED credentials are present in the secure element.
  app.get('/sdk/endpoints/:endpointId/keys', async (req) => {
    const id = (req.params as any).endpointId;
    return [...st.cards.values()].filter((c) => c.endpointId === id && c.status === 'ISSUED')
      .map((c) => ({ credentialId: String(c.credentialID), label: c.label, doorCount: c.doors.length,
        validFrom: new Date(c.startTime).toISOString(), validUntil: new Date(c.expireTime).toISOString() }));
  });

  // BLE "tap at lock": the lock decides using the credential it receives, like a real Visionline lock.
  app.post('/sdk/endpoints/:endpointId/open', async (req, reply) => {
    const endpointId = (req.params as any).endpointId as string;
    const { doorId } = (req.body ?? {}) as { doorId?: string };
    const door = st.doors.find((d) => d.id === doorId);
    if (!door) return reply.code(404).send({ code: 'UnknownDoor' });
    const ep = st.endpoints.get(endpointId);
    const t = Date.now();
    let result: LockEvent['result'] = 'DENIED';
    let reason = 'No valid key for this door';
    let card: Card | undefined;
    if (!ep || ep.endpointStatus !== 'ACTIVE') reason = 'Phone is not an active endpoint';
    else {
      const onPhone = [...st.cards.values()].filter((c) => c.endpointId === endpointId && c.status === 'ISSUED');
      const forDoor = onPhone.filter((c) => c.doors.includes(door.id));
      card = forDoor.find((c) => !c.cancelled && !c.checkedOut.has(door.id) && c.startTime <= t && t < c.expireTime);
      if (card) { result = 'OPENED'; reason = 'Access granted'; }
      else {
        // The lock reports on the newest credential that covers this door.
        const newest = [...forDoor].sort((x, y) => y.createdAt - x.createdAt)[0];
        if (!newest) { if (onPhone.length) reason = 'Door not in key'; }
        else if (newest.cancelled || newest.checkedOut.has(door.id)) reason = 'Key cancelled';
        else if (newest.expireTime <= t) reason = 'Key expired';
        else if (newest.startTime > t) reason = 'Key not yet valid';
      }
    }
    const ev: LockEvent = { at: new Date().toISOString(), doorId: door.id, doorName: door.doorName, endpointId, credentialID: card?.credentialID, result, reason };
    // The lock reports what happened to Visionline [Web API §7.14.1 event codes]: 64 staff card accepted,
    // 320 no access to this room, 368 card is cancelled, 322 card has expired.
    const presented = card ?? [...st.cards.values()].filter((c) => c.endpointId === endpointId && c.status === 'ISSUED').sort((x, y) => y.createdAt - x.createdAt)[0];
    if (presented) {
      const code = result === 'OPENED' ? 64 : reason === 'Key cancelled' ? 368 : reason === 'Key expired' ? 322 : reason === 'Key not yet valid' ? 18 : reason === 'Door not in key' ? 320 : 0;
      if (code) vlPublish(st, 'events', { doorID: door.doorID, registrationNumber: Number(presented.cardId), eventCode: code, eventTime: toVisionlineLocal(new Date(t), opts.timeZone ?? 'Africa/Douala'), repeatFlags: 0 });
    }
    st.events.unshift(ev); st.events.length = Math.min(st.events.length, 200);
    opts.log(`LOCK ${door.doorName}: ${result} (${reason})`);
    if (card && !card.usedAt.has(door.id)) {
      card.usedAt.add(door.id); // READBACK on first use at each door [CS §8.5.3]
      void opts.send('READBACK', { callbackType: 'sessionTransceived', systemId: opts.systemId, endpointId, credentialId: String(card.credentialID), credentialStatus: card.status, label: card.label, description: door.doorName, validity: credentialView(card).validity });
    }
    return ev;
  });

  // ---- Test controls -------------------------------------------------------------------
  app.get('/sim/state', async () => ({
    faults: st.faults, stats: st.stats, mobileAccessOptions: st.mobileAccessOptions, operators: undefined, sessions: st.sessions.size, callbacks: st.csCallbacks.map((c) => ({ type: c.type, url: c.url })),
    endpoints: [...st.endpoints.values()].map(({ invitationCode: _c, ...e }) => e),
    cards: [...st.cards.values()].map((c) => ({ ...c, checkedOut: [...c.checkedOut], usedAt: [...c.usedAt] })),
    users: [...st.users.values()],
    events: st.events.slice(0, 50),
    doors: st.doors,
  }));
  // "Cancel at the Visionline desk": a card cancelled in Visionline by hotel staff, outside the platform.
  // Whether Visionline then revokes the mobile key through Credential Services is not documented, so by
  // default the simulator does not (the platform must react to the connector's report).
  app.post('/sim/cards/:credentialID/cancel', async (req, reply) => {
    const c = st.cards.get(Number((req.params as any).credentialID));
    if (!c) return reply.code(404).send({ code: 'UnknownCard' });
    const b = (req.body ?? {}) as { revokeFromPhone?: boolean };
    if (!c.cancelled) {
      c.cancelled = true; c.vlStatus = 0; c.cancelTime = Date.now();
      vlPublish(st, 'cards', { registrationNumber: Number(c.cardId), status: 0, cancelTime: toVisionlineLocal(new Date(c.cancelTime), opts.timeZone ?? 'Africa/Douala'), cardHolder: c.cardHolder, expireTime: toVisionlineLocal(new Date(c.expireTime), opts.timeZone ?? 'Africa/Douala') });
      opts.log(`DESK cancelled card ${c.credentialID} (${c.cardHolder})`);
      if (b.revokeFromPhone) opts.onRevoke?.(c);
    }
    return { credentialID: c.credentialID, cancelled: true };
  });
  // A lock reporting a battery event [Web API §7.14.1]: low 304, critical 305, exchanged 528, "below X volts" 1056–1081.
  // Battery events are not caused by a card, so registrationNumber is 0.
  app.post('/sim/doors/:id/battery', async (req, reply) => {
    const door = st.doors.find((d) => d.id === (req.params as any).id);
    if (!door) return reply.code(404).send({ code: 'UnknownDoor' });
    const b = (req.body ?? {}) as { kind?: 'low' | 'critical' | 'exchanged' | 'volts'; volts?: number; code?: number };
    let code = b.code ?? (b.kind === 'low' ? 304 : b.kind === 'critical' ? 305 : b.kind === 'exchanged' ? 528 : 0);
    if (b.kind === 'volts') {
      const v = Number(b.volts);
      code = v >= 6 ? 1056 + Math.round((Math.min(9, v) - 6) / 0.2) : 1072 + Math.round((Math.max(3, Math.min(4.8, v)) - 3) / 0.2);
    }
    if (!code) return reply.code(400).send({ code: 'BadKind' });
    // Visionline also raises an alarm for low and critical batteries [§5.3].
    if (b.kind === 'low' || b.kind === 'critical') {
      const t = Date.now();
      st.alarms.push({ id: String(5000 + st.alarms.length), alarmType: '1', alarmText: b.kind === 'low' ? 'Battery level low' : 'Battery level critically low', at: t, door: door.id, cardHolder: null, completed: false, updatedAt: t });
    }
    door.battery = b.kind === 'low' ? 'LOW' : b.kind === 'critical' ? 'CRITICAL' : b.kind === 'exchanged' ? 'GOOD' : door.battery;
    vlPublish(st, 'events', { doorID: door.doorID, registrationNumber: 0, eventCode: code, eventTime: toVisionlineLocal(new Date(), opts.timeZone ?? 'Africa/Douala'), repeatFlags: 0 });
    opts.log(`LOCK ${door.doorName}: battery event ${code}`);
    return { door: door.id, eventCode: code };
  });
  app.post('/sim/faults', async (req) => {
    const b = { ...(req.body as any ?? {}) };
    if (b.revokeWhen) { st.mobileAccessOptions.revokeWhen = b.revokeWhen; delete b.revokeWhen; }
    Object.assign(st.faults, b);
    return { ...st.faults, ...st.mobileAccessOptions };
  });
}

/** Credential delivery is asynchronous; Credential Services reports state changes by callback [CS §8.5.2]. */
export function lifecycle(st: SimState, send: Send, systemId: number) {
  const notify = (c: Card) => void send('CREDENTIAL', {
    callbackType: 'credentialStatusChanged', systemId, endpointId: c.endpointId, credentialId: String(c.credentialID), credentialStatus: c.status,
    label: c.label, description: `Credential ID#${c.credentialID}`,
    validity: { startDate: new Date(c.startTime).toISOString(), endDate: new Date(c.expireTime).toISOString() },
  });
  return {
    onCardCreated(c: Card) {
      notify(c);
      setTimeout(() => {
        const ep = st.endpoints.get(c.endpointId);
        c.status = ep?.endpointStatus === 'ACTIVE' ? 'ISSUED' : 'ISSUING_FAILURE';
        notify(c);
      }, st.faults.deliveryDelayMs);
    },
    onCardRevoked(c: Card) {
      c.status = 'REVOKING'; notify(c);
      setTimeout(() => { c.status = 'REVOKED'; notify(c); }, st.faults.deliveryDelayMs);
    },
  };
}
