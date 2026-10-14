import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Platform release shown on reports and in the portal. The on-premises bundle has it built in
 * (SMK_BUILD_VERSION, set by scripts/package-onprem.mjs); otherwise it is read from the VERSION file.
 */
function read(): string {
  if (process.env.SMK_BUILD_VERSION) return process.env.SMK_BUILD_VERSION;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, '../../../VERSION'), join(process.cwd(), 'VERSION'), join(process.cwd(), '../../VERSION')]) {
    try { if (existsSync(p)) return readFileSync(p, 'utf8').split(/\r?\n/)[0]!.trim(); } catch { /* next */ }
  }
  return 'unknown';
}
export const PLATFORM_VERSION = read();
