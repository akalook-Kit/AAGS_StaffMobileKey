import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { pool } from './db.ts';

// SMK_MIGRATIONS_DIR is set by the on-premises service; in the source tree they sit next to src/.
const migrationsDir = () => process.env.SMK_MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Every migration this version knows, in order. */
export const migrationFiles = () => readdirSync(migrationsDir()).filter((x) => x.endsWith('.sql')).sort();

/**
 * Applies the named migrations that are not applied yet, in order, on a client that is already inside a
 * transaction (used by restore, which rebuilds the schema of an older copy before loading it).
 */
export async function applyMigrations(c: pg.PoolClient, names: string[]) {
  await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const wanted = new Set(names);
  for (const f of migrationFiles()) {
    if (done.has(f) || !wanted.has(f)) continue;
    await c.query(readFileSync(join(migrationsDir(), f), 'utf8').replace(/CREATE TABLE schema_migrations[^;]*;/, ''));
    await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
  }
}

export async function migrate() {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const f of migrationFiles()) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(migrationsDir(), f), 'utf8').replace(/CREATE TABLE schema_migrations[^;]*;/, '');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      await c.query('COMMIT');
      console.log(`[migrate] applied ${f}`);
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally { c.release(); }
  }
}

// Run as a CLI only from its own source file (never when bundled into platform.mjs).
// No top-level await here: this module is part of bundles whose imports form cycles, and an awaiting module in
// a cycle never finishes loading.
if (/[\\/]migrate\.ts$/.test(process.argv[1] ?? '')) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
