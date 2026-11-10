import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useHotel } from '../App';
import { Drawer, ErrorNote, PageHead, fmt, useApi } from '../ui';
import { parsePaperLog } from '../paper-log';

/**
 * 2.30 Lock history and the elimination method (Armel, 9 Nov): how many times a lock's batteries were changed, which
 * parts were changed or checked (Novel locks have their own), and — from the lock reports uploaded after the work —
 * whether the batteries are fine since the swap or still draining, with the next part to check.
 */
interface Part { id: string; name: string; group: string; novel?: boolean; notNovel?: boolean; action?: boolean; only?: string[]; not?: string[] }
interface Catalogue { models: { id: string; name: string }[]; parts: Part[]; groups: { id: string; name: string; why: string }[]; batteryTypes: { id: string; name: string }[]; recommended: string }
interface Rate { per30Days: number; days: number; readings: number; lifeDays: number | null }
interface WorkRow { id: string; on: string; parts: string[]; partNames: string[]; otherPart: string | null; batteryTypeName: string | null; batteryBrand: string | null; notes: string | null; by: string | null; recordedBy: string | null;
  verdict: 'waiting' | 'fixed' | 'better' | 'ok' | 'watch' | 'same' | 'worse' | 'draining'; title: string; detail: string; before: Rate | null; after: Rate | null; againInDays: number | null; alarmsAfter: number; waitUntil: string | null }
interface History {
  door: { id: string; name: string; group: string | null; online: boolean | null }; lockModel: string | null; lockModelName: string | null; novel: boolean;
  batteries: { changes: { day: string; sources: string[]; batteryTypeName: string | null; brand: string | null }[]; count: number; lastedDays: number[]; avgDays: number | null; daysSinceLast: number | null; recommended: string;
    notRecommended: { on: string; type: string; brand: string | null }[]; estimatedDaysPerSet: number | null; avgDropPer30Days: number | null; scale: { top: number; alarmLevel: number } };
  readings: { t: string; volts: number }[]; work: WorkRow[];
  sets: { from: string; to: string; days: number; finished: boolean; openingsPerDay: number | null; perThousand: number | null; per30: number | null; reached: { volts: number; days: number | null }[];
    firstAlarmDays: number | null; alarms: number; firmwareAlarms: number; restarts: number | null; cardErrors: number | null; internalErrors: number | null; deadbolt: number | null; work: { id: string; on: string; parts: string[] }[] }[]; reports: { id: string; fileName: string; from: string | null; to: string | null; uploadedAt: string }[];
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
const rate = (r: Rate | null) => (r ? `${r.per30Days.toFixed(2)} V/30 d${r.lifeDays != null ? ` · ~${r.lifeDays} d a set` : ' · no drop'}` : '—');

/** The locks with a history, for the Lock troubleshooting page. */
export function LockHistoryList() {
  const { base, can } = useHotel();
  const list = useApi<{ locks: any[]; years: { year: string; sets: number; medianDays: number; shortest: number; longest: number }[] }>(`${base}/lock-history`, []);
  const [record, setRecord] = useState(false);
  const nav = useNavigate();
  const rows = list.data?.locks ?? [];
  const years = list.data?.years ?? [];
  return (
    <section className="panel" style={{ padding: 0 }}>
      <div className="row" style={{ justifyContent: 'space-between', padding: '14px 16px 6px', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>Locks: batteries, work done and the cause</h2>
          <p className="small muted" style={{ margin: '4px 0 0' }}>How many times each lock had new batteries, what was changed, and whether the batteries are fine since. Recommended batteries: <strong>industrial alkaline AA</strong>.</p>
        </div>
        {(can('maintenance.work') || can('battery.manage')) && <button className="btn primary" data-tip="Record batteries or parts changed on a lock, and what was checked. The portal then tells from the next lock report whether it worked." onClick={() => setRecord(true)}>Record work on a lock</button>}
      </div>
      <ErrorNote error={list.error} />
      {years.length > 1 && (
        <div className="lh-years" style={{ padding: '0 16px 10px' }} data-tip="How long sets of batteries lasted, by the year they were fitted, over all the locks with a history. A sudden drop on many locks at once points to a common cause: a new battery supply, a setting, a firmware.">
          <span className="small muted">Days a set lasted (median, all locks):</span>
          {years.map((y) => <span key={y.year} className={`badge ${y.medianDays < 120 ? 'bad' : y.medianDays < 300 ? 'warn' : 'ok'}`}>{y.year}: {y.medianDays} d <span className="muted">({y.sets} sets)</span></span>)}
        </div>
      )}
      {!rows.length && !list.loading ? <p className="empty" style={{ padding: '0 16px 16px' }}>No history yet. Record the work done on a lock (batteries, parts) or upload a lock report.</p> : (
        <div className="table-scroll"><table className="grid">
          <thead><tr><th>Door and lock</th><th>State</th><th className="num">Battery changes</th><th className="num">Days a set (avg)</th><th>Last work</th><th>Next to check</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.doorId}>
              <td><Link to={`/lock-troubleshoot/door/${encodeURIComponent(r.doorId)}`}><strong>{r.doorName}</strong></Link><div className="small muted">{r.lockModel ?? 'model not given'}{r.group ? ` · ${r.group}` : ''} · {r.reports} report(s)</div></td>
              <td><span className={`badge ${STATE[r.state as History['elimination']['state']]?.cls ?? ''}`}>{STATE[r.state as History['elimination']['state']]?.label ?? r.state}</span>{r.notRecommended > 0 && <div className="small warn-text">batteries not recommended</div>}</td>
              <td className="num">{r.batteryChanges}{r.daysSinceLast != null && <div className="small muted">last {r.daysSinceLast} d ago</div>}</td>
              <td className="num">{r.avgDays ?? '—'}</td>
              <td className="small">{r.lastWork ? <>{day(r.lastWork.on)}: {r.lastWork.parts.join(', ')}<div><span className={`badge ${WORK_VERDICT[r.lastWork.verdict as WorkRow['verdict']]?.cls ?? ''}`}>{WORK_VERDICT[r.lastWork.verdict as WorkRow['verdict']]?.label}</span></div></> : '—'}</td>
              <td className="small">{r.next ?? '—'}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      {record && <RecordWork onClose={() => setRecord(false)} onDone={(doorId) => { setRecord(false); void list.reload(); nav(`/lock-troubleshoot/door/${encodeURIComponent(doorId)}`); }} />}
    </section>
  );
}

export function DoorHistoryPage() {
  const { doorId = '' } = useParams();
  const { base, can } = useHotel();
  const h = useApi<History>(`${base}/lock-history/${encodeURIComponent(doorId)}`, [doorId]);
  const [record, setRecord] = useState(false);
  const [paper, setPaper] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const x = h.data;
  if (!x) return <><PageHead title="Lock history" /><ErrorNote error={h.error} />{h.loading && <p className="muted">Loading…</p>}</>;
  const e = x.elimination;
  const del = async (id: string) => { if (!confirm('Remove this record of work?')) return; try { await api(`${base}/lock-history/${encodeURIComponent(doorId)}/work/${id}`, { method: 'DELETE' }); void h.reload(); } catch (err) { setError(err); } };
  const canRecord = can('maintenance.work') || can('battery.manage');
  return (
    <div className="lock-history">
      <PageHead title={`Lock ${x.door.name}`} intro={<><strong>{x.lockModelName ?? 'Lock model not given'}</strong>{x.door.group ? ` · ${x.door.group}` : ''}{x.door.online === true ? ' · online lock' : x.door.online === false ? ' · offline (stand-alone) lock' : ''}. Batteries, work done and whether the batteries are fine since.</>}>
        <Link className="btn no-print" to="/lock-troubleshoot">All locks</Link>
        <button className="btn no-print" onClick={() => window.print()}>Print</button>
        {canRecord && <button className="btn no-print" data-tip="Type in the battery card kept in the lock (date, what was changed, who): one line each." onClick={() => setPaper(true)}>Add from the paper log</button>}
        {canRecord && <button className="btn primary no-print" onClick={() => setRecord(true)}>Record work</button>}
      </PageHead>
      <ErrorNote error={error} />

      <section className={`panel verdict v-${e.state === 'draining' ? 'attention' : e.state === 'solved' ? 'ok' : 'check'}`}>
        <h2 style={{ margin: 0 }}><span className={`badge ${STATE[e.state].cls}`}>{STATE[e.state].label}</span></h2>
        {e.state === 'solved' && <p>The last work fixed it: the batteries last since. Keep uploading a report at each battery check to confirm.</p>}
        {e.state === 'waiting' && <p>Read the lock and upload its report after <strong>{day(x.work[x.work.length - 1]?.waitUntil)}</strong>: the portal then compares battery use before and after the last work.</p>}
        {e.next && e.state !== 'solved' && (
          <div className="elim-next">
            <p style={{ margin: '6px 0 4px' }}><strong>Next to check: {e.next.name}</strong>{e.next.suggestedByReport === 'likely' && <span className="badge bad" style={{ marginLeft: 6 }}>likely from the lock report</span>}</p>
            <p className="small muted" style={{ margin: 0 }}>{e.next.why}</p>
            <p className="small" style={{ margin: '4px 0 0' }}>{e.next.parts.join(' · ')}</p>
          </div>
        )}
        {(e.tried.length > 0 || e.remaining.length > 0) && <p className="small muted" style={{ marginBottom: 0 }}>{e.tried.length > 0 && <>Already changed or checked: {e.tried.join(', ')}. </>}{e.remaining.length > 1 && <>Left after that: {e.remaining.slice(1).join(', ')}.</>}</p>}
      </section>

      <div className="rep-figures" style={{ margin: '12px 0' }}>
        <div><strong>{x.batteries.count}</strong><span>battery changes</span></div>
        <div><strong>{x.batteries.avgDays ?? '—'}</strong><span>days a set, on average</span></div>
        <div><strong>{x.batteries.daysSinceLast ?? '—'}</strong><span>days since the last change</span></div>
        <div><strong>{x.batteries.estimatedDaysPerSet ?? '—'}</strong><span>days a set at the current rate</span></div>
        <div><strong>{x.work.length}</strong><span>pieces of work recorded</span></div>
      </div>
      <div className="alert" role="note"><strong>Recommended batteries: {x.batteries.recommended}.</strong> Consumer alkaline, mixed packs or rechargeable batteries do not last in VingCard locks and can raise false alarms.
        {x.batteries.notRecommended.length > 0 && <div className="warn-text" style={{ marginTop: 4 }}>Fitted here: {x.batteries.notRecommended.map((n) => `${n.type}${n.brand ? ` (${n.brand})` : ''} on ${day(n.on)}`).join('; ')}.</div>}</div>

      <h2 className="section-title">Work done and what it changed</h2>
      {!x.work.length ? <div className="panel"><p className="empty">No work recorded on this lock yet.{canRecord && ' Use "Record work" after each visit: batteries (with their type) and every part changed or checked.'}</p></div> : (
        <div className="panel" style={{ padding: 0 }}><div className="table-scroll"><table className="grid">
          <thead><tr><th>Date</th><th>Changed or checked</th><th>Result since</th><th>Battery use before → after</th><th /></tr></thead>
          <tbody>{[...x.work].reverse().map((w) => (
            <tr key={w.id}>
              <td className="nowrap">{day(w.on)}{w.by && <div className="small muted">{w.by}</div>}</td>
              <td className="small">{w.partNames.join(', ')}{w.batteryTypeName && <div className={w.batteryTypeName.startsWith('Industrial') ? 'muted' : 'warn-text'}>Batteries: {w.batteryTypeName}{w.batteryBrand ? `, ${w.batteryBrand}` : ''}</div>}{w.notes && <div className="muted">{w.notes}</div>}</td>
              <td className="small"><span className={`badge ${WORK_VERDICT[w.verdict].cls}`}>{WORK_VERDICT[w.verdict].label}</span> <strong>{w.title}</strong><div className="muted">{w.detail}</div></td>
              <td className="small nowrap">{rate(w.before)}<br />→ {rate(w.after)}{w.againInDays != null && <div className="muted">new batteries again after {w.againInDays} d</div>}</td>
              <td>{can('battery.manage') && <button className="btn small ghost no-print" onClick={() => void del(w.id)}>Remove</button>}</td>
            </tr>))}</tbody>
        </table></div></div>
      )}

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

      {x.readings.length > 1 && <><h2 className="section-title">Battery level from the lock reports</h2><div className="panel"><VoltLine h={x} /></div></>}

      <h2 className="section-title">Lock reports of this door ({x.reports.length})</h2>
      <div className="panel">
        {!x.reports.length ? <p className="empty">None yet. Read the lock with the service device, save its events from Visionline and upload them on Lock troubleshooting.</p>
          : <ul className="plain">{x.reports.map((r) => <li key={r.id}><Link to={`/lock-troubleshoot/${r.id}`}>{r.fileName}</Link> <span className="small muted">events {day(r.from)} – {day(r.to)}, uploaded {fmt.dt(r.uploadedAt)}</span></li>)}</ul>}
      </div>
      {paper && <PaperLog doorId={x.door.id} doorName={x.door.name} model={x.lockModel} existing={x.work} onClose={() => setPaper(false)} onDone={() => { setPaper(false); void h.reload(); }} />}
      {record && <RecordWork doorId={x.door.id} doorName={x.door.name} model={x.lockModel} onClose={() => setRecord(false)} onDone={() => { setRecord(false); void h.reload(); }} />}
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
      {h.work.map((w) => { const t = Date.parse(`${w.on}T12:00:00Z`); if (t < x0 || t > x1) return null; return <g key={w.id}><line x1={X(t)} x2={X(t)} y1={6} y2={H - 26} stroke="var(--brass, #b08d57)" strokeWidth="2" /><text x={X(t) + 3} y={14} fontSize="10" fill="currentColor">{w.partNames[0]?.split(' ')[0]}</text></g>; })}
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" />
      {pts.map((p, i) => <circle key={i} cx={X(p.x)} cy={Y(p.y)} r="2.5" fill="currentColor"><title>{`${new Date(p.x).toISOString().slice(0, 16).replace('T', ' ')}: below ${p.y.toFixed(1)} V`}</title></circle>)}
      <text x={P} y={H - 8} fontSize="10" fill="currentColor">{new Date(x0).toISOString().slice(0, 10)}</text>
      <text x={W - 10} y={H - 8} fontSize="10" textAnchor="end" fill="currentColor">{new Date(x1).toISOString().slice(0, 10)}</text>
    </svg>
  );
}

/** Record work done on a lock: date, who, the lock model, parts changed or checked, the batteries fitted. */
function RecordWork({ doorId, doorName, model, onClose, onDone }: { doorId?: string; doorName?: string; model?: string | null; onClose: () => void; onDone: (doorId: string) => void }) {
  const { base, can } = useHotel();
  const cat = useApi<Catalogue>(`${base}/lock-history/catalogue`, []);
  const doors = useApi<any[]>(can('resources.read') && !doorId ? `${base}/resources?kind=door` : null, []);
  const [door, setDoor] = useState(doorId ?? '');
  const [lockModel, setLockModel] = useState(model ?? '');
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  const [parts, setParts] = useState<string[]>([]);
  const [other, setOther] = useState('');
  const [btype, setBtype] = useState('industrial-alkaline');
  const [brand, setBrand] = useState('');
  const [by, setBy] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const novel = lockModel.startsWith('novel');
  const alfa = lockModel === 'classic-alfa';
  const c = cat.data;
  const groups = useMemo(() => (c?.groups ?? []).map((g) => ({ ...g, parts: partsFor(c?.parts ?? [], lockModel).filter((p) => p.group === g.id) })).filter((g) => g.parts.length), [c, lockModel]);
  const toggle = (id: string) => setParts(parts.includes(id) ? parts.filter((p) => p !== id) : [...parts, id]);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await api(`${base}/lock-history/${encodeURIComponent(door)}/work`, { body: { doneOn: on, parts, otherPart: other || undefined, batteryType: parts.includes('batteries') ? btype : undefined, batteryBrand: brand || undefined, doneBy: by || undefined, notes: notes || undefined, lockModel: lockModel || undefined } });
      onDone(door);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const doorList = (doors.data ?? []).filter((d) => d.active).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return (
    <Drawer title={doorName ? `Record work on ${doorName}` : 'Record work on a lock'} onClose={onClose}>
      {!doorId && (
        <div className="field"><label htmlFor="rw-door">Door</label>
          <select id="rw-door" value={door} onChange={(e) => setDoor(e.target.value)}><option value="">Choose the door…</option>{doorList.map((d) => <option key={d.external_id} value={d.external_id}>{d.name}</option>)}</select></div>
      )}
      <div className="field-row">
        <div className="field"><label htmlFor="rw-on">Date of the work</label><input id="rw-on" type="date" value={on} max={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} onChange={(e) => setOn(e.target.value)} /></div>
        <div className="field"><label htmlFor="rw-model">Lock model</label><select id="rw-model" value={lockModel} onChange={(e) => setLockModel(e.target.value)}><option value="">Not sure</option>{(c?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>Tick everything changed or checked, in the order of the elimination method: simplest first.{novel && ' Novel parts are shown for this lock.'}{alfa && ' Classic Alfa: batteries, battery holder, LCU, LCA and lockcase.'}</p>
      {groups.map((g) => (
        <fieldset key={g.id} className="rw-group"><legend data-tip={g.why}>{g.name}</legend>
          {g.parts.map((p) => <label key={p.id} className="check"><input type="checkbox" checked={parts.includes(p.id)} onChange={() => toggle(p.id)} /> {p.name}</label>)}
        </fieldset>
      ))}
      <div className="field"><label htmlFor="rw-other">Other part (if not in the list)</label><input id="rw-other" value={other} maxLength={120} onChange={(e) => setOther(e.target.value)} /></div>
      {parts.includes('batteries') && (
        <div className="field-row">
          <div className="field"><label htmlFor="rw-bt">Batteries fitted</label><select id="rw-bt" value={btype} onChange={(e) => setBtype(e.target.value)}>{(c?.batteryTypes ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            {btype !== 'industrial-alkaline' && <span className="hint warn-text">Industrial alkaline AA batteries are recommended.</span>}</div>
          <div className="field"><label htmlFor="rw-brand">Brand (optional)</label><input id="rw-brand" value={brand} maxLength={60} onChange={(e) => setBrand(e.target.value)} /></div>
        </div>
      )}
      <div className="field"><label htmlFor="rw-by">Done by (technician)</label><input id="rw-by" value={by} maxLength={80} onChange={(e) => setBy(e.target.value)} /></div>
      <div className="field"><label htmlFor="rw-notes">Notes (what you saw: moisture, pinched cable, door rubbing…)</label><textarea id="rw-notes" rows={3} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} /></div>
      <ErrorNote error={error} />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={busy || !door || (!parts.length && !other.trim())} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
      <p className="small muted">After the work, read the lock again in 3 weeks or more and upload its report: the portal compares the battery use before and after, and says whether this part was the cause.</p>
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
