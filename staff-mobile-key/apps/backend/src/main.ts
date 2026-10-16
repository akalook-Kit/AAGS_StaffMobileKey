import { config } from './config.ts';
import { migrate } from './migrate.ts';
import { buildServer } from './server.ts';
import { startJobs } from './jobs.ts';
import { pool } from './db.ts';

// On-premises service: create K Hotel Bana's settings on first start (migrations always run).
if (process.env.PROVISION_ON_START === '1') { const { provision } = await import('./provision-lib.ts'); await provision(); }
else await migrate();
const app = await buildServer();
const jobs = startJobs();
await app.listen({ port: config.port, host: config.host });

// Clean stop: SIGTERM (Docker, Render) or end of input (Windows service host closes stdin).
let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  clearInterval(jobs);
  await app.close().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
if (process.env.SMK_SERVICE_STDIN_SHUTDOWN === '1') { process.stdin.resume(); process.stdin.on('end', () => void stop()); }
