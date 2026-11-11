import { existsSync } from 'node:fs';
import { reportsCentreRoutes } from './routes/reports-centre.ts';
import { demoRoutes } from './routes/demo.ts';
import { keycardCheckRoutes } from './keycard-check.ts';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config.ts';
import { pool } from './db.ts';
import { ApiError } from './lib/errors.ts';
import { portalRoutes } from './routes/portal.ts';
import { portalAdminRoutes } from './routes/portal-admin.ts';
import { mobileRoutes } from './routes/mobile.ts';
import { connectorRoutes } from './routes/connector.ts';
import { integrationRoutes } from './routes/integrations.ts';
import { phase2Routes } from './routes/phase2.ts';
import { insightsRoutes } from './routes/insights.ts';
import { eventRoutes } from './routes/events.ts';
import { monitoringRoutes } from './routes/monitoring.ts';
import { attendanceRoutes } from './routes/attendance.ts';
import { setupRoutes } from './routes/setup.ts';
import { serverRoutes } from './routes/server.ts';
import { visionlineDataRoutes } from './routes/visionline-data.ts';
import { licenceRoutes } from './routes/licence.ts';
import { accessRoutes, highlightRoutes } from './routes/access.ts';
import { keycardRoutes } from './routes/keycards.ts';
import { inviteRoutes } from './routes/invites.ts';
import { noticeRoutes } from './routes/notices.ts';
import { vlImportRoutes } from './routes/vl-imports.ts';
import { lockReportRoutes } from './routes/lock-reports.ts';
import { lockHistoryRoutes } from './routes/lock-history.ts';
import { lightRoutes } from './routes/light.ts';
import { gatewayRoutes } from './routes/gateways.ts';
import { safetyRoutes } from './routes/safety.ts';
import { reportBuilderRoutes } from './routes/report-builder.ts';
import { breakfastRoutes } from './routes/breakfast.ts';

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Never log credentials, signatures or tokens (spec §13.3).
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-installation-uuid"]'],
    },
    bodyLimit: 4 * 1024 * 1024,
    // Only the proxy right in front (the gateway on-premises, the host's proxy in the cloud) is trusted for the client address.
    trustProxy: Number(process.env.TRUST_PROXY_HOPS ?? 1) as any,
  });
  await app.register(cors, { origin: config.corsOrigins, credentials: false });

  // 2.25 In the Demo Hotel, "the connector is offline" and similar mean: there is no Visionline behind the demo.
  const demoIds = new Set<string>(); let demoAt = 0;
  const isDemo = async (id: string) => { if (Date.now() - demoAt > 60_000) { demoIds.clear(); for (const r of (await pool.query(`SELECT id FROM hotels WHERE is_demo`)).rows) demoIds.add(r.id); demoAt = Date.now(); } return demoIds.has(id); };
  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof ApiError && err.status === 409 && /^(CONNECTOR|NOT_CONFIGURED|NOT_READY|SYNC_OFF|ENCODER_READ_OFF|ENCODE_OFF)/.test(err.code)) {
      const hid = /\/hotels\/([0-9a-f-]{36})\//.exec(req.url)?.[1];
      if (hid && await isDemo(hid).catch(() => false)) return reply.code(409).send({ error: { code: 'DEMO_HOTEL', message: 'This is the Demo Hotel: there is no Visionline or encoder behind it, so this cannot run here. In a real hotel it would now go to Visionline.' } });
    }
    if (err instanceof ApiError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), details: err.issues } });
    // 2.13: a malformed id in the address (not a UUID, not a number) is the caller's mistake, not a server error.
    if (['22P02', '22007', '22008', '22003'].includes((err as any).code)) return reply.code(400).send({ error: { code: 'VALIDATION', message: 'A value in the request is not valid.' } });
    if ((err as any).statusCode && (err as any).statusCode < 500) return reply.code((err as any).statusCode).send({ error: { code: (err as any).code ?? 'BAD_REQUEST', message: (err as Error).message } });
    req.log.error({ err }, 'unhandled');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong. The error has been logged.', correlationId: req.id } });
  });

  // 2.13 (security review): browser protections on every answer, also when the platform is reached directly
  // (cloud hosting) and not through the on-premises gateway, which sets the same.
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-robots-tag', 'noindex, nofollow');
    reply.header('permissions-policy', 'camera=(self), microphone=(), geolocation=()');
    if (!reply.getHeader('content-security-policy'))
      reply.header('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
    if (req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    return payload;
  });

  app.get('/healthz', async () => {
    await pool.query('SELECT 1');
    return { ok: true, time: new Date().toISOString() };
  });

  licenceRoutes(app);
  portalRoutes(app);
  portalAdminRoutes(app);
  mobileRoutes(app);
  connectorRoutes(app);
  integrationRoutes(app);
  phase2Routes(app);
  insightsRoutes(app);
  eventRoutes(app);
  monitoringRoutes(app);
  attendanceRoutes(app);
  setupRoutes(app);
  serverRoutes(app);
  visionlineDataRoutes(app);
  breakfastRoutes(app);
  accessRoutes(app);
  highlightRoutes(app);
  reportBuilderRoutes(app);
  safetyRoutes(app);
  keycardRoutes(app);
  keycardCheckRoutes(app);
  demoRoutes(app);
  reportsCentreRoutes(app);
  inviteRoutes(app);
  noticeRoutes(app);
  vlImportRoutes(app);
  lockReportRoutes(app);
  lockHistoryRoutes(app);
  lightRoutes(app);
  gatewayRoutes(app);

  const dist = resolve(config.portalDist);
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', wildcard: true, index: 'index.html' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !/^\/(api|mobile|connector|integrations)\//.test(req.url)) return reply.sendFile('index.html');
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    });
  }
  return app;
}
