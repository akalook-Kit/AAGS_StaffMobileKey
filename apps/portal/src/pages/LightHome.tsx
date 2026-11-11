import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, connectVisionline, type LightConnection } from '../api';
import { useHotel } from '../App';
import { Columns, DataTable, HBars, Kpi, VizCard } from '../components/charts';
import { ErrorNote, PageHead, fmt, useApi } from '../ui';
import { RecordWorkButton, lowCls, lowIn, type LockList } from './LockHistory';

/**
 * 2.34 Home page of the light edition (Armel, 11 Nov 2026): the connection to Visionline, then the locks at a glance —
 * which drain, which wait for a report, when the batteries are expected low if nothing changes (to prepare in advance),
 * the reminders, and the shortcuts the technicians use every day.
 */
const WEEK = 7 * 86_400_000;
const day = (d: string | null | undefined) => (d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short' }) : '—');

export function LightHome() {
  const { base, hotel, can } = useHotel();
  const nav = useNavigate();
  const conn = useApi<LightConnection>(`${base}/light/connection`, [hotel.id], 15_000);
  const hist = useApi<LockList>(`${base}/lock-history?all=1`, [hotel.id], 120_000);
  const x = hist.data;
  const today = x?.today ?? new Date().toISOString().slice(0, 10);

  const k = useMemo(() => {
    const locks = x?.locks ?? [];
    const low7 = locks.filter((l) => l.forecast?.daysLeft != null && l.forecast.daysLeft <= 7);
    const overdue = locks.filter((l) => l.forecast?.daysLeft != null && l.forecast.daysLeft < 0);
    const reminders = locks.flatMap((l) => l.plan.filter((p) => p.priority <= 1).map((p) => ({ l, p })));
    // Batteries expected low per week, for the next 8 weeks (overdue ones count in this week).
    const t0 = Date.parse(`${today}T12:00:00Z`);
    const weeks = Array.from({ length: 8 }, (_, i) => ({ key: new Date(t0 + i * WEEK).toISOString().slice(0, 10), values: [0] }));
    for (const l of locks) {
      if (!l.forecast?.expectedLowOn) continue;
      const i = Math.max(0, Math.floor((Date.parse(`${l.forecast.expectedLowOn}T12:00:00Z`) - t0) / WEEK));
      if (i < 8) weeks[i]!.values[0]! += 1;
    }
    // The locks whose batteries last the least (days per set).
    const fastest = locks.filter((l) => l.avgDays != null && l.batteryChanges >= 1).sort((a, b) => a.avgDays! - b.avgDays!).slice(0, 10)
      .map((l) => ({ key: l.doorId, label: `${l.doorName}${l.floor ? ` · ${l.floor}` : ''}`, values: [Math.round(l.avgDays!)] }));
    const soon = locks.filter((l) => l.forecast?.daysLeft != null && l.forecast.daysLeft <= 14).sort((a, b) => a.forecast!.daysLeft! - b.forecast!.daysLeft!);
    return { locks, low7, overdue, reminders, weeks, fastest, soon };
  }, [x, today]);

  const c = conn.data;
  return (
    <>
      <PageHead title={hotel.name} intro="Lock diagnosis and battery follow-up: what drains, what to do next, and when to prepare batteries.">
        <span className="no-print"><RecordWorkButton problem /></span>
        <span className="no-print"><RecordWorkButton primary /></span>
      </PageHead>
      <ErrorNote error={conn.error ?? hist.error} />
      {c && !c.connected && <ConnectionCard c={c} onDone={() => { void conn.reload(); void hist.reload(); }} />}
      {c?.connected && (
        <p className="small muted light-conn"><span className="badge ok">Connected to Visionline</span>{c.visionline.username && <span>{`Visionline user: ${c.visionline.username}`}</span>}<span>{`${c.doors} doors`}</span>{c.connector?.lastSeen && <span>{`Last contact ${fmt.dt(c.connector.lastSeen)}`}</span>}
          {(c.discovery?.status === 'PENDING' || c.discovery?.status === 'LEASED') && <span>Reading the doors…</span>}
          {can('battery.manage') && <ChangeAccount onDone={() => void conn.reload()} />}</p>
      )}

      {x && <>
        <div className="kpis light-kpis">
          <Kpi label="Locks draining" value={String(x.counts.draining ?? 0)} tone={(x.counts.draining ?? 0) > 0 ? 'bad' : undefined} sub="follow the next step" onClick={() => nav('/lock-troubleshoot?tab=locks')} />
          <Kpi label="Waiting for a report" value={String(x.counts.waiting ?? 0)} sub="read the lock, upload" onClick={() => nav('/lock-troubleshoot?tab=locks')} />
          <Kpi label="Batteries low within 7 days" value={String(k.low7.length)} tone={k.overdue.length ? 'bad' : k.low7.length ? 'warn' : undefined} sub={k.overdue.length ? `${k.overdue.length} already past` : 'prepare in advance'} onClick={() => nav('/lock-troubleshoot?tab=day')} />
          <Kpi label="Solved" value={String(x.counts.solved ?? 0)} sub={`of ${x.total} locks followed`} onClick={() => nav('/lock-troubleshoot?tab=locks')} />
        </div>

        {k.reminders.length > 0 && (
          <section className="panel light-reminders" style={{ padding: 0 }}>
            <h3 className="lh-todo-h">Reminders <span className="badge bad">{k.reminders.length}</span></h3>
            <table className="grid"><tbody>{k.reminders.slice(0, 8).map(({ l, p }, i) => (
              <tr key={i}><td className="nowrap" style={{ width: 130 }}><Link to={`/lock-troubleshoot/door/${encodeURIComponent(l.doorId)}`}><strong>{l.doorName}</strong></Link><div className="small muted">{l.floor ?? ''}</div></td>
                <td className="small"><strong>{p.title}</strong><div className="muted">{p.detail}</div></td></tr>))}</tbody></table>
            {k.reminders.length > 8 && <p className="small" style={{ padding: '0 16px 12px' }}><Link to="/lock-troubleshoot">All {k.reminders.length} reminders in the To do list →</Link></p>}
          </section>
        )}

        <div className="grid12">
          <VizCard span={6} title="Batteries expected low, per week" sub={x.siteLifeDays ? `If nothing changes: the last battery change + how long a set lasts (hotel: ${x.siteLifeDays} days). Prepare the batteries for these weeks.` : 'If nothing changes: the last battery change + how long a set lasts. Prepare the batteries for these weeks.'}
            chart={<Columns points={k.weeks} series={[{ name: 'Locks', color: 'var(--series-1)' }]} label={(d) => day(d)} onSelect={() => nav('/lock-troubleshoot?tab=locks')} />}
            table={<DataTable head={['Week from', 'Locks']} numeric={[1]} rows={k.weeks.map((w) => [day(w.key), w.values[0]!])} />} />
          <VizCard span={6} title="Locks whose batteries last the least" sub="Average days a set of batteries lasts. Short lives point to a fault: follow the steps on the lock."
            chart={<HBars rows={k.fastest} series={[{ name: 'Days per set', color: 'var(--series-2)' }]} unit=" d" empty="No battery change recorded yet" onSelect={(r) => nav(`/lock-troubleshoot/door/${encodeURIComponent(r.key)}`)} />}
            table={<DataTable head={['Lock', 'Days per set']} numeric={[1]} rows={k.fastest.map((r) => [r.label, r.values[0]!])} />} />
          {x.years.length > 0 && <VizCard span={6} title="Days a set of batteries lasts, by year" sub="Median over the hotel's locks. A drop on many locks at once points to a common cause (battery supply, firmware)."
            chart={<Columns points={x.years.map((y) => ({ key: y.year, values: [y.medianDays] }))} series={[{ name: 'Median days', color: 'var(--series-1)' }]} />}
            table={<DataTable head={['Year', 'Sets', 'Median days', 'Shortest', 'Longest']} numeric={[1, 2, 3, 4]} rows={x.years.map((y) => [y.year, y.sets, y.medianDays, y.shortest, y.longest])} />} />}
          <section className={`vizcard span-${x.years.length ? 6 : 12}`} aria-label="Prepare: batteries low soon">
            <header><div><h2>Prepare: batteries low within 14 days</h2><p>Have the batteries ready for these locks.</p></div></header>
            <div className="vizbody">{!k.soon.length ? <p className="empty">No lock expected low within 14 days.</p> : (
              <table className="grid small"><thead><tr><th>Lock</th><th>Floor</th><th>Expected low</th></tr></thead>
                <tbody>{k.soon.slice(0, 12).map((l) => <tr key={l.doorId}><td><Link to={`/lock-troubleshoot/door/${encodeURIComponent(l.doorId)}`}><strong>{l.doorName}</strong></Link></td><td>{l.floor ?? '—'}</td>
                  <td className="nowrap"><span className={`badge ${lowCls(l.forecast)}`}>{lowIn(l.forecast)}</span> {day(l.forecast?.expectedLowOn)}</td></tr>)}</tbody></table>)}
              {k.soon.length > 12 && <p className="small"><Link to="/lock-troubleshoot?tab=locks">All {k.soon.length} →</Link></p>}</div>
          </section>
        </div>

        <section className="light-actions no-print">
          <Link className="tile" to="/lock-troubleshoot?tab=day"><strong>Day report</strong><span>What was done and seen today, floor by floor. Print or Excel.</span></Link>
          <Link className="tile" to="/lock-troubleshoot?tab=locks"><strong>Lock register</strong><span>Every lock: floor, state, battery changes, expected low.</span></Link>
          {can('battery.manage') && <Link className="tile" to="/lock-troubleshoot?tab=reports&upload=1"><strong>Upload a lock report</strong><span>The events read from the lock (Visionline .xls).</span></Link>}
          <Link className="tile" to="/lock-troubleshoot?tab=how"><strong>How to diagnose a lock</strong><span>Cables → battery holder → batteries → LCA → LCU.</span></Link>
        </section>
      </>}
      {can('battery.manage') && <HotelCard />}
    </>
  );
}

const STATE_TEXT: Record<LightConnection['state'], string> = {
  'no-connector': 'The connector is not registered on this server yet. Restart the server: the installer registers it when its services start.',
  'connector-offline': 'The connector on this server is not running. Check that the "Access Monitoring Tool" services are started.',
  'needs-account': 'Enter the Visionline account the portal reads with (a Visionline user with read rights). This is the only setting.',
  'visionline-unreachable': 'The connector cannot reach Visionline with this account. Check that Visionline is running, then enter the account again.',
  connected: 'Connected.',
};

/** The only setting of the light edition: the Visionline account (the password is encrypted here for the connector). */
function ConnectionCard({ c, onDone }: { c: LightConnection; onDone: () => void }) {
  const { hotel, can } = useHotel();
  const [u, setU] = useState(c.visionline.username ?? '');
  const [p, setP] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const ask = c.state === 'needs-account' || c.state === 'visionline-unreachable';
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(null);
    try { await connectVisionline(hotel.id, u.trim(), p, setBusy); setP(''); onDone(); } catch (err) { setError(err); } finally { setBusy(null); }
  };
  return (
    <section className="panel light-connect">
      <h2 className="section-title" style={{ marginTop: 0 }}>Connect to Visionline</h2>
      <p>{STATE_TEXT[c.state]}</p>
      {c.visionline.lastError && <p className="small warn-text">Last answer from the connector: {c.visionline.lastError}</p>}
      {ask && can('battery.manage') && (
        <form onSubmit={submit} className="field-row" style={{ alignItems: 'flex-end' }}>
          <div className="field"><label htmlFor="lc-u">Visionline user</label><input id="lc-u" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} required maxLength={100} /></div>
          <div className="field"><label htmlFor="lc-p">Password</label><input id="lc-p" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required /></div>
          <div className="field"><button className="btn primary" disabled={Boolean(busy) || !u.trim() || !p}>{busy ? 'Connecting…' : 'Connect'}</button></div>
        </form>
      )}
      {busy && <p className="small muted" role="status">{busy}</p>}
      <ErrorNote error={error} />
      <p className="small muted">The password is encrypted in this browser for the connector on this server: the portal never sees or keeps it.</p>
    </section>
  );
}

function ChangeAccount({ onDone }: { onDone: () => void }) {
  const { hotel } = useHotel();
  const [open, setOpen] = useState(false);
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!open) return <button className="linklike small no-print" onClick={() => setOpen(true)}>Change the Visionline account</button>;
  return (
    <form className="panel no-print" style={{ marginTop: 8 }} onSubmit={async (e) => { e.preventDefault(); setError(null); try { await connectVisionline(hotel.id, u.trim(), p, setBusy); setOpen(false); onDone(); } catch (err) { setError(err); } finally { setBusy(null); } }}>
      <div className="field-row" style={{ alignItems: 'flex-end' }}>
        <div className="field"><label htmlFor="ca-u">Visionline user</label><input id="ca-u" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} required /></div>
        <div className="field"><label htmlFor="ca-p">Password</label><input id="ca-p" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required /></div>
        <div className="field row"><button className="btn primary" disabled={Boolean(busy) || !u.trim() || !p}>{busy ? 'Connecting…' : 'Save'}</button><button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button></div>
      </div>
      {busy && <p className="small muted" role="status">{busy}</p>}
      <ErrorNote error={error} />
    </form>
  );
}

/** The hotel's name and logo (shown on the portal and the printed reports). */
function HotelCard() {
  const { base, hotel, branding, reloadBranding } = useHotel();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(hotel.name);
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!open) return <p className="small muted no-print" style={{ marginTop: 24 }}><button className="linklike small" onClick={() => setOpen(true)}>Change the hotel's name or logo</button></p>;
  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!/^image\/(png|jpeg|svg\+xml|webp)$/.test(f.type) || f.size > 580_000) { setError(new Error('Choose a PNG, JPEG, SVG or WebP logo under 570 KB.')); return; }
    const r = new FileReader(); r.onload = () => setLogo(String(r.result)); r.readAsDataURL(f);
  };
  const save = async () => {
    setBusy(true); setError(null);
    try { await api(`${base}/light/hotel`, { method: 'PUT', body: { ...(name.trim() !== hotel.name ? { name: name.trim() } : {}), ...(logo !== undefined ? { logo } : {}) } }); location.reload(); } catch (e) { setError(e); setBusy(false); }
  };
  void reloadBranding;
  return (
    <section className="panel no-print" style={{ marginTop: 24 }}>
      <h2 className="section-title" style={{ marginTop: 0 }}>Hotel name and logo</h2>
      <div className="field"><label htmlFor="hc-n">Name</label><input id="hc-n" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field"><label htmlFor="hc-l">Logo</label>
        {(logo ?? branding?.logo) && <img src={(logo ?? branding?.logo) as string} alt="" style={{ maxHeight: 60, display: 'block', margin: '4px 0' }} />}
        <input id="hc-l" type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={(e) => pick(e.target.files?.[0])} />
        {(branding?.logo || logo) && <button type="button" className="linklike small" onClick={() => setLogo(null)}>Remove the logo</button>}</div>
      <ErrorNote error={error} />
      <div className="row"><button className="btn primary" disabled={busy || name.trim().length < 2} onClick={save}>{busy ? 'Saving…' : 'Save'}</button><button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button></div>
    </section>
  );
}
