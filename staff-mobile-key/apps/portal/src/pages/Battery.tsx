import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, download } from '../api';
import { useHotel } from '../App';
import { Drawer, ErrorNote, PageHead, Status, fmt, useApi } from '../ui';

type BState = 'GOOD' | 'LOW' | 'CRITICAL' | 'REPORTED' | 'NEVER';
interface BDoor {
  doorId: string; name: string; doorGroup: string | null; online: boolean | null; known: boolean; state: BState; stale: boolean;
  lastEvent: { code: number; name: string } | null; voltsBelow: number | null; reportedAt: string | null; receivedAt: string | null;
  alert: { id: string; severity: 'LOW' | 'CRITICAL'; status: 'OPEN' | 'ACKNOWLEDGED'; openedAt: string; occurrences: number; acknowledgedAt: string | null; acknowledgedBy: string | null } | null;
  ticket: { id: string; number: number; status: string; assignee: string | null } | null;
}

export const STATE_LABEL: Record<BState, string> = { CRITICAL: 'Critical', LOW: 'Low', GOOD: 'Good', REPORTED: 'Reading only', NEVER: 'Never reported' };
const STATE_PILL: Record<BState, string> = { CRITICAL: 'FAILED', LOW: 'PENDING', GOOD: 'ACTIVE', REPORTED: 'EXPIRED', NEVER: 'EXPIRED' };
const FILTERS: { id: string; label: string; test: (d: BDoor) => boolean }[] = [
  { id: 'all', label: 'All doors', test: () => true },
  { id: 'attention', label: 'Low or critical', test: (d) => d.state === 'LOW' || d.state === 'CRITICAL' },
  { id: 'stale', label: 'Stale', test: (d) => d.stale },
  { id: 'never', label: 'Never reported', test: (d) => d.state === 'NEVER' },
];
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export function BatteryPage() {
  const { base, can } = useHotel();
  const { doorId } = useParams();
  const nav = useNavigate();
  const b = useApi<{ doors: BDoor[]; summary: Record<string, number>; policy: any }>(`${base}/battery`, [], 10_000);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [hideNoData, setHideNoData] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const doors = b.data?.doors ?? [];
  const f = FILTERS.find((x) => x.id === filter)!;
  const shown = doors.filter((d) => f.test(d) && (!hideNoData || d.state !== 'NEVER')
    && (!q.trim() || `${d.name} ${d.doorId} ${d.doorGroup ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())));
  const groups = useMemo(() => {
    const m = new Map<string, BDoor[]>();
    for (const d of shown) m.set(d.doorGroup ?? (d.known ? 'Other' : 'Not in discovered doors'), [...(m.get(d.doorGroup ?? (d.known ? 'Other' : 'Not in discovered doors')) ?? []), d]);
    return [...m.entries()].sort(([a], [x]) => (/^floor|floor$/i.test(a) === /^floor|floor$/i.test(x) ? natural(a, x) : /^floor|floor$/i.test(a) ? -1 : 1))
      .map(([g, ds]) => ({ g, ds: ds.sort((x, y) => natural(x.name, y.name)) }));
  }, [shown]);
  const alerts = doors.filter((d) => d.alert).sort((x, y) => (x.alert!.severity === y.alert!.severity ? natural(x.name, y.name) : x.alert!.severity === 'CRITICAL' ? -1 : 1));
  const s = b.data?.summary;
  const ack = async (id: string) => { setError(null); try { await api(`${base}/battery/alerts/${id}/acknowledge`, { body: {} }); await b.reload(); } catch (e) { setError(e); } };
  const selected = doorId ? doors.find((d) => d.doorId === doorId) : null;

  return (
    <>
      <PageHead title="Battery status" intro={<>Lock batteries as the locks report them to Visionline: alarms, exchanges and voltage readings. Offline locks report only when their events reach Visionline, so some doors may show <em>never reported</em> or <em>stale</em>.</>}>
        <button className="btn" onClick={() => download(`${base}/battery/export`, 'battery-history.csv').catch(setError)}>Export history</button>
        {can('settings.manage') && <Link className="btn" to="/settings?tab=battery">Thresholds</Link>}
      </PageHead>
      <ErrorNote error={error ?? b.error} />
      {s && (
        <div className="figures">
          <div><div className="v" style={{ color: s.critical ? 'var(--bad)' : undefined }}>{s.critical}</div><div className="l">critical</div></div>
          <div><div className="v" style={{ color: s.low ? 'var(--warn)' : undefined }}>{s.low}</div><div className="l">low</div></div>
          <div><div className="v">{s.stale}</div><div className="l">stale (no report for {b.data!.policy.staleAfterDays} days)</div></div>
          <div><div className="v">{s.never}<span style={{ fontSize: 18, color: 'var(--ink-3)' }}>/{s.total}</span></div><div className="l">never reported</div></div>
          <div><div className="v" style={{ color: 'var(--ok)' }}>{s.good}</div><div className="l">good</div></div>
        </div>
      )}

      {alerts.length > 0 && (
        <div className="panel flush">
          <div style={{ padding: '16px 20px 4px' }}><h2>Needs attention</h2></div>
          <table className="grid">
            <thead><tr><th>Door</th><th>Battery</th><th>Since</th><th>Acknowledged</th><th>Maintenance</th><th></th></tr></thead>
            <tbody>{alerts.map((d) => (
              <tr key={d.doorId} className="click" onClick={() => nav(`/battery/${encodeURIComponent(d.doorId)}`)}>
                <td><strong>{d.name}</strong><span className="sub">{d.doorGroup ?? '—'}</span></td>
                <td><Status s={STATE_PILL[d.alert!.severity]} label={STATE_LABEL[d.alert!.severity]} /><span className="sub">{d.lastEvent?.name}</span></td>
                <td>{fmt.dt(d.alert!.openedAt)}<span className="sub">{d.alert!.occurrences > 1 ? `${d.alert!.occurrences} reports` : '1 report'}</span></td>
                <td>{d.alert!.status === 'ACKNOWLEDGED' ? <>{d.alert!.acknowledgedBy}<span className="sub">{fmt.rel(d.alert!.acknowledgedAt)}</span></> : <span className="muted">Not yet</span>}</td>
                <td>{d.ticket ? <><Link to={`/maintenance/${d.ticket.id}`} onClick={(e) => e.stopPropagation()}>#{d.ticket.number}</Link> <Status s={ticketTone(d.ticket.status)} label={TICKET_LABEL[d.ticket.status] ?? d.ticket.status} /><span className="sub">{d.ticket.assignee ?? 'Unassigned'}</span></> : <span className="muted">No request</span>}</td>
                <td onClick={(e) => e.stopPropagation()}>{d.alert!.status === 'OPEN' && can('battery.manage') && <button className="btn small" onClick={() => ack(d.alert!.id)}>Acknowledge</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="row">
            <div className="seg" role="group" aria-label="Show">
              {FILTERS.map((x) => <button key={x.id} aria-pressed={filter === x.id} onClick={() => setFilter(x.id)}>{x.label}</button>)}
            </div>
            <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={hideNoData} onChange={(e) => setHideNoData(e.target.checked)} /> Hide doors without battery data</label>
          </div>
          <input className="search" type="search" placeholder="Search door or floor" aria-label="Search doors" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Legend />
        {b.data && !shown.length && <div className="empty">{doors.length ? 'No doors match.' : 'No doors yet. Run resource discovery on Connector health.'}</div>}
        <div className="doormap batmap">
          {groups.map(({ g, ds }) => (
            <div className="floor" key={g}>
              <div className="floor-label"><strong>{g}</strong><span className="n">{ds.length} {ds.length === 1 ? 'door' : 'doors'}{countAlarms(ds)}</span></div>
              <div className="doors">
                {ds.map((d) => (
                  <button key={d.doorId} className={`door wide ${d.state}${d.stale ? ' stale' : ''}`} onClick={() => nav(`/battery/${encodeURIComponent(d.doorId)}`)}
                    title={`${d.name}: ${STATE_LABEL[d.state]}${d.stale ? ' (stale)' : ''}${d.reportedAt ? ` · ${fmt.dt(d.reportedAt)}` : ''}`}>
                    <span className="cell" aria-hidden><i /></span>{d.name}
                    <span className="sr">{STATE_LABEL[d.state]}{d.stale ? ', stale' : ''}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {doorId && <DoorBattery id={doorId} door={selected ?? null} onClose={() => nav('/battery')} onChanged={b.reload} />}
    </>
  );
}

const countAlarms = (ds: BDoor[]) => {
  const c = ds.filter((d) => d.state === 'CRITICAL').length, l = ds.filter((d) => d.state === 'LOW').length;
  return c || l ? ` · ${[c && `${c} critical`, l && `${l} low`].filter(Boolean).join(', ')}` : '';
};

function Legend() {
  return (
    <div className="row small muted batlegend" style={{ marginBottom: 12 }}>
      {(['CRITICAL', 'LOW', 'GOOD', 'REPORTED', 'NEVER'] as BState[]).map((s) => <span key={s} className={`door wide ${s}`} aria-hidden><span className="cell"><i /></span>{STATE_LABEL[s]}</span>)}
      <span className="door wide GOOD stale" aria-hidden><span className="cell"><i /></span>Stale</span>
    </div>
  );
}

export const TICKET_LABEL: Record<string, string> = { OPEN: 'Open', ACKNOWLEDGED: 'Acknowledged', IN_PROGRESS: 'In progress', ON_HOLD: 'On hold', RESOLVED: 'Resolved', CLOSED: 'Closed', CANCELLED: 'Cancelled' };
export const ticketTone = (s: string) => ({ OPEN: 'PENDING', ACKNOWLEDGED: 'SCHEDULED', IN_PROGRESS: 'ISSUING', ON_HOLD: 'PENDING', RESOLVED: 'ACTIVE', CLOSED: 'EXPIRED', CANCELLED: 'EXPIRED' } as Record<string, string>)[s] ?? 'EXPIRED';

function DoorBattery({ id, door, onClose, onChanged }: { id: string; door: BDoor | null; onClose: () => void; onChanged: () => void }) {
  const { base, can } = useHotel();
  const nav = useNavigate();
  const h = useApi<{ readings: any[]; alerts: any[] }>(`${base}/battery/doors/${encodeURIComponent(id)}/history`, [id, door?.reportedAt, door?.alert?.status]);
  const att = useApi<any>(`${base}/attention`);
  const people = useApi<any[]>(can('maintenance.manage') ? `${base}/maintenance/assignees` : null);
  const [error, setError] = useState<unknown>(null);
  const [mode, setMode] = useState<null | 'ticket' | 'resolve'>(null);
  const [assignee, setAssignee] = useState('');
  const [reason, setReason] = useState('');
  const [replaced, setReplaced] = useState(true);
  const act = async (path: string, body: unknown) => {
    setError(null);
    try { const r = await api(`${base}/battery/alerts/${door!.alert!.id}/${path}`, { body }); setMode(null); onChanged(); void h.reload(); return r; } catch (e) { setError(e); }
  };
  if (!door) return <Drawer title="Door" onClose={onClose}><p className="muted">Loading…</p></Drawer>;
  const a = door.alert;
  return (
    <Drawer title={`${door.name}${door.doorGroup ? ` · ${door.doorGroup}` : ''}`} onClose={onClose} footer={
      <>
        <span className="small muted">Door {door.doorId}</span>
        <div className="row">
          {a?.status === 'OPEN' && can('battery.manage') && <button className="btn" onClick={() => act('acknowledge', {})}>Acknowledge</button>}
          {a && !door.ticket && can('maintenance.manage') && att.data?.maintenance && <button className="btn" onClick={() => setMode('ticket')}>Open maintenance request</button>}
          {a && can('battery.manage') && <button className="btn primary" onClick={() => setMode('resolve')}>Mark resolved</button>}
        </div>
      </>
    }>
      <ErrorNote error={error} />
      {mode === 'ticket' && (
        <div className="panel">
          <div className="field"><label htmlFor="as">Give it to</label>
            <select id="as" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Nobody yet (the maintenance team is told)</option>
              {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.jobRole}{p.openTasks ? ` · ${p.openTasks} open` : ''}{p.hasApp ? '' : ' · no app'}</option>)}
            </select>
          </div>
          <div className="row end"><button className="btn" onClick={() => setMode(null)}>Back</button>
            <button className="btn primary" onClick={async () => { const t = await act('ticket', { assigneeStaffId: assignee || null }); if (t) nav(`/maintenance/${t.id}`); }}>Open request</button></div>
        </div>
      )}
      {mode === 'resolve' && (
        <div className="panel">
          <div className="field"><label htmlFor="rr">What was done?</label><input id="rr" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: batteries replaced on the 3rd floor round" autoFocus /></div>
          <label className="check"><input type="checkbox" checked={replaced} onChange={(e) => setReplaced(e.target.checked)} /><span>The battery was replaced<span className="hint" style={{ display: 'block' }}>The door shows Good until the lock reports again.{door.ticket ? ` Request #${door.ticket.number} is resolved too.` : ''}</span></span></label>
          <div className="row end"><button className="btn" onClick={() => setMode(null)}>Back</button><button className="btn primary" disabled={reason.trim().length < 3} onClick={() => act('resolve', { reason, batteryReplaced: replaced })}>Resolve alert</button></div>
        </div>
      )}
      <div className="split" style={{ gridTemplateColumns: 'minmax(0,1fr) 250px' }}>
        <div>
          <dl className="kv" style={{ marginBottom: 18 }}>
            <dt>Battery</dt><dd><Status s={STATE_PILL[door.state]} label={STATE_LABEL[door.state]} />{door.stale && <> <Status s="PENDING" label="Stale" /></>}</dd>
            <dt>Last report</dt><dd>{door.lastEvent ? `${door.lastEvent.name}${door.lastEvent.code ? ` (event ${door.lastEvent.code})` : ''}` : 'This lock has not reported a battery event'}</dd>
            {door.voltsBelow != null && <><dt>Voltage</dt><dd>below {door.voltsBelow.toFixed(1)} V</dd></>}
            <dt>Reported</dt><dd>{door.reportedAt ? `${fmt.dt(door.reportedAt)} (lock time)` : '—'}{door.receivedAt ? <span className="small muted"> · received {fmt.rel(door.receivedAt)}</span> : null}</dd>
            <dt>Lock</dt><dd>{door.online == null ? '—' : door.online ? 'Online' : 'Offline (reports when its events reach Visionline)'}</dd>
            {a && <><dt>Alert</dt><dd><Status s={STATE_PILL[a.severity]} label={`${STATE_LABEL[a.severity]} · ${a.status === 'OPEN' ? 'open' : 'acknowledged'}`} /><span className="small muted"> since {fmt.dt(a.openedAt)} · {a.occurrences} {a.occurrences === 1 ? 'report' : 'reports'}{a.acknowledgedBy ? ` · acknowledged by ${a.acknowledgedBy}` : ''}</span></dd></>}
            {door.ticket && <><dt>Maintenance</dt><dd><Link to={`/maintenance/${door.ticket.id}`}>Request #{door.ticket.number}</Link> <Status s={ticketTone(door.ticket.status)} label={TICKET_LABEL[door.ticket.status]} /> <span className="small muted">{door.ticket.assignee ?? 'unassigned'}</span></dd></>}
          </dl>
          <h3>Reports from this lock</h3>
          {(h.data?.readings ?? []).length ? (
            <table className="grid"><thead><tr><th>Lock time</th><th>Event</th><th>Meaning</th></tr></thead>
              <tbody>{h.data!.readings.map((r, i) => <tr key={i}><td className="small">{fmt.dt(r.reportedAt)}</td><td>{r.event}{r.code ? <span className="sub">event {r.code}</span> : null}</td><td><Status s={STATE_PILL[r.state as BState] ?? 'EXPIRED'} label={STATE_LABEL[r.state as BState] ?? r.state} /></td></tr>)}</tbody></table>
          ) : <p className="muted small">None yet.</p>}
        </div>
        <div>
          <h3>Alerts</h3>
          {(h.data?.alerts ?? []).length ? (
            <ol className="timeline">{h.data!.alerts.map((x) => (
              <li key={x.id}><div>{STATE_LABEL[x.severity as BState]} · {x.status.toLowerCase()}{x.ticketNumber ? ` · request #${x.ticketNumber}` : ''}</div>
                <time>{fmt.dt(x.openedAt)}{x.resolvedAt ? ` → ${fmt.dt(x.resolvedAt)}` : ''}</time>{x.resolvedReason && <div className="small muted">{x.resolvedReason}</div>}</li>
            ))}</ol>
          ) : <p className="muted small">No alerts for this door.</p>}
        </div>
      </div>
    </Drawer>
  );
}
