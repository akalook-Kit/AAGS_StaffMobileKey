/**
 * On-premises administration CLI, used by install-onprem.ps1 (bundled as app\admin.mjs).
 * Secrets travel on standard input or standard output only — never on the command line or in a file.
 *
 *   node admin.mjs create-admin            stdin: {"email","password","name"?}   → creates a platform administrator
 *   node admin.mjs register-connector NAME stdout: {"token": "..."}                → a new connector token (shown once)
 *   node admin.mjs operators               lists operators (no secrets)
 * Every command first applies migrations and K Hotel Bana's settings (idempotent).
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pool, one, many } from '../db.ts';
import { hashPassword } from '../auth.ts';
import { audit } from '../audit.ts';
import { provision } from '../provision-lib.ts';
import { hashToken } from '../routes/connector.ts';

const readStdin = () => new Promise<string>((res) => { let b = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { b += d; }); process.stdin.on('end', () => res(b)); });
const [cmd, ...rest] = process.argv.slice(2);
// Standard output carries only the command's result (the installer parses it); messages go to standard error.
console.log = (...a: unknown[]) => console.error(...a);
await provision(() => {});
const hotel = await one(pool, `SELECT id FROM hotels WHERE slug=$1`, [process.env.PROVISION_HOTEL ?? 'k-hotel-bana']);
let code = 0;
try {
  if (cmd === 'create-admin') {
    const p = z.object({ email: z.string().email(), password: z.string().min(12, 'Use at least 12 characters'), name: z.string().min(2).max(80).optional() })
      .parse(JSON.parse((await readStdin()).replace(/^﻿/, '')));
    if (await one(pool, 'SELECT 1 FROM operators WHERE lower(email)=lower($1)', [p.email])) throw new Error(`An operator ${p.email} already exists.`);
    const op = await one(pool, `INSERT INTO operators (email, display_name, password_hash, is_platform_admin) VALUES ($1,$2,$3,true) RETURNING id`, [p.email, p.name ?? 'Platform Administrator', hashPassword(p.password)]);
    if (hotel) await pool.query('INSERT INTO memberships VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [op!.id, hotel.id, 'HOTEL_ADMIN']);
    await audit(null, { hotelId: null, actorType: 'system', action: 'operator.bootstrapped', targetType: 'operator', targetId: op!.id, details: { email: p.email, via: 'on-premises installer' } });
    console.error(`Administrator ${p.email} created.`);
  } else if (cmd === 'register-connector') {
    if (!hotel) throw new Error('Hotel not provisioned');
    const name = (rest.join(' ') || 'Visionline server').slice(0, 60);
    const token = `smkc_${randomBytes(32).toString('base64url')}`;
    const c = await one(pool, `INSERT INTO connectors (hotel_id, name, token_hash) VALUES ($1,$2,$3) RETURNING id`, [hotel.id, name, hashToken(token)]);
    await audit(null, { hotelId: hotel.id, actorType: 'system', action: 'connector.registered', targetType: 'connector', targetId: c!.id, details: { name, via: 'on-premises installer' } });
    process.stdout.write(JSON.stringify({ token }));
  } else if (cmd === 'operators') {
    for (const o of await many(pool, `SELECT email, display_name, is_platform_admin, mfa_enabled, status FROM operators ORDER BY email`))
      console.log(`${o.email}\t${o.display_name}\t${o.is_platform_admin ? 'platform admin' : ''}\t${o.mfa_enabled ? 'two-step on' : 'two-step OFF'}\t${o.status}`);
  } else throw new Error('Commands: create-admin | register-connector NAME | operators');
} catch (e) { console.error((e as Error).message); code = 1; }
await pool.end();
process.exit(code);
