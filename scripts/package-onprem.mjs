/**
 * Builds the on-premises package for the Vingcard / Visionline server:
 *   app/platform.mjs, app/admin.mjs, app/gateway.mjs, app/cs-check.mjs  (one file each, all dependencies included)
 *   migrations/, portal/ (built web portal), brand/, service/NodeService.cs, the PowerShell scripts,
 *   connector/ (the Windows connector package), runtime/ (Node.js + PostgreSQL for Windows, see windows-runtime.mjs),
 *   Install.cmd / Uninstall.cmd, VERSION, README.txt
 *
 *   npm run build:portal && npm run package:connector && npm run package:onprem
 *     -> dist/onprem/staff-mobile-key-onprem/  (+ staff-mobile-key-onprem-<version>.zip when "zip" exists)
 *
 * 2.9: the server needs nothing installed beforehand. Double-click Install.cmd.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWindowsRuntime } from './windows-runtime.mjs';

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
  // 2.12 Hotels receive programs, not source code: bundled and minified, no source maps (names kept for error reports).
  minify: true, keepNames: true, sourcemap: false,
  external: ['pg-native'],
  define: { 'process.env.SMK_BUILD_VERSION': JSON.stringify(version), __SMK_PACKAGED__: 'true' },
  banner: { js: "import { createRequire as __smkCreateRequire } from 'node:module'; const require = __smkCreateRequire(import.meta.url);" },
};
const be = join(root, 'apps/backend/src');
for (const [entry, file] of [['main.ts', 'platform.mjs'], ['tools/admin.ts', 'admin.mjs'], ['gateway/gateway.ts', 'gateway.mjs'], ['tools/cs-check.ts', 'cs-check.mjs']])
  await build({ ...common, entryPoints: [join(be, entry)], outfile: join(out, 'app', file) });

// A module with a top-level await inside an import cycle never finishes loading in a bundle (2.9 lesson):
// the bundles must not await any module initialiser.
for (const f of ['platform.mjs', 'admin.mjs', 'gateway.mjs', 'cs-check.mjs'])
  if (/^await init_/m.test(readFileSync(join(out, 'app', f), 'utf8'))) throw new Error(`${f}: a bundled module uses top-level await; remove it.`);

cpSync(join(root, 'apps/backend/migrations'), join(out, 'migrations'), { recursive: true });
cpSync(join(root, 'apps/portal/dist'), join(out, 'portal'), { recursive: true });
cpSync(join(root, 'brand'), join(out, 'brand'), { recursive: true });
// 2.17 The quick start and the manual travel with the installer (everything in one file).
mkdirSync(join(out, 'docs'), { recursive: true });
for (const d of ['QUICK-START.md', 'USER-MANUAL.md', 'SECURITY-AND-COMPLIANCE.md', 'TESTERS.md', 'EXTERNAL-ACCESS.md']) cpSync(join(root, 'docs', d), join(out, 'docs', d));
const op = join(root, 'onprem');
cpSync(join(op, 'service'), join(out, 'service'), { recursive: true });
// Windows tools: CRLF line endings (cmd.exe needs them; Notepad shows them right).
const crlf = (t) => t.replace(/\r?\n/g, '\r\n');
for (const f of ['Install.cmd', 'Uninstall.cmd', 'install-onprem.ps1', 'install-auto.ps1', 'database-tools.ps1', 'set-platform-secrets.ps1', 'set-external-access.ps1', 'set-tunnel-access.ps1', 'set-connector-access.ps1', 'rollback-onprem.ps1', 'uninstall-onprem.ps1', 'README.txt', 'gateway.config.template.json', 'Open-StaffMobileKey.cmd', 'open-portal.ps1'])
  writeFileSync(join(out, f), /\.(cmd|ps1|txt)$/.test(f) ? crlf(readFileSync(join(op, f), 'utf8')) : readFileSync(join(op, f)));
cpSync(connectorDir, join(out, 'connector'), { recursive: true });
writeFileSync(join(out, 'VERSION'), `${version}\r\n`);
// 2.33 Edition packages: SMK_PACKAGE_EDITION=la-falaise-light writes edition.json, read by install-onprem.ps1.
const EDITIONS = {
  'la-falaise-light': { title: 'La Falaise Hotel Bonapriso - Light (reports)', msiName: 'AccessMonitoringTool-LaFalaise-Light',
    env: { SMK_EDITION: 'light', SMK_OPEN_ACCESS: 'lan', SMK_TENANT: 'la-falaise' } },
};
const pe = process.env.SMK_PACKAGE_EDITION;
rmSync(join(out, 'edition.json'), { force: true });
if (pe) {
  if (!EDITIONS[pe]) throw new Error(`Unknown SMK_PACKAGE_EDITION ${pe}; known: ${Object.keys(EDITIONS).join(', ')}`);
  writeFileSync(join(out, 'edition.json'), JSON.stringify({ id: pe, ...EDITIONS[pe] }, null, 2) + '\r\n');
  console.log(`Edition package: ${EDITIONS[pe].title}`);
}
const rt = buildWindowsRuntime(join(out, 'runtime'));
console.log(`Windows runtime: ${rt.files} program files checked and included.`);

if (existsSync('/usr/bin/zip')) {
  const zip = join(outRoot, `staff-mobile-key-onprem-${version}.zip`);
  execFileSync('zip', ['-qr', zip, 'staff-mobile-key-onprem'], { cwd: outRoot });
  console.log(`On-premises ${version} package: ${zip}`);
} else console.log(`On-premises ${version} package folder: ${out}`);
