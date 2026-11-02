import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHotel } from '../App';
import { api } from '../api';

/**
 * 2.12 Search everywhere (Ctrl+K / ⌘K): pages, people, doors and card numbers. People and doors open the access
 * history; a card number opens the card lookup.
 */
export function CommandPalette({ pages }: { pages: { to: string; label: string }[] }) {
  const { base, can } = useHotel();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ people: any[]; doors: any[] }>({ people: [], doors: [] });
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const t = useRef<number | undefined>(undefined);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); } if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => { if (open) { setQ(''); setI(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => {
    window.clearTimeout(t.current);
    if (!can('events.read') || q.trim().length < 2 || /^\d+$/.test(q.trim())) { setRes({ people: [], doors: [] }); return; }
    t.current = window.setTimeout(() => { api<any>(`${base}/access/search?q=${encodeURIComponent(q.trim())}`).then(setRes).catch(() => setRes({ people: [], doors: [] })); }, 180);
  }, [q, base]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = q.trim().toLowerCase();
  const items: { label: string; hint: string; go: () => void }[] = [
    ...(/^\d{3,}$/.test(s) && can('reports.read') ? [{ label: `Card ${s}`, hint: 'Look up this keycard', go: () => nav(`/visionline?tab=lookup&card=${s}`) }] : []),
    ...pages.filter((p) => !s || p.label.toLowerCase().includes(s)).slice(0, s ? 6 : 12).map((p) => ({ label: p.label, hint: 'Page', go: () => nav(p.to) })),
    ...res.people.slice(0, 6).map((p) => ({ label: p.name, hint: `${p.group ?? 'Person'} · access history`, go: () => nav(`/access?${new URLSearchParams(p.holder ? { holder: p.holder } : { name: p.name })}`) })),
    ...res.doors.slice(0, 6).map((d) => ({ label: d.name, hint: 'Door · who went through', go: () => nav(`/access?door=${encodeURIComponent(d.id)}`) })),
  ];
  const pick = (n: number) => { const it = items[n]; if (it) { it.go(); setOpen(false); } };
  return (
    <>
      <button className="rail-search" onClick={() => setOpen(true)} aria-label="Search (Ctrl+K)"><span>Search…</span><kbd>Ctrl K</kbd></button>
      {open && (
        <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="palette" role="dialog" aria-label="Search">
            <input ref={input} value={q} placeholder="Search pages, people, doors or a card number…" onChange={(e) => { setQ(e.target.value); setI(0); }}
              onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(items.length - 1, x + 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); } if (e.key === 'Enter') { e.preventDefault(); pick(i); } }} />
            <ul role="listbox">
              {items.map((it, n) => (
                <li key={`${it.label}-${n}`} role="option" aria-selected={n === i} onMouseEnter={() => setI(n)} onMouseDown={(e) => { e.preventDefault(); pick(n); }}>
                  <span>{it.label}</span><small>{it.hint}</small></li>))}
              {!items.length && <li className="muted" aria-disabled>Nothing found</li>}
            </ul>
            <div className="palette-foot"><span>↑↓ to move · Enter to open · Esc to close</span></div>
          </div>
        </div>
      )}
    </>
  );
}
