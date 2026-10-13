import { config } from './config.ts';
import { migrate } from './migrate.ts';
import { buildServer } from './server.ts';
import { startJobs } from './jobs.ts';

await migrate();
const app = await buildServer();
startJobs();
await app.listen({ port: config.port, host: config.host });
