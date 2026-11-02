import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useHotel } from '../App';
import { Columns, DataTable, Kpi, NoData, VizCard, useWidth } from '../components/charts';
import { Drawer, ErrorNote, PageHead, fmt, useApi } from '../ui';

/**
 * 2.18 Lock troubleshooting, mainly for offline locks: the event report of one lock (exported from Visionline) is
 * uploaded, checked, confirmed for a door and analysed: how often the door is used, how fast its batteries go down,
 * which faults it reports and what to do. Names, user IDs and card numbers in the file are never kept.
 */
interface Finding { level: 'high' | 'medium' | 'info'; title: string; detail: string; action?: string; area?: 'battery' | 'lock' | 'door' | 'use' | 'security' | 'data' }
interface Period { from: string; to: string; startedBy: 'exchange' | 'reading' | 'report'; firstVolts: number | null; lowestVolts: number | null; lowestAt: string | null; days: number; dropPer30Days: number | null; openings: number; dropPer1000Openings: number | null; alarms: number; reached?: { volts: number; days: number | null }[]; firmwareAlarms?: number }
interface Step { id: string; title: string; check: string; suggests: 'likely' | 'possible' | 'unlikely' | 'unknown'; evidence: string }
type Checks = Record<string, { result: 'ok' | 'problem'; note: string | null; by: string | null; at: string }>;
interface Week { week: string; openings: number; refused: number; leftOpen: number; internal: number; cardReading: number; restarts: number; batteryAlarms: number; lowest: number | null }
interface Analysis {
  period: { from: string | null; to: string | null; days: number }; window: { from: string | null; to: string | null; days: number; earlier: number };
  events: number; clockLost: number; verdict?: 'attention' | 'check' | 'ok'; actions?: { level: Finding['level']; text: string }[];
  quality?: { duplicates: number; invalidTimes: number; clockLost: number; future: number; dateOrder: string | null; ignoredReadings: number };
  usage: { openings: number; openedFromOutside: number; openedFromInside: number; mechanicalKey: number; staffCards: number; guestCards: number; refused: number; leftOpen: number; deadbolt: number; deadboltReleased?: number; perDay: number;
    byCardType?: { card: string; n: number }[]; hourly?: number[]; weekday?: number[]; busiestHours?: { h: number; n: number }[]; nightOpenings?: number };
  refusedBy?: { code: number; name: string; n: number; recent: number; meaning?: string | null; expected?: boolean }[];
  door?: { leftOpenRecent: number; longestOpenMinutes: number | null; medianOpenMinutes: number | null; openedWithoutCredential: string[] };
  faults: { internal: number; cardReading: number; ble: number; data: number; wrongSystem: number; restarts: number; restartsAfterBatteryChange?: number; coldStarts: number; accessDeniedBattery: number };
  service: { readouts: number; parametersRead?: number; timeSet: number; programDownloads: number; initialisations: number; lastReadout?: string | null; lastTimeSet?: string | null; lastProgram?: string | null };
  online?: { pings: number; lastPing: string | null; longestGapHours: number | null };
  battery: { readings: { t: string; volts: number }[]; ignoredReadings: number; alarms: { t: string; code: number; name: string }[]; exchanges: { t: string; how: string }[]; periods: Period[]; avgDropPer30Days: number | null; estimatedDaysPerSet: number | null; scale: string; alarmLevel: number;
    confirmLevel?: number; firmwareDays?: number; lasted?: { sets: { from: string; to: string; days: number }[]; avgDays: number | null; currentDays: number | null }; lastReading?: { t: string; volts: number } | null; firmwareAlarms?: { t: string; code: number; name: string; changedAt: string }[] };
  steps?: Step[]; weekly?: Week[]; daily: { day: string; openings: number }[]; findings: Finding[]; eventTypes: { code: number; name: string; n: number; last?: string | null; meaning?: string | null; internal?: boolean }[];
}
interface ReportRow { id: string; doorId: string; doorName: string; lockModel?: string | null; stepsLeft?: number; problemsFound?: number; fileName: string; from: string | null; to: string | null; events: number; uploadedAt: string; uploadedBy: string | null; avgDropPer30Days: number | null; perDay: number | null; high: number; medium: number; top: string | null }

/** Lock times are the lock's own wall-clock times ("2026-10-24T13:52"), shown as they are. */
const lt = (t: string | null | undefined, withTime = true) => {
  if (!t) return '—';
  const d = new Date(`${t}:00Z`);
  return d.toLocaleString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
};
const LEVEL: Record<Finding['level'], { label: string; cls: string }> = { high: { label: 'Act now', cls: 'bad' }, medium: { label: 'Check', cls: 'warn' }, info: { label: 'Good to know', cls: '' } };
const AREA: Record<NonNullable<Finding['area']>, string> = { battery: 'Battery', lock: 'Lock', door: 'Door', use: 'Use', security: 'Security', data: 'Service & data' };
const VERDICT = { attention: { cls: 'bad', text: 'This lock needs attention' }, check: { cls: 'warn', text: 'A few things to check' }, ok: { cls: 'ok', text: 'Nothing wrong found' } } as const;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SUGGESTS: Record<Step['suggests'], { label: string; cls: string }> = { likely: { label: 'Likely', cls: 'bad' }, possible: { label: 'Possible', cls: 'warn' }, unlikely: { label: 'Unlikely', cls: 'ok' }, unknown: { label: 'Check on site', cls: '' } };
const toB64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(r.error); r.readAsDataURL(f); });

export function LockTroubleshootPage() {
  const { reportId } = useParams();
  return reportId ? <ReportView id={reportId} /> : <ReportList />;
}

function Steps() {
  return (
    <ol className="small steps-inline">
      <li>Read the lock with the service device and upload its events to Visionline as usual.</li>
      <li>In Visionline, open the lock's events and save them as a report (.xls), for example "1115.xls".</li>
      <li>Upload the file here, check the dates and the door, and confirm.</li>
    </ol>
  );
}

function ReportList() {
  const { base, can } = useHotel();
  const list = useApi<ReportRow[]>(`${base}/lock-reports`, []);
  const att = useApi<any>(`${base}/attention`, []);
  const [upload, setUpload] = useState(false);
  const rows = list.data ?? [];
  return (
    <>
      <PageHead title="Lock troubleshooting" intro={<>Mainly for locks that are not online. Upload the event report of one lock to see how often it is used, how fast its batteries go down, which faults it reports and what to do. Names and card numbers in the file are not kept.</>}>
        {att.data?.batteryMonitoring && <Link className="btn" to="/battery">Battery status</Link>}
        {can('battery.manage') && <button className="btn primary" onClick={() => setUpload(true)}>Upload a lock report</button>}
      </PageHead>
      <ErrorNote error={list.error} />
      {!rows.length && !list.loading && (
        <div className="panel">
          <NoData text="No lock report yet" hint="Upload the events of a lock that drains its batteries or misbehaves." />
          <Steps />
        </div>
      )}
      {rows.length > 0 && (
        <div className="panel" style={{ padding: 0 }}>
          <table className="grid">
            <thead><tr><th>Door and lock</th><th>Events from – to</th><th>Findings</th><th>Causes left</th><th className="num">Openings a day</th><th className="num">Battery use (V / 30 days)</th><th>Uploaded</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/lock-troubleshoot/${r.id}`}><strong>{r.doorName}</strong></Link><div className="small muted">{r.lockModel ?? 'model not given'} · {r.fileName}</div></td>
                  <td className="small">{lt(r.from, false)} – {lt(r.to, false)}</td>
                  <td><div className="badges">{r.high > 0 && <span className="badge bad">{r.high} act now</span>}{r.medium > 0 && <span className="badge warn">{r.medium} to check</span>}{!r.high && !r.medium && <span className="badge ok">nothing found</span>}</div>{r.top && <div className="small muted" style={{ marginTop: 3 }}>{r.top}</div>}</td>
                  <td className="small">{r.problemsFound ? <span className="badge bad">{r.problemsFound} found</span> : null} {r.stepsLeft != null ? `${r.stepsLeft} to check` : '—'}</td>
                  <td className="num">{r.perDay ?? '—'}</td>
                  <td className="num">{r.avgDropPer30Days != null ? Number(r.avgDropPer30Days).toFixed(2) : '—'}</td>
                  <td className="small">{fmt.dt(r.uploadedAt)}{r.uploadedBy ? <div className="muted">{r.uploadedBy}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {upload && <UploadDrawer onClose={() => setUpload(false)} />}
    </>
  );
}

interface Preview { models?: Record<string, string>; lockModels?: { id: string; name: string }[]; doors?: { id: string; name: string; group: string | null }[]; duplicates?: number; events: number; dateOrder: 'MDY' | 'DMY' | 'YMD'; invalidTimes: number; period: { from: string | null; to: string | null; days: number }; window: { from: string | null; to: string | null }; clockLost: number; rooms: { room: string; n: number }[]; suggestedDoor: { id: string; name: string } | null; sample: { t: string; event: string }[]; findings: number }

function UploadDrawer({ onClose }: { onClose: () => void }) {
  const { base } = useHotel();
  const nav = useNavigate();
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [order, setOrder] = useState<Preview['dateOrder'] | null>(null);
  const [pv, setPv] = useState<Preview | null>(null);
  const [door, setDoor0] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const setDoor = (d: string, p: Preview | null = pv) => { setDoor0(d); const m = p?.models?.[d]; if (m) setModel(m); };
  const known = (pv?.doors ?? []).map((d) => ({ doorId: d.id, name: d.name, doorGroup: d.group })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const preview = async (f: { name: string; data: string }, o: Preview['dateOrder'] | null) => {
    setBusy(true); setError(null); setPv(null);
    try {
      const p = await api<Preview>(`${base}/lock-reports/preview`, { body: { fileName: f.name, data: f.data, ...(o ? { dateOrder: o } : {}) } });
      setPv(p); setOrder(p.dateOrder);
      if (!door && p.suggestedDoor) setDoor(p.suggestedDoor.id, p);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { setError(new Error('The file is larger than 10 MB.')); return; }
    const x = { name: f.name, data: await toB64(f) };
    setFile(x); setDoor(''); void preview(x, null);
  };
  const confirm = async () => {
    if (!file || !door || !model) return;
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string }>(`${base}/lock-reports`, { body: { fileName: file.name, data: file.data, dateOrder: order, doorId: door, doorName: known.find((d) => d.doorId === door)?.name, lockModel: model } });
      nav(`/lock-troubleshoot/${r.id}`);
    } catch (e) { setError(e); setBusy(false); }
  };
  return (
    <Drawer title="Upload a lock report" onClose={onClose} footer={<><span /><div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !pv || !door || !model} onClick={confirm}>{busy && pv ? 'Analysing…' : 'Confirm and analyse'}</button></div></>}>
      <Steps />
      <div className="field"><label htmlFor="lr-file">Lock event report (.xls as saved by Visionline, .txt or .csv)</label>
        <input id="lr-file" type="file" accept=".xls,.txt,.csv,.tsv,text/plain,text/csv" onChange={(e) => pick(e.target.files?.[0])} /></div>
      <ErrorNote error={error} />
      {busy && !pv && <p className="small muted">Reading the file…</p>}
      {pv && (
        <>
          <div className="alert ok" style={{ marginTop: 6 }}>
            <strong>{pv.events.toLocaleString()} lock events</strong> from {lt(pv.period.from, false)} to {lt(pv.period.to, false)}.
            {pv.clockLost > 0 && <> {pv.clockLost} more are dated before 2000 (the lock lost its clock).</>}
            {pv.invalidTimes > 0 && <> {pv.invalidTimes} without a readable time.</>}
            {(pv.duplicates ?? 0) > 0 && <> {pv.duplicates} rows read twice are counted once.</>}
          </div>
          <div className="field"><label>Dates in the file</label>
            <div className="seg">{(['MDY', 'DMY'] as const).map((o) => <button key={o} type="button" aria-pressed={order === o} onClick={() => { setOrder(o); if (file) void preview(file, o); }}>{o === 'MDY' ? 'Month/day (10/24/2026)' : 'Day/month (24/10/2026)'}</button>)}</div>
            <span className="hint">Check that the newest events below are right; switch if day and month are swapped.</span></div>
          <table className="grid small" style={{ marginBottom: 10 }}><tbody>{pv.sample.map((s, i) => <tr key={i}><td style={{ whiteSpace: 'nowrap' }}>{lt(s.t)}</td><td>{s.event}</td></tr>)}</tbody></table>
          <div className="field"><label htmlFor="lr-door">Which door is this lock?</label>
            <select id="lr-door" value={door} onChange={(e) => setDoor(e.target.value)}>
              <option value="">Choose the door…</option>
              {known.map((d) => <option key={d.doorId} value={d.doorId}>{d.name}{d.doorGroup ? ` · ${d.doorGroup}` : ''}</option>)}
            </select>
            <span className="hint">{pv.suggestedDoor ? <>Suggested from the file: <strong>{pv.suggestedDoor.name}</strong> (the room most cards in it belong to).</> : pv.rooms.length ? <>Rooms named in the file: {pv.rooms.slice(0, 3).map((r) => r.room).join(', ')}.</> : 'The file does not name the room.'}</span></div>
          <div className="field"><label htmlFor="lr-model">Which lock model?</label>
            <select id="lr-model" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Choose the model…</option>
              {(pv.lockModels ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <span className="hint">{door && pv.models?.[door] ? 'Remembered from an earlier report of this door.' : 'Remembered for this door next time.'}</span></div>
          {door && pv.rooms[0] && known.find((d) => d.doorId === door)?.name !== pv.rooms[0].room && <div className="alert warn">The file is mostly about <strong>{pv.rooms[0].room}</strong>, not the door chosen. Check that this is the right lock.</div>}
          <p className="small muted">Names, user IDs, card numbers, card serial numbers and "issued by" in the file are not kept: only times, events and card types.</p>
        </>
      )}
    </Drawer>
  );
}

function ReportView({ id }: { id: string }) {
  const { base, can, hotel } = useHotel();
  const nav = useNavigate();
  const r = useApi<{ id: string; doorId: string; doorName: string; lockModel: string | null; lockModelName: string | null; checks: Checks; fileName: string; uploadedAt: string; uploadedBy: string | null; analysis: Analysis; others: { id: string; uploadedAt: string; to: string | null; avgDropPer30Days: number | null }[] }>(`${base}/lock-reports/${id}`, [id]);
  const att = useApi<any>(`${base}/attention`, []);
  const [error, setError] = useState<unknown>(null);
  const [ticket, setTicket] = useState<{ number: number; id: string } | null>(null);
  const x = r.data?.analysis;
  if (!r.data || !x) return <><PageHead title="Lock troubleshooting" /><ErrorNote error={r.error} />{r.loading && <p className="muted">Loading…</p>}</>;
  const b = x.battery;
  const act = x.findings.filter((f) => f.level !== 'info');
  const openTicket = async () => {
    setError(null);
    try {
      const lines = act.map((f) => `- ${f.title}: ${f.detail}${f.action ? ` What to do: ${f.action}` : ''}`).join('\n');
      const t = await api<{ id: string; number: number }>(`${base}/maintenance/tickets`, { body: {
        title: `Lock check: ${r.data!.doorName}`.slice(0, 120), category: 'lock', priority: act.some((f) => f.level === 'high') ? 'high' : 'normal', doorId: r.data!.doorId,
        description: `From the lock report ${r.data!.fileName} (events ${lt(x.period.from, false)} – ${lt(x.period.to, false)}).\n\n${lines}`.slice(0, 4000) } });
      setTicket(t);
    } catch (e) { setError(e); }
  };
  const del = async () => { if (!confirm('Delete this lock report?')) return; try { await api(`${base}/lock-reports/${id}`, { method: 'DELETE' }); nav('/lock-troubleshoot'); } catch (e) { setError(e); } };
  return (
    <div className="lock-report">
      <PageHead title={`Lock ${r.data.doorName}`} intro={<><strong>{r.data.lockModelName ?? 'Lock model not given'}</strong> · door {r.data.doorName}. Events from {lt(x.period.from, false)} to {lt(x.period.to, false)} ({x.events.toLocaleString()} events, file {r.data.fileName}). Uploaded {fmt.dt(r.data.uploadedAt)}{r.data.uploadedBy ? ` by ${r.data.uploadedBy}` : ''}.{x.window.earlier > 0 && <> Rates use the last {Math.round(x.window.days)} days ({lt(x.window.from, false)} onwards); {x.window.earlier} older events are counted in the totals only.</>}</>}>
        <Link className="btn no-print" to="/lock-troubleshoot">All lock reports</Link>
        <button className="btn no-print" onClick={() => window.print()}>Print</button>
        {can('maintenance.work') && att.data?.maintenance && act.length > 0 && (ticket
          ? <Link className="btn no-print" to={`/maintenance/${ticket.id}`}>Request #{ticket.number}</Link>
          : <button className="btn primary no-print" onClick={openTicket}>Open a maintenance request</button>)}
        {can('battery.manage') && <button className="btn ghost no-print" onClick={del}>Delete</button>}
      </PageHead>
      <div className="print-only small">{hotel?.name} · Lock troubleshooting · printed {new Date().toLocaleString()}</div>
      <ErrorNote error={error} />
      {x.verdict && (
        <section className={`panel verdict v-${x.verdict}`}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2 style={{ margin: 0 }}><span className={`badge ${VERDICT[x.verdict].cls}`}>{VERDICT[x.verdict].text}</span></h2>
            <span className="small muted">{x.findings.filter((f) => f.level === 'high').length} to act on now · {x.findings.filter((f) => f.level === 'medium').length} to check</span>
          </div>
          {(x.actions ?? []).length > 0 && <>
            <h3 className="section-title" style={{ marginTop: 12 }}>What to do, in this order</h3>
            <ol className="lr-todo">{x.actions!.map((a, i) => <li key={i} className={`t-${a.level}`}>{a.text}</li>)}</ol>
          </>}
        </section>
      )}
      <div className="kpis">
        <Kpi label="Openings a day" value={String(x.usage.perDay)} sub={`${x.usage.staffCards} staff · ${x.usage.guestCards} guest card · ${x.usage.openedFromInside} from inside`} />
        <Kpi label="Battery use" value={b.avgDropPer30Days != null ? `${b.avgDropPer30Days.toFixed(2)} V` : '—'} sub={b.avgDropPer30Days != null ? 'per 30 days (average of the battery periods)' : 'not enough readings in the report'} tone={b.estimatedDaysPerSet != null && b.estimatedDaysPerSet < 90 ? 'bad' : undefined} />
        {b.lasted && (b.lasted.sets.length > 0 || b.lasted.currentDays != null)
          ? <Kpi label={b.lasted.sets.length ? 'Sets lasted' : 'Batteries in for'} value={b.lasted.sets.length ? `${b.lasted.sets.map((x) => Math.round(x.days)).join(' · ')} days` : `${Math.round(b.lasted.currentDays!)} days`}
              sub={b.lasted.sets.length ? `change to change${b.lasted.avgDays != null && b.lasted.sets.length > 1 ? `, average ${Math.round(b.lasted.avgDays)} days` : ''}${b.lasted.currentDays != null ? `; current set in for ${Math.round(b.lasted.currentDays)} days` : ''}` : 'since the last change in the report'}
              tone={b.lasted.avgDays != null && b.lasted.avgDays < 90 ? 'bad' : undefined} />
          : <Kpi label="A set lasts about" value={b.estimatedDaysPerSet != null ? `${b.estimatedDaysPerSet} days` : '—'} sub={`rough estimate, from new to ${b.alarmLevel.toFixed(1)} V at this rate`} tone={b.estimatedDaysPerSet != null && b.estimatedDaysPerSet < 90 ? 'bad' : undefined} />}
        <Kpi label="Last battery reading" value={b.lastReading ? `below ${b.lastReading.volts.toFixed(1)} V` : '—'} sub={b.lastReading ? lt(b.lastReading.t) : 'no reading in the report'} tone={b.lastReading && b.lastReading.volts <= (b.confirmLevel ?? 4.2) ? 'warn' : undefined} />
        <Kpi label="Lock faults" value={String(x.faults.internal + x.faults.cardReading + x.faults.ble + x.faults.restarts)} sub={`${x.faults.internal} internal · ${x.faults.cardReading} card reading · ${x.faults.restarts} restarts`} tone={x.faults.internal >= 5 ? 'warn' : undefined} />
      </div>
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>What we found</h2>
        <div className="findings">
          {x.findings.map((f, i) => (
            <article key={i} className={`finding f-${f.level}`}>
              <div><span className={`badge ${LEVEL[f.level].cls}`}>{LEVEL[f.level].label}</span>{f.area && <div className="small muted" style={{ marginTop: 4 }}>{AREA[f.area]}</div>}</div>
              <div><strong>{f.title}</strong><p>{f.detail}</p>{f.action && <p className="f-action"><b>What to do:</b> {f.action}</p>}</div>
            </article>
          ))}
        </div>
      </section>
      {(x.steps ?? []).length > 0 && <Elimination id={id} steps={x.steps!} initial={r.data.checks ?? {}} canMark={can('maintenance.work')} />}
      <h2 className="section-title">Battery</h2>
      <div className="grid12">
        <VizCard span={12} title="Battery readings" sub={`"Battery level below X volts" events of the lock (${b.scale} scale). Dashed lines: new batteries.${b.ignoredReadings ? ` ${b.ignoredReadings} readings taken while the lock was being programmed or restarting are left out.` : ''}`}
          chart={<VoltChart a={x} />}
          table={<DataTable head={['Lock time', 'Below (V)']} numeric={[1]} rows={[...b.readings].reverse().map((p) => [lt(p.t), p.volts.toFixed(1)])} />} />
        <VizCard span={12} title="Battery periods" sub={<>From one battery change to the next. Consumption = drop from the first to the lowest reading of the period.{(b.firmwareAlarms ?? []).length > 0 && <> {b.firmwareAlarms!.length} battery alarm(s) came within {b.firmwareDays ?? 14} days after new batteries while the readings stayed above {(b.confirmLevel ?? 3.6).toFixed(1)} V: a firmware fault, not counted as battery alarms.</>}</>}
          chart={<DataTable head={['From', 'Started by', 'Days in the lock', 'First (V)', 'Lowest (V)', ...(b.periods[0]?.reached ?? []).map((r) => `Days to ${r.volts.toFixed(1)} V`), 'V / 30 days', 'Openings', 'V / 1,000 openings', 'Battery alarms', 'Alarms from firmware']}
            numeric={[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]}
            rows={b.periods.map((p) => [lt(p.from, false), p.startedBy === 'exchange' ? 'Battery exchanged' : p.startedBy === 'reading' ? 'Reading back at the top' : 'Start of the report', p.days, p.firstVolts?.toFixed(1) ?? null, p.lowestVolts?.toFixed(1) ?? null,
              ...(p.reached ?? []).map((r) => (p.startedBy === 'report' ? '—' : r.days ?? 'not reached')), p.dropPer30Days?.toFixed(2) ?? null, p.openings, p.dropPer1000Openings?.toFixed(2) ?? null, p.alarms, p.firmwareAlarms ?? 0])} />} />
        {(b.firmwareAlarms ?? []).length > 0 && <VizCard span={12} title="Battery alarms after new batteries (firmware fault)" sub="Not a battery problem: program the lock and upload its firmware."
          chart={<DataTable head={['Lock time', 'Event', 'Batteries changed']} rows={[...b.firmwareAlarms!].reverse().slice(0, 60).map((a) => [lt(a.t), `${a.name} (${String(a.code).padStart(4, '0')})`, lt(a.changedAt)])} />} />}
        {b.alarms.length > 0 && <VizCard span={12} title="Battery alarms that count" sub="Battery alarms before a battery change, or confirmed by a low reading."
          chart={<DataTable head={['Lock time', 'Event']} rows={[...b.alarms].reverse().slice(0, 60).map((a) => [lt(a.t), `${a.name} (${String(a.code).padStart(4, '0')})`])} />} />}
      </div>
      <h2 className="section-title">Lock and door</h2>
      <div className="grid12">
        {(x.weekly ?? []).length > 0 && <VizCard span={12} title="Week by week" sub="Weeks start on Monday (lock time). Restarts right after a battery change are not counted."
          chart={<DataTable head={['Week of', 'Openings', 'Refused', 'Left open', 'Internal errors', 'Card errors', 'Restarts', 'Battery alarms', 'Lowest reading (V)']} numeric={[1, 2, 3, 4, 5, 6, 7, 8]}
            rows={x.weekly!.map((w) => [lt(`${w.week}T00:00`, false), w.openings, w.refused, w.leftOpen, w.internal, w.cardReading, w.restarts, w.batteryAlarms, w.lowest?.toFixed(1) ?? '—'])} />} />}
        <VizCard span={6} title="Faults" chart={<DataTable head={['', 'Times']} numeric={[1]} rows={[
          ['Internal error (1975)', x.faults.internal], ['Card reading errors', x.faults.cardReading], ['Bluetooth errors', x.faults.ble], ['Communication / data errors', x.faults.data],
          ['Cards of another system', x.faults.wrongSystem], ['Restarts', x.faults.restarts], ['  of which cold starts', x.faults.coldStarts], ['Restarts right after new batteries (normal)', x.faults.restartsAfterBatteryChange ?? 0],
          ['Access denied for battery', x.faults.accessDeniedBattery], ['Clock lost (events before 2000)', x.clockLost]]} />} />
        <VizCard span={6} title="Door" chart={<DataTable head={['', '']} numeric={[1]} rows={[
          ['Left open too long (whole report)', x.usage.leftOpen], [`  in the last ${Math.round(x.window.days)} days`, x.door?.leftOpenRecent ?? '—'], ['Longest time open (minutes)', x.door?.longestOpenMinutes ?? '—'], ['Typical time open (minutes)', x.door?.medianOpenMinutes ?? '—'],
          ['Opened from outside with no card or key just before', x.door?.openedWithoutCredential.length ?? '—'], ['Metal key used (open or lock)', x.usage.mechanicalKey], ['Double lock on from inside (deadbolt thrown)', x.usage.deadbolt], ['Double lock off (deadbolt released)', x.usage.deadboltReleased ?? '—']]} />} />
        {(x.door?.openedWithoutCredential.length ?? 0) > 0 && <VizCard span={6} title="Opened from outside with no card or key just before" sub="Usually the latch did not catch; check these times against the door's use."
          chart={<DataTable head={['Lock time']} rows={[...x.door!.openedWithoutCredential].reverse().slice(0, 30).map((t) => [lt(t)])} />} />}
        {(x.refusedBy ?? []).length > 0 && <VizCard span={12} title="Entries refused, by reason" sub="A refusal is the lock doing its job: the card was expired, had no right to this door, or the double lock was on. It is a card or rights matter, not a lock fault."
          chart={<DataTable head={['Reason', 'Code', 'Times', `Last ${Math.round(x.window.days)} days`, 'What it means']} numeric={[2, 3]} rows={x.refusedBy!.map((r) => [r.name.replace(/^Error, /, ''), String(r.code).padStart(4, '0'), r.n, r.recent, r.meaning ?? '—'])} />} />}
      </div>
      <h2 className="section-title">Use</h2>
      <div className="grid12">
        <VizCard span={8} title="Openings a day" sub={`Last ${Math.round(x.window.days)} days, lock time`}
          chart={<Columns points={x.daily.map((d) => ({ key: d.day, values: [d.openings] }))} series={[{ name: 'Openings', color: 'var(--series-1)' }]} label={(k) => new Date(`${k}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short' })} />}
          table={<DataTable head={['Day', 'Openings']} numeric={[1]} rows={x.daily.map((d) => [d.day, d.openings])} />} />
        <VizCard span={4} title="Cards used" sub="Accepted cards by card type (no names are kept)." chart={<DataTable head={['Card type', 'Times']} numeric={[1]} rows={(x.usage.byCardType ?? []).map((c) => [c.card, c.n])} />} />
        {x.usage.hourly && <VizCard span={8} title="Openings by hour" sub={`Last ${Math.round(x.window.days)} days${x.usage.nightOpenings ? ` · ${x.usage.nightOpenings} between 00:00 and 06:00` : ''}`}
          chart={<Columns points={x.usage.hourly.map((n, h) => ({ key: String(h), values: [n] }))} series={[{ name: 'Openings', color: 'var(--series-1)' }]} label={(k) => `${k.padStart(2, '0')}h`} />}
          table={<DataTable head={['Hour', 'Openings']} numeric={[1]} rows={x.usage.hourly.map((n, h) => [`${String(h).padStart(2, '0')}:00`, n])} />} />}
        {x.usage.weekday && <VizCard span={4} title="Openings by weekday" chart={<DataTable head={['Day', 'Openings']} numeric={[1]} rows={[1, 2, 3, 4, 5, 6, 0].map((d) => [WEEKDAYS[d]!, x.usage.weekday![d] ?? 0])} />} />}
      </div>
      <h2 className="section-title">Service and data</h2>
      <div className="grid12">
        <VizCard span={6} title="Service device and online connection" chart={<DataTable head={['', '']} rows={[
          ['Read with the service device', `${x.service.readouts} times${x.service.lastReadout ? ` · last ${lt(x.service.lastReadout)}` : ''}`],
          ['Time set', `${x.service.timeSet} times${x.service.lastTimeSet ? ` · last ${lt(x.service.lastTimeSet)}` : ''}`],
          ['Program uploaded', `${x.service.programDownloads} times${x.service.lastProgram ? ` · last ${lt(x.service.lastProgram)}` : ''}`],
          ['Initialised', `${x.service.initialisations} time${x.service.initialisations === 1 ? '' : 's'}`],
          ['Pings from the server (online lock)', x.online?.pings ? `${x.online.pings} · last ${lt(x.online.lastPing)}` : 'none (offline lock)']]} />} />
        <VizCard span={6} title="About this report" chart={<DataTable head={['', '']} rows={[
          ['Events read', x.events.toLocaleString()], ['Period', `${lt(x.period.from, false)} – ${lt(x.period.to, false)}`],
          ['Rows read twice, counted once', x.quality?.duplicates ?? '—'], ['Events with the lock clock lost (before 2000)', x.clockLost], ['Events dated in the future', x.quality?.future ?? '—'],
          ['Rows without a readable time', x.quality?.invalidTimes ?? '—'], ['Battery readings left out (during programming/restart)', b.ignoredReadings],
          ['Dates read as', x.quality?.dateOrder === 'DMY' ? 'day/month' : x.quality?.dateOrder === 'YMD' ? 'year-month-day' : 'month/day']]} />} />
        <VizCard span={12} title="All events in the report" sub={'Most frequent first. "Door Unit Internal" events are the lock\'s own, mostly mechanical events (door opened or closed, double lock on or off). (*) in Visionline marks some events; they are counted the same.'}
          chart={<DataTable head={['Event', 'Code', 'Times', 'Last', 'What it means']} numeric={[2]} rows={x.eventTypes.map((e) => [<>{e.name || '(no name)'}{e.internal ? <div className="small muted">Door unit internal</div> : null}</>, String(e.code).padStart(4, '0'), e.n, e.last ? lt(e.last) : '—', e.meaning ?? '—'])} />} />
      </div>
      {r.data.others.length > 0 && <p className="small muted">Earlier reports for this door: {r.data.others.map((o, i) => <span key={o.id}>{i ? ' · ' : ''}<Link to={`/lock-troubleshoot/${o.id}`}>{fmt.dt(o.uploadedAt)}</Link>{o.avgDropPer30Days != null ? ` (${Number(o.avgDropPer30Days).toFixed(2)} V / 30 days)` : ''}</span>)}</p>}
    </div>
  );
}

/** Voltage steps over time, one axis in volts, with the battery changes and the alarm level marked. */
function VoltChart({ a }: { a: Analysis }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pts = a.battery.readings;
  const dom = useMemo(() => {
    if (!pts.length) return null;
    const t0 = Date.parse(`${a.window.from ?? pts[0]!.t}:00Z`), t1 = Math.max(t0 + 3_600_000, Date.parse(`${a.window.to ?? pts[pts.length - 1]!.t}:00Z`));
    const high = a.battery.scale.startsWith('6');
    return { t0, t1, vmin: high ? 6.4 : Math.min(3.6, ...pts.map((p) => p.volts - 0.2)), vmax: high ? 9.2 : 5.0 };
  }, [pts, a.window.from, a.window.to, a.battery.scale]);
  if (!dom) return <NoData text="No battery readings in this report" hint="The lock reports a reading each time its battery passes a level." />;
  const H = 230, L = 40, R = 12, T = 12, B = 26, pw = Math.max(80, w - L - R), ph = H - T - B;
  const x = (t: string) => L + ((Date.parse(`${t}:00Z`) - dom.t0) / (dom.t1 - dom.t0)) * pw;
  const y = (v: number) => T + ph - ((v - dom.vmin) / (dom.vmax - dom.vmin)) * ph;
  const ticks: number[] = []; for (let v = Math.ceil(dom.vmin * 2) / 2; v <= dom.vmax + 1e-9; v += a.battery.scale.startsWith('6') ? 0.5 : 0.2) ticks.push(Math.round(v * 10) / 10);
  const path = pts.map((p, i) => `${i ? `H${x(p.t)}V` : `M${x(p.t)},`}${y(p.volts)}`).join(' ');
  const days = (dom.t1 - dom.t0) / 86_400_000;
  const xt: string[] = []; const step = Math.max(1, Math.ceil(days / Math.max(2, Math.floor(pw / 90))));
  for (let d = 0; d <= days; d += step) xt.push(new Date(dom.t0 + d * 86_400_000).toISOString().slice(0, 16));
  const hp = hover != null ? pts[hover] : null;
  return (
    <div ref={ref} className="viz" onMouseLeave={() => setHover(null)}>
      <svg width={w} height={H} role="img" aria-label="Battery readings over time"
        onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const px = e.clientX - r.left; let best = 0; pts.forEach((p, i) => { if (Math.abs(x(p.t) - px) < Math.abs(x(pts[best]!.t) - px)) best = i; }); setHover(best); }}>
        {ticks.map((v) => <g key={v}><line x1={L} x2={L + pw} y1={y(v)} y2={y(v)} className="viz-grid" /><text x={L - 6} y={y(v)} className="viz-tick" textAnchor="end" dominantBaseline="central">{v.toFixed(1)}</text></g>)}
        {xt.map((t, i) => <text key={t} x={x(t)} y={H - 8} className="viz-tick" textAnchor={i === 0 ? 'start' : 'middle'}>{lt(t, false).replace(/,? \d{4}$/, '')}</text>)}
        <line x1={L} x2={L + pw} y1={y(a.battery.alarmLevel)} y2={y(a.battery.alarmLevel)} stroke="var(--bad)" strokeDasharray="2 4" strokeWidth={1} />
        <text x={L + pw} y={y(a.battery.alarmLevel) - 4} className="viz-tick" textAnchor="end">usual low-battery level {a.battery.alarmLevel.toFixed(1)} V</text>
        {a.battery.exchanges.map((c) => <g key={c.t}><line x1={x(c.t)} x2={x(c.t)} y1={T} y2={T + ph} stroke="var(--ok, #2f7d4a)" strokeDasharray="4 3" strokeWidth={1.5} /><text x={x(c.t) + 4} y={T + 10} className="viz-tick">new batteries</text></g>)}
        <path d={path} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />
        {pts.map((p, i) => <circle key={i} cx={x(p.t)} cy={y(p.volts)} r={hover === i ? 5 : 2.5} fill="var(--series-1)"><title>{`${lt(p.t)}: below ${p.volts.toFixed(1)} V`}</title></circle>)}
      </svg>
      {hp && <div className="viz-tip" style={{ left: Math.min(x(hp.t) + 10, w - 190), top: 4 }} role="status"><div className="viz-tip-t">{lt(hp.t)}</div><div className="viz-tip-r"><strong>below {hp.volts.toFixed(1)} V</strong></div></div>}
    </div>
  );
}

/** 2.19 Elimination method: the usual causes, simplest first; the technician marks each one checked on the door. */
function Elimination({ id, steps, initial, canMark }: { id: string; steps: Step[]; initial: Checks; canMark: boolean }) {
  const { base } = useHotel();
  const [checks, setChecks] = useState<Checks>(initial);
  const [notes, setNotes] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v.note ?? ''])));
  const [error, setError] = useState<unknown>(null);
  const mark = async (step: string, result: 'ok' | 'problem' | 'not_checked') => {
    setError(null);
    try { const r = await api<{ checks: Checks }>(`${base}/lock-reports/${id}/checks/${step}`, { method: 'PUT', body: { result, note: notes[step] || undefined } }); setChecks(r.checks); }
    catch (e) { setError(e); }
  };
  const found = steps.filter((x) => checks[x.id]?.result === 'problem');
  const left = steps.filter((x) => !checks[x.id] && (x.suggests === 'likely' || x.suggests === 'possible' || x.suggests === 'unknown'));
  const done = steps.filter((x) => checks[x.id]?.result === 'ok').length;
  return (
    <section className="panel elim">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>Find the cause, step by step</h2>
        <span className="small muted">{done} ruled out · {found.length} problem{found.length === 1 ? '' : 's'} found · {left.length} left to check</span>
      </div>
      <p className="small muted" style={{ margin: '6px 0 10px' }}>Check each point on the door, simplest first, and mark it. What the report shows is given for each; a firmware fault can also drain batteries, so rule out the other causes before blaming the batteries.</p>
      {found.length > 0 && <div className="alert bad">Problem found: {found.map((x) => x.title).join(', ')}. Fix it, then upload a new report of this lock in a few weeks to confirm.</div>}
      <ErrorNote error={error} />
      <ol className="elim-steps">
        {steps.map((st) => {
          const c = checks[st.id];
          return (
            <li key={st.id} className={`elim-step${c ? ` is-${c.result}` : ''}`}>
              <div className="elim-head"><strong>{st.title}</strong><span className={`badge ${SUGGESTS[st.suggests].cls}`}>{SUGGESTS[st.suggests].label}</span>
                {c && <span className={`badge ${c.result === 'ok' ? 'ok' : 'bad'}`}>{c.result === 'ok' ? 'Ruled out' : 'Problem found'}</span>}</div>
              <p className="small" style={{ margin: '4px 0' }}><b>The report:</b> {st.evidence}</p>
              <p className="small" style={{ margin: '4px 0' }}><b>Check:</b> {st.check}</p>
              {c && <p className="small muted" style={{ margin: '4px 0' }}>{c.by ?? 'Someone'} · {fmt.dt(c.at)}{c.note ? ` · ${c.note}` : ''}</p>}
              {canMark && (
                <div className="row no-print" style={{ marginTop: 6 }}>
                  <input className="search" style={{ flex: '1 1 220px' }} placeholder="Note (optional)" maxLength={500} value={notes[st.id] ?? ''} onChange={(e) => setNotes({ ...notes, [st.id]: e.target.value })} aria-label={`Note for ${st.title}`} />
                  <button className="btn small" onClick={() => mark(st.id, 'ok')} aria-pressed={c?.result === 'ok'}>OK, ruled out</button>
                  <button className="btn small" onClick={() => mark(st.id, 'problem')} aria-pressed={c?.result === 'problem'}>Problem found</button>
                  {c && <button className="btn small ghost" onClick={() => mark(st.id, 'not_checked')}>Undo</button>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
