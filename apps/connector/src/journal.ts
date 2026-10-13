import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandEnvelope, CommandResult } from '@smk/shared';
import { open, seal, writeAtomic } from './secret-store.ts';

/**
 * Encrypted local command journal (spec §12.1.1: "encrypt queued commands at rest ... preserve idempotency
 * across service or computer restarts").
 *
 *   RECEIVED  -> leased from the cloud, not yet started
 *   IN_FLIGHT -> a non-idempotent Visionline call may have been sent
 *   DONE      -> result known, waiting to be reported to the cloud (outbox)
 *   REPORTED  -> cloud acknowledged; kept briefly for duplicate-delivery protection
 *
 * After a restart, IN_FLIGHT entries become UNCERTAIN_OUTCOME failures and are NEVER retried automatically,
 * so a crash can never silently issue a second key.
 */
export type JournalState = 'RECEIVED' | 'IN_FLIGHT' | 'DONE' | 'REPORTED';
export interface JournalEntry { cmd: CommandEnvelope; state: JournalState; result?: CommandResult; updatedAt: string; pid?: number }

export class Journal {
  private file: string;
  private entries = new Map<string, JournalEntry>();
  constructor(dataDir: string, private key: Buffer) {
    this.file = join(dataDir, 'journal.enc');
    if (existsSync(this.file)) {
      const arr = JSON.parse(open(key, readFileSync(this.file, 'utf8'))) as JournalEntry[];
      for (const e of arr) this.entries.set(e.cmd.id, e);
    }
  }
  private flush() {
    const cutoff = Date.now() - 7 * 86_400_000;
    for (const [id, e] of this.entries) if (e.state === 'REPORTED' && Date.parse(e.updatedAt) < cutoff) this.entries.delete(id);
    writeAtomic(this.file, seal(this.key, JSON.stringify([...this.entries.values()])));
  }
  get(id: string) { return this.entries.get(id); }
  put(cmd: CommandEnvelope, state: JournalState, result?: CommandResult) {
    this.entries.set(cmd.id, { cmd, state, result, updatedAt: new Date().toISOString(), pid: process.pid });
    this.flush();
  }
  /** Called once at start-up. */
  recover(): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.state === 'IN_FLIGHT' && e.pid !== process.pid) {
        e.state = 'DONE';
        e.result = { status: 'FAILED', error: { code: 'UNCERTAIN_OUTCOME', message: 'The connector stopped while Visionline was processing this request. It was not retried automatically.', retryable: false } };
        e.updatedAt = new Date().toISOString();
        n++;
      } else if (e.state === 'RECEIVED' && e.pid !== process.pid) {
        // Never started: safe to forget; the cloud lease will expire and the command will be re-delivered.
        this.entries.delete(e.cmd.id);
      }
    }
    this.flush();
    return n;
  }
  outbox() { return [...this.entries.values()].filter((e) => e.state === 'DONE'); }
  depth() { return [...this.entries.values()].filter((e) => e.state !== 'REPORTED').length; }
  inFlight() { return [...this.entries.values()].filter((e) => e.state === 'IN_FLIGHT').length; }
}
