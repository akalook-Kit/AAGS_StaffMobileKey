import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { compileAllow, startGateway } from './gateway.ts';

describe('gateway address allow-list', () => {
  it('matches IPv4 ranges, IPv4-mapped IPv6 and "private"', () => {
    const a = compileAllow(['41.202.219.0/24', '196.13.4.7']);
    expect(a('41.202.219.77')).toBe(true);
    expect(a('::ffff:41.202.219.5')).toBe(true);
    expect(a('41.202.218.1')).toBe(false);
    expect(a('196.13.4.7')).toBe(true);
    expect(a('196.13.4.8')).toBe(false);
    const p = compileAllow(['private']);
    expect(p('192.168.1.20')).toBe(true);
    expect(p('10.4.5.6')).toBe(true);
    expect(p('172.20.0.1')).toBe(true);
    expect(p('172.32.0.1')).toBe(false);
    expect(p('8.8.8.8')).toBe(false);
    expect(p('::1')).toBe(true);
    expect(p('2001:db8::1')).toBe(false);
  });
  it('rejects nonsense ranges', () => { expect(() => compileAllow(['not-an-ip'])).toThrow(); });
});

describe('gateway external entrance', () => {
  let upstream: http.Server; let gw: Awaited<ReturnType<typeof startGateway>>; let port = 0;
  const seen: { url?: string; xff?: string }[] = [];
  const SECRET = '/k-test-secret-path-123456789';
  beforeAll(async () => {
    upstream = http.createServer((req, res) => { seen.push({ url: req.url, xff: req.headers['x-forwarded-for'] as string }); res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`up:${req.url}`); });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const up = (upstream.address() as AddressInfo).port;
    gw = startGateway({ upstream: `http://127.0.0.1:${up}`, secretPath: SECRET, banAfter: 5, listeners: [{ name: 'external', host: '127.0.0.1', port: 0, allow: ['127.0.0.1'], requireSecretPath: true }] }, {});
    await new Promise((r) => setTimeout(r, 100));
    port = (gw.servers[0]!.address() as AddressInfo).port;
  });
  afterAll(async () => { await gw.close(); upstream.close(); });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: 'manual' });

  it('answers 404 without the secret path or a pass, and forwards nothing', async () => {
    const r = await get('/api/v1/me');
    expect(r.status).toBe(404);
    expect(seen.length).toBe(0);
    expect(r.headers.get('x-frame-options')).toBe('DENY');
  });
  it('the secret path hands out a pass cookie and redirects to the portal', async () => {
    const r = await get(`${SECRET}/`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/');
    expect(r.headers.get('set-cookie')).toMatch(/^smk_gw=\d+\.[\w-]+; Path=\/; Max-Age=43200; HttpOnly; SameSite=Strict/);
  });
  it('with the pass, requests reach the platform; the prefix also works directly (staff app)', async () => {
    const cookie = (await get(`${SECRET}/`)).headers.get('set-cookie')!.split(';')[0]!;
    const a = await get('/api/v1/me', { cookie });
    expect(a.status).toBe(200); expect(await a.text()).toBe('up:/api/v1/me');
    const b = await get(`${SECRET}/mobile/v1/config?hotel=k-hotel-bana`);
    expect(await b.text()).toBe('up:/mobile/v1/config?hotel=k-hotel-bana');
  });
  it('a forged pass is refused', async () => {
    expect((await get('/api/v1/me', { cookie: `smk_gw=${Math.floor(Date.now() / 1000) + 3600}.forged` })).status).toBe(404);
  });
  it('never forwards the connector API or Credential Services callbacks', async () => {
    const before = seen.length;
    expect((await get(`${SECRET}/connector/v1/hello`)).status).toBe(404);
    expect((await get(`${SECRET}/integrations/credential-services/callback/k-hotel-bana`)).status).toBe(404);
    expect(seen.length).toBe(before);
  });
  it('replaces a client-supplied X-Forwarded-For with the real address', async () => {
    await get(`${SECRET}/api/v1/x`, { 'x-forwarded-for': '1.2.3.4' });
    expect(seen[seen.length - 1]!.xff).toBe('127.0.0.1');
  });
  it('bans an address after repeated misses (connection dropped)', async () => {
    for (let i = 0; i < 6; i++) await get('/guess').catch(() => null);
    await expect(get(`${SECRET}/`)).rejects.toThrow();
  });
});
