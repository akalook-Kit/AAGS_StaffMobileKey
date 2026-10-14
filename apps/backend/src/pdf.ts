import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { pool, one } from './db.ts';
import { getConfig } from './hotel-config.ts';
import { PLATFORM_VERSION } from './version.ts';

/**
 * Server-made PDF reports (2.6). Every page carries the hotel logo, hotel name, the report title, the hotel's system
 * number and the platform version at the top, and the report ID, printing time, page number and the hotel's footer
 * line at the bottom. Each PDF is recorded with the SHA-256 of its exact bytes (report_prints), so a copy can be
 * checked later: Event log -> Verify a PDF. The PDF is tamper-evident (any change shows), not tamper-proof.
 */
export interface Column { label: string; width: number; align?: 'left' | 'right' }
export type Tone = 'error' | 'warning' | 'ok' | null;
export interface ReportSpec {
  hotelId: string; report: string; title: string; subtitle?: string;
  /** Lines describing the selection (period, filters), printed on page 1. */
  selection: string[];
  /** Small key figures printed on page 1, e.g. [["Entrances", "120"]]. */
  summary?: [string, string][];
  columns: Column[]; rows: string[][]; tones?: Tone[];
  note?: string | null;
  operatorId: string | null; operatorName: string;
  filters?: Record<string, unknown>;
}

const LOGO_PT = { small: 24, medium: 34, large: 46 } as const; // CSS 32/46/62 px at 0.75 pt/px
const A4L = { w: 841.89, h: 595.28 };
const M = 32;
const INK = rgb(0.11, 0.11, 0.12), MUTED = rgb(0.38, 0.38, 0.4), LINE = rgb(0.82, 0.82, 0.84), ZEBRA = rgb(0.965, 0.965, 0.97);
const TONE = { error: rgb(0.70, 0.15, 0.11), warning: rgb(0.78, 0.50, 0.0), ok: rgb(0.09, 0.45, 0.30) };

export async function hotelHeader(hotelId: string) {
  const [branding, property, cs, hotel] = await Promise.all([
    getConfig(pool, hotelId, 'branding'), getConfig(pool, hotelId, 'property'), getConfig(pool, hotelId, 'credential_services'),
    one(pool, 'SELECT name, slug, timezone FROM hotels WHERE id=$1', [hotelId]),
  ]);
  const systemNumber = property?.systemNumber?.trim() || (cs?.systemId ? String(cs.systemId) : null);
  return {
    name: (property?.displayName ?? hotel?.name ?? 'Hotel') as string, legalName: (property?.legalName ?? null) as string | null,
    city: property?.city ?? null, country: property?.country ?? null, timezone: (property?.timezone ?? hotel?.timezone ?? 'UTC') as string,
    systemNumber, version: PLATFORM_VERSION, logo: (branding?.logo ?? null) as string | null,
    logoSize: (branding?.logoSize?.reports ?? 'medium') as keyof typeof LOGO_PT, footer: (property?.reportFooter ?? null) as string | null,
  };
}

/** Standard PDF fonts only know Windows-1252 characters; anything else is shown as "?" instead of failing. */
const charsets = new WeakMap<PDFFont, Set<number>>();
/** Latin letters that do not decompose into a base letter + accent. */
const LATIN_EXTRA: Record<string, string> = { 'Đ': 'D', 'đ': 'd', 'Ł': 'L', 'ł': 'l', 'Ħ': 'H', 'ħ': 'h', 'ı': 'i', 'Ŋ': 'N', 'ŋ': 'n', 'Ɛ': 'E', 'ɛ': 'e', 'Ɔ': 'O', 'ɔ': 'o', 'Ɓ': 'B', 'ɓ': 'b', 'Ɗ': 'D', 'ɗ': 'd', 'ƙ': 'k', 'ƴ': 'y' };
function safe(font: PDFFont, text: string) {
  let set = charsets.get(font);
  if (!set) { set = new Set(font.getCharacterSet()); charsets.set(font, set); }
  let out = '';
  for (const ch of text.replace(/[\r\n\t]+/g, ' ')) {
    if (set.has(ch.codePointAt(0)!)) { out += ch; continue; }
    const plain = LATIN_EXTRA[ch] ?? ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); // e.g. letters with accents the font lacks
    out += plain && [...plain].every((c) => set!.has(c.codePointAt(0)!)) ? plain : '?';
  }
  return out;
}
function wrap(font: PDFFont, text: string, size: number, width: number, maxLines: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  const fits = (t: string) => font.widthOfTextAtSize(t, size) <= width;
  for (let w of words) {
    while (!fits(w)) { // a single word longer than the column: cut it
      let i = w.length; while (i > 1 && !fits(w.slice(0, i))) i--;
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(w.slice(0, i)); w = w.slice(i);
    }
    const next = cur ? `${cur} ${w}` : w;
    if (fits(next)) cur = next; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1]!;
    while (last && !fits(`${last}…`)) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }
  return lines.length ? lines : [''];
}

async function embedLogo(doc: PDFDocument, dataUrl: string | null): Promise<PDFImage | null> {
  if (!dataUrl) return null;
  const m = /^data:image\/(png|jpeg|jpg);base64,(.+)$/.exec(dataUrl);
  if (!m) return null; // WebP cannot be placed in a PDF; the hotel name is printed instead
  const bytes = Buffer.from(m[2]!, 'base64');
  try { return m[1] === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes); } catch { return null; }
}

export async function buildReportPdf(spec: ReportSpec) {
  const h = await hotelHeader(spec.hotelId);
  const reportId = randomUUID();
  const printedAt = new Date();
  const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: h.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(printedAt);
  const doc = await PDFDocument.create();
  doc.setTitle(`${spec.title} - ${h.name}`);
  doc.setAuthor(h.name);
  doc.setSubject(`Report ${reportId}`);
  doc.setCreator(`Staff Mobile Key ${h.version}`);
  doc.setProducer(`Staff Mobile Key ${h.version}`);
  doc.setCreationDate(printedAt); doc.setModificationDate(printedAt);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await embedLogo(doc, h.logo);
  const S = (t: string | null | undefined, f: PDFFont = font) => safe(f, t ?? '');

  const pages: PDFPage[] = [];
  const headerBottom = A4L.h - M - Math.max(LOGO_PT[h.logoSize], 30) - 10;
  const footerTop = M + 22;
  const newPage = () => {
    const p = doc.addPage([A4L.w, A4L.h]);
    pages.push(p);
    // ---- header (every page) ----
    let x = M;
    const top = A4L.h - M;
    if (logo) {
      const hgt = LOGO_PT[h.logoSize];
      const wdt = Math.min(logo.width * (hgt / logo.height), 200);
      const real = wdt / logo.width * logo.height;
      p.drawImage(logo, { x, y: top - real, width: wdt, height: real });
      x += wdt + 14;
    }
    p.drawText(S(h.name, bold), { x, y: top - 13, size: 13, font: bold, color: INK });
    const sub = [h.legalName && h.legalName !== h.name ? h.legalName : null, [h.city, h.country].filter(Boolean).join(', ') || null].filter(Boolean).join(' · ');
    p.drawText(S(spec.title, bold), { x, y: top - 28, size: 10.5, font: bold, color: INK });
    if (sub) p.drawText(S(sub), { x, y: top - 40, size: 8, font, color: MUTED });
    const right = [`System no. ${h.systemNumber ?? 'not set'}`, `Staff Mobile Key ${h.version}`, `Printed ${fmtTime}`];
    right.forEach((t, i) => { const tt = S(t); p.drawText(tt, { x: A4L.w - M - font.widthOfTextAtSize(tt, 8.5), y: top - 10 - i * 12, size: 8.5, font: i === 0 ? bold : font, color: i === 0 ? INK : MUTED }); });
    p.drawLine({ start: { x: M, y: headerBottom }, end: { x: A4L.w - M, y: headerBottom }, thickness: 0.8, color: LINE });
    return p;
  };

  let page = newPage();
  let y = headerBottom - 16;
  if (spec.subtitle) { page.drawText(S(spec.subtitle), { x: M, y, size: 9, font, color: MUTED }); y -= 14; }
  for (const line of spec.selection) {
    for (const l of wrap(font, S(line), 8.5, A4L.w - 2 * M, 3)) { page.drawText(l, { x: M, y, size: 8.5, font, color: INK }); y -= 11; }
  }
  if (spec.summary?.length) {
    y -= 4;
    let x = M;
    for (const [k, v] of spec.summary) {
      const w = Math.max(bold.widthOfTextAtSize(S(v, bold), 14), font.widthOfTextAtSize(S(k), 8)) + 22;
      page.drawRectangle({ x, y: y - 30, width: w, height: 34, borderColor: LINE, borderWidth: 0.8, color: rgb(1, 1, 1) });
      page.drawText(S(v, bold), { x: x + 8, y: y - 14, size: 14, font: bold, color: INK });
      page.drawText(S(k), { x: x + 8, y: y - 26, size: 8, font, color: MUTED });
      x += w + 8;
    }
    y -= 42;
  }
  if (spec.note) { for (const l of wrap(font, S(spec.note), 8, A4L.w - 2 * M, 4)) { page.drawText(l, { x: M, y, size: 8, font, color: MUTED }); y -= 10; } }
  y -= 6;

  // ---- table ----
  const total = spec.columns.reduce((a, c) => a + c.width, 0);
  const tableW = A4L.w - 2 * M;
  const widths = spec.columns.map((c) => (c.width / total) * tableW);
  const SIZE = 7.8, LH = 9.6, PAD = 4;
  const drawHead = () => {
    page.drawRectangle({ x: M, y: y - 16, width: tableW, height: 16, color: rgb(0.93, 0.93, 0.94) });
    let x = M;
    spec.columns.forEach((c, i) => { page.drawText(S(c.label, bold), { x: x + PAD, y: y - 11.5, size: 8, font: bold, color: INK }); x += widths[i]!; });
    y -= 16;
  };
  drawHead();
  if (!spec.rows.length) { page.drawText('No events match this selection.', { x: M + PAD, y: y - 14, size: 9, font, color: MUTED }); y -= 20; }
  spec.rows.forEach((row, ri) => {
    const cells = row.map((v, i) => wrap(font, S(v), SIZE, widths[i]! - 2 * PAD, 3));
    const hgt = Math.max(...cells.map((c) => c.length)) * LH + 5;
    if (y - hgt < footerTop + 6) { page = newPage(); y = headerBottom - 12; drawHead(); }
    if (ri % 2 === 1) page.drawRectangle({ x: M, y: y - hgt, width: tableW, height: hgt, color: ZEBRA });
    const tone = spec.tones?.[ri];
    if (tone) page.drawRectangle({ x: M, y: y - hgt, width: 2.5, height: hgt, color: TONE[tone] });
    let x = M;
    cells.forEach((lines, i) => {
      lines.forEach((l, li) => {
        const right = spec.columns[i]!.align === 'right';
        const tx = right ? x + widths[i]! - PAD - font.widthOfTextAtSize(l, SIZE) : x + PAD;
        page.drawText(l, { x: tx, y: y - 9 - li * LH, size: SIZE, font: i === 1 && tone ? bold : font, color: INK });
      });
      x += widths[i]!;
    });
    y -= hgt;
  });

  // ---- footer (every page, with "page n of N") ----
  const id = `Report ID ${reportId}`;
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: footerTop }, end: { x: A4L.w - M, y: footerTop }, thickness: 0.6, color: LINE });
    const left = S(`${id} · printed by ${spec.operatorName} · verify: portal > Event log > Verify a PDF`);
    p.drawText(left, { x: M, y: footerTop - 11, size: 7, font, color: MUTED });
    if (h.footer) p.drawText(S(h.footer), { x: M, y: footerTop - 20, size: 7, font, color: MUTED });
    const pn = `Page ${i + 1} of ${pages.length}`;
    p.drawText(pn, { x: A4L.w - M - bold.widthOfTextAtSize(pn, 8), y: footerTop - 11, size: 8, font: bold, color: INK });
  });

  const bytes = Buffer.from(await doc.save({ useObjectStreams: true }));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await pool.query(`INSERT INTO report_prints (id, hotel_id, report, title, filters, rows, pages, sha256, bytes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [reportId, spec.hotelId, spec.report, spec.title, spec.filters ?? {}, spec.rows.length, pages.length, sha256, bytes.length, spec.operatorId]);
  return { bytes, reportId, sha256, pages: pages.length, version: h.version };
}
