import { loadConfig, installationUuid } from './config.ts';
import { SecretStore } from './secret-store.ts';
import { Connector } from './connector.ts';
import { startLocalAdmin } from './local-admin.ts';
import { CONNECTOR_VERSION } from './connector.ts';

if (process.argv.includes('--version')) { console.log(CONNECTOR_VERSION); process.exit(0); }
const cfg = loadConfig();
const secrets = new SecretStore(cfg.dataDir);

// Installer helper: `node connector.mjs set-secrets` reads {"platformToken": "...", "adminPassword": "..."} on
// standard input (never on the command line or in the environment) and stores them encrypted.
if (process.argv[2] === 'set-secrets') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const v = JSON.parse(input || '{}') as Record<string, string | undefined>;
  const allowed = ['platformToken', 'adminPassword', 'vlUsername', 'vlPassword', 'vlAccessId'] as const;
  const picked = Object.fromEntries(allowed.filter((k) => typeof v[k] === 'string' && v[k]!.length > 0).map((k) => [k, v[k]]));
  secrets.set(picked);
  console.log(`Saved ${Object.keys(picked).join(', ') || 'nothing'} (encrypted in ${cfg.dataDir})`);
  process.exit(0);
}

// Development/Docker convenience: import secrets from the environment once, then they live encrypted on disk.
// On a real Visionline PC, enter them on the local setup page instead and keep them out of the environment.
const fromEnv = {
  platformToken: process.env.PLATFORM_TOKEN, vlUsername: process.env.VL_USERNAME, vlPassword: process.env.VL_PASSWORD,
  vlAccessId: process.env.VL_ACCESS_ID, adminPassword: process.env.CONNECTOR_ADMIN_PASSWORD,
};
if (Object.values(fromEnv).some(Boolean)) secrets.set(fromEnv);

const connector = new Connector(cfg, secrets, installationUuid(cfg.dataDir));
const admin = startLocalAdmin(connector);
console.log(`[connector] Visionline ${cfg.visionline.baseUrl} - platform ${cfg.platformUrl} - data ${cfg.dataDir}`);

let stoppingNow = false;
const shutdown = async () => {
  if (stoppingNow) return;
  stoppingNow = true;
  console.log('[connector] stopping');
  admin.close();
  await connector.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Under the Windows service host, end of standard input means "service stopping".
if (process.env.SMK_SERVICE_STDIN_SHUTDOWN === '1') { process.stdin.on('end', shutdown); process.stdin.on('close', shutdown); process.stdin.resume(); }
await connector.run();
