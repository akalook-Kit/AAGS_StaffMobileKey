/**
 * Builds the Windows connector package: one JavaScript file per program (connector and probe, all
 * dependencies included), the service host source, and the PowerShell installer.
 *
 *   npm run package:connector        → dist/connector/staff-mobile-key-connector/  (+ .zip when "zip" exists)
 *
 * The Visionline PC needs only Node.js 22 LTS; no npm install and no third-party service wrapper.
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
const connectorVersion = /CONNECTOR_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'apps/connector/src/connector.ts'), 'utf8'))[1];
const outRoot = join(root, 'dist/connector');
const out = join(outRoot, 'staff-mobile-key-connector');
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(join(out, 'app'), { recursive: true });

const common = {
  bundle: true, platform: 'node', target: 'node22', format: 'esm', legalComments: 'none', logLevel: 'warning',
  banner: { js: "import { createRequire as __smkCreateRequire } from 'node:module'; const require = __smkCreateRequire(import.meta.url);" },
};
await build({ ...common, entryPoints: [join(root, 'apps/connector/src/main.ts')], outfile: join(out, 'app/connector.mjs') });
await build({ ...common, entryPoints: [join(root, 'apps/connector/src/probe.ts')], outfile: join(out, 'app/probe.mjs') });

const win = join(root, 'apps/connector/windows');
for (const f of ['install.ps1', 'uninstall.ps1', 'set-secrets.ps1', 'visionline-probe.ps1', 'README.txt', 'connector.config.template.json'])
  cpSync(join(win, f), join(out, f));
cpSync(join(win, 'service'), join(out, 'service'), { recursive: true });
writeFileSync(join(out, 'VERSION'), `${connectorVersion}\r\nplatform release ${version}\r\n`);

if (existsSync('/usr/bin/zip')) {
  const zip = join(outRoot, `staff-mobile-key-connector-${connectorVersion}.zip`);
  execFileSync('zip', ['-qr', zip, 'staff-mobile-key-connector'], { cwd: outRoot });
  console.log(`Connector ${connectorVersion} package: ${zip}`);
} else console.log(`Connector ${connectorVersion} package folder: ${out}`);
