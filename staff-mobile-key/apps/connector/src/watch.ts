import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VL } from '@smk/shared/node';
import type { VisionlineEventsBatch } from '@smk/shared';
import { seal, open, writeAtomic } from './secret-store.ts';
import { VisionlineApiError } from './visionline/client.ts';
import type { VisionlineAdapter } from './visionline/adapter.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface WatchState { callbackId?: string; lastCatchUp?: string; outbox: VisionlineEventsBatch[] }

/**
 * Watches Visionline for changes made outside the platform (spec: hotel decision 13 Oct):
 *  - cards cancelled at the Visionline desk (status 0) → the platform revokes the key in the app;
 *  - lock events where a card was refused (e.g. 320 "No access to this room") → wrong-door counting.
 *
 * Uses a Visionline callback [Web API §7.14, long poll §7.16] and, after a restart, catches up with
 * GET /cards?cancelTimeSince [§5.9.3] because callback records expire after 12 hours and are not kept while
 * nobody polls. Batches that cannot reach the platform are kept, encrypted, and re-sent.
 */
export class VisionlineWatch {
  status = 'not started';
  private stopping = false;
  private file: string;
  private st: WatchState = { outbox: [] };

  constructor(
    private adapter: () => VisionlineAdapter,
    private send: (b: VisionlineEventsBatch) => Promise<unknown>,
    dataDir: string, private key: Buffer, private ready: () => boolean,
  ) {
    this.file = join(dataDir, 'visionline-watch.enc');
    try { if (existsSync(this.file)) this.st = { outbox: [], ...JSON.parse(open(key, readFileSync(this.file, 'utf8'))) }; } catch { /* start fresh */ }
  }
  private save() { writeAtomic(this.file, seal(this.key, JSON.stringify(this.st))); }

  private async flush() {
    while (this.st.outbox.length) {
      await this.send(this.st.outbox[0]!);
      this.st.outbox.shift();
      this.save();
    }
  }
  private queue(source: VisionlineEventsBatch['source'], cards: any[], events: any[]) {
    if (!cards.length && !events.length) return;
    this.st.outbox.push({ batchId: randomUUID(), source, cards, events });
    if (this.st.outbox.length > 500) this.st.outbox.splice(0, this.st.outbox.length - 500); // bounded
    this.save();
  }

  async run() {
    let backoff = 5_000;
    while (!this.stopping) {
      if (!this.ready()) { this.status = 'waiting for platform and Visionline credentials'; await sleep(5_000); continue; }
      try {
        await this.flush().catch(() => { /* platform down: keep batches, keep watching Visionline */ });
        const a = this.adapter();
        if (!this.st.callbackId) {
          this.st.callbackId = await a.registerWatch();
          this.save();
          // Anything cancelled while nobody was watching (2 minutes overlap; the platform ignores repeats).
          const since = this.st.lastCatchUp ? new Date(Date.parse(this.st.lastCatchUp) - 120_000) : new Date(Date.now() - 24 * 3600_000);
          const startedAt = new Date().toISOString();
          this.queue('catchup', await a.cancelledSince(since), []);
          this.st.lastCatchUp = startedAt;
          this.save();
        }
        this.status = `watching since ${new Date().toISOString()} (callback ${this.st.callbackId.slice(0, 8)}…)`;
        const r = await a.pollWatch(this.st.callbackId);
        this.queue('callback', r.cards, r.events);
        this.st.lastCatchUp = new Date().toISOString();
        this.save();
        await this.flush().catch(() => {});
        backoff = 5_000;
      } catch (e) {
        const ve = e as VisionlineApiError;
        if (ve instanceof VisionlineApiError && (ve.status === 404 || ve.code === VL.errors.resourceNotFound)) {
          // The callback expired or Visionline restarted: register again and catch up.
          this.st.callbackId = undefined; this.save();
          continue;
        }
        this.status = `error: ${(e as Error).message} (retrying in ${backoff / 1000}s)`;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 120_000);
      }
    }
  }

  async stop(deleteCallback: (id: string) => Promise<void>) {
    this.stopping = true;
    // Keep the callback registered across restarts? No: records would pile up for 12 h. Remove it [§7.15].
    if (this.st.callbackId) { try { await deleteCallback(this.st.callbackId); } catch { /* ignore */ } this.st.callbackId = undefined; this.save(); }
  }
}
