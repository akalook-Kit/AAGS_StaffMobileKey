import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Connector secret store (spec §6, §13.3): Visionline operator name/password, access ID and the
 * platform token live only here, encrypted with AES-256-GCM.
 *
 * Master key protection:
 *  - Windows: the 32-byte master key is protected with DPAPI (LocalMachine scope) via PowerShell, so the
 *    file is useless if copied to another machine. Restrict the data folder to the service account.
 *  - Other OS (development/Docker): CONNECTOR_MASTER_KEY (base64, 32 bytes) or a 0600 key file.
 */
export type Secrets = Partial<{
  platformToken: string;
  vlUsername: string;
  vlPassword: string;
  vlAccessId: string;
  adminPassword: string;
  /** RSA key pair used to open credentials sealed in the portal. The private key never leaves this store. */
  sealPrivateKey: string;
  sealPublicKey: string;
  sealKeyId: string;
}>;

function dpapi(op: 'protect' | 'unprotect', b64: string): string {
  const ps = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${b64}');` +
    (op === 'protect'
      ? `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'LocalMachine'))`
      : `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'LocalMachine'))`);
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim();
}

function loadMasterKey(dataDir: string): Buffer {
  if (process.env.CONNECTOR_MASTER_KEY) {
    const k = Buffer.from(process.env.CONNECTOR_MASTER_KEY, 'base64');
    if (k.length !== 32) throw new Error('CONNECTOR_MASTER_KEY must be 32 bytes, base64-encoded');
    return k;
  }
  const file = join(dataDir, process.platform === 'win32' ? 'master.key.dpapi' : 'master.key');
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8').trim();
    return Buffer.from(process.platform === 'win32' ? dpapi('unprotect', raw) : raw, 'base64');
  }
  const k = randomBytes(32);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, process.platform === 'win32' ? dpapi('protect', k.toString('base64')) : k.toString('base64'), { mode: 0o600 });
  return k;
}

export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function open(key: Buffer, sealed: string): string {
  const b = Buffer.from(sealed, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

/** Atomic write: a crash mid-write never leaves a truncated file. */
export function writeAtomic(file: string, data: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

export class SecretStore {
  readonly key: Buffer;
  private file: string;
  private cache: Secrets;
  constructor(dataDir: string) {
    this.key = loadMasterKey(dataDir);
    this.file = join(dataDir, 'secrets.enc');
    this.cache = existsSync(this.file) ? JSON.parse(open(this.key, readFileSync(this.file, 'utf8'))) : {};
  }
  get<K extends keyof Secrets>(k: K): Secrets[K] { return this.cache[k]; }
  set(values: Secrets) {
    for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== '') (this.cache as any)[k] = v;
    writeAtomic(this.file, seal(this.key, JSON.stringify(this.cache)));
  }
  has(k: keyof Secrets) { return Boolean(this.cache[k]); }
}
