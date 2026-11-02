import { describe, expect, it } from 'vitest';
import { binaryWorkbook, cardLogColumns, decodeReport, detectKind, parseSystemSettings, parseTable } from './vl-reports.ts';

const SAMPLE = ['', '[System code]', '1111-2222-3333', 'AA-00000', '', '[Visionline]', 'Version: 1.21.1.16', '',
  '[Guest cards]', 'Default number of guest cards: 2', 'Default check-in time: 2:00 PM', '', '[Options]', '(1) PMS Plus', '(39) Mobile Access', '',
  '[Events]', '(5) Access', '    Y: (40) Emergency', '    N: (45) Exit Button', '(4) Alert', '    Y: (19) Battery Level', ''].join('\r\n');

describe('Visionline reports (2.17)', () => {
  it('reads the System settings report as Visionline saves it (UTF-16 ".xls")', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SAMPLE, 'utf16le')]);
    const text = decodeReport(buf);
    expect(detectKind(text, parseTable(text).head)).toBe('system_settings');
    const s = parseSystemSettings(text);
    expect(s.facts['System code']).toBe('1111-2222-3333');
    expect(s.facts['Visionline version']).toBe('1.21.1.16');
    expect(s.facts['Guest cards · Default number of guest cards']).toBe('2');
    expect(s.options.map((o) => o.code)).toEqual(['1', '39']);
    expect(s.events[0]).toEqual({ group: 'Access', items: [{ on: true, code: '40', name: 'Emergency' }, { on: false, code: '45', name: 'Exit Button' }] });
  });
  it('recognises a card log and an operator list; refuses real workbooks', () => {
    const log = parseTable('Reg. no\tCard holder\tOperator\tCreated\r\n135799\tJean\tMarie\t2026-10-20 10:00\r\n');
    expect(detectKind('', log.head)).toBe('card_log');
    expect(cardLogColumns(log.head)).toEqual({ reg: 0, op: 2, at: 3 });
    expect(detectKind('', parseTable('Operator;Operator template\nsym;System manager\n').head)).toBe('operators');
    expect(binaryWorkbook(Buffer.from([0x50, 0x4b, 3, 4]))).toBe(true);
    expect(binaryWorkbook(Buffer.from('[System code]'))).toBe(false);
  });
});
