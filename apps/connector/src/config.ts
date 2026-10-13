import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { VL } from '@smk/shared/node';

/** Non-secret connector settings. Secrets go to the SecretStore, never into this file (spec §6). */
const Schema = z.object({
  platformUrl: z.string().url(),
  dataDir: z.string().default('./data'),
  localAdmin: z.object({ host: z.string().default('127.0.0.1'), port: z.number().int().default(8090) }).default({ host: '127.0.0.1', port: 8090 }),
  visionline: z.object({
    baseUrl: z.string().url().default(VL.defaultBaseUrl), // per-hotel value [spec §12.1.1]
    caFile: z.string().optional(), // trust anchor for the Visionline certificate
    pinSha256: z.string().optional(), // optional certificate pin (rotate with the certificate)
    servername: z.string().optional(), // host name in the certificate, if it does not cover 127.0.0.1
    revokeStrategy: z.enum(['checkoutPerDoor', 'cancelCard']).default('checkoutPerDoor'),
    /** Watch Visionline for cancelled cards and refused doors [Web API §7.14]. */
    watch: z.boolean().default(true),
    /** Refuse every command that would change Visionline (issue, revoke, create user group). For trying the
     *  connector against a live Visionline: discovery, credential checks and the watch still work. */
    readOnly: z.boolean().default(false),
  }).default({ baseUrl: VL.defaultBaseUrl, revokeStrategy: 'checkoutPerDoor', watch: true, readOnly: false }),
  heartbeatSec: z.number().int().min(5).default(15),
});
export type ConnectorConfig = z.infer<typeof Schema>;

export function loadConfig(): ConnectorConfig {
  const file = resolve(process.env.CONNECTOR_CONFIG ?? 'connector.config.json');
  // Windows editors may save a byte-order mark; JSON.parse does not accept it.
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
  // Empty strings in the file mean "not set".
  for (const k of ['caFile', 'pinSha256', 'servername']) if (fromFile.visionline?.[k] === '') delete fromFile.visionline[k];
  const e = process.env;
  const merged = {
    ...fromFile,
    ...(e.PLATFORM_URL ? { platformUrl: e.PLATFORM_URL } : {}),
    ...(e.CONNECTOR_DATA_DIR ? { dataDir: e.CONNECTOR_DATA_DIR } : {}),
    localAdmin: { ...fromFile.localAdmin, ...(e.LOCAL_ADMIN_HOST ? { host: e.LOCAL_ADMIN_HOST } : {}), ...(e.LOCAL_ADMIN_PORT ? { port: Number(e.LOCAL_ADMIN_PORT) } : {}) },
    visionline: {
      ...fromFile.visionline,
      ...(e.VL_BASE_URL ? { baseUrl: e.VL_BASE_URL } : {}),
      ...(e.VL_CA_FILE ? { caFile: e.VL_CA_FILE } : {}),
      ...(e.VL_PIN_SHA256 ? { pinSha256: e.VL_PIN_SHA256 } : {}),
      ...(e.VL_SERVERNAME ? { servername: e.VL_SERVERNAME } : {}),
      ...(e.VL_REVOKE_STRATEGY ? { revokeStrategy: e.VL_REVOKE_STRATEGY } : {}),
      ...(e.VL_WATCH ? { watch: e.VL_WATCH !== 'false' } : {}),
      ...(e.VL_READ_ONLY ? { readOnly: e.VL_READ_ONLY === 'true' } : {}),
    },
  };
  const cfg = Schema.parse(merged);
  cfg.dataDir = resolve(cfg.dataDir);
  return cfg;
}

/** Stable per-installation UUID, sent to Visionline as "uuid" with the access ID [Web API §5.24.2] and to the platform. */
export function installationUuid(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const f = join(dataDir, 'installation.json');
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')).uuid;
  const uuid = randomUUID();
  writeFileSync(f, JSON.stringify({ uuid, createdAt: new Date().toISOString() }, null, 2));
  return uuid;
}
