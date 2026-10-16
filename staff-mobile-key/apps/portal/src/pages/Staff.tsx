import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useHotel } from '../App';
import { Drawer, ErrorNote, PageHead, Status, fmt, useApi } from '../ui';
import { IssueKey } from '../components/IssueKey';
import { ImportStaff } from '../components/ImportStaff';

export function StaffPage() {
  const { base, can } = useHotel();
  const nav = useNavigate();
  const staff = useApi<any[]>(`${base}/staff`, [], 5000);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [issueFor, setIssueFor] = useState<string | null>(null);
  const rows = (staff.data ?? []).filter((s) => !q || `${s.full_name} ${s.email} ${s.job_role}`.toLowerCase().includes(q.toLowerCase()));
  const live = (s: any) => s.key_status && ['ISSUED', 'ISSUING', 'QUEUED', 'SCHEDULED', 'PENDING_APPROVAL', 'REVOKING'].includes(s.key_status) && new Date(s.key_expires_at) > new Date();

  return (
    <>
      <PageHead title="Staff" intro="People who can receive mobile keys, their phone set-up and their current key.">
        <input type="search" placeholder="Search name, email or role" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search staff" style={{ padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6, minWidth: 240 }} />
        {can('staff.manage') && <button className="btn" onClick={() => setImporting(true)}>Import from file</button>}
        {can('staff.manage') && <button className="btn primary" onClick={() => setAdding(true)}>Add staff member</button>}
      </PageHead>
      <ErrorNote error={staff.error} />
      <div className="panel flush">
        {staff.data && !rows.length ? <div className="empty">{q ? `No one matches “${q}”.` : 'No staff yet. Add the first person who needs a mobile key.'}</div> : (
          <table className="grid">
            <thead><tr><th>Name</th><th>Phone</th><th>Current key</th><th>Visionline user</th><th /></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.full_name}</strong><span className="sub">{s.job_role} · {s.email}</span>{s.status !== 'ACTIVE' && <Status s={s.status} />}</td>
                  <td>{s.endpoint_status ? <Status s={s.endpoint_status} /> : <span className="muted small">Not set up</span>}{s.device_label && <span className="sub">{s.device_label}</span>}</td>
                  <td>{s.key_status ? (
                    <button className="btn small" style={{ border: 0, padding: 0, background: 'none' }} onClick={() => nav(`/keys/${s.key_id}`)}>
                      <Status s={s.key_status} />
                    </button>) : <span className="muted small">None</span>}
                    {s.key_status && <span className="sub">{s.template_name ?? 'custom doors'} · until {fmt.dt(s.key_expires_at)}</span>}
                  </td>
                  <td><span className="mono">{s.visionline_user}</span><span className="sub">{s.visionline_user_group ?? 'default group'}{s.uniform_access ? ' · uniform access' : ''}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="row end">
                      {can('key.issue') && s.endpoint_status === 'ACTIVE' && !live(s) && s.status === 'ACTIVE' && <button className="btn small primary" onClick={() => setIssueFor(s.id)}>Issue key</button>}
                      {(can('staff.manage') || can('endpoint.delete')) && <button className="btn small" onClick={() => setEditing(s)}>Manage</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {importing && <ImportStaff onClose={() => setImporting(false)} onDone={() => void staff.reload()} />}
      {adding && <StaffForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void staff.reload(); }} />}
      {editing && <StaffForm person={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void staff.reload(); }} />}
      {issueFor && <IssueKey staffId={issueFor} onClose={() => setIssueFor(null)} onIssued={(k) => nav(`/keys/${k.id}`)} />}
    </>
  );
}

function StaffForm({ person, onClose, onSaved }: { person?: any; onClose: () => void; onSaved: () => void }) {
  const { base, can } = useHotel();
  const groups = useApi<any[]>(`${base}/resources?kind=usergroup`);
  const vl = useApi<any>(`${base}/config/visionline`);
  const found = new Set((groups.data ?? []).map((g) => g.external_id));
  const groupNames: string[] = [...new Set<string>([...(vl.data?.data?.userGroups ?? []), ...found])];
  const [f, setF] = useState({ fullName: person?.full_name ?? '', email: person?.email ?? '', employeeNo: person?.employee_no ?? '', jobRole: person?.job_role ?? 'Housekeeper', visionlineUser: person?.visionline_user ?? '', visionlineUserGroup: person?.visionline_user_group ?? '', appPassword: '' });
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setError(null);
    try {
      const body: any = { fullName: f.fullName, jobRole: f.jobRole, visionlineUserGroup: f.visionlineUserGroup || null, ...(f.appPassword ? { appPassword: f.appPassword } : {}) };
      if (person) await api(`${base}/staff/${person.id}`, { method: 'PATCH', body });
      else await api(`${base}/staff`, { body: { ...body, email: f.email, employeeNo: f.employeeNo || null, visionlineUser: f.visionlineUser || null } });
      onSaved();
    } catch (e) { setError(e); }
  };
  const setStatus = async (status: string) => {
    try { const r = await api(`${base}/staff/${person.id}`, { method: 'PATCH', body: { status } }); setNote(r.note ?? 'Saved.'); } catch (e) { setError(e); }
  };
  const removePhone = async () => {
    if (!confirm(`Remove ${person.full_name}'s phone? Keys on it stop working and they will need to set up their phone again.`)) return;
    try { await api(`${base}/staff/${person.id}/endpoint/remove`, { body: {} }); onSaved(); } catch (e) { setError(e); }
  };
  return (
    <Drawer title={person ? person.full_name : 'Add staff member'} onClose={onClose} footer={
      <><span /><div className="row"><button className="btn" onClick={onClose}>Cancel</button>{can('staff.manage') && <button className="btn primary" onClick={save} disabled={!f.fullName || (!person && !f.email)}>{person ? 'Save changes' : 'Add staff member'}</button>}</div></>
    }>
      <ErrorNote error={error} />
      {note && <div className="alert warn">{note}</div>}
      <div className="field-row">
        <div className="field"><label htmlFor="fn">Full name</label><input id="fn" value={f.fullName} onChange={set('fullName')} /></div>
        <div className="field"><label htmlFor="jr">Job role</label>
          <select id="jr" value={f.jobRole} onChange={set('jobRole')}>{[...new Set(['Housekeeper', 'Housekeeping Supervisor', 'Maintenance', 'Security', 'Manager', 'Front Office', f.jobRole])].map((r) => <option key={r}>{r}</option>)}</select></div>
      </div>
      <div className="field-row">
        <div className="field"><label htmlFor="em">Work email</label><input id="em" type="email" value={f.email} onChange={set('email')} disabled={Boolean(person)} /><span className="hint">Used to sign in to the staff app.</span></div>
        <div className="field"><label htmlFor="eno">Employee number</label><input id="eno" value={f.employeeNo} onChange={set('employeeNo')} disabled={Boolean(person)} /></div>
      </div>
      <h3 style={{ marginTop: 6 }}>Visionline</h3>
      <div className="field-row">
        <div className="field"><label htmlFor="vu">Visionline user ID</label><input id="vu" value={f.visionlineUser} onChange={set('visionlineUser')} disabled={Boolean(person)} placeholder="Created automatically if empty" /><span className="hint">The card holder in Visionline. Created on first key if missing.</span></div>
        <div className="field"><label htmlFor="ug">User group</label>
          <select id="ug" value={f.visionlineUserGroup} onChange={set('visionlineUserGroup')}>
            <option value="">Hotel default{vl.data?.data?.defaultUserGroup ? ` (${vl.data.data.defaultUserGroup})` : ''}</option>
            {f.visionlineUserGroup && !groupNames.includes(f.visionlineUserGroup) && <option value={f.visionlineUserGroup}>{f.visionlineUserGroup}</option>}
            {groupNames.map((g) => <option key={g} value={g}>{g}{found.has(g) ? '' : ' (not in Visionline yet)'}</option>)}
          </select><span className="hint">Groups are managed in Settings → Visionline.</span></div>
      </div>
      <h3 style={{ marginTop: 6 }}>Staff app sign-in</h3>
      <div className="field"><label htmlFor="ap">{person ? 'Set a new temporary password' : 'Temporary password'}</label><input id="ap" type="password" autoComplete="new-password" value={f.appPassword} onChange={set('appPassword')} placeholder="At least 8 characters" />
        <span className="hint">Development sign-in. In production staff sign in with the hotel's identity provider.</span></div>
      {person && (
        <div className="panel" style={{ marginTop: 10 }}>
          <h3>Phone and access</h3>
          <p className="small muted">{person.endpoint_status === 'ACTIVE' ? `Phone set up ${fmt.dt(person.activated_at)}.` : person.endpoint_status === 'INVITED' ? 'Invitation created; waiting for the app to finish set-up.' : 'No phone set up.'}</p>
          <div className="row">
            {person.endpoint_status && can('endpoint.delete') && <button className="btn danger small" onClick={removePhone}>Remove phone</button>}
            {can('staff.manage') && person.status === 'ACTIVE' && <button className="btn small" onClick={() => setStatus('SUSPENDED')}>Suspend</button>}
            {can('staff.manage') && person.status !== 'ACTIVE' && <button className="btn small" onClick={() => setStatus('ACTIVE')}>Reactivate</button>}
          </div>
        </div>
      )}
    </Drawer>
  );
}
