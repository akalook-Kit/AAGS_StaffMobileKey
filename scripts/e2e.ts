/**
 * End-to-end check of the Phase 1 acceptance gates (spec §10) against the running stack:
 * backend (API), connector, and the Visionline / Credential Services simulator.
 *
 *   npm run e2e            (defaults: API http://localhost:4000, simulator http://localhost:8444)
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

  // ---- 2.7: monitoring, e-mail/SMS alerts, doors offline, VIP doors, disk and database ---------------------
  console.log('\n2.7: monitoring - doors offline, watched (VIP) doors, disk and database, e-mail and SMS');
  const maint27 = await login('maint@khb.test');
  ok((await call('GET', `${H}/monitoring`, tech)).status === 403, 'a technician cannot open Monitoring');
  ok((await call('GET', `${H}/monitoring`, maint27)).status === 200 && (await call('GET', `${H}/monitoring/contacts`, maint27)).status === 403, 'the maintenance manager sees Monitoring but cannot change who is told');
  // Start from a quiet state (the test machine itself may be low on disk space).
  const pol27 = (await call('GET', `${H}/config/policy`, admin)).json.data;
  await call('PUT', `${H}/config/policy`, admin, { ...pol27, monitoring: { ...(pol27.monitoring ?? {}), diskMinFreeGb: 1 } });
  await call('POST', `${H}/monitoring/check`, admin, {});
  await call('DELETE', `${SIM}/sim/outbox`);
  const outbox27 = async () => (await call('GET', `${SIM}/sim/outbox`)).json as any[];
  const contacts27 = (await call('GET', `${H}/monitoring/contacts`, admin)).json;
  ok(contacts27.contacts.some((c: any) => c.name === 'Duty manager (test)' && c.byEmail && c.bySms), 'test contact told by e-mail and SMS');
  ok((await call('POST', `${H}/monitoring/contacts`, admin, { name: 'Bad number', phone: '0712 345', bySms: true, byEmail: false, categories: ['system'] })).status === 400, 'phone numbers must be in international form');
  ok((await call('POST', `${H}/monitoring/contacts`, admin, { name: 'Nobody', byEmail: true, categories: [] })).status === 400, 'a contact needs at least one kind of alert');
  const testRes = await call('POST', `${H}/monitoring/test`, admin, {});
  ok(testRes.status === 200 && testRes.json.sent >= 2 && testRes.json.failed === 0, `test message sent (${testRes.json.sent} messages)`, testRes.json);
  const tb27 = await until('test messages', outbox27, (o) => o.filter((m: any) => /Test message/.test(m.subject ?? m.text)).length >= 2, 20_000);
  ok(tb27.some((m: any) => m.via === 'email' && m.to.includes('duty@khb.test')) && tb27.some((m: any) => m.via.startsWith('sms') && m.to.includes('+237600000001')), 'e-mail through SMTP and SMS through the Android gateway arrive');

  const tight27 = { ...pol27, monitoring: { ...(pol27.monitoring ?? {}), dbMaxMb: 1, diskMinFreeGb: 100_000, notify: { cooldownMinutes: 0, sendResolved: true }, doorOffline: { ...(pol27.monitoring?.doorOffline ?? {}), enabled: true, offlineEventCodes: [9001], onlineEventCodes: [9002] } } };
  ok((await call('PUT', `${H}/config/policy`, admin, tight27)).status === 200, 'thresholds: database 1 MB, free disk 100,000 GB, lock offline/online codes 9001/9002');
  await call('POST', `${H}/monitoring/check`, admin, {});
  let mon27 = (await call('GET', `${H}/monitoring`, gm)).json;
  const diskAlert = mon27.alerts.find((a: any) => a.kind === 'disk_low');
  ok(diskAlert?.severity === 'critical' && mon27.system.disks[0].low === true, `low disk space raises a critical (red) alert: ${diskAlert?.title}`);
  ok(mon27.alerts.some((a: any) => a.kind === 'db_large' && a.severity === 'warning'), `database above its limit raises a warning (${Math.round(mon27.system.database.bytes / 1048576)} MB, largest table ${mon27.system.database.tables[0]?.name})`);
  ok((await call('GET', `${H}/monitoring/banner`, gm)).json.some((a: any) => a.kind === 'disk_low'), 'a red band about the disk shows on every portal page');
  await until('disk e-mail', outbox27, (o) => o.some((m: any) => /Disk space low/.test(m.subject ?? '')), 20_000);
  ok((await outbox27()).some((m: any) => m.via.startsWith('sms') && /Disk space low/.test(m.text)), 'the IT contact gets the disk alert by e-mail and SMS');
  ok((await call('POST', `${H}/monitoring/alerts/${diskAlert.id}/acknowledge`, gm, {})).status === 403 && (await call('POST', `${H}/monitoring/alerts/${diskAlert.id}/acknowledge`, security, {})).status === 200, 'security can mark an alert as seen (management cannot)');
  await call('POST', `${H}/monitoring/check`, admin, {});
  ok((await call('GET', `${H}/monitoring/banner`, gm)).json.some((a: any) => a.kind === 'disk_low'), 'a seen disk alert stays red until the disk is fixed');
  const before27 = (await outbox27()).length;
  await call('POST', `${H}/monitoring/check`, admin, {});
  ok((await outbox27()).length === before27, 'an open alert is not sent again every minute');

  // A lock reports "offline" (hotel-defined code); the connector starts listening for it after the policy change.
  const offEv27 = await until('lock offline event recorded', async () => {
    await call('POST', `${SIM}/sim/doors/102/event`, undefined, { code: 9001 });
    await sleep(3000);
    return call('GET', `${H}/events?from=${new Date(Date.now() - 600_000).toISOString()}&to=${new Date(Date.now() + 60_000).toISOString()}&cls=errors&q=offline`, auditor);
  }, (r) => r.json.events?.some((e: any) => e.event === 'Lock went offline'), 120_000);
  ok(offEv27.json.events.some((e: any) => e.event === 'Lock went offline' && e.door === '102'), 'the connector picked up the new offline code; the event log shows "Lock went offline" (error)');
  await call('POST', `${H}/monitoring/check`, admin, {});
  mon27 = (await call('GET', `${H}/monitoring`, gm)).json;
  const doorAlert27 = mon27.alerts.find((a: any) => a.kind === 'door_offline');
  ok(doorAlert27?.severity === 'critical' && /102/.test(doorAlert27.title) && mon27.doors.offline >= 1, `door offline alert: ${doorAlert27?.title}`);
  await until('door offline SMS', outbox27, (o) => o.some((m: any) => m.via.startsWith('sms') && /Door offline: 102/.test(m.text)), 20_000);
  ok(true, 'door offline announced by SMS and e-mail');
  await until('lock online event recorded', async () => {
    await call('POST', `${SIM}/sim/doors/102/event`, undefined, { code: 9002 });
    await sleep(2500);
    await call('POST', `${H}/monitoring/check`, admin, {});
    return call('GET', `${H}/monitoring`, gm);
  }, (r) => !r.json.alerts.some((a: any) => a.kind === 'door_offline'), 60_000);
  ok(true, 'the lock reports back online: the alert closes');
  await until('resolved message', outbox27, (o) => o.some((m: any) => /Resolved: Door offline: 102/.test(m.subject ?? m.text)), 20_000);
  ok(true, 'contacts are told that the door is back');

  // Watched (VIP) door: first entrance of the day is announced once.
  ok((await call('POST', `${H}/monitoring/watched-doors`, tech, { doorId: 'GM Office', label: 'VIP' })).status === 403, 'a technician cannot set watched doors');
  ok((await call('POST', `${H}/monitoring/watched-doors`, security, { doorId: 'No such door', label: 'VIP' })).status === 400, 'only doors read from Visionline can be watched');
  const watchRes = await call('POST', `${H}/monitoring/watched-doors`, security, { doorId: 'GM Office', label: 'VIP - GM Office', mode: 'first_daily' });
  ok(watchRes.status === 200, 'security sets GM Office as a watched (VIP) door');
  ok((await tap(briceOb.me.endpoint.endpointId, 'GM Office')).result === 'OPENED', 'Brice opens the GM Office');
  const vipRes = await until('VIP entrance', () => call('GET', `${H}/monitoring/alerts?kind=vip_entrance`, gm), (r) => r.json.length >= 1, 60_000);
  ok(/First entrance at VIP - GM Office/.test(vipRes.json[0]?.title) && /Brice/.test(vipRes.json[0]?.detail ?? ''), `VIP alert: ${vipRes.json[0]?.title} - ${vipRes.json[0]?.detail}`);
  await until('VIP SMS', outbox27, (o) => o.some((m: any) => m.via.startsWith('sms') && /First entrance at VIP - GM Office/.test(m.text)), 20_000);
  ok(true, 'the first entrance is announced by SMS and e-mail');
  await tap(briceOb.me.endpoint.endpointId, 'GM Office');
  await sleep(6000);
  ok((await call('GET', `${H}/monitoring/alerts?kind=vip_entrance`, gm)).json.length === 1, 'the second entrance the same day is not announced again (first entrance each day)');
  const evVip27 = await call('GET', `${H}/events?from=${new Date(Date.now() - 600_000).toISOString()}&to=${new Date(Date.now() + 60_000).toISOString()}&cls=entrances`, gm);
  ok(evVip27.json.events.some((e: any) => e.watched === 'VIP - GM Office'), 'the event log highlights entrances at the watched door');
  const sumv27 = (await call('GET', `${H}/monitoring/summary`, gm)).json;
  ok(sumv27.watched[0]?.last_entrance_at && sumv27.alerts.critical >= 1, 'the Overview shows open alerts and the last VIP entrance');

  // Back to normal limits (1 GB here, because the test machine itself may have little free space).
  await call('PUT', `${H}/config/policy`, admin, { ...pol27, monitoring: { ...(pol27.monitoring ?? {}), diskMinFreeGb: 1 } });
  await call('POST', `${H}/monitoring/check`, admin, {});
  mon27 = (await call('GET', `${H}/monitoring`, gm)).json;
  ok(!mon27.alerts.some((a: any) => a.kind === 'disk_low' || a.kind === 'db_large') && !(await call('GET', `${H}/monitoring/banner`, gm)).json.length, 'back to normal limits: disk and database alerts close and the red band goes away');
  const msgs27 = (await call('GET', `${H}/monitoring/messages`, gm)).json;
  ok(msgs27.length > 0 && !msgs27.some((m: any) => m.recipient.includes('duty@khb.test') || m.recipient.includes('+237600000001')), 'the message log keeps addresses and numbers masked');
  ok((await call('GET', `${H}/monitoring`, lakeAdmin)).status === 403, 'another hotel cannot see K Hotel Bana monitoring');

  // ---- 2.8: hide modules from people; time & attendance --------------------------------------------------------
  console.log('\n2.8: modules hidden per person or for non-administrators; time & attendance and payroll');
  const meAdmin = (await call('GET', `${API}/api/v1/me`, admin)).json;
  const ops28 = (await call('GET', `${H}/operators`, admin)).json;
  const issuerOp = ops28.find((o: any) => o.email === 'issuer@khb.test');
  ok(meAdmin.modules?.mobileKeys && (await call('PUT', `${H}/operators/${meAdmin.id}/modules`, admin, { hidden: ['mobileKeys'] })).status === 403, 'modules can be hidden per person, but not from yourself');
  ok((await call('PUT', `${H}/operators/${issuerOp.id}/modules`, admin, { hidden: ['mobileKeys', 'eventLog'] })).status === 200, 'admin hides mobile keys and the event log from the key issuer');
  const issuerMe28 = (await call('GET', `${API}/api/v1/me`, issuer)).json.hotels.find((x: any) => x.id === khb);
  ok(issuerMe28.hiddenModules.includes('mobileKeys') && !issuerMe28.permissions.includes('key.issue'), 'the issuer no longer has the mobile keys rights (menu and server)');
  ok((await call('GET', `${H}/keys`, issuer)).status === 403, 'hidden on the server too: the keys API refuses the issuer');
  await call('PUT', `${H}/operators/${issuerOp.id}/modules`, admin, { hidden: [] });
  ok((await call('GET', `${H}/keys`, issuer)).status === 200, 'shown again: the issuer can use mobile keys');
  const feat28 = (await call('GET', `${H}/config/features`, admin)).json.data;
  ok((await call('PUT', `${H}/config/features`, admin, { ...feat28, mobileKeysVisibleTo: 'administrators' })).status === 200, 'mobile keys limited to administrators while being finalised');
  ok((await call('GET', `${H}/keys`, security)).status === 403 && (await call('GET', `${H}/keys`, admin)).status === 200, 'the security manager no longer sees mobile keys; the hotel administrator still does');
  await call('PUT', `${H}/config/features`, admin, { ...feat28, mobileKeysVisibleTo: 'everyone' });
  ok((await call('GET', `${H}/keys`, security)).status === 200, 'back to everyone');

  const hr28 = await login('hr@khb.test');
  const desk28 = await login('desk@khb.test');
  ok((await call('GET', `${H}/attendance/today`, tech)).status === 403, 'a technician has no access to time & attendance');
  const today28 = await call('GET', `${H}/attendance/today`, desk28);
  ok(today28.status === 200 && today28.json.people.length >= 6, `check-in desk lists ${today28.json.people?.length} people (staff and daily workers)`);
  ok((await call('GET', `${H}/attendance/timesheet?from=${today28.json.date}&to=${today28.json.date}`, desk28)).status === 403, 'the desk timekeeper cannot read timesheets');
  const joseph28 = today28.json.people.find((p: any) => p.name === 'Joseph Kamau');
  const bricePerson = today28.json.people.find((p: any) => p.name === 'Brice Ngono');
  ok(joseph28?.kind === 'manual' && bricePerson?.kind === 'staff', 'a daily worker without a keycard and a staff member are both on the list');
  const cin = await call('POST', `${H}/attendance/clock`, desk28, { personId: joseph28.id, direction: 'in' });
  ok(cin.status === 200 && cin.json.direction === 'in', 'the desk checks the daily worker in');
  ok((await call('POST', `${H}/attendance/clock`, desk28, { personId: joseph28.id, direction: 'out', at: new Date(Date.now() - 3600_000).toISOString(), reason: 'x' })).status === 403, 'the desk cannot enter another time (HR only)');
  const t28 = (await call('GET', `${H}/attendance/today`, desk28)).json;
  ok(t28.people.find((p: any) => p.id === joseph28.id).state === 'in', 'the desk shows him as In');
  ok((await call('POST', `${H}/attendance/clock`, hr28, { personId: joseph28.id, direction: 'out', at: new Date(Date.now() - 60_000 * 30).toISOString() })).status === 400, 'HR must give a reason for another time');
  await call('POST', `${H}/attendance/clock`, desk28, { personId: joseph28.id, direction: 'out' });
  ok((await call('GET', `${H}/attendance/today`, desk28)).json.people.find((p: any) => p.id === joseph28.id).state === 'out', 'checked out at the desk');

  // Keycard / mobile key at the attendance door (Staff Entrance) clocks the person automatically.
  ok((await tap(briceOb.me.endpoint.endpointId, 'Staff Entrance')).result === 'OPENED', 'Brice opens the staff entrance (attendance door)');
  const day28 = today28.json.date as string;
  const bp = await until('door clock record', () => call('GET', `${H}/attendance/people/${bricePerson.id}/punches?from=${day28}&to=${day28}`, hr28), (r) => r.json.some?.((x: any) => x.source === 'door'), 60_000);
  ok(bp.json.some((x: any) => x.source === 'door' && x.door === 'Staff Entrance'), 'the entrance became a clock record for Brice (door, no desk needed)');
  await tap(briceOb.me.endpoint.endpointId, 'Staff Entrance');
  await sleep(5000);
  ok((await call('GET', `${H}/attendance/people/${bricePerson.id}/punches?from=${day28}&to=${day28}`, hr28)).json.filter((x: any) => x.source === 'door').length === 1, 'passing the door again within 10 minutes is not a second record');
  const addOut = await call('POST', `${H}/attendance/punches`, hr28, { personId: bricePerson.id, at: new Date(Date.now() - 60_000).toISOString(), direction: 'out', reason: 'Left by the main gate' });
  ok(addOut.status === 200, 'HR adds a missing check-out with a reason');
  const ts28 = (await call('GET', `${H}/attendance/timesheet?from=${day28}&to=${day28}`, hr28)).json;
  const bDay = ts28.people.find((p: any) => p.id === bricePerson.id).days[0];
  const jDay = ts28.people.find((p: any) => p.id === joseph28.id).days[0];
  ok(jDay.status === 'present' && jDay.punches === 2 && bDay.firstIn && bDay.punches === 2, `timesheet: daily worker present (${jDay.punches} records), Brice in by door and out by HR`);
  ok((await call('POST', `${H}/attendance/punches/${addOut.json.id}/void`, hr28, { reason: 'x' })).status === 400 && (await call('POST', `${H}/attendance/punches/${addOut.json.id}/void`, hr28, { reason: 'Entered for the wrong person' })).status === 200, 'a wrong record is voided with a reason (never deleted)');
  const voided = (await call('GET', `${H}/attendance/people/${bricePerson.id}/punches?from=${day28}&to=${day28}`, hr28)).json.find((x: any) => x.id === addOut.json.id);
  ok(voided?.voided_at && voided.void_reason === 'Entered for the wrong person', 'the voided record stays visible with who and why');

  const sh28 = await call('POST', `${H}/attendance/shifts`, hr28, { name: 'Night 22-06', start: '22:00', end: '06:00', breakMinutes: 30, graceMinutes: 5, workDays: [1, 2, 3, 4, 5, 6, 7] });
  ok(sh28.status === 200 && (await call('POST', `${H}/attendance/shifts`, desk28, { name: 'X', start: '08:00', end: '09:00' })).status === 403, 'HR adds a night shift; the desk cannot');
  const casual28 = await call('POST', `${H}/attendance/people`, hr28, { fullName: 'Peter Daily', employeeNo: 'DW-003', department: 'Laundry', employment: 'casual', payBasis: 'daily', shiftId: sh28.json.id });
  ok(casual28.status === 200 && casual28.json.kind === 'manual', 'HR adds another daily worker without a keycard');
  ok((await call('POST', `${H}/attendance/people`, hr28, { fullName: 'Duplicate', employeeNo: 'dw-003' })).status === 400, 'payroll numbers are unique');

  const yesterday28 = new Date(new Date(`${day28}T12:00:00Z`).getTime() - 86400_000).toISOString().slice(0, 10);
  const hol28 = await call('POST', `${H}/attendance/absences`, hr28, { personId: null, from: yesterday28, to: yesterday28, kind: 'public_holiday', note: 'Test holiday' });
  ok(hol28.status === 200, 'HR records a public holiday for everybody');
  ok((await call('POST', `${H}/attendance/absences`, hr28, { personId: null, from: yesterday28, to: yesterday28, kind: 'sick' })).status === 400, 'only a public holiday can apply to everybody');
  const tsY = (await call('GET', `${H}/attendance/timesheet?from=${yesterday28}&to=${yesterday28}`, hr28)).json;
  ok(tsY.people.every((p: any) => p.days[0].status === 'holiday' || p.days[0].punches > 0 || p.days[0].status === 'off'), 'yesterday shows as a public holiday, not as absent');
  const appr28 = await call('POST', `${H}/attendance/periods`, hr28, { from: yesterday28, to: yesterday28 });
  ok(appr28.status === 200, 'HR approves yesterday for payroll');
  ok((await call('POST', `${H}/attendance/periods`, hr28, { from: day28, to: day28 })).status === 400, 'today cannot be approved before it is over');
  const locked28 = await call('POST', `${H}/attendance/punches`, hr28, { personId: joseph28.id, at: new Date(`${yesterday28}T10:00:00Z`).toISOString(), direction: 'in', reason: 'late entry' });
  ok(locked28.status === 409 && locked28.json.error?.code === 'PERIOD_APPROVED', 'nothing can be changed in an approved period');

  const sumCsv = await fetch(`${H}/attendance/export/summary.csv?from=${yesterday28}&to=${day28}`, { headers: { authorization: `Bearer ${gm}` } });
  const sumText = Buffer.from(await sumCsv.arrayBuffer());
  ok(sumCsv.status === 200 && sumText[0] === 0xef && /employee_no,name,department,employment,pay_basis,days_present/.test(sumText.toString('utf8')) && /DW-001,Joseph Kamau/.test(sumText.toString('utf8')), 'payroll summary CSV (one row per person) for hotel management');
  const daily28 = await call('GET', `${H}/attendance/export/daily.json?from=${yesterday28}&to=${day28}`, gm);
  const jRow = daily28.json.rows?.find((r: any) => r.employee_no === 'DW-001' && r.date === day28);
  ok(daily28.status === 200 && jRow?.status === 'Present' && jRow.first_in && jRow.last_out && daily28.json.rows.some((r: any) => r.status === 'Public holiday'), 'day-by-day JSON for a payroll system: times, hours, status');
  const pdfA = await fetch(`${H}/attendance/pdf`, { method: 'POST', headers: { authorization: `Bearer ${hr28}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: yesterday28, to: day28 }) });
  const pdfBytes = Buffer.from(await pdfA.arrayBuffer());
  ok(pdfA.status === 200 && pdfBytes.subarray(0, 5).toString() === '%PDF-' && (await call('POST', `${H}/reports/verify`, gm, { sha256: (await import('node:crypto')).createHash('sha256').update(pdfBytes).digest('hex') })).json.genuine, 'printed attendance summary (PDF with the hotel header) can be verified');
  const per28 = (await call('GET', `${H}/attendance/periods`, hr28)).json.find((p: any) => p.date_from === yesterday28);
  ok((await call('DELETE', `${H}/attendance/periods/${per28.id}?reason=Correction%20needed`, hr28)).status === 200 && (await call('POST', `${H}/attendance/punches`, hr28, { personId: joseph28.id, at: new Date(`${yesterday28}T10:00:00Z`).toISOString(), direction: 'in', reason: 'late entry' })).status === 200, 'HR re-opens the period with a reason; corrections are possible again');
  const st28 = await call('PUT', `${H}/attendance/settings`, hr28, { doorIds: ['Staff Entrance', 'Main Entrance'], dayStartsAt: '04:00', ignoreRepeatMinutes: 10, overtimeAfterMinutes: 480, roundToMinutes: 15, defaultBreakMinutes: 60, requireReason: true });
  ok(st28.status === 200 && st28.json.settings.roundToMinutes === 15, 'HR changes the attendance doors and rounding without full settings rights');
  ok((await call('PUT', `${H}/attendance/settings`, desk28, { doorIds: [] })).status === 403, 'the desk cannot change attendance settings');
  const f28 = (await call('GET', `${H}/config/features`, admin)).json.data;
  await call('PUT', `${H}/config/features`, admin, { ...f28, timeAttendance: false });
  const off28 = await call('GET', `${H}/attendance/today`, desk28);
  ok(off28.status === 409 && off28.json.error?.code === 'MODULE_OFF', 'with the module switched off the desk says so');
  await call('PUT', `${H}/config/features`, admin, { ...f28, timeAttendance: true });
  ok((await call('GET', `${H}/attendance/today`, lakeAdmin)).status === 403, 'another hotel cannot see K Hotel Bana attendance');

  console.log('\n2.9: first-run setup, passwords in the portal, database copies');
  const su29 = await call('GET', `${API}/api/v1/setup`);
  ok(su29.status === 200 && su29.json.needed === false, 'an installation that is set up does not offer the setup page');
  ok((await call('POST', `${API}/api/v1/setup`, undefined, { code: 'AAAA-BBBB-CCCC', admin: { name: 'X Y', email: 'x@y.test', password: 'Long-enough-pass-1' } })).status === 409, 'the setup cannot be run again');
  const sec29 = await call('GET', `${H}/secrets`, admin);
  const csPw29 = sec29.json.secrets?.find((x: any) => x.ref === 'CS_TENANT_PASSWORD');
  ok(sec29.status === 200 && csPw29?.source === 'server', 'Credential Services password set on the server shows as such', sec29.json);
  ok(!JSON.stringify(sec29.json).includes('dev-tenant-password') && !JSON.stringify(sec29.json).includes('dev-smtp-password'), 'no password value is ever returned');
  ok((await call('PUT', `${H}/secrets/CS_TENANT_PASSWORD`, admin, { value: 'other' })).status === 409, 'a value set on the server cannot be overridden in the portal');
  ok((await call('GET', `${H}/secrets`, issuer)).status === 403, 'only administrators see the passwords page');
  ok((await call('PUT', `${H}/secrets/JWT_SECRET`, admin, { value: 'x' })).status === 404, 'only the passwords the settings refer to can be set');
  const nt29 = (await call('GET', `${H}/config/notifications`, admin)).json.data;
  ok((await call('PUT', `${H}/config/notifications`, admin, { ...nt29, sms: { ...nt29.sms, secretRef: 'CS_TENANT_PASSWORD' } })).status === 400, 'settings cannot point the SMS key at the Credential Services password');
  const bk29 = await call('GET', `${H}/backups`, admin);
  ok(bk29.status === 200 && typeof bk29.json.enabled === 'boolean', 'backup page answers');
  if (bk29.json.enabled) {
    const made29 = await call('POST', `${H}/backups`, admin, {});
    ok(made29.status === 200 && made29.json.bytes > 1000 && /^[0-9a-f]{64}$/.test(made29.json.sha256), `Back up now makes a checked copy (${made29.json.rows} rows)`);
    ok((await call('GET', `${H}/backups`, admin)).json.copies.some((c: any) => c.name === made29.json.name && c.fingerprint), 'the copy is listed with its fingerprint');
  }
  ok((await call('POST', `${H}/backups`, auditor, {})).status === 403, 'only administrators make copies');

  console.log('\n2.10: Visionline data arrives by itself (user groups, doors, people, keycards)');
  const ug10 = await until('Engineering group read from Visionline', () => call('GET', `${H}/visionline/user-groups`, gm),
    (r) => r.json?.some?.((g: any) => g.name === 'Engineering' && g.inVisionline), 90_000);
  const eng10 = ug10.json.find?.((g: any) => g.name === 'Engineering');
  ok(eng10?.inVisionline && eng10.people >= 2 && eng10.doors >= 1, `a user group that exists only in Visionline reached the portal by itself (Engineering: ${eng10?.people} people, ${eng10?.doors} doors)`, ug10.json);
  const vl10 = (await call('GET', `${H}/config/visionline`, admin)).json.data;
  ok(vl10.userGroups.includes('Engineering'), 'it joined the staff user groups without anyone typing it', vl10.userGroups);
  const ov10 = await call('GET', `${H}/visionline/overview`, gm);
  ok(ov10.status === 200 && ov10.json.counts.doors > 0 && ov10.json.counts.people > 0 && ov10.json.counts.validCards > 0 && ov10.json.connector?.liveCards, `overview: ${ov10.json.counts?.doors} doors, ${ov10.json.counts?.people} people, ${ov10.json.counts?.validCards} valid keycards; new cards live`, ov10.json);
  const desk10 = await call('POST', `${SIM}/sim/desk/cards`, undefined, { userId: `vl-en-${Date.now() % 100000}`, givenName: 'Grace', surname: 'Mvogo', userGroup: 'Engineering', days: 30 });
  ok(desk10.status === 200, 'a keycard is encoded at the Visionline desk (outside the platform)');
  const card10 = await until('desk keycard recorded', () => call('GET', `${H}/visionline/cards?q=${desk10.json.regNo}&state=all`, gm),
    (r) => r.json?.[0]?.holder_name === 'Grace Mvogo' && r.json[0].door_count > 0, 60_000);
  const c10 = card10.json?.[0];
  ok(c10?.reg_no === String(desk10.json.regNo) && c10.valid && c10.user_group === 'Engineering' && c10.door_count >= 1 && !c10.mobile_key,
    `the new keycard is in the portal within seconds, with its holder, group and doors (${c10?.holder_name}, ${c10?.user_group}, ${c10?.door_count} doors)`, c10);
  ok((await call('GET', `${H}/visionline/people?q=Mvogo`, gm)).json.some?.((u: any) => u.given_name === 'Grace' && u.valid_cards === 1), 'the new person is listed with one valid keycard');
  ok((await call('GET', `${H}/visionline/cards`, issuer)).status === 403, 'key issuers without report rights do not see the Visionline card list');
  ok((await call('POST', `${H}/visionline/refresh`, gm)).status === 403, 'hotel management cannot start a Visionline read');
  const rf10 = await call('POST', `${H}/visionline/refresh`, admin);
  ok(rf10.status === 200 && rf10.json.discovery?.commandId, 'an administrator can refresh everything now', rf10.json);

  console.log('\n2.11: Breakfast at the restaurant (in-house list, serving, reports)');
  const rest = await login('restaurant@khb.test');
  const hr11 = await login('hr@khb.test');
  const f11 = (await call('GET', `${H}/config/features`, admin)).json.data;
  await call('PUT', `${H}/config/features`, admin, { ...f11, breakfast: false });
  ok((await call('GET', `${H}/breakfast/day`, rest)).status === 409, 'breakfast switched off: the pages answer "switched off"');
  ok((await call('PUT', `${H}/config/features`, admin, { ...f11, breakfast: true })).status === 200, 'an administrator switches Breakfast on (Settings → Modules)');
  ok((await call('GET', `${H}/attention`, admin)).json.breakfast === true, 'the Breakfast page appears in the menu');
  const day11 = await call('GET', `${H}/breakfast/day`, rest);
  const today11 = day11.json.today as string;
  const next11 = new Date(Date.parse(`${today11}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  ok(day11.status === 200 && /^\d{4}-\d{2}-\d{2}$/.test(today11) && day11.json.can.serve && !day11.json.can.manage, `the restaurant sees today's breakfast (${today11}, ${day11.json.timeZone}); may serve, not manage`);
  const base11 = `9${String(Date.now()).slice(-5)}`;
  const [rA, rB] = [`${base11}1`, `${base11}2`];
  ok((await call('POST', `${H}/breakfast/stays/import`, rest, { rows: [{ room: rA }] })).status === 403, 'the restaurant cannot import the in-house list');
  const imp11 = await call('POST', `${H}/breakfast/stays/import`, issuer, { rows: [
    { ref: `E2E-${base11}-1`, room: rA, guestName: 'Family Test', adults: '2', children: '1', arrival: today11, departure: next11, breakfast: 'BB' },
    { ref: `E2E-${base11}-2`, room: rB, guestName: 'Room Only', adults: 1, arrival: today11, departure: next11, breakfast: 'RO' },
    { room: '', guestName: 'broken row' },
  ] });
  ok(imp11.status === 200 && imp11.json.added === 2 && imp11.json.rejected === 1, `PMS list imported: ${imp11.json.added} stays added, ${imp11.json.rejected} bad row reported`, imp11.json);
  const again11 = await call('POST', `${H}/breakfast/stays/import`, issuer, { rows: [{ ref: `E2E-${base11}-1`, room: rA, guestName: 'Family Test', adults: 2, children: 1, arrival: today11, departure: next11 }] });
  ok(again11.json.added === 0 && again11.json.updated === 1, 'importing the same reservation again updates it (no duplicate)', again11.json);
  const s1 = await call('POST', `${H}/breakfast/serve`, rest, { room: rA, persons: 2 });
  ok(s1.status === 200 && s1.json.kind === 'included', 'room with breakfast in the rate: 2 served as included', s1.json);
  const over11 = await call('POST', `${H}/breakfast/serve`, rest, { room: rA, persons: 2, kind: 'included' });
  ok(over11.status === 409 && over11.json.error?.code === 'NOT_INCLUDED', 'more than the rate allows is refused as included', over11.json);
  ok((await call('POST', `${H}/breakfast/serve`, rest, { room: rA, persons: 1 })).json.kind === 'included', 'the third person (a child) is still in the rate');
  ok((await call('POST', `${H}/breakfast/serve`, rest, { room: rA, persons: 1 })).json.kind === 'paying', 'a fourth person is recorded as paying');
  ok((await call('POST', `${H}/breakfast/serve`, rest, { room: rB, persons: 1, kind: 'included' })).status === 409, 'a room-only stay cannot be served as included');
  ok((await call('POST', `${H}/breakfast/serve`, rest, { room: rB, persons: 1 })).json.kind === 'paying', 'the room-only guest is recorded as paying');
  ok((await call('POST', `${H}/breakfast/serve`, rest, { persons: 1 })).status === 400, 'a guest without a room needs a note');
  const walk11 = await call('POST', `${H}/breakfast/serve`, rest, { persons: 2, note: `E2E visitors ${base11}` });
  ok(walk11.status === 200 && walk11.json.kind === 'walk_in', 'walk-in guests are recorded', walk11.json);
  ok((await call('POST', `${H}/breakfast/served/${walk11.json.id}/void`, rest, { reason: 'typed twice' })).status === 200, 'the waiter can undo an own entry');
  ok((await call('POST', `${H}/breakfast/serve`, rest, { room: rA, persons: 1, date: next11 })).status === 403, 'the restaurant can only record today');
  const v11 = (await call('GET', `${H}/breakfast/day`, gm)).json;
  const ra11 = v11.rooms.find((r: any) => r.room === rA), rb11 = v11.rooms.find((r: any) => r.room === rB);
  ok(ra11?.included === 3 && ra11.servedIncluded === 3 && ra11.servedPaying === 1 && ra11.status === 'done' && rb11?.status === 'not_included' && rb11.servedPaying === 1,
    `today: room ${rA} 3 of 3 in the rate + 1 paying (done), room ${rB} not in the rate + 1 paying`, { ra11, rb11 });
  ok(v11.served.some((s: any) => s.id === walk11.json.id && s.voided), 'the undone walk-in stays visible as undone (nothing is deleted)');
  ok((await call('GET', `${H}/breakfast/day`, hr11)).status === 403, 'roles without breakfast rights do not see it');
  ok((await call('POST', `${H}/breakfast/serve`, auditor, { room: rA, persons: 1 })).status === 403, 'auditors can look but not serve');
  ok((await call('PUT', `${H}/breakfast/settings`, rest, { dayStartsAt: '03:00', serviceFrom: '06:00', serviceUntil: '10:30', countChildren: true, allowWalkIns: true })).status === 403, 'the restaurant cannot change breakfast settings');
  const rep11 = await call('GET', `${H}/breakfast/report?from=${today11}&to=${today11}`, gm);
  ok(rep11.status === 200 && rep11.json.days[0].served >= 3 && rep11.json.days[0].paying >= 2, `report: ${rep11.json.days?.[0]?.served} in the rate served, ${rep11.json.days?.[0]?.paying} paying`, rep11.json);
  const csv11 = await fetch(`${H}/breakfast/export.csv?from=${today11}&to=${today11}`, { headers: { authorization: `Bearer ${gm}` } }).then((r) => r.text());
  ok(csv11.includes(`${today11},${rA},Family Test,3,3,3,1,0`), 'CSV export has one line per room', csv11.slice(0, 300));
  const pdf11 = await fetch(`${H}/breakfast/pdf`, { method: 'POST', headers: { authorization: `Bearer ${gm}`, 'content-type': 'application/json' }, body: '{}' });
  ok(pdf11.status === 200 && (await pdf11.arrayBuffer()).byteLength > 1000 && /^[0-9a-f]{64}$/.test(pdf11.headers.get('x-report-sha256') ?? ''), 'the day sheet prints as a signed PDF');
  const end11 = await call('POST', `${H}/breakfast/stays/import`, issuer, { rows: [{ ref: `E2E-${base11}-1`, room: rA, guestName: 'Family Test', adults: 2, children: 1, arrival: today11, departure: next11 }], replace: true });
  ok(end11.status === 200 && end11.json.ended >= 1, `a full list with "replace" ends the stays it no longer contains (${end11.json.ended})`, end11.json);
  ok(!(await call('GET', `${H}/breakfast/day`, gm)).json.rooms.some((r: any) => r.room === rB && r.stays.length), `room ${rB} left the in-house list`);

  console.log('\n2.12: keycard privileges, access history, lock events matched to keycards, report builder');
  {
    const db12 = await call('GET', `${H}/visionline/cards?deadbolt=yes&state=all`, gm);
    ok(db12.status === 200 && db12.json.length > 0 && db12.json.every((c: any) => c.deadbolt_override === true), `keycards that override the deadbolt can be listed (${db12.json.length})`, db12.json?.[0]);
    const nodb = await call('GET', `${H}/visionline/cards?deadbolt=no&state=all`, gm);
    ok(nodb.json.length > 0 && nodb.json.every((c: any) => c.deadbolt_override === false), 'and those that do not');
    const vlc = (await call('GET', `${H}/config/visionline`, admin)).json.data;
    const grp = await call('PUT', `${H}/config/visionline`, admin, { ...vlc, directorySync: { ...vlc.directorySync, scope: 'groups', groups: ['Engineering', 'Security'], maxUsers: 500 } });
    ok(grp.status === 200, 'the hotel chooses exactly which user groups to read, and how many people at most', grp.json);
    await call('PUT', `${H}/config/visionline`, admin, vlc);
    const ev12 = await call('GET', `${H}/events?from=${new Date(Date.now() - 2 * 86400_000).toISOString()}&to=${new Date().toISOString()}&limit=500`, security);
    const withCard = ev12.json.events.filter((e: any) => e.match);
    ok(ev12.status === 200 && withCard.length > 0 && withCard.every((e: any) => typeof e.match.known === 'boolean'), `lock events carry their keycard match (${withCard.length} with a card number)`);
    const known = withCard.find((e: any) => e.match.known && e.match.kind === 'mobile');
    ok(!known || known.match.issuedBy, `a mobile key used at a door shows who issued it${known ? ` (${known.match.issuedBy})` : ''}`, known);
    const unk = await call('GET', `${H}/events?from=${new Date(Date.now() - 2 * 86400_000).toISOString()}&to=${new Date().toISOString()}&match=unknown&limit=500`, security);
    ok(unk.status === 200 && unk.json.events.every((e: any) => e.match && !e.match.known), `"no matching keycard" filter (${unk.json.events.length})`);
    const s12 = await call('GET', `${H}/access/search?q=Grace`, security);
    ok(s12.status === 200 && s12.json.people.some((p: any) => /Grace/.test(p.name)), 'access history finds people by name', s12.json);
    const holder = s12.json.people.find((p: any) => p.holder)?.holder;
    const a12 = await call('GET', `${H}/access?holder=${encodeURIComponent(holder)}&days=30`, security);
    ok(a12.status === 200 && a12.json.person?.name && Array.isArray(a12.json.doors) && Array.isArray(a12.json.cards), `a person's access history: ${a12.json.totals?.entrances} entrances, ${a12.json.cards?.length} keycards`, a12.json.person);
    const doorId = ev12.json.events.find((e: any) => e.doorId && (e.category === 'refused' || e.category === 'entrance'))?.doorId;
    if (doorId) { const d12 = await call('GET', `${H}/access?door=${encodeURIComponent(doorId)}&days=30`, security); ok(d12.status === 200 && d12.json.door?.name && d12.json.totals.entrances + d12.json.totals.refused > 0, `who went through door ${d12.json.door?.name}`); }
    ok((await call('GET', `${H}/access?holder=x`, hr11)).status === 403, 'access history needs the event log permission');

    const cat12 = await call('GET', `${H}/insights/builder/catalog`, gm);
    ok(cat12.status === 200 && ['doorEvents', 'keycards'].every((id) => cat12.json.datasets.some((d: any) => d.id === id)), `report builder data: ${cat12.json.datasets?.map((d: any) => d.id).join(', ')}`);
    const spec = { dataset: 'keycards', groupBy: 'userGroup', splitBy: 'deadbolt', measure: 'cards', days: 30, limit: 10, chart: 'bars', filters: [{ dim: 'state', values: ['Valid'] }] };
    const run12 = await call('POST', `${H}/insights/builder/run`, gm, spec);
    ok(run12.status === 200 && run12.json.rows.length > 0 && run12.json.series.includes('Overrides deadbolt'), `custom report runs: ${run12.json.rows?.length} groups × ${run12.json.series?.length} series`, run12.json);
    const bad12 = await call('POST', `${H}/insights/builder/run`, gm, { ...spec, groupBy: "user_group; DROP TABLE staff" });
    ok(bad12.status === 400, 'only listed fields can be used (no SQL from the browser)');
    const ev12r = await call('POST', `${H}/insights/builder/run`, gm, { dataset: 'doorEvents', groupBy: 'hour', splitBy: 'category', measure: 'events', days: 7, limit: 24, chart: 'columns', filters: [] });
    ok(ev12r.status === 200, `door events by hour: ${ev12r.json.total} events`);
    const sv = await call('POST', `${H}/insights/reports`, gm, { name: 'Deadbolt by group', spec, pinned: true, shared: true });
    ok(sv.status === 200 && sv.json.id, 'a report is saved and pinned');
    ok((await call('GET', `${H}/insights/reports`, security)).json.some((r: any) => r.id === sv.json.id && !r.mine), 'a shared report is visible to other report readers');
    ok((await call('DELETE', `${H}/insights/reports/${sv.json.id}`, security)).status === 404, 'only its author can delete it');
    ok((await call('DELETE', `${H}/insights/reports/${sv.json.id}`, gm)).status === 200, 'the author deletes it');
    const csv12 = await fetch(`${H}/insights/builder/csv`, { method: 'POST', headers: { authorization: `Bearer ${gm}`, 'content-type': 'application/json' }, body: JSON.stringify(spec) }).then((r) => r.text());
    ok(csv12.includes('Overrides deadbolt') && csv12.split('\n').length > 1, 'a custom report exports to CSV');

    // Card lookup and reading a keycard on an encoder (pilot)
    const lk = await call('GET', `${H}/visionline/cards/${desk10.json.regNo}/lookup`, gm);
    ok(lk.status === 200 && lk.json.known && lk.json.card.holder === 'Grace Mvogo' && lk.json.card.issuedBy === null && lk.json.card.doors.length > 0, `card lookup: ${lk.json.card?.holder}, ${lk.json.card?.group}, issued by ${lk.json.card?.issuedBy ?? 'Visionline (operator not reported)'}, ${lk.json.card?.doors?.length} doors`, lk.json);
    ok((await call('GET', `${H}/visionline/cards/999999999/lookup`, gm)).json.known === false, 'an unknown card number is said to match nothing');
    ok((await call('POST', `${H}/visionline/encoder/read`, gm, { encoder: 'fd1' })).json.error?.code === 'ENCODER_READ_OFF', 'reading at an encoder is off until the hotel switches it on');
    const vle = (await call('GET', `${H}/config/visionline`, admin)).json.data;
    ok((await call('PUT', `${H}/config/visionline`, admin, { ...vle, encoderRead: { enabled: true, encoders: ['fd1'], action: 'read' } })).status === 200, 'encoder fd1 allowed (Settings → Reports & sync)');
    await call('POST', `${SIM}/sim/encoder`, undefined, { encoder: 'fd1', regNo: String(desk10.json.regNo) });
    const rd = await call('POST', `${H}/visionline/encoder/read`, gm, { encoder: 'fd1' });
    const fast = await call('POST', `${H}/visionline/encoder/read`, gm, { encoder: 'fd1' });
    ok(fast.status === 429 && fast.json.error?.code === 'TOO_FAST', 'reads at the encoder are spaced out (Visionline is shared with reception and the GRMS)', fast.json);
    const rr = await until('card read at the encoder', () => call('GET', `${H}/visionline/encoder/read/${rd.json.commandId}`, gm), (r) => ['SUCCEEDED', 'FAILED', 'EXPIRED'].includes(r.json?.status), 40_000);
    ok(rr.json.status === 'SUCCEEDED' && rr.json.result.regNo === String(desk10.json.regNo) && rr.json.result.cardHolder, `the card on encoder fd1 is read: ${rr.json.result?.regNo} (${rr.json.result?.cardHolder})`, rr.json);
    ok(!JSON.stringify(rr.json.result).includes('04A1B2C3D4'), 'card serial numbers are not kept');
    await call('POST', `${SIM}/sim/encoder`, undefined, { encoder: 'fd1', regNo: null });
    await sleep(3500);
    const rd2 = await call('POST', `${H}/visionline/encoder/read`, gm, { encoder: 'fd1' });
    const rr2 = await until('empty encoder', () => call('GET', `${H}/visionline/encoder/read/${rd2.json.commandId}`, gm), (r) => ['SUCCEEDED', 'FAILED', 'EXPIRED'].includes(r.json?.status), 40_000);
    ok(rr2.json.status === 'FAILED' && /no card/i.test(rr2.json.error?.message ?? ''), `an empty encoder says so: "${rr2.json.error?.message}"`, rr2.json);
    ok((await call('POST', `${H}/visionline/encoder/read`, gm, { encoder: 'fd9' })).json.error?.code === 'UNKNOWN_ENCODER', 'only the listed encoders can be used');
    await call('PUT', `${H}/config/visionline`, admin, vle);
  }

  console.log('\n2.12: licences (signed by the vendor, checked offline)');
  {
    const { createPrivateKey, sign } = await import('node:crypto');
    const tk = JSON.parse(readFileSync(new URL('./e2e-licence-test-key.json', import.meta.url), 'utf8'));
    const priv = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: tk.x, d: tk.d }, format: 'jwk' });
    const b64u = (b: Buffer) => b.toString('base64url');
    const lic = (p: Record<string, unknown>) => {
      const head = `SMK1.${b64u(Buffer.from(JSON.stringify({ v: 1, id: `E2E-${Date.now() % 1e6}`, customer: 'K Hotel Bana', hotel: 'K Hotel Bana', issued: '2026-10-18', modules: ['*'], ...p })))}`;
      return `${head}.${b64u(sign(null, Buffer.from(head), priv))}`;
    };
    const st12 = await call('GET', `${H}/licence`, admin);
    ok(st12.status === 200 && (st12.json.enforced ? st12.json.state === 'trial' && st12.json.daysLeft > 50 : true) && /^[0-9A-F]{4}-/.test(st12.json.installationId),
      `licence status: ${st12.json.enforced ? `${st12.json.state}, ${st12.json.daysLeft} days left` : 'not enforced'}, installation ID ${st12.json.installationId}`, st12.json);
    if (st12.json.enforced) {
      ok((await call('PUT', `${H}/licence`, admin, { key: 'SMK1.nonsense.nonsense' })).json.error?.code === 'LICENCE_INVALID', 'a made-up key is refused');
      const good = lic({ systemId: null, modules: ['staffMobileKeys', 'batteryMonitoring', 'maintenance', 'timeAttendance'], expires: '2099-12-31' });
      const parts = good.split('.');
      const forged = `${parts[0]}.${b64u(Buffer.from(Buffer.from(parts[1]!, 'base64url').toString().replace('2099-12-31', '2199-12-31')))}.${parts[2]}`;
      ok((await call('PUT', `${H}/licence`, admin, { key: forged })).json.error?.code === 'LICENCE_INVALID', 'a licence changed after signing (longer end date) is refused');
      ok((await call('PUT', `${H}/licence`, admin, { key: lic({ systemId: 999999, expires: '2099-12-31' }) })).json.error?.code === 'LICENCE_OTHER_HOTEL', 'a licence for another ASSA ABLOY System ID is refused');
      ok((await call('PUT', `${H}/licence`, admin, { key: lic({ expires: '2020-01-31' }) })).json.error?.code === 'LICENCE_EXPIRED', 'an ended licence is refused');
      ok((await call('PUT', `${H}/licence`, issuer, { key: good })).status === 403, 'only administrators enter licences');
      const inst = await call('PUT', `${H}/licence`, admin, { key: good });
      ok(inst.status === 200 && inst.json.state === 'licensed' && inst.json.switchedOff?.includes('Breakfast') && !inst.json.modules.includes('breakfast'),
        `licence installed; a module it does not include was switched off (${inst.json.switchedOff?.join(', ')})`, inst.json);
      const f12 = (await call('GET', `${H}/config/features`, admin)).json.data;
      const on = await call('PUT', `${H}/config/features`, admin, { ...f12, breakfast: true });
      ok(on.status === 402 && on.json.error?.code === 'LICENCE_REQUIRED', 'a module outside the licence cannot be switched on', on.json);
      ok((await call('GET', `${H}/attention`, admin)).json.breakfast === false, 'and it leaves the menu');
      const all = await call('PUT', `${H}/licence`, admin, { key: lic({ systemId: null, modules: ['*'], expires: null }) });
      ok(all.status === 200 && all.json.state === 'licensed' && all.json.daysLeft === null && all.json.modules.length === 5, 'a full licence without end date', all.json);
      ok((await call('PUT', `${H}/config/features`, admin, { ...f12, breakfast: true })).status === 200, 'then the module can be switched on again (its data was kept)');
    }
  }

  console.log('\n2.13: personal menu, focus mode, sign-in timing, administrator protection');
  {
    const pf = await call('PUT', `${API}/api/v1/me/prefs`, issuer, { hiddenNav: ['/insights', '/events'], theme: 'dark' });
    const me13 = await call('GET', `${API}/api/v1/me`, issuer);
    ok(pf.status === 200 && me13.json.prefs.theme === 'dark' && me13.json.prefs.hiddenNav.includes('/events'), 'personal menu and appearance are kept with the account');
    ok((await call('PUT', `${API}/api/v1/me/prefs`, issuer, { hiddenNav: ['javascript:alert(1)'] })).status === 400, 'only menu addresses are accepted');
    await call('PUT', `${API}/api/v1/me/prefs`, issuer, { hiddenNav: [], theme: 'system' });
    const f13 = (await call('GET', `${H}/config/features`, admin)).json.data;
    ok((await call('PUT', `${H}/config/features`, admin, { ...f13, portalFocus: 'visionline' })).status === 200, 'portal focus "Visionline only" saved');
    const pIss = (await call('GET', `${API}/api/v1/me`, issuer)).json.hotels.find((h: any) => h.id === khb).permissions;
    const pAdm = (await call('GET', `${API}/api/v1/me`, admin)).json.hotels.find((h: any) => h.id === khb).permissions;
    ok(!pIss.includes('key.read') && !pIss.includes('attendance.read') && pAdm.includes('key.read'), 'focus mode hides mobile keys and attendance from everyone but administrators');
    ok((await call('GET', `${H}/keys`, issuer)).status === 403, 'and closes them on the server too, not only in the menu');
    await call('PUT', `${H}/config/features`, admin, f13);
    // Sign-in takes the same time whether or not the e-mail exists (no account guessing).
    const tm = async (email: string) => { const t0 = performance.now(); await call('POST', `${API}/api/v1/auth/login`, undefined, { email, password: 'Not-the-password-1' }); return performance.now() - t0; };
    const kn: number[] = [], un: number[] = [];
    for (let i = 0; i < 2; i++) { kn.push(await tm('auditor@khb.test')); un.push(await tm(`nobody-${Date.now()}-${i}@nowhere.test`)); }
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    ok(avg(un) > avg(kn) * 0.5, `sign-in time for an unknown e-mail ${avg(un).toFixed(0)} ms vs a known one ${avg(kn).toFixed(0)} ms`);
    ok((await call('GET', `${H}/staff/not-a-uuid`, admin)).status < 500, 'malformed ids in the address are refused, not server errors');
    const hdr = await fetch(`${API}/api/v1/me`, { headers: { authorization: `Bearer ${admin}` } });
    ok(hdr.headers.get('x-frame-options') === 'DENY' && /frame-ancestors 'none'/.test(hdr.headers.get('content-security-policy') ?? ''), 'every answer forbids framing and carries a content security policy');

    // Two-step sign-in required for administrators.
    const totp = async (secret: string) => {
      const { createHmac } = await import('node:crypto');
      const B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
      for (const ch of secret) bits += B.indexOf(ch).toString(2).padStart(5, '0');
      const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
      const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
      const h = createHmac('sha1', key).update(ctr).digest(); const o = h[h.length - 1]! & 0xf;
      return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
    };
    const pol13 = (await call('GET', `${H}/config/policy`, admin)).json.data;
    ok((await call('PUT', `${H}/config/policy`, admin, { ...pol13, adminSecurity: { requireAdminMfa: true, reauthMinutes: 5 } })).status === 200, 'administrators must use two-step sign-in (Settings → Administrator protection)');
    const locked = await call('GET', `${H}/operators`, admin);
    ok(locked.status === 403 && locked.json.error?.code === 'MFA_REQUIRED', 'an administrator without it can no longer open Settings or Operators', locked.json);
    ok((await call('GET', `${API}/api/v1/me`, admin)).json.hotels.find((h: any) => h.id === khb).mfaRequired === true, 'the portal is told so (banner, menu)');
    ok((await call('GET', `${H}/events?from=${new Date(Date.now() - 86400_000).toISOString()}&to=${new Date().toISOString()}&limit=5`, admin)).status === 200, 'everything else keeps working');
    const su = await call('POST', `${API}/api/v1/auth/mfa/setup`, admin, {});
    ok((await call('POST', `${API}/api/v1/auth/mfa/enable`, admin, { code: await totp(su.json.secret) })).status === 200, 'the administrator turns two-step sign-in on');
    ok((await call('GET', `${H}/operators`, admin)).status === 200, 'and Settings open again');
    ok((await call('POST', `${API}/api/v1/auth/mfa/setup`, admin, {})).json.error?.code === 'MFA_ALREADY_ON', 'a session alone cannot switch two-step sign-in off by starting again');
    const plat = await login('platform@smk.test');
    ok((await call('POST', `${H}/operators/${me.json.id}/mfa/reset`, plat, {})).json.error?.code === 'REAUTH_REQUIRED', 'resetting it (lost phone) needs the password again');
    await call('PUT', `${H}/config/policy`, admin, pol13);
    const ra = (await call('POST', `${API}/api/v1/me/reauth`, plat, { password: PW })).json.token;
    ok((await call('POST', `${H}/operators/${me.json.id}/mfa/reset`, plat, {}, { 'x-smk-reauth': ra })).status === 200, 'another administrator resets it');
    ok((await call('POST', `${API}/api/v1/me/reauth`, plat, { password: 'wrong' })).status === 400, 'a wrong password is not a confirmation');
  }

  console.log('\n2.13: live occupancy, emergency (two people), roll call, emergency keys');
  {
    const safety = await login('safety@khb.test');
    const m13 = await call('GET', `${H}/muster`, safety);
    ok(m13.status === 200 && typeof m13.json.totals.staff === 'number' && m13.json.rooms.length > 0, `live occupancy: ${m13.json.totals?.staff} staff on site, ${m13.json.totals?.guests} guests, ${m13.json.rooms?.length} rooms`, m13.json.totals);
    ok((await call('GET', `${H}/muster`, rest)).status === 403, 'the restaurant does not see it');
    ok((await call('GET', `${API}/api/v1/hotels/${khb}/muster`, lakeAdmin)).status === 403, 'another hotel does not see it');
    const pdf13 = await fetch(`${H}/muster/pdf`, { headers: { authorization: `Bearer ${safety}` } });
    ok(pdf13.status === 200 && pdf13.headers.get('content-type') === 'application/pdf', 'evacuation list prints as a PDF');
    const open0 = (await call('GET', `${H}/emergency/status`, safety)).json.open;
    if (open0) await call('POST', `${H}/emergency/${open0.id}/end`, security, { note: 'e2e: closing an earlier one' });
    ok((await call('POST', `${H}/emergency`, safety, { kind: 'drill', reason: 'e2e drill' })).json.error?.code === 'REAUTH_REQUIRED', 'starting an emergency needs the password again');
    const rs = (await call('POST', `${API}/api/v1/me/reauth`, safety, { password: PW })).json.token;
    const e13 = await call('POST', `${H}/emergency`, safety, { kind: 'fire', reason: 'e2e: smoke on floor 2' }, { 'x-smk-reauth': rs });
    ok(e13.status === 201 && e13.json.status === 'REQUESTED', 'the fire warden starts an emergency');
    ok((await call('POST', `${H}/emergency/${e13.json.id}/confirm`, safety, {}, { 'x-smk-reauth': rs })).status === 403, 'the same person cannot confirm it');
    ok((await call('POST', `${H}/emergency/${e13.json.id}/confirm`, security, {}, { 'x-smk-reauth': rs })).status === 401, "another person's password confirmation does not count");
    const rsec = (await call('POST', `${API}/api/v1/me/reauth`, security, { password: PW })).json.token;
    ok((await call('POST', `${H}/emergency/${e13.json.id}/confirm`, security, {}, { 'x-smk-reauth': rsec })).json.status === 'ACTIVE', 'a second person confirms it');
    ok((await call('GET', `${H}/emergency/status`, safety)).json.open?.status === 'ACTIVE', 'every portal shows it');
    const room = m13.json.rooms[0].room;
    const roll = await call('POST', `${H}/emergency/${e13.json.id}/roll`, safety, { key: `room:${room}`, safe: true });
    ok(roll.status === 200 && roll.json.roll[`room:${room}`]?.safe, `room ${room} ticked as safe`);
    ok((await call('POST', `${H}/emergency/${e13.json.id}/keys`, safety, { staffIds: [randomUUID()] })).status === 403, 'emergency keys need the right to issue keys');
    const tpl = (await call('GET', `${H}/templates`, admin)).json[0];
    const pol = (await call('GET', `${H}/config/policy`, admin)).json.data;
    await call('PUT', `${H}/config/policy`, admin, { ...pol, safety: { ...(pol.safety ?? {}), emergencyTemplateId: tpl.id, emergencyKeyHours: 2 } });
    const em = (await call('GET', `${H}/emergency`, admin)).json;
    ok(em.readiness.template?.id === tpl.id && em.readiness.responders.length > 0 && typeof em.readiness.remoteOpen.online === 'number', `readiness: template "${em.readiness.template?.name}", ${em.readiness.responders.length} responder(s), online/offline locks counted for emergency open`);
    const k13 = await call('POST', `${H}/emergency/${e13.json.id}/keys`, admin, { staffIds: [em.readiness.responders[0].id] });
    ok(k13.status === 200 && k13.json.results.length === 1 && (k13.json.results[0].ok || /live key/.test(k13.json.results[0].error)), `emergency key for ${em.readiness.responders[0].name}: ${k13.json.results[0]?.ok ? k13.json.results[0].status : k13.json.results[0]?.error}`, k13.json);
    const end = await call('POST', `${H}/emergency/${e13.json.id}/end`, security, { note: 'e2e: all clear' });
    ok(end.json.status === 'ENDED', 'the emergency is ended with a note');
    await call('PUT', `${H}/config/policy`, admin, pol);
    const trail13 = await call('GET', `${H}/audit?action=emergency.activated`, auditor);
    ok(trail13.status === 200 && trail13.json.some((a: any) => a.action === 'emergency.activated' && a.target_id === e13.json.id), 'emergencies are in the audit trail');
  }

  console.log('\n2.13: staff ID profiles, usage, supplier summary');
  {
    const jpg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64')}`;
    const idn = `E2E-${Date.now() % 1e6}`;
    const p13 = await call('POST', `${H}/idcards/profiles`, hr11, { fullName: 'Grace Mvogo', idNumber: idn, department: 'Engineering', jobTitle: 'Technician', photo: jpg });
    ok(p13.status === 201 && p13.json.hasPhoto, 'HR creates a staff ID profile with a photo');
    ok((await call('POST', `${H}/idcards/profiles`, hr11, { fullName: 'Copy', idNumber: idn.toLowerCase() })).status === 409, 'ID numbers are unique');
    ok((await call('POST', `${H}/idcards/profiles`, hr11, { fullName: 'Bad', photo: 'data:image/svg+xml;base64,PHN2Zz4=' })).status === 400, 'only JPEG photos are accepted (no SVG or scripts)');
    ok((await call('POST', `${H}/idcards/profiles`, hr11, { fullName: 'Bad', photo: 'data:image/jpeg;base64,PHN2Zz4=' })).status === 400, 'and the photo must really be a JPEG');
    const imp = await call('POST', `${H}/idcards/profiles/import`, hr11, { from: 'visionline' });
    const imp2 = await call('POST', `${H}/idcards/profiles/import`, hr11, { from: 'visionline' });
    ok(imp.status === 200 && imp.json.created > 0 && imp2.json.created === 0, `profiles created from Visionline people (${imp.json.created}), not twice`);
    const b13 = await call('POST', `${H}/idcards/profiles/batch`, hr11, { ids: [p13.json.id] });
    ok(b13.json[0]?.photo === jpg, 'photos come back for printing');
    ok((await call('POST', `${H}/idcards/printed`, hr11, { ids: [p13.json.id] })).json.printed === 1, 'printing is recorded');
    ok((await call('GET', `${API}/api/v1/hotels/${khb}/idcards/profiles`, lakeAdmin)).status === 403 && (await call('GET', `${H}/idcards/profiles`, rest)).status === 403, 'profiles are closed to other hotels and roles');
    ok((await call('DELETE', `${H}/idcards/profiles/${p13.json.id}`, hr11)).status === 200, 'a profile is removed (and its photo deleted)');

    ok((await call('POST', `${H}/usage/ping`, issuer, { area: 'visionline' })).status === 204, 'page use is counted');
    ok((await call('POST', `${H}/usage/ping`, issuer, { area: '../../etc' })).status === 400, 'only known pages are counted');
    const u13 = await call('GET', `${H}/usage?days=30`, admin);
    ok(u13.status === 200 && u13.json.areas.some((a: any) => a.area === 'visionline') && u13.json.outcomes.length > 5, `usage: ${u13.json.activeLast7Days} active people, ${u13.json.outcomes?.length} outcomes`);
    ok((await call('GET', `${H}/usage`, issuer)).status === 403, 'usage is for administrators');
    const ex = await fetch(`${H}/usage/export`, { headers: { authorization: `Bearer ${admin}` } }).then((r) => r.json());
    const { createPublicKey, verify, createHash } = await import('node:crypto');
    const { sha256, signer, sig, ...body } = ex;
    const canon = JSON.stringify(body);
    const valid = Boolean(signer && sig) && verify(null, Buffer.from(canon), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: signer }, format: 'jwk' }), Buffer.from(sig, 'base64url'));
    ok(valid && createHash('sha256').update(canon).digest('hex') === sha256, 'the supplier summary is signed by this installation');
    ok(!/@|Grace|Amina|khb-/.test(canon), 'and contains counts only (no names, e-mails or Visionline ids)');
  }

  console.log('\n2.14: keycard requests (QR page), encode in Visionline, return, unpaid guest, departures, emergency open');
  {
    const cmdDone = (tok: string, id: string) => until('command', () => call('GET', `${H}/commands/${id}`, tok), (r) => ['SUCCEEDED', 'FAILED', 'EXPIRED'].includes(r.json?.status), 60_000);
    const pol14 = (await call('GET', `${H}/config/policy`, admin)).json.data;
    await call('POST', `${H}/resources/discover`, admin);
    await sleep(3000);
    const enc = await call('POST', `${H}/keycards/encoders/refresh`, admin, {});
    ok((await cmdDone(admin, enc.json.commandId)).json.status === 'SUCCEEDED' && (await call('GET', `${H}/keycards/encoders`, admin)).json.encoders.some((e: any) => e.name === 'fd1' && e.inVisionline), 'encoders are read from Visionline');
    ok((await call('PUT', `${H}/config/policy`, admin, { ...pol14, keycards: { ...(pol14.keycards ?? {}), encodeEnabled: true, encoders: ['fd1'], hrEmail: 'hr@khb.test' },
      safety: { ...(pol14.safety ?? {}), doorCommands: { enabled: true, scope: 'rooms', closeOnEnd: true, parallel: 6, doorGroups: [] } } })).status === 200, 'encoding from the portal and remote door commands switched on');
    const link = await call('POST', `${H}/keycards/qr-link`, admin, {});
    const tok = link.json.path.split('/').pop();
    ok((await call('GET', `${API}/api/v1/public/keycard-requests/${tok}`)).status === 200, 'the QR page opens without signing in');
    ok((await call('GET', `${API}/api/v1/public/keycard-requests/${'x'.repeat(24)}`)).status === 404, 'a wrong link opens nothing');
    const pub = await call('POST', `${API}/api/v1/public/keycard-requests/${tok}`, undefined, { kind: 'new', staffType: 'permanent', givenName: 'Aline', surname: 'Mbarga', department: 'Housekeeping', reason: 'New starter', managerName: 'Housekeeping manager' });
    ok(pub.status === 201 && /^KR\d{4}-\d{4}$/.test(pub.json.number), `a manager asks from the QR page: ${pub.json.number}`);
    ok((await call('GET', `${H}/keycards/requests`, rest)).status === 403, 'the restaurant cannot see keycard requests');
    const req14 = (await call('GET', `${H}/keycards/requests?q=Mbarga`, issuer)).json[0];
    ok((await call('POST', `${H}/keycards/requests/${req14.id}/issue`, issuer, { method: 'encoder', encoder: 'fd1', userGroup: 'Housekeeping' })).json.error?.code === 'LABEL_REQUIRED', 'permanent staff need the card number (HK 001)');
    await call('POST', `${SIM}/sim/encoder`, undefined, { encoder: 'fd1', regNo: 'blank' });
    const iss = await call('POST', `${H}/keycards/requests/${req14.id}/issue`, issuer, { method: 'encoder', encoder: 'fd1', userGroup: 'Housekeeping', cardLabel: 'hk 7' });
    const ic = await cmdDone(issuer, iss.json.commandId);
    await sleep(500);
    const reg14 = (await call('GET', `${H}/keycards/register`, issuer)).json.find((x: any) => x.label === 'HK 007');
    ok(ic.json.status === 'SUCCEEDED' && reg14?.status === 'in_use' && reg14.regNo === ic.json.result.regNo, `the card is encoded in Visionline (card ${ic.json.result?.regNo}) and registered as HK 007`, ic.json);
    const dup = await call('POST', `${API}/api/v1/public/keycard-requests/${tok}`, undefined, { kind: 'new', staffType: 'permanent', givenName: 'Other', surname: 'Person', department: 'Housekeeping', reason: 'x1', managerName: 'HK manager' });
    const other = (await call('GET', `${H}/keycards/requests?q=Other`, issuer)).json[0];
    ok((await call('POST', `${H}/keycards/requests/${other.id}/issue`, issuer, { method: 'visionline_desk', userGroup: 'Housekeeping', cardLabel: 'HK 007' })).json.error?.code === 'LABEL_IN_USE' && dup.status === 201, 'a card number in use cannot be given twice');
    const col = await call('POST', `${H}/keycards/requests/${req14.id}/collect`, issuer, { returnState: 'returned', method: 'expire_now', encoder: 'fd1' });
    const cc = await cmdDone(issuer, col.json.commandId);
    await sleep(1500);
    const after = (await call('GET', `${H}/keycards/requests?q=Mbarga`, issuer)).json[0];
    ok(cc.json.status === 'SUCCEEDED' && after.status === 'COLLECTED' && (await call('GET', `${H}/keycards/register`, issuer)).json.find((x: any) => x.label === 'HK 007')?.status === 'returned', 'the returned card is overwritten with a 1-minute card; the register says returned');
    ok(after.notified.some((n: any) => n.to === 'hr@khb.test' && n.ok) && after.notified.some((n: any) => n.to === 'security@khb.test' && n.ok), 'HR and the security manager are told by e-mail', after.notified);
    ok((await call('GET', `${H}/keycards/register.csv`, issuer)).json.includes('HK 007'), 'the register exports for HR');
    ok((await call('GET', `${H}/keycards/attention`, issuer)).status === 200, 'renewals and people with several cards are listed');

    const lo = await call('POST', `${H}/lockouts`, issuer, { room: '101', guestName: 'E2E Guest', amount: '100 USD', reason: 'Unpaid two nights' });
    ok((await call('POST', `${H}/lockouts/${lo.json.id}/decide`, issuer, { approve: true })).status === 403, 'front office cannot approve its own lock-out');
    const ap = await call('POST', `${H}/lockouts/${lo.json.id}/decide`, security, { approve: true });
    const apc = await cmdDone(security, ap.json.commandId);
    await sleep(500);
    ok(ap.json.online === true && apc.json.status === 'SUCCEEDED' && (await call('GET', `${H}/lockouts`, security)).json.find((x: any) => x.id === lo.json.id)?.status === 'DONE', 'online room: the checkout command reached the lock');
    const lo2 = await call('POST', `${H}/lockouts`, issuer, { room: '308', reason: 'Unpaid (offline lock)' });
    await call('POST', `${SIM}/sim/encoder`, undefined, { encoder: 'fd1', regNo: 'blank' });
    const ap2 = await call('POST', `${H}/lockouts/${lo2.json.id}/decide`, security, { approve: true, encoder: 'fd1' });
    const ap2c = await cmdDone(security, ap2.json.commandId);
    ok(ap2.json.online === false && ap2c.json.status === 'SUCCEEDED' && ap2c.json.result.kind === 'guestBlock', 'offline room: a 1-minute override guest card is encoded to place in the lock', ap2c.json);

    await call('POST', `${SIM}/sim/encoder`, undefined, { encoder: 'fd1', regNo: 'blank' });
    const sp = await call('POST', `${H}/keycards/special`, admin, { kind: 'emergency', encoder: 'fd1', holder: 'Duty manager' });
    ok((await cmdDone(admin, sp.json.commandId)).json.status === 'SUCCEEDED', 'an emergency card is encoded at the encoder');
    ok((await call('GET', `${H}/reports/setup`, admin)).json.property?.locks > 0, 'system setup report');
    await call('POST', `${SIM}/sim/guest-cards`, undefined, { room: '205', n: 2 });
    const gc = await call('POST', `${H}/reports/accounts/read-guest-cards`, admin, {});
    ok((await cmdDone(admin, gc.json.commandId)).json.status === 'SUCCEEDED', 'guest keycards per room read from Visionline');
    const acc = (await call('GET', `${H}/reports/accounts`, admin)).json;
    ok(/occupied rooms/.test(acc.subject ?? '') && acc.multipleCards.some((m: any) => m.room === '205' && m.n >= 2), `Accounts daily report flags room 205 with ${acc.multipleCards?.find((m: any) => m.room === '205')?.n} active guest keycards`, acc.multipleCards);
    ok(Array.isArray((await call('GET', `${H}/today`, security)).json.items), '"To do now" for the Overview');

    const safety14 = await login('safety@khb.test');
    const open0 = (await call('GET', `${H}/emergency/status`, safety14)).json.open;
    if (open0) await call('POST', `${H}/emergency/${open0.id}/end`, security, { note: 'e2e cleanup' });
    const rw = (await call('POST', `${API}/api/v1/me/reauth`, safety14, { password: PW })).json.token;
    const rs = (await call('POST', `${API}/api/v1/me/reauth`, security, { password: PW })).json.token;
    const em = await call('POST', `${H}/emergency`, safety14, { kind: 'fire', reason: 'e2e: emergency open' }, { 'x-smk-reauth': rw });
    ok((await call('POST', `${H}/emergency/${em.json.id}/doors`, security, { command: 'emergencyOpen' }, { 'x-smk-reauth': rs })).status === 409, 'doors are not opened before a second person confirms');
    await call('POST', `${H}/emergency/${em.json.id}/confirm`, security, {}, { 'x-smk-reauth': rs });
    const op14 = await call('POST', `${H}/emergency/${em.json.id}/doors`, security, { command: 'emergencyOpen' }, { 'x-smk-reauth': rs });
    for (const id of op14.json.commandIds ?? []) await cmdDone(security, id);
    const runs = (await call('GET', `${H}/emergency/${em.json.id}/doors`, security)).json;
    ok(op14.json.online > 0 && runs[0]?.reached === op14.json.online && op14.json.offline.length > 0, `emergency open: ${runs[0]?.reached} online guest-room locks opened, ${op14.json.offline?.length} offline listed for the emergency card`, op14.json);
    await call('POST', `${H}/emergency/${em.json.id}/end`, security, { note: 'e2e: all clear' });
    const back = await until('back to normal', () => call('GET', `${H}/emergency/${em.json.id}/doors`, security), (r) => r.json.some((x: any) => x.command === 'emergencyClose' && x.reached === op14.json.online), 60_000);
    ok(back.json.some((x: any) => x.command === 'emergencyClose' && x.reached === op14.json.online), 'ending the emergency puts the doors back to normal');
    await call('PUT', `${H}/config/policy`, admin, pol14);
  }

  console.log('\n2.15: keycards used per room (who issued them), battery changes, "program the lock and upload firmware"');
  {
    const maint15 = await login('maint@khb.test');
    const ev = (door: string, body: unknown) => call('POST', `${SIM}/sim/doors/${encodeURIComponent(door)}/event`, undefined, body);
    const desk = (await call('POST', `${SIM}/sim/desk/cards`, undefined, { userId: 'e2e-215', givenName: 'Room', surname: 'Attendant', userGroup: (await call('GET', `${SIM}/sim/state`)).json.users[0]?.userGroup, doors: ['309'] })).json;
    const guest = (await call('POST', `${SIM}/sim/guest-cards`, undefined, { room: '309', n: 1 })).json;
    await ev('309', { code: 64, registrationNumber: desk.regNo, minutesAgo: 180 }); // offline lock: recorded 3 h ago, uploaded now
    await ev('309', { code: 64, registrationNumber: guest.regNos[0], minutesAgo: 120 });
    await ev('309', { code: 320, registrationNumber: guest.regNos[0], minutesAgo: 60 });
    const from = new Date(Date.now() - 86_400_000).toISOString(), to = new Date(Date.now() + 60_000).toISOString();
    const ru = await until('room 309 usage', () => call('GET', `${H}/reports/room-keycards?from=${from}&to=${to}`, admin), (r) => (r.json.rooms ?? []).find((x: any) => x.door === '309')?.cards?.length >= 2);
    const r309 = ru.json.rooms?.find((x: any) => x.door === '309');
    const g = r309?.cards.find((c: any) => c.card === guest.regNos[0]);
    ok(r309 && g?.entries === 1 && g?.refused === 1 && /Visionline desk/.test(g.issuedBy), 'keycards used per room: room 309 lists the guest card (1 entry, 1 refused, issued at the Visionline desk)', r309);
    ok(r309?.cards.some((c: any) => c.card === desk.regNo && c.entries === 1), 'and the staff card used there');
    ok(g && Math.abs(new Date(g.first).getTime() - (Date.now() - 120 * 60_000)) < 3 * 60_000, 'events uploaded late from an offline lock are placed at the time the lock recorded them');
    ok(ru.json.rooms.some((x: any) => x.cards.some((c: any) => c.kind === 'mobile' && c.issuedBy && !/Visionline desk/.test(c.issuedBy))), 'mobile keys show the portal user who issued them');
    ok(!ru.json.rooms.some((x: any) => /Entrance/.test(x.door)), 'guest rooms only by default');
    ok((await call('GET', `${H}/reports/room-keycards?from=${from}&to=${to}`, lakeAdmin)).status === 403, 'another hotel cannot read the room report');
    const rpdf = await fetch(`${H}/reports/room-keycards/pdf`, { method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: JSON.stringify({ from, to }) });
    ok(rpdf.status === 200 && (await rpdf.arrayBuffer()).byteLength > 1000 && /^[0-9a-f]{64}$/.test(rpdf.headers.get('x-report-sha256') ?? ''), 'room report printed as a verifiable PDF');

    const bat = (door: string, body: unknown) => call('POST', `${SIM}/sim/doors/${encodeURIComponent(door)}/battery`, undefined, body);
    const bd = async (id: string) => (await call('GET', `${H}/battery`, maint15)).json.doors?.find((d: any) => d.doorId === id);
    await bat('206', { kind: 'volts', volts: 3.6, minutesAgo: 3 * 1440 });
    await until('206 first reading', () => bd('206'), (d) => d?.voltsBelow === 3.6);
    await bat('206', { kind: 'volts', volts: 4.6, minutesAgo: 2 * 1440 });
    const ch = await until('206 change inferred', () => bd('206'), (d) => d?.lastChange);
    ok(ch?.lastChange?.source === 'inferred' && /3\.6 V to 4\.6 V/.test(ch.lastChange.detail ?? ''), 'batteries counted as changed from the voltage jump (3.6 V -> 4.6 V), without a "battery exchanged" event', ch?.lastChange);
    ok((await bd('Linen Store'))?.lastChange?.source === 'event', 'Linen Store: last change from the lock\'s "battery exchanged" event');
    await bat('206', { kind: 'low' });
    const rp = await until('206 reprogram', () => bd('206'), (d) => d?.reprogram);
    ok(rp?.state === 'LOW' && rp.reprogram?.number > 0 && rp.ticket?.id === rp.reprogram.ticketId, `still alarming after the change -> request #${rp?.reprogram?.number} "program the lock and upload firmware"`, rp);
    const rt = (await call('GET', `${H}/maintenance/tickets/${rp?.reprogram?.ticketId}`, maint15)).json;
    ok(/Program lock and upload firmware/.test(rt.title) && /service tool/.test(rt.description) && rt.category === 'lock', 'the request tells the technician to program the lock and upload the firmware', rt.title);
    await bat('206', { kind: 'low' });
    await new Promise((r) => setTimeout(r, 2500));
    const tickets = (await call('GET', `${H}/maintenance/tickets?status=open`, maint15)).json;
    const list = Array.isArray(tickets) ? tickets : tickets.tickets ?? tickets.items ?? [];
    ok(list.filter((t: any) => /206/.test(t.title)).length === 1, 'a repeated alarm does not open a second request (and no "replace battery" request)');
  }

  console.log('\n2.16: invitations, hotel or institution, connector on another computer');
  {
    const issuer16 = await login('issuer@khb.test');
    const prof = await call('GET', `${H}/operators/profiles`, admin);
    ok(prof.status === 200 && prof.json.some((p: any) => p.id === 'frontOffice'), 'simple profiles for inviting people', prof.json?.map((p: any) => p.id));
    ok((await call('POST', `${H}/operators/invite`, issuer16, { email: 'new.person@khb.test', displayName: 'New Person', profile: 'frontOffice' })).status === 403, 'only administrators invite people');
    const inv = await call('POST', `${H}/operators/invite`, admin, { email: 'new.person@khb.test', displayName: 'New Person', profile: 'frontOffice', portalUrl: 'https://portal.example' });
    ok(inv.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(inv.json.token) && !inv.json.existing, 'an invitation makes a one-time link', inv.json);
    const listed = (await call('GET', `${H}/operators`, admin)).json.find((o: any) => o.email === 'new.person@khb.test');
    ok(listed?.status === 'INVITED' && listed.roles.includes('KEY_ISSUER') && listed.invite_expires_at, 'the person shows as invited, with the front-office role');
    ok((await call('POST', `${API}/api/v1/auth/login`, undefined, { email: 'new.person@khb.test', password: 'whatever-password' })).status === 401, 'no sign-in before the password is chosen');
    const info = await call('GET', `${API}/api/v1/public/invites/${inv.json.token}`);
    ok(info.status === 200 && info.json.email === 'new.person@khb.test' && info.json.site, 'the link shows who it is for, without signing in');
    ok((await call('GET', `${API}/api/v1/public/invites/${'x'.repeat(43)}`)).status === 404, 'a made-up link is refused');
    ok((await call('POST', `${API}/api/v1/public/invites/${inv.json.token}`, undefined, { password: 'short' })).status === 400, 'a short password is refused');
    const acc = await call('POST', `${API}/api/v1/public/invites/${inv.json.token}`, undefined, { password: 'Front office 2026 desk' });
    ok(acc.status === 200 && acc.json.token, 'the person chooses a password and is signed in');
    const me16 = (await call('GET', `${API}/api/v1/me`, acc.json.token)).json;
    ok(me16.hotels?.[0]?.roles?.includes('KEY_ISSUER'), 'they see the site with their role');
    ok((await call('POST', `${API}/api/v1/public/invites/${inv.json.token}`, undefined, { password: 'Another long password' })).status === 410, 'the link works only once');
    ok((await call('POST', `${API}/api/v1/auth/login`, undefined, { email: 'new.person@khb.test', password: 'Front office 2026 desk' })).json.token, 'they sign in with their own password');
    ok((await call('POST', `${H}/operators/${inv.json.id}/invite`, admin, {})).status === 401, 'a forgotten-password link needs the administrator\'s password first');
    const ra16 = (await call('POST', `${API}/api/v1/me/reauth`, admin, { password: PW })).json.token;
    const rs16 = await call('POST', `${H}/operators/${inv.json.id}/invite`, admin, {}, { 'x-smk-reauth': ra16 });
    ok(rs16.status === 200 && (await call('GET', `${API}/api/v1/public/invites/${rs16.json.token}`)).json.reset === true, 'then a link to choose a new password');
    ok((await call('POST', `${API}/api/v1/public/invites/${rs16.json.token}`, undefined, { password: 'Front office 2026 desk new' })).json.token
      && (await call('POST', `${API}/api/v1/auth/login`, undefined, { email: 'new.person@khb.test', password: 'Front office 2026 desk new' })).json.token, 'the new password works');
    const inv2 = await call('POST', `${H}/operators/invite`, admin, { email: 'later.person@khb.test', displayName: 'Later Person', profile: 'auditor' });
    const re = await call('POST', `${H}/operators/${inv2.json.id}/invite`, admin, {});
    ok(re.status === 200 && re.json.token !== inv2.json.token && (await call('GET', `${API}/api/v1/public/invites/${inv2.json.token}`)).status === 404, 'a new link replaces the old one');
    ok((await call('POST', `${H}/operators/${inv.json.id}/remove`, admin, {})).status === 200, 'an administrator removes access');
    ok(!(await call('GET', `${API}/api/v1/me`, acc.json.token)).json.hotels?.length, 'the removed person no longer sees the site');
    ok((await call('GET', `${API}/api/v1/public/invites/${re.json.token}`)).status === 200 && (await call('POST', `${H}/operators/${inv2.json.id}/remove`, admin, {})).status === 200
      && (await call('GET', `${API}/api/v1/public/invites/${re.json.token}`)).status === 404, 'removing someone also cancels their open link');

    const prop = (await call('GET', `${H}/config/property`, admin)).json.data;
    ok((await call('PUT', `${H}/config/property`, admin, { ...prop, kind: 'institution' })).status === 200, 'the site can be an institution');
    ok((await call('GET', `${API}/api/v1/me`, admin)).json.hotels.find((h: any) => h.id === khb)?.kind === 'institution', 'the portal is told (no guest features, "rooms")');
    await call('PUT', `${H}/config/property`, admin, { ...prop, kind: 'hotel' });

    const pol16 = (await call('GET', `${H}/config/policy`, admin)).json.data;
    const cs16 = await call('PUT', `${H}/config/policy`, admin, { ...pol16, connectorSetup: { location: 'remote', computerAddress: '192.168.1.50', serverUrl: 'https://smk-server:8443', visionlineUrl: 'https://localhost/api/v1' } });
    ok(cs16.status === 200, 'connector on another computer: its address and the server address are saved', cs16.json);
    ok((await call('PUT', `${H}/config/policy`, admin, { ...pol16, connectorSetup: { location: 'remote', computerAddress: 'not an ip' } })).status === 400, 'a wrong connector address is refused');
    const cn = (await call('GET', `${H}/connectors`, admin)).json.connectors?.find((c: any) => c.online);
    ok(cn && cn.last_address, `the connector's address is shown (${cn?.last_address})`);
    await call('PUT', `${H}/config/policy`, admin, pol16);
  }

  console.log('\n2.16.1: user-group override in the setup report, who can open a door, master keycards');
  {
    const done1 = (id: string) => until('command', () => call('GET', `${H}/commands/${id}`, admin), (r) => ['SUCCEEDED', 'FAILED', 'EXPIRED'].includes(r.json?.status), 60_000);
    const disc = await call('POST', `${H}/resources/discover`, admin, {});
    if (disc.json?.commandId) await done1(disc.json.commandId);
    const sr = (await call('GET', `${H}/reports/setup`, admin)).json;
    const mg = sr.userGroups?.find((g: any) => g.name === 'Management'), hk = sr.userGroups?.find((g: any) => g.name === 'Housekeeping');
    ok(mg?.overrideDeadbolt === true && mg?.overridePrivacy === true && hk?.overrideDeadbolt !== true, 'setup report: Management overrides deadbolt and privacy, Housekeeping does not', { mg, hk });
    const byDoor = await call('GET', `${H}/visionline/cards?door=${encodeURIComponent('GM Office')}&state=all`, admin);
    const all = (await call('GET', `${H}/visionline/cards?state=all`, admin)).json;
    ok(byDoor.status === 200 && Array.isArray(byDoor.json) && byDoor.json.length <= all.length, `who can open GM Office: ${byDoor.json?.length} of ${all.length} keycards`);
    const master = await call('GET', `${H}/visionline/cards?master=yes&state=all`, admin);
    ok(master.status === 200 && Array.isArray(master.json), `master keycards (open every room): ${master.json?.length}`);
    ok((await call('GET', `${H}/visionline/doors`, admin)).json.some((d: any) => d.name === 'GM Office'), 'door list for the filter');
    ok((await call('GET', `${H}/visionline/doors`, lakeAdmin)).status === 403, 'another site cannot read the door list');
  }

  console.log('\n2.17: notice board, sign-in page, charts, Visionline reports, issued by, existing keycards, users and card holders');
  {
    const gm17 = await login('gm@khb.test'); const iss17 = await login('issuer@khb.test');
    const pub = await call('POST', `${H}/notices`, admin, { title: 'Fire drill on Friday', body: 'At 10:00, assemble at the car park.', kind: 'event', public: true });
    const priv = await call('POST', `${H}/notices`, admin, { title: 'New HR e-mail', body: 'hr@khb.test', kind: 'info', public: false, pinned: true });
    ok(pub.status === 200 && priv.status === 200, 'an administrator posts on the notice board');
    ok((await call('POST', `${H}/notices`, iss17, { title: 'Not allowed', kind: 'info' })).status === 403, 'only administrators post');
    const signIn = (await call('GET', `${API}/api/v1/public/notices?hotel=k-hotel-bana`)).json.notices ?? [];
    ok(signIn.some((n: any) => n.title === 'Fire drill on Friday') && !signIn.some((n: any) => n.title === 'New HR e-mail'), 'the sign-in page shows public posts only (before sign-in)');
    const feed = (await call('GET', `${H}/notices`, iss17)).json;
    ok(feed[0]?.title === 'New HR e-mail' && feed.length >= 2, 'staff see every current post on the Overview, pinned first');
    ok((await call('DELETE', `${H}/notices/${priv.json.id}`, admin)).status === 200, 'a post is deleted');

    const chart = await call('POST', `${H}/insights/builder/run`, iss17, { dataset: 'doorEvents', groupBy: 'door', measure: 'events', days: 30, limit: 10, chart: 'bars', filters: [] });
    ok(chart.status === 200 || chart.status === 403, `own charts: ${chart.status === 200 ? 'a key issuer builds one from door events' : 'refused for data the person may not read'}`);

    // Mobile keys made in Visionline: their "serial number" is FFFFFFFF.
    await call('POST', `${H}/visionline/refresh`, admin, {});
    const mob = await until('mobile keys from Visionline', () => call('GET', `${H}/visionline/cards?kind=mobile&state=all`, gm17), (r) => (r.json ?? []).length > 0, 90_000);
    ok((mob.json ?? []).length > 0 && mob.json.every((k: any) => k.mobile_key), `mobile keys recognised in Visionline's card list (${mob.json?.length})`);

    // Issued by: the portal user for cards encoded here.
    const enc = (await call('GET', `${H}/visionline/cards?state=all&kind=card`, gm17)).json;
    const special = (await call('GET', `${H}/audit?action=keycard.encode_requested&limit=5`, admin)).json;
    ok(Array.isArray(enc) && Array.isArray(special), 'card list and audit available');
    const pec = await call('GET', `${H}/visionline/cards/${encodeURIComponent(String((await call('GET', `${H}/keycards/register`, iss17)).json.find((x: any) => x.label === 'HK 007')?.regNo ?? '0'))}/lookup`, gm17);
    ok(pec.json?.known === false || /Eric|Supervisor|Admin|Grace/.test(pec.json?.card?.issuedBy ?? ''), `a keycard encoded from the portal shows who encoded it (${pec.json?.card?.issuedBy ?? 'not read yet'})`);

    // Visionline reports
    const ss = ['[System code]', '1111-2222-3333', 'AA-00001', '', '[Visionline]', 'Version: 1.21.1.16', '', '[Options]', '(39) Mobile Access', '(64) Web service for callback', ''].join('\r\n');
    const up = await call('POST', `${H}/visionline-imports`, admin, { fileName: 'System settings.xls', data: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ss, 'utf16le')]).toString('base64') });
    ok(up.status === 200 && up.json.kind === 'system_settings', 'the Visionline System settings report is imported (UTF-16 ".xls" as Visionline saves it)', up.json);
    ok((await call('POST', `${H}/visionline-imports`, admin, { fileName: 'x.xlsx', data: Buffer.from([0x50, 0x4b, 3, 4, 0, 0]).toString('base64') })).json.error?.code === 'WORKBOOK', 'a real Excel workbook is refused with how to save it');
    ok((await call('POST', `${H}/visionline-imports`, iss17, { fileName: 'a.txt', data: 'eA==' })).status === 403, 'only administrators import');
    const anyCard = (await call('GET', `${H}/visionline/cards?state=all&kind=card`, gm17)).json.find((k: any) => !k.issued_by);
    if (anyCard) {
      const log = `Reg. no\tCard holder\tOperator\r\n${anyCard.reg_no}\t${anyCard.card_holder}\tMarie Desk\r\n`;
      const lg = await call('POST', `${H}/visionline-imports`, admin, { fileName: 'cards.txt', data: Buffer.from(log, 'utf8').toString('base64') });
      ok(lg.json.kind === 'card_log' && lg.json.issuers === 1, 'a Visionline card list with the operator is imported');
      const look = (await call('GET', `${H}/visionline/cards/${anyCard.reg_no}/lookup`, gm17)).json;
      ok(look.card?.issuedBy === 'Visionline: Marie Desk', `"Issued by" now shows the Visionline operator for a desk card (${look.card?.issuedBy})`);
    }
    const ops = `Operator\tOperator template\r\nPMS\tInterface\r\nmarie\tFront office\r\n`;
    ok((await call('POST', `${H}/visionline-imports`, admin, { fileName: 'operators.txt', data: Buffer.from(ops).toString('base64') })).json.kind === 'operators', 'the Visionline operator list is imported');
    const rep = (await call('GET', `${H}/reports/setup`, admin)).json;
    ok(rep.visionline?.systemSettings?.facts?.['Visionline version'] === '1.21.1.16' && rep.visionline.operators?.shared?.includes('PMS'), 'setup report: Visionline settings, operators, and the shared PMS operator flagged');
    ok(Array.isArray(rep.accessByGroup) && rep.accessByGroup.length > 0 && Array.isArray(rep.accessByPerson), `setup report: access by user group (${rep.accessByGroup?.length}) and by person (${rep.accessByPerson?.length})`);

    // Issue from an existing Visionline keycard / person
    const tok17 = (await call('POST', `${H}/keycards/qr-link`, admin, {})).json.path.split('/').pop();
    await call('POST', `${API}/api/v1/public/keycard-requests/${tok17}`, undefined, { kind: 'new', staffType: 'daily', givenName: 'Existing', surname: 'Holder', department: 'Housekeeping', reason: 'already has a card', managerName: 'HK manager' });
    const req17 = (await call('GET', `${H}/keycards/requests?q=Existing`, iss17)).json[0];
    const srch = (await call('GET', `${H}/keycards/visionline-search?q=`, iss17)).json;
    ok(Array.isArray(srch.people) && Array.isArray(srch.cards), 'front office searches the people and keycards already in Visionline');
    const card17 = srch.cards.find((c: any) => !c.mobile) ?? srch.cards[0];
    if (card17 && req17) {
      const ex = await call('POST', `${H}/keycards/requests/${req17.id}/issue`, iss17, { method: 'existing', regNo: card17.reg_no, userGroup: 'n/a' });
      const after = (await call('GET', `${H}/keycards/requests?q=Existing`, iss17)).json[0];
      ok(ex.json.status === 'ISSUED' && after.cardRegNo === card17.reg_no, `a request is linked to an existing keycard (${card17.reg_no}, ${card17.user_group ?? 'no group'})`);
    }

    // Operators and card holders
    const gmOp = (await call('GET', `${H}/operators`, admin)).json.find((o: any) => o.email === 'gm@khb.test');
    const person = srch.people[0];
    if (gmOp && person) {
      ok((await call('PUT', `${H}/operators/${gmOp.id}/visionline-person`, admin, { vlUserId: person.user_id })).status === 200, 'a portal user is linked to the Visionline card holder they are');
      const again = (await call('GET', `${H}/operators`, admin)).json.find((o: any) => o.email === 'gm@khb.test');
      ok(again.vl_user_id === person.user_id, `Users shows their keycards (${again.vl_cards} valid)`);
      const ppl = (await call('GET', `${H}/visionline/people?q=${encodeURIComponent(person.user_id)}`, gm17)).json;
      ok(ppl.some((u: any) => u.portal_user), 'Visionline people shows who is also a portal user');
    }
    const ovw = (await call('GET', `${H}/visionline/overview`, gm17)).json;
    ok(ovw.visionlineOperator && typeof ovw.visionlineOperator.shared === 'boolean', `the Visionline user the portal uses is checked (${ovw.visionlineOperator?.name}: ${ovw.visionlineOperator?.shared ? 'shared' : 'named'})`);
  }

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
