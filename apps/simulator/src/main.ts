import Fastify from 'fastify';
import { createState, makeCallbackSender } from './state.ts';
import { ensureDevCerts } from './certs.ts';
import { registerVisionline } from './visionline.ts';
import { registerCredentialServices, lifecycle } from './credential-services.ts';
import { simPage } from './ui.ts';
import { registerOutbox } from './outbox.ts';

const env = (k: string, d: string) => process.env[k] ?? d;

const st = createState();
st.faults.sessionTtlSec = Number(env('SIM_SESSION_TTL_SEC', '1800'));
st.faults.clockOffsetSec = Number(env('SIM_CLOCK_OFFSET_SEC', '0'));
st.faults.deliveryDelayMs = Number(env('SIM_DELIVERY_DELAY_MS', '1500'));
st.mobileAccessOptions.uuid = Number(env('SIM_MOBILE_ACCESS_UUID', '9'));
st.mobileAccessOptions.revokeWhen = env('SIM_REVOKE_WHEN', 'overridden') === 'expired' ? 'expired' : 'overridden';
const systemId = st.mobileAccessAccounts[0]!.systemID;

const log = (m: string) => console.log(`[sim] ${m}`);
const send = makeCallbackSender(st, log);
const lc = lifecycle(st, send, systemId);

const certs = await ensureDevCerts(env('CERT_DIR', './certs'), env('VL_HOSTNAMES', 'localhost,simulator').split(','));

// Visionline Web API: HTTPS with TLS 1.2+, as on a real Visionline server [Web API §1].
const vl = Fastify({ https: { key: certs.key, cert: certs.cert, minVersion: 'TLSv1.2' } });
registerVisionline(vl, st, {
  basePath: '/api/v1',
  // Property operator plus personal operators (JSON in VL_OPERATORS adds more): {"name":"password"}
  operators: { [env('VL_OPERATOR_USER', 'smk-operator')]: env('VL_OPERATOR_PASSWORD', 'dev-operator-password'), sym: 'sym-dev-password', eric: 'eric-dev-password', sandra: 'sandra-dev-password', ...JSON.parse(env('VL_OPERATORS', '{}')) },
  accessIds: env('VL_ACCESS_IDS', 'khb-connector').split(','),
  timeZone: env('HOTEL_TIMEZONE', 'Africa/Douala'),
  ...lc,
});

// Credential Services + simulated SDK/locks + control page. Plain HTTP for local development only.
const cs = Fastify();
// Browser previews of the staff app call the simulated SDK endpoints cross-origin. Native apps do not need this.
cs.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/sdk/')) return;
  reply.header('access-control-allow-origin', '*').header('access-control-allow-headers', 'content-type').header('access-control-allow-methods', 'GET,POST');
  if (req.method === 'OPTIONS') return reply.code(204).send();
});
cs.options('/sdk/*', async (_req, reply) => reply.code(204).send());
registerCredentialServices(cs, st, {
  tenantUser: env('CS_TENANT_USER', 'khb-tenant'), tenantPassword: env('CS_TENANT_PASSWORD', 'dev-tenant-password'),
  send, log, systemId, timeZone: env('HOTEL_TIMEZONE', 'Africa/Douala'), onRevoke: lc.onCardRevoked,
});
cs.get('/', async (_req, reply) => reply.type('text/html').send(simPage()));
// Alert e-mail and SMS test sinks (2.7 monitoring): SMTP on SIM_SMTP_PORT, SMS gateways on this HTTP server.
if (!cs.hasContentTypeParser('application/x-www-form-urlencoded')) {
  cs.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
}
registerOutbox(cs, log, Number(env('SIM_SMTP_PORT', '2525')), env('SIM_SMS_USER', 'sms'), env('SIM_SMS_PASSWORD', 'sms-dev-password'));

const host = env('HOST', '0.0.0.0');
await vl.listen({ port: Number(env('VL_PORT', '8443')), host });
await cs.listen({ port: Number(env('CS_PORT', '8444')), host });
log(`Visionline Web API  https://localhost:${env('VL_PORT', '8443')}/api/v1  (trust ${certs.caPath})`);
log(`Credential Services http://localhost:${env('CS_PORT', '8444')}/cs   ·  lock simulator page http://localhost:${env('CS_PORT', '8444')}/`);
