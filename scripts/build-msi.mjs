// Builds the Windows installer (.msi) from the on-premises package with wixl (msitools, Linux/WSL).
//   npm run package:connector && npm run package:onprem && npm run package:msi
//   -> dist/msi/StaffMobileKey-Server-<version>.msi
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
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.push(relative(pkg, p)); } };
walk(pkg);
// Harvest the package into components (stable GUIDs from the path, so upgrades replace files cleanly).
const frag = execFileSync('wixl-heat', ['--directory-ref', 'INSTALLDIR', '--component-group', 'PackageFiles', '--var', 'var.SourceDir', '-p', `${pkg}/`, '--win64'],
  { cwd: pkg, input: files.map((f) => join(pkg, f)).join('\n') + '\n', maxBuffer: 64 * 1024 * 1024 }).toString();
writeFileSync(join(out, 'files.wxs'), frag);
const msi = join(out, `StaffMobileKey-Server-${version}.msi`);
execFileSync('wixl', ['-a', 'x64', '-o', msi,
  '-D', `Version=${version}`, '-D', 'Win64=yes', '-D', `SourceDir=${pkg}`,
  '-D', `Manufacturer=${process.env.SMK_MSI_MANUFACTURER ?? 'Staff Mobile Key'}`, '-D', `HelpLink=${process.env.SMK_MSI_HELP ?? 'https://github.com/akalook-Kit/AAGS_StaffMobileKey'}`,
  join(root, 'installer/msi/product.wxs'), join(out, 'files.wxs')], { stdio: 'inherit' });
const sha = createHash('sha256').update(readFileSync(msi)).digest('hex');
writeFileSync(`${msi}.sha256`, `${sha}  StaffMobileKey-Server-${version}.msi\n`);
console.log(`MSI: ${msi} (${files.length} files, ${(statSync(msi).size / 1048576).toFixed(1)} MB) sha256 ${sha}`);
