import { afterEach, describe, expect, it } from 'vitest';
import { LIGHT_REMOVED_PERMISSIONS, withoutEdition } from '@smk/shared';
import { isPrivateIp, openAccessAllowed } from './edition.ts';

const req = (o: { listener?: string; ip?: string; remote?: string }) =>
  ({ headers: o.listener ? { 'x-smk-listener': o.listener } : {}, ip: o.ip ?? '192.168.1.20', socket: { remoteAddress: o.remote ?? '127.0.0.1' } }) as any;

describe('2.33 light edition', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  it('recognises private addresses', () => {
    for (const ip of ['10.1.2.3', '192.168.0.9', '172.16.0.1', '172.31.255.1', '127.0.0.1', '::1', '::ffff:192.168.1.4', 'fd12:3456::1']) expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ['41.202.219.10', '172.32.0.1', '8.8.8.8', '::ffff:41.1.1.1', '2001:db8::1']) expect(isPrivateIp(ip)).toBe(false);
  });

  it('open access needs the light edition and SMK_OPEN_ACCESS=lan', () => {
    process.env.SMK_EDITION = 'full'; process.env.SMK_OPEN_ACCESS = 'lan';
    expect(openAccessAllowed(req({ listener: 'lan' })).ok).toBe(false);
    process.env.SMK_EDITION = 'light'; process.env.SMK_OPEN_ACCESS = 'off';
    expect(openAccessAllowed(req({ listener: 'lan' })).ok).toBe(false);
  });

  it('only the LAN listener from a private address; never external or the tunnel', () => {
    process.env.SMK_EDITION = 'light'; process.env.SMK_OPEN_ACCESS = 'lan'; delete process.env.SMK_OPEN_ACCESS_DIRECT;
    expect(openAccessAllowed(req({ listener: 'lan' })).ok).toBe(true);
    expect(openAccessAllowed(req({ listener: 'external' })).ok).toBe(false);
    expect(openAccessAllowed(req({ listener: 'tunnel' })).ok).toBe(false);
    expect(openAccessAllowed(req({ listener: 'lan', ip: '41.202.219.10' })).ok).toBe(false);
    // Directly on the backend only with SMK_OPEN_ACCESS_DIRECT=1 and from loopback.
    expect(openAccessAllowed(req({})).ok).toBe(false);
    process.env.SMK_OPEN_ACCESS_DIRECT = '1';
    expect(openAccessAllowed(req({ ip: '127.0.0.1' })).ok).toBe(true);
    expect(openAccessAllowed(req({ ip: '10.0.0.5', remote: '10.0.0.5' })).ok).toBe(false);
  });

  it('the light edition removes keys, keycard issuing, staff and safety permissions', () => {
    const all = ['reports.read', 'battery.read', 'key.issue', 'keycards.manage', 'staff.manage', 'emergency.manage', 'settings.manage'] as any;
    expect([...withoutEdition(new Set(all), 'light')]).toEqual(['reports.read', 'battery.read', 'settings.manage']);
    expect([...withoutEdition(new Set(all), 'full')]).toEqual(all);
    expect(LIGHT_REMOVED_PERMISSIONS).toContain('key.issue');
  });
});
