/**
 * On-premises administration CLI, used by the installer and the PowerShell tools (bundled as app\admin.mjs).
 * Secrets travel on standard input or standard output only — never on the command line or in a file.
 *
 *   node admin.mjs db-init                 stdin: {"superUrl","appPassword"}  creates the role and database "smk" (bundled PostgreSQL)
 *   node admin.mjs migrate                 applies migrations (and creates the hotel from the installer's answers, if given)
 *   node admin.mjs create-admin            stdin: {"email","password","name"?}   creates a platform administrator
 *   node admin.mjs register-connector NAME stdout: {"token": "..."}               a new connector token (shown once)
 *   node admin.mjs operators               lists operators (no secrets)
 *   node admin.mjs backup FILE|--dir DIR [--reason pre-upgrade]   a consistent copy of the database (stdout: JSON summary)
 *   node admin.mjs verify FILE             checks a copy (readable, complete, unchanged)
 *   node admin.mjs restore FILE [--exact]  puts a copy back (platform stopped); --exact: as it was, without newer migrations (rollback)
 *   node admin.mjs size                    database size and largest tables
 *   node admin.mjs optimize                VACUUM ANALYZE
 *   node admin.mjs status                  stdout: {"setupNeeded", "hotel", "operators"}
 * Messages go to standard error; standard output carries only the result that the scripts parse.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { pool, one, many } from '../db.ts';
import { hashPassword } from '../auth.ts';
import { audit } from '../audit.ts';
import { provision } from '../provision-lib.ts';
import { hashToken } from '../routes/connector.ts';
import { backupNow, databaseSize, optimizeDatabase, restoreBackup, verifyBackup, writeBackup } from '../backup.ts';
import { setupNeeded } from '../routes/setup.ts';

const readStdin = () => new Promise<string>((res) => { let b = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { b += d; }); process.stdin.on('end', () => res(b)); });
const readJson = async () => JSON.parse((await readStdin()).replace(/^﻿/, ''));
const [cmd, ...rest] = process.argv.slice(2);
console.log = (...a: unknown[]) => console.error(...a);
const out = (v: unknown) => process.stdout.write(JSON.stringify(v));
const mb = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} kB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const arg = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
let lastShown = 0;
const progress = (p: { table: string; tableNo: number; tables: number; rows: number }) => {
  if (Date.now() - lastShown < 700 && p.rows % 2000 !== 0) return;
  lastShown = Date.now();
  console.error(`PROGRESS ${Math.round((100 * (p.tableNo - 1)) / Math.max(1, p.tables))} ${p.tableNo}/${p.tables} ${p.table} (${p.rows} rows)`);
};

async function hotelOrNull() {
  const p = await provision(() => {});
  return p ? await one(pool, `SELECT id FROM hotels WHERE slug=$1`, [p.slug]) : null;
}

let code = 0;
try {
  if (cmd === 'db-init') {
    // Bundled PostgreSQL: the installer gives the superuser address (127.0.0.1 only) and a new password for "smk".
    const p = z.object({ superUrl: z.string().startsWith('postgres://'), appPassword: z.string().min(16) }).parse(await readJson());
    const c = new pg.Client({ connectionString: p.superUrl });
    await c.connect();
    try {
      const pw = p.appPassword.replace(/'/g, "''");
      if ((await c.query(`SELECT 1 FROM pg_roles WHERE rolname='smk'`)).rowCount) await c.query(`ALTER ROLE smk WITH LOGIN PASSWORD '${pw}'`);
      else await c.query(`CREATE ROLE smk WITH LOGIN PASSWORD '${pw}'`);
      if (!(await c.query(`SELECT 1 FROM pg_database WHERE datname='smk'`)).rowCount) await c.query(`CREATE DATABASE smk OWNER smk ENCODING 'UTF8' TEMPLATE template0`);
      await c.query('REVOKE ALL ON DATABASE smk FROM PUBLIC');
    } finally { await c.end(); }
    console.error('Database "smk" and role "smk" ready.');
  } else if (cmd === 'migrate') {
    await provision((m) => console.error(m));
  } else if (cmd === 'status') {
    await provision(() => {});
    const h = await one(pool, 'SELECT name, slug FROM hotels ORDER BY created_at LIMIT 1');
    const o = await one(pool, 'SELECT count(*)::int AS n FROM operators');
    out({ setupNeeded: await setupNeeded(), hotel: h ?? null, operators: o!.n });
  } else if (cmd === 'create-admin') {
    const hotel = await hotelOrNull();
    const p = z.object({ email: z.string().email(), password: z.string().min(12, 'Use at least 12 characters'), name: z.string().min(2).max(80).optional() }).parse(await readJson());
    if (await one(pool, 'SELECT 1 FROM operators WHERE lower(email)=lower($1)', [p.email])) throw new Error(`An operator ${p.email} already exists.`);
    const op = await one(pool, `INSERT INTO operators (email, display_name, password_hash, is_platform_admin) VALUES ($1,$2,$3,true) RETURNING id`, [p.email, p.name ?? 'Platform Administrator', hashPassword(p.password)]);
    if (hotel) await pool.query('INSERT INTO memberships VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [op!.id, hotel.id, 'HOTEL_ADMIN']);
    await audit(null, { hotelId: null, actorType: 'system', action: 'operator.bootstrapped', targetType: 'operator', targetId: op!.id, details: { email: p.email, via: 'on-premises installer' } });
    console.error(`Administrator ${p.email} created.`);
  } else if (cmd === 'register-connector') {
    const hotel = await hotelOrNull();
    if (!hotel) throw new Error('The hotel is not set up yet (first-run setup in the portal).');
    const name = (rest.join(' ') || 'Visionline server').slice(0, 60);
    const token = `smkc_${randomBytes(32).toString('base64url')}`;
    const c = await one(pool, `INSERT INTO connectors (hotel_id, name, token_hash) VALUES ($1,$2,$3) RETURNING id`, [hotel.id, name, hashToken(token)]);
    await audit(null, { hotelId: hotel.id, actorType: 'system', action: 'connector.registered', targetType: 'connector', targetId: c!.id, details: { name, via: 'on-premises installer' } });
    out({ token });
  } else if (cmd === 'operators') {
    for (const o of await many(pool, `SELECT email, display_name, is_platform_admin, mfa_enabled, status FROM operators ORDER BY email`))
      console.error(`${o.email}\t${o.display_name}\t${o.is_platform_admin ? 'platform admin' : ''}\t${o.mfa_enabled ? 'two-step on' : 'two-step OFF'}\t${o.status}`);
  } else if (cmd === 'backup') {
    const dir = arg('dir');
    const reason = (arg('reason') ?? 'manual') as 'manual' | 'pre-upgrade' | 'daily';
    let r;
    if (dir) {
      process.env.SMK_BACKUP_DIR = dir;
      r = await backupNow(reason);
    } else {
      const file = rest.find((x) => !x.startsWith('--') && x !== reason);
      if (!file) throw new Error('Give the file to write, or --dir FOLDER.');
      r = await writeBackup(file.endsWith('.smkbak') ? file : join(file, `smk-copy-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13)}.smkbak`), progress);
    }
    console.error(`Copy ready: ${r.file} (${mb(r.bytes)}, ${r.tables} tables, ${r.rows} rows)`);
    out({ file: r.file, bytes: r.bytes, sha256: r.sha256, tables: r.tables, rows: r.rows });
  } else if (cmd === 'verify') {
    if (!rest[0]) throw new Error('Give the copy to check.');
    const v = await verifyBackup(rest[0]);
    console.error(`Readable and complete: ${v.tables} tables, ${v.rows} rows; made ${v.createdAt} by version ${v.platformVersion}. Fingerprint: ${v.fingerprint === 'match' ? 'matches' : 'no .sha256 file next to it (not checked)'}.`);
    out({ ok: true, createdAt: v.createdAt, platformVersion: v.platformVersion, tables: v.tables, rows: v.rows, fingerprint: v.fingerprint });
  } else if (cmd === 'restore') {
    if (!rest[0]) throw new Error('Give the copy to put back.');
    const v = await restoreBackup(rest[0], progress, { exact: rest.includes('--exact') });
    console.error(`Restored the copy made ${v.createdAt} (${v.tables} tables, ${v.rows} rows).`);
    out({ ok: true, createdAt: v.createdAt, rows: v.rows });
  } else if (cmd === 'size') {
    const s = await databaseSize();
    console.error(`Database ${s.name}: ${mb(s.bytes)}`);
    for (const t of s.tables) console.error(`  ${String(t.table).padEnd(28)} ${mb(Number(t.bytes)).padStart(10)}  ~${t.rows} rows`);
    out({ bytes: s.bytes, tables: s.tables });
  } else if (cmd === 'optimize') {
    await optimizeDatabase((t) => console.error(`  vacuum ${t}`));
    console.error('Done.');
  } else throw new Error('Commands: db-init | migrate | status | create-admin | register-connector NAME | operators | backup FILE|--dir DIR | verify FILE | restore FILE | size | optimize');
} catch (e) { console.error((e as Error).message); code = 1; }
await pool.end().catch(() => {});
process.exit(code);
