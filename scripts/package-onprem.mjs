/**
 * Builds the on-premises package for the Vingcard / Visionline server:
 *   app/platform.mjs, app/admin.mjs, app/gateway.mjs, app/cs-check.mjs  (one file each, all dependencies included)
 *   migrations/, portal/ (built web portal), brand/, service/NodeService.cs, the PowerShell scripts,
 *   connector/ (the Windows connector package), VERSION, README.txt
 *
 *   npm run build:portal && npm run package:connector && npm run package:onprem
 *     -> dist/onprem/staff-mobile-key-onprem/  (+ staff-mobile-key-onprem-<version>.zip when "zip" exists)
 *
 * The server needs Node.js 22 LTS and PostgreSQL only: no npm install, no third-party service wrapper.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
const outRoot = join(root, 'dist/onprem');
const out = join(outRoot, 'staff-mobile-key-onprem');
const portalDist = join(root, 'apps/portal/dist/index.html');
const connectorDir = join(root, 'dist/connector/staff-mobile-key-connector');
if (!existsSync(portalDist)) throw new Error('Build the portal first: npm run build:portal');
if (!existsSync(connectorDir)) throw new Error('Build the connector package first: npm run package:connector');

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(join(out, 'app'), { recursive: true });
const common = {
  bundle: true, platform: 'node', target: 'node22', format: 'esm', legalComments: 'none', logLevel: 'warning',
  external: ['pg-native'],
  define: { 'process.env.SMK_BUILD_VERSION': JSON.stringify(version) },
  banner: { js: "import { createRequire as __smkCreateRequire } from 'node:module'; const require = __smkCreateRequire(import.meta.url);" },
};
const be = join(root, 'apps/backend/src');
for (const [entry, file] of [['main.ts', 'platform.mjs'], ['tools/admin.ts', 'admin.mjs'], ['gateway/gateway.ts', 'gateway.mjs'], ['tools/cs-check.ts', 'cs-check.mjs']])
  await build({ ...common, entryPoints: [join(be, entry)], outfile: join(out, 'app', file) });

cpSync(join(root, 'apps/backend/migrations'), join(out, 'migrations'), { recursive: true });
cpSync(join(root, 'apps/portal/dist'), join(out, 'portal'), { recursive: true });
cpSync(join(root, 'brand'), join(out, 'brand'), { recursive: true });
const op = join(root, 'onprem');
cpSync(join(op, 'service'), join(out, 'service'), { recursive: true });
for (const f of ['install-onprem.ps1', 'backup-onprem.ps1', 'database-tools.ps1', 'set-platform-secrets.ps1', 'set-external-access.ps1', 'rollback-onprem.ps1', 'uninstall-onprem.ps1', 'README.txt', 'gateway.config.template.json'])
  cpSync(join(op, f), join(out, f));
cpSync(connectorDir, join(out, 'connector'), { recursive: true });
writeFileSync(join(out, 'VERSION'), `${version}\r\n`);

if (existsSync('/usr/bin/zip')) {
  const zip = join(outRoot, `staff-mobile-key-onprem-${version}.zip`);
  execFileSync('zip', ['-qr', zip, 'staff-mobile-key-onprem'], { cwd: outRoot });
  console.log(`On-premises ${version} package: ${zip}`);
} else console.log(`On-premises ${version} package folder: ${out}`);
