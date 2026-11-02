import { describe, expect, it } from 'vitest';
import { VisionlineApiError } from './client.ts';
import { utcForms, withTimeForms } from './time-forms.ts';

describe('Visionline query time formats', () => {
  it('offers UTC forms that all end in Z', () => {
    expect(utcForms(new Date('2026-10-17T12:40:31.123Z'))).toEqual(['20261017T1240Z', '20261017T124031Z', '2026-10-17T12:40:31Z']);
  });
  it('moves to the next form on "Time must be in UTC." and remembers it', async () => {
    const tried: string[] = [];
    const call = async (t: string) => { tried.push(t); if (!t.endsWith('Z')) throw new VisionlineApiError(400, 40002, 'Time must be in UTC.'); return t; };
    expect(await withTimeForms('test.a', ['202610171540', '20261017T1240Z'], call)).toBe('20261017T1240Z');
    tried.length = 0;
    await withTimeForms('test.a', ['202610171541', '20261017T1241Z'], call);
    expect(tried).toEqual(['20261017T1241Z']);
  });
  it('does not hide other errors', async () => {
    await expect(withTimeForms('test.b', ['x', 'y'], async () => { throw new VisionlineApiError(401, 40101, 'Session not found'); })).rejects.toThrow('Session not found');
  });
});
