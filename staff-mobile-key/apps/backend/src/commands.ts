import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { PAYLOAD_SCHEMAS, type CommandType, type CommandResult } from '@smk/shared';
import { config } from './config.ts';
import { pool, tx, one, many, lockHotel, type Db } from './db.ts';
import { audit } from './audit.ts';
import { onIssueResult, onRevokeResult } from './keys.ts';
import { onDirectorySyncResult } from './directory.ts';

/**
 * Cloud → connector command queue (spec §4.3). Every command has: a unique id, a per-hotel idempotency
 * key (UNIQUE in the database, so a retry can never create a second command), an expiry, a correlation id,
 * a recorded result, and a lease so a crashed connector's command becomes available again.
 */
export async function enqueue(c: Db, o: { hotelId: string; type: CommandType; payload: unknown; idempotencyKey: string; correlationId: string; ttlSec?: number }) {
  PAYLOAD_SCHEMAS[o.type].parse(o.payload);
  const inserted = await one(c, `INSERT INTO commands (hotel_id, type, payload, idempotency_key, correlation_id, expires_at)
      VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6))
      ON CONFLICT (hotel_id, idempotency_key) DO NOTHING RETURNING *`,
    [o.hotelId, o.type, o.payload, o.idempotencyKey, o.correlationId, o.ttlSec ?? config.commandTtlSec]);
  return inserted ?? (await one(c, 'SELECT * FROM commands WHERE hotel_id=$1 AND idempotency_key=$2', [o.hotelId, o.idempotencyKey]));
}

export async function lease(connector: { id: string; hotel_id: string }, max: number) {
  const rows = await many(
    pool,
    `UPDATE commands SET status='LEASED', leased_by=$2, attempts=attempts+1,
        -- A directory sync runs for minutes in the background on the connector: keep it leased meanwhile.
        lease_until=now() + CASE WHEN type='SYNC_DIRECTORY' THEN interval '35 minutes' ELSE interval '90 seconds' END
      WHERE id IN (
        SELECT id FROM commands
         WHERE hotel_id=$1 AND expires_at > now()
           AND (status='PENDING' OR (status='LEASED' AND lease_until < now()))
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $3)
      RETURNING id, hotel_id, type, payload, idempotency_key, correlation_id, expires_at, attempts`,
    [connector.hotel_id, connector.id, max]);
  return rows.map((r) => ({
    id: r.id, hotelId: r.hotel_id, type: r.type, payload: r.payload, idempotencyKey: r.idempotency_key,
    correlationId: r.correlation_id, expiresAt: new Date(r.expires_at).toISOString(), attempt: r.attempts,
  }));
}

export async function complete(connector: { id: string; hotel_id: string }, commandId: string, result: CommandResult) {
  return tx(async (c) => {
    await lockHotel(c, connector.hotel_id);
    const cmd = await one(c, 'SELECT * FROM commands WHERE id=$1 AND hotel_id=$2 FOR UPDATE', [commandId, connector.hotel_id]);
    if (!cmd) return { status: 404 as const };
    if (cmd.status === 'SUCCEEDED' || cmd.status === 'FAILED') return { status: 200 as const, duplicate: true }; // idempotent report
    if (cmd.status === 'EXPIRED') {
      // The connector finished after the cloud gave up. Record it so the outcome is not lost.
      await audit(c, { hotelId: cmd.hotel_id, actorType: 'connector', actorId: connector.id, action: 'command.late_result', targetType: 'command', targetId: cmd.id, correlationId: cmd.correlation_id, details: { type: cmd.type, status: result.status, result: result.result, error: result.error } });
    }
    await c.query(`UPDATE commands SET status=$2, result=$3, error=$4, completed_at=now(), lease_until=NULL WHERE id=$1`,
      [cmd.id, result.status, result.result ?? null, result.error ?? null]);
    await audit(c, { hotelId: cmd.hotel_id, actorType: 'connector', actorId: connector.id, action: `command.${result.status.toLowerCase()}`, targetType: 'command', targetId: cmd.id, correlationId: cmd.correlation_id, details: { type: cmd.type, attempt: cmd.attempts, result: result.result, error: result.error } });
    await applyResult(c, cmd, result);
    return { status: 200 as const };
  });
}

async function applyResult(c: pg.PoolClient, cmd: any, result: CommandResult) {
  switch (cmd.type as CommandType) {
    case 'ISSUE_STAFF_KEY': return onIssueResult(c, cmd, result);
    case 'REVOKE_STAFF_KEY': return onRevokeResult(c, cmd, result);
    case 'DISCOVER_RESOURCES': {
      if (result.status !== 'SUCCEEDED') return;
      const items = (result.result?.resources ?? []) as { kind: string; externalId: string; name: string; data: unknown }[];
      const kinds = [...new Set(items.map((i) => i.kind))];
      for (const k of kinds) await c.query('UPDATE resources SET active=false WHERE hotel_id=$1 AND kind=$2', [cmd.hotel_id, k]);
      for (const i of items) await c.query(`INSERT INTO resources (hotel_id, kind, external_id, name, data, active, discovered_at)
          VALUES ($1,$2,$3,$4,$5,true,now())
          ON CONFLICT (hotel_id, kind, external_id) DO UPDATE SET name=EXCLUDED.name, data=EXCLUDED.data, active=true, discovered_at=now()`,
        [cmd.hotel_id, i.kind, i.externalId, i.name, i.data ?? {}]);
      return;
    }
    case 'VALIDATE_SETUP': return;
    case 'SYNC_DIRECTORY': return onDirectorySyncResult(c, cmd, result);
    case 'SET_PROPERTY_CREDENTIALS': return; // outcome visible in command result and connector health
    case 'VERIFY_OPERATOR_CREDENTIALS': {
      const ok = result.status === 'SUCCEEDED';
      await c.query(`UPDATE operator_vl_credentials SET status=$3, status_detail=$4, verified_at=CASE WHEN $3='VERIFIED' THEN now() ELSE verified_at END, updated_at=now()
        WHERE hotel_id=$1 AND operator_id=$2 AND sealed->>'ct' = $5`,
        [cmd.hotel_id, cmd.payload.operatorId, ok ? 'VERIFIED' : 'FAILED', ok ? null : result.error?.message ?? 'Visionline refused these credentials', cmd.payload.sealed.ct]);
      return;
    }
    case 'CREATE_USER_GROUP': {
      if (result.status !== 'SUCCEEDED') return;
      const g = result.result as { id: string; uniformAccess?: boolean; doorOperations?: unknown[] };
      await c.query(`INSERT INTO resources (hotel_id, kind, external_id, name, data, active, discovered_at) VALUES ($1,'usergroup',$2,$2,$3,true,now())
        ON CONFLICT (hotel_id, kind, external_id) DO UPDATE SET data=EXCLUDED.data, active=true, discovered_at=now()`,
        [cmd.hotel_id, g.id, { uniformAccess: g.uniformAccess ?? false, doorOperations: g.doorOperations ?? [] }]);
      return;
    }
  }
}

export const newCorrelationId = () => `smk-${randomUUID()}`;
