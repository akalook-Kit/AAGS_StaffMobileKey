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

/**
 * 2.27 The first page of the Visionline setup report (Armel, 4 Nov: "the version … whether the AES has been enabled or
 * not, number of locks … not in a vague way"). Read from the imported System settings report, wherever Visionline put
 * it: the [Visionline] section, a heading line, an option or a setting line. Works on reports imported before 2.27 too.
 */
export interface VisionlineGlance {
  version: string | null; versionFrom: string | null;
  pmsEncryptionKey: string | null;
  aes: { enabled: boolean | null; evidence: string | null };
  keyMode: { state: 'not_started' | 'in_progress' | 'finished' | null; text: string | null; systemIdLastSet: string | null; disableLegacyCardCreated: boolean } | null;
  knownAuth: string[];
  clients: { label: string; value: string; section: string } | null;
  ev1: { label: string; value: string; section: string } | null;
  pms: { label: string; value: string; section: string }[];
  pmsOptions: string[];
  mobileLicence: { state: 'licensed' | 'demo' | 'none'; evidence: string } | null;
  encryption: string | null;
  systemCode: string | null; systemId: string | null; firmwarePack: string | null;
  locksInReport: { label: string; value: string }[];
  options: { code: string; name: string }[];
  mobileAccess: boolean | null;
  guestCards: { label: string; value: string }[];
  eventsOn: number; eventsTotal: number;
}
const YES = /^(y|yes|on|true|enabled?|active|activated|1|oui|ja|s[ií])\b/i;
const NO = /^(n|no|off|false|disabled?|inactive|not (?:enabled|activated|used)|none|0|non|nein)\b/i;

export function visionlineGlance(s: Pick<SystemSettings, 'sections' | 'facts' | 'options' | 'events'>): VisionlineGlance {
  const options0 = () => s.options ?? [];
  const sections = s.sections ?? [];
  const all = sections.flatMap((sec) => sec.lines.map((l) => ({ sec: sec.name, line: l.trim() })));
  const kv = (l: string) => { const m = /^([^:=]{2,90})[:=]\s*(.*)$/.exec(l); return m ? { k: m[1]!.trim(), v: m[2]!.trim() } : null; };
  // ---- version
  let version: string | null = s.facts?.['Visionline version'] ?? null;
  let versionFrom: string | null = version ? '[Visionline] Version' : null;
  if (!version) {
    const VER = /(\d+\.\d+(?:\.\d+){0,3})/;
    for (const { sec, line } of all) {
      const p = kv(line);
      if (p && /(^|\s)(visionline\s+)?(software\s+|program\s+|application\s+|system\s+)?version$/i.test(p.k) && !/firmware|database|sql|windows|os\b|lock|encoder|api/i.test(p.k) && VER.test(p.v)) {
        version = VER.exec(p.v)![1]!; versionFrom = `[${sec}] ${p.k}`; break;
      }
    }
  }
  if (!version) {
    for (const { sec, line } of all) {
      const m = /visionline\D{0,20}?(\d+\.\d+(?:\.\d+){1,3})/i.exec(line);
      if (m) { version = m[1]!; versionFrom = `[${sec}] ${line.slice(0, 80)}`; break; }
    }
  }
  if (!version) {
    const sec = sections.find((x) => /^version$/i.test(x.name));
    const m = sec?.lines.map((l) => /(\d+\.\d+(?:\.\d+){0,3})/.exec(l)).find(Boolean);
    if (m) { version = m[1]!; versionFrom = '[Version]'; }
  }
  // ---- AES / card encryption
  let aes: VisionlineGlance['aes'] = { enabled: null, evidence: null };
  let encryption: string | null = null;
  for (const { sec, line } of all) {
    if (/^\s*options\s*$/i.test(sec) || /known authentication|security enhancement/i.test(sec)) continue;
    const yn = /^([YN]):\s*(?:\(\d+\)\s*)?(.+)$/.exec(line);
    const p = kv(line);
    if (/\baes\b/i.test(line)) {
      if (yn) { aes = { enabled: yn[1] === 'Y', evidence: `[${sec}] ${line}` }; break; }
      if (p && /\baes\b/i.test(p.k)) { aes = { enabled: YES.test(p.v) ? true : NO.test(p.v) ? false : p.v ? true : null, evidence: `[${sec}] ${line}` }; if (aes.enabled !== null) break; }
      if (p && /\baes\b/i.test(p.v)) { aes = { enabled: !/\b(no|not|off|disabled?)\b/i.test(p.v), evidence: `[${sec}] ${line}` }; encryption = p.v; break; }
      if (!aes.evidence) aes = { enabled: /\b(not|no|off|disabled?)\b/i.test(line) ? false : /\b(enabled?|on|active|used|yes)\b/i.test(line) ? true : null, evidence: `[${sec}] ${line}` };
    } else if (p && /encrypt|cipher|crypt/i.test(p.k) && !/\bpms\b/i.test(p.k) && !encryption) {
      encryption = `${p.k}: ${p.v}`;
    }
  }
  const aesOption = (s.options ?? []).find((o) => /\baes\b/i.test(o.name));
  if (aes.enabled === null && aesOption) aes = { enabled: true, evidence: `[Options] (${aesOption.code}) ${aesOption.name}` };
  if (aes.enabled === null && encryption && !/\baes\b/i.test(encryption) && /\b(des|mifare|crypto1|none|off|no)\b/i.test(encryption)) aes = { enabled: false, evidence: encryption };
  // 2.28 AES key mode, as Visionline 1.28+ writes it (ASSA ABLOY 66 5013 166-1B "Switch to AES key mode"):
  // [Security enhancement process] Key mode: Not started | In progress | Finished; System ID last set; and, once made,
  // "A 'Disable legacy key mode' card has been created." This is the real answer; it replaces any guess above.
  const sep = sections.find((x) => /security enhancement/i.test(x.name));
  let keyMode: VisionlineGlance['keyMode'] = null;
  if (sep) {
    const km = sep.lines.map((l) => kv(l.trim())).find((q) => q && /^key mode$/i.test(q.k));
    const last = sep.lines.map((l) => kv(l.trim())).find((q) => q && /system id last set/i.test(q.k));
    const card = sep.lines.some((l) => /disable legacy key mode.*card has been created/i.test(l));
    const v = km?.v ?? null;
    const state = !v ? null : /finish|complet|done/i.test(v) ? 'finished' : /progress|started|ongoing/i.test(v) && !/not\s+started/i.test(v) ? 'in_progress' : /not\s+started|legacy/i.test(v) ? 'not_started' : null;
    keyMode = { state, text: v, systemIdLastSet: last?.v ?? null, disableLegacyCardCreated: card };
    if (state) aes = { enabled: state === 'finished', evidence: `[${sep.name}] Key mode: ${v}${card ? ' · a "Disable legacy key mode" card has been created' : ''}` };
  }
  // Card types / authentications Visionline knows (e.g. "Ultralight AES signature"): a card capability, not the key mode.
  const knownAuth = sections.filter((x) => /known authentication/i.test(x.name)).flatMap((x) => x.lines.map((l) => l.trim())).filter(Boolean).slice(0, 30);
  // Licence facts, wherever they are written: clients allowed, DESFire EV1 enhancement, PMS, mobile keys.
  const pairs = all.map(({ sec, line }) => ({ sec, line, p: kv(line) }));
  const find = (re: RegExp, valueRe?: RegExp) => { const h = pairs.find((x) => x.p && re.test(x.p.k) && (!valueRe || valueRe.test(x.p.v))); return h ? { label: h.p!.k, value: h.p!.v, section: h.sec } : null; };
  const clients = find(/\bclients?\b|workstations?|client licen[cs]es?/i, /\d/);
  const ev1Line = pairs.find((x) => /\bev\s?1\b/i.test(x.line));
  const ev1Opt = options0().find((o) => /\bev\s?1\b/i.test(o.name));
  const ev1 = ev1Line ? { label: ev1Line.p?.k ?? ev1Line.line.replace(/^[YN]:\s*/, ''), value: ev1Line.p?.v ?? (/^N:/.test(ev1Line.line) ? 'No' : /^Y:/.test(ev1Line.line) ? 'Yes' : 'Listed'), section: ev1Line.sec }
    : ev1Opt ? { label: `(${ev1Opt.code}) ${ev1Opt.name}`, value: 'Licensed option', section: 'Options' } : null;
  const pms = pairs.filter((x) => x.p && (/\bpms\b|interface|hotel system|property management/i.test(x.p.k) || /\bpms\b/i.test(x.sec))).slice(0, 12).map((x) => ({ label: x.p!.k, value: x.p!.v, section: x.sec }));
  const pmsOptions = options0().filter((o) => /\bpms\b|interface/i.test(o.name)).map((o) => `(${o.code}) ${o.name}`);
  const mobOpt = options0().filter((o) => /mobile/i.test(o.name));
  const mobLine = pairs.find((x) => /mobile/i.test(x.line) && /demo|trial|evaluation|expir|licen[cs]e|valid/i.test(x.line));
  const mobileLicence = mobLine ? { state: /demo|trial|evaluation/i.test(mobLine.line) ? 'demo' as const : 'licensed' as const, evidence: `[${mobLine.sec}] ${mobLine.line}` }
    : mobOpt.length ? { state: mobOpt.some((o) => /demo|trial|evaluation/i.test(o.name)) ? 'demo' as const : 'licensed' as const, evidence: `[Options] ${mobOpt.map((o) => `(${o.code}) ${o.name}`).join(', ')}` }
    : options0().length ? { state: 'none' as const, evidence: 'No mobile access option in the licensed options' } : null;
  // ---- locks, guest cards, firmware
  const locksInReport = all.map(({ line }) => kv(line)).filter((p): p is { k: string; v: string } => Boolean(p && /\b(locks?|doors?|rooms?|encoders?|gateways?|online|offline)\b/i.test(p.k) && /^\d[\d\s.,]*$/.test(p.v)))
    .slice(0, 20).map((p) => ({ label: p.k, value: p.v }));
  const guestCards = sections.filter((x) => /guest/i.test(x.name)).flatMap((x) => x.lines.map(kv).filter(Boolean) as { k: string; v: string }[]).slice(0, 12).map((p) => ({ label: p.k, value: p.v }));
  const fwKey = Object.keys(s.facts ?? {}).find((k) => /firmware/i.test(k));
  const options = options0();
  const evTotal = (s.events ?? []).reduce((n, g) => n + g.items.length, 0);
  const evOn = (s.events ?? []).reduce((n, g) => n + g.items.filter((i) => i.on).length, 0);
  const pmsLine = all.map(({ line }) => kv(line)).find((p) => p && /\bpms\b/i.test(p.k) && /encrypt|key/i.test(p.k));
  return {
    version, versionFrom, aes, encryption, pmsEncryptionKey: pmsLine ? pmsLine.v : null, keyMode, knownAuth, clients, ev1, pms, pmsOptions, mobileLicence,
    systemCode: s.facts?.['System code'] ?? null, systemId: s.facts?.['System ID'] ?? null, firmwarePack: fwKey ? s.facts[fwKey]! : null,
    locksInReport, options, mobileAccess: options.length ? options.some((o) => /mobile/i.test(o.name)) : null, guestCards, eventsOn: evOn, eventsTotal: evTotal,
  };
}
