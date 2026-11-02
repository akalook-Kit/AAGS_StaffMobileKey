import { describe, it, expect, afterAll } from 'vitest';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { VisionlineClient } from './client.ts';

/**
 * 2.21 Bana, 31 Oct: "Visionline cannot be reached: read ECONNRESET" while Visionline was fine. A request sent on a
 * kept-alive connection that Visionline had already dropped fails with ECONNRESET. A read is resent once on a new
 * connection; idle connections are closed by the connector first.
 */
const dir = mkdtempSync(join(tmpdir(), 'vl-stale-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Visionline WebService', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
const key = readFileSync(join(dir, 'k.pem')), cert = readFileSync(join(dir, 'c.pem'));

let dropReusedGet = true; const seen: { method: string; reused: boolean }[] = [];
const server = https.createServer({ key, cert }, (req, res) => {
  const reused = ((req.socket as any).__n = ((req.socket as any).__n ?? 0) + 1) > 1;
  seen.push({ method: req.method!, reused });
  if (req.method === 'GET' && reused && dropReusedGet) { req.socket.destroy(); return; /* the client sees ECONNRESET (socket hang up) */ }
  req.resume(); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') { res.statusCode = 201; res.end(JSON.stringify({ id: 's1', accessKey: 'k' })); }
    else res.end(JSON.stringify([{ id: 'r1' }, { id: 'r2' }]));
  });
});
const ready = new Promise<number>((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port)));
afterAll(() => server.close());

describe('Visionline connection dropped while idle', () => {
  it('a read on a dropped kept-alive connection is resent once on a new one', async () => {
    const port = await ready;
    const c = new VisionlineClient(`https://127.0.0.1:${port}/api/v1`, { caFile: join(dir, 'c.pem') }, () => ({ username: 'u', password: 'p', clientUuid: 'x' }));
    const r = await c.request<any[]>('GET', '/resources');
    expect(r).toHaveLength(2);
    // session POST on a new connection, GET on the same (dropped), GET again on a new connection
    expect(seen.map((s) => `${s.method}${s.reused ? '*' : ''}`)).toEqual(['POST', 'GET*', 'GET']);
    await c.close();
  });
  it('idle connections are closed by the connector after the idle time', async () => {
    const port = await ready; seen.length = 0; dropReusedGet = false;
    const before = VisionlineClient.idleSocketMs; VisionlineClient.idleSocketMs = 200;
    const c = new VisionlineClient(`https://127.0.0.1:${port}/api/v1`, { caFile: join(dir, 'c.pem') }, () => ({ username: 'u', password: 'p', clientUuid: 'x' }));
    VisionlineClient.idleSocketMs = before;
    await c.request('GET', '/resources');
    await new Promise((r) => setTimeout(r, 600));
    await c.request('GET', '/resources');
    expect(seen.map((s) => s.reused)).toEqual([false, true, false]);
    await c.close();
  });
});
