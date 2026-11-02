import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ROLES, ROLE_PERMISSIONS, type Role } from '@smk/shared';
import { api } from '../api';
import { useHotel } from '../App';
import { Drawer, ErrorNote, PageHead, Status, fmt, useApi } from '../ui';
import { useReauth } from '../components/Reauth';

const ASSIGNABLE = ROLES.filter((r) => r !== 'PLATFORM_ADMIN');

export function OperatorsPage() {
  const { base, me } = useHotel();
  const ops = useApi<any[]>(`${base}/operators`);
  const [edit, setEdit] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [linking, setLinking] = useState<any>(null);
  const [link, setLink] = useState<{ name: string; url: string; outside?: string; emailed?: boolean; emailError?: string } | null>(null);
  const [modules, setModules] = useState<any>(null);
  const [withReauth, reauthDialog] = useReauth();
  const [msg, setMsg] = useState<unknown>(null);
  const portalUrl = location.origin;
  const renew = async (o: any) => {
    setMsg(null);
    const go = (t?: string) => api(`${base}/operators/${o.id}/invite`, { body: { sendEmail: true, portalUrl }, headers: t ? { 'x-smk-reauth': t } : {} });
    if (o.status === 'ACTIVE' && !confirm(`Make a link with which ${o.display_name} chooses a new password (forgotten password)? Their current password stops working once they use it.`)) return;
    try { const r: any = o.status === 'ACTIVE' ? await new Promise((res, rej) => { withReauth((t) => go(t).then(res, rej)).catch(rej); }) : await go(); setLink({ name: o.display_name, url: `${portalUrl}/invite#${r.token}`, outside: r.outsideLink ?? undefined, emailed: r.emailed, emailError: r.emailError }); void ops.reload(); } catch (e) { setMsg(e); }
  };
  const remove = async (o: any) => {
    if (!confirm(`Remove ${o.display_name}'s access? They can no longer sign in here. You can invite them again later.`)) return;
    setMsg(null);
    try { await api(`${base}/operators/${o.id}/remove`, { body: {} }); void ops.reload(); } catch (e) { setMsg(e); }
  };
  const resetMfa = (o: any) => { if (confirm(`Turn two-step sign-in off for ${o.display_name} (lost phone)? They can turn it on again with a new phone.`)) withReauth((t) => api(`${base}/operators/${o.id}/mfa/reset`, { body: {}, headers: { 'x-smk-reauth': t } }).then(() => ops.reload())).catch(setMsg); };
  return (
    <>
      {reauthDialog}
      <ErrorNote error={msg} />
      <PageHead title="Users" intro="People who sign in to this portal (operators) and what each may do. Card holders are the people with keycards in Visionline; someone can be both: link them in the Keycards column. Invite someone: they get a link, choose their own password and are in.">
        <button className="btn" onClick={() => setAdding(true)}>Add with a password</button>
        <button className="btn primary" onClick={() => setInviting(true)}>Invite someone</button>
      </PageHead>
      {link && <InviteLink {...link} onClose={() => setLink(null)} />}
      <ErrorNote error={ops.error} />
      <div className="panel flush">
        <table className="grid">
          <thead><tr><th>Name</th><th>Roles</th><th>Keycards (Visionline)</th><th>Sign-in</th><th>Last sign-in</th><th /></tr></thead>
          <tbody>
            {(ops.data ?? []).map((o) => (
              <tr key={o.id}>
                <td><strong>{o.display_name}</strong><span className="sub">{o.email}</span></td>
                <td>{o.roles.map((r: string) => me.roleLabels[r] ?? r).join(', ')}{(o.hidden_modules ?? []).length > 0 && <span className="sub">hidden: {(o.hidden_modules as string[]).map((m) => (me.modules?.[m] ?? m).split(' (')[0]).join(', ')}</span>}</td>
                <td className="small">{o.vl_user_id ? <><Link to={`/access?holder=${encodeURIComponent(o.vl_user_id)}`}>{o.vl_name ?? o.vl_user_id}</Link><span className="sub">{o.vl_group ?? '—'} · {o.vl_cards} valid card{o.vl_cards === 1 ? '' : 's'}</span><button className="btn small" onClick={() => setLinking(o)}>Change</button></> : <button className="btn small" onClick={() => setLinking(o)} title="This person also holds keycards in Visionline">Link a card holder</button>}</td>
                <td className="small">{o.status === 'INVITED' ? <><Status s="PENDING" label="Invited" /><span className="sub">{o.invite_expires_at && new Date(o.invite_expires_at) > new Date() ? `link valid until ${fmt.dt(o.invite_expires_at)}` : 'link expired'}</span></> : <>{o.idp_subject ? 'Identity provider' : 'Local account'}{o.mfa_enabled ? ' · two-step on' : ' · two-step off'}</>}</td>
                <td className="small">{fmt.rel(o.last_sign_in_at)}</td>
                <td style={{ textAlign: 'right', maxWidth: 260 }}>{o.id !== me.id && <div className="row end" style={{ flexWrap: 'wrap', gap: 6 }}><button className="btn small" onClick={() => setEdit(o)}>Change roles</button><button className="btn small" onClick={() => setModules(o)}>Modules</button>{o.mfa_enabled && <button className="btn small" onClick={() => resetMfa(o)} title="Lost phone">Reset two-step</button>}<button className="btn small" onClick={() => renew(o)} title={o.status === 'INVITED' ? 'A new invitation link' : 'Forgotten password: a link to choose a new one'}>{o.status === 'INVITED' ? 'New link' : 'Password link'}</button><button className="btn small" onClick={() => remove(o)}>Remove</button></div>}</td>
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
      {modules && <ModulesForm op={modules} onClose={() => setModules(null)} onSaved={() => { setModules(null); void ops.reload(); }} />}
      {linking && <LinkPerson op={linking} onClose={() => setLinking(null)} onSaved={() => { setLinking(null); void ops.reload(); }} />}
      {inviting && <InviteForm onClose={() => setInviting(false)} onDone={(l) => { setInviting(false); setLink(l); void ops.reload(); }} />}
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

/** 2.8: hide portal modules from one person while they are being finalised (menu and permissions). */
function ModulesForm({ op, onClose, onSaved }: { op: any; onClose: () => void; onSaved: () => void }) {
  const { base, me } = useHotel();
  const [hidden, setHidden] = useState<string[]>(op.hidden_modules ?? []);
  const [error, setError] = useState<unknown>(null);
  const all = Object.entries(me.modules ?? {}) as [string, string][];
  const save = async () => { try { await api(`${base}/operators/${op.id}/modules`, { method: 'PUT', body: { hidden } }); onSaved(); } catch (e) { setError(e); } };
  return (
    <Drawer title={`Modules for ${op.display_name}`} onClose={onClose} footer={<><span /><div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></div></>}>
      <ErrorNote error={error} />
      <p className="small muted">Tick a module to hide it from this person. It disappears from their menu and they lose its rights, even if a role would allow it. Untick to show it again. Their roles do not change.</p>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn small" onClick={() => setHidden(all.map(([id]) => id).filter((id) => ['mobileKeys', 'attendance', 'breakfast', 'battery', 'maintenance', 'idCards'].includes(id)))}>Visionline only</button>
        <button className="btn small" onClick={() => setHidden([])}>Show everything</button>
      </div>
      {all.map(([id, label]) => (
        <label key={id} className="check"><input type="checkbox" checked={hidden.includes(id)} onChange={() => setHidden(hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id])} /><span>Hide <strong>{label}</strong></span></label>
      ))}
    </Drawer>
  );
}

/** 2.16 Invite someone: name, e-mail and what they do (a profile), or chosen roles. */
function InviteForm({ onClose, onDone }: { onClose: () => void; onDone: (l: { name: string; url: string; outside?: string; emailed?: boolean; emailError?: string }) => void }) {
  const { base, me } = useHotel();
  const profiles = useApi<{ id: string; label: string; hint: string }[]>(`${base}/operators/profiles`);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [profile, setProfile] = useState('frontOffice');
  const [custom, setCustom] = useState(false);
  const [roles, setRoles] = useState<Role[]>([]);
  const [mail, setMail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const send = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api(`${base}/operators/invite`, { body: { email, displayName: name, ...(custom ? { roles } : { profile }), sendEmail: mail, portalUrl: location.origin } });
      onDone(r.existing ? { name, url: '' } : { name, url: `${location.origin}/invite#${r.token}`, outside: r.outsideLink ?? undefined, emailed: r.emailed, emailError: r.emailError });
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const ok = name.trim().length >= 2 && /.+@.+\..+/.test(email) && (custom ? roles.length > 0 : Boolean(profile));
  return (
    <Drawer title="Invite someone" onClose={onClose} footer={<><span /><div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!ok || busy} onClick={send}>{busy ? 'Inviting…' : 'Invite'}</button></div></>}>
      <ErrorNote error={error} />
      <div className="field-row">
        <div className="field"><label htmlFor="in">Name</label><input id="in" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
        <div className="field"><label htmlFor="ie">Work e-mail (their sign-in)</label><input id="ie" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
      </div>
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>What do they do?</legend>
        {!custom && (profiles.data ?? []).map((p) => (
          <label key={p.id} className="check"><input type="radio" name="prof" checked={profile === p.id} onChange={() => setProfile(p.id)} /><span><strong>{p.label}</strong><span className="sub small muted" style={{ display: 'block' }}>{p.hint}</span></span></label>
        ))}
        {custom && ASSIGNABLE.map((r) => (
          <label key={r} className="check"><input type="checkbox" checked={roles.includes(r)} onChange={() => setRoles(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r])} /><span><strong>{me.roleLabels[r]}</strong></span></label>
        ))}
        <button type="button" className="btn small" onClick={() => setCustom(!custom)}>{custom ? 'Back to the simple list' : 'Choose roles instead'}</button>
      </fieldset>
      <label className="check" style={{ marginTop: 12 }}><input type="checkbox" checked={mail} onChange={(e) => setMail(e.target.checked)} /><span>Also send the link by e-mail<span className="hint" style={{ display: 'block' }}>When e-mail is set up (Settings → Alerts &amp; notifications). You can always copy the link.</span></span></label>
    </Drawer>
  );
}

function InviteLink({ name, url, outside, emailed, emailError, onClose }: { name: string; url: string; outside?: string; emailed?: boolean; emailError?: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copiedOut, setCopiedOut] = useState(false);
  if (!url) return <div className="alert ok">{name} already had an account here; their new roles apply at their next sign-in. <button className="btn small" onClick={onClose}>OK</button></div>;
  return (
    <div className="panel">
      <h2>Invitation for {name}</h2>
      <p className="small">{emailed ? 'The link was sent by e-mail. ' : ''}Send this link to {name} (e-mail, WhatsApp, Teams). It works once, for 72 hours; they choose their own password.{emailError ? ` E-mail was not sent: ${emailError}` : ''}</p>
      <div className="token-box">{url}</div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn small" onClick={() => { void navigator.clipboard?.writeText(url); setCopied(true); }}>{copied ? 'Copied' : 'Copy link'}</button>
        <button className="btn small" onClick={onClose}>Done</button>
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>The link opens the portal at this address ({location.host}); make sure {name}'s computer or phone is on a network that reaches it.</p>
      {outside && outside !== url && <>
        <h3 style={{ marginTop: 14 }}>From outside the hotel</h3>
        <div className="token-box">{outside}</div>
        <div className="row" style={{ marginTop: 8 }}><button className="btn small" onClick={() => { void navigator.clipboard?.writeText(outside); setCopiedOut(true); }}>{copiedOut ? 'Copied' : 'Copy outside link'}</button></div>
        <p className="small muted" style={{ marginTop: 6 }}>Through Cloudflare Tunnel. It contains the secret part of the outside address: send it only to {name}.</p>
      </>}
    </div>
  );
}

/** 2.17 Link a portal user to the Visionline card holder they are (an operator who also holds keycards). */
function LinkPerson({ op, onClose, onSaved }: { op: any; onClose: () => void; onSaved: () => void }) {
  const { base } = useHotel();
  const [q, setQ] = useState('');
  const list = useApi<any[]>(`${base}/operators/${op.id}/visionline-person/suggest${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`, [q]);
  const [error, setError] = useState<unknown>(null);
  const save = async (vlUserId: string | null) => { try { await api(`${base}/operators/${op.id}/visionline-person`, { method: 'PUT', body: { vlUserId } }); onSaved(); } catch (e) { setError(e); } };
  return (
    <Drawer title={`${op.display_name}: Visionline card holder`} onClose={onClose} footer={<><span />{op.vl_user_id ? <button className="btn" onClick={() => save(null)}>Unlink</button> : <span />}</>}>
      <ErrorNote error={error} />
      <p className="small muted">Operators sign in to this portal; card holders have keycards in Visionline. When {op.display_name} also holds keycards, choose them here: their keycards and door history are then one click away.</p>
      <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search Visionline people (default: "${op.display_name}")`} aria-label="Search Visionline people" />
      <ul className="vlpick-list" style={{ marginTop: 8 }}>
        {(list.data ?? []).map((p) => <li key={p.user_id}><button type="button" onClick={() => save(p.user_id)}><strong>{p.name ?? p.user_id}</strong><span>{p.user_group ?? '—'} · {p.user_id}</span></button></li>)}
        {list.data && !list.data.length && <li className="small muted" style={{ padding: 8 }}>No Visionline person with that name. People come from Visionline by themselves.</li>}
      </ul>
    </Drawer>
  );
}
