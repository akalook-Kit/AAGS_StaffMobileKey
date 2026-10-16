import { pool, tx, many, one, lockHotel } from './db.ts';
import { audit } from './audit.ts';
import { enqueueIssue, notify, applyCredentialEvent, processPendingEvents, handleCsCallback } from './keys.ts';
import { csForHotel, ensureCallbacks } from './credential-services.ts';
import { scheduleDirectorySyncs } from './directory.ts';
import { config } from './config.ts';

/**
 * Housekeeping loop: command expiry, scheduled issuance, key expiry, invitation expiry, and
 * reconciliation with Credential Services when a callback is late or lost (spec §2 operational resilience).
 */
export async function sweep() {
  // 1. Commands nobody completed in time. A LEASED command may have reached Visionline: outcome uncertain.
  const expired = await many(pool, `UPDATE commands SET status='EXPIRED', completed_at=now(),
      error = jsonb_build_object('code', CASE WHEN status='LEASED' THEN 'UNCERTAIN_OUTCOME' ELSE 'COMMAND_EXPIRED' END,
        'message', CASE WHEN status='LEASED' THEN 'Connector took the command but did not report a result in time' ELSE 'No connector picked up the command before it expired' END,
        'retryable', false)
     WHERE status IN ('PENDING','LEASED') AND expires_at < now() RETURNING *`);
  for (const cmd of expired) await tx(async (c) => {
    await lockHotel(c, cmd.hotel_id);
    await audit(c, { hotelId: cmd.hotel_id, actorType: 'system', action: 'command.expired', targetType: 'command', targetId: cmd.id, correlationId: cmd.correlation_id, details: { type: cmd.type, error: cmd.error } });
    if (cmd.type === 'ISSUE_STAFF_KEY') {
      await c.query(`UPDATE key_requests SET status='FAILED', failure_code=$2, failure_message=$3, updated_at=now() WHERE id=$1 AND status='QUEUED'`,
        [cmd.payload.keyRequestId, cmd.error.code, cmd.error.message]);
    } else if (cmd.type === 'REVOKE_STAFF_KEY') {
      await c.query(`UPDATE key_requests SET status='ISSUED', failure_code=$2, failure_message='Revoke did not reach the hotel connector. The key may still work. Check connector health and revoke again.', updated_at=now() WHERE id=$1 AND status='REVOKING'`,
        [cmd.payload.keyRequestId, cmd.error.code]);
    }
  });

  // 2. Scheduled keys whose start time has come.
  for (const key of await many(pool, `SELECT * FROM key_requests WHERE status='SCHEDULED' AND starts_at <= now() + interval '30 seconds'`)) {
    await tx(async (c) => {
      await lockHotel(c, key.hotel_id);
      const k = await one(c, `SELECT * FROM key_requests WHERE id=$1 AND status='SCHEDULED' FOR UPDATE`, [key.id]);
      if (!k) return;
      if (new Date(k.expires_at) <= new Date()) {
        await c.query(`UPDATE key_requests SET status='EXPIRED', updated_at=now() WHERE id=$1`, [k.id]);
        return;
      }
      await enqueueIssue(c, k);
      await audit(c, { hotelId: k.hotel_id, actorType: 'system', action: 'key.schedule_released', targetType: 'key_request', targetId: k.id, correlationId: k.correlation_id });
    });
  }

  // 3. Keys past their expiry. Locks enforce expiry themselves; this keeps the portal truthful.
  for (const k of await many(pool, `UPDATE key_requests SET status='EXPIRED', updated_at=now()
      WHERE status IN ('ISSUED','ISSUING','PENDING_APPROVAL') AND expires_at < now() RETURNING id, hotel_id, staff_id, correlation_id, status`)) {
    await audit(null, { hotelId: k.hotel_id, actorType: 'system', action: 'key.expired', targetType: 'key_request', targetId: k.id, correlationId: k.correlation_id });
    await notify(pool, k.hotel_id, k.staff_id, 'Key expired', 'Your mobile key has expired.');
  }

  // 4. Invitations past their 10-hour validity [CS §6.1].
  await pool.query(`UPDATE endpoints SET status='FAILED', vendor_status='INVITATION_INVALID', updated_at=now()
    WHERE status='INVITED' AND invitation_expires_at < now()`);
}

/** Look up credentials whose callback is overdue [CS §7.2] and apply the vendor's current status. */
export async function reconcile(minAgeSec = 120) {
  const stale = await many(pool, `SELECT id, hotel_id, credential_id, status FROM key_requests
    WHERE credential_id IS NOT NULL AND status IN ('ISSUING','REVOKING') AND updated_at < now() - make_interval(secs => $1) LIMIT 50`, [minAgeSec]);
  await checkCredentials(stale, true);
}

/**
 * Polling mode only: issued keys can be removed on the vendor side (phone deleted, Visionline override) and,
 * without callbacks, nobody tells the platform. Ask about the least recently checked issued keys, a small batch
 * per round: keys on a deleted phone first, then each issued key about every few minutes.
 */
export async function pollIssuedKeys(batch = 20, everySec = 120) {
  const due = await many(pool, `SELECT k.id, k.hotel_id, k.credential_id, k.status FROM key_requests k
      LEFT JOIN endpoints e ON e.hotel_id=k.hotel_id AND e.endpoint_id=k.endpoint_id
    WHERE k.status='ISSUED' AND k.credential_id IS NOT NULL
      AND (k.vendor_checked_at IS NULL OR k.vendor_checked_at < now() - make_interval(secs => CASE WHEN e.status='DELETED' THEN 15 ELSE $1 END))
    ORDER BY (e.status='DELETED') DESC, k.vendor_checked_at NULLS FIRST LIMIT $2`, [everySec, batch]);
  await checkCredentials(due, false);
}

async function checkCredentials(list: any[], logReconciled: boolean) {
  for (const k of list) {
    try {
      const { client, systemId } = await csForHotel(k.hotel_id);
      const cred = await client.getCredential(systemId, k.credential_id);
      await tx(async (c) => {
        await lockHotel(c, k.hotel_id);
        await c.query('UPDATE key_requests SET vendor_checked_at=now() WHERE id=$1', [k.id]);
        if (!logReconciled && cred.status === 'ISSUED') return; // unchanged: nothing to record
        await applyCredentialEvent(c, k.hotel_id, { callbackType: 'credentialStatusChanged', systemId, credentialId: k.credential_id, endpointId: cred.endpointId, credentialStatus: cred.status });
        await c.query('UPDATE key_requests SET updated_at=now() WHERE id=$1', [k.id]);
        await audit(c, { hotelId: k.hotel_id, actorType: 'system', action: 'key.reconciled', targetType: 'key_request', targetId: k.id, details: { vendorStatus: cred.status, previous: k.status } });
      });
    } catch (e) {
      console.warn(`[reconcile] ${k.id}: ${(e as Error).message}`);
    }
  }
}

const callbackState = new Map<string, { ok: boolean; at: number; error?: string; url?: string }>();
export const getCallbackState = (hotelId: string) => callbackState.get(hotelId) ?? null;

export async function ensureAllCallbacks() {
  for (const h of await many(pool, `SELECT id FROM hotels WHERE status='ACTIVE'`)) {
    const s = callbackState.get(h.id);
    if (s?.ok && Date.now() - s.at < 30 * 60_000) continue;
    if (config.csCallbacks === 'off') {
      // On-premises: no callbacks registered; just confirm the account answers (GET only).
      try {
        const { client } = await csForHotel(h.id);
        await client.listCallbacks();
        callbackState.set(h.id, { ok: true, at: Date.now(), url: 'Polling mode: no inbound callbacks (the platform asks Credential Services)' });
      } catch (e) { callbackState.set(h.id, { ok: false, at: Date.now(), error: (e as Error).message }); }
      continue;
    }
    try {
      const r = await ensureCallbacks(h.id);
      callbackState.set(h.id, { ok: true, at: Date.now(), url: r.url });
    } catch (e) {
      callbackState.set(h.id, { ok: false, at: Date.now(), error: (e as Error).message });
    }
  }
}

/**
 * Polling mode (CS_CALLBACKS=off): ask Credential Services about phones waiting to be set up, the way an
 * endpoint callback would have told us [CS §5.3, §8.5.1]. Credential status is covered by reconcile().
 */
export async function pollEndpoints() {
  const waiting = await many(pool, `SELECT hotel_id, endpoint_id FROM endpoints WHERE status='INVITED' AND invitation_expires_at > now() ORDER BY updated_at LIMIT 50`);
  for (const e of waiting) {
    try {
      const { client } = await csForHotel(e.hotel_id);
      const ep = await client.getEndpoint(e.endpoint_id);
      if (ep.endpointStatus === 'ACTIVE') await handleCsCallback(e.hotel_id, null, { callbackType: 'endpointStatusChanged', endpointId: e.endpoint_id, endpointStatus: 'ACTIVE' });
    } catch { /* not created yet, or Credential Services unreachable: next round */ }
  }
}

export function startJobs() {
  let n = 0;
  const tick = async () => {
    try {
      await sweep();
      await processPendingEvents();
      if (config.csCallbacks === 'off') { await pollEndpoints(); if (n % 2 === 0) { await reconcile(5); await pollIssuedKeys(); } }
      else if (n % 12 === 0) await reconcile();
      if (n % 12 === 0) await ensureAllCallbacks();
      if (n % 12 === 6) await scheduleDirectorySyncs();
    } catch (e) {
      console.error('[jobs]', e);
    }
    n++;
  };
  void tick();
  return setInterval(tick, 5_000);
}
