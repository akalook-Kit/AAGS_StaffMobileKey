import { useState } from 'react';
import { useHotel } from '../App';
import { download } from '../api';
import { ErrorNote, PageHead, fmt, useApi } from '../ui';
import { Columns, DataTable, HBars, Kpi, VizCard } from '../components/charts';

const AREA: Record<string, string> = {
  overview: 'Overview', insights: 'Insights', access: 'Access history', events: 'Event log', monitoring: 'Monitoring', visionline: 'Visionline cards & people', staff: 'Staff', keys: 'Mobile keys',
  attendance: 'Time & attendance', breakfast: 'Breakfast', battery: 'Battery status', maintenance: 'Maintenance', operators: 'Operators', connector: 'Connector health', branding: 'Branding',
  settings: 'Settings', audit: 'Audit trail', account: 'Account', idcards: 'Staff ID cards', muster: 'Live occupancy', emergency: 'Emergency', usage: 'Usage', help: 'Help',
};
/** Minutes each outcome saves compared with doing it by hand in Visionline or on paper: starting points, change them. */
const MINUTES: Record<string, number> = {
  keysIssued: 4, keysRemoved: 2, cardReads: 3, reportsPrinted: 20, reportsExported: 15, reportsSaved: 10, directorySyncs: 0, alertsHandled: 5, maintenance: 5, attendanceRecords: 2,
  breakfastServed: 1, idCardsPrinted: 10, attendanceDoor: 1,
};

/**
 * 2.13 Is the portal worth it? Who uses it, which pages, and what it did (keys, lookups, reports, attendance
 * records…), with an estimate of the time saved. The supplier summary is anonymous (counts only) and signed.
 */
export function UsagePage() {
  const { base } = useHotel();
  const [days, setDays] = useState(30);
  const u = useApi<any>(`${base}/usage?days=${days}`, [days]);
  const [mins, setMins] = useState<Record<string, number>>(MINUTES);
  const [rate, setRate] = useState(() => { try { return Number(localStorage.getItem('smk.usage.rate')) || 0; } catch { return 0; } });
  const [error, setError] = useState<unknown>(null);
  const x = u.data;
  const saved = x ? x.outcomes.reduce((a: number, o: any) => a + o.n * (mins[o.id] ?? 0), 0) : 0;
  const views = x ? x.areas.reduce((a: number, r: any) => a + r.views, 0) : 0;
  const active = x ? x.people.filter((p: any) => p.views > 0).length : 0;
  return (
    <>
      <PageHead title="Usage" intro="Who uses the portal, what for, and how much work it takes off the team. Counted on this server only; nothing is sent anywhere.">
        <div className="seg" role="radiogroup" aria-label="Period">{[7, 30, 90, 365].map((d) => <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>{d === 365 ? '1 year' : `${d} days`}</button>)}</div>
        <button className="btn" onClick={() => download(`${base}/usage/export?days=${Math.max(days, 30)}`, `usage-summary.smkusage`).catch(setError)} title="Anonymous counts for your supplier, signed by this installation">Summary for the supplier</button>
      </PageHead>
      <ErrorNote error={error ?? u.error} />
      {x && (
        <>
          <div className="kpis">
            <Kpi label="People using it" value={`${active} of ${x.operators}`} sub={`${x.activeLast7Days} in the last 7 days`} />
            <Kpi label="Pages opened" value={views.toLocaleString()} sub={`${x.daily.length} active day(s)`} spark={x.daily.map((d: any) => d.views)} />
            <Kpi label="Time saved (estimate)" value={saved >= 120 ? `${Math.round(saved / 60)} h` : `${saved} min`} sub={rate ? `≈ ${Math.round((saved / 60) * rate).toLocaleString()} in staff cost` : 'from the minutes below'} />
            <Kpi label="Work done in the portal" value={x.outcomes.reduce((a: number, o: any) => a + o.n, 0).toLocaleString()} sub="keys, lookups, reports, records" />
          </div>
          <div className="grid12">
            <VizCard span={7} title="People per day" chart={<Columns points={x.daily.map((d: any) => ({ key: d.day, values: [d.people] }))} series={[{ name: 'People', color: 'var(--series-1)' }]} label={(k) => k.slice(5)} />}
              table={<DataTable head={['Day', 'People', 'Pages']} numeric={[1, 2]} rows={x.daily.map((d: any) => [d.day, d.people, d.views])} />} />
            <VizCard span={5} title="Most used pages" chart={<HBars rows={x.areas.slice(0, 10).map((a: any) => ({ key: a.area, label: AREA[a.area] ?? a.area, values: [a.views] }))} series={[{ name: 'Pages opened', color: 'var(--series-1)' }]} />}
              table={<DataTable head={['Page', 'Opened', 'People']} numeric={[1, 2]} rows={x.areas.map((a: any) => [AREA[a.area] ?? a.area, a.views, a.people])} />} />
          </div>
          <div className="cols" style={{ marginTop: 14 }}>
            <section className="panel">
              <h2>What it did</h2>
              <p className="small muted">Minutes saved per item, compared with doing it by hand in Visionline or on paper. Change them to match your hotel.</p>
              <table className="grid">
                <thead><tr><th>Outcome</th><th className="num">Count</th><th className="num">Min. each</th><th className="num">Saved</th></tr></thead>
                <tbody>{x.outcomes.map((o: any) => (
                  <tr key={o.id}><td>{o.label}</td><td className="num">{o.n}</td>
                    <td className="num"><input type="number" min={0} max={240} value={mins[o.id] ?? 0} onChange={(e) => setMins({ ...mins, [o.id]: Math.max(0, Number(e.target.value)) })} style={{ width: 64 }} aria-label={`Minutes for ${o.label}`} /></td>
                    <td className="num nowrap">{o.n * (mins[o.id] ?? 0)} min</td></tr>))}
                </tbody>
              </table>
              <div className="field" style={{ marginTop: 12, maxWidth: 260 }}><label htmlFor="rate">Staff cost per hour (optional)</label>
                <input id="rate" type="number" min={0} value={rate || ''} onChange={(e) => { const v = Number(e.target.value); setRate(v); try { localStorage.setItem('smk.usage.rate', String(v)); } catch { /* ignore */ } }} /></div>
            </section>
            <section className="panel flush">
              <h2 style={{ padding: '16px 20px 0' }}>People</h2>
              <table className="grid">
                <thead><tr><th>Name</th><th className="num">Days</th><th className="num">Pages</th><th>Uses most</th><th>Last sign-in</th></tr></thead>
                <tbody>{x.people.map((p: any) => (
                  <tr key={p.id}><td>{p.name}</td><td className="num">{p.activeDays}</td><td className="num">{p.views}</td><td className="small">{p.top.map((a: string) => AREA[a] ?? a).join(', ') || <span className="muted">—</span>}</td><td className="small">{fmt.rel(p.lastSignIn)}</td></tr>))}
                </tbody>
              </table>
            </section>
          </div>
          <p className="small muted">Pages are counted once a minute per person. The supplier summary contains counts only (no names, e-mails, guests or doors), is signed by this installation so it cannot be edited, and is sent only if you e-mail it.</p>
        </>
      )}
    </>
  );
}
