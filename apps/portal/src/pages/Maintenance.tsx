import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, auth, download } from '../api';
import { useHotel } from '../App';
import { Drawer, ErrorNote, PageHead, Status, fmt, useApi } from '../ui';
import { TICKET_LABEL, ticketTone } from './Battery';

const CATEGORY_LABEL: Record<string, string> = { battery: 'Lock battery', lock: 'Lock', door: 'Door', room: 'Room', electrical: 'Electrical', plumbing: 'Plumbing', other: 'Other' };
const PRIORITY_LABEL: Record<string, string> = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
const VIEWS = [{ id: 'open', label: 'Open' }, { id: 'closed', label: 'Resolved and closed' }, { id: 'all', label: 'All' }];

/** Which moves a person may offer from each status (the platform checks them again). */
const MOVES: Record<string, { to: string; label: string; manager?: boolean; primary?: boolean }[]> = {
  OPEN: [{ to: 'ACKNOWLEDGED', label: 'Acknowledge' }, { to: 'IN_PROGRESS', label: 'Start work', primary: true }, { to: 'RESOLVED', label: 'Resolve' }, { to: 'CANCELLED', label: 'Cancel request', manager: true }],
  ACKNOWLEDGED: [{ to: 'IN_PROGRESS', label: 'Start work', primary: true }, { to: 'ON_HOLD', label: 'Put on hold' }, { to: 'RESOLVED', label: 'Resolve' }, { to: 'CANCELLED', label: 'Cancel request', manager: true }],
  IN_PROGRESS: [{ to: 'ON_HOLD', label: 'Put on hold' }, { to: 'RESOLVED', label: 'Resolve', primary: true }, { to: 'CANCELLED', label: 'Cancel request', manager: true }],
  ON_HOLD: [{ to: 'IN_PROGRESS', label: 'Resume work', primary: true }, { to: 'RESOLVED', label: 'Resolve' }, { to: 'CANCELLED', label: 'Cancel request', manager: true }],
  RESOLVED: [{ to: 'CLOSED', label: 'Close', manager: true, primary: true }, { to: 'OPEN', label: 'Reopen', manager: true }],
  CLOSED: [{ to: 'OPEN', label: 'Reopen', manager: true }],
  CANCELLED: [{ to: 'OPEN', label: 'Reopen', manager: true }],
};

export function MaintenancePage() {
  const { base, can } = useHotel();
  const { ticketId } = useParams();
  const nav = useNavigate();
  const [view, setView] = useState('open');
  const [q, setQ] = useState('');
  const [assignee, setAssignee] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [qDebounced, setQDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setQDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  const params = new URLSearchParams({ view, ...(qDebounced.trim() ? { q: qDebounced.trim() } : {}), ...(assignee ? { assignee } : {}) });
  const list = useApi<any[]>(`${base}/maintenance/tickets?${params}`, [view, qDebounced, assignee], 8000);
  const people = useApi<any[]>(`${base}/maintenance/assignees`);
  const rows = list.data ?? [];

  return (
    <>
      <PageHead title="Maintenance" intro="Requests from the portal, from staff in the app and from lock battery alarms. Search by room, door, staff member or item.">
        <button className="btn" onClick={() => download(`${base}/maintenance/export`, 'maintenance-requests.csv').catch(setError)}>Export</button>
        <button className="btn" onClick={() => download(`${base}/maintenance/export?kind=history`, 'maintenance-history.csv').catch(setError)}>Export history</button>
        {can('maintenance.work') && <button className="btn primary" onClick={() => setCreating(true)}>New request</button>}
      </PageHead>
      <ErrorNote error={error ?? list.error} />
      <div className="row" style={{ marginBottom: 14, justifyContent: 'space-between' }}>
        <div className="row">
          <div className="seg" role="group" aria-label="Show">{VIEWS.map((v) => <button key={v.id} aria-pressed={view === v.id} onClick={() => setView(v.id)}>{v.label}</button>)}</div>
          <select aria-label="Assigned to" className="search" style={{ minWidth: 0 }} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Anyone</option><option value="none">Unassigned</option>
            {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <input className="search" type="search" placeholder="Room, door, person, #number" aria-label="Search requests" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="panel flush">
        {list.data && !rows.length ? (
          <div className="empty">{q || assignee ? 'No requests match.' : view === 'open' ? 'Nothing open. New requests from the portal, the app and battery alarms appear here.' : 'No requests yet.'}</div>
        ) : (
          <table className="grid">
            <thead><tr><th>#</th><th>Request</th><th>Where</th><th>Priority</th><th>Status</th><th>Assigned to</th><th>Due</th></tr></thead>
            <tbody>{rows.map((t) => (
              <tr key={t.id} className="click" onClick={() => nav(`/maintenance/${t.id}`)}>
                <td className="tag-num">{t.number}</td>
                <td><strong>{t.title}</strong><span className="sub">{CATEGORY_LABEL[t.category]}{t.source === 'battery' ? ' · from a battery alarm' : t.source === 'app' ? ` · reported in the app by ${t.createdBy ?? 'staff'}` : ''}{t.comments ? ` · ${t.comments} ${t.comments === 1 ? 'comment' : 'comments'}` : ''}{t.attachments ? ` · ${t.attachments} ${t.attachments === 1 ? 'file' : 'files'}` : ''}</span></td>
                <td>{t.doorName ?? t.location ?? '—'}{t.doorName && t.doorGroup && <span className="sub">{t.doorGroup}</span>}{!t.doorName && t.asset && <span className="sub">{t.asset}</span>}</td>
                <td><span className={`prio ${t.priority}`}>{PRIORITY_LABEL[t.priority]}</span></td>
                <td><Status s={ticketTone(t.status)} label={TICKET_LABEL[t.status]} /></td>
                <td>{t.assigneeName ?? <span className="muted">Unassigned</span>}</td>
                <td className={t.overdue ? 'overdue' : ''}>{t.dueAt ? fmt.dt(t.dueAt) : '—'}{t.overdue && <span className="sub" style={{ color: 'var(--bad)' }}>overdue</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {creating && <NewRequest people={people.data ?? []} onClose={() => setCreating(false)} onCreated={(t) => { setCreating(false); void list.reload(); nav(`/maintenance/${t.id}`); }} />}
      {ticketId && <TicketDetail id={ticketId} people={people.data ?? []} onClose={() => nav('/maintenance')} onChanged={list.reload} />}
    </>
  );
}

function NewRequest({ people, onClose, onCreated }: { people: any[]; onClose: () => void; onCreated: (t: any) => void }) {
  const { base, can } = useHotel();
  const manager = can('maintenance.manage');
  const doors = useApi<any[]>(`${base}/resources?kind=door`);
  const [f, setF] = useState({ title: '', description: '', category: 'other', priority: 'normal', doorId: '', location: '', asset: '', assigneeStaffId: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      onCreated(await api(`${base}/maintenance/tickets`, { body: {
        title: f.title, description: f.description, category: f.category, priority: f.priority, doorId: f.doorId || null, location: f.location || null, asset: f.asset || null,
        ...(manager && f.assigneeStaffId ? { assigneeStaffId: f.assigneeStaffId } : {}),
      } }));
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const activeDoors = (doors.data ?? []).filter((d) => d.active).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return (
    <Drawer title="New maintenance request" onClose={onClose} footer={<><span /><div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="newreq" disabled={busy || f.title.trim().length < 3}>{busy ? 'Saving…' : 'Create request'}</button></div></>}>
      <form id="newreq" onSubmit={submit}>
        <ErrorNote error={error} />
        <div className="field"><label htmlFor="t">What needs doing?</label><input id="t" value={f.title} onChange={set('title')} placeholder="For example: door closer leaking" autoFocus maxLength={120} required /></div>
        <div className="field"><label htmlFor="d">Details</label><textarea id="d" rows={4} value={f.description} onChange={set('description')} maxLength={4000} /></div>
        <div className="field-row">
          <div className="field"><label htmlFor="c">Type</label><select id="c" value={f.category} onChange={set('category')}>{Object.entries(CATEGORY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <div className="field"><label htmlFor="p">Priority</label><select id="p" value={f.priority} onChange={set('priority')}>{Object.entries(PRIORITY_LABEL).filter(([v]) => manager || v !== 'urgent').map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <span className="hint">Sets the due time from the hotel's policy.</span></div>
        </div>
        <div className="field-row">
          <div className="field"><label htmlFor="door">Door (Visionline)</label>
            <select id="door" value={f.doorId} onChange={set('doorId')}><option value="">None</option>{activeDoors.map((d) => <option key={d.external_id} value={d.external_id}>{d.name}{d.data?.doorGroup ? ` · ${d.data.doorGroup}` : ''}</option>)}</select></div>
          <div className="field"><label htmlFor="loc">Or place</label><input id="loc" value={f.location} onChange={set('location')} placeholder="Lobby, kitchen, room 204…" maxLength={120} /></div>
        </div>
        <div className="field"><label htmlFor="asset">Item</label><input id="asset" value={f.asset} onChange={set('asset')} placeholder="Optional: minibar, AC unit, TV…" maxLength={120} /></div>
        {manager && (
          <div className="field"><label htmlFor="as">Give it to</label>
            <select id="as" value={f.assigneeStaffId} onChange={set('assigneeStaffId')}>
              <option value="">Nobody yet (the maintenance team is told)</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.jobRole}{p.openTasks ? ` · ${p.openTasks} open` : ''}{p.hasApp ? '' : ' · no app'}</option>)}
            </select>
            <span className="hint">They are told in the staff app and see it under My tasks.</span></div>
        )}
      </form>
    </Drawer>
  );
}

function TicketDetail({ id, people, onClose, onChanged }: { id: string; people: any[]; onClose: () => void; onChanged: () => void }) {
  const { base, can } = useHotel();
  const manager = can('maintenance.manage');
  const worker = can('maintenance.work');
  const t = useApi<any>(`${base}/maintenance/tickets/${id}`, [id], 10_000);
  const [error, setError] = useState<unknown>(null);
  const [move, setMove] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [replaced, setReplaced] = useState(true);
  const [comment, setComment] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const d = t.data;
  const run = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); await t.reload(); onChanged(); return true; } catch (e) { setError(e); return false; } };
  const patch = (body: unknown) => run(() => api(`${base}/maintenance/tickets/${id}`, { method: 'PATCH', body }));
  if (!d) return <Drawer title="Maintenance request" onClose={onClose}><ErrorNote error={t.error} /></Drawer>;
  const moves = (MOVES[d.status] ?? []).filter((m) => worker && (!m.manager || manager));
  const doMove = async (to: string) => {
    if ((to === 'RESOLVED' || to === 'ON_HOLD' || to === 'CANCELLED') && move !== to) { setMove(to); setNote(''); return; }
    if (await run(() => api(`${base}/maintenance/tickets/${id}/status`, { body: { status: to, note: note || null, ...(to === 'RESOLVED' && d.category === 'battery' ? { batteryReplaced: replaced } : {}) } }))) setMove(null);
  };
  const upload = async (file: File) => {
    const b64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = rej; r.readAsDataURL(file); });
    await run(() => api(`${base}/maintenance/tickets/${id}/attachments`, { body: { filename: file.name, dataBase64: b64 } }));
    if (fileRef.current) fileRef.current.value = '';
  };
  const openFile = async (a: any) => {
    const r = await fetch(`${base}/maintenance/tickets/${id}/attachments/${a.id}`, { headers: { authorization: `Bearer ${auth.token}` } });
    if (!r.ok) return setError(new Error('Could not open the file.'));
    const url = URL.createObjectURL(await r.blob());
    Object.assign(document.createElement('a'), { href: url, download: a.filename }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const dueLocal = d.dueAt ? toLocalInput(d.dueAt) : '';

  return (
    <Drawer title={`#${d.number} · ${d.title}`} onClose={onClose} footer={
      <>
        <span className="small muted">{CATEGORY_LABEL[d.category]} · opened {fmt.dt(d.createdAt)} by {d.createdBy ?? '—'}</span>
        <div className="row">{moves.map((m) => <button key={m.to} className={`btn ${m.primary ? 'primary' : ''} ${m.to === 'CANCELLED' ? 'danger' : ''}`} onClick={() => doMove(m.to)}>{m.label}</button>)}</div>
      </>
    }>
      <ErrorNote error={error} />
      {move && (
        <div className="panel">
          <div className="field"><label htmlFor="note">{move === 'RESOLVED' ? 'What was done?' : move === 'ON_HOLD' ? 'Why is it on hold?' : 'Why cancel it?'}</label>
            <textarea id="note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus placeholder={move === 'RESOLVED' ? 'Required: for example, replaced the closer arm' : move === 'ON_HOLD' ? 'For example: waiting for a part' : ''} /></div>
          {move === 'RESOLVED' && d.category === 'battery' && <label className="check"><input type="checkbox" checked={replaced} onChange={(e) => setReplaced(e.target.checked)} /><span>The lock battery was replaced<span className="hint" style={{ display: 'block' }}>Resolves the battery alert; the door shows Good until the lock reports again.</span></span></label>}
          <div className="row end"><button className="btn" onClick={() => setMove(null)}>Back</button><button className="btn primary" disabled={move === 'RESOLVED' && note.trim().length < 3} onClick={() => doMove(move)}>{move === 'RESOLVED' ? 'Mark resolved' : move === 'ON_HOLD' ? 'Put on hold' : 'Cancel request'}</button></div>
        </div>
      )}
      <div className="split" style={{ gridTemplateColumns: 'minmax(0,1fr) 270px' }}>
        <div>
          <dl className="kv" style={{ marginBottom: 16 }}>
            <dt>Status</dt><dd><Status s={ticketTone(d.status)} label={TICKET_LABEL[d.status]} />{d.overdue && <span className="overdue small"> · overdue</span>}</dd>
            <dt>Where</dt><dd>{d.doorName ? <>{d.doorName}{d.doorGroup ? ` · ${d.doorGroup}` : ''}{can('battery.read') && d.category === 'battery' && <> · <Link to={`/battery/${encodeURIComponent(d.doorId)}`}>battery</Link></>}</> : d.location ?? '—'}{d.asset ? <span className="small muted"> · {d.asset}</span> : null}</dd>
            {d.batteryAlertId && <><dt>Battery alarm</dt><dd>{d.alertSeverity === 'CRITICAL' ? 'Critical' : 'Low'} · {d.alertStatus === 'RESOLVED' ? 'resolved' : 'open'}</dd></>}
            <dt>Resolution</dt><dd>{d.resolution ?? <span className="muted">Not resolved yet</span>}</dd>
          </dl>
          {d.description && <div className="bubble-plain" style={{ whiteSpace: 'pre-wrap', marginBottom: 16 }}>{d.description}</div>}

          <h3>Activity</h3>
          <ol className="activity">
            {d.activity.map((a: any) => (
              <li key={a.id}>
                <span className={`who ${a.actorType}`} aria-hidden>{a.actorType === 'system' ? '•' : initials(a.actorName)}</span>
                <div>
                  <div><strong>{a.actorType === 'system' ? 'Platform' : a.actorName}</strong> {describe(a, people)} <time>· {fmt.dt(a.at)}</time></div>
                  {a.body && a.kind !== 'created' && <div className="bubble">{a.body}</div>}
                </div>
              </li>
            ))}
          </ol>
          {worker && (
            <form className="row" style={{ marginTop: 12, alignItems: 'flex-end' }} onSubmit={async (e) => { e.preventDefault(); if (await run(() => api(`${base}/maintenance/tickets/${id}/comments`, { body: { body: comment } }))) setComment(''); }}>
              <div className="field" style={{ flex: 1, margin: 0 }}><label htmlFor="cm" className="sr">Comment</label><textarea id="cm" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment" maxLength={4000} /></div>
              <button className="btn" disabled={!comment.trim()}>Comment</button>
            </form>
          )}
        </div>
        <div>
          <div className="field"><label htmlFor="asg">Assigned to</label>
            <select id="asg" value={d.assigneeStaffId ?? ''} disabled={!manager} onChange={(e) => patch({ assigneeStaffId: e.target.value || null })}>
              <option value="">Unassigned</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.hasApp ? '' : ' (no app)'}</option>)}
            </select></div>
          <div className="field"><label htmlFor="pr">Priority</label>
            <select id="pr" value={d.priority} disabled={!manager} onChange={(e) => patch({ priority: e.target.value })}>{Object.entries(PRIORITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <div className="field"><label htmlFor="due">Due</label>
            <input id="due" type="datetime-local" defaultValue={dueLocal} key={dueLocal} disabled={!manager} onBlur={(e) => { const v = e.target.value; if (v && v !== dueLocal) void patch({ dueAt: new Date(v).toISOString() }); }} /></div>
          <h3 style={{ marginTop: 18 }}>Files</h3>
          {d.attachments.length ? (
            <ul className="files">{d.attachments.map((a: any) => <li key={a.id}><button className="linkish" onClick={() => openFile(a)}>{a.filename}</button><span className="small muted">{Math.max(1, Math.round(a.size / 1024))} KB</span></li>)}</ul>
          ) : <p className="muted small">No files.</p>}
          {worker && <label className="btn small" style={{ cursor: 'pointer' }}>Attach photo or PDF<input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} /></label>}
          <p className="hint small muted" style={{ marginTop: 6 }}>Up to 3 MB each.</p>
        </div>
      </div>
    </Drawer>
  );
}

const initials = (n?: string | null) => (n ?? '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
function toLocalInput(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function describe(a: any, people: any[]): string {
  const x = a.data ?? {};
  const name = (id?: string | null) => (id ? people.find((p) => p.id === id)?.name ?? x.toName ?? 'someone' : 'nobody');
  switch (a.kind) {
    case 'created': return `opened the request${x.source === 'battery' ? ' from a battery alarm' : x.source === 'app' ? ' from the staff app' : ''}${a.body ? `: “${a.body}”` : ''}`;
    case 'comment': return 'commented';
    case 'status': return `${({ ACKNOWLEDGED: 'acknowledged it', IN_PROGRESS: 'started work', ON_HOLD: 'put it on hold', RESOLVED: x.batteryReplaced ? 'resolved it: battery replaced' : 'resolved it', CLOSED: 'closed it', CANCELLED: 'cancelled it', OPEN: 'reopened it' } as Record<string, string>)[x.to] ?? `moved it to ${x.to}`}`;
    case 'assigned': return x.to ? `assigned it to ${x.toName ?? name(x.to)}` : 'removed the assignment';
    case 'priority': return `changed priority from ${PRIORITY_LABEL[x.from] ?? x.from} to ${PRIORITY_LABEL[x.to] ?? x.to}`;
    case 'due': return `set the due time to ${fmt.dt(x.to)}`;
    case 'edited': return `edited ${(x.fields ?? []).join(', ')}`;
    case 'attachment': return 'attached a file';
    case 'battery': return 'battery update';
    default: return a.kind;
  }
}
