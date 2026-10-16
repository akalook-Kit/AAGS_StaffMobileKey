import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, auth, ApiError, download } from '../api';
import { useHotel } from '../App';
import { Drawer, ErrorNote, PageHead, useApi } from '../ui';
import { NoData } from '../components/charts';

/**
 * Time & attendance (2.8): check-in desk, timesheets, people (with or without a keycard), shifts, leave and public
 * holidays, approval and payroll exports (CSV, JSON, PDF), setup (attendance doors and rules).
 */
const STATE: Record<string, { l: string; c: string }> = {
  in: { l: 'In', c: 'ok' }, out: { l: 'Checked out', c: 'idle' }, not_in: { l: 'Not in yet', c: 'warn' }, leave: { l: 'On leave', c: 'idle' }, holiday: { l: 'Public holiday', c: 'idle' }, off: { l: 'Day off', c: 'idle' },
};
const DAY_STATUS: Record<string, string> = { present: 'Present', incomplete: 'No check-out', absent: 'Absent', leave: 'Leave', holiday: 'Holiday', off: 'Off', future: '' };
const ABSENCE: Record<string, string> = { annual_leave: 'Annual leave', sick: 'Sick leave', day_off: 'Day off', public_holiday: 'Public holiday', unpaid: 'Unpaid leave', other: 'Other' };
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const h = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);
function presetRange(p: string) {
  const now = new Date(); const t = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const wd = (t.getUTCDay() + 6) % 7; const add = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);
  if (p === 'this_week') return { from: iso(add(t, -wd)), to: iso(add(t, 6 - wd)) };
  if (p === 'last_week') return { from: iso(add(t, -wd - 7)), to: iso(add(t, -wd - 1)) };
  if (p === 'last_month') { const f = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1)); return { from: iso(f), to: iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0))) }; }
  const f = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)); return { from: iso(f), to: iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0))) };
}

export function AttendancePage() {
  const { can } = useHotel();
  const [sp, setSp] = useSearchParams();
  const tabs = [
    can('attendance.clock') && { id: 'desk', l: 'Check-in desk' },
    can('attendance.read') && { id: 'timesheets', l: 'Timesheets' },
    can('attendance.clock') && { id: 'people', l: 'People' },
    can('attendance.read') && { id: 'shifts', l: 'Shifts' },
    can('attendance.read') && { id: 'leave', l: 'Leave & holidays' },
    can('attendance.read') && { id: 'payroll', l: 'Payroll' },
    can('attendance.read') && { id: 'setup', l: 'Setup' },
  ].filter(Boolean) as { id: string; l: string }[];
  const tab = tabs.some((t) => t.id === sp.get('tab')) ? sp.get('tab')! : tabs[0]?.id ?? 'desk';
  return (
    <>
      <PageHead title="Time & attendance" intro="Check staff in and out, see timesheets, record leave and send the hours to payroll. Keycard holders are clocked by the attendance doors; people without a card (daily workers) are checked in at the desk or entered by HR." />
      <div className="seg" role="tablist" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        {tabs.map((t) => <button key={t.id} role="tab" aria-pressed={tab === t.id} onClick={() => setSp({ tab: t.id })}>{t.l}</button>)}
      </div>
      {tab === 'desk' ? <Desk /> : tab === 'timesheets' ? <Timesheets /> : tab === 'people' ? <People /> : tab === 'shifts' ? <Shifts /> : tab === 'leave' ? <Leave /> : tab === 'payroll' ? <Payroll /> : <Setup />}
    </>
  );
}

function ModuleOff({ error }: { error: unknown }) {
  const { can } = useHotel();
  if (error instanceof ApiError && error.code === 'MODULE_OFF' || (typeof error === 'string' && /switched off/.test(error)))
    return <div className="alert warn">Time & attendance is switched off for this hotel. {can('settings.manage') ? <Link to="/settings?tab=features">Settings → Modules</Link> : 'Ask a hotel administrator to switch it on (Settings → Modules).'}</div>;
  return <ErrorNote error={error} />;
}

// ---- check-in desk ----
function Desk() {
  const { base, can } = useHotel();
  const t = useApi<any>(`${base}/attendance/today`, [], 30_000);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<string>('all');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [other, setOther] = useState<any>(null);
  const clock = async (p: any, direction: 'in' | 'out', at?: string, reason?: string) => {
    setError(null); setMsg(null);
    try {
      const r = await api(`${base}/attendance/clock`, { body: { personId: p.id, direction, ...(at ? { at: new Date(at).toISOString(), reason } : {}) } });
      setMsg(`${r.name} checked ${direction} at ${new Date(r.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', ...(t.data?.tz ? { timeZone: t.data.tz } : {}) })}.`);
      setOther(null); await t.reload();
    } catch (e) { setError(e); }
  };
  if (t.error) return <ModuleOff error={t.error} />;
  const d = t.data;
  if (!d) return null;
  const list = d.people.filter((p: any) => (filter === 'all' || p.state === filter) && (!q.trim() || `${p.name} ${p.employeeNo ?? ''} ${p.department ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())));
  const time = (v: string | null) => (v ? new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: d.tz }) : '—');
  return (
    <>
      <div className="mon-tiles">
        {[['in', 'in now', 'ok'], ['not_in', 'not in yet', d.counts.notIn ? 'warn' : 'ok'], ['out', 'checked out', ''], ['leave', 'on leave / holiday', '']].map(([k, l, c]) => (
          <button key={k} className={`mon-tile ${c}`} aria-pressed={filter === k} onClick={() => setFilter(filter === k ? 'all' : k!)}><strong>{k === 'leave' ? d.counts.leave : d.counts[k === 'not_in' ? 'notIn' : k!]}</strong><span>{l}</span></button>
        ))}
      </div>
      <ErrorNote error={error} />
      {msg && <div className="alert ok" role="status">{msg}</div>}
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <input type="search" autoFocus placeholder="Name, payroll number or department" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 280, padding: '8px 10px', fontSize: 16 }} aria-label="Find a person" />
          <span className="small muted">Today, {d.date} · {d.counts.total} people · refreshes every 30 seconds</span>
        </div>
        {!d.people.length ? <NoData text="Nobody to check in yet" hint={can('attendance.manage') ? 'Add people in the People tab (import staff or keycard holders, or add daily workers).' : 'HR adds people in the People tab.'} />
          : !list.length ? <NoData text="Nobody matches" hint="Clear the search or the filter." />
          : (
          <table className="grid desk"><thead><tr><th>Person</th><th>Shift</th><th>Status</th><th>In</th><th>Out</th><th /></tr></thead><tbody>
            {list.map((p: any) => (
              <tr key={p.id}>
                <td><strong>{p.name}</strong><span className="sub">{[p.employeeNo, p.department, p.kind === 'manual' ? 'no keycard' : null].filter(Boolean).join(' · ')}</span></td>
                <td className="small">{p.shift ?? '—'}</td>
                <td><span className={`att-state ${STATE[p.state]?.c ?? ''}`}>{STATE[p.state]?.l ?? p.state}</span>{p.day.lateMinutes > 0 && <span className="small bad-text"> · late {p.day.lateMinutes >= 60 ? `${h(p.day.lateMinutes)} h` : `${p.day.lateMinutes} min`}</span>}</td>
                <td>{time(p.day.firstIn)}</td><td>{time(p.day.lastOut)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {p.state === 'in' ? <button className="btn" onClick={() => clock(p, 'out')}>Check out</button> : <button className="btn primary" onClick={() => clock(p, 'in')}>Check in</button>}
                  {can('attendance.manage') && <> <button className="btn small ghost" onClick={() => setOther(p)} title="Enter another time (with a reason)">Other time…</button></>}
                </td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>
      {other && <OtherTime p={other} onClose={() => setOther(null)} onSave={(dir, at, reason) => clock(other, dir, at, reason)} />}
    </>
  );
}

function OtherTime({ p, onClose, onSave }: { p: any; onClose: () => void; onSave: (d: 'in' | 'out', at: string, reason: string) => void }) {
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [dir, setDir] = useState<'in' | 'out'>(p.state === 'in' ? 'out' : 'in');
  const [at, setAt] = useState(now);
  const [reason, setReason] = useState('');
  return (
    <Drawer title={`Another time for ${p.name}`} onClose={onClose} footer={<><span /><div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={reason.trim().length < 3} onClick={() => onSave(dir, at, reason)}>Save</button></div></>}>
      <div className="seg" style={{ marginBottom: 10 }}><button aria-pressed={dir === 'in'} onClick={() => setDir('in')}>Check in</button><button aria-pressed={dir === 'out'} onClick={() => setDir('out')}>Check out</button></div>
      <div className="field"><label htmlFor="ot">Time (this computer's clock)</label><input id="ot" type="datetime-local" value={at} max={now} onChange={(e) => setAt(e.target.value)} /></div>
      <div className="field"><label htmlFor="or">Reason</label><input id="or" value={reason} maxLength={300} placeholder="e.g. forgot to check out, card not working" onChange={(e) => setReason(e.target.value)} /><span className="hint">Kept with the record and in the audit trail.</span></div>
    </Drawer>
  );
}

// ---- timesheets ----
function PeriodPicker({ value, onChange, extra }: { value: { from: string; to: string }; onChange: (v: { from: string; to: string }) => void; extra?: React.ReactNode }) {
  return (
    <div className="ev-sel">
      <div className="seg">{[['this_week', 'This week'], ['last_week', 'Last week'], ['this_month', 'This month'], ['last_month', 'Last month']].map(([k, l]) => <button key={k} aria-pressed={JSON.stringify(presetRange(k!)) === JSON.stringify(value)} onClick={() => onChange(presetRange(k!))}>{l}</button>)}</div>
      <label className="slicer"><span>From</span><input type="date" value={value.from} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} /></label>
      <label className="slicer"><span>To</span><input type="date" value={value.to} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} /></label>
      {extra}
    </div>
  );
}
function useRange(key: string, def = 'this_week') {
  const [sp, setSp] = useSearchParams();
  const v = sp.get('from') && sp.get('to') ? { from: sp.get('from')!, to: sp.get('to')! } : presetRange(def);
  const set = (r: { from: string; to: string }) => { const n = new URLSearchParams(sp); n.set('from', r.from); n.set('to', r.to); n.set('tab', key); setSp(n, { replace: true }); };
  return [v, set] as const;
}

function Timesheets() {
  const { base } = useHotel();
  const [range, setRange] = useRange('timesheets');
  const [dept, setDept] = useState('');
  const qs = new URLSearchParams({ from: range.from, to: range.to, ...(dept ? { department: dept } : {}) }).toString();
  const t = useApi<any>(`${base}/attendance/timesheet?${qs}`, [qs]);
  const [open, setOpen] = useState<any>(null);
  const depts = useMemo(() => [...new Set((t.data?.people ?? []).map((p: any) => p.department).filter(Boolean))].sort() as string[], [t.data]);
  if (t.error) return <><PeriodPicker value={range} onChange={setRange} /><ModuleOff error={t.error} /></>;
  const ppl = t.data?.people ?? [];
  return (
    <>
      <PeriodPicker value={range} onChange={setRange} extra={<label className="slicer"><span>Department</span><select value={dept} onChange={(e) => setDept(e.target.value)}><option value="">All</option>{depts.map((d) => <option key={d}>{d}</option>)}</select></label>} />
      {(t.data?.approved ?? []).length > 0 && <div className="alert ok">Approved for payroll: {t.data.approved.map((a: any) => `${a.date_from} to ${a.date_to} (${a.approved_by ?? '—'})`).join('; ')}. Days in an approved period cannot be changed.</div>}
      <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
        {!ppl.length ? <NoData text="No people in Time & attendance yet" hint="Add them in the People tab." /> : (
          <table className="grid"><thead><tr><th>Person</th><th>Department</th><th>Shift</th><th className="num">Present</th><th className="num">Absent</th><th className="num">Leave</th><th className="num">No check-out</th><th className="num">Worked</th><th className="num">Overtime</th><th className="num">Late</th></tr></thead><tbody>
            {ppl.map((p: any) => (
              <tr key={p.id} className="clickable" onClick={() => setOpen(p)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(p)}>
                <td><strong>{p.name}</strong><span className="sub">{p.employeeNo ?? ''}</span></td><td>{p.department ?? '—'}</td><td className="small">{p.shift ?? '—'}</td>
                <td className="num">{p.totals.daysPresent}</td><td className={`num ${p.totals.daysAbsent ? 'bad-text' : ''}`}>{p.totals.daysAbsent}</td><td className="num">{p.totals.daysLeave + p.totals.daysHoliday}</td>
                <td className={`num ${p.totals.incomplete ? 'bad-text' : ''}`}>{p.totals.incomplete}</td><td className="num">{h(p.totals.workedMinutes)}</td><td className="num">{h(p.totals.overtimeMinutes)}</td>
                <td className="num">{p.totals.lateDays ? `${p.totals.lateDays} d / ${h(p.totals.lateMinutes)} h` : '—'}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>
      <p className="small muted">Hours are h:mm. Click a person for their days and clock records. Times are hotel time ({t.data?.tz}).</p>
      {open && <PersonDays person={open} range={range} tz={t.data.tz} onClose={() => setOpen(null)} onChanged={() => t.reload()} />}
    </>
  );
}

function PersonDays({ person, range, tz, onClose, onChanged }: { person: any; range: { from: string; to: string }; tz: string; onClose: () => void; onChanged: () => void }) {
  const { base, can } = useHotel();
  const pq = `from=${range.from}&to=${range.to}`;
  const punches = useApi<any[]>(`${base}/attendance/people/${person.id}/punches?${pq}`, [pq]);
  const [error, setError] = useState<unknown>(null);
  const [add, setAdd] = useState({ at: '', direction: 'out', reason: '' });
  const time = (v: string | null) => (v ? new Date(v).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz }) : '—');
  const reload = async () => { await punches.reload(); onChanged(); };
  const addRecord = async () => { setError(null); try { await api(`${base}/attendance/punches`, { body: { personId: person.id, at: new Date(add.at).toISOString(), direction: add.direction, reason: add.reason } }); setAdd({ at: '', direction: 'out', reason: '' }); await reload(); } catch (e) { setError(e); } };
  const voidIt = async (p: any) => { const reason = prompt('Why is this record wrong?'); if (!reason) return; setError(null); try { await api(`${base}/attendance/punches/${p.id}/void`, { body: { reason } }); await reload(); } catch (e) { setError(e); } };
  return (
    <Drawer title={`${person.name}${person.employeeNo ? ` · ${person.employeeNo}` : ''}`} onClose={onClose}>
      <ErrorNote error={error} />
      <table className="grid small"><thead><tr><th>Day</th><th>Status</th><th>In</th><th>Out</th><th className="num">Worked</th><th className="num">OT</th><th className="num">Late (h:mm)</th></tr></thead><tbody>
        {person.days.filter((d: any) => d.status !== 'future').map((d: any) => (
          <tr key={d.date} className={d.status === 'absent' || d.status === 'incomplete' ? 'warning' : ''}>
            <td>{WD[d.weekday - 1]} {d.date.slice(5)}</td><td>{DAY_STATUS[d.status]}{d.absence && d.status !== 'leave' && d.status !== 'holiday' ? ` (${ABSENCE[d.absence]})` : ''}</td>
            <td>{d.firstIn ? time(d.firstIn).split(', ').pop() : '—'}</td><td>{d.lastOut ? time(d.lastOut).split(', ').pop() : '—'}</td>
            <td className="num">{d.workedMinutes ? h(d.workedMinutes) : ''}</td><td className="num">{d.overtimeMinutes ? h(d.overtimeMinutes) : ''}</td><td className="num">{d.lateMinutes ? h(d.lateMinutes) : ''}</td>
          </tr>
        ))}
      </tbody></table>
      <h3 style={{ marginTop: 14 }}>Clock records</h3>
      {!(punches.data ?? []).length ? <p className="small muted">None in this period.</p> : (
        <table className="grid small"><tbody>
          {punches.data!.map((p) => (
            <tr key={p.id} className={p.voided_at ? 'muted' : ''}>
              <td style={{ textDecoration: p.voided_at ? 'line-through' : undefined }}>{time(p.at)}</td>
              <td>{p.direction === 'auto' ? 'Door' : p.direction === 'in' ? 'In' : 'Out'}</td>
              <td className="small">{p.source === 'door' ? `Door ${p.door ?? ''}` : p.source === 'desk' ? `Desk (${p.entered_by ?? ''})` : `HR: ${p.entered_by ?? ''} - ${p.reason ?? ''}`}{p.voided_at && <div>Voided by {p.voided_by}: {p.void_reason}</div>}</td>
              <td style={{ textAlign: 'right' }}>{can('attendance.manage') && !p.voided_at && <button className="btn small ghost" onClick={() => voidIt(p)}>Void</button>}</td>
            </tr>
          ))}
        </tbody></table>
      )}
      {can('attendance.manage') && (
        <div className="panel" style={{ marginTop: 12 }}>
          <h3>Add a missing record</h3>
          <div className="field-row">
            <div className="field"><label htmlFor="pa">Time</label><input id="pa" type="datetime-local" value={add.at} onChange={(e) => setAdd({ ...add, at: e.target.value })} /></div>
            <div className="field"><label htmlFor="pd">Type</label><select id="pd" value={add.direction} onChange={(e) => setAdd({ ...add, direction: e.target.value })}><option value="in">Check in</option><option value="out">Check out</option></select></div>
          </div>
          <div className="field"><label htmlFor="pr">Reason</label><input id="pr" value={add.reason} onChange={(e) => setAdd({ ...add, reason: e.target.value })} placeholder="e.g. forgot to check out" /></div>
          <button className="btn primary" disabled={!add.at || add.reason.trim().length < 3} onClick={addRecord}>Add record</button>
        </div>
      )}
    </Drawer>
  );
}

// ---- people ----
function People() {
  const { base, can } = useHotel();
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const ppl = useApi<any[]>(`${base}/attendance/people?all=${all}`, [all]);
  const shifts = useApi<any[]>(can('attendance.read') ? `${base}/attendance/shifts` : null);
  const [edit, setEdit] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const imp = async (source: 'staff' | 'keycard') => { setError(null); setMsg(null); try { const r = await api(`${base}/attendance/people/import`, { body: { source } }); setMsg(`${r.added} people added.`); await ppl.reload(); } catch (e) { setError(e); } };
  const list = (ppl.data ?? []).filter((p) => !q.trim() || `${p.fullName} ${p.employeeNo ?? ''} ${p.department ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <ErrorNote error={error ?? ppl.error} />
      {msg && <div className="alert ok">{msg}</div>}
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div className="row"><input type="search" placeholder="Find" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a person" /><label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /><span>Show inactive</span></label></div>
          {can('attendance.manage') && <div className="row">
            <button className="btn" onClick={() => imp('staff')} title="Everyone in the Staff list">Add staff</button>
            <button className="btn" onClick={() => imp('keycard')} title="Visionline users read in Settings → Reports & sync">Add Visionline keycard holders</button>
            <button className="btn primary" onClick={() => setEdit({ fullName: '', employment: 'casual', payBasis: 'daily', active: true })}>Add a person without a card</button>
          </div>}
        </div>
        {!list.length ? <NoData text="No people yet" hint="Import staff or keycard holders, or add daily workers." /> : (
          <table className="grid"><thead><tr><th>Name</th><th>Payroll no.</th><th>Department</th><th>Employment</th><th>Shift</th><th>Clocked by</th><th /></tr></thead><tbody>
            {list.map((p) => (
              <tr key={p.id} className={p.active ? '' : 'muted'}>
                <td><strong>{p.fullName}</strong>{p.jobTitle && <span className="sub">{p.jobTitle}</span>}</td><td>{p.employeeNo ?? '—'}</td><td>{p.department ?? '—'}</td>
                <td className="small">{p.employment} · paid {p.payBasis}</td><td className="small">{p.shift ?? '—'}</td>
                <td className="small">{p.kind === 'manual' ? 'Desk / HR (no card)' : p.kind === 'keycard' ? 'Keycard + desk' : `Mobile key${p.vlUserId ? ' + keycard' : ''} + desk`}</td>
                <td style={{ textAlign: 'right' }}>{can('attendance.manage') && <button className="btn small" onClick={() => setEdit(p)}>Edit</button>}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>
      {edit && <PersonForm p={edit} shifts={shifts.data ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void ppl.reload(); }} />}
    </>
  );
}

function PersonForm({ p, shifts, onClose, onSaved }: { p: any; shifts: any[]; onClose: () => void; onSaved: () => void }) {
  const { base } = useHotel();
  const [f, setF] = useState<any>({ employeeNo: '', department: '', jobTitle: '', shiftId: null, vlUserId: null, startDate: null, endDate: null, ...p });
  const holders = useApi<any[]>(`${base}/attendance/keycard-holders`);
  const [error, setError] = useState<unknown>(null);
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const save = async () => {
    setError(null);
    const body = { fullName: f.fullName, employeeNo: f.employeeNo, department: f.department, jobTitle: f.jobTitle, employment: f.employment, payBasis: f.payBasis, shiftId: f.shiftId || null, vlUserId: f.vlUserId || null, active: f.active, startDate: f.startDate || null, endDate: f.endDate || null };
    try { if (p.id) await api(`${base}/attendance/people/${p.id}`, { method: 'PUT', body }); else await api(`${base}/attendance/people`, { body }); onSaved(); } catch (e) { setError(e); }
  };
  return (
    <Drawer title={p.id ? `Edit ${p.fullName}` : 'Add a person'} onClose={onClose} footer={<><span /><div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={(f.fullName ?? '').trim().length < 2} onClick={save}>Save</button></div></>}>
      <ErrorNote error={error} />
      <div className="field-row">
        <div className="field"><label htmlFor="fn">Full name</label><input id="fn" value={f.fullName} onChange={(e) => set('fullName', e.target.value)} /></div>
        <div className="field"><label htmlFor="en">Payroll number</label><input id="en" value={f.employeeNo ?? ''} onChange={(e) => set('employeeNo', e.target.value)} /><span className="hint">The number the payroll system knows this person by.</span></div>
      </div>
      <div className="field-row">
        <div className="field"><label htmlFor="dp">Department</label><input id="dp" value={f.department ?? ''} onChange={(e) => set('department', e.target.value)} /></div>
        <div className="field"><label htmlFor="jt">Job title</label><input id="jt" value={f.jobTitle ?? ''} onChange={(e) => set('jobTitle', e.target.value)} /></div>
      </div>
      <div className="field-row">
        <div className="field"><label htmlFor="em">Employment</label><select id="em" value={f.employment} onChange={(e) => set('employment', e.target.value)}><option value="permanent">Permanent</option><option value="contract">Contract</option><option value="casual">Casual / daily worker</option><option value="intern">Intern</option></select></div>
        <div className="field"><label htmlFor="pb">Paid</label><select id="pb" value={f.payBasis} onChange={(e) => set('payBasis', e.target.value)}><option value="monthly">Monthly</option><option value="daily">Daily</option><option value="hourly">Hourly</option></select></div>
        <div className="field"><label htmlFor="sh">Shift</label><select id="sh" value={f.shiftId ?? ''} onChange={(e) => set('shiftId', e.target.value || null)}><option value="">No fixed shift</option>{shifts.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.start}-{s.end})</option>)}</select></div>
      </div>
      {p.kind !== 'staff' && (
        <div className="field"><label htmlFor="vu">Visionline keycard holder</label>
          <select id="vu" value={f.vlUserId ?? ''} onChange={(e) => set('vlUserId', e.target.value || null)}>
            <option value="">No keycard (checked in at the desk)</option>
            {(holders.data ?? []).filter((x) => !x.linked_to || x.id === p.vlUserId).map((x) => <option key={x.id} value={x.id}>{x.name ?? x.id}{x.group ? ` · ${x.group}` : ''}</option>)}
          </select><span className="hint">Linking the card makes entrances at the attendance doors count. The list comes from Settings → Reports & sync.</span></div>
      )}
      <div className="field-row">
        <div className="field"><label htmlFor="sd">Started</label><input id="sd" type="date" value={f.startDate ?? ''} onChange={(e) => set('startDate', e.target.value || null)} /></div>
        <div className="field"><label htmlFor="ed">Left</label><input id="ed" type="date" value={f.endDate ?? ''} onChange={(e) => set('endDate', e.target.value || null)} /></div>
      </div>
      <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /><span>Active</span></label>
    </Drawer>
  );
}

// ---- shifts ----
function Shifts() {
  const { base, can } = useHotel();
  const s = useApi<any[]>(`${base}/attendance/shifts`);
  const blank = { name: '', start: '08:00', end: '17:00', breakMinutes: 60, graceMinutes: 10, workDays: [1, 2, 3, 4, 5, 6], active: true };
  const [f, setF] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const save = async () => { setError(null); try { if (f.id) await api(`${base}/attendance/shifts/${f.id}`, { method: 'PUT', body: f }); else await api(`${base}/attendance/shifts`, { body: f }); setF(null); await s.reload(); } catch (e) { setError(e); } };
  return (
    <div className="panel">
      <ErrorNote error={error ?? s.error} />
      {!(s.data ?? []).length ? <NoData text="No shifts yet" hint="Without a shift, more than 8 hours a day counts as overtime." /> : (
        <table className="grid"><thead><tr><th>Shift</th><th>Hours</th><th>Break</th><th>Late after</th><th>Days</th><th className="num">People</th><th /></tr></thead><tbody>
          {s.data!.map((x) => <tr key={x.id} className={x.active ? '' : 'muted'}><td><strong>{x.name}</strong></td><td>{x.start} - {x.end}{x.end <= x.start ? ' (next day)' : ''}</td><td>{x.breakMinutes} min</td><td>{x.graceMinutes} min</td><td className="small">{x.workDays.map((d: number) => WD[d - 1]).join(' ')}</td><td className="num">{x.people}</td>
            <td style={{ textAlign: 'right' }}>{can('attendance.manage') && <button className="btn small" onClick={() => setF(x)}>Edit</button>}</td></tr>)}
        </tbody></table>
      )}
      {can('attendance.manage') && (f ? (
        <div className="panel" style={{ marginTop: 10 }}>
          <div className="field-row">
            <div className="field"><label htmlFor="sn">Name</label><input id="sn" value={f.name} placeholder="Morning 06-14" onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
            <div className="field"><label htmlFor="ss">Start</label><input id="ss" type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></div>
            <div className="field"><label htmlFor="se">End</label><input id="se" type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /><span className="hint">Earlier than the start = ends the next day.</span></div>
            <div className="field"><label htmlFor="sb">Break (min)</label><input id="sb" type="number" min={0} value={f.breakMinutes} onChange={(e) => setF({ ...f, breakMinutes: Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor="sg">Late after (min)</label><input id="sg" type="number" min={0} value={f.graceMinutes} onChange={(e) => setF({ ...f, graceMinutes: Number(e.target.value) })} /></div>
          </div>
          <div className="ev-types">{WD.map((d, i) => <button key={d} type="button" className="chip" aria-pressed={f.workDays.includes(i + 1)} onClick={() => setF({ ...f, workDays: f.workDays.includes(i + 1) ? f.workDays.filter((x: number) => x !== i + 1) : [...f.workDays, i + 1] })}>{d}</button>)}</div>
          <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /><span>Active</span></label>
          <div className="row" style={{ marginTop: 8 }}><button className="btn primary" onClick={save} disabled={f.name.trim().length < 2 || !f.workDays.length}>Save</button><button className="btn ghost" onClick={() => setF(null)}>Cancel</button></div>
        </div>
      ) : <button className="btn" style={{ marginTop: 10 }} onClick={() => setF(blank)}>Add a shift</button>)}
    </div>
  );
}

// ---- leave and holidays ----
function Leave() {
  const { base, can } = useHotel();
  const [range, setRange] = useRange('leave', 'this_month');
  const qs = `from=${range.from}&to=${range.to}`;
  const a = useApi<any[]>(`${base}/attendance/absences?${qs}`, [qs]);
  const ppl = useApi<any[]>(`${base}/attendance/people`);
  const [f, setF] = useState({ personId: '', kind: 'annual_leave', from: range.from, to: range.from, note: '' });
  const [error, setError] = useState<unknown>(null);
  const save = async () => { setError(null); try { await api(`${base}/attendance/absences`, { body: { ...f, personId: f.personId || null } }); setF({ ...f, note: '' }); await a.reload(); } catch (e) { setError(e); } };
  const remove = async (x: any) => { if (!confirm('Remove this entry?')) return; try { await api(`${base}/attendance/absences/${x.id}`, { method: 'DELETE' }); await a.reload(); } catch (e) { setError(e); } };
  return (
    <>
      <PeriodPicker value={range} onChange={setRange} />
      <ErrorNote error={error ?? a.error} />
      <div className="panel">
        {!(a.data ?? []).length ? <NoData text="No leave or holidays in this period" hint="Add them below." /> : (
          <table className="grid"><thead><tr><th>Who</th><th>What</th><th>From</th><th>To</th><th>Note</th><th>Entered by</th><th /></tr></thead><tbody>
            {a.data!.map((x) => <tr key={x.id}><td>{x.person ?? <strong>Everybody</strong>}</td><td>{ABSENCE[x.kind]}</td><td>{x.date_from}</td><td>{x.date_to}</td><td className="small">{x.note ?? ''}</td><td className="small">{x.created_by ?? ''}</td>
              <td style={{ textAlign: 'right' }}>{can('attendance.manage') && <button className="btn small ghost" onClick={() => remove(x)}>Remove</button>}</td></tr>)}
          </tbody></table>
        )}
      </div>
      {can('attendance.manage') && (
        <div className="panel">
          <h2>Add leave, a day off or a public holiday</h2>
          <div className="field-row">
            <div className="field"><label htmlFor="lp">Who</label><select id="lp" value={f.personId} onChange={(e) => setF({ ...f, personId: e.target.value })}><option value="">Everybody (public holiday)</option>{(ppl.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}</select></div>
            <div className="field"><label htmlFor="lk">What</label><select id="lk" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(ABSENCE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div className="field"><label htmlFor="lf">From</label><input id="lf" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, to: f.to < e.target.value ? e.target.value : f.to })} /></div>
            <div className="field"><label htmlFor="lt">To</label><input id="lt" type="date" value={f.to} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
          </div>
          <div className="field"><label htmlFor="ln">Note</label><input id="ln" value={f.note} maxLength={200} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
          <button className="btn primary" onClick={save} disabled={!f.personId && f.kind !== 'public_holiday'}>Add</button>
        </div>
      )}
    </>
  );
}

// ---- payroll ----
function Payroll() {
  const { base, can, hotel } = useHotel();
  const [range, setRange] = useRange('payroll', 'last_month');
  const qs = `from=${range.from}&to=${range.to}`;
  const t = useApi<any>(`${base}/attendance/timesheet?${qs}`, [qs]);
  const periods = useApi<any[]>(`${base}/attendance/periods`);
  const [error, setError] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const file = (name: string) => download(`${base}/attendance/export/${name}?${qs}`, `${hotel.slug}-attendance-${name.replace('.', `-${range.from}_${range.to}.`)}`).catch(setError);
  const pdf = async () => {
    setError(null);
    try {
      const r = await fetch(`${base}/attendance/pdf`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` }, body: JSON.stringify(range) });
      if (!r.ok) { const j = await r.json().catch(() => null); throw new ApiError(r.status, j?.error?.code ?? 'ERROR', j?.error?.message ?? 'Printing failed'); }
      const url = URL.createObjectURL(await r.blob()); Object.assign(document.createElement('a'), { href: url, download: `${hotel.slug}-attendance-${range.from}_${range.to}.pdf` }).click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { setError(e); }
  };
  const approve = async () => {
    if (!confirm(`Approve ${range.from} to ${range.to} for payroll? Nothing in this period can be changed afterwards (unless it is re-opened).`)) return;
    setError(null); setMsg(null);
    try { const r = await api(`${base}/attendance/periods`, { body: range }); setMsg(`Approved.${r.daysWithoutCheckout ? ` Note: ${r.daysWithoutCheckout} day(s) have no check-out.` : ''}`); await periods.reload(); await t.reload(); } catch (e) { setError(e); }
  };
  const reopen = async (p: any) => { const reason = prompt(`Re-open ${p.date_from} to ${p.date_to}? Give the reason:`); if (!reason) return; try { await api(`${base}/attendance/periods/${p.id}?reason=${encodeURIComponent(reason)}`, { method: 'DELETE' }); await periods.reload(); await t.reload(); } catch (e) { setError(e); } };
  if (t.error) return <><PeriodPicker value={range} onChange={setRange} /><ModuleOff error={t.error} /></>;
  const ppl = t.data?.people ?? [];
  const sum = ppl.reduce((a: any, p: any) => ({ w: a.w + p.totals.workedMinutes, o: a.o + p.totals.overtimeMinutes, i: a.i + p.totals.incomplete, ab: a.ab + p.totals.daysAbsent }), { w: 0, o: 0, i: 0, ab: 0 });
  const approved = (t.data?.approved ?? []).some((a: any) => a.date_from <= range.from && a.date_to >= range.to);
  return (
    <>
      <PeriodPicker value={range} onChange={setRange} />
      <ErrorNote error={error} />
      {msg && <div className="alert ok">{msg}</div>}
      <div className="mon-tiles">
        <div className="mon-tile ok"><strong>{ppl.length}</strong><span>people</span></div>
        <div className="mon-tile"><strong>{h(sum.w)}</strong><span>hours worked</span></div>
        <div className="mon-tile"><strong>{h(sum.o)}</strong><span>overtime</span></div>
        <div className={`mon-tile ${sum.i ? 'warn' : 'ok'}`}><strong>{sum.i}</strong><span>days without check-out (fix before approving)</span></div>
        <div className={`mon-tile ${approved ? 'ok' : 'warn'}`}><strong>{approved ? 'Approved' : 'Open'}</strong><span>for payroll</span></div>
      </div>
      <div className="panel">
        <h2>Send to payroll</h2>
        <p className="small muted">CSV opens in Excel and imports into most payroll systems (one row per person per day, or one row per person). JSON is for a payroll system that reads it directly. The PDF has the hotel header on every page and can be checked later (Event log → Verify a PDF).</p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button className="btn" onClick={() => file('summary.csv')}>Summary per person (CSV)</button>
          <button className="btn" onClick={() => file('daily.csv')}>Day by day (CSV)</button>
          <button className="btn" onClick={() => file('summary.json')}>Summary (JSON)</button>
          <button className="btn" onClick={pdf}>Print PDF</button>
          {can('attendance.manage') && !approved && <button className="btn primary" onClick={approve}>Approve this period</button>}
        </div>
      </div>
      <div className="panel">
        <h2>Approved periods</h2>
        {!(periods.data ?? []).length ? <p className="small muted">None yet.</p> : (
          <table className="grid small"><tbody>{periods.data!.map((p) => <tr key={p.id}><td>{p.date_from} to {p.date_to}</td><td className="muted">{p.approved_by} · {new Date(p.approved_at).toLocaleString()}</td>
            <td style={{ textAlign: 'right' }}>{can('attendance.manage') && <button className="btn small ghost" onClick={() => reopen(p)}>Re-open</button>}</td></tr>)}</tbody></table>
        )}
      </div>
    </>
  );
}

// ---- setup ----
function Setup() {
  const { base, can } = useHotel();
  const s = useApi<any>(`${base}/attendance/settings`);
  const [f, setF] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => { if (s.data && !f) setF(s.data.settings); }, [s.data, f]);
  if (!s.data || !f) return <ErrorNote error={s.error} />;
  const save = async () => { setError(null); setOk(null); try { const r = await api(`${base}/attendance/settings`, { method: 'PUT', body: f }); setOk(`Saved (policy version ${r.version}).`); } catch (e) { setError(e); } };
  const ro = !can('attendance.manage');
  return (
    <div className="panel">
      {!s.data.enabled && <div className="alert warn">Time & attendance is switched off. {can('settings.manage') ? <Link to="/settings?tab=features">Settings → Modules</Link> : 'A hotel administrator switches it on in Settings → Modules.'}</div>}
      <ErrorNote error={error} />
      {ok && <div className="alert ok">{ok}</div>}
      <h2>Attendance doors</h2>
      <p className="small muted">Entrances at these doors count as clock records for the person whose keycard or mobile key opened them: the first of the day is the arrival, the last the departure. Usually the staff entrance. Door entrances need the connector's Visionline watch with entrance recording on (Settings → Event log).</p>
      <div className="ev-types">{s.data.doors.map((d: any) => <button key={d.id} type="button" className="chip" disabled={ro} aria-pressed={f.doorIds.includes(d.id)} onClick={() => setF({ ...f, doorIds: f.doorIds.includes(d.id) ? f.doorIds.filter((x: string) => x !== d.id) : [...f.doorIds, d.id] })}>{d.name}</button>)}</div>
      {!s.data.doors.length && <NoData text="No doors yet" hint="Doors are read from Visionline on Connector health." />}
      <h2 style={{ marginTop: 16 }}>Rules</h2>
      <div className="field-row">
        <div className="field"><label htmlFor="ad">A working day starts at</label><input id="ad" type="time" disabled={ro} value={f.dayStartsAt} onChange={(e) => setF({ ...f, dayStartsAt: e.target.value })} /><span className="hint">Night shifts are counted on the day they started.</span></div>
        <div className="field"><label htmlFor="ar">Ignore the same door again within (min)</label><input id="ar" type="number" min={0} disabled={ro} value={f.ignoreRepeatMinutes} onChange={(e) => setF({ ...f, ignoreRepeatMinutes: Number(e.target.value) })} /></div>
        <div className="field"><label htmlFor="ao">Overtime after (minutes a day, no shift)</label><input id="ao" type="number" min={60} disabled={ro} value={f.overtimeAfterMinutes} onChange={(e) => setF({ ...f, overtimeAfterMinutes: Number(e.target.value) })} /></div>
      </div>
      <div className="field-row">
        <div className="field"><label htmlFor="ab">Break without a shift (min, if more than 6 h)</label><input id="ab" type="number" min={0} disabled={ro} value={f.defaultBreakMinutes} onChange={(e) => setF({ ...f, defaultBreakMinutes: Number(e.target.value) })} /></div>
        <div className="field"><label htmlFor="ard">Round worked time to</label><select id="ard" disabled={ro} value={f.roundToMinutes} onChange={(e) => setF({ ...f, roundToMinutes: Number(e.target.value) })}>{[0, 5, 10, 15, 30].map((n) => <option key={n} value={n}>{n ? `${n} minutes` : 'Exact minutes'}</option>)}</select></div>
      </div>
      <label className="check"><input type="checkbox" disabled={ro} checked={f.requireReason} onChange={(e) => setF({ ...f, requireReason: e.target.checked })} /><span>Corrections and other times need a reason</span></label>
      {!ro && <button className="btn primary" onClick={save} style={{ marginTop: 10 }}>Save</button>}
    </div>
  );
}
