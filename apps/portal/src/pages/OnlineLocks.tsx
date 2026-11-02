import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useHotel } from '../App';
import { Kpi, NoData } from '../components/charts';
import { Drawer, ErrorNote, PageHead, fmt, useApi } from '../ui';

/**
 * 2.19 Online locks and gateways (Armel, 27 Oct). The locks Visionline runs online, whether each is in contact, and
 * the gateways (name, EEID, address, the locks behind them). An offline lock or gateway raises a monitoring alarm that
 * closes by itself when it is back.
 */
type State = 'online' | 'offline' | 'unknown';
interface Gateway { id: string; name: string; eeid: string | null; address: string | null; location: string | null; notes: string | null; doors: string[]; source: string; state: State; reason: string | null; since: string | null; checkedAt: string | null; alertOpen: boolean }
interface Lock { id: string; name: string; group: string | null; onlineLock: boolean; state: State; lastContact: string | null; since: string | null; reason: string | null; battery: string | null; model: string | null; gateway: { id: string; name: string; eeid: string | null; state: string } | null; alertOpen: boolean }
interface Data {
  summary: { onlineLocks: number; inContact: number; offline: number; unknown: number; gateways: number; gatewaysOffline: number; offlineDoorsVisionline: number };
  gateways: Gateway[]; locks: Lock[]; recentlyResolved: { kind: string; title: string; openedAt: string; resolvedAt: string }[];
}
const STATE: Record<State, { label: string; cls: string }> = { online: { label: 'In contact', cls: 'ok' }, offline: { label: 'Offline', cls: 'bad' }, unknown: { label: 'Not known yet', cls: '' } };
const MODEL: Record<string, string> = { 'signature-rfid': 'Signature RFID', essence: 'Essence', 'classic-rfid': 'Classic RFID', allure: 'Allure', other: 'Other' };
const toB64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(r.error); r.readAsDataURL(f); });

export function OnlineLocksPage() {
  const { base, can } = useHotel();
  const d = useApi<Data>(`${base}/online-locks`, [], 60_000);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'all' | 'offline' | 'unknown'>('all');
  const [edit, setEdit] = useState<Partial<Gateway> | null>(null);
  const [imp, setImp] = useState(false);
  const admin = can('settings.manage');
  const x = d.data;
  const locks = useMemo(() => (x?.locks ?? []).filter((l) => (only === 'all' || l.state === only)
    && (!q || `${l.name} ${l.group ?? ''} ${l.gateway?.name ?? ''} ${l.gateway?.eeid ?? ''}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.state === 'offline' ? -1 : b.state === 'offline' ? 1 : 0)), [x, q, only]);
  return (
    <>
      <PageHead title="Online locks & gateways" intro={<>The locks Visionline runs online and the gateways they talk through. An offline lock or gateway raises an alarm in Monitoring that <strong>closes by itself when it is back</strong>. A lock is offline when it says so, when a Visionline alarm says it lost contact, or when a lock that normally reports goes silent (Settings → Monitoring).</>}>
        <Link className="btn" to="/monitoring">Monitoring</Link>
        {admin && <button className="btn" onClick={() => setImp(true)}>Import gateways</button>}
        {admin && <button className="btn primary" onClick={() => setEdit({ name: '', eeid: '', doors: [] })}>Add a gateway</button>}
      </PageHead>
      <ErrorNote error={d.error} />
      {x && (
        <div className="kpis">
          <Kpi label="Online locks" value={String(x.summary.onlineLocks)} sub="run online by Visionline" />
          <Kpi label="In contact" value={String(x.summary.inContact)} sub="reporting normally" />
          <Kpi label="Offline" value={String(x.summary.offline)} sub="alarm open until back" tone={x.summary.offline ? 'bad' : undefined} />
          <Kpi label="Gateways" value={String(x.summary.gateways)} sub={x.summary.gatewaysOffline ? `${x.summary.gatewaysOffline} offline` : 'none offline'} tone={x.summary.gatewaysOffline ? 'bad' : undefined} />
        </div>
      )}
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Gateways</h2>
        {!x?.gateways.length && <NoData text="No gateway listed yet" hint={admin ? 'Add them one by one, or import the list exported from Visionline (name, EEID, address, location, doors).' : 'An administrator adds them.'} />}
        {(x?.gateways.length ?? 0) > 0 && (
          <div className="viz-table-wrap"><table className="grid">
            <thead><tr><th>Gateway</th><th>EEID</th><th>Address</th><th>Location</th><th className="num">Locks</th><th>State</th><th>Since</th>{admin && <th />}</tr></thead>
            <tbody>{x!.gateways.map((g) => (
              <tr key={g.id}>
                <td><strong>{g.name}</strong>{g.notes && <div className="small muted">{g.notes}</div>}</td>
                <td><code>{g.eeid ?? '—'}</code></td><td>{g.address ?? '—'}</td><td>{g.location ?? '—'}</td><td className="num">{g.doors.length}</td>
                <td><span className={`badge ${STATE[g.state].cls}`}>{STATE[g.state].label}</span>{g.reason && <div className="small muted">{g.reason}</div>}</td>
                <td className="small">{g.since ? fmt.dt(g.since) : '—'}</td>
                {admin && <td><button className="btn small" onClick={() => setEdit(g)}>Edit</button></td>}
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <p className="small muted" style={{ marginBottom: 0 }}>A gateway is offline when a Visionline alarm names it (its EEID, or its name with "gateway", "offline"…) or when all the locks behind it are offline. Live state from the network integrator (Ruckus, Cisco…) is added once their system can be read.</p>
      </section>
      <section className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Online locks</h2>
          <div className="row">
            <input className="search" placeholder="Door, floor, gateway or EEID…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
            <div className="seg">{(['all', 'offline', 'unknown'] as const).map((k) => <button key={k} type="button" aria-pressed={only === k} onClick={() => setOnly(k)}>{k === 'all' ? 'All' : k === 'offline' ? 'Offline' : 'Not known'}</button>)}</div>
          </div>
        </div>
        {x && !x.locks.length && <NoData text="No online lock found" hint="Visionline marks a door as online when it is run by the online system. Run discovery (Settings → Connector) to read the doors." />}
        {locks.length > 0 && (
          <div className="viz-table-wrap" style={{ marginTop: 10 }}><table className="grid">
            <thead><tr><th>Door</th><th>State</th><th>Last contact</th><th>Gateway</th><th>Lock model</th><th>Battery</th></tr></thead>
            <tbody>{locks.slice(0, 600).map((l) => (
              <tr key={l.id}>
                <td><strong>{l.name}</strong>{l.group && <div className="small muted">{l.group}</div>}</td>
                <td><span className={`badge ${STATE[l.state].cls}`}>{STATE[l.state].label}</span>{l.reason && <div className="small muted">{l.reason}</div>}</td>
                <td className="small">{l.lastContact ? fmt.dt(l.lastContact) : '—'}</td>
                <td className="small">{l.gateway ? <>{l.gateway.name}{l.gateway.eeid && <div className="muted"><code>{l.gateway.eeid}</code></div>}</> : '—'}</td>
                <td className="small">{l.model ? MODEL[l.model] ?? l.model : '—'}</td>
                <td className="small">{l.battery ? <Link to={`/battery/${encodeURIComponent(l.id)}`}>{l.battery === 'GOOD' ? 'Good' : l.battery === 'LOW' ? 'Low' : l.battery === 'CRITICAL' ? 'Critical' : 'Reading only'}</Link> : '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {locks.length > 600 && <p className="small muted">The first 600 of {locks.length}; search to narrow the list.</p>}
      </section>
      {(x?.recentlyResolved.length ?? 0) > 0 && (
        <section className="panel">
          <h2 style={{ marginTop: 0 }}>Back online (alarms closed by themselves)</h2>
          <table className="grid small"><thead><tr><th>Alarm</th><th>Opened</th><th>Closed</th></tr></thead>
            <tbody>{x!.recentlyResolved.map((r, i) => <tr key={i}><td>{r.title}</td><td>{fmt.dt(r.openedAt)}</td><td>{fmt.dt(r.resolvedAt)}</td></tr>)}</tbody></table>
        </section>
      )}
      {edit && <GatewayForm g={edit} locks={x?.locks ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void d.reload(); }} />}
      {imp && <ImportDrawer onClose={() => setImp(false)} onDone={() => { setImp(false); void d.reload(); }} />}
    </>
  );
}

function GatewayForm({ g, locks, onClose, onSaved }: { g: Partial<Gateway>; locks: Lock[]; onClose: () => void; onSaved: () => void }) {
  const { base } = useHotel();
  const [v, setV] = useState({ name: g.name ?? '', eeid: g.eeid ?? '', address: g.address ?? '', location: g.location ?? '', notes: g.notes ?? '' });
  const names = new Map(locks.map((l) => [l.id, l.name]));
  const [doors, setDoors] = useState(() => (g.doors ?? []).map((id) => names.get(id) ?? id).join(', '));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = { ...v, doors: doors.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean) };
      if (g.id) await api(`${base}/gateways/${g.id}`, { method: 'PUT', body }); else await api(`${base}/gateways`, { body });
      onSaved();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const del = async () => { if (!g.id || !confirm(`Remove gateway ${g.name}?`)) return; try { await api(`${base}/gateways/${g.id}`, { method: 'DELETE' }); onSaved(); } catch (e) { setError(e); } };
  return (
    <Drawer title={g.id ? `Gateway ${g.name}` : 'Add a gateway'} onClose={onClose} footer={<>{g.id ? <button className="btn ghost" onClick={del}>Remove</button> : <span />}<div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !v.name.trim()} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div></>}>
      <ErrorNote error={error} />
      <div className="field"><label htmlFor="gw-n">Name</label><input id="gw-n" value={v.name} maxLength={120} onChange={(e) => setV({ ...v, name: e.target.value })} autoFocus /></div>
      <div className="field"><label htmlFor="gw-e">EEID</label><input id="gw-e" value={v.eeid} maxLength={64} onChange={(e) => setV({ ...v, eeid: e.target.value })} placeholder="as shown in Visionline" /></div>
      <div className="field-row">
        <div className="field"><label htmlFor="gw-a">IP address or host</label><input id="gw-a" value={v.address} maxLength={120} onChange={(e) => setV({ ...v, address: e.target.value })} /></div>
        <div className="field"><label htmlFor="gw-l">Location</label><input id="gw-l" value={v.location} maxLength={120} onChange={(e) => setV({ ...v, location: e.target.value })} placeholder="e.g. Floor 3, east corridor" /></div>
      </div>
      <div className="field"><label htmlFor="gw-d">Locks behind it (door names or numbers, separated by commas)</label>
        <textarea id="gw-d" rows={4} value={doors} onChange={(e) => setDoors(e.target.value)} />
        <span className="hint">Used to tell when the gateway itself is down (all its locks offline).</span></div>
      <div className="field"><label htmlFor="gw-x">Notes</label><textarea id="gw-x" rows={2} maxLength={1000} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></div>
    </Drawer>
  );
}

function ImportDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { base } = useHotel();
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [pv, setPv] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async (f: { name: string; data: string }, preview: boolean) => {
    setBusy(true); setError(null);
    try {
      const r = await api<any>(`${base}/gateways/import`, { body: { fileName: f.name, data: f.data, preview } });
      if (preview) setPv(r); else onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const pick = async (f: File | undefined) => { if (!f) return; const x = { name: f.name, data: await toB64(f) }; setFile(x); setPv(null); void run(x, true); };
  return (
    <Drawer title="Import gateways" onClose={onClose} footer={<><span /><div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !pv || !file || !(pv.added + pv.updated)} onClick={() => file && run(file, false)}>{busy && pv ? 'Importing…' : 'Import'}</button></div></>}>
      <p className="small">A table exported from Visionline (saved as .xls, .txt or .csv), or one you type in Excel and save as "Unicode Text" or CSV. The first line holds the column names; these are recognised: <b>Name</b>, <b>EEID</b>, <b>IP / Address</b>, <b>Location / Floor</b>, <b>Doors / Rooms</b> (several in one cell, separated by commas). Gateways already listed are updated (matched on EEID, else on name).</p>
      <div className="field"><label htmlFor="gw-file">File</label><input id="gw-file" type="file" accept=".xls,.txt,.csv,.tsv,text/plain,text/csv" onChange={(e) => pick(e.target.files?.[0])} /></div>
      <ErrorNote error={error} />
      {pv && (
        <>
          <div className="alert ok">{pv.added} to add, {pv.updated} to update{pv.skipped ? `, ${pv.skipped} rows without a name or EEID skipped` : ''}.</div>
          <p className="small muted">Columns used: {Object.entries(pv.columns).filter(([, v]) => v).map(([k, v]) => `${k} = "${v}"`).join(', ')}.</p>
          {pv.unknownDoors.length > 0 && <div className="alert warn">Doors not found in Visionline: {pv.unknownDoors.slice(0, 12).join(', ')}{pv.unknownDoors.length > 12 ? '…' : ''}.</div>}
          <table className="grid small"><thead><tr><th>Name</th><th>EEID</th><th>Address</th><th>Location</th><th className="num">Locks</th><th /></tr></thead>
            <tbody>{pv.rows.slice(0, 40).map((r: any, i: number) => <tr key={i}><td>{r.name}</td><td><code>{r.eeid ?? '—'}</code></td><td>{r.address ?? '—'}</td><td>{r.location ?? '—'}</td><td className="num">{r.doors}</td><td>{r.action === 'add' ? 'new' : 'update'}</td></tr>)}</tbody></table>
        </>
      )}
    </Drawer>
  );
}
