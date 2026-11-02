import { useEffect, useMemo, useState } from 'react';
import { useHotel } from '../App';
import { api, download } from '../api';
import { ErrorNote, useApi } from '../ui';
import { Columns, DataTable, HBars, Legend, Lines, NoData, VizCard } from './charts';

/** 2.12 Build your own report: one dataset, group by, optional split, a measure, filters, a chart. Saved reports can be pinned to Insights. */
export interface Spec { dataset: string; groupBy: string; splitBy?: string | null; measure: string; days: number; limit: number; chart: 'bars' | 'columns' | 'lines' | 'table'; filters: { dim: string; values: string[] }[] }
const PALETTE = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', '#8e5bd0', '#c2185b', '#6d6d6d', '#b9aea8'];
const DAYS = [{ d: 1, l: 'Today' }, { d: 7, l: '7 days' }, { d: 30, l: '30 days' }, { d: 90, l: '90 days' }, { d: 365, l: '12 months' }];
const CHARTS = [{ id: 'bars', l: 'Bars' }, { id: 'columns', l: 'Columns' }, { id: 'lines', l: 'Line' }, { id: 'table', l: 'Table' }] as const;

/** Ready-made starting points, like rows on a streaming home page. */
export const TEMPLATES: { title: string; about: string; spec: Spec }[] = [
  { title: 'Entrances by hour of the day', about: 'When the building is busiest, refused entries in red.', spec: { dataset: 'doorEvents', groupBy: 'hour', splitBy: 'category', measure: 'events', days: 30, limit: 24, chart: 'columns', filters: [] } },
  { title: 'Busiest doors', about: 'Entrances and refused entries per door.', spec: { dataset: 'doorEvents', groupBy: 'door', splitBy: 'category', measure: 'events', days: 30, limit: 15, chart: 'bars', filters: [] } },
  { title: 'Who uses the most doors', about: 'Different doors opened per person.', spec: { dataset: 'doorEvents', groupBy: 'person', measure: 'doors', days: 30, limit: 15, chart: 'bars', filters: [{ dim: 'category', values: ['Entrance'] }] } },
  { title: 'Lock events with no matching keycard', about: 'Card numbers that match no Visionline keycard and no mobile key.', spec: { dataset: 'doorEvents', groupBy: 'door', measure: 'events', days: 90, limit: 15, chart: 'bars', filters: [{ dim: 'cardKind', values: ['Not matched'] }] } },
  { title: 'Keycards that override the deadbolt', about: 'Valid keycards by user group, split by deadbolt privilege.', spec: { dataset: 'keycards', groupBy: 'userGroup', splitBy: 'deadbolt', measure: 'cards', days: 30, limit: 20, chart: 'bars', filters: [{ dim: 'state', values: ['Valid'] }] } },
  { title: 'Keycards ending soon', about: 'Valid keycards by when they end.', spec: { dataset: 'keycards', groupBy: 'ends', splitBy: 'kind', measure: 'cards', days: 30, limit: 10, chart: 'columns', filters: [{ dim: 'state', values: ['Valid'] }] } },
  { title: 'Mobile keys issued per supervisor', about: 'Who issues keys, and how they ended.', spec: { dataset: 'mobileKeys', groupBy: 'issuedBy', splitBy: 'endedBy', measure: 'keys', days: 90, limit: 15, chart: 'bars', filters: [] } },
  { title: 'Lock alarms per week day', about: 'Which days alarms happen.', spec: { dataset: 'alarms', groupBy: 'weekday', splitBy: 'state', measure: 'alarms', days: 90, limit: 7, chart: 'columns', filters: [] } },
  { title: 'Maintenance: time to resolve by category', about: 'Average hours to resolve.', spec: { dataset: 'maintenance', groupBy: 'category', measure: 'hours', days: 90, limit: 10, chart: 'bars', filters: [] } },
  { title: 'Breakfast guests per day', about: 'In the rate, paying and walk-in.', spec: { dataset: 'breakfast', groupBy: 'day', splitBy: 'kind', measure: 'persons', days: 30, limit: 31, chart: 'columns', filters: [] } },
];

export function useCatalog() {
  const { base } = useHotel();
  return useApi<{ datasets: any[] }>(`${base}/insights/builder/catalog`);
}

/** Runs a report and draws it. Clicking a group can narrow the report (onPick). */
export function ReportVisual({ spec, title, sub, actions, span = 6, onPick, height }: { spec: Spec; title: string; sub?: string; actions?: React.ReactNode; span?: 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12; onPick?: (key: string) => void; height?: number }) {
  const { base } = useHotel();
  const [r, setR] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const key = JSON.stringify(spec);
  useEffect(() => {
    let alive = true;
    setError(null);
    api<any>(`${base}/insights/builder/run`, { body: spec }).then((x) => alive && setR(x)).catch((e) => alive && setError(e));
    return () => { alive = false; };
  }, [key, base]); // eslint-disable-line react-hooks/exhaustive-deps
  const series = (r?.series ?? []).map((n: string, i: number) => ({ name: n, color: n === 'Refused' ? 'var(--st-crit)' : n === 'Other' ? '#b9aea8' : PALETTE[i % PALETTE.length]! }));
  const table = r ? <DataTable head={[r.groupBy, ...r.series]} numeric={r.series.map((_: string, i: number) => i + 1)} rows={r.rows.map((x: any) => [x.label, ...x.values])} /> : null;
  const chart = error ? <ErrorNote error={error} /> : !r ? <div className="viz-empty">Loading…</div> : !r.rows.length ? <NoData text="Nothing for this selection" hint="Change the period or the filters." />
    : spec.chart === 'table' ? table
      : spec.chart === 'lines' ? <><Legend series={series} /><Lines points={r.rows.map((x: any) => ({ t: x.key, values: x.values }))} series={series} label={(t) => t} height={height} /></>
        : spec.chart === 'columns' ? <><Legend series={series} /><Columns points={r.rows.map((x: any) => ({ key: x.key, values: x.values }))} series={series} label={(k) => r.rows.find((x: any) => x.key === k)?.label ?? k} onSelect={onPick} height={height} /></>
          : <><Legend series={series} /><HBars rows={r.rows.map((x: any) => ({ key: x.key, label: x.label, values: x.values }))} series={series} onSelect={onPick ? (row) => onPick(row.key) : undefined} unit={r.unit} /></>;
  const foot = r ? `${r.total != null ? `Total ${r.total.toLocaleString()}${r.unit} · ` : ''}${r.hiddenGroups ? `${r.hiddenGroups} smaller groups not shown · ` : ''}${r.dataset.label}` : '';
  return <VizCard span={span} title={title} sub={[sub, foot].filter(Boolean).join(' · ')} chart={chart} table={spec.chart === 'table' ? undefined : table ?? undefined} actions={actions} filtered={spec.filters.map((f) => `${f.values.slice(0, 2).join(', ')}${f.values.length > 2 ? '…' : ''}`)} />;
}

/** The builder: configuration on the left, the live report on the right. */
export function Builder({ initial, savedId, savedName, savedFlags, onSaved, onCancel }: {
  initial?: Spec; savedId?: string; savedName?: string; savedFlags?: { pinned: boolean; shared: boolean }; onSaved: () => void; onCancel: () => void;
}) {
  const { base, hotel } = useHotel();
  const cat = useCatalog();
  const [spec, setSpec] = useState<Spec>(initial ?? TEMPLATES[1]!.spec);
  const [name, setName] = useState(savedName ?? '');
  const [pinned, setPinned] = useState(savedFlags?.pinned ?? true);
  const [shared, setShared] = useState(savedFlags?.shared ?? false);
  const [addDim, setAddDim] = useState('');
  const [values, setValues] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ds = cat.data?.datasets.find((d) => d.id === spec.dataset);
  const set = (p: Partial<Spec>) => setSpec((s) => ({ ...s, ...p }));
  const pickDataset = (id: string) => {
    const d = cat.data!.datasets.find((x) => x.id === id)!;
    setSpec((s) => ({ ...s, dataset: id, groupBy: d.dims[0].id, splitBy: null, measure: d.measures[0].id, filters: [] }));
  };
  // Values to filter on: the groups of the chosen dimension.
  useEffect(() => {
    if (!addDim || !ds) { setValues([]); return; }
    api<any>(`${base}/insights/builder/run`, { body: { ...spec, groupBy: addDim, splitBy: null, limit: 100, chart: 'table', filters: spec.filters.filter((f) => f.dim !== addDim) } })
      .then((r) => setValues(r.rows.map((x: any) => x.key))).catch(() => setValues([]));
  }, [addDim, spec.dataset, spec.days]); // eslint-disable-line react-hooks/exhaustive-deps
  const filterOf = (dim: string) => spec.filters.find((f) => f.dim === dim)?.values ?? [];
  const toggleValue = (dim: string, v: string) => {
    const cur = filterOf(dim); const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    set({ filters: [...spec.filters.filter((f) => f.dim !== dim), ...(next.length ? [{ dim, values: next }] : [])] });
  };
  const dimLabel = (id: string) => ds?.dims.find((d: any) => d.id === id)?.label ?? id;
  const autoName = useMemo(() => ds ? `${ds.measures.find((m: any) => m.id === spec.measure)?.label ?? ''} by ${dimLabel(spec.groupBy).toLowerCase()}${spec.splitBy ? ` and ${dimLabel(spec.splitBy).toLowerCase()}` : ''}` : '', [ds, spec]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = { name: (name.trim() || autoName).slice(0, 80), spec, pinned, shared };
      if (savedId) await api(`${base}/insights/reports/${savedId}`, { method: 'PUT', body }); else await api(`${base}/insights/reports`, { body });
      onSaved();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const csv = () => {
    void (async () => {
      try {
        const res = await fetch(`${base}/insights/builder/csv`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('smk.token') ?? ''}` }, body: JSON.stringify(spec) });
        if (!res.ok) throw new Error('Export failed');
        const url = URL.createObjectURL(await res.blob());
        Object.assign(document.createElement('a'), { href: url, download: `${hotel.slug}-${(name || autoName).replace(/\W+/g, '-').toLowerCase()}.csv` }).click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (e) { setError(e); }
    })();
  };
  void download;
  if (!cat.data) return <div className="panel"><p className="muted">{cat.error ?? 'Loading…'}</p></div>;
  return (
    <div className="builder">
      <aside className="builder-side panel">
        <div className="bstep"><h3>Data</h3>
          <div className="ds-list">{cat.data.datasets.map((d) => (
            <button key={d.id} type="button" className="ds" aria-pressed={spec.dataset === d.id} onClick={() => pickDataset(d.id)} title={d.about}>{d.label}</button>))}</div>
          {ds && <p className="hint small">{ds.about}</p>}
        </div>
        {ds && <>
          <div className="bstep"><h3>Show</h3>
            <div className="chips">{ds.measures.map((m: any) => <button key={m.id} type="button" className="chip" aria-pressed={spec.measure === m.id} onClick={() => set({ measure: m.id })}>{m.label}</button>)}</div></div>
          <div className="bstep two">
            <label className="field"><span>Group by</span><select value={spec.groupBy} onChange={(e) => set({ groupBy: e.target.value, splitBy: spec.splitBy === e.target.value ? null : spec.splitBy })}>{ds.dims.map((d: any) => <option key={d.id} value={d.id}>{d.label}</option>)}</select></label>
            <label className="field"><span>Split by (colours)</span><select value={spec.splitBy ?? ''} onChange={(e) => set({ splitBy: e.target.value || null })}><option value="">Nothing</option>{ds.dims.filter((d: any) => d.id !== spec.groupBy).map((d: any) => <option key={d.id} value={d.id}>{d.label}</option>)}</select></label>
          </div>
          <div className="bstep"><h3>Chart</h3>
            <div className="seg">{CHARTS.map((c) => <button key={c.id} type="button" aria-pressed={spec.chart === c.id} onClick={() => set({ chart: c.id })}>{c.l}</button>)}</div></div>
          <div className="bstep two">
            {ds.time ? <label className="field"><span>Period</span><select value={spec.days} onChange={(e) => set({ days: Number(e.target.value) })}>{DAYS.map((d) => <option key={d.d} value={d.d}>{d.l}</option>)}</select></label> : <div className="field"><span>Period</span><div className="hint small" style={{ paddingTop: 8 }}>Current state</div></div>}
            <label className="field"><span>Show the top</span><select value={spec.limit} onChange={(e) => set({ limit: Number(e.target.value) })}>{[5, 10, 15, 20, 24, 31, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          </div>
          <div className="bstep"><h3>Filters</h3>
            {spec.filters.map((f) => (
              <div key={f.dim} className="fchip-row"><span className="muted small">{dimLabel(f.dim)}:</span>
                {f.values.map((v) => <button key={v} type="button" className="fchip" onClick={() => toggleValue(f.dim, v)} title="Remove">{v.replace(/^\d /, '')} ×</button>)}</div>))}
            <select value={addDim} onChange={(e) => setAddDim(e.target.value)} className="search" style={{ minWidth: 0, width: '100%' }}>
              <option value="">＋ Filter on…</option>{ds.dims.map((d: any) => <option key={d.id} value={d.id}>{d.label}</option>)}</select>
            {addDim && <div className="chips" style={{ marginTop: 8, maxHeight: 160, overflow: 'auto' }}>
              {values.length ? values.map((v) => <button key={v} type="button" className="chip" aria-pressed={filterOf(addDim).includes(v)} onClick={() => toggleValue(addDim, v)}>{v.replace(/^\d /, '')}</button>) : <span className="muted small">No values in this period.</span>}</div>}
          </div>
        </>}
      </aside>
      <section className="builder-main">
        <div className="grid12">
          <ReportVisual span={12} spec={spec} title={name.trim() || autoName} height={300}
            onPick={(k) => { if (!filterOf(spec.groupBy).includes(k)) toggleValue(spec.groupBy, k); }}
            actions={<button className="btn small ghost" onClick={csv}>CSV</button>} />
        </div>
        <p className="hint small">Tip: click a bar to keep only that {dimLabel(spec.groupBy).toLowerCase()}; remove it again under Filters.</p>
        <div className="panel save-bar">
          <label className="field" style={{ flex: '1 1 260px', margin: 0 }}><span>Name</span><input value={name} placeholder={autoName} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /><span>Pin to the Insights summary</span></label>
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /><span>Share with everyone who reads reports</span></label>
          <div className="row" style={{ marginLeft: 'auto' }}><button className="btn" onClick={onCancel}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : savedId ? 'Save changes' : 'Save report'}</button></div>
        </div>
        <ErrorNote error={error} />
      </section>
    </div>
  );
}

/** My reports: saved and shared reports, plus the gallery of ready-made ones. */
export function MyReports({ onEdit, onNew }: { onEdit: (r: any) => void; onNew: (spec?: Spec) => void }) {
  const { base } = useHotel();
  const list = useApi<any[]>(`${base}/insights/reports`);
  const cat = useCatalog();
  const allowed = new Set((cat.data?.datasets ?? []).map((d) => d.id));
  const [error, setError] = useState<unknown>(null);
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); await list.reload(); } catch (e) { setError(e); } };
  const toggle = (r: any, k: 'pinned' | 'shared') => act(() => api(`${base}/insights/reports/${r.id}`, { method: 'PUT', body: { name: r.name, spec: r.spec, pinned: k === 'pinned' ? !r.pinned : r.pinned, shared: k === 'shared' ? !r.shared : r.shared } }));
  return (
    <>
      <ErrorNote error={error} />
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>My reports</h2>
        <button className="btn primary" onClick={() => onNew()}>＋ Build a report</button>
      </div>
      {list.data && !list.data.length && <div className="panel"><p className="muted" style={{ margin: 0 }}>No saved reports yet. Start from one below or build your own; saved reports can be pinned to the Summary page.</p></div>}
      <div className="grid12">
        {(list.data ?? []).map((r) => (
          <ReportVisual key={r.id} span={6} spec={r.spec} title={r.name} sub={r.mine ? (r.shared ? 'shared' : 'only you') : `shared by ${r.owner}`}
            actions={r.mine && <>
              <button className="btn small ghost" aria-pressed={r.pinned} title="Pin to the Insights summary" onClick={() => toggle(r, 'pinned')}>{r.pinned ? '★ Pinned' : '☆ Pin'}</button>
              <button className="btn small ghost" onClick={() => onEdit(r)}>Edit</button>
              <button className="btn small ghost" onClick={() => window.confirm(`Delete "${r.name}"?`) && act(() => api(`${base}/insights/reports/${r.id}`, { method: 'DELETE' }))}>Delete</button></>} />))}
      </div>
      <h2 style={{ margin: '22px 0 10px' }}>Start from…</h2>
      <div className="gallery">
        {TEMPLATES.filter((t) => allowed.has(t.spec.dataset)).map((t) => (
          <button key={t.title} type="button" className="gal-card" onClick={() => onNew(t.spec)}>
            <span className="gal-kind">{cat.data?.datasets.find((d) => d.id === t.spec.dataset)?.label}</span>
            <strong>{t.title}</strong><span className="muted small">{t.about}</span>
          </button>))}
      </div>
    </>
  );
}

/** Pinned reports, shown at the end of the Insights summary. */
export function PinnedReports() {
  const { base } = useHotel();
  const list = useApi<any[]>(`${base}/insights/reports`);
  const pinned = (list.data ?? []).filter((r) => r.pinned && r.mine);
  if (!pinned.length) return null;
  return <>{pinned.map((r) => <ReportVisual key={r.id} span={6} spec={r.spec} title={r.name} sub="pinned" />)}</>;
}
