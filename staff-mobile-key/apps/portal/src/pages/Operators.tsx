import { useState } from 'react';
import { ROLES, ROLE_PERMISSIONS, type Role } from '@smk/shared';
import { api } from '../api';
import { useHotel } from '../App';
import { Drawer, ErrorNote, PageHead, fmt, useApi } from '../ui';

const ASSIGNABLE = ROLES.filter((r) => r !== 'PLATFORM_ADMIN');

export function OperatorsPage() {
  const { base, me } = useHotel();
  const ops = useApi<any[]>(`${base}/operators`);
  const [edit, setEdit] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHead title="Operators" intro="People who use this portal, and what each of them is allowed to do.">
        <button className="btn primary" onClick={() => setAdding(true)}>Add operator</button>
      </PageHead>
      <ErrorNote error={ops.error} />
      <div className="panel flush">
        <table className="grid">
          <thead><tr><th>Name</th><th>Roles</th><th>Sign-in</th><th>Last sign-in</th><th /></tr></thead>
          <tbody>
            {(ops.data ?? []).map((o) => (
              <tr key={o.id}>
                <td><strong>{o.display_name}</strong><span className="sub">{o.email}</span></td>
                <td>{o.roles.map((r: string) => me.roleLabels[r] ?? r).join(', ')}</td>
                <td className="small">{o.idp_subject ? 'Hotel identity provider' : 'Local account'}{o.mfa_enabled ? ' · two-step on' : ' · two-step off'}</td>
                <td className="small">{fmt.rel(o.last_sign_in_at)}</td>
                <td style={{ textAlign: 'right' }}>{o.id !== me.id && <button className="btn small" onClick={() => setEdit(o)}>Change roles</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h2>What each role can do</h2>
        <table className="grid small">
          <tbody>{ASSIGNABLE.map((r) => <tr key={r}><td style={{ width: 200 }}><strong>{me.roleLabels[r]}</strong></td><td className="muted">{ROLE_PERMISSIONS[r].join(', ')}</td></tr>)}</tbody>
        </table>
        <p className="small muted" style={{ marginTop: 10 }}>Broad access needs two people: a Key Issuer can request it, and a Security Manager or Approver must approve it.</p>
      </div>
      {(edit || adding) && <OperatorForm op={edit} onClose={() => { setEdit(null); setAdding(false); }} onSaved={() => { setEdit(null); setAdding(false); void ops.reload(); }} />}
    </>
  );
}

function OperatorForm({ op, onClose, onSaved }: { op?: any; onClose: () => void; onSaved: () => void }) {
  const { base, me } = useHotel();
  const [roles, setRoles] = useState<Role[]>(op?.roles ?? ['KEY_ISSUER']);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [error, setError] = useState<unknown>(null);
  const toggle = (r: Role) => setRoles(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r]);
  const save = async () => {
    try {
      if (op) await api(`${base}/operators/${op.id}/roles`, { method: 'PUT', body: { roles } });
      else await api(`${base}/operators`, { body: { email, displayName: name, roles, tempPassword: pw } });
      onSaved();
    } catch (e) { setError(e); }
  };
  return (
    <Drawer title={op ? `Roles for ${op.display_name}` : 'Add operator'} onClose={onClose} footer={<><span /><div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!roles.length} onClick={save}>{op ? 'Save roles' : 'Add operator'}</button></div></>}>
      <ErrorNote error={error} />
      {!op && (
        <>
          <div className="field-row">
            <div className="field"><label htmlFor="on">Name</label><input id="on" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="field"><label htmlFor="oe">Work email</label><input id="oe" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          </div>
          <div className="field"><label htmlFor="op">Temporary password</label><input id="op" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /><span className="hint">At least 10 characters. Ask them to turn on two-step sign-in after their first sign-in.</span></div>
        </>
      )}
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>Roles</legend>
        {ASSIGNABLE.map((r) => (
          <label key={r} className="check"><input type="checkbox" checked={roles.includes(r)} onChange={() => toggle(r)} /><span><strong>{me.roleLabels[r]}</strong><span className="sub small muted" style={{ display: 'block' }}>{ROLE_PERMISSIONS[r].slice(0, 6).join(', ')}{ROLE_PERMISSIONS[r].length > 6 ? '…' : ''}</span></span></label>
        ))}
      </fieldset>
    </Drawer>
  );
}
