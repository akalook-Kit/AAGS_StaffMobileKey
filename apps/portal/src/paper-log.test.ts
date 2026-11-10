import { describe, expect, it } from 'vitest';
import { parsePaperLog } from './paper-log';

describe('paper battery log (2.31, the cards kept in the locks)', () => {
  it('reads the lines of the card of 804 and 404', () => {
    const r = parsePaperLog(['22/07/2026 LCO', '04/09/2026 Porte batterie Augustin', '14/04/2026 LCA + Pil Serge', '02/10/2026 Augus', 'le 23/05/2024 Thomson Atien',
      "installation d'un LGU neuf et VARTA industriel 04/03/2023", '26/09/26 ARNOL', '31/02/2026 X'].join('\n'), 'classic-alfa');
    expect(r[0]).toMatchObject({ doneOn: '2026-07-22', parts: ['lcu'], doneBy: '' });
    expect(r[1]).toMatchObject({ doneOn: '2026-09-04', parts: ['battery-holder'], doneBy: 'Augustin' });
    expect(r[2]).toMatchObject({ doneOn: '2026-04-14', parts: ['lca', 'batteries'], doneBy: 'Serge' });
    expect(r[3]).toMatchObject({ doneOn: '2026-10-02', parts: ['batteries'], doneBy: 'Augus' });
    expect(r[4]).toMatchObject({ doneOn: '2024-05-23', parts: ['batteries'], doneBy: 'Thomson Atien' });
    expect(r[5]).toMatchObject({ doneOn: '2023-03-04', parts: ['lcu', 'batteries'], batteryType: 'industrial-alkaline' });
    expect(r[6]).toMatchObject({ doneOn: '2026-09-26', doneBy: 'ARNOL' });
    expect(r[7]!.error).toMatch(/not valid/);
  });
  it('keeps remarks in brackets out of the parts and the name', () => {
    expect(parsePaperLog('02/11/2026 LCU (?) (written "LCO", top of the card)', 'classic-alfa')[0]).toMatchObject({ parts: ['lcu'], doneBy: '' });
  });
  it('maps LCU / LCA to the door unit and reader on other models', () => {
    expect(parsePaperLog('01/02/2026 LCU', 'signature-rfid')[0]!.parts).toEqual(['door-unit']);
  });
});
