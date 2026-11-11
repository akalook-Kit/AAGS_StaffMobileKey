import { useEffect, useState, type FormEvent } from 'react';
import { api, auth, connectVisionline } from '../api';
import { ErrorNote } from '../ui';

/**
 * 2.34 First start of the light edition (Armel, 11 Nov 2026: "doesn't request any configuration except your credentials
 * for Visionline, and then it connects automatically"). The installer opens this page with the setup code; the team
 * gives the Visionline account (and, if they want, the hotel's name). Everything else is made by the server.
 */
export function LightSetupPage({ info }: { info: { version: string; suggest?: { name?: string } } }) {
  const [code, setCode] = useState(() => new URLSearchParams(location.hash.slice(1)).get('code') ?? '');
  const [askCode] = useState(() => !new URLSearchParams(location.hash.slice(1)).get('code'));
  const [name, setName] = useState(info.suggest?.name ?? '');
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  useEffect(() => { document.title = 'Access Monitoring Tool Light'; }, []);
  useEffect(() => { if (location.hash) history.replaceState(null, '', location.pathname); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(null);
    try {
      setStep('Preparing the portal…');
      try { await api('/api/v1/setup', { body: { code: code.trim(), light: { hotelName: name.trim() || undefined } } }); }
      catch (err: any) { if (err?.code !== 'SETUP_DONE') throw err; }
      const o = await api<{ token: string }>('/api/v1/auth/open');
      auth.set(o.token);
      try { sessionStorage.setItem('smk.openAvail', '1'); } catch { /* ignore */ }
      const me = await api<{ hotels: { id: string }[] }>('/api/v1/me');
      await connectVisionline(me.hotels[0]!.id, u.trim(), p, setStep);
      setP(''); setDone(true);
      setTimeout(() => location.replace('/'), 1500);
    } catch (err) { setError(err); setStep(null); }
  };

  return (
    <div className="setup">
      <form className="setup-card panel" onSubmit={submit} style={{ maxWidth: 520, margin: '6vh auto' }}>
        <h1 style={{ marginTop: 0 }}>Access Monitoring Tool Light</h1>
        <p>Lock diagnosis, battery follow-up and day reports. The only thing needed is the <strong>Visionline account</strong> the portal reads with; it then connects by itself and reads the doors.</p>
        {askCode && <div className="field"><label htmlFor="ls-code">Setup code (shown at the end of the installation)</label><input id="ls-code" value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="off" />
          <span className="hint">To see it again on the server: Start menu → "Access Monitoring Tool - setup code".</span></div>}
        <div className="field"><label htmlFor="ls-name">Hotel name (optional)</label><input id="ls-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hotel La Falaise" /></div>
        <div className="field"><label htmlFor="ls-u">Visionline user</label><input id="ls-u" value={u} autoComplete="username" maxLength={100} onChange={(e) => setU(e.target.value)} required /></div>
        <div className="field"><label htmlFor="ls-p">Visionline password</label><input id="ls-p" type="password" value={p} autoComplete="current-password" onChange={(e) => setP(e.target.value)} required />
          <span className="hint">Encrypted in this browser for the connector on this server: the portal never sees or keeps it.</span></div>
        <ErrorNote error={error} />
        {step && !done && <p className="small" role="status">{step}</p>}
        {done ? <p className="badge ok" role="status">Connected. Opening the portal…</p>
          : <button className="btn primary" disabled={Boolean(step) || !u.trim() || !p || !code.trim()}>{step ? 'Connecting…' : 'Connect'}</button>}
        <p className="small muted" style={{ marginBottom: 0 }}>Version {info.version}. The portal opens without signing in on this hotel's network.</p>
      </form>
    </div>
  );
}
