import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, download } from '../api';
import { useHotel } from '../App';
import { Drawer, ErrorNote, fmt, useApi } from '../ui';
import { PrintFrame } from '../components/PrintFrame';
import { DataTable, HBars, Kpi, Legend, Lines, SERIES, StatusBar, VizCard, fmtN, type BarRow } from '../components/charts';

/**
 * Insights: a Power BI–style report canvas for hotel management. One filter row scopes every visual below it
 * (period, Visionline user group, floor). Pages: Summary, Keycards & people, Locks & batteries, Maintenance,
 * Valid keycards. Every visual has a table view; exports are CSV.
 */
const PERIODS = [{ d: 1, l: 'Today' }, { d: 7, l: '7 days' }, { d: 30, l: '30 days' }, { d: 90, l: '90 days' }, { d: 180, l: '6 months' }, { d: 365, l: '12 months' }];
const PAGES = [
  { id: 'summary', l: 'Summary' }, { id: 'keycards', l: 'Keycards & people' }, { id: 'locks', l: 'Locks & batteries' }, { id: 'maintenance', l: 'Maintenance' }, { id: 'cards', l: 'Valid keycards' },
] as const;
type Page = (typeof PAGES)[number]['id'];
const SOURCE_LABEL: Record<string, string> = { expired: 'Expired at end time', operator: 'Revoked in the portal', visionline: 'Cancelled in Visionline', wrong_door: 'Wrong-door limit', replaced: 'Doors changed', other: 'Other' };
const CAT_LABEL: Record<string, string> = { battery: 'Lock battery', lock: 'Lock', door: 'Door', room: 'Room', electrical: 'Electrical', plumbing: 'Plumbing', other: 'Other' };
const STATUS_LABEL: Record<string, string> = { OPEN: 'Open', ACKNOWLEDGED: 'Acknowledged', IN_PROGRESS: 'In progress', ON_HOLD: 'On hold' };

export function InsightsPage() {
  const { base, can, hotel } = useHotel();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const days = Number(sp.get('days') ?? 30);
  const group = sp.get('group') ?? '';
  const floor = sp.get('floor') ?? '';
  const page = (sp.get('page') ?? 'summary') as Page;
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const qs = new URLSearchParams({ days: String(days), ...(group ? { group } : {}), ...(floor ? { floor } : {}) }).toString();
  const d = useApi<any>(`${base}/insights?${qs}`, [qs], 60_000);
  const [drill, setDrill] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [syncing, setSyncing] = useState(false);
  const data = d.data;
  const k = data?.kpis;
  const exp = (report: string) => download(`${base}/insights/export/${report}?${qs}`, `${hotel.slug}-${report}-${new Date().toISOString().slice(0, 10)}.csv`).catch(setError);
  const sync = async () => {
    setError(null); setSyncing(true);
    try { await api(`${base}/insights/sync`, { body: {} }); setTimeout(() => { void d.reload(); setSyncing(false); }, 6000); } catch (e) { setError(e); setSyncing(false); }
  };
  const dayLabel = (t: string) => {
    const dt = new Date(`${t}T12:00:00`);
    return data?.period?.bucket === 'week' ? `wk ${dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  const filtersOn = [group && `group ${group}`, floor && floor].filter(Boolean) as string[];
  const gf = group ? [`group ${group}`] : [];
  const ff = floor ? [floor] : [];

  const pageLabel = PAGES.find((p) => p.id === page)?.l ?? '';
  const periodLabel = PERIODS.find((p) => p.d === days)?.l ?? `${days} days`;
  return (
    <PrintFrame title={`Insights - ${pageLabel}`} subtitle={[`Period: ${periodLabel}`, ...filtersOn].join(' · ')}>
    <div className="insights">
      <div className="ins-head">
        <div>
          <h1>Insights</h1>
          <p className="muted">
            {hotel.name} · {PERIODS.find((p) => p.d === days)?.l.toLowerCase() ?? `${days} days`}{data?.period?.timeZone ? ` · ${data.period.timeZone} time` : ''}
            {data?.sync ? <> · Visionline people and keycards read {data.sync.lastSuccessAt ? fmt.rel(data.sync.lastSuccessAt) : 'not yet'}{data.sync.status === 'RUNNING' ? ' (reading now…)' : ''}</> : null}
          </p>
        </div>
        <div className="row no-print">
          {data?.modules?.directorySync && can('resources.discover') && <button className="btn" onClick={sync} disabled={syncing}>{syncing ? 'Reading Visionline…' : 'Read Visionline now'}</button>}
          <button className="btn" onClick={() => window.print()}>Print / PDF</button>
        </div>
      </div>

      {/* Slicers: one row above everything they scope. */}
      <div className="slicers no-print" role="group" aria-label="Filters">
        <div className="seg" role="group" aria-label="Period">{PERIODS.map((p) => <button key={p.d} aria-pressed={days === p.d} onClick={() => set('days', String(p.d))}>{p.l}</button>)}</div>
        <label className="slicer"><span>User group</span>
          <select value={group} onChange={(e) => set('group', e.target.value || null)}><option value="">All</option>{(data?.filters?.userGroups ?? []).map((g: string) => <option key={g}>{g}</option>)}</select></label>
        <label className="slicer"><span>Floor / door group</span>
          <select value={floor} onChange={(e) => set('floor', e.target.value || null)}><option value="">All</option>{(data?.filters?.floors ?? []).map((g: string) => <option key={g}>{g}</option>)}</select></label>
        {filtersOn.length > 0 && <button className="btn small ghost" onClick={() => { const n = new URLSearchParams(sp); n.delete('group'); n.delete('floor'); setSp(n, { replace: true }); }}>Clear filters</button>}
      </div>
      <ErrorNote error={error ?? d.error} />

      {k && (
        <div className={`kpis${d.loading ? ' stale' : ''}`}>
          <Kpi label="Valid keycards (Visionline)" value={k.validCards == null ? '—' : fmtN(k.validCards)}
            sub={k.validCards == null ? (data.modules.directorySync ? 'not read yet' : 'switch on in Settings → Reports & sync') : `${fmtN(k.validMobile)} are mobile keys`} onClick={() => set('page', 'cards')} />
          <Kpi label="Active mobile keys" value={fmtN(k.activeMobileKeys)} sub={`${k.staffWithPhone}/${k.staff} staff phones set up${k.expiring24h ? ` · ${k.expiring24h} end within 24 h` : ''}`} onClick={() => nav('/keys')} />
          <Kpi label="Keys issued" value={fmtN(k.keysIssued)} delta={{ now: k.keysIssued, prev: k.keysIssuedPrev }} upIsGood spark={data.trend.map((t: any) => t.keysIssued)} />
          <Kpi label="Lock alarms" value={fmtN(k.lockAlarms)} delta={{ now: k.lockAlarms, prev: k.lockAlarmsPrev }} sub={k.openLockAlarms ? `${k.openLockAlarms} not completed` : undefined}
            tone={k.openLockAlarms ? 'warn' : undefined} spark={data.trend.map((t: any) => t.alarms)} onClick={() => set('page', 'locks')} />
          <Kpi label="Refused at doors" value={fmtN(k.refusedAtDoors)} sub={k.wrongDoor ? `${k.wrongDoor} wrong-door attempts on mobile keys` : 'events 320–369 from the locks'} spark={data.trend.map((t: any) => t.denials)} />
          {data.modules.battery && <Kpi label="Lock batteries" value={`${k.batteryCritical + k.batteryLow}`} sub={`${k.batteryCritical} critical · ${k.batteryLow} low`} tone={k.batteryCritical ? 'bad' : k.batteryLow ? 'warn' : undefined} onClick={() => set('page', 'locks')} />}
          {data.modules.maintenance && <Kpi label="Open maintenance" value={fmtN(k.maintOpen)} sub={`${k.maintOverdue} overdue · ${k.maintUnassigned} unassigned`} tone={k.maintOverdue ? 'bad' : undefined} onClick={() => set('page', 'maintenance')} />}
          {data.modules.maintenance && <Kpi label="Time to resolve" value={k.maintAvgHours == null ? '—' : k.maintAvgHours >= 48 ? `${(k.maintAvgHours / 24).toFixed(1)} d` : `${Math.round(k.maintAvgHours)} h`}
            sub={k.maintResolved ? `${Math.round((k.maintOnTime / k.maintResolved) * 100)}% on time · ${k.maintResolved} resolved` : 'nothing resolved yet'} />}
        </div>
      )}

      <nav className="pages no-print" aria-label="Report pages">
        {PAGES.map((p) => <button key={p.id} aria-current={page === p.id ? 'page' : undefined} onClick={() => set('page', p.id)}>{p.l}</button>)}
      </nav>

      {data && (
        <div className={`canvas${d.loading ? ' stale' : ''}`}>
          {page === 'summary' && <Summary data={data} dayLabel={dayLabel} onGroup={setDrill} exp={exp} gf={gf} ff={ff} />}
          {page === 'keycards' && <Keycards data={data} dayLabel={dayLabel} onGroup={setDrill} exp={exp} gf={gf} />}
          {page === 'locks' && <Locks data={data} dayLabel={dayLabel} exp={exp} ff={ff} />}
          {page === 'maintenance' && <Maintenance data={data} dayLabel={dayLabel} exp={exp} ff={ff} />}
          {page === 'cards' && <ValidCards group={group} exp={exp} synced={data.cards != null} directoryOn={data.modules.directorySync} />}
        </div>
      )}
      {drill && <GroupDrill group={drill} onClose={() => setDrill(null)} />}
      <p className="small muted print-only">Printed {new Date().toLocaleString()} · {hotel.name} · Staff Mobile Key Insights{filtersOn.length ? ` · filtered: ${filtersOn.join(', ')}` : ''}</p>
    </div>
    </PrintFrame>
  );
}

const keySeries = [{ name: 'Issued', color: SERIES[0] }, { name: 'Ended', color: SERIES[1] }];

function Summary({ data, dayLabel, onGroup, exp, gf, ff }: any) {
  const groupRows: BarRow[] = (data.cards?.byGroup ?? []).map((g: any) => ({ key: g.group, label: g.group, values: [g.mobileKeys, g.otherCards] }));
  const lockRows: BarRow[] = data.locks.byDoor.slice(0, 8).map((r: any) => ({ key: r.doorId, label: r.name, values: [r.alarms, r.denials, r.battery] }));
  return (
    <div className="grid12">
      <VizCard span={8} title="Mobile keys over time" sub={`Keys issued and keys ended, per ${data.period.bucket}`} filtered={gf}
        chart={<><Legend series={keySeries} /><Lines points={data.trend.map((t: any) => ({ t: t.t, values: [t.keysIssued, t.keysEnded] }))} series={keySeries} label={dayLabel} /></>}
        table={<DataTable head={[data.period.bucket === 'week' ? 'Week of' : 'Day', 'Issued', 'Ended']} numeric={[1, 2]} rows={data.trend.map((t: any) => [dayLabel(t.t), t.keysIssued, t.keysEnded])} />} />
      <VizCard span={4} title="Lock batteries" sub={`${data.battery.doorsTracked} doors · median life ${data.battery.medianLifeDays ?? '—'} days`} filtered={ff}
        chart={data.modules.battery ? <BatteryStates b={data.battery} /> : <div className="viz-empty">Battery monitoring is switched off (Settings → Modules).</div>} />
      <VizCard span={6} title="Valid keycards by user group" sub="From Visionline · select a group to see the people" filtered={gf} actions={<button className="btn small ghost" onClick={() => exp('user-groups')}>CSV</button>}
        chart={data.cards ? <><Legend series={cardSeries} /><HBars rows={groupRows} series={cardSeries} onSelect={(r) => onGroup(r.key)} /></> : <NoSnapshot on={data.modules.directorySync} />}
        table={data.cards && <GroupTable rows={data.cards.byGroup} />} />
      <VizCard span={6} title="Busiest locks" sub="Alarms, refused entries and battery events per door" filtered={ff} actions={<button className="btn small ghost" onClick={() => exp('lock-activity')}>CSV</button>}
        chart={<><Legend series={lockSeries} /><HBars rows={lockRows} series={lockSeries} /></>} table={<LockTable rows={data.locks.byDoor} />} />
    </div>
  );
}

const cardSeries = [{ name: 'Mobile keys (this platform)', color: SERIES[0] }, { name: 'Other Visionline cards', color: SERIES[1] }];
const lockSeries = [{ name: 'Alarms', color: SERIES[0] }, { name: 'Refused entries', color: SERIES[1] }, { name: 'Battery events', color: SERIES[2] }];

function NoSnapshot({ on }: { on: boolean }) {
  return <div className="viz-empty">{on ? 'Visionline has not been read yet. Use "Read Visionline now", or wait for the scheduled read.' : <>People and keycards come from Visionline once the hotel switches it on: <Link to="/settings?tab=reports">Settings → Reports & sync</Link>.</>}</div>;
}
function GroupTable({ rows }: { rows: any[] }) {
  return <DataTable head={['User group', 'People', 'Valid cards', 'Mobile keys', 'Other cards', 'People without a card', 'Expiring in 7 days']} numeric={[1, 2, 3, 4, 5, 6]}
    rows={rows.map((g) => [g.group, g.people, g.validCards, g.mobileKeys, g.otherCards, g.peopleWithoutCard, g.expiring7d])} />;
}
function LockTable({ rows }: { rows: any[] }) {
  return <DataTable head={['Door', 'Group', 'Alarms', 'Not completed', 'Refused entries', 'Battery events']} numeric={[2, 3, 4, 5]} rows={rows.map((r) => [r.name, r.group, r.alarms, r.open, r.denials, r.battery])} />;
}
function BatteryStates({ b }: { b: any }) {
  return <StatusBar parts={[
    { label: 'critical', n: b.states.CRITICAL, tone: 'crit', icon: '!' }, { label: 'low', n: b.states.LOW, tone: 'warn', icon: '▾' },
    { label: 'good', n: b.states.GOOD, tone: 'good', icon: '✓' }, { label: 'reading only', n: b.states.REPORTED, tone: 'idle', icon: '·' },
    { label: 'never reported', n: b.states.NEVER, tone: 'none', icon: '○' },
  ]} />;
}

function Keycards({ data, dayLabel, onGroup, exp, gf }: any) {
  const deptRows: BarRow[] = data.keys.byDepartment.map((r: any) => ({ key: r.department, label: r.department, values: [r.activeKeys] }));
  const srcRows: BarRow[] = data.keys.revokeSources.map((r: any) => ({ key: r.source, label: SOURCE_LABEL[r.source] ?? r.source, values: [r.n] }));
  const t = data.cards?.totals;
  return (
    <div className="grid12">
      {t && <div className="span-12 facts">
        <Fact n={t.valid} l="valid keycards in Visionline" /><Fact n={t.mobile} l="are mobile keys from this platform" /><Fact n={t.expiring7d} l="expire within 7 days" tone={t.expiring7d ? 'warn' : undefined} />
        <Fact n={t.longValidity} l="valid for more than 6 months" tone={t.longValidity ? 'warn' : undefined} /><Fact n={t.broad} l="open 15 doors or more" /><Fact n={t.notEncoded} l="created but not encoded" />
      </div>}
      <VizCard span={6} title="Valid keycards by user group" sub="Select a group to see who holds which card" filtered={gf} actions={<button className="btn small ghost" onClick={() => exp('user-groups')}>CSV</button>}
        chart={data.cards ? <><Legend series={cardSeries} /><HBars rows={(data.cards.byGroup).map((g: any) => ({ key: g.group, label: g.group, values: [g.mobileKeys, g.otherCards] }))} series={cardSeries} onSelect={(r) => onGroup(r.key)} /></> : <NoSnapshot on={data.modules.directorySync} />}
        table={data.cards && <GroupTable rows={data.cards.byGroup} />} />
      <VizCard span={6} title="People per user group" sub="Everyone Visionline lists in each group, with or without a valid card" filtered={gf}
        chart={data.cards ? <><Legend series={peopleSeries} /><HBars rows={data.cards.byGroup.map((g: any) => ({ key: g.group, label: g.group, values: [g.people - g.peopleWithoutCard, g.peopleWithoutCard] }))} series={peopleSeries} onSelect={(r) => onGroup(r.key)} /></> : <NoSnapshot on={data.modules.directorySync} />}
        table={data.cards && <GroupTable rows={data.cards.byGroup} />} />
      <VizCard span={6} title="Active mobile keys by department" sub="Platform staff by job role" filtered={gf} actions={<button className="btn small ghost" onClick={() => exp('departments')}>CSV</button>}
        chart={<HBars rows={deptRows} series={[{ name: 'Active mobile keys', color: SERIES[0] }]} empty="No active mobile keys right now." />}
        table={<DataTable head={['Department', 'Staff', 'Phones set up', 'Active keys', 'Issued in period']} numeric={[1, 2, 3, 4]} rows={data.keys.byDepartment.map((r: any) => [r.department, r.staff, r.withPhone, r.activeKeys, r.issued])} />} />
      <VizCard span={6} title="Why keys ended" sub="Mobile keys that ended in the period" filtered={gf}
        chart={<HBars rows={srcRows} series={[{ name: 'Keys', color: SERIES[0] }]} />}
        table={<DataTable head={['Reason', 'Keys']} numeric={[1]} rows={data.keys.revokeSources.map((r: any) => [SOURCE_LABEL[r.source] ?? r.source, r.n])} />} />
      <VizCard span={8} title="Mobile keys over time" filtered={gf}
        chart={<><Legend series={keySeries} /><Lines points={data.trend.map((x: any) => ({ t: x.t, values: [x.keysIssued, x.keysEnded] }))} series={keySeries} label={dayLabel} /></>}
        table={<DataTable head={['Period', 'Issued', 'Ended']} numeric={[1, 2]} rows={data.trend.map((x: any) => [dayLabel(x.t), x.keysIssued, x.keysEnded])} />} />
      <VizCard span={4} title="Most used access templates" filtered={gf}
        chart={<HBars rows={data.keys.byTemplate.map((r: any) => ({ key: r.template, label: r.template, values: [r.n] }))} series={[{ name: 'Keys issued', color: SERIES[0] }]} />}
        table={<DataTable head={['Template', 'Keys issued']} numeric={[1]} rows={data.keys.byTemplate.map((r: any) => [r.template, r.n])} />} />
      {data.cards?.trend?.length > 1 && <VizCard span={12} title="Valid keycards over time" sub="One point per Visionline read" filtered={gf}
        chart={<><Legend series={cardTrendSeries} /><Lines points={data.cards.trend.map((x: any) => ({ t: x.at.slice(0, 10), values: [x.validCards, x.people] }))} series={cardTrendSeries} label={(t) => new Date(`${t}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} /></>} />}
    </div>
  );
}
const peopleSeries = [{ name: 'With a valid card', color: SERIES[0] }, { name: 'Without a valid card', color: SERIES[1] }];
const cardTrendSeries = [{ name: 'Valid cards', color: SERIES[0] }, { name: 'People', color: SERIES[1] }];

function Fact({ n, l, tone }: { n: number; l: string; tone?: 'warn' }) {
  return <div className={`fact${tone ? ` ${tone}` : ''}`}><strong>{fmtN(n)}</strong><span>{l}</span></div>;
}

function Locks({ data, dayLabel, exp, ff }: any) {
  const nav = useNavigate();
  const b = data.battery;
  const lockRows: BarRow[] = data.locks.byDoor.map((r: any) => ({ key: r.doorId, label: r.name, values: [r.alarms, r.denials, r.battery] }));
  const lifeBar = (days: number | null) => {
    if (days == null || !b.medianLifeDays) return null;
    const pct = Math.min(100, Math.round((days / (b.medianLifeDays * 2)) * 100));
    return <span className="lifebar" title={`${days} days (hotel median ${b.medianLifeDays})`}><i style={{ width: `${pct}%` }} /><b style={{ left: '50%' }} /></span>;
  };
  const alarmSeries = [{ name: 'Alarms', color: SERIES[0] }, { name: 'Refused entries', color: SERIES[1] }];
  return (
    <div className="grid12">
      <VizCard span={8} title="Lock activity by door" sub={`${data.locks.doorsWithActivity} doors had alarms, refused entries or battery events · top 15`} filtered={ff}
        actions={<button className="btn small ghost" onClick={() => exp('lock-activity')}>CSV</button>}
        chart={<><Legend series={lockSeries} /><HBars rows={lockRows} series={lockSeries} onSelect={data.modules.battery ? (r) => nav(`/battery/${encodeURIComponent(r.key)}`) : undefined} /></>}
        table={<LockTable rows={data.locks.byDoor} />} />
      <VizCard span={4} title="Alarm types" sub="Visionline alarms in the period" filtered={ff}
        chart={<HBars rows={data.locks.alarmTypes.map((r: any) => ({ key: r.type, label: r.type, values: [r.n] }))} series={[{ name: 'Alarms', color: SERIES[0] }]} empty="No Visionline alarms (or the alarms option is not licensed)." />}
        table={<DataTable head={['Type', 'Alarms']} numeric={[1]} rows={data.locks.alarmTypes.map((r: any) => [r.type, r.n])} />} />
      <VizCard span={8} title="Alarms and refused entries over time" filtered={ff}
        chart={<><Legend series={alarmSeries} /><Lines points={data.trend.map((x: any) => ({ t: x.t, values: [x.alarms, x.denials] }))} series={alarmSeries} label={dayLabel} /></>}
        table={<DataTable head={['Period', 'Alarms', 'Refused entries']} numeric={[1, 2]} rows={data.trend.map((x: any) => [dayLabel(x.t), x.alarms, x.denials])} />} />
      <VizCard span={4} title="Why doors refused a card" sub="Lock events" filtered={ff}
        chart={<HBars rows={data.locks.denialTypes.map((r: any) => ({ key: r.type, label: r.type, values: [r.n] }))} series={[{ name: 'Refusals', color: SERIES[1] }]} />}
        table={<DataTable head={['Reason', 'Refusals']} numeric={[1]} rows={data.locks.denialTypes.map((r: any) => [r.type, r.n])} />} />
      {data.modules.battery && <>
        <VizCard span={4} title="Battery state now" sub={`${b.doorsTracked} doors · ${b.states.STALE} with no report for a while`} filtered={ff} chart={<BatteryStates b={b} />} />
        <VizCard span={8} title="Locks draining batteries fastest" sub={b.medianLifeDays ? `Days from a battery exchange to the first "low" report. Hotel median: ${b.medianLifeDays} days (${b.cyclesMeasured} battery cycles measured).` : 'Needs at least one full battery cycle (exchange, then low) to compare.'}
          filtered={ff} actions={<button className="btn small ghost" onClick={() => exp('battery-life')}>CSV</button>}
          chart={<DataTable head={['Door', 'Group', 'Now', 'Last cycle', 'Average', 'Alarms (90 d)', 'Trend']} numeric={[3, 4, 5]}
            rows={b.draining.map((x: any) => [<Link key="d" to={`/battery/${encodeURIComponent(x.doorId)}`}>{x.name}</Link>, x.group, stateText(x.state),
              x.lifeDays != null ? <span className="lifecell">{x.lifeDays} d {lifeBar(x.lifeDays)}</span> : x.daysSinceExchange != null ? `low after ${x.daysSinceExchange} d` : '—',
              x.avgLifeDays != null ? `${x.avgLifeDays} d` : '—', x.alarms90, x.voltsPer30d != null ? `${x.voltsPer30d} V / month` : '—'])} />} />
        <VizCard span={6} title="Locks doing well" sub="Longest time since the last exchange, no low report and no alarm in 90 days" filtered={ff}
          chart={<DataTable head={['Door', 'Group', 'Since exchange', 'Reports']} numeric={[2, 3]} rows={b.healthy.map((x: any) => [x.name, x.group, `${x.daysSinceExchange} d`, x.reports])} />} />
        <VizCard span={6} title="Expected to need batteries soon" sub="Predicted from each lock's own past cycles, or the hotel median" filtered={ff}
          chart={<DataTable head={['Door', 'Group', 'Expected low', 'Since exchange']} numeric={[3]} rows={b.dueSoon.map((x: any) => [x.name, x.group, fmt.dt(x.predictedLowAt).replace(/,.*$/, ''), `${x.daysSinceExchange} d`])} />} />
      </>}
    </div>
  );
}
const stateText = (s: string) => ({ CRITICAL: '! Critical', LOW: '▾ Low', GOOD: '✓ Good', REPORTED: '· Reading', NEVER: '○ Never' } as Record<string, string>)[s] ?? s;

function Maintenance({ data, dayLabel, exp, ff }: any) {
  if (!data.modules.maintenance) return <div className="viz-empty panel">Maintenance is switched off (Settings → Modules).</div>;
  const m = data.maintenance;
  const flow = [{ name: 'Created', color: SERIES[0] }, { name: 'Resolved', color: SERIES[1] }];
  const open = [{ name: 'Open', color: SERIES[0] }];
  return (
    <div className="grid12">
      <VizCard span={8} title="Requests created and resolved" filtered={ff}
        chart={<><Legend series={flow} /><Lines points={data.trend.map((x: any) => ({ t: x.t, values: [x.maintCreated, x.maintResolved] }))} series={flow} label={dayLabel} /></>}
        table={<DataTable head={['Period', 'Created', 'Resolved']} numeric={[1, 2]} rows={data.trend.map((x: any) => [dayLabel(x.t), x.maintCreated, x.maintResolved])} />} />
      <VizCard span={4} title="Open requests by status" filtered={ff}
        chart={<HBars rows={m.byStatus.map((r: any) => ({ key: r.status, label: STATUS_LABEL[r.status] ?? r.status, values: [r.n] }))} series={open} empty="Nothing open." />}
        table={<DataTable head={['Status', 'Requests']} numeric={[1]} rows={m.byStatus.map((r: any) => [STATUS_LABEL[r.status] ?? r.status, r.n])} />} />
      <VizCard span={6} title="Requests by type" sub="Created in the period, and still open" filtered={ff}
        chart={<><Legend series={[{ name: 'Created and closed', color: SERIES[0] }, { name: 'Still open', color: SERIES[1] }]} />
          <HBars rows={m.byCategory.map((r: any) => ({ key: r.category, label: CAT_LABEL[r.category] ?? r.category, values: [Math.max(0, r.created - r.open), r.open] }))}
            series={[{ name: 'Created and closed', color: SERIES[0] }, { name: 'Still open', color: SERIES[1] }]} /></>}
        table={<DataTable head={['Type', 'Created', 'Open', 'Avg. hours to resolve']} numeric={[1, 2, 3]} rows={m.byCategory.map((r: any) => [CAT_LABEL[r.category] ?? r.category, r.created, r.open, r.avg_hours ?? '—'])} />} />
      <VizCard span={6} title="Average time to resolve, by type" sub="Hours from report to resolved" filtered={ff}
        chart={<HBars rows={m.byCategory.filter((r: any) => r.avg_hours != null).map((r: any) => ({ key: r.category, label: CAT_LABEL[r.category] ?? r.category, values: [Math.round(r.avg_hours)] }))} series={[{ name: 'Hours', color: SERIES[0] }]} unit=" h" />}
        table={<DataTable head={['Type', 'Avg. hours']} numeric={[1]} rows={m.byCategory.map((r: any) => [CAT_LABEL[r.category] ?? r.category, r.avg_hours ?? '—'])} />} />
      <VizCard span={12} title="Workload by person" filtered={ff} actions={<button className="btn small ghost" onClick={() => exp('maintenance-workload')}>CSV</button>}
        chart={<DataTable head={['Person', 'Open', 'Overdue', 'Resolved in period', 'Avg. hours to resolve']} numeric={[1, 2, 3, 4]}
          rows={m.workload.map((r: any) => [r.person, r.open, r.overdue ? <span className="overdue">{r.overdue}</span> : 0, r.resolved, r.avg_hours ?? '—'])} />} />
    </div>
  );
}

function ValidCards({ group, exp, synced, directoryOn }: { group: string; exp: (r: string) => void; synced: boolean; directoryOn: boolean }) {
  const { base } = useHotel();
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [expiring, setExpiring] = useState(false);
  useEffect(() => { const t = setTimeout(() => setQd(q), 250); return () => clearTimeout(t); }, [q]);
  const params = new URLSearchParams({ ...(group ? { group } : {}), ...(qd ? { q: qd } : {}), ...(expiring ? { expiringDays: '7' } : {}) });
  const list = useApi<any[]>(synced ? `${base}/insights/valid-cards?${params}` : null, [params.toString()]);
  if (!synced) return <div className="panel"><NoSnapshot on={directoryOn} /></div>;
  const rows = list.data ?? [];
  return (
    <section className="vizcard span-12">
      <header>
        <div><h2>Valid keycards</h2><p>{rows.length} cards{group ? ` in ${group}` : ''} · read from Visionline</p></div>
        <div className="row">
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={expiring} onChange={(e) => setExpiring(e.target.checked)} /> Expiring within 7 days</label>
          <input className="search" type="search" placeholder="Name, user id or reg. no." aria-label="Search cards" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn small" onClick={() => exp('valid-cards')}>CSV</button>
        </div>
      </header>
      <DataTable head={['Holder', 'User group', 'Card', 'Valid from', 'Valid until', 'Doors', 'Door groups']} numeric={[5]}
        rows={rows.map((r) => [<span key="h">{r.name}<span className="sub">{r.holder}</span></span>, r.group, <span key="c">{r.mobile ? 'Mobile key' : 'Visionline card'}<span className="sub">reg. no. {r.regNo}{r.notEncoded ? ' · not encoded' : ''}</span></span>,
          fmt.dt(r.from), <span key="u" className={new Date(r.until).getTime() < Date.now() + 7 * 86_400_000 ? 'overdue' : ''}>{fmt.dt(r.until)}</span>, r.doors, (r.doorGroups ?? []).join(', ') || '—'])} />
    </section>
  );
}

function GroupDrill({ group, onClose }: { group: string; onClose: () => void }) {
  const { base } = useHotel();
  const p = useApi<any[]>(`${base}/insights/user-groups/${encodeURIComponent(group)}`, [group]);
  const people = p.data ?? [];
  const withCard = useMemo(() => people.filter((x) => x.cards.length).length, [people]);
  return (
    <Drawer title={`${group} · ${people.length} people`} onClose={onClose}>
      <ErrorNote error={p.error} />
      <p className="muted">{withCard} of {people.length} hold a valid keycard. People are read from Visionline; "on the platform" means they also have a staff account here.</p>
      <DataTable head={['Person', 'Visionline user', 'Valid keycards', 'Until']}
        rows={people.map((x) => [<span key="n">{x.name}{x.onPlatform && <span className="sub">on the platform</span>}</span>, x.userId,
          x.cards.length ? x.cards.map((c: any) => `${c.mobile ? 'Mobile key' : 'Card'} ${c.regNo} (${c.doors} ${c.doors === 1 ? "door" : "doors"})`).join(', ') : <span key="c" className="muted">none</span>,
          x.cards.length ? fmt.dt(x.cards[x.cards.length - 1].until) : '—'])} />
    </Drawer>
  );
}
