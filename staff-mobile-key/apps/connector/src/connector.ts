import { createHash } from 'node:crypto';
import { CONTRACT_VERSION, PAYLOAD_SCHEMAS, type CommandEnvelope, type CommandResult, type ConnectorHealth, type SealedCredentialPlain, type SealedSecret } from '@smk/shared';
import { generateSealingKey, openSealed } from '@smk/shared/node';
import type { ConnectorConfig } from './config.ts';
import { Journal } from './journal.ts';
import { SecretStore } from './secret-store.ts';
import { VisionlineClient, VisionlineApiError } from './visionline/client.ts';
import { WebApiAdapter, toErrorInfo, ADAPTER_VERSION, type VisionlineAdapter } from './visionline/adapter.ts';
import { VisionlineWatch } from './watch.ts';
import { readDirectory } from './visionline/directory.ts';

/** Commands that change Visionline; refused in read-only mode. */
const WRITES = new Set(['ISSUE_STAFF_KEY', 'REVOKE_STAFF_KEY', 'CREATE_USER_GROUP']);

export const CONNECTOR_VERSION = '0.6.0';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The hotel connector service (spec §4.1, §13.1). Outbound only:
 *   loop: lease commands from the platform (long poll) → run against Visionline → report result
 *   timer: heartbeat with health (no secrets)
 * Results that cannot be reported (internet down) stay in the encrypted journal outbox and are re-sent.
 */
export class Connector {
  readonly startedAt = Date.now();
  hotel: { id: string; slug: string; name: string; timezone: string } | null = null;
  vl: VisionlineClient;
  adapter: VisionlineAdapter;
  journal: Journal;
  watch: VisionlineWatch;
  lastError: string | null = null;
  platformReachable = false;
  lastPlatformContact: string | null = null;
  visionlineReachable = false;
  apiVersion: string | null = null;
  private stopping = false;
  /** Directory sync (management reports) runs beside the command loop so it never delays a key. */
  private syncRunning: string | null = null;
  directorySync = 'not run';
  /** Sessions opened under operators' personal Visionline identities, keyed by username + password hash. */
  private operatorClients = new Map<string, VisionlineClient>();

  constructor(public cfg: ConnectorConfig, public secrets: SecretStore, public installationUuid: string) {
    this.journal = new Journal(cfg.dataDir, secrets.key);
    if (!secrets.has('sealPrivateKey')) {
      // One RSA key pair per installation; the portal encrypts Visionline passwords with the public half.
      const k = generateSealingKey();
      secrets.set({ sealPrivateKey: k.privateKeyPem, sealPublicKey: k.publicKeyPem, sealKeyId: k.keyId });
    }
    this.vl = new VisionlineClient(cfg.visionline.baseUrl, cfg.visionline, () => {
      const u = secrets.get('vlUsername'); const p = secrets.get('vlPassword');
      return u && p ? { username: u, password: p, accessId: secrets.get('vlAccessId'), clientUuid: installationUuid } : null;
    });
    this.adapter = new WebApiAdapter(this.vl, () => this.hotel?.timezone ?? 'UTC', cfg.visionline.revokeStrategy);
    this.watch = new VisionlineWatch(() => this.adapter, (b) => this.platform('/connector/v1/visionline-events', b), cfg.dataDir, secrets.key,
      () => Boolean(this.hotel) && this.secrets.has('vlUsername') && this.secrets.has('vlPassword'));
    if (!cfg.visionline.watch) this.watch.status = 'switched off in the connector configuration';
  }

  // ---- platform channel ----------------------------------------------------------------------
  private async platform<T>(path: string, body: unknown, timeoutMs = 30_000): Promise<T> {
    const token = this.secrets.get('platformToken');
    if (!token) throw new Error('Platform token not configured');
    const r = await fetch(this.cfg.platformUrl.replace(/\/$/, '') + path, {
      method: 'POST', body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-installation-uuid': this.installationUuid, 'user-agent': `smk-connector/${CONNECTOR_VERSION}` },
    });
    const text = await r.text();
    const json = text ? JSON.parse(text) : {};
    if (!r.ok) throw Object.assign(new Error(json?.error?.message ?? `Platform HTTP ${r.status}`), { status: r.status });
    this.platformReachable = true;
    this.lastPlatformContact = new Date().toISOString();
    if (this.lastError?.startsWith('Platform')) this.lastError = null;
    return json as T;
  }

  health(): ConnectorHealth {
    const credentialsConfigured = this.secrets.has('vlUsername') && this.secrets.has('vlPassword');
    const status = !credentialsConfigured || !this.visionlineReachable ? (this.lastError ? 'ERROR' : 'DEGRADED') : 'OK';
    return {
      connectorVersion: CONNECTOR_VERSION, contractVersion: CONTRACT_VERSION, status, adapter: ADAPTER_VERSION,
      credentialsConfigured, visionlineReachable: this.visionlineReachable, visionlineApiVersion: this.apiVersion,
      tlsTrust: this.vl.tlsState, lastSuccessfulSessionAt: this.vl.lastSessionAt, lastError: this.lastError,
      queueDepth: this.journal.depth(), inFlight: this.journal.inFlight(), clockOffsetMs: this.vl.skewMs,
      callbackHealth: this.cfg.visionline.watch ? `Visionline watch: ${this.watch.status}` : 'Visionline watch switched off',
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      propertyUsername: this.secrets.get('vlUsername') ?? null,
      visionlineBaseUrl: this.cfg.visionline.baseUrl,
      sealKeyId: this.secrets.get('sealKeyId'),
      visionlineWatch: this.watch.status,
      readOnly: this.cfg.visionline.readOnly,
      // Battery alarms ride on the Visionline watch; without the watch there are none to report.
      capabilities: [...(this.cfg.visionline.watch ? ['battery-events'] : []), 'directory-sync'],
      directorySync: this.directorySync,
    };
  }

  // ---- sealed credentials --------------------------------------------------------------------
  /** Opens a credential sealed in the portal and checks it was sealed for this hotel, purpose and operator. */
  private openCredential(sealed: SealedSecret, purpose: SealedCredentialPlain['purpose'], operatorId?: string): SealedCredentialPlain {
    if (sealed.keyId !== this.secrets.get('sealKeyId')) throw Object.assign(new Error('Sealed for a different connector key. Enter the password again in the portal.'), { code: 'STALE_SEALING_KEY' });
    const plain = JSON.parse(openSealed(this.secrets.get('sealPrivateKey')!, sealed)) as SealedCredentialPlain;
    if (plain.purpose !== purpose || plain.hotelId !== this.hotel?.id || (operatorId && plain.operatorId !== operatorId))
      throw Object.assign(new Error('Sealed credential does not belong to this request'), { code: 'SEALED_MISMATCH' });
    return plain;
  }

  private newClient(username: string, password: string, accessId?: string) {
    return new VisionlineClient(this.cfg.visionline.baseUrl, this.cfg.visionline, () => ({ username, password, accessId: accessId ?? this.secrets.get('vlAccessId'), clientUuid: this.installationUuid }));
  }

  /** Adapter running under an operator's personal Visionline identity (or the property operator). */
  private adapterFor(cred?: { operatorId: string; username: string; sealed: SealedSecret }): VisionlineAdapter {
    if (!cred) return this.adapter;
    const plain = this.openCredential(cred.sealed, 'operator', cred.operatorId);
    const k = `${plain.username}:${createHash('sha256').update(plain.password).digest('hex')}`;
    let client = this.operatorClients.get(k);
    if (!client) { client = this.newClient(plain.username, plain.password); this.operatorClients.set(k, client); }
    return new WebApiAdapter(client, () => this.hotel?.timezone ?? 'UTC', this.cfg.visionline.revokeStrategy);
  }

  /** Opens a session with these credentials, lists resources, and closes the session. */
  private async tryCredentials(username: string, password: string, accessId?: string) {
    const c = this.newClient(username, password, accessId);
    try { return (await c.request<{ id: string }[]>('GET', '/resources')).length; } finally { await c.close(); }
  }

  /** Lightweight Visionline probe for health: create/reuse a session and list resources. */
  async probeVisionline() {
    try {
      const r = await this.vl.request<{ id: string }[]>('GET', '/resources');
      this.visionlineReachable = true;
      this.apiVersion = `v1 (${r.length} resources)`;
      if (this.lastError?.startsWith('Visionline')) this.lastError = null;
    } catch (e) {
      this.visionlineReachable = false;
      this.lastError = `Visionline: ${(e as Error).message}`;
    }
  }

  // ---- command execution ---------------------------------------------------------------------
  async execute(cmd: CommandEnvelope): Promise<CommandResult> {
    const prior = this.journal.get(cmd.id);
    if (prior?.state === 'DONE' || prior?.state === 'REPORTED') return prior.result!; // duplicate delivery
    if (prior?.state === 'IN_FLIGHT') return { status: 'FAILED', error: { code: 'UNCERTAIN_OUTCOME', message: 'Command was already in progress', retryable: false } };
    if (Date.parse(cmd.expiresAt) < Date.now()) return { status: 'FAILED', error: { code: 'COMMAND_EXPIRED', message: 'Command expired before execution', retryable: false } };
    this.journal.put(cmd, 'RECEIVED');
    let result: CommandResult;
    try {
      if (this.cfg.visionline.readOnly && WRITES.has(cmd.type))
        throw Object.assign(new Error('This connector is in read-only mode: it does not change Visionline. Switch off readOnly in connector.config.json to issue or revoke keys.'), { code: 'VISIONLINE_READ_ONLY' });
      const payload = PAYLOAD_SCHEMAS[cmd.type].parse(cmd.payload) as any; // reject anything unexpected
      switch (cmd.type) {
        case 'ISSUE_STAFF_KEY': {
          const adapter = this.adapterFor(payload.operatorCredential);
          const r = await this.withSafeRetry(() => adapter.issueStaffMobileKey(payload, () => this.journal.put(cmd, 'IN_FLIGHT')));
          result = { status: 'SUCCEEDED', result: { ...r, issuedAs: payload.operatorCredential?.username ?? this.secrets.get('vlUsername') } };
          break;
        }
        case 'REVOKE_STAFF_KEY': {
          const adapter = this.adapterFor(payload.operatorCredential);
          result = { status: 'SUCCEEDED', result: await this.withSafeRetry(() => adapter.revokeStaffMobileKey(payload)) };
          break;
        }
        case 'SET_PROPERTY_CREDENTIALS': {
          const plain = this.openCredential(payload.sealed, 'property');
          // Only replace the stored property operator once Visionline accepts the new credentials.
          const n = await this.tryCredentials(plain.username, plain.password, plain.accessId);
          this.secrets.set({ vlUsername: plain.username, vlPassword: plain.password, vlAccessId: plain.accessId });
          this.vl.reset();
          await this.probeVisionline();
          result = { status: 'SUCCEEDED', result: { username: plain.username, resources: n } };
          break;
        }
        case 'VERIFY_OPERATOR_CREDENTIALS': {
          const plain = this.openCredential(payload.sealed, 'operator', payload.operatorId);
          const n = await this.tryCredentials(plain.username, plain.password);
          result = { status: 'SUCCEEDED', result: { username: plain.username, resources: n } };
          break;
        }
        case 'CREATE_USER_GROUP':
          result = { status: 'SUCCEEDED', result: await this.adapter.createUserGroup(payload.userGroup, payload.uniformAccess) };
          break;
        case 'DISCOVER_RESOURCES':
          result = { status: 'SUCCEEDED', result: await this.withSafeRetry(() => this.adapter.discover(payload.userGroups)) };
          break;
        case 'VALIDATE_SETUP':
          result = { status: 'SUCCEEDED', result: await this.adapter.validate() };
          break;
      }
      this.visionlineReachable = true;
    } catch (e) {
      const info = ['STALE_SEALING_KEY', 'SEALED_MISMATCH', 'VISIONLINE_READ_ONLY'].includes((e as any)?.code)
        ? { code: (e as any).code, message: (e as Error).message, retryable: false }
        : toErrorInfo(e);
      if ((e as any)?.partial) (info as any).partial = (e as any).partial;
      result = { status: 'FAILED', error: info };
      if (info.code === 'VISIONLINE_UNREACHABLE') this.visionlineReachable = false;
    }
    this.journal.put(cmd, 'DONE', result!);
    return result!;
  }

  /**
   * Bounded retry ONLY for failures that cannot have changed Visionline: connection never established,
   * or 50301 "service unavailable". Ambiguous failures are reported, not retried (spec §13.3 idempotency).
   */
  private async withSafeRetry<T>(fn: () => Promise<T>): Promise<T> {
    const delays = [2_000, 5_000, 10_000];
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        const safe = e instanceof VisionlineApiError && (e.notSent || e.code === 50301);
        if (!safe || i >= delays.length) throw e;
        await sleep(delays[i]!);
      }
    }
  }

  private async report(cmdId: string, result: CommandResult) {
    await this.platform(`/connector/v1/commands/${cmdId}/result`, result);
    const e = this.journal.get(cmdId);
    if (e) this.journal.put(e.cmd, 'REPORTED', result);
  }

  private async flushOutbox() {
    for (const e of this.journal.outbox()) {
      try { await this.report(e.cmd.id, e.result!); } catch (err) {
        if ((err as any).status === 404) this.journal.put(e.cmd, 'REPORTED', e.result); // cloud no longer knows it
        else throw err;
      }
    }
  }

  // ---- main loops -------------------------------------------------------------------------------
  async run() {
    const recovered = this.journal.recover();
    if (recovered) console.warn(`[connector] ${recovered} command(s) were in flight during the last shutdown; reported as UNCERTAIN_OUTCOME`);
    void this.heartbeatLoop();
    if (this.cfg.visionline.watch) void this.watch.run();
    let backoff = 1_000;
    while (!this.stopping) {
      try {
        if (!this.hotel) {
          const hello = await this.platform<any>('/connector/v1/hello', { installationUuid: this.installationUuid, version: CONNECTOR_VERSION, contractVersion: CONTRACT_VERSION, sealPublicKey: this.secrets.get('sealPublicKey'), sealKeyId: this.secrets.get('sealKeyId') });
          this.hotel = hello.hotel;
          console.log(`[connector] connected to platform as ${this.hotel!.name} (${this.hotel!.timezone})`);
          void this.probeVisionline();
        }
        await this.flushOutbox();
        const { commands } = await this.platform<{ commands: CommandEnvelope[] }>('/connector/v1/commands/lease', { max: 5, waitSec: 20 }, 40_000);
        for (const cmd of commands) {
          console.log(`[connector] ${cmd.type} ${cmd.id} (attempt ${cmd.attempt}, ${cmd.correlationId})`);
          if (cmd.type === 'SYNC_DIRECTORY') { this.startSync(cmd); continue; }
          const result = await this.execute(cmd);
          console.log(`[connector] ${cmd.type} ${cmd.id} -> ${result.status}${result.error ? ` ${result.error.code}` : ''}`);
          try { await this.report(cmd.id, result); } catch { /* stays in outbox */ }
        }
        backoff = 1_000;
      } catch (e) {
        this.platformReachable = false;
        const msg = (e as Error).message;
        if (!this.lastError || !this.lastError.startsWith('Visionline')) this.lastError = `Platform: ${msg}`;
        if ((e as any).status === 401 || (e as any).status === 409 || (e as any).status === 426) console.error(`[connector] platform refused connector: ${msg}`);
        else console.warn(`[connector] platform unavailable (${msg}); retrying in ${backoff / 1000}s. Visionline is unaffected.`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** Reads Visionline's people, valid keycards and alarms in the background and streams them to the platform. */
  private startSync(cmd: CommandEnvelope) {
    const prior = this.journal.get(cmd.id);
    if (prior?.state === 'DONE' || prior?.state === 'REPORTED') { void this.report(cmd.id, prior.result!).catch(() => {}); return; }
    if (this.syncRunning) {
      if (this.syncRunning !== cmd.id) void this.report(cmd.id, { status: 'FAILED', error: { code: 'SYNC_BUSY', message: 'A directory sync is already running on the connector.', retryable: true } }).catch(() => {});
      return;
    }
    this.syncRunning = cmd.id;
    this.journal.put(cmd, 'RECEIVED');
    const started = Date.now();
    this.directorySync = `running since ${new Date(started).toISOString()}`;
    void (async () => {
      let result: CommandResult;
      try {
        const payload = PAYLOAD_SCHEMAS.SYNC_DIRECTORY.parse(cmd.payload);
        const r = await readDirectory(this.vl, payload, this.hotel?.timezone ?? 'UTC',
          (chunk) => this.platform('/connector/v1/directory', { ...chunk, syncId: cmd.id }, 60_000).then(() => undefined),
          { onProgress: (m) => { this.directorySync = `running: ${m}`; } });
        result = { status: 'SUCCEEDED', result: { ...r, seconds: Math.round((Date.now() - started) / 1000) } };
        this.directorySync = `last run ${new Date().toISOString()}: ${r.users} users, ${r.cards} valid cards, ${r.alarms} alarms`;
      } catch (e) {
        result = { status: 'FAILED', error: toErrorInfo(e) };
        this.directorySync = `failed ${new Date().toISOString()}: ${(e as Error).message}`;
      }
      this.journal.put(cmd, 'DONE', result);
      console.log(`[connector] SYNC_DIRECTORY ${cmd.id} -> ${result.status}${result.error ? ` ${result.error.code}` : ''}`);
      try { await this.report(cmd.id, result); } catch { /* stays in outbox */ }
      this.syncRunning = null;
    })();
  }

  private async heartbeatLoop() {
    let n = 0;
    while (!this.stopping) {
      if (n++ % 4 === 0 && this.secrets.has('vlUsername')) await this.probeVisionline();
      try { if (this.hotel) await this.platform('/connector/v1/heartbeat', this.health(), 10_000); } catch { this.platformReachable = false; }
      await sleep(this.cfg.heartbeatSec * 1000);
    }
  }

  async stop() {
    this.stopping = true;
    await this.watch.stop((id) => this.vl.request('DELETE', `/callback/${encodeURIComponent(id)}`));
    for (const c of this.operatorClients.values()) await c.close();
    await this.vl.close();
  }
}
