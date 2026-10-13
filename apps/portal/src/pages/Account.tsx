import { useState } from 'react';
import { api, sealCredential } from '../api';
import { useHotel } from '../App';
import { ErrorNote, PageHead, Status, fmt, useApi, waitForCommand } from '../ui';

type Tab = 'user' | 'visionline' | 'mfa';

/** Your account: user settings, personal Visionline credentials, two-step sign-in (vendor portal parity). */
export function AccountPage() {
  const { me } = useHotel();
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get('tab') as Tab) ?? 'user');
  return (
    <>
      <PageHead title="Your account" intro={me.email} />
      <div className="seg" role="tablist" style={{ marginBottom: 16 }}>
        <button role="tab" aria-pressed={tab === 'user'} onClick={() => setTab('user')}>User settings</button>
        <button role="tab" aria-pressed={tab === 'visionline'} onClick={() => setTab('visionline')}>Visionline credentials</button>
        <button role="tab" aria-pressed={tab === 'mfa'} onClick={() => setTab('mfa')}>Two-step sign-in</button>
      </div>
      {tab === 'user' && <UserSettings />}
      {tab === 'visionline' && <PersonalVisionline />}
      {tab === 'mfa' && <TwoStep />}
    </>
  );
}

function UserSettings() {
  const { me } = useHotel();
  const [name, setName] = useState(me.displayName);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  const saveName = async () => { setError(null); setOk(null); try { await api('/api/v1/me', { method: 'PATCH', body: { displayName: name } }); setOk('Name saved. It appears in the audit trail from now on.'); } catch (e) { setError(e); } };
  const savePw = async () => {
    setError(null); setOk(null);
    if (next !== again) { setError(new Error('The new passwords do not match.')); return; }
    try { await api('/api/v1/me/password', { body: { current: cur, next } }); setCur(''); setNext(''); setAgain(''); setOk('Password changed.'); } catch (e) { setError(e); }
  };
  return (
    <div className="panel" style={{ maxWidth: 720 }}>
      <ErrorNote error={error} />
      {ok && <div className="alert ok">{ok}</div>}
      <div className="field"><label htmlFor="nm">Name</label><input id="nm" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field"><label htmlFor="em">Email</label><input id="em" value={me.email} disabled /><span className="hint">Your sign-in. Ask a hotel administrator to change it.</span></div>
      <button className="btn" onClick={saveName} disabled={name.trim().length < 2 || name === me.displayName}>Save name</button>
      <h3 style={{ marginTop: 24 }}>Change password</h3>
      <div className="field-row">
        <div className="field"><label htmlFor="cp">Current password</label><input id="cp" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></div>
        <div className="field"><label htmlFor="np">New password</label><input id="np" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /><span className="hint">At least 10 characters.</span></div>
        <div className="field"><label htmlFor="ap">New password again</label><input id="ap" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></div>
      </div>
      <button className="btn primary" onClick={savePw} disabled={!cur || next.length < 10}>Change password</button>
    </div>
  );
}

function PersonalVisionline() {
  const { base, hotel, me } = useHotel();
  const st = useApi<any>(`${base}/me/visionline-credentials`, [], 3000);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const c = st.data?.credential;
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const sealed = await sealCredential(base, hotel.id, 'operator', username || c?.username, password, me.id);
      const r = await api(`${base}/me/visionline-credentials`, { method: 'PUT', body: { username: username || c?.username, sealed } });
      setPassword('');
      await waitForCommand(hotel.id, r.commandId, 60_000).catch(() => {});
      await st.reload();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const remove = async () => { try { await api(`${base}/me/visionline-credentials`, { method: 'DELETE' }); await st.reload(); } catch (e) { setError(e); } };
  return (
    <div className="panel" style={{ maxWidth: 720 }}>
      <div className="alert warn">
        {st.data?.required ? 'This hotel requires personal Visionline credentials before you can issue keys.' : 'Optional. With personal Visionline credentials, keys you issue are recorded in Visionline under your own operator name instead of the property operator.'}
      </div>
      <ErrorNote error={error} />
      {c && (
        <dl className="kv" style={{ marginBottom: 16 }}>
          <dt>Visionline username</dt><dd className="mono">{c.username}</dd>
          <dt>Status</dt><dd><Status s={c.status === 'VERIFIED' ? 'ACTIVE' : c.status === 'PENDING' ? 'QUEUED' : 'FAILED'} label={c.status === 'VERIFIED' ? 'Verified with Visionline' : c.status === 'PENDING' ? 'Checking with Visionline' : 'Not accepted'} />
            {c.statusDetail && <div className="small muted" style={{ marginTop: 4 }}>{c.statusDetail}</div>}</dd>
          <dt>Last checked</dt><dd>{fmt.dt(c.verifiedAt ?? c.updatedAt)}</dd>
        </dl>
      )}
      <div className="field"><label htmlFor="vu">Visionline username</label><input id="vu" autoComplete="off" value={username} placeholder={c?.username ?? ''} onChange={(e) => setUsername(e.target.value)} /></div>
      <div className="field"><label htmlFor="vp">Visionline password</label><input id="vp" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your personal Visionline password" />
        <span className="hint">Encrypted in this browser for the hotel connector. It is never stored readable on the platform and never shown again.</span></div>
      <div className="row">
        <button className="btn primary" onClick={save} disabled={busy || !password || !(username || c?.username)}>{busy ? 'Checking with Visionline…' : 'Save and verify'}</button>
        {c && <button className="btn danger" onClick={remove}>Remove</button>}
      </div>
    </div>
  );
}

function TwoStep() {
  const { me } = useHotel();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [done, setDone] = useState(me.mfaEnabled);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="panel" style={{ maxWidth: 640 }}>
      <ErrorNote error={error} />
      {done ? <p>Two-step sign-in is on. You’ll be asked for a code from your authenticator app each time you sign in.</p> : !setup ? (
        <>
          <p>Protect your account with a 6-digit code from an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password and similar).</p>
          <button className="btn primary" onClick={async () => { try { setSetup(await api('/api/v1/auth/mfa/setup', { body: {} })); } catch (e) { setError(e); } }}>Turn on two-step sign-in</button>
        </>
      ) : (
        <>
          <p>In your authenticator app, add an account using this setup key:</p>
          <div className="token-box">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</div>
          <p className="small muted" style={{ marginTop: 8 }}>Or open this link on your phone: <a href={setup.otpauthUrl}>add to authenticator</a></p>
          <div className="field" style={{ maxWidth: 220 }}><label htmlFor="c">Code from the app</label><input id="c" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} /></div>
          <button className="btn primary" onClick={async () => { try { await api('/api/v1/auth/mfa/enable', { body: { code } }); setDone(true); } catch (e) { setError(e); } }}>Confirm and turn on</button>
        </>
      )}
    </div>
  );
}
