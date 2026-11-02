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
execFileSync('mcs', ['-target:winexe', '-optimize+', `-out:${join(pkg, 'run-hidden.exe')}`, join(root, 'installer/msi/tools/RunHidden.cs')], { stdio: 'inherit' });
execFileSync('mcs', ['-target:winexe', '-optimize+', `-out:${join(tools, 'ask-setup.exe')}`, '-r:System.Windows.Forms.dll', '-r:System.Drawing.dll', '-r:System.Security.dll',
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
