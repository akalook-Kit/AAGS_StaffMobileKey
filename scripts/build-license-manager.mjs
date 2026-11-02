// Builds the offline License Manager (one HTML file, tweetnacl 1.0.3 inlined) for the vendor's PC.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('..', import.meta.url).pathname;
const src = readFileSync(`${root}tools/license-manager/license-manager.src.html`, 'utf8');
const nacl = readFileSync(`${root}tools/license-manager/vendor/nacl-fast.min.js`, 'utf8');
const sha = createHash('sha256').update(nacl).digest('hex');
if (sha !== '3ec535c004aeeb225785d8e93fb33bf99f52e399bd7dfc01969b5629baea5131') throw new Error('tweetnacl file changed');
const out = src.replace('<script>/*NACL*/</script>', `<script>/* tweetnacl-js 1.0.3 (public domain) */\n${nacl}</script>`);
mkdirSync(`${root}dist/license-manager`, { recursive: true });
writeFileSync(`${root}dist/license-manager/SMK-License-Manager.html`, out);
console.log('License Manager: dist/license-manager/SMK-License-Manager.html');
