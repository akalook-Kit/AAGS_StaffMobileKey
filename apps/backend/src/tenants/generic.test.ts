import { describe, expect, it } from 'vitest';
import { genericProfile, slugify } from './generic.ts';
import { SCHEMAS } from '../hotel-config.ts';

describe('any hotel (installer answers -> first settings)', () => {
  const env = { HOTEL_NAME: 'Lakeview Résort & Spa Kigali', HOTEL_TIMEZONE: 'Africa/Kigali', HOTEL_COUNTRY: 'rw', HOTEL_SYSTEM_ID: '4711' };
  it('makes a hotel code from the name', () => {
    expect(slugify('Lakeview Résort & Spa Kigali')).toBe('lakeview-resort-spa-kigali');
    expect(genericProfile(env).slug).toBe('lakeview-resort-spa-kigali');
    expect(genericProfile({ ...env, PROVISION_HOTEL: 'lakeview' }).slug).toBe('lakeview');
  });
  it('produces settings that pass validation, with no K Hotel Bana values', () => {
    const p = genericProfile(env);
    for (const [kind, data] of Object.entries(p.config)) expect(SCHEMAS[kind as keyof typeof SCHEMAS].safeParse(data).success, kind).toBe(true);
    const all = JSON.stringify(p.config);
    expect(all).not.toMatch(/K Hotel|khotel|Bana|3460|hma-cs-/i);
    expect((p.config.property as any).systemNumber).toBe('4711');
    expect((p.config.credential_services as any).systemId).toBe(4711);
    expect((p.config.property as any).country).toBe('RW');
  });
  it('refuses missing or wrong answers', () => {
    expect(() => genericProfile({ ...env, HOTEL_NAME: '' })).toThrow(/HOTEL_NAME/);
    expect(() => genericProfile({ ...env, HOTEL_TIMEZONE: 'Nairobi' })).toThrow(/IANA/);
    expect(() => genericProfile({ ...env, HOTEL_TIMEZONE: '' })).toThrow(/TIMEZONE/);
    expect(() => genericProfile({ ...env, HOTEL_COUNTRY: 'Kenya' })).toThrow(/two-letter/);
    expect(() => genericProfile({ ...env, PROVISION_HOTEL: 'Bad Code!' })).toThrow(/lower-case/);
  });
});
