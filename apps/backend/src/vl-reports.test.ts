import { describe, expect, it } from 'vitest';
import { binaryWorkbook, cardLogColumns, decodeReport, detectKind, parseSystemSettings, parseTable, visionlineGlance } from './vl-reports.ts';

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

describe('Visionline setup report, first page (2.27)', () => {
  it('finds the version and AES wherever Visionline wrote them', () => {
    const a = visionlineGlance(parseSystemSettings(SAMPLE));
    expect(a.version).toBe('1.21.1.16');
    expect(a.aes.enabled).toBeNull();
    expect(a.mobileAccess).toBe(true);
    expect(a.eventsOn).toBe(2);
    const b = visionlineGlance(parseSystemSettings(['Visionline 1.27.0.25 - System settings', '[Security]', 'AES encryption: Yes', '[Locks]', 'Number of locks: 312', 'Online locks: 40'].join('\n')));
    expect(b.version).toBe('1.27.0.25');
    expect(b.aes).toEqual({ enabled: true, evidence: '[Security] AES encryption: Yes' });
    expect(b.locksInReport).toEqual([{ label: 'Number of locks', value: '312' }, { label: 'Online locks', value: '40' }]);
    const c = visionlineGlance(parseSystemSettings(['[General]', 'Program version: 1.24.3', 'Card encryption: AES-128'].join('\n')));
    expect(c.version).toBe('1.24.3');
    expect(c.aes.enabled).toBe(true);
    expect(visionlineGlance(parseSystemSettings('[System]\nUse AES: N\n')).aes.enabled).toBe(false);
    expect(visionlineGlance(parseSystemSettings('[Options]\n(77) AES card encryption\n')).aes.enabled).toBe(true);
    // K Hotel Bana's report: a card capability, not the AES key mode (2.28)
    const bana = visionlineGlance(parseSystemSettings('[Known authentication information]\nUltralight AES signature\n[PMS]\nPMS encryption key: Not set\n'));
    expect(bana.aes.enabled).toBeNull();
    expect(bana.knownAuth).toEqual(['Ultralight AES signature']);
    expect(bana.encryption).toBeNull();
    expect(bana.pmsEncryptionKey).toBe('Not set');
  });
});

describe('AES key mode and licence facts (2.28, ASSA ABLOY 66 5013 166-1B)', () => {
  const rep = (km: string, extra = '') => visionlineGlance(parseSystemSettings(['[Visionline]', 'Version: 1.34.0.17', '', '[Security enhancement process]', `Key mode: ${km}`, 'System ID last set: 2022-03-04 07:31:55', extra, '', '[Known authentication information]', 'Ultralight AES signature',
    '[License]', 'Number of clients: 5', 'DESFire EV1 enhancement: Yes', '[PMS]', 'PMS interface: TCP/IP', 'PMS encryption key: Not set', '[Options]', '(39) Mobile Access', ''].join('\r\n')));
  it('reads the key mode', () => {
    expect(rep('Not started').aes.enabled).toBe(false);
    expect(rep('Not started').keyMode?.state).toBe('not_started');
    expect(rep('In progress').keyMode?.state).toBe('in_progress');
    const f = rep('Finished', "A 'Disable legacy key mode' card has been created.");
    expect(f.aes.enabled).toBe(true);
    expect(f.keyMode).toEqual({ state: 'finished', text: 'Finished', systemIdLastSet: '2022-03-04 07:31:55', disableLegacyCardCreated: true });
  });
  it('reads clients, EV1, PMS and the mobile key licence', () => {
    const g = rep('Finished');
    expect(g.clients?.value).toBe('5');
    expect(g.ev1?.value).toBe('Yes');
    expect(g.pms.map((x) => x.label)).toEqual(['PMS interface', 'PMS encryption key']);
    expect(g.mobileLicence?.state).toBe('licensed');
    expect(visionlineGlance(parseSystemSettings('[Options]\n(39) Mobile Access demo\n')).mobileLicence?.state).toBe('demo');
  });
});
