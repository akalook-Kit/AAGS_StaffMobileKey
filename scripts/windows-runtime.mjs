/**
 * The Windows runtime bundled with the on-premises package (2.9), so the hotel server needs nothing installed:
 *   runtime/node/node.exe   Node.js 22 LTS (official build, signed by the OpenJS Foundation)
 *   runtime/pgsql/          PostgreSQL 16 server (EDB Windows binaries, repackaged by the embedded-postgres project)
 *                           + the Microsoft Visual C++ runtime DLLs it needs (signed by Microsoft), app-local
 *   runtime/VERSIONS.txt    versions, sources and the SHA-256 of every program file (for the hotel's IT/antivirus)
 *
 * Every download is pinned and checked before use. Downloads are cached in .cache/windows-runtime.
 *   node scripts/windows-runtime.mjs <output folder>
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.cache/windows-runtime');

export const RUNTIME = {
  node: { spec: 'node-win-x64@22.23.2', file: 'node-win-x64-22.23.2.tgz', version: '22.23.2',
    integrity: 'sha512-xKmY4NKtdOtMmesJb8WZax5wsHybu0SeqIAVuPWTy7aBr9wOCI5YxyxxzfbjEzPcOq2rQ+RURlxNTGFWYjc4Bw==',
    exeSha256: '0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4' },
  postgres: { spec: '@embedded-postgres/windows-x64@16.14.0-beta.17', file: 'embedded-postgres-windows-x64-16.14.0-beta.17.tgz', version: '16.14',
    integrity: 'sha512-Wn4nuAT1H7SIJuLWPs+C1aSdZKpbTloCr0Xaozdfg956lUVvv3iHv6K8Lsc+xmtt1qQpTno3PJLqAgzJ/lg60Q==' },
  vcRuntime: { file: 'msvc_runtime-14.44.35112-cp312-cp312-win_amd64.whl', version: '14.44.35112',
    url: 'https://files.pythonhosted.org/packages/21/3b/134d04268ab8e35853cd007582076429b45d60d6abb1036d159be9c50342/msvc_runtime-14.44.35112-cp312-cp312-win_amd64.whl',
    sha256: '32f9c706009e16ccc319d6947ce3bffe20e5192bee52b18cf48313f9e7bedfbe',
    dlls: { 'vcruntime140.dll': 'd5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066', 'vcruntime140_1.dll': '1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f', 'msvcp140.dll': '0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9' } },
};
// PostgreSQL program files kept (the server, initdb, pg_ctl and the DLLs they and the server extensions load).
const PG_BIN_KEEP = ['postgres.exe', 'initdb.exe', 'pg_ctl.exe', 'icudt67.dll', 'icuin67.dll', 'icuuc67.dll', 'libcrypto-3-x64.dll', 'libecpg.dll', 'libiconv-2.dll',
  'libintl-9.dll', 'liblz4.dll', 'libpgtypes.dll', 'libpq.dll', 'libssl-3-x64.dll', 'libwinpthread-1.dll', 'libxml2.dll', 'libxslt.dll', 'libzstd.dll', 'zlib1.dll'];

const sha = (algo, file, enc = 'hex') => createHash(algo).update(readFileSync(file)).digest(enc);
const isWin = process.platform === 'win32';

function npmPack(spec, file, integrity) {
  const target = join(cache, file);
  if (!existsSync(target)) execFileSync(isWin ? 'npm.cmd' : 'npm', ['pack', spec, '--pack-destination', cache, '--silent'], { stdio: ['ignore', 'ignore', 'inherit'], shell: isWin });
  const got = `sha512-${sha('sha512', target, 'base64')}`;
  if (got !== integrity) { rmSync(target, { force: true }); throw new Error(`${file}: integrity ${got} does not match the pinned ${integrity}`); }
  return target;
}
function download(url, file, sha256) {
  const target = join(cache, file);
  if (!existsSync(target)) execFileSync(isWin ? 'curl.exe' : 'curl', ['-fsSL', '--retry', '3', '-o', target, url], { stdio: 'inherit' });
  const got = sha('sha256', target);
  if (got !== sha256) { rmSync(target, { force: true }); throw new Error(`${file}: SHA-256 ${got} does not match the pinned ${sha256}`); }
  return target;
}
function extract(archive, into) {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  if (archive.endsWith('.whl') && !isWin) execFileSync('unzip', ['-q', archive, '-d', into]);
  else execFileSync('tar', [archive.endsWith('.tgz') ? '-xzf' : '-xf', archive, '-C', into]); // Windows 10+ tar reads zip files too
}
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

export function buildWindowsRuntime(out) {
  mkdirSync(cache, { recursive: true });
  const work = join(cache, 'work');
  rmSync(out, { recursive: true, force: true });

  // Node.js
  extract(npmPack(RUNTIME.node.spec, RUNTIME.node.file, RUNTIME.node.integrity), join(work, 'node'));
  const nodeExe = join(work, 'node/package/bin/node.exe');
  if (sha('sha256', nodeExe) !== RUNTIME.node.exeSha256) throw new Error('node.exe is not the expected official build');
  mkdirSync(join(out, 'node'), { recursive: true });
  cpSync(nodeExe, join(out, 'node/node.exe'));

  // PostgreSQL
  extract(npmPack(RUNTIME.postgres.spec, RUNTIME.postgres.file, RUNTIME.postgres.integrity), join(work, 'pg'));
  const pg = join(work, 'pg/package/native');
  const pgOut = join(out, 'pgsql');
  mkdirSync(join(pgOut, 'bin'), { recursive: true });
  for (const f of PG_BIN_KEEP) cpSync(join(pg, 'bin', f), join(pgOut, 'bin', f));
  cpSync(join(pg, 'lib'), join(pgOut, 'lib'), { recursive: true, filter: (src) => !/\.(lib|a|pdb)$/i.test(src) && !/[\\/]pgxs([\\/]|$)/.test(src) });
  cpSync(join(pg, 'share'), join(pgOut, 'share'), { recursive: true });
  cpSync(join(work, 'pg/package/LICENSE.md'), join(pgOut, 'LICENSE-embedded-postgres.md'));

  // Visual C++ runtime, next to the PostgreSQL programs that need it (no system-wide installation).
  extract(download(RUNTIME.vcRuntime.url, RUNTIME.vcRuntime.file, RUNTIME.vcRuntime.sha256), join(work, 'vc'));
  const vcDir = join(work, 'vc/msvc_runtime-14.44.35112.data/data/Scripts');
  for (const [dll, want] of Object.entries(RUNTIME.vcRuntime.dlls)) {
    if (sha('sha256', join(vcDir, dll)) !== want) throw new Error(`${dll} is not the expected Microsoft file`);
    cpSync(join(vcDir, dll), join(pgOut, 'bin', dll));
  }

  const programs = walk(out).filter((f) => /\.(exe|dll)$/i.test(f)).sort();
  writeFileSync(join(out, 'VERSIONS.txt'), [
    'Staff Mobile Key - Windows runtime (used only by Staff Mobile Key; nothing is installed system-wide)',
    '',
    `Node.js ${RUNTIME.node.version} (official Windows build, Authenticode-signed by the OpenJS Foundation). MIT licence. https://nodejs.org`,
    `PostgreSQL ${RUNTIME.postgres.version} server (EnterpriseDB Windows binaries via ${RUNTIME.postgres.spec}). PostgreSQL Licence. https://www.postgresql.org`,
    `Microsoft Visual C++ runtime ${RUNTIME.vcRuntime.version} (vcruntime140, vcruntime140_1, msvcp140; signed by Microsoft), redistributed app-local as Microsoft allows.`,
    '',
    'SHA-256 of every program file (for antivirus / application allow-lists):',
    ...programs.map((f) => `${sha('sha256', f)}  ${relative(out, f).replace(/\//g, '\\')}`),
    '',
  ].join('\r\n'));
  rmSync(work, { recursive: true, force: true });
  return { files: programs.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2];
  if (!out) throw new Error('Usage: node scripts/windows-runtime.mjs <output folder>');
  console.log(buildWindowsRuntime(out));
}
