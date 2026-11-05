import { describe, it, expect, beforeEach } from 'vitest';
import { WebApiAdapter } from './adapter.ts';
import { VisionlineApiError } from './client.ts';

/**
 * 2.26.1 Bana: "Invalid query parameter value" when reading a card on "Encoder .96". Every safe form of the read is
 * tried (action read/readCard, encoder space as %20 or +), the working one is remembered, and if none works the
 * error lists Visionline's answer to each.
 */
function vl(accept: (path: string) => boolean, seen: string[]) {
  return {
    async request(method: string, path: string) {
      seen.push(`${method} ${path}`);
      if (method === 'GET') return { cardHolder: 'u1', expireTime: '20271231T2359', doorOperations: [{ operation: 'normal', doors: ['101'], doorGroups: [] }] };
      if (accept(path)) return { id: '480101', cardHolder: 'u1' };
      throw new VisionlineApiError(400, 40017, 'Invalid query parameter value.', 'Invalid query parameter value.');
    },
  } as any;
}
describe('reading a card at an encoder', () => {
  beforeEach(() => WebApiAdapter.encoderStyles.clear());
  it('tries the other action name', async () => {
    const seen: string[] = [];
    const a = new WebApiAdapter(vl((p) => p.includes('action=readCard'), seen), () => 'UTC', 'checkoutPerDoor');
    const r = await a.readCardAtEncoder('Encoder .96', 'read');
    expect(r.regNo).toBe('480101');
    expect(r.actionUsed).toBe('readCard');
    expect(seen[0]).toContain('action=read&encoder=Encoder%20.96');
  });
  it('tries the encoder name with + for the space, and remembers it for encoding too', async () => {
    const seen: string[] = [];
    const a = new WebApiAdapter(vl((p) => p.includes('encoder=Encoder+.96') && p.includes('action=read&'), seen), () => 'UTC', 'checkoutPerDoor');
    const r = await a.readCardAtEncoder('Encoder .96', 'read');
    expect(r.encoderStyleUsed).toBe('plus');
    expect(seen.filter((s) => s.startsWith('POST'))).toHaveLength(3);
    expect(WebApiAdapter.encoderParam('Encoder .96')).toBe('Encoder+.96');
  });
  it('reports every answer when no form works', async () => {
    const a = new WebApiAdapter(vl(() => false, []), () => 'UTC', 'checkoutPerDoor');
    await expect(a.readCardAtEncoder('Encoder .96', 'read')).rejects.toThrow(/refused every form.*action=read&encoder=Encoder%20\.96.*action=readCard&encoder=Encoder\+\.96/);
  });
  it('does not retry other errors (no card on the encoder)', async () => {
    const seen: string[] = [];
    const a = new WebApiAdapter({ async request(m: string, p: string) { seen.push(p); throw new VisionlineApiError(400, 40024, 'There is no card on encoder Encoder .96.'); } } as any, () => 'UTC', 'checkoutPerDoor');
    await expect(a.readCardAtEncoder('Encoder .96', 'read')).rejects.toThrow(/no card/);
    expect(seen).toHaveLength(1);
  });
});
