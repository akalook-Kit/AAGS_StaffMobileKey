// Builds the Windows installer (.msi) from the on-premises package with wixl (msitools, Linux/WSL).
//   npm run package:connector && npm run package:onprem && npm run package:msi
//   -> dist/msi/AccessMonitoringTool-Server-<version>.msi
// Optional: SMK_MSI_MANUFACTURER (your company name, shown in Windows "Apps"), SMK_MSI_HELP (support web page).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
const root = new URL('..', import.meta.url).pathname;
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
const pkg = join(root, 'dist/onprem/staff-mobile-key-onprem');
if (!existsSync(join(pkg, 'install-onprem.ps1'))) throw new Error('Build the on-premises package first: npm run package:onprem');
if (!existsSync('/usr/bin/wixl')) throw new Error('wixl is needed (Ubuntu/WSL: sudo apt-get install wixl msitools)');
const out = join(root, 'dist/msi');
mkdirSync(out, { recursive: true });
// 2.17 Two small Windows helpers, compiled here with Mono (mcs) for .NET Framework 4 (part of Windows 10/11/Server):
// run-hidden.exe runs the installation scripts without a console window; ask-setup.exe asks the setup questions.
const tools = join(out, 'tools');
mkdirSync(tools, { recursive: true });
if (!existsSync('/usr/bin/mcs')) throw new Error('mcs (Mono C# compiler) is needed: sudo apt-get install mono-mcs');
// 2.17.1 Compiled against the .NET Framework 4.0 reference assemblies, not Mono's own libraries: with Mono's mscorlib
// the compiler picked String.TrimEnd(char), which .NET Framework does not have ("Method not found ... TrimEnd(Char)").
// Now the compiler refuses anything Windows' .NET Framework 4 lacks. The assemblies (MIT, .NET Foundation) are fetched
// once from github.com/mono/reference-assemblies at a fixed commit and checked against these SHA-256 values.
const REF_COMMIT = '02349172cfa5732cdf2c6c5aa5d1dd2315213b70';
const REFS = {
  'mscorlib.dll': '57dad5c007d52244b7681eacbbf83f9cf03824e83b86884e84f3461bf40cccdf',
  'System.dll': '49636283124d77cad96631b219e99933c9fbc6f521d50efc9ecc80073147d9ae',
  'System.Core.dll': '1859548ac9f909fb2f117fb099e22a2981694feec1a8bebac848365e90367fc9',
  'System.Drawing.dll': '497a784112eec5ba04534c7ec383e2bb7d4faa6b6e819c208d2d8eea3c6e8576',
  'System.Windows.Forms.dll': '5ac34d5b214bfa6bf1d38f9c9222915f69524dcbd66c3953abec0735cd5bcaa7',
  'System.Security.dll': '0e68b4aa350528d6777c2638cca5229886c9045a82ca1dbabb506bb2c7028aa7',
};
const refDir = join(root, 'dist/netfx40-refs');
mkdirSync(refDir, { recursive: true });
for (const [n, sha] of Object.entries(REFS)) {
  const f = join(refDir, n);
  const ok = () => existsSync(f) && createHash('sha256').update(readFileSync(f)).digest('hex') === sha;
  if (!ok()) {
    const r = await fetch(`https://raw.githubusercontent.com/mono/reference-assemblies/${REF_COMMIT}/v4.0/${n}`);
    if (!r.ok) throw new Error(`Downloading the reference assembly ${n} failed (${r.status}).`);
    writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    if (!ok()) throw new Error(`The reference assembly ${n} does not have the expected SHA-256.`);
  }
}
const netfx = (...names) => ['-noconfig', '-nostdlib', ...['mscorlib.dll', 'System.dll', ...names].map((n) => `-r:${join(refDir, n)}`)];
execFileSync('mcs', ['-target:winexe', '-optimize+', ...netfx(), `-out:${join(pkg, 'run-hidden.exe')}`, join(root, 'installer/msi/tools/RunHidden.cs')], { stdio: 'inherit' });
execFileSync('mcs', ['-target:winexe', '-optimize+', ...netfx('System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Security.dll'), `-out:${join(tools, 'ask-setup.exe')}`,
  join(root, 'installer/msi/tools/AskSetup.cs')], { stdio: 'inherit' });
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.push(relative(pkg, p)); } };
walk(pkg);
// Harvest the package into components (stable GUIDs from the path, so upgrades replace files cleanly).
const frag = execFileSync('wixl-heat', ['--directory-ref', 'INSTALLDIR', '--component-group', 'PackageFiles', '--var', 'var.SourceDir', '-p', `${pkg}/`, '--win64'],
  { cwd: pkg, input: files.map((f) => join(pkg, f)).join('\n') + '\n', maxBuffer: 64 * 1024 * 1024 }).toString();
writeFileSync(join(out, 'files.wxs'), frag);
const msi = join(out, `AccessMonitoringTool-Server-${version}.msi`);
execFileSync('wixl', ['-a', 'x64', '-o', msi,
  '-D', `Version=${version}`, '-D', 'Win64=yes', '-D', `SourceDir=${pkg}`, '-D', `ToolsDir=${tools}`,
  '-D', `Manufacturer=${process.env.SMK_MSI_MANUFACTURER ?? 'Access Monitoring Tool'}`, '-D', `HelpLink=${process.env.SMK_MSI_HELP ?? 'https://github.com/akalook-Kit/AAGS_StaffMobileKey'}`,
  join(root, 'installer/msi/product.wxs'), join(out, 'files.wxs')], { stdio: 'inherit' });
// 2.17 The setup-questions action (type 2 = program stored in the Binary table, synchronous, exit code checked).
execFileSync('msibuild', [msi, '-q', "INSERT INTO `CustomAction` (`Action`, `Type`, `Source`, `Target`) VALUES ('AskSetup', 2, 'AskSetupExe', '')"]);
// 2.16.1 Deferred actions must run between InstallInitialize and InstallFinalize (else Windows stops with error 2762).
{
  const seq = Object.fromEntries(execFileSync('msiinfo', ['export', msi, 'InstallExecuteSequence']).toString().split(/\r?\n/).slice(3)
    .map((l) => l.split('\t')).filter((c) => c.length >= 3).map((c) => [c[0], Number(c[2])]));
  const ui = execFileSync('msiinfo', ['export', msi, 'InstallUISequence']).toString();
  if (!/AskSetup/.test(ui)) throw new Error('The setup questions (AskSetup) are not in the InstallUISequence.');
  const ca = execFileSync('msiinfo', ['export', msi, 'CustomAction']).toString();
  if (!/^AskSetup\t2\tAskSetupExe/m.test(ca)) throw new Error('The AskSetup custom action is missing.');
  const bin = execFileSync('msiinfo', ['export', msi, 'Binary']).toString();
  if (!/^AskSetupExe\t/m.test(bin)) throw new Error('ask-setup.exe is missing from the Binary table.');
  for (const a of ['RunServerInstaller', 'RunServerUninstaller'])
    if (!(seq[a] > seq.InstallInitialize && seq[a] < seq.InstallFinalize)) throw new Error(`${a} is at ${seq[a]}, outside InstallInitialize ${seq.InstallInitialize} - InstallFinalize ${seq.InstallFinalize}`);
  if (!(seq.RunServerUninstaller < seq.RemoveFiles && seq.RunServerInstaller > seq.InstallFiles)) throw new Error('Custom actions are in the wrong order around the file actions.');
  console.log(`MSI sequence OK: installer ${seq.RunServerInstaller}, uninstaller ${seq.RunServerUninstaller} (between ${seq.InstallInitialize} and ${seq.InstallFinalize})`);
}
const sha = createHash('sha256').update(readFileSync(msi)).digest('hex');
writeFileSync(`${msi}.sha256`, `${sha}  AccessMonitoringTool-Server-${version}.msi\n`);
console.log(`MSI: ${msi} (${files.length} files, ${(statSync(msi).size / 1048576).toFixed(1)} MB) sha256 ${sha}`);
