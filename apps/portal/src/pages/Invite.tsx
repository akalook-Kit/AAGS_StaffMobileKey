import { useEffect, useState, type FormEvent } from 'react';
import { api, auth } from '../api';
import { ErrorNote } from '../ui';

/**
 * 2.16 The invitation link: the person chooses their own password and is signed in. The link's secret is in the
 * address after "#", so it never reaches server logs; it is removed from the address bar at once.
 */
export function InvitePage({ token, onSignedIn }: { token: string; onSignedIn: (token: string) => void }) {
  const [info, setInfo] = useState<any>(null);
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [doneSignIn, setDoneSignIn] = useState(false);
  useEffect(() => { try { history.replaceState(null, '', '/invite'); } catch { /* ignore */ } }, []);
  useEffect(() => { document.title = 'Set your password'; api(`/api/v1/public/invites/${encodeURIComponent(token)}`).then(setInfo).catch(setError); }, [token]);
  const problem = pw && pw.length < 12 ? 'At least 12 characters.' : again && again !== pw ? 'The two passwords differ.' : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem || !pw) return;
    setBusy(true); setError(null);
    try {
      const r = await api(`/api/v1/public/invites/${encodeURIComponent(token)}`, { body: { password: pw } });
      history.replaceState(null, '', '/');
      if (r.token) onSignedIn(r.token); else setDoneSignIn(true);
    } catch (x) { setError(x); } finally { setBusy(false); }
  };
  return (
    <div className="setup"><div className="setup-card" style={{ maxWidth: 520 }}>
      <div className="setup-kicker">{info?.site ?? 'Access Monitoring Tool'}</div>
      <h1>Welcome{info?.name ? `, ${info.name.split(' ')[0]}` : ''}</h1>
      <ErrorNote error={error} />
      {doneSignIn && <div className="alert ok">Your new password is saved. <a href="/">Sign in</a> with it and your two-step code.</div>}
      {info && !doneSignIn && (
        <form onSubmit={submit}>
          <p className="muted">{info.reset ? 'Choose a new password' : 'Choose the password you will use'} to sign in as <strong>{info.email}</strong>.</p>
          <div className="field"><label htmlFor="p1">Password</label><input id="p1" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" minLength={12} required autoFocus /><span className="hint">At least 12 characters. A short sentence is easy to remember.</span></div>
          <div className="field"><label htmlFor="p2">Same password again</label><input id="p2" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required /></div>
          {problem && <p className="small" style={{ color: 'var(--bad)' }}>{problem}</p>}
          <button className="btn primary" disabled={busy || Boolean(problem) || !pw || pw !== again}>{busy ? 'Saving…' : 'Save and sign in'}</button>
          <p className="small muted" style={{ marginTop: 14 }}>After signing in, turn on two-step sign-in under <em>Your account</em> for extra protection.</p>
        </form>
      )}
      {!info && !error && <p className="muted">Checking the link…</p>}
    </div></div>
  );
}
