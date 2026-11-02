import { useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api';
import { ErrorNote } from '../ui';

/**
 * 2.13 Sensitive actions (starting or confirming an emergency) ask for the password again, and the two-step code
 * when it is on. The proof is kept in memory only, for the few minutes the server allows.
 */
let proof: { token: string; until: number } | null = null;

export function useReauth(): [(run: (token: string) => Promise<unknown>) => Promise<void>, ReactNode] {
  const [ask, setAsk] = useState<null | { why: string }>(null);
  const pending = useRef<((t: string | null) => void) | null>(null);
  const get = () => new Promise<string | null>((resolve) => { pending.current = resolve; setAsk({ why: '' }); });
  const withReauth = async (run: (token: string) => Promise<unknown>) => {
    let t = proof && proof.until > Date.now() + 10_000 ? proof.token : await get();
    if (!t) return;
    try { await run(t); }
    catch (e) {
      if (e instanceof ApiError && e.code === 'REAUTH_REQUIRED') { proof = null; t = await get(); if (t) await run(t); return; }
      throw e;
    }
  };
  const dialog = ask ? <ReauthDialog onDone={(t) => { setAsk(null); pending.current?.(t); pending.current = null; }} /> : null;
  return [withReauth, dialog];
}

function ReauthDialog({ onDone }: { onDone: (token: string | null) => void }) {
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ token: string; minutes: number }>('/api/v1/me/reauth', { body: { password: pw, ...(code ? { code } : {}) } });
      proof = { token: r.token, until: Date.now() + r.minutes * 60_000 };
      onDone(r.token);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CODE_REQUIRED') setNeedCode(true); else setError(e);
    } finally { setBusy(false); }
  };
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(null); }}>
      <form className="modal" role="dialog" aria-modal="true" aria-label="Confirm it is you" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <h2>Confirm it is you</h2>
        <p className="muted">This action is recorded with your name. Enter your password{needCode ? ' and the code from your authenticator app' : ''}.</p>
        <label className="field"><span>Password</span><input type="password" autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        {needCode && <label className="field"><span>Two-step code</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>}
        <ErrorNote error={error} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="btn" onClick={() => onDone(null)}>Cancel</button>
          <button className="btn primary" disabled={!pw || busy || (needCode && code.length < 6)}>Confirm</button>
        </div>
      </form>
    </div>
  );
}
