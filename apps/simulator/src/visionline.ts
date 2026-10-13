import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { VL, contentMd5, parseAuthorization, sign, signaturesEqual, fromVisionlineLocal, toVisionlineLocal } from '@smk/shared/node';
import { newId, newSecret, vlPublish, type SimState, type Card } from './state.ts';

/**
 * Simulated Visionline Web API following ASSA ABLOY Web API 61 1100 080 rev 74.
 * Implements the subset the platform uses, including the failure modes the connector must handle:
 * 40101 clock skew, 40103 expired session, 40104 bad signature, 40406 unknown door, 40052 endpoint
 * not found, 40902 existing staff card, 50301 outage.
 */
export function registerVisionline(app: FastifyInstance, st: SimState, opts: {
  basePath: string; operators: Record<string, string>; accessIds: string[]; timeZone: string;
  onCardCreated: (c: Card) => void; onCardRevoked: (c: Card) => void;
}) {
  const E = VL.errors;
  const now = () => Date.now() + st.faults.clockOffsetSec * 1000;
  const fail = (reply: FastifyReply, code: number, message: string, developerMessage?: string) => {
    const status = Math.floor(code / 100);
    return reply.code(status).send({ status, code, message, developerMessage: developerMessage ?? message });
  };

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  app.addHook('onSend', async (_req, reply) => { reply.header('date', new Date(now()).toUTCString()); });

  app.addHook('preHandler', async (req: FastifyRequest, reply) => {
    const url = req.url;
    if (!url.startsWith(opts.basePath)) return fail(reply, E.resourceNotFound, 'Not found');
    if (st.faults.visionlineDown) return fail(reply, E.unavailable, 'Service is unavailable.');
    const body = typeof req.body === 'string' ? req.body : '';
    if (body && !String(req.headers['content-type'] ?? '').startsWith('application/json'))
      return fail(reply, 41501, 'The request did not have content type of application/json; utf-8.');
    (req as any).json = body ? JSON.parse(body) : {};
    (req as any).operator = undefined;
    if (req.method === 'POST' && url.split('?')[0] === opts.basePath + VL.paths.sessions) return; // unsigned [§5.24]

    const auth = parseAuthorization(req.headers.authorization);
    if (!auth) return fail(reply, E.malformedAuthorization, 'The Authorization header is malformed.');
    const xAahDate = req.headers[VL.auth.dateHeader] as string | undefined;
    const date = req.headers['date'] as string | undefined;
    const t = Date.parse(xAahDate ?? date ?? '');
    if (!Number.isFinite(t)) return fail(reply, E.invalidDate, 'The Date header is invalid.');
    if (Math.abs(t - now()) > VL.maxClockSkewMs) return fail(reply, E.clockSkew, 'The time skew between the client and the server is too big.');

    const session = st.sessions.get(auth.sessionId);
    if (!session || session.expiresAt < now()) {
      if (session) st.sessions.delete(session.id);
      return fail(reply, E.sessionNotFound, 'The supplied session ID does not exist. It may have expired.');
    }
    const md5 = req.headers['content-md5'] as string | undefined;
    if (body && md5 !== contentMd5(body)) return fail(reply, E.badContentMd5, 'The Content MD5 Header value does not match the MD5 value of the message body.');
    const expected = sign(session.accessKey, {
      method: req.method, contentMd5: md5, contentType: req.headers['content-type'] as string | undefined, date, xAahDate, url,
    });
    if (!signaturesEqual(expected, auth.signature)) {
      st.stats.rejectedSignatures++;
      return fail(reply, E.badSignature, 'The signature of the request did not match calculated signature.');
    }
    st.stats.signedRequests++;
    session.expiresAt = now() + session.ttlMs;
    (req as any).operator = session.username;
  });

  const p = (s: string) => opts.basePath + s;
  const cardChange = (c: Card) => ({ registrationNumber: Number(c.cardId), status: c.vlStatus ?? (c.cancelled ? 0 : 1), cancelTime: c.cancelTime ? toVisionlineLocal(new Date(c.cancelTime), opts.timeZone) : '', cardHolder: c.cardHolder, expireTime: toVisionlineLocal(new Date(c.expireTime), opts.timeZone) });
  const J = (req: FastifyRequest) => (req as any).json as Record<string, any>;
  const F = VL.fields;

  // ---- sessions [§5.24, §5.25]
  app.post(p('/sessions'), async (req, reply) => {
    const b = J(req);
    if (!b[F.username] || opts.operators[b[F.username]] !== b[F.password])
      return fail(reply, E.badCredentials, 'A new session could not be created since the client has supplied bad credentials.');
    if (b[F.accessId] !== undefined && !opts.accessIds.includes(b[F.accessId]))
      return fail(reply, 40036, 'Unknown access ID specified. The access ID is not in the white-list on the server.');
    // A new session by the same operator terminates the previous one [§5.25].
    for (const s of st.sessions.values()) if (s.username === b[F.username]) st.sessions.delete(s.id);
    const ttlMs = st.faults.sessionTtlSec * 1000;
    const s = { id: newId(), accessKey: newSecret(), username: b[F.username], ttlMs, expiresAt: now() + ttlMs,
      webClientID: b[F.accessId] ? 10000 : undefined };
    st.sessions.set(s.id, s);
    st.stats.sessionsCreated++;
    return reply.code(201).header('location', `${opts.basePath}/sessions/${s.id}`)
      .send({ id: s.id, accessKey: s.accessKey, ...(s.webClientID ? { webClientID: s.webClientID } : {}) });
  });
  app.delete(p('/sessions/:id'), async (req, reply) => { st.sessions.delete((req.params as any).id); return reply.code(200).send({}); });

  // ---- discovery
  app.get(p('/resources'), async () =>
    ['cards', 'doors', 'users', 'userGroups', 'timeSchedules', 'mobileaccess', 'callback', 'resources'].map((id) => ({ id })));
  app.get(p('/doors'), async (req) => {
    const q = req.query as Record<string, string>;
    let ds = st.doors;
    if (q.doorGroup) ds = ds.filter((d) => d.doorGroup === q.doorGroup);
    if (q.details === 'true') return ds.map(({ battery: _b, ...d }) => d);
    return ds.map((d) => ({ id: d.id }));
  });
  app.get(p('/doors/:id'), async (req, reply) => {
    const d = st.doors.find((x) => x.id === (req.params as any).id);
    if (!d) return fail(reply, E.doorNotFound, 'The specified door does not exist.');
    const { battery: _b, ...rest } = d; return rest;
  });
  app.get(p('/userGroups/:id'), async (req, reply) => {
    const g = st.userGroups.get((req.params as any).id);
    return g ?? fail(reply, E.resourceNotFound, 'The resource does not exist.') // as observed on a real Visionline (40401);
  });
  app.put(p('/userGroups/:id'), async (req, reply) => {
    const id = (req.params as any).id as string;
    if (st.userGroups.has(id)) return fail(reply, 40901, 'The resource cannot be created because it already exists.');
    const b = J(req);
    const g = { id, uniformAccess: Boolean(b.uniformAccess), doorOperations: Array.isArray(b.doorOperations) ? b.doorOperations : [] };
    st.userGroups.set(id, g);
    return reply.code(201).send(g);
  });
  app.get(p('/users'), async (req) => {
    const q = req.query as Record<string, string>;
    return [...st.users.values()].filter((u) => !q.userGroup || u.userGroup === q.userGroup).map((u) => ({ id: u.id }));
  });
  app.get(p('/users/:id'), async (req, reply) => {
    const u = st.users.get((req.params as any).id);
    return u ? { ...u, extendedExpireTime: null, autoDelete: false } : fail(reply, E.resourceNotFound, 'The resource does not exist.');
  });
  app.put(p('/users/:id'), async (req, reply) => {
    const id = (req.params as any).id as string;
    const b = J(req);
    if (st.users.has(id)) return fail(reply, 40901, 'The resource cannot be created because it already exists.');
    if (!b[F.userGroup]) return fail(reply, E.missingProperty, 'A mandatory property is missing in the request object.');
    if (!st.userGroups.has(b[F.userGroup])) return fail(reply, E.userGroupNotFound, 'The specified user group does not exist.');
    const u = { id, surname: b.surname, givenName: b.givenName, userGroup: b.userGroup, email: b.email };
    st.users.set(id, u);
    return reply.code(201).send({ ...u, extendedExpireTime: null, autoDelete: false });
  });
  app.get(p('/timeSchedules'), async () => st.timeSchedules);
  app.get(p('/mobileaccess'), async () => st.mobileAccessAccounts.map(({ default: _d, ...a }) => a));
  app.get(p('/mobileaccess/:id'), async (req, reply) => {
    const a = st.mobileAccessAccounts.find((x) => x.name === (req.params as any).id);
    if (!a) return fail(reply, E.resourceNotFound, 'The resource does not exist.');
    const { default: _d, ...rest } = a; return rest;
  });

  // ---- staff mobile key [§7.5.6]
  app.post(p('/cards'), async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q.action !== VL.query.mobileAccess) return fail(reply, 50011, 'The requested functionality has not been implemented.', 'Simulator implements action=mobileAccess only');
    if (q.returnCredential === 'true') return fail(reply, 40326, 'Returning credentials is not enabled in this simulator.');
    const b = J(req);
    if (!b[F.format] || !b[F.expireTime]) return fail(reply, E.missingProperty, 'A mandatory property is missing in the request object.');
    if (b[F.format] !== 'TLCode' && b[F.format] !== 'rfid48') return fail(reply, 40009, 'Illegal card format specified. It must be rfid48 or TLCode.');
    if (!b[F.cardHolder]) return fail(reply, E.missingProperty, 'cardHolder is mandatory for a staff mobile key.');
    if (!st.users.has(b[F.cardHolder])) return fail(reply, E.cardHolderNotFound, 'The specified card holder does not exist.');
    const ep = String(b[F.endpointId] ?? '');
    if (ep.length > 50) return fail(reply, 40507, 'Mobile Access EndPoint ID with length more than 50 characters is not allowed.');
    const endpoint = st.endpoints.get(ep);
    if (!endpoint || endpoint.endpointStatus !== 'ACTIVE') return fail(reply, E.endpointNotFound, 'Endpoint not found.');
    const holder = st.users.get(b[F.cardHolder])!;
    const group = st.userGroups.get(holder.userGroup);
    if (group?.uniformAccess) {
      if (b[F.doorOperations]) return fail(reply, 40015, 'Cannot change the doors of a card when card holder belongs to user group with uniform access.');
      b[F.doorOperations] = group.doorOperations; // doors come from the group [§5.29.3]
    }
    if (!Array.isArray(b[F.doorOperations])) return fail(reply, E.missingProperty, 'A mandatory property is missing in the request object.', 'doorOperations');
    const doors: string[] = [];
    for (const op of b[F.doorOperations]) {
      if (op.operation !== 'normal') return fail(reply, E.illegalOperation, 'Illegal door operation type specified. In case of Staff card it should be normal.');
      if (!Array.isArray(op.doors)) return fail(reply, 40019, 'Door list in doorOperations property must be a list of strings.');
      for (const d of op.doors) {
        const door = st.doors.find((x) => x.id === d || String(x.doorID) === String(d));
        if (!door) return fail(reply, E.doorNotFound, 'The specified door does not exist.', `Door ${d}`);
        if (!doors.includes(door.id)) doors.push(door.id);
      }
      for (const g of op.doorGroups ?? []) for (const door of st.doors.filter((x) => x.doorGroup === g)) if (!doors.includes(door.id)) doors.push(door.id);
    }
    if (b[F.timeSchedule] && !st.timeSchedules.some((t) => t.timeSchedule === b[F.timeSchedule]))
      return fail(reply, 40031, 'Invalid Time Schedule. It must be an existing value in Database.');
    let expire: number;
    try { expire = fromVisionlineLocal(b[F.expireTime], opts.timeZone).getTime(); } catch { return fail(reply, 40028, 'Timestamp must be in local time and formatted according to ISO 8601.'); }
    if (expire <= now()) return fail(reply, E.expireInPast, 'Value of Expire time cannot be in the past.');
    const account = b[F.accountName] ?? st.mobileAccessAccounts.find((a) => a.default)!.name;
    if (!st.mobileAccessAccounts.some((a) => a.name === account)) return fail(reply, 40035, 'Invalid property value.', 'Unknown accountName');
    const existing = [...st.cards.values()].find((c) => c.cardHolder === b[F.cardHolder] && !c.cancelled && c.status !== 'REVOKED' && c.expireTime > now());
    if (existing && st.faults.enforceOneStaffCard && q.override !== 'true')
      return fail(reply, E.validStaffCardExists, 'There is/are valid staff card(s) for this user. Please provide override=true to cancel all previous staff card(s).');
    if (st.faults.failNextCard) { const c = st.faults.failNextCard; st.faults.failNextCard = null; return fail(reply, c, 'Simulated failure'); }
    if (existing && q.override === 'true') {
      // Override cancels the previous staff card. The mobile key leaves the phone now only if Visionline is set to
      // "Revoke mobile key when overridden"; with "when expired" it stays on the phone (refused at locks) until expiry.
      existing.cancelled = true; existing.vlStatus = 2; existing.cancelTime = now();
      vlPublish(st, 'cards', cardChange(existing));
      if (st.mobileAccessOptions.revokeWhen === 'overridden') opts.onCardRevoked(existing);
    }

    const card: Card = {
      // The card registration number (card id, §5.10.2) is separate from the credentialID returned to the client.
      cardId: String(st.nextCardId++), credentialID: st.nextCredentialId++, cardHolder: b[F.cardHolder], issuedBy: (req as any).operator ?? '?', endpointId: ep, doors,
      startTime: b[F.startTime] ? fromVisionlineLocal(b[F.startTime], opts.timeZone).getTime() : now(),
      expireTime: expire, status: 'ISSUING', cancelled: false, checkedOut: new Set(), createdAt: now(),
      accountName: account, timeSchedule: b[F.timeSchedule], label: b[F.label] ?? `Staff ${doors[0]}`, usedAt: new Set(),
    };
    st.cards.set(card.credentialID, card);
    st.stats.cardsCreated++;
    opts.onCardCreated(card);
    return reply.code(201).send({ credentialID: card.credentialID });
  });

  // Find cards [§5.9.3]: by card holder and validTime, or cancelled since a moment (cancelTimeSince, used alone).
  app.get(p('/cards'), async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q.cancelTimeSince) {
      if (Object.keys(q).length > 1) return fail(reply, 40022, 'Parameter cancelTimeSince cannot be combined with other parameters.');
      const t = fromVisionlineLocal(q.cancelTimeSince, opts.timeZone).getTime();
      return [...st.cards.values()].filter((c) => c.cancelled && (c.cancelTime ?? 0) >= t).map((c) => ({ id: c.cardId }));
    }
    if (!q.cardHolder || (!q.validTime && !(q.startTime && q.expireTime))) return fail(reply, 40022, 'A mandatory parameter is missing in the query string of the request.');
    if (q.validTime) {
      const t = fromVisionlineLocal(q.validTime, opts.timeZone).getTime();
      return [...st.cards.values()].filter((c) => c.cardHolder === q.cardHolder && !c.cancelled && c.startTime <= t && t < c.expireTime).map((c) => ({ id: c.cardId }));
    }
    // startTime: cards that expire after it; expireTime: cards that become valid before it [§5.9.3].
    const from = fromVisionlineLocal(q.startTime, opts.timeZone).getTime(), to = fromVisionlineLocal(q.expireTime, opts.timeZone).getTime();
    return [...st.cards.values()].filter((c) => c.cardHolder === q.cardHolder && c.expireTime > from && c.startTime < to).map((c) => ({ id: c.cardId }));
  });
  app.get(p('/cards/:id'), async (req, reply) => {
    const c = [...st.cards.values()].find((x) => x.cardId === (req.params as any).id);
    if (!c) return fail(reply, 40411, 'The specified card does not exist.');
    return { id: c.cardId, cardHolder: c.cardHolder, format: 'TLCode', cancelled: c.cancelled, created: toVisionlineLocal(new Date(c.createdAt), opts.timeZone) + String(new Date(c.createdAt).getUTCSeconds()).padStart(2, '0') + String(c.createdAt % 1000).padStart(3, '0'),
      startTime: toVisionlineLocal(new Date(c.startTime), opts.timeZone), expireTime: toVisionlineLocal(new Date(c.expireTime), opts.timeZone),
      doorOperations: [{ operation: 'normal', doors: c.doors, doorGroups: [] }] };
  });
  // Cancel a card [§7.7.4]
  app.post(p('/cards/:id'), async (req, reply) => {
    const c = [...st.cards.values()].find((x) => x.cardId === (req.params as any).id);
    if (!c) return fail(reply, 40411, 'The specified card does not exist.');
    const b = J(req);
    if (b.cancelled === true && !c.cancelled) { c.cancelled = true; c.vlStatus = 0; c.cancelTime = now(); vlPublish(st, 'cards', cardChange(c)); opts.onCardRevoked(c); }
    return { id: c.cardId, cancelled: c.cancelled };
  });

  // ---- callbacks [§7.14 set up, §7.15 remove, §7.16 long poll]
  app.post(p('/callback'), async (req, reply) => {
    const r = J(req).resources ?? {};
    if (!r.cards && !r.events) return fail(reply, E.missingProperty, 'A mandatory property is missing in the request object.', 'resources');
    const id = newId();
    st.vlCallbacks.set(id, { id, wantCards: Boolean(r.cards), wantEvents: Boolean(r.events), eventCodes: Array.isArray(r.events?.eventCode) ? r.events.eventCode.map(Number) : null, cards: [], events: [], waiters: [], lastPoll: Date.now() });
    return reply.code(200).send({ id });
  });
  app.get(p('/callback/:id'), async (req, reply) => {
    const cb = st.vlCallbacks.get((req.params as any).id);
    if (!cb) return fail(reply, E.resourceNotFound, 'The specified resource does not exist.');
    cb.lastPoll = Date.now();
    if (!cb.cards.length && !cb.events.length) {
      // Visionline holds the request for up to 4 minutes; the simulator uses a shorter wait.
      await new Promise<void>((res) => { const t = setTimeout(res, Number(process.env.SIM_CALLBACK_WAIT_MS ?? 20_000)); cb.waiters.push(() => { clearTimeout(t); res(); }); });
    }
    const resources: Record<string, unknown[]> = {};
    if (cb.cards.length) resources.cards = cb.cards.splice(0);
    if (cb.events.length) resources.events = cb.events.splice(0);
    return { id: cb.id, resources };
  });
  app.delete(p('/callback/:id'), async (req, reply) => {
    if (!st.vlCallbacks.delete((req.params as any).id)) return fail(reply, E.resourceNotFound, 'The specified resource does not exist.');
    return reply.code(200).send({});
  });

  // Checkout of an individual mobile key at a door [§5.13.4, §7.13.5]
  app.post(p('/doors/:id'), async (req, reply) => {
    const door = st.doors.find((x) => x.id === (req.params as any).id);
    if (!door) return fail(reply, E.doorNotFound, 'The specified door does not exist.');
    const b = J(req);
    if (b[F.checkedOut] !== true) return fail(reply, 40503, 'The specified operation is not allowed for the door.', 'Simulator implements checkedOut only');
    if (b.credentialID !== undefined) {
      const c = st.cards.get(Number(b.credentialID));
      if (!c) return fail(reply, 40411, 'The specified card does not exist.');
      if (c.doors.includes(door.id)) c.checkedOut.add(door.id);
      // Key leaves the phone once every door it opens has been checked out [§7.13.5].
      if (c.doors.every((d) => c.checkedOut.has(d)) && !c.cancelled) { c.cancelled = true; c.cancelTime = now(); opts.onCardRevoked(c); }
    }
    return { id: door.id };
  });
}
