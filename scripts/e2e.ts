/**
 * End-to-end check of the Phase 1 acceptance gates (spec §10) against the running stack:
 * backend (API), connector, and the Visionline / Credential Services simulator.
 *
 *   npm run e2e            (defaults: API http://localhost:4000, simulator http://localhost:8444)
 */
import { randomUUID } from 'node:crypto';
import { sealForConnector } from '../packages/shared/src/sealing.ts';

const API = process.env.API_URL ?? 'http://localhost:4000';
const SIM = process.env.SIM_URL ?? 'http://localhost:8444';
const PW = process.env.SEED_PASSWORD ?? 'ChangeMe!2026';
const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? 'Staff!2026';
const SKIP_SLOW = process.env.E2E_FAST === '1';
/** E2E_POLLING=1 when the backend runs with CS_CALLBACKS=off (on-premises): no vendor callbacks at all. */
const POLLING = process.env.E2E_POLLING === '1';

let passed = 0;
const failures: string[] = [];
const ok = (cond: unknown, label: string, extra?: unknown) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures.push(label); console.log(`  ✗ ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json };
}
const login = async (email: string) => (await call('POST', `${API}/api/v1/auth/login`, undefined, { email, password: PW })).json.token as string;
const staffLogin = async (email: string, hotel = 'k-hotel-bana') => (await call('POST', `${API}/mobile/v1/login`, undefined, { hotel, email, password: STAFF_PW })).json.token as string;
async function until<T>(label: string, fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let v = await fn();
  while (!pred(v) && Date.now() < end) { await sleep(500); v = await fn(); }
  if (!pred(v)) console.log(`    (timed out waiting for ${label})`);
  return v;
}
const sim = (body: unknown) => call('POST', `${SIM}/sim/faults`, undefined, body);
const tap = async (endpointId: string, doorId: string) => (await call('POST', `${SIM}/sdk/endpoints/${endpointId}/open`, undefined, { doorId })).json;

async function onboard(staffToken: string, device: string) {
  const inv = await call('POST', `${API}/mobile/v1/onboarding`, staffToken, { deviceLabel: device });
  const p = await call('POST', `${SIM}/sdk/personalize`, undefined, { invitationCode: inv.json.invitationCode, deviceModel: device });
  const me = await until('endpoint ACTIVE', () => call('GET', `${API}/mobile/v1/me`, staffToken), (r) => r.json?.endpoint?.status === 'ACTIVE');
  return { inv, personalize: p, me: me.json };
}

async function main() {
  console.log(`E2E against ${API} and simulator ${SIM}\n`);
  const admin = await login('admin@khb.test');
  const issuer = await login('issuer@khb.test');
  const security = await login('security@khb.test');
  const auditor = await login('auditor@khb.test');
  const lakeAdmin = await login('admin@lakeside.test');
  const me = await call('GET', `${API}/api/v1/me`, admin);
  const khb = me.json.hotels.find((h: any) => h.slug === 'k-hotel-bana').id as string;
  const H = `${API}/api/v1/hotels/${khb}`;

  console.log('Setup: connector, discovery, Credential Services');
  const ready0 = await until('connector online', () => call('GET', `${H}/readiness`, admin), (r) => r.json.checks.find((c: any) => c.id === 'connector')?.ok);
  ok(ready0.json.checks.find((c: any) => c.id === 'connector').ok, 'connector is online (outbound channel only)');
  const disc = await call('POST', `${H}/resources/discover`, admin);
  const dcmd = await until('discovery', () => call('GET', `${H}/commands/${disc.json.commandId}`, admin), (r) => ['SUCCEEDED', 'FAILED'].includes(r.json.status));
  ok(dcmd.json.status === 'SUCCEEDED', 'resource discovery through the connector succeeded', dcmd.json.error);
  const doors = (await call('GET', `${H}/resources?kind=door`, admin)).json;
  ok(doors.length >= 30, `discovered ${doors.length} doors`);
  const ready = await until('readiness', () => call('GET', `${H}/readiness`, admin), (r) => r.json.checks.every((c: any) => c.ok), 60_000);
  for (const c of ready.json.checks) ok(c.ok, `readiness: ${c.label}`, c.detail);

  console.log('\nGate: phone onboarding (Credential Services endpoint becomes ACTIVE)');
  const amina = await staffLogin('amina@khb.test');
  const ob = await onboard(amina, 'Pixel 8 (Amina)');
  ok(/^[A-Z0-9]{4}(-[A-Z0-9]{4})+$/.test(ob.inv.json.invitationCode ?? ''), 'invitation code returned to the app only');
  ok(ob.me.endpoint?.status === 'ACTIVE', 'endpoint ACTIVE after vendor callback');
  const aminaEp = ob.me.endpoint.endpointId as string;

  console.log('\nGate: permitted administrator issues a time-limited key for an approved scope');
  const staff = (await call('GET', `${H}/staff`, issuer)).json;
  const sid = (email: string) => staff.find((s: any) => s.email === email).id as string;
  const templates = (await call('GET', `${H}/templates`, issuer)).json;
  const tpl = (name: string) => templates.find((t: any) => t.name === name).id as string;
  const expiresAt = new Date(Date.now() + 8 * 3600_000).toISOString();
  const idem = `e2e-${randomUUID()}`;
  const issue = await call('POST', `${H}/keys`, issuer, { staffId: sid('amina@khb.test'), templateId: tpl('Floor 1 rooms'), expiresAt, reason: 'Morning shift' }, { 'idempotency-key': idem });
  ok(issue.status === 201 && issue.json.status === 'QUEUED', 'key request accepted and queued', issue.json);
  const keyId = issue.json.id as string;

  console.log('\nGate: duplicate requests do not create duplicate credentials');
  const dup = await call('POST', `${H}/keys`, issuer, { staffId: sid('amina@khb.test'), templateId: tpl('Floor 1 rooms'), expiresAt }, { 'idempotency-key': idem });
  ok(dup.status === 200 && dup.json.id === keyId, 'same Idempotency-Key returns the original request (no second key)');
  const second = await call('POST', `${H}/keys`, issuer, { staffId: sid('amina@khb.test'), templateId: tpl('Floor 2 rooms'), expiresAt }, { 'idempotency-key': `e2e-${randomUUID()}` });
  ok(second.status === 409 && second.json.error.code === 'KEY_ALREADY_ACTIVE', 'a second live key for the same person is refused');
  const noIdem = await call('POST', `${H}/keys`, issuer, { staffId: sid('amina@khb.test'), templateId: tpl('Floor 1 rooms'), expiresAt });
  ok(noIdem.status === 400 && noIdem.json.error.code === 'IDEMPOTENCY_KEY_REQUIRED', 'requests without an Idempotency-Key are refused');

  console.log('\nGate: the app receives the credential through the vendor mechanism');
  const issued = await until('ISSUED', () => call('GET', `${H}/keys/${keyId}`, issuer), (r) => ['ISSUED', 'FAILED'].includes(r.json.status));
  ok(issued.json.status === 'ISSUED', 'key ISSUED after Credential Services delivery callback', issued.json.failureMessage);
  ok(/^\d+$/.test(issued.json.credentialId ?? ''), `Visionline credentialID recorded (${issued.json.credentialId})`);
  ok(JSON.stringify(issued.json.resolvedScope.doorIds) === JSON.stringify(issued.json.requestedScope.resolvedDoorIds), 'requested and Visionline-resolved scope both recorded');
  const wallet = (await call('GET', `${API}/mobile/v1/keys`, amina)).json;
  ok(wallet[0]?.status === 'ISSUED' && wallet[0].doors.length === 12, `wallet shows the active key with ${wallet[0]?.doors.length} doors`);
  const onPhone = (await call('GET', `${SIM}/sdk/endpoints/${aminaEp}/keys`)).json;
  ok(onPhone.length === 1, 'credential present in the (simulated) secure element on the phone');

  console.log('\nGate: the credential opens only authorised doors during its validity');
  ok((await tap(aminaEp, '101')).result === 'OPENED', 'Room 101 (in scope) opens');
  ok((await tap(aminaEp, 'Linen Store')).result === 'OPENED', 'Linen Store (in template) opens');
  const t201 = await tap(aminaEp, '201');
  ok(t201.result === 'DENIED', `Room 201 (other floor) denied: ${t201.reason}`);
  ok((await tap(aminaEp, 'GM Office')).result === 'DENIED', 'GM Office denied');
  if (POLLING) console.log('  - first use at a door: needs Credential Services READBACK callbacks, not available in polling mode (on-premises)');
  else {
    const used = await until('readback', () => call('GET', `${H}/keys/${keyId}`, issuer), (r) => Boolean(r.json.firstUsedAt));
    ok(used.json.firstUsedAt, 'first use at a door recorded from the READBACK callback');
  }

  console.log('\nGate: unauthorised users cannot issue, broaden or view outside role and hotel');
  ok((await call('POST', `${H}/keys`, auditor, { staffId: sid('jean@khb.test'), templateId: tpl('Floor 1 rooms'), expiresAt }, { 'idempotency-key': `e2e-${randomUUID()}` })).status === 403, 'Auditor cannot issue keys');
  ok((await call('GET', `${H}/staff`, lakeAdmin)).status === 403, 'another hotel’s administrator cannot see K Hotel Bana staff');
  ok((await call('GET', `${H}/keys/${keyId}`, lakeAdmin)).status === 403, 'another hotel’s administrator cannot read K Hotel Bana keys');
  ok((await call('GET', `${H}/audit`, issuer)).status === 403, 'Key Issuer cannot read the audit log');
  ok((await call('PUT', `${H}/config/features`, admin, { staffMobileKeys: true, guestKeys: true })).status === 400, 'unlicensed module (guest keys) cannot be enabled');

  console.log('\nGate: broad access needs a second person (separation of duties)');
  const jean = await staffLogin('jean@khb.test');
  const jeanOb = await onboard(jean, 'iPhone 15 (Jean)');
  const broad = await call('POST', `${H}/keys`, issuer, { staffId: sid('jean@khb.test'), templateId: tpl('All guest rooms (broad)'), expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(), reason: 'Deep clean' }, { 'idempotency-key': `e2e-${randomUUID()}` });
  ok(broad.json.status === 'PENDING_APPROVAL' && broad.json.isBroad, 'all-room request waits for approval', broad.json);
  ok((await call('POST', `${H}/keys/${broad.json.id}/approve`, issuer, {})).status === 403, 'requester cannot approve own broad request');
  const tooLong = await call('POST', `${H}/keys`, issuer, { staffId: sid('peter@khb.test'), templateId: tpl('All guest rooms (broad)'), expiresAt: new Date(Date.now() + 20 * 3600_000).toISOString() }, { 'idempotency-key': `e2e-${randomUUID()}` });
  ok(tooLong.status === 400 || tooLong.status === 409, 'over-long broad validity refused', tooLong.json?.error);
  const appr = await call('POST', `${H}/keys/${broad.json.id}/approve`, security, { note: 'Approved for deep clean' });
  ok(appr.json.status === 'QUEUED', 'Security Manager approval queues the key');
  const broadIssued = await until('broad ISSUED', () => call('GET', `${H}/keys/${broad.json.id}`, security), (r) => ['ISSUED', 'FAILED'].includes(r.json.status));
  ok(broadIssued.json.status === 'ISSUED', 'approved broad key issued');
  ok((await tap(jeanOb.me.endpoint.endpointId, '305')).result === 'OPENED', 'broad key opens Room 305');

  console.log('\nGate: revocation behaves as documented and is reflected in the portal');
  const rv = await call('POST', `${H}/keys/${keyId}/revoke`, issuer, { reason: 'Shift ended early' });
  ok(rv.json.status === 'REVOKING', 'revoke accepted (checkout per door with credentialID, Web API §7.13.5)');
  const revoked = await until('REVOKED', () => call('GET', `${H}/keys/${keyId}`, issuer), (r) => ['REVOKED', 'ISSUED'].includes(r.json.status) && r.json.status !== 'REVOKING');
  ok(revoked.json.status === 'REVOKED', 'key REVOKED after Credential Services confirmation', revoked.json.failureMessage);
  const after = await tap(aminaEp, '101');
  ok(after.result === 'DENIED', `Room 101 denied after revocation: ${after.reason}`);
  const reissue = await call('POST', `${H}/keys`, issuer, { staffId: sid('amina@khb.test'), templateId: tpl('Floor 2 rooms'), expiresAt }, { 'idempotency-key': `e2e-${randomUUID()}` });
  ok(reissue.status === 201, 'a new key can be issued after revocation');
  await until('reissue', () => call('GET', `${H}/keys/${reissue.json.id}`, issuer), (r) => r.json.status === 'ISSUED');

  console.log('\nGate: Visionline protocol resilience (session expiry, clock skew)');
  await sim({ sessionTtlSec: 1 });
  await sleep(1500);
  let d2 = await call('POST', `${H}/resources/discover`, admin);
  let d2r = await until('discovery after session expiry', () => call('GET', `${H}/commands/${d2.json.commandId}`, admin), (r) => ['SUCCEEDED', 'FAILED'].includes(r.json.status));
  ok(d2r.json.status === 'SUCCEEDED', 'expired session (40103) handled: new session, request re-sent', d2r.json.error);
  await sim({ sessionTtlSec: 1800, clockOffsetSec: 20 * 60 });
  d2 = await call('POST', `${H}/resources/discover`, admin);
  d2r = await until('discovery under skew', () => call('GET', `${H}/commands/${d2.json.commandId}`, admin), (r) => ['SUCCEEDED', 'FAILED'].includes(r.json.status));
  ok(d2r.json.status === 'SUCCEEDED', '20-minute clock skew (40101) handled using the server Date', d2r.json.error);
  await sim({ clockOffsetSec: 0 });

  console.log('\nGate: outages produce safe, visible, recoverable states');
  const peter = await staffLogin('peter@khb.test');
  const peterOb = await onboard(peter, 'Galaxy A55 (Peter)');
  await sim({ visionlineDown: true });
  const down = await call('POST', `${H}/keys`, issuer, { staffId: sid('peter@khb.test'), templateId: tpl('Common areas'), expiresAt }, { 'idempotency-key': `e2e-${randomUUID()}` });
  const downR = await until('outage failure', () => call('GET', `${H}/keys/${down.json.id}`, issuer), (r) => ['FAILED', 'ISSUED'].includes(r.json.status), 60_000);
  ok(downR.json.status === 'FAILED' && downR.json.failureCode === 'VISIONLINE_UNREACHABLE', `Visionline outage → FAILED with actionable message: "${downR.json.failureMessage}"`);
  await sim({ visionlineDown: false });
  const retry = await call('POST', `${H}/keys`, issuer, { staffId: sid('peter@khb.test'), templateId: tpl('Common areas'), expiresAt }, { 'idempotency-key': `e2e-${randomUUID()}` });
  const retryR = await until('after outage', () => call('GET', `${H}/keys/${retry.json.id}`, issuer), (r) => ['FAILED', 'ISSUED'].includes(r.json.status));
  ok(retryR.json.status === 'ISSUED', 'after Visionline recovers, issuing works again');
  ok((await tap(peterOb.me.endpoint.endpointId, 'Main Entrance')).result === 'OPENED', 'Peter opens the Main Entrance');

  console.log('\nGate: Visionline rejections are explained (vendor error mapping)');
  await call('POST', `${H}/keys/${retry.json.id}/revoke`, issuer, { reason: 'test' });
  await until('peter revoked', () => call('GET', `${H}/keys/${retry.json.id}`, issuer), (r) => r.json.status === 'REVOKED');
  await sim({ failNextCard: 40308 });
  const rej = await call('POST', `${H}/keys`, issuer, { staffId: sid('peter@khb.test'), templateId: tpl('Common areas'), expiresAt }, { 'idempotency-key': `e2e-${randomUUID()}` });
  const rejR = await until('rejection', () => call('GET', `${H}/keys/${rej.json.id}`, issuer), (r) => ['FAILED', 'ISSUED'].includes(r.json.status));
  ok(rejR.json.failureCode === 'VALIDITY_TOO_LONG' && /40308/.test(rejR.json.failureMessage), `Visionline 40308 → "${rejR.json.failureMessage}"`);

  console.log('\nGate: device replacement');
  const rm = await call('POST', `${H}/staff/${sid('amina@khb.test')}/endpoint/remove`, admin, {});
  ok(rm.status === 200, 'old phone removed from Credential Services');
  const gone = await until('reissued key revoked by endpoint deletion', () => call('GET', `${H}/keys/${reissue.json.id}`, issuer), (r) => r.json.status === 'REVOKED');
  ok(gone.json.status === 'REVOKED', 'keys on the removed phone are revoked');
  const ob2 = await onboard(amina, 'New phone (Amina)');
  ok(ob2.me.endpoint?.status === 'ACTIVE' && ob2.me.endpoint.endpointId !== aminaEp, 'new phone onboarded with a new endpoint');


  // ======================= Iteration 2 =======================
  const seal = async (purpose: 'property' | 'operator', username: string, password: string, operatorId?: string) => {
    const k = (await call('GET', `${H}/connector/sealing-key`, admin)).json;
    return sealForConnector(k.publicKey, JSON.stringify({ purpose, hotelId: khb, operatorId, username, password, ts: new Date().toISOString() }));
  };
  const waitCmd = (id: string, token = admin) => until('command', () => call('GET', `${H}/commands/${id}`, token), (r) => ['SUCCEEDED', 'FAILED', 'EXPIRED'].includes(r.json.status));

  console.log('\nGate: property Visionline credentials entered in the portal (sealed for the connector)');
  const badProp = await call('PUT', `${H}/visionline/property-credentials`, admin, { username: 'sym', sealed: await seal('property', 'sym', 'wrong-password') });
  ok((await waitCmd(badProp.json.commandId)).json.status === 'FAILED', 'wrong property password is rejected by Visionline and NOT stored');
  const goodProp = await call('PUT', `${H}/visionline/property-credentials`, admin, { username: 'sym', sealed: await seal('property', 'sym', 'sym-dev-password') });
  ok((await waitCmd(goodProp.json.commandId)).json.status === 'SUCCEEDED', 'property operator "sym" accepted and stored on the connector');
  const hp = await until('health shows sym', () => call('GET', `${H}/readiness`, admin), (r) => r.json.connectorHealth?.propertyUsername === 'sym');
  ok(hp.json.connectorHealth.propertyUsername === 'sym', 'connector health reports property operator "sym" (password never leaves the connector)');
  const cmdRow = (await call('GET', `${H}/commands/${goodProp.json.commandId}`, admin)).json;
  ok(!JSON.stringify(cmdRow).includes('sym-dev-password'), 'the stored command contains no readable password');

  console.log('\nGate: personal Visionline credentials per operator');
  const issuerMe = (await call('GET', `${API}/api/v1/me`, issuer)).json;
  const badPers = await call('PUT', `${H}/me/visionline-credentials`, issuer, { username: 'eric', sealed: await seal('operator', 'eric', 'nope', issuerMe.id) });
  await waitCmd(badPers.json.commandId);
  ok((await call('GET', `${H}/me/visionline-credentials`, issuer)).json.credential.status === 'FAILED', 'wrong personal password shows as not verified');
  const goodPers = await call('PUT', `${H}/me/visionline-credentials`, issuer, { username: 'eric', sealed: await seal('operator', 'eric', 'eric-dev-password', issuerMe.id) });
  await waitCmd(goodPers.json.commandId);
  ok((await call('GET', `${H}/me/visionline-credentials`, issuer)).json.credential.status === 'VERIFIED', 'personal credentials verified against Visionline');
  const stolen = await call('PUT', `${H}/me/visionline-credentials`, security, { username: 'eric', sealed: await seal('operator', 'eric', 'eric-dev-password', issuerMe.id) });
  await waitCmd(stolen.json.commandId);
  ok((await call('GET', `${H}/me/visionline-credentials`, security)).json.credential.status === 'FAILED', 'a blob sealed for one operator cannot be used by another');

  console.log('\nGate: change doors (Visionline override; "revoke mobile key when overridden")');
  const amina2 = await staffLogin('amina@khb.test');
  const aminaEp2 = (await call('GET', `${API}/mobile/v1/me`, amina2)).json.endpoint.endpointId as string;
  const k1 = await call('POST', `${H}/keys`, issuer, { staffId: sid('amina@khb.test'), templateId: tpl('Floor 1 rooms'), expiresAt }, { 'idempotency-key': `e2e-${randomUUID()}` });
  const k1i = await until('k1', () => call('GET', `${H}/keys/${k1.json.id}`, issuer), (r) => ['ISSUED', 'FAILED'].includes(r.json.status));
  ok(k1i.json.status === 'ISSUED' && k1i.json.issuedAs === 'eric', `key issued under the operator's own Visionline name (${k1i.json.issuedAs})`);
  const simCard = (await call('GET', `${SIM}/sim/state`)).json.cards.find((c: any) => String(c.credentialID) === k1i.json.credentialId);
  ok(simCard?.issuedBy === 'eric', 'Visionline (simulated) records operator "eric" as the issuer');
  ok((await tap(aminaEp2, '101')).result === 'OPENED', 'Room 101 opens before the change');
  const rep = await call('POST', `${H}/keys/${k1.json.id}/replace`, issuer, { templateId: tpl('Floor 2 rooms'), expiresAt, reason: 'Moved to floor 2' }, { 'idempotency-key': `e2e-${randomUUID()}` });
  ok(rep.status === 201 && rep.json.status === 'QUEUED', 'change-doors request queued without revoking first');
  const repI = await until('replacement', () => call('GET', `${H}/keys/${rep.json.id}`, issuer), (r) => ['ISSUED', 'FAILED'].includes(r.json.status));
  ok(repI.json.status === 'ISSUED', 'replacement key ISSUED', repI.json.failureMessage);
  const oldK = await until('old revoked', () => call('GET', `${H}/keys/${k1.json.id}`, issuer), (r) => r.json.status === 'REVOKED');
  ok(oldK.json.status === 'REVOKED', 'old key removed from the phone by Visionline override (no separate revoke)');
  ok((await tap(aminaEp2, '101')).result === 'DENIED' && (await tap(aminaEp2, '201')).result === 'OPENED', 'Room 101 now refused, Room 201 opens');

  console.log('\nGate: several Visionline user groups');
  const ug = await call('POST', `${H}/visionline/user-groups`, admin, { userGroup: 'Night Audit' });
  ok((await waitCmd(ug.json.commandId)).json.status === 'SUCCEEDED', 'user group "Night Audit" created in Visionline from the portal');
  const ugs = (await call('GET', `${H}/resources?kind=usergroup`, admin)).json.map((g: any) => g.external_id);
  ok(['Housekeeping', 'Maintenance', 'Security', 'Night Audit'].every((g) => ugs.includes(g)), `user groups known: ${ugs.join(', ')}`);
  const peterKeys = (await call('GET', `${H}/keys?staffId=${sid('peter@khb.test')}&status=ISSUED,ISSUING,QUEUED`, issuer)).json;
  for (const k of peterKeys) await call('POST', `${H}/keys/${k.id}/revoke`, issuer, { reason: 'test reset' });
  await sleep(2500);
  const mr = await call('POST', `${H}/keys`, issuer, { staffId: sid('peter@khb.test'), templateId: tpl('Maintenance rounds'), expiresAt }, { 'idempotency-key': `e2e-${randomUUID()}` });
  ok(mr.status === 201 && mr.json.requestedScope.resolvedDoorIds.length === 13, `role-based template adds the Maintenance group's doors (${mr.json.requestedScope?.resolvedDoorIds?.length} doors)`, mr.json);

  console.log('\nGate: uniform-access user group (Security)');
  const brice = await staffLogin('brice@khb.test');
  const briceOb = await onboard(brice, 'Pixel 7 (Brice)');
  const bk = await call('POST', `${H}/keys`, issuer, { staffId: sid('brice@khb.test'), templateId: tpl('Common areas'), expiresAt }, { 'idempotency-key': `e2e-${randomUUID()}` });
  ok(bk.status === 201 && bk.json.requestedScope.uniformGroup === 'Security' && bk.json.requestedScope.resolvedDoorIds.length === 4, 'scope comes from the uniform-access group, not the template', bk.json);
  const bki = await until('brice key', () => call('GET', `${H}/keys/${bk.json.id}`, issuer), (r) => ['ISSUED', 'FAILED'].includes(r.json.status));
  ok(bki.json.status === 'ISSUED', 'uniform-access key issued (doorOperations omitted, Web API §5.29.3)', bki.json.failureMessage);
  ok((await tap(briceOb.me.endpoint.endpointId, 'GM Office')).result === 'OPENED', 'Security group door (GM Office) opens');

  console.log('\nGate: personal credentials can be required');
  const vlc = (await call('GET', `${H}/config/visionline`, admin)).json.data;
  await call('PUT', `${H}/config/visionline`, admin, { ...vlc, requirePersonalCredentials: true });
  const noCred = await call('POST', `${H}/keys`, admin, { staffId: sid('jean@khb.test'), templateId: tpl('Floor 1 rooms'), expiresAt }, { 'idempotency-key': `e2e-${randomUUID()}` });
  ok(noCred.status === 409 && noCred.json.error.code === 'PERSONAL_CREDENTIALS_REQUIRED', 'an operator without personal credentials cannot issue');
  await call('PUT', `${H}/config/visionline`, admin, { ...vlc, requirePersonalCredentials: false });
  ok(vlc.mobileAccessUuid === 9 && vlc.revokeMode === 'overridden', 'Visionline Mobile Access options recorded (UUID 9, revoke when overridden)');

  console.log('\nGate: staff import with preview');
  const rows = [
    { fullName: 'Import One', email: 'import1@khb.test', jobRole: 'Housekeeper', userGroup: 'Housekeeping' },
    { fullName: 'Import Two', email: 'import2@khb.test', employeeNo: 'E2002' },
    { fullName: 'Amina Uwase', email: 'amina@khb.test' },
    { fullName: 'Bad Group', email: 'bad@khb.test', userGroup: 'Nope' },
  ];
  const dry = (await call('POST', `${H}/staff/import`, admin, { rows, mode: 'skip', dryRun: true })).json;
  ok(dry.summary.create === 2 && dry.summary.skip === 1 && dry.summary.invalid === 1, `preview: ${JSON.stringify(dry.summary)}`);
  const before = (await call('GET', `${H}/staff`, admin)).json.length;
  const applied = (await call('POST', `${H}/staff/import`, admin, { rows, mode: 'skip', dryRun: false })).json;
  const afterCount = (await call('GET', `${H}/staff`, admin)).json.length;
  ok(applied.summary.create === 2 && afterCount === before + 2, 'import created 2 staff, skipped the existing one, rejected the bad row');

  // ---- Iteration 3: Visionline watch, wrong doors, cancel card, start time ---------------------------
  const clearKeys = async (email: string) => {
    for (const k of (await call('GET', `${H}/keys?staffId=${sid(email)}&status=SCHEDULED,QUEUED,ISSUING,ISSUED,PENDING_APPROVAL`, issuer)).json)
      await call('POST', `${H}/keys/${k.id}/revoke`, issuer, { reason: 'test reset' });
    await until(`${email} keys cleared`, () => call('GET', `${H}/keys?staffId=${sid(email)}&status=SCHEDULED,QUEUED,ISSUING,ISSUED,PENDING_APPROVAL,REVOKING`, issuer), (r) => r.json.length === 0);
  };
  const issueFor = async (email: string, body: Record<string, unknown>) => {
    const r = await call('POST', `${H}/keys`, issuer, { staffId: sid(email), expiresAt, ...body }, { 'idempotency-key': `e2e-${randomUUID()}` });
    if (r.status !== 201) return r.json;
    return (await until('key ISSUED', () => call('GET', `${H}/keys/${r.json.id}`, issuer), (x) => ['ISSUED', 'FAILED'].includes(x.json.status))).json;
  };
  const jeanEp = jeanOb.me.endpoint.endpointId as string;

  console.log('\nGate: Visionline watch (cards cancelled in Visionline leave the app)');
  const rw = await until('watch running', () => call('GET', `${H}/readiness`, admin), (r) => r.json.checks.find((c: any) => c.id === 'watch')?.ok);
  ok(rw.json.checks.find((c: any) => c.id === 'watch')?.ok, 'connector is watching Visionline /callback (Web API §7.14)', rw.json.checks.find((c: any) => c.id === 'watch'));
  await clearKeys('jean@khb.test');
  const wk = await issueFor('jean@khb.test', { templateId: tpl('Floor 1 rooms') });
  ok(wk.status === 'ISSUED' && wk.regNo && wk.regNo !== wk.credentialId, `key issued: card reg. no. ${wk.regNo} looked up in Visionline (credential ID ${wk.credentialId} is different)`, { regNo: wk.regNo, cred: wk.credentialId });
  const desk = await call('POST', `${SIM}/sim/cards/${wk.credentialId}/cancel`, undefined, {});
  ok(desk.status === 200, 'card cancelled at the Visionline desk (outside the platform)');
  const wkr = await until('key revoked by watch', () => call('GET', `${H}/keys/${wk.id}`, issuer), (r) => r.json.status === 'REVOKED');
  ok(wkr.json.status === 'REVOKED' && wkr.json.revokeSource === 'visionline', 'platform revoked the key when the connector reported the cancellation', { status: wkr.json.status, src: wkr.json.revokeSource });
  const jeanKeys = (await call('GET', `${API}/mobile/v1/keys`, jean)).json;
  ok(jeanKeys.find((k: any) => k.id === wk.id)?.status === 'REVOKED', 'the staff app shows the key as removed');
  const jeanNotes = (await call('GET', `${API}/mobile/v1/notifications`, jean)).json;
  ok(jeanNotes.some((n: any) => /cancelled in the hotel lock system/.test(n.body)), 'staff member notified');

  console.log('\nGate: more than 5 wrong-door attempts cancel the card automatically');
  const wd = await issueFor('jean@khb.test', { templateId: tpl('Floor 1 rooms') });
  ok(wd.status === 'ISSUED', 'new key issued (new reg. no.)', wd.status);
  ok(wd.regNo !== wk.regNo, `new reg. no. ${wd.regNo} differs from ${wk.regNo}`);
  for (const d of ['201', '202', '203', '204', '205']) ok((await tap(jeanEp, d)).result === 'DENIED', `door ${d} refused (event 320)`);
  const five = await until('5 attempts counted', () => call('GET', `${H}/keys/${wd.id}`, issuer), (r) => r.json.wrongDoorCount >= 5);
  ok(five.json.wrongDoorCount === 5 && five.json.status === 'ISSUED', 'after 5 attempts the key still works (limit is "more than 5")', { n: five.json.wrongDoorCount, s: five.json.status });
  ok((await tap(jeanEp, '101')).result === 'OPENED', 'room 101 still opens');
  await tap(jeanEp, '206');
  const six = await until('auto-cancel', () => call('GET', `${H}/keys/${wd.id}`, issuer), (r) => r.json.status === 'REVOKED');
  ok(six.json.status === 'REVOKED' && six.json.revokeSource === 'wrong_door' && six.json.revokeMethod === 'cancelCard', '6th wrong door → card cancelled in Visionline and key revoked', { s: six.json.status, src: six.json.revokeSource });
  const wdCard = (await call("GET", `${SIM}/sim/state`)).json.cards.find((c: any) => String(c.credentialID) === String(wd.credentialId));
  ok(wdCard?.cancelled === true && String(wdCard?.cardId) === String(wd.regNo), 'Visionline card is cancelled by its reg. no. (POST /cards/{reg. no.} cancelled=true, §7.7.4)');
  ok((await tap(jeanEp, '101')).result === 'DENIED', 'room 101 no longer opens');
  ok((six.json.lockEvents ?? []).filter((e: any) => e.event_code === 320).length >= 6, 'key detail lists the refused doors', six.json.lockEvents?.length);

  console.log('\nGate: revoke by cancelling the card');
  const ck = await issueFor('jean@khb.test', { templateId: tpl('Floor 1 rooms') });
  await call('POST', `${H}/keys/${ck.id}/revoke`, issuer, { reason: 'Lost phone', method: 'cancelCard' });
  const ckr = await until('cancelCard revoke', () => call('GET', `${H}/keys/${ck.id}`, issuer), (r) => r.json.status === 'REVOKED');
  ok(ckr.json.status === 'REVOKED' && ckr.json.revokeMethod === 'cancelCard', 'operator can revoke by cancelling the card instead of check-out');

  console.log('\nGate: start and end time');
  const vl3 = (await call('GET', `${H}/config/visionline`, admin)).json.data;
  const startLater = new Date(Date.now() + 2 * 3600_000).toISOString();
  const endLater = new Date(Date.now() + 6 * 3600_000).toISOString();
  const held = await call('POST', `${H}/keys`, issuer, { staffId: sid('jean@khb.test'), templateId: tpl('Floor 1 rooms'), startsAt: startLater, expiresAt: endLater }, { 'idempotency-key': `e2e-${randomUUID()}` });
  ok(held.json.status === 'SCHEDULED', 'default: a future key is held by the platform until its start time (Web API §7.6.2)', held.json.status);
  await call('POST', `${H}/keys/${held.json.id}/revoke`, issuer, { reason: 'test' });
  await call('PUT', `${H}/config/visionline`, admin, { ...vl3, startTimeMode: 'send' });
  const sent = await issueFor('jean@khb.test', { templateId: tpl('Floor 1 rooms'), startsAt: startLater, expiresAt: endLater });
  ok(sent.status === 'ISSUED' && sent.resolvedScope?.startTimeLocal, `"send" mode: created now with startTime ${sent.resolvedScope?.startTimeLocal}`, sent);
  ok((await tap(jeanEp, '101')).reason === 'Key not yet valid', 'the lock refuses the key before its start time');
  await call('PUT', `${H}/config/visionline`, admin, { ...vl3, startTimeMode: 'hold' });
  await clearKeys('jean@khb.test');

  if (!SKIP_SLOW) {
    console.log('\nGate: automatic expiry (takes about 2 minutes)');
    // Earlier gates may leave Amina with a live key; Visionline allows one staff key per person.
    for (const k of (await call('GET', `${H}/keys?staffId=${sid('amina@khb.test')}&status=SCHEDULED,QUEUED,ISSUING,ISSUED,PENDING_APPROVAL`, issuer)).json)
      await call('POST', `${H}/keys/${k.id}/revoke`, issuer, { reason: 'test reset' });
    await until('amina keys cleared', () => call('GET', `${H}/keys?staffId=${sid('amina@khb.test')}&status=SCHEDULED,QUEUED,ISSUING,ISSUED,PENDING_APPROVAL,REVOKING`, issuer), (r) => r.json.length === 0);
    const shortExp = new Date(Date.now() + 2 * 60_000 + 5_000).toISOString();
    const sk = await call('POST', `${H}/keys`, issuer, { staffId: sid('amina@khb.test'), doorIds: ['102'], expiresAt: shortExp }, { 'idempotency-key': `e2e-${randomUUID()}` });
    if (sk.status !== 201) console.log('    short key request:', JSON.stringify(sk.json));
    await until('short ISSUED', () => call('GET', `${H}/keys/${sk.json.id}`, issuer), (r) => r.json.status === 'ISSUED');
    const ep2 = ob2.me.endpoint.endpointId;
    ok((await tap(ep2, '102')).result === 'OPENED', 'short key opens Room 102 while valid');
    const exp = await until('EXPIRED', () => call('GET', `${H}/keys/${sk.json.id}`, issuer), (r) => r.json.status === 'EXPIRED', 200_000);
    ok(exp.json.status === 'EXPIRED', 'portal shows EXPIRED after the validity window');
    const t = await tap(ep2, '102');
    ok(t.result === 'DENIED', `lock refuses the expired key: ${t.reason}`);
  }

  // ---- Phase 2 -------------------------------------------------------------------------------------
  console.log('\nPhase 2: modules');
  const maint = await login('maint@khb.test');
  const tech = await login('tech@khb.test');
  const peterApp = await staffLogin('peter@khb.test');
  const features = (await call('GET', `${H}/config/features`, admin)).json.data;
  ok((await call('GET', `${H}/battery`, maint)).status === 409, 'battery screen answers "module off" until the hotel switches it on');
  const fOn = await call('PUT', `${H}/config/features`, admin, { ...features, batteryMonitoring: true, maintenance: true });
  ok(fOn.status === 200, 'battery monitoring and maintenance switched on (connector 0.5.0 reports battery events)', fOn.json);
  ok((await call('PUT', `${H}/config/features`, admin, { ...features, batteryMonitoring: true, maintenance: true, guestKeys: true })).status === 400, 'Phase 3 modules still cannot be switched on');
  ok((await call('GET', `${H}/battery`, lakeAdmin)).status === 403, 'another hotel cannot read K Hotel Bana batteries');

  console.log('\nPhase 2: battery alarms from lock events');
  const battery = (body: unknown, door: string) => call('POST', `${SIM}/sim/doors/${encodeURIComponent(door)}/battery`, undefined, body);
  const bdoor = async (id: string) => (await call('GET', `${H}/battery`, tech)).json.doors.find((d: any) => d.doorId === id);
  const peterNotes = async () => (await call('GET', `${API}/mobile/v1/notifications`, peterApp)).json as any[];
  await battery({ kind: 'low' }, '104');
  const low104 = await until('104 LOW', () => bdoor('104'), (d) => d?.state === 'LOW');
  ok(low104?.state === 'LOW' && low104.alert?.severity === 'LOW' && low104.lastEvent?.code === 304, 'event 304 → room 104 Low, alert opened', low104);
  await battery({ kind: 'low' }, '104');
  const again104 = await until('104 repeat', () => bdoor('104'), (d) => d?.alert?.occurrences === 2);
  ok(again104?.alert?.occurrences === 2, 'a repeated alarm updates the same alert (duplicate suppressed)');
  ok((await peterNotes()).filter((n) => /battery low/.test(n.title) && /^104/.test(n.body)).length === 1, 'the maintenance team is told once, in the app');

  await battery({ kind: 'critical' }, 'Linen Store');
  const crit = await until('Linen Store CRITICAL', () => bdoor('Linen Store'), (d) => d?.state === 'CRITICAL' && d?.ticket);
  ok(crit?.alert?.severity === 'CRITICAL' && crit.ticket?.number > 0, `event 305 → critical alert and maintenance request #${crit?.ticket?.number} opened automatically`, crit);
  await battery({ kind: 'low' }, '105');
  await until('105 LOW', () => bdoor('105'), (d) => d?.state === 'LOW');
  await battery({ kind: 'critical' }, '105');
  const esc105 = await until('105 escalated', () => bdoor('105'), (d) => d?.alert?.severity === 'CRITICAL');
  ok(esc105?.alert?.severity === 'CRITICAL' && esc105.alert.occurrences === 2 && esc105.ticket, 'low then critical → the alert escalates and gets a request', esc105?.alert);

  await battery({ kind: 'volts', volts: 7.2 }, '201');
  const v201 = await until('201 volts', () => bdoor('201'), (d) => d?.voltsBelow != null);
  ok(v201?.state === 'REPORTED' && v201.voltsBelow === 7.2 && !v201.alert, '"below 7.2 volts" without hotel thresholds is shown as a reading only', v201);
  const pol = (await call('GET', `${H}/config/policy`, admin)).json.data;
  await call('PUT', `${H}/config/policy`, admin, { ...pol, battery: { staleAfterDays: 30, autoTicket: 'critical', voltage: { highRange: { low: 7.4, critical: 6.6 }, lowRange: { low: null, critical: null } } } });
  await battery({ kind: 'volts', volts: 7.2 }, '202');
  const v202 = await until('202 LOW', () => bdoor('202'), (d) => d?.state === 'LOW');
  ok(v202?.state === 'LOW' && v202.alert, 'with a 7.4 V warning threshold, "below 7.2 volts" raises a Low alert', v202);

  ok((await call('POST', `${H}/battery/alerts/${low104.alert.id}/acknowledge`, tech)).status === 403, 'a technician cannot acknowledge alerts (battery.manage)');
  ok((await call('POST', `${H}/battery/alerts/${low104.alert.id}/acknowledge`, maint)).status === 200, 'the maintenance manager acknowledges the alert');
  ok((await bdoor('104'))?.alert?.status === 'ACKNOWLEDGED', 'alert shows as acknowledged');

  await battery({ kind: 'exchanged' }, 'Linen Store');
  const ex = await until('Linen Store GOOD', () => bdoor('Linen Store'), (d) => d?.state === 'GOOD');
  ok(ex?.state === 'GOOD' && !ex.alert, 'event 528 battery exchanged → Good, alert resolved');
  const critTicket = (await call('GET', `${H}/maintenance/tickets/${crit.ticket.id}`, maint)).json;
  ok(critTicket.status === 'RESOLVED' && /Battery exchanged/.test(critTicket.resolution ?? ''), 'its maintenance request was resolved automatically', critTicket.status);
  const hist = (await call('GET', `${H}/battery/doors/${encodeURIComponent('Linen Store')}/history`, tech)).json;
  ok(hist.readings.length === 2 && hist.alerts[0]?.status === 'RESOLVED', 'door history lists both readings and the resolved alert');
  const att = (await call('GET', `${H}/attention`, maint)).json;
  ok(att.battery?.critical >= 1 && att.maintenance?.open >= 1, 'attention counts for the navigation', att);

  console.log('\nPhase 2: maintenance requests');
  const peterId = sid('peter@khb.test');
  const mk = await call('POST', `${H}/maintenance/tickets`, maint, { title: 'Door closer leaking', description: 'Oil on the floor', category: 'door', priority: 'high', doorId: '101', assigneeStaffId: peterId });
  ok(mk.status === 200 && mk.json.number > 0 && mk.json.assigneeName === 'Peter Otieno' && mk.json.location?.includes('Floor 1'), `manager opened request #${mk.json.number} for room 101 and assigned it to Peter`, mk.json);
  ok(new Date(mk.json.dueAt).getTime() - Date.now() < 25 * 3600_000, 'due time follows the hotel policy for "high" (24 h)');
  ok((await call('POST', `${H}/maintenance/tickets`, tech, { title: 'Something', assigneeStaffId: peterId })).status === 403, 'a technician cannot assign requests');
  const ptasks = (await call('GET', `${API}/mobile/v1/tasks`, peterApp)).json;
  ok(ptasks.enabled && ptasks.tasks.some((t: any) => t.id === mk.json.id), "the request appears in Peter's app under My tasks");
  ok((await peterNotes()).some((n) => n.title === `New task #${mk.json.number}`), 'Peter is notified in the app');
  const st = (s: string, note?: string, extra: object = {}) => call('POST', `${API}/mobile/v1/tasks/${mk.json.id}/status`, peterApp, { status: s, note, ...extra });
  ok((await st('ACKNOWLEDGED')).json.status === 'ACKNOWLEDGED', 'Peter acknowledges from the app');
  ok((await st('IN_PROGRESS')).json.status === 'IN_PROGRESS', 'Peter starts the work');
  ok((await call('POST', `${API}/mobile/v1/tasks/${mk.json.id}/comments`, peterApp, { body: 'Needs a new closer arm, ordered.' })).status === 200, 'Peter comments');
  ok((await st('RESOLVED')).status === 400, 'resolving needs a note on what was done');
  ok((await st('RESOLVED', 'Replaced the closer arm')).json.status === 'RESOLVED', 'Peter resolves with a note');
  ok((await st('CLOSED')).status === 403, 'staff cannot close a request; a manager does');
  const closed = await call('POST', `${H}/maintenance/tickets/${mk.json.id}/status`, maint, { status: 'CLOSED' });
  ok(closed.json.status === 'CLOSED', 'the maintenance manager closes it');
  const kinds = closed.json.activity.map((a: any) => a.kind);
  ok(['created', 'assigned', 'status', 'comment'].every((k) => kinds.includes(k)) && closed.json.activity.length >= 7, `resolution history has ${closed.json.activity.length} entries`);

  const jean2 = await staffLogin('jean@khb.test');
  const report = await call('POST', `${API}/mobile/v1/reports`, jean2, { title: 'Bathroom light flickers', location: 'Room 203', category: 'electrical' });
  ok(report.status === 200 && report.json.source === 'app' && report.json.doorId === '203' && !report.json.assigneeStaffId, 'a housekeeper reports a problem from the app; "Room 203" is linked to door 203', report.json);
  ok((await peterNotes()).some((n) => n.title === `New maintenance request #${report.json.number}`), 'the maintenance team hears about the new unassigned request');
  ok((await call('POST', `${API}/mobile/v1/tasks/${report.json.id}/status`, jean2, { status: 'ACKNOWLEDGED' })).status === 403, 'the reporter cannot work on a request that is not assigned to them');
  ok((await call('GET', `${API}/mobile/v1/tasks/${report.json.id}`, jean2)).status === 200, 'but can follow it');
  const found = (await call('GET', `${H}/maintenance/tickets?q=203`, tech)).json;
  ok(found.some((t: any) => t.id === report.json.id), 'search by room finds it');
  ok((await call('GET', `${H}/maintenance/tickets?q=%23${report.json.number}`, tech)).json.length === 1, 'search by #number finds it');

  const bt = await call('POST', `${H}/battery/alerts/${low104.alert.id}/ticket`, maint, { assigneeStaffId: peterId });
  ok(bt.status === 200 && bt.json.category === 'battery', `manager opened request #${bt.json.number} for the room 104 alert`, bt.json);
  await call('POST', `${API}/mobile/v1/tasks/${bt.json.id}/status`, peterApp, { status: 'IN_PROGRESS' });
  const btr = await call('POST', `${API}/mobile/v1/tasks/${bt.json.id}/status`, peterApp, { status: 'RESOLVED', note: 'New batteries fitted', batteryReplaced: true });
  ok(btr.json.status === 'RESOLVED', 'Peter resolves it as "battery replaced"');
  const d104 = await bdoor('104');
  ok(d104?.state === 'GOOD' && !d104.alert, 'room 104 shows Good and its alert is resolved', d104);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64').toString('base64');
  const up = await call('POST', `${H}/maintenance/tickets/${report.json.id}/attachments`, tech, { filename: 'light.png', dataBase64: png });
  ok(up.status === 200 && up.json.attachments.length === 1, 'technician attaches a photo');
  ok((await call('POST', `${H}/maintenance/tickets/${report.json.id}/attachments`, tech, { filename: 'x.html', dataBase64: Buffer.from('<script>alert(1)</script>').toString('base64') })).status === 400, 'other file types are refused (checked by content, not by name)');
  const dl = await fetch(`${H}/maintenance/tickets/${report.json.id}/attachments/${up.json.attachments[0].id}`, { headers: { authorization: `Bearer ${auditor}` } });
  ok(dl.status === 200 && dl.headers.get('content-type') === 'image/png' && dl.headers.get('x-content-type-options') === 'nosniff' && /attachment/.test(dl.headers.get('content-disposition') ?? ''), 'attachment downloads as a file with its checked type');
  await call('POST', `${H}/maintenance/tickets`, tech, { title: '=HYPERLINK("http://x","y")', location: 'Lobby' });
  const mcsv = await fetch(`${H}/maintenance/export`, { headers: { authorization: `Bearer ${auditor}` } }).then((r) => r.text());
  ok(mcsv.includes(`"'=HYPERLINK(""http://x"",""y"")"`) && !/\n[^\n]*,=HYPERLINK/.test(mcsv), 'export neutralises spreadsheet formulas');
  const bcsv = await fetch(`${H}/battery/export`, { headers: { authorization: `Bearer ${auditor}` } }).then((r) => r.text());
  ok(bcsv.split('\n').length >= 9 && bcsv.includes('Battery level critically low'), 'battery history exports as CSV');
  ok((await call('GET', `${H}/maintenance/tickets`, lakeAdmin)).status === 403, 'another hotel cannot read K Hotel Bana requests');

  // ---- 2.5: Visionline directory and management reports ----------------------------------------------
  console.log('\n2.5: people, keycards and alarms from Visionline (read-only) and management reports');
  const gm = await login('gm@khb.test');
  ok((await call('GET', `${H}/insights`, tech)).status === 403, 'a technician cannot open management reports');
  ok((await call('POST', `${H}/insights/sync`, gm)).status === 403, 'hotel management reads reports but cannot start a Visionline read');
  const vl5 = (await call('GET', `${H}/config/visionline`, admin)).json.data;
  const off = await call('POST', `${H}/insights/sync`, admin);
  ok(off.status === 409 && off.json.error?.code === 'SYNC_OFF', 'reading people from Visionline is off until the hotel switches it on', off.json);
  const dsOn = await call('PUT', `${H}/config/visionline`, admin, { ...vl5, directorySync: { enabled: true, scope: 'all', includeCards: true, includeAlarms: true, everyHours: 24, maxUsers: 3000 } });
  ok(dsOn.status === 200, 'directory sync switched on (Settings -> Reports & sync)', dsOn.json);
  const syncReq = await call('POST', `${H}/insights/sync`, admin);
  ok(syncReq.status === 200 && syncReq.json.syncId, 'Visionline read requested through the connector', syncReq.json);
  const sync = await until('directory sync', () => call('GET', `${H}/insights/syncs`, gm), (r) => ['SUCCEEDED', 'FAILED'].includes(r.json[0]?.status), 60_000);
  const s0 = sync.json[0];
  ok(s0.status === 'SUCCEEDED' && s0.users >= 13 && s0.cards >= 10 && s0.alarms >= 1, `read ${s0.users} users, ${s0.cards} valid keycards, ${s0.alarms} alarms`, s0);
  const ins = await call('GET', `${H}/insights?days=30`, gm);
  ok(ins.status === 200 && ins.json.kpis && ins.json.cards?.byGroup?.length >= 3, 'hotel management sees the overview (KPIs, keycards per user group)', ins.json.kpis);
  const hk = ins.json.cards.byGroup.find((g: any) => g.group === 'Housekeeping');
  ok(hk && hk.people >= 5 && hk.validCards >= 1, `Housekeeping: ${hk?.people} people, ${hk?.validCards} valid keycards`, hk);
  ok(Array.isArray(ins.json.locks?.byDoor) && Array.isArray(ins.json.battery?.draining) && Array.isArray(ins.json.maintenance?.byStatus), 'lock alarms, battery life and maintenance sections present');
  const members = await call('GET', `${H}/insights/user-groups/Housekeeping`, gm);
  ok(members.status === 200 && members.json.length >= 5 && members.json.every((p: any) => Array.isArray(p.cards)), `user group drill-down lists ${members.json.length} people with their keycards`);
  const valid = await call('GET', `${H}/insights/valid-cards`, gm);
  ok(valid.status === 200 && valid.json.length >= 10 && !valid.json.some((c: any) => /cancel/i.test(c.regNo ?? '')), `valid keycards report: ${valid.json.length} cards`);
  const exports: Record<string, string> = {};
  for (const r of ['valid-cards', 'user-groups', 'lock-activity', 'battery-life', 'departments', 'maintenance-workload']) {
    const res = await fetch(`${H}/insights/export/${r}?days=30`, { headers: { authorization: `Bearer ${gm}` } });
    const raw = Buffer.from(await res.arrayBuffer());
    exports[r] = raw.toString('utf8');
    ok(res.status === 200 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf && /^\uFEFF[a-z_]+,/.test(exports[r]), `export ${r}.csv (opens in Excel with accents intact)`, exports[r].slice(0, 120));
  }
  const everything = JSON.stringify([members.json, valid.json, ins.json]) + Object.values(exports).join('');
  ok(!/4321|@staff\.example|\+237 6 99|badge 77/.test(everything), 'PINs, e-mails, phone numbers and user details from Visionline are never copied');
  ok((await call('GET', `${H}/insights`, lakeAdmin)).status === 403, 'another hotel cannot read K Hotel Bana reports');

  // ---- 2.6: event log, PDF reports, any hotel ------------------------------------------------------------
  console.log('\n2.6: event log (all / entrance / error events), PDF only, verifiable; any hotel');
  const evFrom = new Date(Date.now() - 6 * 3600_000).toISOString(), evTo = new Date(Date.now() + 60_000).toISOString();
  const evq = (tok: string, cls: string, extra = '') => call('GET', `${H}/events?from=${evFrom}&to=${evTo}&cls=${cls}${extra}`, tok);
  ok((await evq(tech, 'all')).status === 403, 'a technician cannot open the event log');
  const evAll = await evq(gm, 'all');
  ok(evAll.status === 200 && evAll.json.counts.all > 0, `hotel management sees the event log: ${evAll.json.counts?.all} events, ${evAll.json.counts?.entrances} entrances, ${evAll.json.counts?.errors} errors and warnings`, evAll.json.error);
  const evIn = await evq(auditor, 'entrances');
  ok(evIn.json.events.length > 0 && evIn.json.events.every((e: any) => e.category === 'entrance'), 'entrance events only: doors opened');
  ok(evIn.json.events.some((e: any) => e.code === 64 && e.source === 'Lock (Visionline)' && e.person), 'door openings reported by the locks (Visionline event 64, recorded by the connector) name the person');
  const evErr = await evq(auditor, 'errors');
  ok(evErr.json.events.length > 0 && evErr.json.events.every((e: any) => e.severity === 'error' || e.severity === 'warning'), 'error events only: errors and warnings');
  ok(evErr.json.events.some((e: any) => e.category === 'refused' && e.event === 'No access to this room'), 'refused entries are error events');
  const evSel = await evq(auditor, 'all', '&categories=refused&q=amina');
  ok(evSel.json.events.length > 0 && evSel.json.events.every((e: any) => e.category === 'refused' && /amina/i.test(`${e.person} ${e.card} ${e.event}`)), 'selection by event type and person');
  ok((await evq(auditor, 'all', '&categories=bogus')).status === 400, 'unknown event types are refused');
  ok((await call('GET', `${H}/events/export`, auditor)).status === 404, 'there is no spreadsheet export of the event log (PDF only)');
  const pdfRes = await fetch(`${H}/events/pdf`, { method: 'POST', headers: { authorization: `Bearer ${auditor}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: evFrom, to: evTo, cls: 'errors' }) });
  const pdf = Buffer.from(await pdfRes.arrayBuffer());
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(pdf).digest('hex');
  ok(pdfRes.status === 200 && pdfRes.headers.get('content-type') === 'application/pdf' && pdf.subarray(0, 5).toString() === '%PDF-', `error events printed as a PDF (${Math.round(pdf.length / 1024)} KB) made by the platform`);
  ok(pdfRes.headers.get('x-report-sha256') === sha, 'the platform recorded the PDF\'s fingerprint');
  const ver = await call('POST', `${H}/reports/verify`, gm, { sha256: sha });
  ok(ver.json.genuine === true && ver.json.report.title === 'Event log - error events', 'Verify a PDF: the printed copy is confirmed genuine');
  const tampered = Buffer.from(pdf); tampered[Math.floor(tampered.length / 2)] ^= 1;
  ok((await call('POST', `${H}/reports/verify`, gm, { sha256: createHash('sha256').update(tampered).digest('hex') })).json.genuine === false, 'a changed copy is not confirmed');
  ok((await call('POST', `${H}/reports/verify`, lakeAdmin, { sha256: sha })).status === 403, 'another hotel cannot check K Hotel Bana prints');
  const hdr = await call('GET', `${H}/reports/header`, gm);
  ok(hdr.status === 200 && hdr.json.systemNumber === '3460' && /^\d+\.\d+\.\d+$/.test(hdr.json.version) && hdr.json.logo?.startsWith('data:image/'), `report header: logo, system no. ${hdr.json.systemNumber}, version ${hdr.json.version}`);
  const prop = (await call('GET', `${H}/config/property`, admin)).json.data;
  const propSave = await call('PUT', `${H}/config/property`, admin, { ...prop, systemNumber: 'KHB-0001', legalName: 'K Hotel Bana SARL', reportFooter: 'Confidential - hotel management only' });
  ok(propSave.status === 200 && (await call('GET', `${H}/reports/header`, gm)).json.systemNumber === 'KHB-0001', 'hotel details: system number, legal name and report footer are printed on reports', propSave.json);
  await call('PUT', `${H}/config/property`, admin, prop);
  const brand = (await call('GET', `${H}/config/branding`, admin)).json.data;
  ok((await call('PUT', `${H}/config/branding`, admin, { ...brand, logoSize: { portal: 'large', app: 'small', reports: 'large' } })).status === 200, 'logo size per place (portal, app, reports)');
  ok((await call('PUT', `${H}/config/branding`, admin, { ...brand, logoSize: { portal: 'huge' } })).status === 400, 'unknown logo sizes are refused');
  await call('PUT', `${H}/config/branding`, admin, brand);
  const def = await call('GET', `${API}/mobile/v1/config?hotel=default`);
  ok(def.status === 200 && def.json.hotel.slug, `sign-in page and app find this installation's hotel without a built-in hotel code (${def.json.hotel?.slug})`);

  console.log('\nGate: every request is traceable without exposing secrets');
  const trail = (await call('GET', `${H}/keys/${keyId}`, issuer)).json;
  const kt = await call('GET', `${H}/keys/${keyId}`, auditor);
  ok(kt.status === 200 && kt.json.trail.length >= 5, `key ${keyId.slice(0, 8)} has a ${kt.json.trail?.length}-step audit trail with correlation id ${trail.correlationId}`);
  const verify = await call('GET', `${H}/audit/verify`, auditor);
  ok(verify.json.ok, `audit hash chain intact (${verify.json.records} records)`);
  const csv = await fetch(`${H}/audit/export`, { headers: { authorization: `Bearer ${auditor}` } }).then((r) => r.text());
  ok(!/dev-operator-password|dev-tenant-password|accessKey"\s*:\s*"[0-9a-f]{8}|smkc_dev|AWS [0-9a-f]+:/.test(csv), 'audit export contains no passwords, tokens, access keys or signatures');
  ok(!csv.includes(ob.inv.json.invitationCode), 'invitation codes are never stored in the audit trail');

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log('Failed:\n - ' + failures.join('\n - ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
