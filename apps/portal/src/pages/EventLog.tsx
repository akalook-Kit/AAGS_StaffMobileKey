import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { auth, ApiError } from '../api';
import { useHotel } from '../App';
import { ErrorNote, PageHead, useApi } from '../ui';
import { NoData } from '../components/charts';

/**
 * Event log (2.6): every door and system event in one list, split into All / Entrance / Error events, with a
 * selection (period, event types, door, person or card). It leaves the platform only as a PDF made by the server,
 * with the hotel header on every page and a fingerprint that "Verify a PDF" checks later. No spreadsheet export.
 */
type Cls = 'all' | 'entrances' | 'errors';
const CLASSES: { id: Cls; label: string; hint: string }[] = [
  { id: 'all', label: 'All events', hint: 'Everything below, including card changes and key life cycle' },
  { id: 'entrances', label: 'Entrance events', hint: 'Doors opened with a card or a mobile key' },
  { id: 'errors', label: 'Error events', hint: 'Refused entries, lock alarms, low batteries, failed keys and connector errors' },
];
const PRESETS = [{ id: 'today', l: 'Today' }, { id: '24h', l: 'Last 24 h' }, { id: '7d', l: '7 days' }, { id: '30d', l: '30 days' }] as const;

/** Offset of a time zone from UTC at instant t, in ms. */
function tzOffset(t: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(t / 1000) * 1000;
}
/** "2026-10-14T08:00" in the hotel's time zone -> instant. */
function fromHotelLocal(v: string, tz: string) {
  const [d, t = '00:00'] = v.split('T');
  const [y, m, day] = d!.split('-').map(Number); const [hh, mm] = t.split(':').map(Number);
  const guess = Date.UTC(y!, m! - 1, day!, hh!, mm!);
  let at = guess - tzOffset(guess, tz);
  at = guess - tzOffset(at, tz);
  return new Date(at);
}
/** Instant -> "2026-10-14T08:00" in the hotel's time zone. */
function toHotelLocal(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

async function sha256Hex(buf: ArrayBuffer) {
  if (!window.crypto?.subtle) throw new ApiError(0, 'INSECURE_CONTEXT', 'Open the portal through https:// (or localhost) to check a PDF.');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function EventLogPage() {
  const { base, hotel } = useHotel();
  const [sp, setSp] = useSearchParams();
  const cls = (sp.get('cls') ?? 'all') as Cls;
  const preset = sp.get('p') ?? (sp.get('from') ? '' : '24h');
  const cats = sp.get('types')?.split(',').filter(Boolean) ?? [];
  const door = sp.get('door') ?? '';
  const [q, setQ] = useState(sp.get('q') ?? '');
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); } setSp(n, { replace: true }); };

  // The hotel's time zone comes with the first answer; until then the browser's is used.
  const [tz, setTz] = useState<string>(Intl.DateTimeFormat().resolvedOptions().timeZone);
  // Presets move with the clock: refresh the window every 30 seconds.
  const [tick, setTick] = useState(0);
  useEffect(() => { if (!preset) return; const t = setInterval(() => setTick((n) => n + 1), 30_000); return () => clearInterval(t); }, [preset]);
  const range = useMemo(() => {
    const now = new Date();
    if (preset === 'today') { const start = fromHotelLocal(`${toHotelLocal(now, tz).slice(0, 10)}T00:00`, tz); return { from: start, to: now }; }
    if (preset === '7d') return { from: new Date(now.getTime() - 7 * 86400_000), to: now };
    if (preset === '30d') return { from: new Date(now.getTime() - 30 * 86400_000), to: now };
    if (preset === '24h' || !sp.get('from')) return { from: new Date(now.getTime() - 86400_000), to: now };
    return { from: fromHotelLocal(sp.get('from')!, tz), to: sp.get('to') ? fromHotelLocal(sp.get('to')!, tz) : now };
  }, [preset, sp, tz, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const filter = { from: range.from.toISOString(), to: range.to.toISOString(), cls, ...(cats.length ? { categories: cats.join(',') } : {}), ...(door ? { door } : {}), ...(sp.get('q') ? { q: sp.get('q')! } : {}) };
  const qs = new URLSearchParams(filter).toString();
  const r = useApi<any>(`${base}/events?${qs}&limit=500`, [qs]);
  const data = r.data;
  useEffect(() => { if (data?.tz && data.tz !== tz) setTz(data.tz); }, [data?.tz, tz]);
  const timeFmt = new Intl.DateTimeFormat(undefined, { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const shortFmt = (v: string) => new Intl.DateTimeFormat(undefined, { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(v));
  const pagesLabel = (n: number) => `${n} page${n === 1 ? '' : 's'}`;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [printed, setPrinted] = useState<string | null>(null);
  const printPdf = async () => {
    setBusy(true); setError(null); setPrinted(null);
    try {
      const body = { ...filter, categories: cats.length ? cats : undefined };
      const res = await fetch(`${base}/events/pdf`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` }, body: JSON.stringify(body) });
      if (!res.ok) { const j = await res.json().catch(() => null); throw new ApiError(res.status, j?.error?.code ?? 'ERROR', j?.error?.message ?? 'Printing failed'); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const name = `${hotel.slug}-event-log-${cls}-${new Date().toISOString().slice(0, 10)}.pdf`;
      Object.assign(document.createElement('a'), { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setPrinted(`PDF ready (${name}). Report ID ${res.headers.get('x-report-id')}.`);
      void prints.reload();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const [verify, setVerify] = useState<any>(null);
  const checkPdf = async (file: File | undefined) => {
    setVerify(null); setError(null);
    if (!file) return;
    try {
      const sha256 = await sha256Hex(await file.arrayBuffer());
      const res = await fetch(`${base}/reports/verify`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` }, body: JSON.stringify({ sha256 }) });
      const j = await res.json();
      if (!res.ok) throw new ApiError(res.status, j?.error?.code ?? 'ERROR', j?.error?.message ?? 'Check failed');
      setVerify({ ...j, file: file.name });
    } catch (e) { setError(e); }
  };
  const prints = useApi<any[]>(`${base}/reports/prints`);
  const toggleCat = (c: string) => { const n = cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c]; set({ types: n.join(',') || null }); };
  const counts = data?.counts ?? { all: 0, entrances: 0, errors: 0 };

  return (
    <>
      <PageHead title="Event log" intro={<>Door entrances, refused entries, lock alarms, batteries, keys and system errors. Times are hotel time ({tz}). The log can only be printed as a PDF made by the platform; every PDF can be checked later with <b>Verify a PDF</b>.</>}>
        <button className="btn primary" onClick={printPdf} disabled={busy || !data}>{busy ? 'Making the PDF…' : 'Print PDF'}</button>
      </PageHead>
      <ErrorNote error={error ?? r.error} />
      {printed && <div className="alert ok">{printed}</div>}

      <div className="ev-classes" role="group" aria-label="Event class">
        {CLASSES.map((c) => (
          <button key={c.id} className={`ev-class ${c.id}`} aria-pressed={cls === c.id} onClick={() => set({ cls: c.id === 'all' ? null : c.id })} title={c.hint}>
            <strong>{Number(counts[c.id]).toLocaleString()}</strong><span>{c.label}</span>
          </button>
        ))}
      </div>

      <div className="ev-sel" role="group" aria-label="Selection">
        <div className="seg" role="group" aria-label="Period">
          {PRESETS.map((p) => <button key={p.id} aria-pressed={preset === p.id} onClick={() => set({ p: p.id, from: null, to: null })}>{p.l}</button>)}
        </div>
        <label className="slicer"><span>From</span><input type="datetime-local" value={toHotelLocal(range.from, tz)} onChange={(e) => e.target.value && set({ p: null, from: e.target.value, to: sp.get('to') ?? toHotelLocal(range.to, tz) })} /></label>
        <label className="slicer"><span>To</span><input type="datetime-local" value={toHotelLocal(range.to, tz)} onChange={(e) => e.target.value && set({ p: null, to: e.target.value, from: sp.get('from') ?? toHotelLocal(range.from, tz) })} /></label>
        <label className="slicer"><span>Door</span>
          <select value={door} onChange={(e) => set({ door: e.target.value || null })}><option value="">All doors</option>{(data?.doors ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <form className="slicer" onSubmit={(e) => { e.preventDefault(); set({ q: q.trim() || null }); }}><span>Person, card or text</span>
          <input type="search" value={q} placeholder="e.g. Amina, 135800" onChange={(e) => setQ(e.target.value)} onBlur={() => set({ q: q.trim() || null })} /></form>
        <div className="slicer" style={{ flexBasis: '100%' }}><span>Event types {cats.length ? `(${cats.length} selected)` : '(all)'}</span>
          <div className="ev-types">
            {(data?.categories ?? []).map((c: any) => (
              <button key={c.id} className="chip" aria-pressed={cats.includes(c.id)} onClick={() => toggleCat(c.id)}>{c.label}{data?.byCategory?.[c.id] ? ` · ${data.byCategory[c.id]}` : ''}</button>
            ))}
            {cats.length > 0 && <button className="btn small ghost" onClick={() => set({ types: null })}>All types</button>}
          </div>
        </div>
      </div>

      <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="grid ev-table">
          <thead><tr><th>Time</th><th>Type</th><th>Event</th><th>Door</th><th>Person / card</th><th>Source</th><th>Details</th></tr></thead>
          <tbody>
            {(data?.events ?? []).map((e: any) => (
              <tr key={e.id} className={`${e.severity}${e.watched && e.category === 'entrance' ? ' vip-row' : ''}`}>
                <td className="t">{timeFmt.format(new Date(e.at))}</td>
                <td><span className={`ev-tag ${e.severity !== 'info' ? e.severity : e.category === 'entrance' ? 'entrance' : ''}`}>{data.categories.find((c: any) => c.id === e.category)?.label}{e.severity !== 'info' && <b>· {e.severity === 'error' ? 'Error' : 'Warning'}</b>}</span></td>
                <td>{e.event}</td><td>{e.door ?? '—'}{e.watched && <span className="vip-tag" title={`Watched door: ${e.watched}`}>★ {e.watched}</span>}</td>
                <td>{e.person ?? ''}{e.person && e.card ? ' · ' : ''}{e.card ? <span className="mono">{e.card}</span> : (!e.person ? '—' : '')}</td>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{e.source}</td><td className="muted small">{e.detail ?? ''}</td>
              </tr>
            ))}
            {data && !data.events.length && <tr><td colSpan={7}><NoData text="No events match this selection for now" hint="New events appear by themselves (refreshed every 30 seconds)." /></td></tr>}
          </tbody>
        </table>
      </div>
      {data?.truncated && <p className="small muted">Showing the newest {data.events.length} of {data.total}. The PDF holds up to 5,000; narrow the period or the selection for more.</p>}

      <div className="split" style={{ marginTop: 16 }}>
        <div className="panel">
          <h2>Verify a PDF</h2>
          <p className="small muted">Choose a PDF printed from this platform. Your browser computes its fingerprint (SHA-256) and the platform checks it against the PDFs it printed. Any change to the file, even one character, makes the check fail. The file itself is not uploaded.</p>
          <input type="file" accept="application/pdf" onChange={(e) => void checkPdf(e.target.files?.[0])} aria-label="PDF to verify" />
          {verify && (verify.genuine
            ? <div className="alert ok verify-result"><b>Genuine and unchanged.</b> {verify.report.title}, printed {shortFmt(verify.report.printedAt)} by {verify.report.printedBy ?? 'unknown'} · {verify.report.rows} rows on {pagesLabel(verify.report.pages)} · report ID <span className="mono">{verify.report.id}</span></div>
            : <div className="alert bad verify-result"><b>Not confirmed.</b> {verify.file} was not printed by this platform for {hotel.name}, or it has been changed since.</div>)}
        </div>
        <div className="panel">
          <h2>Recently printed</h2>
          <table className="grid small"><tbody>
            {(prints.data ?? []).slice(0, 8).map((p: any) => <tr key={p.id}><td>{p.title}</td><td className="muted">{shortFmt(p.created_at)} · {p.printed_by ?? '—'}</td><td className="muted" style={{ whiteSpace: 'nowrap' }}>{p.rows} rows · {pagesLabel(p.pages)}</td></tr>)}
            {prints.data && !prints.data.length && <tr><td className="muted">Nothing printed yet.</td></tr>}
          </tbody></table>
        </div>
      </div>
    </>
  );
}
