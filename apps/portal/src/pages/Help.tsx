import { Fragment, useMemo, useState, type ReactNode } from 'react';
import manual from '../../../../docs/USER-MANUAL.md?raw';
import quick from '../../../../docs/QUICK-START.md?raw';
import { PageHead } from '../ui';

/** Inline markdown: **bold**, *italic*, `code`. Text only: nothing in the manual is turned into HTML. */
function inline(t: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(t))) {
    if (m.index > last) out.push(t.slice(last, m.index));
    const x = m[0];
    out.push(x.startsWith('**') ? <strong key={i++}>{x.slice(2, -2)}</strong> : x.startsWith('`') ? <code key={i++}>{x.slice(1, -1)}</code> : <em key={i++}>{x.slice(1, -1)}</em>);
    last = m.index + x.length;
  }
  if (last < t.length) out.push(t.slice(last));
  return out;
}

type Block = { kind: 'h1' | 'h2' | 'p' | 'ul' | 'ol' | 'table' | 'pre'; lines: string[] };
function blocks(md: string): Block[] {
  const out: Block[] = [];
  let cur = null as Block | null;
  const push = (k: Block['kind'], l: string) => { if (!cur || cur.kind !== k) { cur = { kind: k, lines: [] }; out.push(cur); } cur.lines.push(l); };
  for (const raw of md.split(/\r?\n/)) {
    const l = raw.trimEnd();
    if (!l.trim()) { cur = null; continue; }
    if (l.startsWith('# ')) { out.push({ kind: 'h1', lines: [l.slice(2)] }); cur = null; }
    else if (l.startsWith('## ')) { out.push({ kind: 'h2', lines: [l.slice(3)] }); cur = null; }
    else if (/^\s*- /.test(l)) push('ul', l);
    else if (/^\d+\. /.test(l)) push('ol', l.replace(/^\d+\. /, ''));
    else if (l.startsWith('|')) push('table', l);
    else if (l.startsWith('    ')) push('pre', l.slice(4));
    else if (cur && (cur.kind === 'ul' || cur.kind === 'ol')) cur.lines[cur.lines.length - 1] += ` ${l.trim()}`;
    else push('p', l);
  }
  return out;
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** 2.13 The user manual, in the portal and printable (Print → Save as PDF). */
export function HelpPage() {
  // 2.16 The short quick start first; the full manual one click away.
  const [which, setWhich] = useState<'quick' | 'manual'>(() => (new URLSearchParams(location.search).get('doc') === 'manual' ? 'manual' : 'quick'));
  const bs = useMemo(() => blocks(which === 'quick' ? quick : manual), [which]);
  const [q, setQ] = useState('');
  const toc = bs.filter((b) => b.kind === 'h2').map((b) => b.lines[0]!);
  // Search: keep the sections whose text matches.
  const sections = useMemo(() => {
    const s: { title: string | null; items: Block[] }[] = [{ title: null, items: [] }];
    for (const b of bs) { if (b.kind === 'h2') s.push({ title: b.lines[0]!, items: [b] }); else if (b.kind !== 'h1') s[s.length - 1]!.items.push(b); }
    const t = q.trim().toLowerCase();
    return t ? s.filter((x) => x.items.some((b) => b.lines.join(' ').toLowerCase().includes(t))) : s;
  }, [bs, q]);
  return (
    <>
      <PageHead title="Help and manual" intro="Start with the quick start; the full manual explains every page. Print either (Save as PDF) for the team.">
        <div className="seg" role="group" aria-label="Document"><button aria-pressed={which === 'quick'} onClick={() => setWhich('quick')}>Quick start</button><button aria-pressed={which === 'manual'} onClick={() => setWhich('manual')}>Full manual</button></div>
        <input className="search" placeholder="Search the manual" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the manual" />
        <button className="btn" onClick={() => window.print()}>Print / PDF</button>
      </PageHead>
      <div className="help-layout">
        <nav className="help-toc no-print" aria-label="Contents">{toc.map((t) => <a key={t} href={`#${slug(t)}`}>{t}</a>)}</nav>
        <article className="panel help">
          {sections.map((s, si) => <Fragment key={si}>{s.items.map((b, i) => <Render key={i} b={b} />)}</Fragment>)}
          {!sections.length && <p className="empty">Nothing in the manual matches “{q}”.</p>}
        </article>
      </div>
    </>
  );
}

function Render({ b }: { b: Block }) {
  switch (b.kind) {
    case 'h2': return <h2 id={slug(b.lines[0]!)}>{b.lines[0]}</h2>;
    case 'ul': return <ul>{b.lines.map((l, i) => <li key={i} style={{ marginLeft: (l.match(/^\s*/)?.[0].length ?? 0) * 6 }}>{inline(l.replace(/^\s*- /, ''))}</li>)}</ul>;
    case 'ol': return <ol>{b.lines.map((l, i) => <li key={i}>{inline(l)}</li>)}</ol>;
    case 'pre': return <pre>{b.lines.join('\n')}</pre>;
    case 'table': {
      const rows = b.lines.filter((l) => !/^\|[\s|:-]+\|$/.test(l)).map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      return <table className="grid"><thead><tr>{rows[0]!.map((c, i) => <th key={i}>{inline(c)}</th>)}</tr></thead><tbody>{rows.slice(1).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody></table>;
    }
    default: return <p>{inline(b.lines.join(' '))}</p>;
  }
}
