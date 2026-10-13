import { createHash } from 'node:crypto';
import type pg from 'pg';
import { pool, tx, type Db } from './db.ts';
import { redact, stableStringify } from './lib/redact.ts';

/**
 * Append-only, hash-chained audit trail (spec §3, §6). Each hotel has its own chain; every record's hash
 * covers the previous hash, so any edit or deletion is detectable by verifyAuditChain(). The table also
 * rejects UPDATE/DELETE/TRUNCATE with a trigger. Production should additionally ship records to WORM storage.
 */
export interface AuditEntry {
  hotelId: string | null;
  actorType: 'operator' | 'staff' | 'connector' | 'system' | 'vendor';
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  correlationId?: string | null;
  details?: Record<string, unknown>;
}

const GENESIS = '0'.repeat(64);
const digest = (prev: string, at: string, e: AuditEntry, details: unknown) =>
  createHash('sha256').update(stableStringify([prev, at, e.hotelId ?? null, e.actorType, e.actorId ?? null, e.action,
    e.targetType ?? null, e.targetId ?? null, e.correlationId ?? null, details])).digest('hex');

async function append(c: pg.PoolClient, e: AuditEntry) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${e.hotelId ?? 'platform'}`]);
  const last = await c.query('SELECT hash FROM audit_log WHERE hotel_id IS NOT DISTINCT FROM $1 ORDER BY seq DESC LIMIT 1', [e.hotelId]);
  const prev = last.rows[0]?.hash ?? GENESIS;
  const at = new Date().toISOString();
  const details = JSON.parse(JSON.stringify(redact(e.details ?? {})));
  const hash = digest(prev, at, e, details);
  await c.query(
    `INSERT INTO audit_log (hotel_id, at, actor_type, actor_id, action, target_type, target_id, correlation_id, details, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [e.hotelId, at, e.actorType, e.actorId ?? null, e.action, e.targetType ?? null, e.targetId ?? null, e.correlationId ?? null, details, prev, hash],
  );
}

/** Pass the transaction client when the audited change is part of a transaction. */
export async function audit(db: Db | null, e: AuditEntry) {
  if (db && 'release' in db) return append(db as pg.PoolClient, e);
  return tx((c) => append(c, e));
}

export async function verifyAuditChain(hotelId: string | null) {
  const { rows } = await pool.query(
    `SELECT seq, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at_iso, hotel_id, actor_type, actor_id, action, target_type, target_id, correlation_id, details, prev_hash, hash
       FROM audit_log WHERE hotel_id IS NOT DISTINCT FROM $1 ORDER BY seq`, [hotelId]);
  let prev = GENESIS;
  for (const r of rows) {
    const e: AuditEntry = { hotelId: r.hotel_id, actorType: r.actor_type, actorId: r.actor_id, action: r.action, targetType: r.target_type, targetId: r.target_id, correlationId: r.correlation_id };
    const expected = digest(prev, r.at_iso, e, r.details);
    if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, records: rows.length, brokenAt: r.seq };
    prev = r.hash;
  }
  return { ok: true, records: rows.length, head: prev };
}
