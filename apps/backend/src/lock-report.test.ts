import { describe, expect, it } from 'vitest';
import { analyseLockReport, detectDateOrder, localTime, parseLockReport } from './lock-report.ts';

const HEAD = 'User group\tCard name\tRegistration No.\tTime\tEvent\tMain guest room\tUser ID\tLast name\tFirst name\tIssued by';
const row = (t: string, ev: string, card = 'Door Unit Internal', name = '') => `n/a\t${card}\tn/a\t${t}\t${ev}\t\t\t${name}\t\t`;
const utf16 = (lines: string[]) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n'), 'utf16le')]);

describe('lock event report (2.18 troubleshooting)', () => {
  it('reads dates in either order', () => {
    expect(detectDateOrder(['10/24/2026 1:52 PM', '9/14/2026 2:08 AM'])).toBe('MDY');
    expect(detectDateOrder(['24/10/2026 13:52'])).toBe('DMY');
    expect(localTime('10/24/2026 1:52 PM', 'MDY')).toBe('2026-10-24T13:52');
    expect(localTime('10/24/2026 12:05 AM', 'MDY')).toBe('2026-10-24T00:05');
    expect(localTime('2026-10-24 08:01:09', 'DMY')).toBe('2026-10-24T08:01');
  });

  it('finds fast-draining batteries, faults and a lost clock, and keeps no names', () => {
    const lines = [HEAD];
    // Newest first, like Visionline. New batteries on 2 Oct, below 4.4 V three days later.
    lines.push(row('10/12/2026 9:00 AM', 'Battery level below 4.2 volts (1078)'));
    for (let d = 11; d >= 3; d--) for (let i = 0; i < 6; i++) {
      lines.push(row(`10/${d}/2026 ${i + 8}:10 AM`, 'The door is opened (0912)'));
      lines.push(row(`10/${d}/2026 ${i + 8}:09 AM`, 'Staff card accepted (0064)', 'Staff', 'Secret Person'));
    }
    lines.push(row('10/5/2026 8:00 PM', 'Battery level below 4.4 volts (1079)'));
    for (let i = 0; i < 6; i++) lines.push(row(`10/4/2026 ${i + 1}:00 PM`, 'Error, Internal (1975)'));
    lines.push(row('10/2/2026 9:20 PM', 'Battery level below 4.8 volts (1081)'));
    lines.push(row('10/2/2026 7:06 PM', 'Battery exchanged (0528)'));
    lines.push(row('10/1/2026 3:06 PM', 'Battery status in lock changed to Access Denied (0530)'));
    lines.push(row('10/1/2026 3:00 PM', 'Battery level below 3.8 volts (1076)'));
    lines.push(row('9/28/2026 3:00 PM', 'Battery level below 4.0 volts (1077)'));
    lines.push(row('7/20/1996 12:01 AM', 'Door unit cold started (0578)'));
    const p = parseLockReport(utf16(lines));
    expect(p.dateOrder).toBe('MDY');
    expect(JSON.stringify(p.events)).not.toContain('Secret');
    const a = analyseLockReport(p, Date.parse('2026-10-26T00:00:00Z'));
    expect(a.usage.openings).toBe(54);
    expect(a.usage.staffCards).toBe(54);
    expect(a.clockLost).toBe(1);
    expect(a.battery.exchanges[0]!.t).toBe('2026-10-02T19:06');
    const titles = a.findings.map((f) => f.title);
    expect(titles.some((t) => /New batteries down to 4\.4 V in 3 days/.test(t))).toBe(true);
    expect(titles.some((t) => /refused cards because of its battery/.test(t))).toBe(true);
    expect(titles.some((t) => /Internal lock error 6 times/.test(t))).toBe(true);
    expect(titles.some((t) => /lost its clock/.test(t))).toBe(true);
    expect(a.findings[0]!.level).toBe('high');
    expect(a.battery.avgDropPer30Days).toBeGreaterThan(1);
  });

  it('reads the newer report (Event time, Read-out time, Seq.No), drops duplicates and treats battery alarms after new batteries as a firmware fault', () => {
    const H2 = 'Door\tUser group\tCard name\tS/N\tRegistration No.\tEvent time\tEvent\tRead-out time\tUser ID\tLast name\tFirst name\tIssued by\tSeq.No';
    const r2 = (t: string, ev: string, seq: number, card = 'Staff', name = 'Secretname') => `314\tGrand Master\t${card}\t043d46f2811290ff\t100103\t${t}\t${ev}\t10/26/2026 11:00 AM\tAfratech\t${name}\tArmel\tSym\t${seq}`;
    const lines = [H2,
      r2('10/26/2026 10:28 AM', 'Staff card accepted (0064)', 3),
      r2('10/26/2026 10:20 AM', 'Alert, Battery level low (0304)', 2),
      r2('10/26/2026 10:04 AM', 'Staff card accepted (0064) (*)', 14),
      r2('10/26/2026 10:04 AM', 'Alert, Battery level low (0304)', 13),
      r2('10/26/2026 10:04 AM', 'Staff card accepted (0064)', 1),
      r2('10/26/2026 10:04 AM', 'Battery exchanged (0528)', 0, 'Door Unit Internal', ''),
      r2('10/26/2026 10:04 AM', 'Battery level below 4.8 volts (1081)', 15, 'Door Unit Internal', ''),
      r2('10/26/2026 10:04 AM', 'Alert, Battery level low (0304)', 13),
      r2('10/26/2026 10:03 AM', 'Alert, Battery level low (0304)', 11),
      r2('10/24/2026 12:01 PM', 'Battery level below 4.0 volts (1077)', 4, 'Door Unit Internal', ''),
    ];
    const p = parseLockReport(utf16(lines));
    expect(p.columns.time).toBe(5);
    expect(p.duplicates).toBe(1);
    expect(JSON.stringify(p.events)).not.toMatch(/Secretname|Armel|043d46/);
    const a = analyseLockReport(p, Date.parse('2026-10-27T00:00:00Z'));
    expect(a.battery.exchanges.length).toBe(1);
    // 2.19: a battery alarm after new batteries (readings fine) is a firmware fault, not a battery alarm.
    expect(a.battery.firmwareAlarms.length).toBe(3); // incl. 10:03, minutes before the change
    expect(a.battery.alarms.length).toBe(0);
    expect(a.findings.some((f) => /firmware fault/.test(f.title) && f.level === 'high')).toBe(true);
    const fw = a.steps.find((x) => x.id === 'firmware')!;
    expect(fw.suggests).toBe('likely');
  });

  it('refuses a file that is not a lock event report', () => {
    expect(() => parseLockReport(Buffer.from('Name,Group\nA,B\n'))).toThrow(/lock event report/);
  });
});
