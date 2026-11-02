import { describe, expect, it } from 'vitest';
import { genericCardName } from './index.ts';

describe('generic keycard names (2.20)', () => {
  it('flags names that are not a person', () => {
    for (const n of ['Staff', 'Housekeeping 2', 'HK 01', 'Maid', 'Grand Master', 'Spare card', 'Test', 'FO-03', '1234', '', 'Room attendant 5', 'Security Guard', 'Daily staff 7', 'Engineering', 'n/a'])
      expect(genericCardName(n), n).toBe(true);
  });
  it('does not flag people', () => {
    for (const n of ['Armel Karerwa', 'Koffi Team', 'Desmond Dessy Amunyela', 'Siddharth Mehra', 'Asif Mohammed', 'Grace'])
      expect(genericCardName(n), n).toBe(false);
  });
});
