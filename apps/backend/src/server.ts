import { existsSync } from 'node:fs';
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

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Never log credentials, signatures or tokens (spec §13.3).
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-installation-uuid"]'],
    },
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: true,
  });
  await app.register(cors, { origin: config.corsOrigins, credentials: false });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), details: err.issues } });
    if ((err as any).statusCode && (err as any).statusCode < 500) return reply.code((err as any).statusCode).send({ error: { code: (err as any).code ?? 'BAD_REQUEST', message: (err as Error).message } });
    req.log.error({ err }, 'unhandled');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong. The error has been logged.', correlationId: req.id } });
  });

  app.get('/healthz', async () => {
    await pool.query('SELECT 1');
    return { ok: true, time: new Date().toISOString() };
  });

  portalRoutes(app);
  portalAdminRoutes(app);
  mobileRoutes(app);
  connectorRoutes(app);
  integrationRoutes(app);
  phase2Routes(app);
  insightsRoutes(app);
  eventRoutes(app);
  monitoringRoutes(app);

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
