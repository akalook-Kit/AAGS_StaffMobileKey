import { useState } from 'react';
import { api, download } from '../api';
import { ErrorNote, PageHead, fmt, useApi } from '../ui';

/**
 * 2.25 Demo Hotel and testers (platform administrators): a site with made-up data that people can try, one-time
 * invitation links with access for a few days, and everything testers said with the Feedback button.
 */
export function DemoPage() {
  const d = useApi<any>('/api/v1/platform/demo');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (label: string, f: () => Promise<unknown>) => { setBusy(label); setError(null); try { await f(); await d.reload(); } catch (e) { setError(e); } finally { setBusy(null); } };
  const x = d.data;
  return (
    <>
      <PageHead title="Demo Hotel and testers" intro="Let people try the portal with made-up data, then read what they think. Testers only ever see the Demo Hotel: no real person, keycard or door, and nothing is sent to Visionline." />
      <ErrorNote error={error ?? d.error} />
      {x && !x.exists && (
        <section className="panel">
          <h2>Create the Demo Hotel</h2>
          <p>About 40 doors on three floors and back-of-house areas, 24 staff with keycards, two weeks of door events, battery alarms, an offline lock, keycard requests and a register. You become its administrator; it appears in your site list.</p>
          <button className="btn primary" disabled={Boolean(busy)} onClick={() => run('Creating the Demo Hotel…', () => api('/api/v1/platform/demo', { body: {} }))}>{busy ?? 'Create the Demo Hotel'}</button>
        </section>
      )}
      {x?.exists && (
        <>
          <Invite onDone={() => void d.reload()} />
          <section className="panel">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>Testers ({x.testers.length})</h2>
              <button className="btn" disabled={Boolean(busy)} onClick={() => { if (confirm('Put the made-up data back as it was at the start? Testers, their accounts and feedback stay.')) void run('Resetting…', () => api('/api/v1/platform/demo/reset', { body: {} })); }}>{busy === 'Resetting…' ? busy : 'Reset the sample data'}</button>
            </div>
            {!x.testers.length ? <p className="empty">No testers yet. Invite someone above.</p> : (
              <div className="table-scroll"><table className="grid" style={{ marginTop: 10 }}><thead><tr><th>Tester</th><th>State</th><th>Access until</th><th>Last sign-in</th><th>Feedback</th><th></th></tr></thead>
                <tbody>{x.testers.map((t: any) => (
                  <tr key={t.id}><td><strong>{t.name}</strong><div className="small muted">{t.email}</div></td>
                    <td><span className={`pill ${t.state === 'active' ? 'ok' : t.state === 'ended' ? '' : 'warn'}`}>{t.state === 'invited' ? `Invited (${t.days ?? 7} days once accepted)` : t.state === 'active' ? 'Testing' : 'Ended'}</span></td>
                    <td className="small">{t.accessUntil ? fmt.dt(t.accessUntil) : '—'}</td><td className="small">{t.lastSignIn ? fmt.dt(t.lastSignIn) : 'never'}</td><td>{t.feedback || '—'}</td>
                    <td>{t.state !== 'ended' && <button className="btn small" onClick={() => { if (confirm(`End ${t.name}'s test access now?`)) void run('Ending…', () => api(`/api/v1/platform/demo/testers/${t.id}/end`, { body: {} })); }}>End access</button>}</td></tr>))}</tbody></table></div>
            )}
          </section>
          <section className="panel">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>Feedback ({x.feedback.length})</h2>
              {x.feedback.length > 0 && <button className="btn" onClick={() => download('/api/v1/platform/demo/feedback.csv', 'feedback.csv')}>Export (CSV)</button>}
            </div>
            {!x.feedback.length ? <p className="empty">Nothing yet. Everyone can press Feedback at the bottom right of any page.</p> : (
              <ul className="fb-list">{x.feedback.map((f: any) => (
                <li key={f.id}><div className="small muted">{fmt.dt(f.at)} · {f.who} · {f.site}{f.page ? ` · ${f.page}` : ''}{f.rating ? ` · rated ${f.rating}/5` : ''}</div><p>{f.text}</p></li>))}</ul>
            )}
          </section>
        </>
      )}
    </>
  );
}

function Invite({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [days, setDays] = useState(7);
  const [mail, setMail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [res, setRes] = useState<any>(null);
  const invite = async () => {
    setBusy(true); setError(null); setRes(null);
    try {
      const r = await api<any>('/api/v1/platform/demo/testers', { body: { displayName: name, email, days, sendEmail: mail, portalUrl: location.origin } });
      setRes({ ...r, who: name, link: r.outsideLink ?? `${location.origin}/invite#${r.token}` });
      setName(''); setEmail(''); onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const copy = (v: string) => { try { void navigator.clipboard.writeText(v); } catch { /* ignore */ } };
  return (
    <section className="panel">
      <h2>Invite a tester</h2>
      <p className="small muted">They get a link that works once (for 72 hours) to choose a password, then access to the Demo Hotel for the number of days you choose, counted from that moment.</p>
      <div className="field-row">
        <div className="field"><label htmlFor="t-n">Name</label><input id="t-n" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></div>
        <div className="field"><label htmlFor="t-e">E-mail</label><input id="t-e" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={160} /><span className="hint">Their sign-in name. Not one that has access to a real site.</span></div>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="small muted">Access for</span>
        <div className="seg">{[1, 7, 14].map((n) => <button key={n} type="button" aria-pressed={days === n} onClick={() => setDays(n)}>{n === 1 ? '1 day' : `${n} days`}</button>)}</div>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={mail} onChange={(e) => setMail(e.target.checked)} /> Also send the link by e-mail</label>
      </div>
      <ErrorNote error={error} />
      <button className="btn primary" style={{ marginTop: 12 }} disabled={busy || name.trim().length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)} onClick={invite}>{busy ? 'Inviting…' : 'Make the invitation link'}</button>
      {res && (
        <div className="alert ok" style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          <span>Send this link to {res.who} (WhatsApp, e-mail…). It works once, within 72 hours; access then lasts {res.days} day{res.days === 1 ? '' : 's'}.{res.emailed ? ' It was also e-mailed.' : res.emailError ? ` Not e-mailed: ${res.emailError}` : ''}</span>
          <div className="copy-box"><input readOnly value={res.link} aria-label="Invitation link" onFocus={(e) => e.target.select()} /><button className="btn" onClick={() => copy(res.link)}>Copy</button></div>
          {!res.outsideLink && <span className="small">This link uses the address you are on now. For testers outside the hotel, switch on outside access first (set-tunnel-access.ps1): the link then uses your domain.</span>}
          {res.signInLink && <span className="small">Afterwards they sign in at <a href={res.signInLink}>{res.signInLink}</a>.</span>}
        </div>
      )}
    </section>
  );
}
