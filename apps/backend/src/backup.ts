/**
 * Database copies made by the platform itself (2.9): no pg_dump, psql or other PostgreSQL client tools are
 * needed on the server. Used by the daily backup, "Back up now" in the portal, database-tools.ps1 and the
 * installer (copy before upgrading).
 *
 * File (.smkbak): gzip-compressed lines, each a JSON array:
 *   ["H", {format, formatVersion, platformVersion, createdAt, migrations[], tables[]}]
 *   ["T", "table"]            then one ["R", <row as JSON>] per row of that table
 *   ["E", {rows: {table: n}, sha256}]   sha256 of every line before this one (detects truncation and damage)
 * A "<file>.sha256" next to it holds the fingerprint of the whole file (detects any later change).
 *
 * The copy is consistent: all tables are read in one REPEATABLE READ transaction while the platform runs.
 * Rows are written as PostgreSQL produced them (row_to_json), never re-encoded, so no value loses precision.
 *
 * Restore: the schema is rebuilt with the migrations the copy was made with, the rows are loaded with the
 * foreign keys set aside and checked again at the end, sequences are moved past the highest id, and newer
 * migrations are applied. It all happens in one transaction: if anything fails, nothing changes.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip, createGzip } from 'node:zlib';
import { once } from 'node:events';
import type pg from 'pg';
import { pool, many, one } from './db.ts';
import { migrationFiles, applyMigrations } from './migrate.ts';
import { PLATFORM_VERSION } from './version.ts';

export const FORMAT = 'staff-mobile-key-backup';
const SKIP = new Set(['schema_migrations']);
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export type Progress = (p: { table: string; tableNo: number; tables: number; rows: number }) => void;

async function publicTables(c: pg.PoolClient | pg.Pool) {
  return (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows.map((r) => r.tablename as string).filter((t) => !SKIP.has(t));
}

/** Writes a consistent copy of the whole database to `file`. Returns its size and fingerprint. */
export async function writeBackup(file: string, progress?: Progress) {
  mkdirSync(dirname(file), { recursive: true });
  const part = `${file}.part`;
  const c = await pool.connect();
  const gz = createGzip({ level: 6 });
  const out = createWriteStream(part);
  gz.pipe(out);
  const inner = createHash('sha256');
  const counts: Record<string, number> = {};
  const write = async (line: string) => {
    inner.update(line).update('\n');
    if (!gz.write(`${line}\n`)) await once(gz, 'drain');
  };
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const migrations = (await c.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name as string);
    const tables = await publicTables(c);
    await write(JSON.stringify(['H', { format: FORMAT, formatVersion: 1, platformVersion: PLATFORM_VERSION, createdAt: new Date().toISOString(), migrations, tables }]));
    let n = 0;
    for (const t of tables) {
      n++;
      await write(JSON.stringify(['T', t]));
      counts[t] = 0;
      await c.query(`DECLARE smk_backup NO SCROLL CURSOR FOR SELECT row_to_json(x)::text AS j FROM public.${q(t)} x`);
      for (;;) {
        const r = await c.query('FETCH 2000 FROM smk_backup');
        for (const row of r.rows) { await write(`["R",${row.j}]`); counts[t]!++; }
        progress?.({ table: t, tableNo: n, tables: tables.length, rows: counts[t]! });
        if (r.rows.length < 2000) break;
      }
      await c.query('CLOSE smk_backup');
    }
    await c.query('COMMIT');
    const trailer = JSON.stringify(['E', { rows: counts, sha256: inner.digest('hex') }]);
    gz.end(`${trailer}\n`);
    await once(out, 'close');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    gz.destroy(); out.destroy();
    rmSync(part, { force: true });
    throw e;
  } finally { c.release(); }
  renameSync(part, file);
  const sha256 = await fileSha256(file);
  writeFileSync(`${file}.sha256`, `${sha256}  ${basename(file)}\n`);
  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
  return { file, bytes: statSync(file).size, sha256, tables: Object.keys(counts).length, rows: totalRows };
}

export async function fileSha256(file: string) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

interface Header { format: string; formatVersion: number; platformVersion: string; createdAt: string; migrations: string[]; tables: string[] }

/** Reads a copy line by line; calls onTable / onRow. Checks structure, counts and the inner fingerprint. */
async function readBackup(file: string, on: { table?: (t: string) => Promise<void> | void; row?: (t: string, json: string) => Promise<void> | void } = {}) {
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  const inner = createHash('sha256');
  let header: Header | null = null; let current: string | null = null; let trailer: any = null;
  const counts: Record<string, number> = {};
  for await (const line of rl) {
    if (trailer) throw new Error('Data after the end marker.');
    if (line.startsWith('["R",')) {
      if (!current) throw new Error('Row outside a table.');
      if (!line.endsWith(']')) throw new Error(`Damaged row in ${current}.`);
      counts[current]!++;
      inner.update(line).update('\n');
      if (on.row) await on.row(current, line.slice(5, -1));
      continue;
    }
    const v = JSON.parse(line);
    if (v[0] === 'H') {
      if (header) throw new Error('Two headers.');
      header = v[1];
      if (header!.format !== FORMAT) throw new Error('This file is not a Access Monitoring Tool database copy.');
      if (header!.formatVersion !== 1) throw new Error(`Copy format ${header!.formatVersion} is not supported by this version.`);
    } else if (v[0] === 'T') {
      if (!header) throw new Error('Table before the header.');
      current = v[1]; counts[current!] = 0;
      if (on.table) await on.table(current!);
    } else if (v[0] === 'E') { trailer = v[1]; continue; }
    else throw new Error('Unknown line in the copy.');
    inner.update(line).update('\n');
  }
  if (!header) throw new Error('Empty or unreadable copy.');
  if (!trailer) throw new Error('The copy is incomplete (no end marker): it was cut off while being written or copied.');
  if (trailer.sha256 !== inner.digest('hex')) throw new Error('The copy is damaged (its content does not match its own fingerprint).');
  for (const [t, n] of Object.entries(trailer.rows as Record<string, number>)) if (counts[t] !== n) throw new Error(`Table ${t}: ${counts[t] ?? 0} rows read, ${n} expected.`);
  return { header, rows: counts };
}

/** Checks a copy without changing anything: readable, complete, unchanged since it was made. */
export async function verifyBackup(file: string) {
  if (!existsSync(file)) throw new Error(`${file} not found.`);
  try { return await verifyInner(file); } catch (e) {
    const m = (e as Error).message;
    if (/unexpected end of file|incorrect header check|invalid (stored|block|distance|code)|Unexpected (token|end)|JSON/i.test(m)) throw new Error(`The copy is damaged or incomplete and cannot be read (${m}).`);
    throw e;
  }
}
async function verifyInner(file: string) {
  let fingerprint: 'match' | 'mismatch' | 'missing' = 'missing';
  const shaFile = `${file}.sha256`;
  if (existsSync(shaFile)) fingerprint = readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0]!.toLowerCase() === (await fileSha256(file)) ? 'match' : 'mismatch';
  if (fingerprint === 'mismatch') throw new Error('The copy was changed or damaged after it was made (its .sha256 fingerprint does not match).');
  const { header, rows } = await readBackup(file);
  return { ...header, fingerprint, tables: Object.keys(rows).length, rows: Object.values(rows).reduce((a, b) => a + b, 0), perTable: rows };
}

/**
 * Puts a copy back. Everything in the current database is replaced. The platform must be stopped
 * (database-tools.ps1 does that). One transaction: on any error nothing changes.
 */
export async function restoreBackup(file: string, progress?: Progress, opts: { exact?: boolean } = {}) {
  const checked = await verifyBackup(file);
  const known = migrationFiles();
  const unknown = checked.migrations.filter((m) => !known.includes(m));
  if (unknown.length) throw new Error(`The copy was made by a newer version (${checked.platformVersion}); install that version first. Unknown: ${unknown.join(', ')}`);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL lock_timeout = 10000');
    await c.query('DROP SCHEMA public CASCADE');
    await c.query('CREATE SCHEMA public');
    await applyMigrations(c, checked.migrations);
    const fks = (await c.query(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE contype='f' AND connamespace='public'::regnamespace`)).rows as { tbl: string; conname: string; def: string }[];
    for (const f of fks) await c.query(`ALTER TABLE ${f.tbl} DROP CONSTRAINT ${q(f.conname)}`);
    const tables = new Set(await publicTables(c));
    let batch: string[] = []; let bytes = 0; let table = ''; let tableNo = 0; let done = 0;
    const flush = async () => {
      if (!batch.length) return;
      await c.query(`INSERT INTO public.${q(table)} SELECT * FROM json_populate_recordset(NULL::public.${q(table)}, $1::json)`, [`[${batch.join(',')}]`]);
      done += batch.length; batch = []; bytes = 0;
      progress?.({ table, tableNo, tables: checked.tables, rows: done });
    };
    await readBackup(file, {
      table: async (t) => {
        await flush();
        if (!tables.has(t)) throw new Error(`Table ${t} of the copy does not exist at its version.`);
        table = t; tableNo++; done = 0;
      },
      row: async (_t, json) => { batch.push(json); bytes += json.length; if (batch.length >= 1000 || bytes > 8_000_000) await flush(); },
    });
    await flush();
    for (const f of fks) await c.query(`ALTER TABLE ${f.tbl} ADD CONSTRAINT ${q(f.conname)} ${f.def}`);
    // bigserial columns continue after the highest restored id.
    const seqs = (await c.query(`SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col FROM pg_class s
      JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'a' JOIN pg_class t ON t.oid = d.refobjid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE s.relkind = 'S' AND s.relnamespace = 'public'::regnamespace`)).rows;
    for (const s of seqs) await c.query(`SELECT setval('public.${q(s.seq)}', COALESCE((SELECT max(${q(s.col)}) FROM public.${q(s.tbl)}), 0) + 1, false)`);
    if (!opts.exact) await applyMigrations(c, known); // anything newer than the copy (not when going back to an older version)
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
  return checked;
}

/** Size of the database and its largest tables. */
export async function databaseSize() {
  const total = await one(pool, `SELECT pg_database_size(current_database())::bigint AS bytes, current_database() AS name`);
  const tables = await many(pool, `SELECT c.relname AS table, pg_total_relation_size(c.oid)::bigint AS bytes, GREATEST(c.reltuples, 0)::bigint AS rows
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY 2 DESC LIMIT 12`);
  return { name: total!.name as string, bytes: Number(total!.bytes), tables };
}

/** VACUUM ANALYZE every table (safe while the platform runs). */
export async function optimizeDatabase(progress?: (t: string) => void) {
  for (const t of await publicTables(pool)) { progress?.(t); await pool.query(`VACUUM (ANALYZE) public.${q(t)}`); }
  await pool.query('VACUUM (ANALYZE) public.schema_migrations');
}

// ---- Copies kept on the server -----------------------------------------------------------------------------

export const backupDir = () => process.env.SMK_BACKUP_DIR?.trim() || null;
const NAME = /^smk-(\d{8}-\d{4,6})(-[a-z0-9-]+)?\.smkbak$/;

export function listBackups(dir = backupDir()) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => NAME.test(f)).map((f) => {
    const st = statSync(join(dir, f));
    return { name: f, bytes: st.size, madeAt: st.mtime.toISOString(), fingerprint: existsSync(join(dir, `${f}.sha256`)) };
  }).sort((a, b) => b.madeAt.localeCompare(a.madeAt));
}

export function backupLog(line: string) {
  const f = process.env.SMK_BACKUP_LOG;
  if (!f) return;
  try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `${new Date().toISOString()} ${line}\n`, { flag: 'a' }); } catch { /* the log is a convenience */ }
}

let running: Promise<unknown> | null = null;
/** A copy into the server's backup folder; keeps the newest `keep` daily copies. One at a time. */
export async function backupNow(reason: 'daily' | 'manual' | 'pre-upgrade' = 'manual', keep = Number(process.env.SMK_BACKUP_KEEP ?? 14)) {
  const dir = backupDir();
  if (!dir) throw new Error('No backup folder is configured on this server (SMK_BACKUP_DIR).');
  if (running) throw new Error('A copy is already being made. Try again in a minute.');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = join(dir, `smk-${stamp}${reason === 'daily' ? '' : `-${reason}`}.smkbak`);
  const p = (async () => {
    try {
      const r = await writeBackup(file);
      backupLog(`OK ${file} ${r.bytes} bytes`);
      // Keep the newest daily copies; manual and pre-upgrade copies are kept until removed by hand.
      const daily = listBackups(dir).filter((b) => !NAME.exec(b.name)![2]);
      for (const old of daily.slice(Math.max(keep, 1))) { rmSync(join(dir, old.name), { force: true }); rmSync(join(dir, `${old.name}.sha256`), { force: true }); }
      return r;
    } catch (e) { backupLog(`FAILED ${(e as Error).message}`); throw e; }
  })();
  running = p;
  try { return await p; } finally { running = null; }
}

/** Daily copy at SMK_BACKUP_AT (server time, default 02:30), once per day, also after a restart. */
export async function maybeDailyBackup(now = new Date()) {
  const dir = backupDir();
  if (!dir || running) return null;
  const [hh, mm] = (process.env.SMK_BACKUP_AT ?? '02:30').split(':').map(Number);
  if (now.getHours() * 60 + now.getMinutes() < (hh ?? 2) * 60 + (mm ?? 30)) return null;
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  // Names use UTC; compare by the file's local modification day instead.
  const madeToday = listBackups(dir).some((b) => !NAME.exec(b.name)![2] && localDay(new Date(b.madeAt)) === day);
  if (madeToday) return null;
  return backupNow('daily');
}
const localDay = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
