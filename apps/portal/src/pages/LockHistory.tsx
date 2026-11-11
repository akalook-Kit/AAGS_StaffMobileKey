import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, blobUrl, photoDataUrl, saveCsv } from '../api';
import { useHotel } from '../App';
import { Drawer, ErrorNote, PageHead, fmt, useApi } from '../ui';
import { parsePaperLog } from '../paper-log';
import { tr } from '../i18n';

/**
 * 2.30 Lock history and the elimination method (Armel, 9 Nov): how many times a lock's batteries were changed, which
 * parts were changed or checked (Novel locks have their own), and — from the lock reports uploaded after the work —
 * whether the batteries are fine since the swap or still draining, with the next part to check.
 */
interface Part { id: string; name: string; group: string; novel?: boolean; notNovel?: boolean; action?: boolean; only?: string[]; not?: string[] }
interface Catalogue { models: { id: string; name: string }[]; parts: Part[]; groups: { id: string; name: string; why: string }[]; batteryTypes: { id: string; name: string }[]; recommended: string }
interface Rate { per30Days: number; days: number; readings: number; lifeDays: number | null }
interface WorkRow { id: string; on: string; parts: string[]; partNames: string[]; otherPart: string | null; batteryTypeName: string | null; batteryBrand: string | null; notes: string | null; by: string | null; recordedBy: string | null;
  voltsIdle?: number | null; voltsLoaded?: number | null; swappedFrom?: string | null; files?: number;
  verdict: 'waiting' | 'fixed' | 'better' | 'ok' | 'watch' | 'same' | 'worse' | 'draining'; title: string; detail: string; before: Rate | null; after: Rate | null; againInDays: number | null; alarmsAfter: number; waitUntil: string | null }
interface History {
  door: { id: string; name: string; group: string | null; online: boolean | null; floor?: string | null }; lockModel: string | null; lockModelName: string | null; novel: boolean;
  forecast?: Forecast; issues?: { id: string; on: string; notes: string | null; by: string | null }[];
  seen?: { id: string; on: string; parts: string[]; partNames: string[]; notes: string | null; by: string | null; voltsIdle: number | null; voltsLoaded: number | null; recordedBy: string | null; files: number }[];
  batteries: { changes: { day: string; sources: string[]; batteryTypeName: string | null; brand: string | null }[]; count: number; lastedDays: number[]; avgDays: number | null; daysSinceLast: number | null; recommended: string;
    notRecommended: { on: string; type: string; brand: string | null }[]; estimatedDaysPerSet: number | null; avgDropPer30Days: number | null; scale: { top: number; alarmLevel: number } };
  readings: { t: string; volts: number }[]; work: WorkRow[];
  sets: { from: string; to: string; days: number; finished: boolean; openingsPerDay: number | null; perThousand: number | null; per30: number | null; reached: { volts: number; days: number | null }[];
    firstAlarmDays: number | null; alarms: number; firmwareAlarms: number; restarts: number | null; cardErrors: number | null; internalErrors: number | null; deadbolt: number | null; work: { id: string; on: string; parts: string[] }[] }[]; reports: { id: string; fileName: string; from: string | null; to: string | null; uploadedAt: string }[];
  plan: PlanItem[]; weakPacks: { on: string; volts: number }[];
  firmware: { id: string; day: string; from: string | null; to: string | null; beforeMedian: number | null; beforeSets: number; afterMedian: number | null; afterSets: number }[]; firmwareSeen: { on: string; version: string }[];
  elimination: { state: 'draining' | 'waiting' | 'solved' | 'unknown'; next: { group: string; name: string; why: string; parts: string[]; suggestedByReport: string | null } | null; tried: string[]; remaining: string[] };
}
export const WORK_VERDICT: Record<WorkRow['verdict'], { cls: string; label: string }> = {
  waiting: { cls: '', label: 'Waiting for a report' }, fixed: { cls: 'ok', label: 'Fixed' }, ok: { cls: 'ok', label: 'Batteries fine' }, better: { cls: 'warn', label: 'Better' },
  watch: { cls: 'warn', label: 'Watch' }, same: { cls: 'bad', label: 'No change' }, worse: { cls: 'bad', label: 'Worse' }, draining: { cls: 'bad', label: 'Still draining' },
};
export const STATE: Record<History['elimination']['state'], { cls: string; label: string }> = {
  draining: { cls: 'bad', label: 'Draining' }, waiting: { cls: '', label: 'Waiting for a report' }, solved: { cls: 'ok', label: 'Solved' }, unknown: { cls: '', label: 'Not enough data' },
};
const day = (d: string | null | undefined) => (d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }) : '—');
/** 2.34 "in 5 days" / "3 days ago" / "today" for an expected low-battery date. */
export const lowIn = (f?: Forecast | null) => (!f?.expectedLowOn || f.daysLeft == null ? '—' : f.daysLeft === 0 ? 'today' : f.daysLeft > 0 ? `in ${f.daysLeft} days` : `${-f.daysLeft} days ago`);
export const lowCls = (f?: Forecast | null) => (f?.daysLeft == null ? '' : f.daysLeft <= 0 ? 'bad' : f.daysLeft <= 7 ? 'warn' : 'ok');
const rate = (r: Rate | null) => (r ? `${r.per30Days.toFixed(2)} V/30 d${r.lifeDays != null ? ` · ~${r.lifeDays} d a set` : ' · no drop'}` : '—');

/** 2.32 The hotel's locks: one load for the To do list, the locks table and the trend. */
/** 2.34 When the batteries are expected to be low if nothing changes. */
export interface Forecast { lastChange: string | null; expectedLifeDays: number | null; basis: 'this lock' | 'lock report' | 'hotel' | null; expectedLowOn: string | null; daysLeft: number | null }
export interface PlanItem { kind: 'read' | 'batteries' | 'check' | 'report' | 'record' | 'firmware'; priority: number; title: string; detail: string; due: string | null }
export interface LockRow { doorId: string; doorName: string; group: string | null; floor?: string | null; forecast?: Forecast; lastChange?: string | null; lastIssue?: { on: string; notes: string | null } | null; lockModelId?: string | null; online: boolean | null; lockModel: string | null; batteryChanges: number; avgDays: number | null; lastSetDays: number | null; daysSinceLast: number | null; reports: number; work: number;
  lastWork: { on: string; parts: string[]; verdict: WorkRow['verdict']; title: string } | null; state: History['elimination']['state']; next: string | null; notRecommended: number; plan: PlanItem[] }
export interface FirmwareRow { id: string; day: string; from: string | null; to: string | null; scope: string; notes: string | null; beforeMedian: number | null; beforeSets: number; afterMedian: number | null; afterSets: number; drop: number | null }
export interface LockList { locks: LockRow[]; years: { year: string; sets: number; medianDays: number; shortest: number; longest: number }[]; counts: Record<string, number>; total: number; firmware: FirmwareRow[]; siteLifeDays?: number | null; today?: string }

const PLAN_GROUPS: { id: string; title: string; test: (p: PlanItem) => boolean }[] = [
  { id: 'read-now', title: 'Read these locks and upload their report', test: (p) => p.kind === 'read' && p.priority === 1 },
  { id: 'firmware', title: 'Battery life fell after a firmware upgrade: ask ASSA ABLOY', test: (p) => p.kind === 'firmware' },
  { id: 'batteries', title: 'Fit industrial alkaline AA batteries', test: (p) => p.kind === 'batteries' },
  { id: 'check', title: 'Next part to check (elimination method)', test: (p) => p.kind === 'check' },
  { id: 'report', title: 'Upload a recent report', test: (p) => p.kind === 'report' },
  { id: 'record', title: 'Record what was done (from the paper log)', test: (p) => p.kind === 'record' },
  { id: 'soon', title: 'Coming up: read after the date', test: (p) => p.kind === 'read' && p.priority !== 1 },
];

export function LockTrend({ data, onChange }: { data: LockList; onChange?: () => void }) {
  const c = data.counts;
  return (
    <div className="lh-kpis">
      <div className="lh-kpi bad"><strong>{c.draining ?? 0}</strong><span>draining</span></div>
      <div className="lh-kpi"><strong>{c.waiting ?? 0}</strong><span>waiting for a report</span></div>
      <div className="lh-kpi ok"><strong>{c.solved ?? 0}</strong><span>solved</span></div>
      <div className="lh-kpi"><strong>{c.unknown ?? 0}</strong><span>not enough data</span></div>
      <FirmwareKpi data={data} onChange={onChange} />
      {data.years.length > 0 && (
        <div className="lh-kpi wide" data-tip="How long sets of batteries lasted, by the year they were fitted, over all the locks with a history. A drop on many locks at once points to a common cause: battery supply, a setting, firmware.">
          <span>Days a set lasted (median, all locks)</span>
          <div className="lh-years">{data.years.slice(-5).map((y) => <span key={y.year} className={`badge ${y.medianDays < 120 ? 'bad' : y.medianDays < 300 ? 'warn' : 'ok'}`}>{y.year}: {y.medianDays} d <span className="muted">({y.sets})</span></span>)}</div>
        </div>
      )}
    </div>
  );
}

/** Everything to do, all locks, by kind of action: the technicians' round. */
export function LockTodo({ data }: { data: LockList }) {
  const items = data.locks.flatMap((l) => l.plan.map((p) => ({ ...p, lock: l })));
  if (!items.length) return <div className="panel"><p className="empty">Nothing to do. Locks appear here once their work is recorded or their report uploaded.</p></div>;
  return (
    <div className="lh-todo">
      {PLAN_GROUPS.map((g) => {
        const rows = items.filter((x) => g.test(x)).sort((a, b) => (a.due ?? '').localeCompare(b.due ?? '') || a.lock.doorName.localeCompare(b.lock.doorName, undefined, { numeric: true }));
        if (!rows.length) return null;
        return (
          <section key={g.id} className="panel" style={{ padding: 0 }}>
            <h3 className="lh-todo-h">{g.title} <span className="badge">{rows.length}</span></h3>
            <table className="grid"><tbody>{rows.map((r, i) => (
              <tr key={`${r.lock.doorId}-${i}`}>
                <td className="nowrap" style={{ width: 120 }}><Link to={`/lock-troubleshoot/door/${encodeURIComponent(r.lock.doorId)}`}><strong>{r.lock.doorName}</strong></Link><div className="small muted">{r.lock.group ?? ''}</div></td>
                <td className="small"><strong>{r.title}</strong><div className="muted">{r.detail}</div></td>
                <td className="small nowrap" style={{ width: 150 }}>{r.lock.lastSetDays != null ? `last set ${r.lock.lastSetDays} d` : ''}{r.lock.batteryChanges ? <div className="muted">{r.lock.batteryChanges} battery changes</div> : null}</td>
                <td className="print-only" style={{ width: 90 }}>Done ☐</td>
              </tr>))}</tbody></table>
          </section>
        );
      })}
    </div>
  );
}

/** The locks with a history: search, filter by state and floor, a page at a time. */
export function LocksTable({ data, title }: { data: LockList; title?: string }) {
  const { hotel } = useHotel();
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [grp, setGrp] = useState('');
  const [soon, setSoon] = useState(false);
  const [page, setPage] = useState(0);
  const floorOf = (l: LockRow) => l.floor ?? l.group ?? null;
  const groups = [...new Set(data.locks.map(floorOf).filter(Boolean))].sort((a, b) => a!.localeCompare(b!, undefined, { numeric: true })) as string[];
  const rows = data.locks.filter((l) => (!state || l.state === state) && (!grp || floorOf(l) === grp) && (!soon || (l.forecast?.daysLeft != null && l.forecast.daysLeft <= 14))
    && (!q || `${l.doorName} ${l.lockModel ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const per = 25, pages = Math.max(1, Math.ceil(rows.length / per)), pg = Math.min(page, pages - 1);
  // 2.34 The lock register as a spreadsheet (Armel: "an important Excel"): one line per lock.
  const exportCsv = () => saveCsv(['Door', 'Floor', 'Lock model', 'State', 'Battery changes', 'Last battery change', 'Days the last set lasted', 'Days a set (average)', 'Batteries expected low on', 'Days left',
    'Last work', 'Parts', 'Last problem seen', 'Next step'],
    rows.map((r) => [r.doorName, floorOf(r), r.lockModel, STATE[r.state]?.label ?? r.state, r.batteryChanges, r.lastChange ?? '', r.lastSetDays, r.avgDays, r.forecast?.expectedLowOn ?? '', r.forecast?.daysLeft ?? '',
      r.lastWork?.on ?? '', r.lastWork?.parts.join(', ') ?? '', r.lastIssue?.on ?? '', r.plan[0]?.title ?? '']), `${hotel.slug}-locks-${new Date().toISOString().slice(0, 10)}.csv`);
  return (
    <section className="panel" style={{ padding: 0 }}>
      {title && <h3 className="lh-todo-h">{title}</h3>}
      <div className="row lh-filters">
        <input className="search" placeholder="Door…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} aria-label="Search a door" />
        <select value={state} onChange={(e) => { setState(e.target.value); setPage(0); }} aria-label="State"><option value="">All states</option>{Object.entries(STATE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        {groups.length > 1 && <select value={grp} onChange={(e) => { setGrp(e.target.value); setPage(0); }} aria-label="Floor or door group"><option value="">All floors</option>{groups.map((g) => <option key={g}>{g}</option>)}</select>}
        <label className="check small"><input type="checkbox" checked={soon} onChange={(e) => { setSoon(e.target.checked); setPage(0); }} /> Batteries low within 14 days</label>
        <span className="small muted">{rows.length} lock(s)</span>
        <button className="btn small no-print" style={{ marginLeft: 'auto' }} data-tip="Download this list for Excel (one line per lock)." onClick={exportCsv}>Excel (CSV)</button>
      </div>
      {!rows.length ? <p className="empty" style={{ padding: '0 16px 16px' }}>No lock matches.</p> : (
        <div className="table-scroll"><table className="grid">
          <thead><tr><th>Door and lock</th><th>Floor</th><th>State</th><th className="num">Battery changes</th><th className="num">Last set</th><th>Batteries low</th><th>Last work</th><th>What to do</th></tr></thead>
          <tbody>{rows.slice(pg * per, pg * per + per).map((r) => (
            <tr key={r.doorId}>
              <td><Link to={`/lock-troubleshoot/door/${encodeURIComponent(r.doorId)}`}><strong>{r.doorName}</strong></Link><div className="small muted">{r.lockModel ?? 'model not given'}</div></td>
              <td className="small">{floorOf(r) ?? '—'}</td>
              <td><span className={`badge ${STATE[r.state]?.cls ?? ''}`}>{STATE[r.state]?.label ?? r.state}</span>{r.notRecommended > 0 && <div className="small warn-text">batteries not recommended</div>}</td>
              <td className="num">{r.batteryChanges}</td>
              <td className="num">{r.lastSetDays != null ? `${r.lastSetDays} d` : '—'}{r.avgDays != null && <div className="small muted">avg {r.avgDays} d</div>}</td>
              <td className="small nowrap">{r.forecast?.expectedLowOn ? <><span className={`badge ${lowCls(r.forecast)}`}>{lowIn(r.forecast)}</span><div className="muted">{day(r.forecast.expectedLowOn)}</div></> : '—'}</td>
              <td className="small">{r.lastWork ? <>{day(r.lastWork.on)}: {r.lastWork.parts.join(', ')} <span className={`badge ${WORK_VERDICT[r.lastWork.verdict]?.cls ?? ''}`}>{WORK_VERDICT[r.lastWork.verdict]?.label}</span></> : '—'}</td>
              <td className="small">{r.plan[0]?.title ?? '—'}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      {pages > 1 && <div className="row lh-pager"><button className="btn small" disabled={pg === 0} onClick={() => setPage(pg - 1)}>‹ Previous</button><span className="small">Page {pg + 1} of {pages}</span><button className="btn small" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next ›</button></div>}
    </section>
  );
}

/** Record work on any lock (door picked in the form). */
export function RecordWorkButton({ onDone, problem, primary }: { onDone?: () => void; problem?: boolean; primary?: boolean }) {
  const { can } = useHotel();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  if (!(can('maintenance.work') || can('battery.manage'))) return null;
  return (<>
    {problem
      ? <button className={`btn${primary ? ' primary' : ''}`} data-tip="Note a problem on a lock on a given day (the batteries dropped, an alarm, the door did not open), without changing anything." onClick={() => setOpen(true)}>Report a problem</button>
      : <button className={`btn${primary ? ' primary' : ''}`} data-tip="Record batteries or parts changed on a lock, and what was checked. The portal then tells from the next lock report whether it worked." onClick={() => setOpen(true)}>Record work on a lock</button>}
    {open && <RecordWork initialParts={problem ? ['issue-reported'] : []} onClose={() => setOpen(false)} onDone={(doorId) => { setOpen(false); onDone?.(); nav(`/lock-troubleshoot/door/${encodeURIComponent(doorId)}`); }} />}
  </>);
}

export function DoorHistoryPage() {
  const { doorId = '' } = useParams();
  const { base, can } = useHotel();
  const h = useApi<History>(`${base}/lock-history/${encodeURIComponent(doorId)}`, [doorId]);
  const [record, setRecord] = useState<false | 'work' | 'problem'>(false);
  const [paper, setPaper] = useState(false);
  const [photos, setPhotos] = useState<{ id: string; title: string } | null>(null);
  const [tab, setTab] = useState('sets');
  const [error, setError] = useState<unknown>(null);
  const x = h.data;
  if (!x) return <><PageHead title="Lock history" /><ErrorNote error={h.error} />{h.loading && <p className="muted">Loading…</p>}</>;
  const e = x.elimination;
  const del = async (id: string) => { if (!confirm('Remove this record of work?')) return; try { await api(`${base}/lock-history/${encodeURIComponent(doorId)}/work/${id}`, { method: 'DELETE' }); void h.reload(); } catch (err) { setError(err); } };
  const canRecord = can('maintenance.work') || can('battery.manage');
  return (
    <div className="lock-history">
      <PageHead title={`Lock ${x.door.name}`} intro={<><strong>{x.lockModelName ?? 'Lock model not given'}</strong>{x.door.floor ?? x.door.group ? ` · ${x.door.floor ?? x.door.group}` : ''}{x.door.online === true ? ' · online lock' : x.door.online === false ? ' · offline (stand-alone) lock' : ''}. Batteries, work done and whether the batteries are fine since.</>}>
        <Link className="btn no-print" to="/lock-troubleshoot">All locks</Link>
        <button className="btn no-print" onClick={() => window.print()}>Print</button>
        {canRecord && <button className="btn no-print" data-tip="Type in the battery card kept in the lock (date, what was changed, who): one line each." onClick={() => setPaper(true)}>Add from the paper log</button>}
        {canRecord && <button className="btn no-print" data-tip="Note a problem seen on a day (the batteries dropped, an alarm, the door did not open), or a voltage measured, without changing anything." onClick={() => setRecord('problem')}>Report a problem</button>}
        {canRecord && <button className="btn primary no-print" onClick={() => setRecord('work')}>Record work</button>}
      </PageHead>
      <ErrorNote error={error} />

      <section className={`panel verdict lh-head v-${e.state === 'draining' ? 'attention' : e.state === 'solved' ? 'ok' : 'check'}`}>
        <div className="lh-head-main">
          <h2 style={{ margin: 0 }}><span className={`badge ${STATE[e.state].cls}`}>{STATE[e.state].label}</span></h2>
          {e.state === 'solved' && <p style={{ margin: '6px 0' }}>The last work fixed it: the batteries last since. Keep uploading a report at each battery check to confirm.</p>}
          {x.plan.length > 0 && (
            <ol className="lh-plan">{x.plan.map((p, i) => <li key={i}><strong>{p.title}</strong><div className="small muted">{p.detail}</div></li>)}</ol>
          )}
          {e.next && e.state === 'draining' && e.next.group !== 'batteries' && !x.plan.some((p) => p.kind === 'check') && (
            <p className="small" style={{ margin: '6px 0 0' }}><strong>Next to check: {e.next.name}</strong> — {e.next.parts.join(' · ')}</p>
          )}
          {e.next && <p className="small muted" style={{ margin: '6px 0 0' }}>{e.next.suggestedByReport === 'likely' && <span className="badge bad" style={{ marginRight: 6 }}>likely from the lock report</span>}{e.next.why}</p>}
          {(e.tried.length > 0 || e.remaining.length > 1) && <p className="small muted" style={{ margin: '6px 0 0' }}>{e.tried.length > 0 && <>Already changed or checked: {e.tried.map((t) => tr(t)).join(', ')}. </>}{e.remaining.length > 1 && <>Left after that: {e.remaining.slice(1).map((t) => tr(t)).join(', ')}.</>}</p>}
        </div>
        <div className="lh-head-figs">
          <div><strong>{x.batteries.count}</strong><span>battery changes</span></div>
          <div><strong>{x.batteries.lastedDays.length ? x.batteries.lastedDays[x.batteries.lastedDays.length - 1] : '—'}</strong><span>days the last set lasted</span></div>
          <div><strong>{x.batteries.avgDays ?? '—'}</strong><span>days a set, average</span></div>
          <div><strong>{x.batteries.daysSinceLast ?? '—'}</strong><span>days since the last change</span></div>
          {x.forecast?.expectedLowOn && <div className={`lh-fig-${lowCls(x.forecast)}`} data-tip={`If nothing changes: the last battery change (${day(x.forecast.lastChange)}) + ${x.forecast.expectedLifeDays} days, how long a set lasts on ${x.forecast.basis === 'this lock' ? 'this lock' : x.forecast.basis === 'lock report' ? 'this lock (from its report)' : 'the locks of this hotel'}. Prepare the batteries in advance.`}>
            <strong>{lowIn(x.forecast)}</strong><span>batteries expected low ({day(x.forecast.expectedLowOn)})</span></div>}
        </div>
      </section>
      <p className="small lh-batt-note">Recommended batteries: <strong>{x.batteries.recommended}</strong>.
        {x.batteries.notRecommended.length > 0 && <span className="warn-text"> Fitted here: {x.batteries.notRecommended.map((n) => `${n.type}${n.brand ? ` (${n.brand})` : ''} on ${day(n.on)}`).join('; ')}.</span>}
        {x.firmware.map((f) => <span key={f.id}> Firmware upgrade of <strong>{day(f.day)}</strong>{f.to ? ` (${f.to})` : ''}: sets {f.beforeMedian ?? '—'} d before → <strong className={f.beforeMedian && f.afterMedian != null && f.afterMedian <= f.beforeMedian / 2 ? 'bad-text' : ''}>{f.afterMedian ?? '—'} d after</strong>.</span>)}
        {x.firmwareSeen.length > 0 && <span> Firmware seen on this lock: {x.firmwareSeen.map((v) => `${v.version} (${day(v.on)})`).join(', ')}.</span>}
        {x.weakPacks.length > 0 && <span className="warn-text"> New pack already weak when measured: {x.weakPacks.map((w) => `${w.volts.toFixed(2)} V on ${day(w.on)}`).join('; ')} (old or weak stock).</span>}</p>

      <div className="seg no-print lh-tabs" role="tablist" aria-label="Lock history">
        {([['sets', `Battery sets (${x.sets.length})`], ['work', `Work done (${x.work.length})`], ['seen', `Problems and measurements (${x.seen?.length ?? 0})`], ['changes', `Battery changes (${x.batteries.count})`], ['level', 'Battery level'], ['reports', `Reports (${x.reports.length})`]] as [string, string][])
          .map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}
      </div>

      <div className="lh-tab" hidden={tab !== 'work'}>
      <h2 className="section-title">Work done and what it changed</h2>
      {!x.work.length ? <div className="panel"><p className="empty">No work recorded on this lock yet.{canRecord && ' Use "Record work" after each visit: batteries (with their type) and every part changed or checked.'}</p></div> : (
        <div className="panel" style={{ padding: 0 }}><div className="table-scroll"><table className="grid">
          <thead><tr><th>Date</th><th>Changed or checked</th><th>Result since</th><th>Battery use before → after</th><th /></tr></thead>
          <tbody>{[...x.work].reverse().map((w) => (
            <tr key={w.id}>
              <td className="nowrap">{day(w.on)}{w.by && <div className="small muted">{w.by}</div>}</td>
              <td className="small">{w.partNames.map((t) => tr(t)).join(', ')}{w.batteryTypeName && <div className={w.batteryTypeName.startsWith('Industrial') ? 'muted' : 'warn-text'}>Batteries: {w.batteryTypeName}{w.batteryBrand ? `, ${w.batteryBrand}` : ''}</div>}{(w as any).voltsBefore != null || (w as any).voltsAfter != null ? <div className="muted">Pack: {(w as any).voltsBefore ?? '—'} V → {(w as any).voltsAfter ?? '—'} V</div> : null}{(w as any).batteryBatch && <div className="muted">Batch {(w as any).batteryBatch}</div>}{(w.voltsIdle != null || w.voltsLoaded != null) && <div className="muted">At rest {w.voltsIdle ?? '—'} V · under load {w.voltsLoaded ?? '—'} V</div>}{w.swappedFrom && <div className="muted">Swapped with door {w.swappedFrom}</div>}{w.notes && <div className="muted">{w.notes}</div>}{(w.files ?? 0) > 0 && <button className="linklike small no-print" onClick={() => setPhotos({ id: w.id, title: `${day(w.on)}: ${w.partNames.map((t) => tr(t)).join(', ')}` })}>Photos ({w.files})</button>}</td>
              <td className="small"><span className={`badge ${WORK_VERDICT[w.verdict].cls}`}>{WORK_VERDICT[w.verdict].label}</span> <strong>{w.title}</strong><div className="muted">{w.detail}</div></td>
              <td className="small nowrap">{rate(w.before)}<br />→ {rate(w.after)}{w.againInDays != null && <div className="muted">new batteries again after {w.againInDays} d</div>}</td>
              <td>{can('battery.manage') && <button className="btn small ghost no-print" onClick={() => void del(w.id)}>Remove</button>}</td>
            </tr>))}</tbody>
        </table></div></div>
      )}

      </div>
      <div className="lh-tab" hidden={tab !== 'seen'}>
      <h2 className="section-title">Problems seen and voltages measured</h2>
      {!(x.seen ?? []).length ? <div className="panel"><p className="empty">Nothing yet.{canRecord && ' Use "Report a problem" on the day the batteries drop, an alarm shows or the door does not open, and record the voltage measured at rest and under load.'}</p></div> : (
        <div className="panel" style={{ padding: 0 }}><div className="table-scroll"><table className="grid">
          <thead><tr><th>Date</th><th>What</th><th className="num">At rest</th><th className="num">Under load</th><th>Notes</th><th /></tr></thead>
          <tbody>{[...(x.seen ?? [])].reverse().map((w) => (
            <tr key={w.id}>
              <td className="nowrap">{day(w.on)}{w.by && <div className="small muted">{w.by}</div>}</td>
              <td className="small">{w.parts.includes('issue-reported') ? <span className="badge bad">Problem</span> : <span className="badge">Measured</span>}</td>
              <td className="num">{w.voltsIdle != null ? `${w.voltsIdle} V` : '—'}</td>
              <td className="num">{w.voltsLoaded != null ? `${w.voltsLoaded} V` : '—'}</td>
              <td className="small">{w.notes ?? '—'}{w.files > 0 && <div><button className="linklike small no-print" onClick={() => setPhotos({ id: w.id, title: `${day(w.on)}: ${w.partNames.map((t) => tr(t)).join(', ')}` })}>Photos ({w.files})</button></div>}</td>
              <td>{can('battery.manage') && <button className="btn small ghost no-print" onClick={() => void del(w.id)}>Remove</button>}</td>
            </tr>))}</tbody>
        </table></div></div>
      )}
      </div>
      <div className="lh-tab" hidden={tab !== 'sets'}>
      {!x.sets.length && <div className="panel"><p className="empty">No battery set yet: upload a report of this lock (Lock reports tab of Lock troubleshooting).</p></div>}
      {x.sets.length > 0 && <>
        <h2 className="section-title">Battery sets in the lock reports ({x.sets.length})</h2>
        <p className="small muted" style={{ marginTop: -4 }}>Each set from one battery change to the next, with what was changed when it was fitted. If the sets keep lasting the same after a part was changed, that part was not the cause.</p>
        <div className="panel" style={{ padding: 0 }}><div className="table-scroll"><table className="grid lh-sets">
          <thead><tr><th>Fitted</th><th>Changed at the same time</th><th className="num">Lasted</th><th className="num">Openings a day</th>
            {(x.sets[0]?.reached ?? []).map((r) => <th key={r.volts} className="num">Days to {r.volts.toFixed(1)} V</th>)}<th className="num">First alarm</th><th className="num">Restarts</th><th className="num">Card errors</th></tr></thead>
          <tbody>{[...x.sets].reverse().map((t) => {
            const short = t.finished && t.days < 120;
            return <tr key={t.from} className={short ? 'row-bad' : undefined}>
              <td className="nowrap">{day(t.from)}</td>
              <td className="small">{t.work.length ? t.work.map((w) => w.parts.join(', ')).join('; ') : <span className="muted">—</span>}</td>
              <td className="num nowrap"><strong>{Math.round(t.days)} d</strong>{!t.finished && <div className="small muted">so far</div>}</td>
              <td className="num">{t.openingsPerDay ?? '—'}</td>
              {t.reached.map((r) => <td key={r.volts} className="num">{r.days != null ? Math.round(r.days) : '—'}</td>)}
              <td className="num nowrap">{t.firstAlarmDays != null ? `${Math.round(t.firstAlarmDays)} d` : '—'}</td>
              <td className="num">{t.restarts ?? '—'}</td>
              <td className="num">{t.cardErrors ?? '—'}</td>
            </tr>;
          })}</tbody>
        </table></div></div>
      </>}

      </div>
      <div className="lh-tab" hidden={tab !== 'changes'}>
      <h2 className="section-title">Battery changes ({x.batteries.count})</h2>
      <div className="panel" style={{ padding: 0 }}>
        {!x.batteries.changes.length ? <p className="empty" style={{ padding: 14 }}>No battery change known yet.</p> : (
          <table className="grid"><thead><tr><th>Date</th><th className="num">Lasted</th><th>Batteries</th><th>Known from</th></tr></thead>
            <tbody>{[...x.batteries.changes].reverse().map((c, i, arr) => {
              const idx = arr.length - 1 - i; const lasted = x.batteries.lastedDays[idx] ?? null;
              return <tr key={c.day}><td>{day(c.day)}</td><td className="num">{lasted != null ? `${lasted} d` : idx === arr.length - 1 ? `${x.batteries.daysSinceLast ?? '—'} d so far` : '—'}</td>
                <td className="small">{c.batteryTypeName ?? '—'}{c.brand ? `, ${c.brand}` : ''}</td><td className="small muted">{c.sources.join(', ')}</td></tr>;
            })}</tbody></table>
        )}
      </div>

      </div>
      <div className="lh-tab" hidden={tab !== 'level'}>
      {x.readings.length < 2 && <div className="panel"><p className="empty">No battery readings yet: they come from the lock reports.</p></div>}
      {x.readings.length > 1 && <><h2 className="section-title">Battery level from the lock reports</h2><div className="panel"><VoltLine h={x} /></div></>}

      </div>
      <div className="lh-tab" hidden={tab !== 'reports'}>
      <h2 className="section-title">Lock reports of this door ({x.reports.length})</h2>
      <div className="panel">
        {!x.reports.length ? <p className="empty">None yet. Read the lock with the service device, save its events from Visionline and upload them on Lock troubleshooting.</p>
          : <ul className="plain">{x.reports.map((r) => <li key={r.id}><Link to={`/lock-troubleshoot/${r.id}`}>{r.fileName}</Link> <span className="small muted">events {day(r.from)} – {day(r.to)}, uploaded {fmt.dt(r.uploadedAt)}</span></li>)}</ul>}
      </div>
      </div>
      {paper && <PaperLog doorId={x.door.id} doorName={x.door.name} model={x.lockModel} existing={x.work} onClose={() => setPaper(false)} onDone={() => { setPaper(false); void h.reload(); }} />}
      {record && <RecordWork doorId={x.door.id} doorName={x.door.name} model={x.lockModel} initialParts={record === 'problem' ? ['issue-reported'] : []} onClose={() => setRecord(false)} onDone={() => { setRecord(false); void h.reload(); }} />}
      {photos && <Photos doorId={x.door.id} workId={photos.id} title={photos.title} onClose={() => setPhotos(null)} />}
    </div>
  );
}

/** Voltage steps over time with the work marked (a simple line; the readings are the lock's "below X V" steps). */
function VoltLine({ h }: { h: History }) {
  const W = 760, H = 180, P = 34;
  const pts = h.readings.map((r) => ({ x: Date.parse(`${r.t}:00Z`), y: r.volts }));
  const x0 = Math.min(...pts.map((p) => p.x)), x1 = Math.max(...pts.map((p) => p.x), x0 + 86_400_000);
  const top = h.batteries.scale.top, lo = Math.min(h.batteries.scale.alarmLevel - 0.2, ...pts.map((p) => p.y));
  const X = (t: number) => P + ((t - x0) / (x1 - x0)) * (W - P - 10), Y = (v: number) => 10 + ((top - v) / (top - lo)) * (H - 40);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Battery level over time">
      <line x1={P} x2={W - 10} y1={Y(h.batteries.scale.alarmLevel)} y2={Y(h.batteries.scale.alarmLevel)} stroke="currentColor" strokeOpacity=".35" strokeDasharray="4 4" />
      <text x={P - 4} y={Y(h.batteries.scale.alarmLevel) + 4} fontSize="10" textAnchor="end" fill="currentColor">{h.batteries.scale.alarmLevel.toFixed(1)}</text>
      <text x={P - 4} y={Y(top) + 4} fontSize="10" textAnchor="end" fill="currentColor">{top.toFixed(1)} V</text>
      {h.firmware.map((f) => { const t = Date.parse(`${f.day}T12:00:00Z`); if (t < x0 || t > x1) return null; return <g key={f.id}><line x1={X(t)} x2={X(t)} y1={6} y2={H - 26} stroke="var(--bad, #b3261e)" strokeWidth="2" strokeDasharray="5 3" /><text x={X(t) + 3} y={H - 30} fontSize="10" fill="currentColor">firmware</text></g>; })}
      {h.work.map((w) => { const t = Date.parse(`${w.on}T12:00:00Z`); if (t < x0 || t > x1) return null; return <g key={w.id}><line x1={X(t)} x2={X(t)} y1={6} y2={H - 26} stroke="var(--brass, #b08d57)" strokeWidth="2" /><text x={X(t) + 3} y={14} fontSize="10" fill="currentColor">{w.partNames[0]?.split(' ')[0]}</text></g>; })}
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" />
      {pts.map((p, i) => <circle key={i} cx={X(p.x)} cy={Y(p.y)} r="2.5" fill="currentColor"><title>{`${new Date(p.x).toISOString().slice(0, 16).replace('T', ' ')}: below ${p.y.toFixed(1)} V`}</title></circle>)}
      <text x={P} y={H - 8} fontSize="10" fill="currentColor">{new Date(x0).toISOString().slice(0, 10)}</text>
      <text x={W - 10} y={H - 8} fontSize="10" textAnchor="end" fill="currentColor">{new Date(x1).toISOString().slice(0, 10)}</text>
    </svg>
  );
}

/** Record work done on a lock: date, who, the lock model, parts changed or checked, the batteries fitted. */
function RecordWork({ doorId, doorName, model, initialParts = [], onClose, onDone }: { doorId?: string; doorName?: string; model?: string | null; initialParts?: string[]; onClose: () => void; onDone: (doorId: string) => void }) {
  const { base, can } = useHotel();
  const cat = useApi<Catalogue>(`${base}/lock-history/catalogue`, []);
  const doors = useApi<any[]>(can('resources.read') && !doorId ? `${base}/resources?kind=door` : null, []);
  const [door, setDoor] = useState(doorId ?? '');
  // 2.34 Most hotels have one lock model: the last one chosen is remembered on this computer.
  const [lockModel, setLockModel] = useState(model ?? (() => { try { return localStorage.getItem('smk.lockModel') ?? ''; } catch { return ''; } })());
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  const [parts, setParts] = useState<string[]>(initialParts);
  const [vIdle, setVIdle] = useState('');
  const [vLoad, setVLoad] = useState('');
  const [swap, setSwap] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sent, setSent] = useState(0);
  const [other, setOther] = useState('');
  const [btype, setBtype] = useState('industrial-alkaline');
  const [brand, setBrand] = useState('');
  const [by, setBy] = useState('');
  const [batch, setBatch] = useState('');
  const [vb, setVb] = useState('');
  const [va, setVa] = useState('');
  const [fwv, setFwv] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const novel = lockModel.startsWith('novel');
  const alfa = lockModel === 'classic-alfa';
  const c = cat.data;
  // 2.34 "Report a problem" shows what was seen or measured first; work shows the method's order (cables first).
  const problemFirst = initialParts.includes('issue-reported');
  const groups = useMemo(() => {
    const gs = (c?.groups ?? []).map((g) => ({ ...g, parts: partsFor(c?.parts ?? [], lockModel).filter((p) => p.group === g.id) })).filter((g) => g.parts.length);
    return problemFirst ? [...gs.filter((g) => g.id === 'note'), ...gs.filter((g) => g.id !== 'note')] : gs;
  }, [c, lockModel, problemFirst]);
  const toggle = (id: string) => setParts(parts.includes(id) ? parts.filter((p) => p !== id) : [...parts, id]);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const num = (v: string) => (v ? Number(v.replace(',', '.')) : undefined);
      const r = await api<{ id: string }>(`${base}/lock-history/${encodeURIComponent(door)}/work`, { body: { doneOn: on, parts, otherPart: other || undefined, batteryType: parts.includes('batteries') ? btype : undefined, batteryBrand: brand || undefined, batteryBatch: batch || undefined,
        voltsBefore: num(vb), voltsAfter: num(va), voltsIdle: num(vIdle), voltsLoaded: num(vLoad), swappedFrom: swapping ? swap || undefined : undefined,
        firmwareVersion: fwv || undefined, doneBy: by || undefined, notes: notes || undefined, lockModel: lockModel || undefined } });
      try { if (lockModel) localStorage.setItem('smk.lockModel', lockModel); } catch { /* private window */ }
      for (const f of files) { await api(`${base}/lock-history/${encodeURIComponent(door)}/work/${r.id}/files`, { body: { name: f.name.slice(0, 160), dataUrl: await photoDataUrl(f) } }); setSent((n) => n + 1); }
      onDone(door);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const doorList = (doors.data ?? []).filter((d) => d.active).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const swapping = parts.some((p) => ['lca', 'lcu', 'classic-lockcase', 'lockcase', 'door-unit', 'reader', 'novel-inside', 'novel-reader'].includes(p));
  const onlySeen = parts.length > 0 && parts.every((p) => (c?.parts.find((x) => x.id === p)?.group ?? '') === 'note');
  return (
    <Drawer title={initialParts.includes('issue-reported') ? (doorName ? `Report a problem on ${doorName}` : 'Report a problem on a lock') : doorName ? `Record work on ${doorName}` : 'Record work on a lock'} onClose={onClose}>
      {!doorId && (
        <div className="field"><label htmlFor="rw-door">Door</label>
          <select id="rw-door" value={door} onChange={(e) => setDoor(e.target.value)}><option value="">Choose the door…</option>{doorList.map((d) => <option key={d.external_id} value={d.external_id}>{d.name}{d.data?.doorGroup ? ` · ${d.data.doorGroup}` : ''}</option>)}</select></div>
      )}
      <div className="field-row">
        <div className="field"><label htmlFor="rw-on">{onlySeen ? 'Date' : 'Date of the work'}</label><input id="rw-on" type="date" value={on} max={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} onChange={(e) => setOn(e.target.value)} /></div>
        <div className="field"><label htmlFor="rw-model">Lock model</label><select id="rw-model" value={lockModel} onChange={(e) => setLockModel(e.target.value)}><option value="">Not sure</option>{(c?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>Tick everything changed or checked, in the order of the method: cables and alignment first, then the battery holder (rust), the batteries, and only then the LCA and the LCU (swapped with a lock that works).{novel && ' Novel locks have everything in one unit: their own parts are shown.'}{alfa && ' Classic Alfa: cables, battery holder, batteries, LCA (lock case adapter), LCU (lock controller unit) and lock case.'}</p>
      {groups.map((g) => (
        <fieldset key={g.id} className="rw-group"><legend data-tip={g.why}>{g.name}</legend>
          {g.parts.map((p) => <label key={p.id} className="check"><input type="checkbox" checked={parts.includes(p.id)} onChange={() => toggle(p.id)} /> {p.name}</label>)}
        </fieldset>
      ))}
      {swapping && <div className="field"><label htmlFor="rw-swap">Swapped with the part of door (a lock that works)</label><input id="rw-swap" value={swap} maxLength={100} placeholder="e.g. 812" onChange={(e) => setSwap(e.target.value)} />
        <span className="hint">The part of this lock went to that door, and theirs came here. Watch both locks: if the problem moves with the part, the part is faulty.</span></div>}
      <div className="field"><label htmlFor="rw-other">Other part (if not in the list)</label><input id="rw-other" value={other} maxLength={120} onChange={(e) => setOther(e.target.value)} /></div>
      {parts.includes('batteries') && (
        <div className="field-row">
          <div className="field"><label htmlFor="rw-bt">Batteries fitted</label><select id="rw-bt" value={btype} onChange={(e) => setBtype(e.target.value)}>{(c?.batteryTypes ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            {btype !== 'industrial-alkaline' && <span className="hint warn-text">Industrial alkaline AA batteries are recommended.</span>}</div>
          <div className="field"><label htmlFor="rw-brand">Brand (optional)</label><input id="rw-brand" value={brand} maxLength={60} onChange={(e) => setBrand(e.target.value)} /></div>
        </div>
      )}
      {parts.includes('batteries') && <div className="field"><label htmlFor="rw-batch">Batch / expiry on the pack (optional)</label><input id="rw-batch" value={batch} maxLength={60} onChange={(e) => setBatch(e.target.value)} /></div>}
      <div className="field-row">
        <div className="field"><label htmlFor="rw-vi">Battery voltage at rest (V)</label><input id="rw-vi" inputMode="decimal" value={vIdle} onChange={(e) => setVIdle(e.target.value)} placeholder="e.g. 4.7" /></div>
        <div className="field"><label htmlFor="rw-vl">Under load (V, while the lock opens)</label><input id="rw-vl" inputMode="decimal" value={vLoad} onChange={(e) => setVLoad(e.target.value)} placeholder="e.g. 4.3" />
          {vIdle && vLoad && Number(vIdle.replace(',', '.')) - Number(vLoad.replace(',', '.')) > 0.6 && <span className="hint warn-text">A drop of more than 0.6 V when the lock opens points to weak batteries, a rusty holder or a bad contact.</span>}</div>
      </div>
      {!onlySeen && <div className="field-row">
        <div className="field"><label htmlFor="rw-vb">Pack voltage before (V, multimeter)</label><input id="rw-vb" inputMode="decimal" value={vb} onChange={(e) => setVb(e.target.value)} placeholder="e.g. 3.8" /></div>
        <div className="field"><label htmlFor="rw-va">Pack voltage after (V)</label><input id="rw-va" inputMode="decimal" value={va} onChange={(e) => setVa(e.target.value)} placeholder="e.g. 4.8" />
          {parts.includes('batteries') && va && Number(va.replace(',', '.')) < 4.6 && Number(va.replace(',', '.')) > 3 && <span className="hint warn-text">A new pack of 3 alkaline cells reads about 4.8 V: under 4.6 V is old or weak stock.</span>}</div>
      </div>}
      {parts.includes('firmware') && <div className="field"><label htmlFor="rw-fw">Firmware version now on the lock</label><input id="rw-fw" value={fwv} maxLength={40} onChange={(e) => setFwv(e.target.value)} /></div>}
      <div className="field"><label htmlFor="rw-by">Done by (technician)</label><input id="rw-by" value={by} maxLength={80} onChange={(e) => setBy(e.target.value)} /></div>
      <div className="field"><label htmlFor="rw-notes">{onlySeen ? 'What happened (e.g. batteries dropped, alarm, door did not open)' : 'Notes (what you saw: rust, cut cable, misalignment, door rubbing…)'}</label><textarea id="rw-notes" rows={3} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} /></div>
      <div className="field"><label htmlFor="rw-files">Photos or screenshots (optional: paper log, multimeter, battery holder, Visionline)</label>
        <input id="rw-files" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 6))} />
        {files.length > 0 && <span className="hint">{files.length} photo(s) will be attached.</span>}</div>
      <ErrorNote error={error} />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={busy || !door || (!parts.length && !other.trim())} onClick={save}>{busy ? (files.length ? `Saving… (${sent}/${files.length} photos)` : 'Saving…') : 'Save'}</button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
      <p className="small muted">{onlySeen ? 'If the batteries dropped again, read the lock and upload its latest report: if the report shows the drop, change the next part.' : 'After the work, read the lock again in 3 weeks or more and upload its report: the portal compares the battery use before and after, and says whether this part was the cause.'}</p>
    </Drawer>
  );
}

/** The parts that exist on a lock model (same rule as the server). */
export function partsFor(parts: Part[], model: string | null | undefined) {
  const novel = Boolean(model && model.startsWith('novel'));
  return parts.filter((p) => (p.only ? Boolean(model && p.only.includes(model)) : !(model && p.not?.includes(model)) && (novel ? !p.notNovel : !p.novel)));
}

function PaperLog({ doorId, doorName, model, existing, onClose, onDone }: { doorId: string; doorName: string; model: string | null; existing: { on: string; parts: string[] }[]; onClose: () => void; onDone: () => void }) {
  const { base } = useHotel();
  const cat = useApi<Catalogue>(`${base}/lock-history/catalogue`, []);
  const [lockModel, setLockModel] = useState(model ?? '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const rows = useMemo(() => parsePaperLog(text, lockModel || null).map((r) => (r.doneOn && existing.some((w) => w.on === r.doneOn && [...w.parts].sort().join() === [...r.parts].sort().join()) ? { ...r, error: 'already recorded' } : r)), [text, lockModel, existing]);
  const name = (id: string) => cat.data?.parts.find((p) => p.id === id)?.name ?? id;
  const good = rows.filter((r) => !r.error && r.doneOn);
  const save = async () => {
    setBusy(true); setError(null); setDone(0);
    try {
      for (const r of good) {
        await api(`${base}/lock-history/${encodeURIComponent(doorId)}/work`, { body: { doneOn: r.doneOn, parts: r.parts, batteryType: r.parts.includes('batteries') ? r.batteryType : undefined, doneBy: r.doneBy || undefined, notes: r.notes, lockModel: lockModel || undefined } });
        setDone((n) => n + 1);
      }
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Drawer title={`Paper log of ${doorName}`} onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>Type the card kept in the lock, one line per entry: the date (day/month/year), what was changed and who. <em>Piles</em> = batteries; <em>LCU</em>, <em>LCA</em>, <em>porte batterie</em> (battery holder), <em>lock case</em> are recognised. A line with only a date and a name is a battery change.</p>
      <div className="field"><label htmlFor="pl-model">Lock model</label><select id="pl-model" value={lockModel} onChange={(e) => setLockModel(e.target.value)}><option value="">Not sure</option>{(cat.data?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
      <div className="field"><label htmlFor="pl-text">Lines of the paper log</label>
        <textarea id="pl-text" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'14/04/2026 LCA + piles Serge\n22/07/2026 LCU\n04/09/2026 porte batterie Augustin\n02/10/2026 Augustin'} /></div>
      {rows.length > 0 && (
        <div className="table-scroll"><table className="grid">
          <thead><tr><th>Date</th><th>Changed</th><th>Who</th></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className={r.error ? 'row-bad' : undefined}><td className="nowrap">{r.doneOn ?? <span className="bad-text">{r.error}</span>}</td><td className="small">{r.parts.map(name).join(', ')}{r.parts.includes('batteries') && <div className="muted">batteries: {r.batteryType === 'unknown' ? 'type not known' : r.batteryType}</div>}</td><td className="small">{r.doneBy || '—'}</td></tr>)}</tbody>
        </table></div>
      )}
      <ErrorNote error={error} />
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button className="btn primary" disabled={busy || !good.length} onClick={save}>{busy ? `Saving ${done}/${good.length}…` : `Save ${good.length} entr${good.length === 1 ? 'y' : 'ies'}`}</button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
      {rows.some((r) => r.error) && <p className="small muted">Lines in red are left out: correct their date to include them.</p>}
    </Drawer>
  );
}

/** 2.32 Firmware upgrades of the site's locks, with how long battery sets lasted before and after each one. */
function FirmwareKpi({ data, onChange }: { data: LockList; onChange?: () => void }) {
  const { base, can } = useHotel();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ doneOn: '', versionFrom: '', versionTo: '', doors: '', notes: '' });
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setError(null);
    try {
      const doors = f.doors.split(/[\s,;]+/).filter(Boolean);
      const ids = doors.length ? doors.map((n) => data.locks.find((l) => l.doorName === n)?.doorId ?? n) : undefined;
      await api(`${base}/lock-history/firmware`, { body: { doneOn: f.doneOn, versionFrom: f.versionFrom || undefined, versionTo: f.versionTo || undefined, doors: ids, notes: f.notes || undefined } });
      setOpen(false); onChange?.();
    } catch (e) { setError(e); }
  };
  const del = async (id: string) => { if (!confirm('Remove this firmware upgrade?')) return; try { await api(`${base}/lock-history/firmware/${id}`, { method: 'DELETE' }); onChange?.(); } catch (e) { setError(e); } };
  return (
    <div className="lh-kpi wide" data-tip="When the lock firmware was upgraded, and how long battery sets lasted before and after, over the locks concerned. A big drop after an upgrade points to the firmware.">
      <span>Firmware upgrades</span>
      {!data.firmware.length ? <div className="small muted">None recorded.</div> : data.firmware.map((x) => (
        <div key={x.id} className="small">
          <strong>{day(x.day)}</strong>{x.to ? ` → ${x.to}` : ''} <span className="muted">({x.scope})</span>:{' '}
          {x.beforeMedian != null || x.afterMedian != null ? <>sets {x.beforeMedian ?? '—'} d before → <strong className={x.drop != null && x.drop >= 50 ? 'bad-text' : ''}>{x.afterMedian ?? '—'} d after</strong>{x.drop != null && x.drop > 0 && <> (−{x.drop}%)</>}</> : <span className="muted">no battery sets yet</span>}
          {can('battery.manage') && <button className="linklike no-print" style={{ marginLeft: 6 }} onClick={() => void del(x.id)}>remove</button>}
        </div>
      ))}
      {can('battery.manage') && <button className="btn small no-print" style={{ marginTop: 6 }} onClick={() => setOpen(true)}>Record a firmware upgrade</button>}
      {open && (
        <Drawer title="Record a firmware upgrade" onClose={() => setOpen(false)}>
          <div className="field"><label htmlFor="fw-on">Date of the upgrade</label><input id="fw-on" type="date" value={f.doneOn} onChange={(e) => setF({ ...f, doneOn: e.target.value })} /></div>
          <div className="field-row">
            <div className="field"><label htmlFor="fw-from">Version before (if known)</label><input id="fw-from" value={f.versionFrom} maxLength={40} onChange={(e) => setF({ ...f, versionFrom: e.target.value })} /></div>
            <div className="field"><label htmlFor="fw-to">Version after</label><input id="fw-to" value={f.versionTo} maxLength={40} onChange={(e) => setF({ ...f, versionTo: e.target.value })} /></div>
          </div>
          <div className="field"><label htmlFor="fw-doors">Locks (door numbers, e.g. 804 809 404); empty = all locks</label><input id="fw-doors" value={f.doors} onChange={(e) => setF({ ...f, doors: e.target.value })} /></div>
          <div className="field"><label htmlFor="fw-notes">Notes (who did it, firmware pack, with which tool)</label><textarea id="fw-notes" rows={3} value={f.notes} maxLength={1000} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
          <ErrorNote error={error} />
          <button className="btn primary" disabled={!f.doneOn} onClick={save}>Save</button>
          <p className="small muted">The portal then compares, for the locks concerned, how long battery sets lasted before and after this date, using the paper logs and the lock reports.</p>
        </Drawer>
      )}
    </div>
  );
}

/** 2.34 Photos and screenshots attached to a piece of work. */
function Photos({ doorId, workId, title, onClose }: { doorId: string; workId: string; title: string; onClose: () => void }) {
  const { base } = useHotel();
  const path = `${base}/lock-history/${encodeURIComponent(doorId)}/work/${workId}/files`;
  const list = useApi<{ files: { id: string; name: string }[] }>(path, [workId]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true; const made: string[] = [];
    (async () => { for (const f of list.data?.files ?? []) { try { const u = await blobUrl(`${path}/${f.id}`); made.push(u); if (live) setUrls((m) => ({ ...m, [f.id]: u })); } catch (e) { if (live) setError(e); } } })();
    return () => { live = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [list.data, path]);
  return (
    <Drawer title={`Photos · ${title}`} onClose={onClose}>
      <ErrorNote error={list.error ?? error} />
      {(list.data?.files ?? []).map((f) => <figure key={f.id} style={{ margin: '0 0 12px' }}>{urls[f.id] ? <a href={urls[f.id]} target="_blank" rel="noreferrer"><img src={urls[f.id]} alt={f.name} style={{ maxWidth: '100%', borderRadius: 6 }} /></a> : <p className="muted small">Loading…</p>}<figcaption className="small muted">{f.name}</figcaption></figure>)}
    </Drawer>
  );
}

/**
 * 2.34 The day report (Armel: "a report at the end of the day that shows on which floor, when the batteries were
 * replaced, which equipment was replaced as per the paperwork, the status"): one day or a period. Printable and for Excel.
 */
interface DayEntry { on: string; doorId: string; door: string; floor: string | null; model: string | null; kind: 'work' | 'problem' | 'measured' | 'battery-seen'; parts: string[]; batteries: string | null;
  voltsIdle: number | null; voltsLoaded: number | null; voltsBefore: number | null; voltsAfter: number | null; swappedFrom: string | null; by: string | null; notes: string | null; files: number; state: keyof typeof STATE }
interface DayReportData { from: string; to: string; today: string; entries: DayEntry[]; soon: { doorId: string; door: string; floor: string | null; lastChange: string | null; expectedLowOn: string | null; daysLeft: number | null; lifeDays: number | null; basis: string | null; state: keyof typeof STATE }[];
  reminders: { doorId: string; door: string; floor: string | null; title: string; detail: string }[]; states: Record<string, number>; counts: { work: number; problems: number; batteries: number; locks: number } }
const KIND: Record<DayEntry['kind'], { cls: string; label: string }> = { work: { cls: 'ok', label: 'Work' }, problem: { cls: 'bad', label: 'Problem' }, measured: { cls: '', label: 'Measured' }, 'battery-seen': { cls: 'warn', label: 'Batteries (not recorded)' } };
export function DayReport() {
  const { base, hotel } = useHotel();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const r = useApi<DayReportData>(`${base}/lock-history/day-report?from=${from}&to=${to < from ? from : to}`, [from, to]);
  const x = r.data;
  const shift = (n: number) => { const d = new Date(Date.parse(`${from}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); setFrom(d); setTo(d); };
  const exportCsv = () => x && saveCsv(['Date', 'Floor', 'Door', 'Lock model', 'What', 'Parts changed or checked', 'Batteries', 'At rest (V)', 'Under load (V)', 'Pack before (V)', 'Pack after (V)', 'Swapped with door', 'Done by', 'Notes', 'Lock state'],
    x.entries.map((e) => [e.on, e.floor, e.door, e.model, KIND[e.kind].label, e.parts.join(', '), e.batteries, e.voltsIdle, e.voltsLoaded, e.voltsBefore, e.voltsAfter, e.swappedFrom, e.by, e.notes, STATE[e.state]?.label ?? e.state]),
    `${hotel.slug}-lock-report-${from}${to !== from ? `_${to}` : ''}.csv`);
  return (
    <div className="lh-day">
      <div className="row no-print lh-filters" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn small" onClick={() => shift(-1)} aria-label="Previous day">‹</button>
        <label className="small">From <input type="date" value={from} max={today} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} /></label>
        <label className="small">to <input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="btn small" onClick={() => shift(1)} disabled={from >= today} aria-label="Next day">›</button>
        <button className="btn small" onClick={() => { setFrom(today); setTo(today); }}>Today</button>
        <button className="btn small" onClick={() => { const d = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10); setFrom(d); setTo(today); }}>Last 7 days</button>
        <span style={{ marginLeft: 'auto' }} />
        <button className="btn small" onClick={() => window.print()}>Print</button>
        <button className="btn small" disabled={!x} onClick={exportCsv}>Excel (CSV)</button>
      </div>
      <ErrorNote error={r.error} />
      {x && <>
        <h2 className="section-title print-title">{hotel.name} · locks {from === to ? day(from) : `${day(from)} – ${day(to)}`}</h2>
        <div className="lh-kpis">
          <div className="lh-kpi"><strong>{x.counts.locks}</strong><span>lock(s) worked on</span></div>
          <div className="lh-kpi"><strong>{x.counts.batteries}</strong><span>battery change(s)</span></div>
          <div className="lh-kpi"><strong>{x.counts.work}</strong><span>piece(s) of work</span></div>
          <div className={`lh-kpi ${x.counts.problems ? 'bad' : ''}`}><strong>{x.counts.problems}</strong><span>problem(s) seen</span></div>
          <div className="lh-kpi bad"><strong>{x.states.draining ?? 0}</strong><span>locks draining (all)</span></div>
        </div>
        <section className="panel" style={{ padding: 0 }}>
          <h3 className="lh-todo-h">What was done and seen</h3>
          {!x.entries.length ? <p className="empty" style={{ padding: '0 16px 16px' }}>Nothing recorded {from === to ? 'on this day' : 'in this period'}. Use "Record work on a lock" or "Report a problem" (from the paper log too).</p> : (
            <div className="table-scroll"><table className="grid">
              <thead><tr>{from !== to && <th>Date</th>}<th>Floor</th><th>Door</th><th>What</th><th>Changed or checked</th><th>Volts (rest / load)</th><th>By</th><th>State now</th></tr></thead>
              <tbody>{x.entries.map((e, i) => (
                <tr key={i}>
                  {from !== to && <td className="nowrap small">{day(e.on)}</td>}
                  <td className="small">{e.floor ?? '—'}</td>
                  <td><Link to={`/lock-troubleshoot/door/${encodeURIComponent(e.doorId)}`}><strong>{e.door}</strong></Link>{e.model && <div className="small muted">{e.model}</div>}</td>
                  <td><span className={`badge ${KIND[e.kind].cls}`}>{KIND[e.kind].label}</span></td>
                  <td className="small">{e.parts.map((t) => tr(t)).join(', ')}{e.batteries && <div className="muted">Batteries: {e.batteries}</div>}{e.swappedFrom && <div className="muted">Swapped with door {e.swappedFrom}</div>}{e.notes && <div className="muted">{e.notes}</div>}</td>
                  <td className="small nowrap">{e.voltsIdle != null || e.voltsLoaded != null ? `${e.voltsIdle ?? '—'} / ${e.voltsLoaded ?? '—'} V` : e.voltsBefore != null || e.voltsAfter != null ? `pack ${e.voltsBefore ?? '—'} → ${e.voltsAfter ?? '—'} V` : '—'}</td>
                  <td className="small">{e.by ?? '—'}</td>
                  <td><span className={`badge ${STATE[e.state]?.cls ?? ''}`}>{STATE[e.state]?.label ?? e.state}</span></td>
                </tr>))}</tbody>
            </table></div>
          )}
        </section>
        {x.reminders.length > 0 && (
          <section className="panel" style={{ padding: 0 }}>
            <h3 className="lh-todo-h">Reminders <span className="badge bad">{x.reminders.length}</span></h3>
            <table className="grid"><tbody>{x.reminders.map((m, i) => <tr key={i}><td className="nowrap" style={{ width: 120 }}><Link to={`/lock-troubleshoot/door/${encodeURIComponent(m.doorId)}`}><strong>{m.door}</strong></Link><div className="small muted">{m.floor ?? ''}</div></td><td className="small"><strong>{m.title}</strong><div className="muted">{m.detail}</div></td></tr>)}</tbody></table>
          </section>
        )}
        <section className="panel" style={{ padding: 0 }}>
          <h3 className="lh-todo-h">Prepare: batteries expected low soon <span className="badge">{x.soon.length}</span></h3>
          {!x.soon.length ? <p className="empty" style={{ padding: '0 16px 16px' }}>No lock is expected to be low within 7 days.</p> : (
            <table className="grid"><thead><tr><th>Floor</th><th>Door</th><th>Last battery change</th><th>Expected low</th><th className="num">A set lasts</th></tr></thead>
              <tbody>{x.soon.map((s) => <tr key={s.doorId}><td className="small">{s.floor ?? '—'}</td><td><Link to={`/lock-troubleshoot/door/${encodeURIComponent(s.doorId)}`}><strong>{s.door}</strong></Link></td><td className="small">{day(s.lastChange)}</td>
                <td className="small nowrap"><span className={`badge ${lowCls(s as unknown as Forecast)}`}>{lowIn(s as unknown as Forecast)}</span> {day(s.expectedLowOn)}</td><td className="num small">{s.lifeDays != null ? `${s.lifeDays} d` : '—'}<div className="muted">{s.basis === 'this lock' ? 'this lock' : s.basis === 'lock report' ? 'lock report' : 'hotel'}</div></td></tr>)}</tbody></table>
          )}
        </section>
      </>}
    </div>
  );
}
