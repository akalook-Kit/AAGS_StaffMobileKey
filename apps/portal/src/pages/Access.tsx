import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useHotel } from '../App';
import { api } from '../api';
import { ErrorNote, PageHead, fmt, useApi } from '../ui';
import { Columns, HBars, Kpi, NoData, SERIES, VizCard, DataTable } from '../components/charts';

/** 2.12 Access history: which doors a person opened, and who went through a door. */
const PERIODS = [{ d: 1, l: '24 hours' }, { d: 7, l: '7 days' }, { d: 30, l: '30 days' }, { d: 90, l: '90 days' }];
const EV_SERIES = [{ name: 'Entrances', color: SERIES[0] }, { name: 'Refused', color: 'var(--st-crit)' }];

export function AccessPage() {
  const { base } = useHotel();
  const [sp, setSp] = useSearchParams();
  const days = Number(sp.get('days') ?? 30);
  const holder = sp.get('holder'), name = sp.get('name'), door = sp.get('door');
  const set = (p: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(p)) v === null ? n.delete(k) : n.set(k, v); setSp(n, { replace: true }); };
  const subject = holder || name || door;
  const qs = new URLSearchParams({ days: String(days), ...(holder ? { holder } : {}), ...(name && !holder ? { name } : {}), ...(door ? { door } : {}) });
  const r = useApi<any>(subject ? `${base}/access?${qs}` : null, [qs.toString()], 60_000);
  const x = subject ? r.data : null;
  return (
    <>
      <PageHead title="Access history" intro="Which doors a person opened or was refused at, and who went through a door. From the lock events Visionline reports (offline locks report when they reconnect)." />
      <div className="access-bar">
        <Finder onPick={(p) => set({ holder: p.holder ?? null, name: p.holder ? null : p.name ?? null, door: p.door ?? null })} />
        <div className="seg" role="group" aria-label="Period">
          {PERIODS.map((p) => <button key={p.d} aria-pressed={days === p.d} onClick={() => set({ days: String(p.d) })}>{p.l}</button>)}
        </div>
      </div>
      <ErrorNote error={subject ? r.error : null} />
      {!subject && <Suggestions onPick={(p) => set(p)} />}
      {subject && !x && !r.error && <div className="panel"><p className="muted">Loading…</p></div>}
      {x?.person && <PersonView x={x} onDoor={(d) => set({ door: d, holder: null, name: null })} />}
      {x?.door && <DoorView x={x} onPerson={(p) => set({ holder: p.holder ?? null, name: p.holder ? null : p.person, door: null })} />}
    </>
  );
}

function Finder({ onPick }: { onPick: (p: { holder?: string; name?: string; door?: string }) => void }) {
  const { base } = useHotel();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const t = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(t.current);
    if (q.trim().length < 2) { setRes(null); return; }
    t.current = window.setTimeout(async () => { try { setRes(await api(`${base}/access/search?q=${encodeURIComponent(q.trim())}`)); setOpen(true); } catch { setRes(null); } }, 200);
  }, [q, base]);
  const pick = (p: any) => { onPick(p); setOpen(false); setQ(''); };
  return (
    <div className="finder" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <input className="search" type="search" placeholder="Search a person or a door…" value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => res && setOpen(true)} aria-label="Search a person or a door" />
      {open && res && (
        <div className="finder-pop" role="listbox">
          {!res.people.length && !res.doors.length && <div className="muted small" style={{ padding: 10 }}>Nothing found for “{q}”.</div>}
          {res.people.length > 0 && <div className="finder-h">People</div>}
          {res.people.map((p: any, i: number) => <button key={`p${i}`} role="option" aria-selected={false} onClick={() => pick({ holder: p.holder, name: p.name })}><b>{p.name}</b><span>{p.group ?? ''}</span></button>)}
          {res.doors.length > 0 && <div className="finder-h">Doors</div>}
          {res.doors.map((d: any) => <button key={d.id} role="option" aria-selected={false} onClick={() => pick({ door: d.id })}><b>{d.name}</b><span>Door</span></button>)}
        </div>
      )}
    </div>
  );
}

/** Before a choice: the busiest people and doors of the last day, one click away. */
function Suggestions({ onPick }: { onPick: (p: Record<string, string | null>) => void }) {
  const { base } = useHotel();
  const since = useState(() => new Date(Date.now() - 7 * 86400_000).toISOString())[0];
  const ev = useApi<any>(`${base}/events?from=${since}&to=${new Date().toISOString()}&categories=entrance,refused&limit=2000`);
  const events: any[] = ev.data?.events ?? [];
  const people = new Map<string, { label: string; holder: string | null; n: number }>();
  const doors = new Map<string, { label: string; n: number }>();
  for (const e of events) {
    const k = e.person ?? e.match?.holderId; if (k) { const p = people.get(k) ?? { label: k, holder: e.match?.holderId ?? null, n: 0 }; p.n++; if (!p.holder && e.match?.holderId) p.holder = e.match.holderId; people.set(k, p); }
    if (e.doorId) { const d = doors.get(e.doorId) ?? { label: e.door, n: 0 }; d.n++; doors.set(e.doorId, d); }
  }
  const topP = [...people.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  const topD = [...doors.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  return (
    <div className="grid12">
      <VizCard span={6} title="Most active people · 7 days" sub="Click a name to see the doors they used."
        chart={<HBars rows={topP.map(([k, p]) => ({ key: k, label: p.label, values: [p.n] }))} series={[{ name: 'Door events', color: SERIES[0] }]} onSelect={(r) => { const p = people.get(r.key)!; onPick({ holder: p.holder, name: p.holder ? null : p.label, door: null }); }} empty="No door events in the last 7 days yet" />} />
      <VizCard span={6} title="Busiest doors · 7 days" sub="Click a door to see who went through."
        chart={<HBars rows={topD.map(([k, d]) => ({ key: k, label: d.label, values: [d.n] }))} series={[{ name: 'Door events', color: SERIES[1] }]} onSelect={(r) => onPick({ door: r.key, holder: null, name: null })} empty="No door events in the last 7 days yet" />} />
    </div>
  );
}

const when = (v: string | null) => (v ? `${fmt.dt(v)} (${fmt.rel(v)})` : 'never in this period');
const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function PersonView({ x, onDoor }: { x: any; onDoor: (d: string) => void }) {
  return (
    <>
      <div className="profile panel">
        <div className="avatar" aria-hidden>{x.person.name.split(/\s+/).map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}</div>
        <div className="profile-main">
          <h2 style={{ margin: 0 }}>{x.person.name}</h2>
          <div className="muted small">{[x.person.group, x.person.jobTitle, x.person.holder ? `Visionline user ${x.person.holder}` : null].filter(Boolean).join(' · ')}</div>
          <div className="badges" style={{ marginTop: 8 }}>
            {x.cards.filter((c: any) => c.valid).map((c: any) => (
              <span key={c.regNo} className="badge ok" title={`Valid until ${fmt.dt(c.expiresAt)} · issued by ${c.issuedBy ?? 'unknown'}`}>{c.mobileKey ? 'Mobile key' : 'Keycard'} {c.regNo}{c.deadbolt ? ' · deadbolt override' : ''}</span>))}
            {!x.cards.some((c: any) => c.valid) && <span className="badge">No valid keycard known</span>}
          </div>
        </div>
      </div>
      <div className="kpis">
        <Kpi label="Entrances" value={String(x.totals.entrances)} sub={`last ${x.days} days`} />
        <Kpi label="Refused" value={String(x.totals.refused)} tone={x.totals.refused > 0 ? 'warn' : undefined} sub="wrong door or no access" />
        <Kpi label="Doors used" value={String(x.totals.doors)} />
        <Kpi label="Last seen at a door" value={x.totals.last ? fmt.rel(x.totals.last) : '—'} sub={x.totals.last ? fmt.dt(x.totals.last) : 'nothing in this period'} />
      </div>
      <div className="grid12">
        <VizCard span={7} title="By day" chart={<Columns points={x.byDay.map((d: any) => ({ key: d.day, values: [d.entrances, d.refused] }))} series={EV_SERIES} label={shortDay} />}
          table={<DataTable head={['Day', 'Entrances', 'Refused']} numeric={[1, 2]} rows={x.byDay.map((d: any) => [d.day, d.entrances, d.refused])} />} />
        <VizCard span={5} title="Doors" sub="Click a door to see who else went through."
          chart={<HBars rows={x.doors.slice(0, 12).map((d: any) => ({ key: d.doorId ?? d.door, label: d.door, values: [d.entrances, d.refused] }))} series={EV_SERIES} onSelect={(r) => onDoor(r.key)} />}
          table={<DataTable head={['Door', 'Entrances', 'Refused', 'Last']} numeric={[1, 2]} rows={x.doors.map((d: any) => [d.door, d.entrances, d.refused, fmt.dt(d.last)])} />} />
      </div>
      <Timeline events={x.events} who={false} />
      {x.cards.length > 0 && (
        <div className="panel flush" style={{ marginTop: 14 }}>
          <h2 style={{ padding: '14px 16px 0' }}>Keycards and mobile keys</h2>
          <table className="grid"><thead><tr><th>Card</th><th>Kind</th><th>Valid until</th><th className="num">Doors</th><th>Deadbolt override</th><th>Issued by</th><th>State</th></tr></thead>
            <tbody>{x.cards.map((c: any) => <tr key={c.regNo}><td className="mono">{c.regNo}</td><td>{c.mobileKey ? 'Mobile key' : 'Keycard'}</td><td>{fmt.dt(c.expiresAt)}</td><td className="num">{c.doors || '—'}</td>
              <td>{c.deadbolt === null ? <span className="muted">not reported</span> : c.deadbolt ? 'Yes' : 'No'}</td><td>{c.issuedBy ?? '—'}</td><td>{c.valid ? <span className="pill ok">Valid</span> : <span className="pill">Ended</span>}</td></tr>)}</tbody></table>
        </div>
      )}
    </>
  );
}

function DoorView({ x, onPerson }: { x: any; onPerson: (p: any) => void }) {
  return (
    <>
      <div className="profile panel">
        <div className="avatar door-av" aria-hidden>🚪</div>
        <div className="profile-main"><h2 style={{ margin: 0 }}>{x.door.name}</h2><div className="muted small">Door{x.door.floor != null ? ` · floor ${x.door.floor}` : ''} · last {x.days} days</div></div>
        <Link className="btn" to={`/events?door=${encodeURIComponent(x.door.id)}`}>Open in Event log</Link>
      </div>
      <div className="kpis">
        <Kpi label="Entrances" value={String(x.totals.entrances)} />
        <Kpi label="Refused" value={String(x.totals.refused)} tone={x.totals.refused > 0 ? 'warn' : undefined} />
        <Kpi label="Different people" value={String(x.people.length)} />
        <Kpi label="Last used" value={x.totals.last ? fmt.rel(x.totals.last) : '—'} sub={x.totals.last ? fmt.dt(x.totals.last) : 'nothing in this period'} />
      </div>
      <div className="grid12">
        <VizCard span={7} title="By day" chart={<Columns points={x.byDay.map((d: any) => ({ key: d.day, values: [d.entrances, d.refused] }))} series={EV_SERIES} label={shortDay} />}
          table={<DataTable head={['Day', 'Entrances', 'Refused']} numeric={[1, 2]} rows={x.byDay.map((d: any) => [d.day, d.entrances, d.refused])} />} />
        <div className="vizcard span-5">
          <header><div><h2>People</h2><p>Click a name for everything they opened.</p></div></header>
          {!x.people.length ? <NoData text="Nobody in this period" /> : (
            <div className="viz-table-wrap"><table className="grid viz-table"><thead><tr><th>Person</th><th className="num">In</th><th className="num">Refused</th><th>Last</th></tr></thead>
              <tbody>{x.people.map((p: any, i: number) => <tr key={i} className="clickable" onClick={() => onPerson(p)}><td>{p.person ?? <span className="muted">Unknown holder</span>}</td><td className="num">{p.entrances}</td><td className="num">{p.refused}</td><td className="nowrap">{fmt.rel(p.last)}</td></tr>)}</tbody></table></div>)}
        </div>
      </div>
      <Timeline events={x.events} who />
    </>
  );
}

function Timeline({ events, who }: { events: any[]; who: boolean }) {
  const [shown, setShown] = useState(60);
  if (!events.length) return <div className="panel" style={{ marginTop: 14 }}><NoData text="No door events in this period" hint="Entrances and refused entries appear here as the locks report them." /></div>;
  const days = new Map<string, any[]>();
  for (const e of events.slice(0, shown)) { const d = new Date(e.at).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); days.set(d, [...(days.get(d) ?? []), e]); }
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <h2>Timeline</h2>
      {[...days.entries()].map(([d, list]) => (
        <div key={d} className="tl-day">
          <h3>{d}</h3>
          <ul className="tl">
            {list.map((e) => (
              <li key={e.id} className={e.category}>
                <time>{new Date(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>
                <span className="tl-what">{e.category === 'entrance' ? 'Entered' : 'Refused at'} <b>{e.door ?? 'a door'}</b>{who && <> · {e.person ?? <span className="muted">unknown holder</span>}</>}</span>
                <span className="tl-meta">{e.card ? `card ${e.card}` : ''}{e.match?.issuedBy ? ` · issued by ${e.match.issuedBy}` : ''}{e.category === 'refused' ? ` · ${e.event}` : ''}</span>
              </li>))}
          </ul>
        </div>
      ))}
      {events.length > shown && <button className="btn" onClick={() => setShown(shown + 200)}>Show more ({events.length - shown} older)</button>}
    </div>
  );
}
