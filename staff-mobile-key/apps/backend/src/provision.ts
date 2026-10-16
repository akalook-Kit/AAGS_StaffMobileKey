/**
 * Production provisioning CLI (Render's start command runs it before the API). See provision-lib.ts.
 */
import { pool } from './db.ts';
import { provision } from './provision-lib.ts';

await provision();
await pool.end();
