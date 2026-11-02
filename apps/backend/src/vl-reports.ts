/**
 * 2.17 Reports exported from Visionline, imported by an administrator, for what the Visionline Web API does not give:
 *   - the System settings report (Visionline: Help -> System settings / "System information", saved as .xls/.txt):
 *     system code, version, options, housekeeping, door counts, event settings;
 *   - a list of Visionline operators (who can do what in Visionline), exported as a table;
 *   - a card log / issued-cards list (card number + operator), so "Issued by" shows the Visionline operator.
 * Visionline saves these "Excel" files as Unicode (UTF-16) text; tab- or comma-separated tables work too.
 */
export type ImportKind = 'system_settings' | 'operators' | 'card_log' | 'user_groups' | 'other';

export function decodeReport(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString('utf16le'); }
  // UTF-16 without a byte order mark: every other byte is zero.
  let zeros = 0; for (let i = 1; i < Math.min(buf.length, 400); i += 2) if (buf[i] === 0) zeros++;
  if (zeros > 150) return buf.toString('utf16le');
  return buf.toString('utf8').replace(/^﻿/, '');
}

/** "Excel" files that are real workbooks cannot be read here: ask for the Unicode text / CSV export. */
export function binaryWorkbook(buf: Buffer): boolean {
  return (buf[0] === 0x50 && buf[1] === 0x4b) || (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0);
}

export interface SystemSettings {
  sections: { name: string; lines: string[] }[];
  facts: Record<string, string>;
  options: { code: string; name: string }[];
  events: { group: string; items: { on: boolean; code: string; name: string }[] }[];
}

export function parseSystemSettings(text: string): SystemSettings {
  const sections: { name: string; lines: string[] }[] = [];
  let cur: { name: string; lines: string[] } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const h = /^\[(.+)\]$/.exec(line.trim());
    if (h) { cur = { name: h[1]!.trim(), lines: [] }; sections.push(cur); continue; }
    if (!line.trim()) continue;
    if (!cur) { cur = { name: 'General', lines: [] }; sections.push(cur); }
    if (cur.lines.length < 2000) cur.lines.push(line.slice(0, 300));
  }
  const facts: Record<string, string> = {};
  const sec = (n: string) => sections.find((s) => s.name.toLowerCase() === n.toLowerCase());
  const code = sec('System code');
  if (code) { facts['System code'] = code.lines[0]?.trim() ?? ''; if (code.lines[1]) facts['System ID'] = code.lines[1].trim(); }
  const ver = sec('Visionline')?.lines.find((l) => /^Version:/i.test(l.trim()));
  if (ver) facts['Visionline version'] = ver.split(':').slice(1).join(':').trim();
  for (const s of sections) {
    if (['options', 'events', 'components', 'internal events', 'system code'].includes(s.name.toLowerCase())) continue;
    for (const l of s.lines) {
      const m = /^([^:]{3,80}):\s+(.+)$/.exec(l.trim());
      if (m && Object.keys(facts).length < 200) facts[`${s.name} · ${m[1]!.trim()}`] = m[2]!.trim();
      else if (/^firmware pack version/i.test(l.trim())) facts['Firmware pack'] = l.trim().replace(/^firmware pack version\s*/i, '').replace(/ installed\.?$/i, '');
    }
  }
  const options = (sec('Options')?.lines ?? []).map((l) => /^\((\d+)\)\s*(.+)$/.exec(l.trim())).filter(Boolean).map((m) => ({ code: m![1]!, name: m![2]!.trim() }));
  const events: SystemSettings['events'] = [];
  for (const l of sec('Events')?.lines ?? []) {
    const g = /^\((\d+)\)\s*(.+)$/.exec(l.trim());
    const it = /^([YN]):\s*\((\d+)\)\s*(.+)$/.exec(l.trim());
    if (g && !/^\s/.test(l)) events.push({ group: g[2]!.trim(), items: [] });
    else if (it && events.length) events[events.length - 1]!.items.push({ on: it[1] === 'Y', code: it[2]!, name: it[3]!.trim() });
  }
  return { sections, facts, options, events };
}

/** A table: tab-, semicolon- or comma-separated, first non-empty line = headings. */
export function parseTable(text: string): { head: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { head: [], rows: [] };
  const first = lines[0]!;
  const sep = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
  const split = (l: string) => {
    if (sep === '\t') return l.split('\t').map((x) => x.trim().replace(/^"|"$/g, ''));
    const out: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i]!;
      if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === sep && !q) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const head = split(first).map((h) => h.slice(0, 80));
  const rows = lines.slice(1, 20001).map((l) => split(l).map((c) => c.slice(0, 200)));
  return { head, rows };
}

export function detectKind(text: string, head: string[]): ImportKind {
  if (/^\s*\[System code\]/m.test(text) || /^\s*\[Visionline\]/m.test(text)) return 'system_settings';
  const h = head.map((x) => x.toLowerCase());
  const has = (re: RegExp) => h.some((x) => re.test(x));
  if (has(/^(reg\.? ?no|registration|card ?(no|number|id))/) && has(/operator|issued by|encoded by|created by/)) return 'card_log';
  if (has(/operator|login|user ?name/) && has(/template|privilege|right|access|role|group/)) return 'operators';
  if (has(/user ?group/) && has(/door/)) return 'user_groups';
  return 'other';
}

/** Card number and operator columns of a card log. */
export function cardLogColumns(head: string[]) {
  const h = head.map((x) => x.toLowerCase());
  const reg = h.findIndex((x) => /^(reg\.? ?no|registration|card ?(no|number|id))/.test(x));
  const op = h.findIndex((x) => /operator|issued by|encoded by|created by/.test(x));
  const at = h.findIndex((x) => /^(time|date|created|issued|encoded)/.test(x) && !/by/.test(x));
  return { reg, op, at };
}

/** Shared Visionline operators (PMS interface, "sym"...) in an operators list. */
export function operatorColumns(head: string[]) {
  const h = head.map((x) => x.toLowerCase());
  return { name: h.findIndex((x) => /operator|login|user ?name|^name/.test(x)), template: h.findIndex((x) => /template|privilege|right|role|group|access/.test(x)) };
}
