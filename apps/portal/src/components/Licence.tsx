import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useHotel } from '../App';
import { api } from '../api';
import { ErrorNote, useApi } from '../ui';

const STATE: Record<string, { label: string; tone: string }> = {
  licensed: { label: 'Licensed', tone: 'ok' }, trial: { label: 'Trial', tone: 'warn' }, grace: { label: 'Ending — grace period', tone: 'warn' },
  expired: { label: 'Ended', tone: 'bad' }, mismatch: { label: 'Licence for another hotel', tone: 'bad' },
};
const d = (v?: string | null) => (v ? new Date(v.length === 10 ? `${v}T12:00:00Z` : v).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

/** Settings → Licence: what the hotel may use, until when, and where to enter a new key. */
export function LicencePanel() {
  const { base, can } = useHotel();
  const s = useApi<any>(`${base}/licence`);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const x = s.data;
  const save = async () => {
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await api<any>(`${base}/licence`, { method: 'PUT', body: { key } });
      setKey(''); await s.reload();
      setMsg(`Licence ${r.licence?.id} installed.${r.switchedOff?.length ? ` Switched off (not in the licence): ${r.switchedOff.join(', ')}.` : ''}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const readFile = async (f: File | undefined) => { if (f) setKey((await f.text()).trim()); };
  if (!x) return <div className="panel"><p className="muted">{s.error ?? 'Loading…'}</p></div>;
  const st = STATE[x.state] ?? { label: x.state, tone: '' };
  return (
    <div className="cols">
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Licence</h2>
          <span className={`pill ${st.tone}`}>{st.label}</span>
        </div>
        {!x.enforced && <p className="muted small">Licences are not checked on this server (hosted or test installation).</p>}
        <dl className="kv" style={{ margin: "12px 0 16px" }}>
          {x.licence ? <>
            <dt>Licensed to</dt><dd>{x.licence.customer}</dd>
            <dt>Hotel</dt><dd>{x.licence.hotel}</dd>
            <dt>Licence number</dt><dd><code>{x.licence.id}</code></dd>
            <dt>Valid until</dt><dd>{x.licence.expires ? `${d(x.licence.expires)} (${x.daysLeft >= 0 ? `${x.daysLeft} days left` : 'ended'})` : 'No end date'}</dd>
            {x.licence.support && <><dt>Support and updates until</dt><dd>{d(x.licence.support)}</dd></>}
            {x.licence.systemId && <><dt>ASSA ABLOY System ID</dt><dd>{x.licence.systemId}</dd></>}
            <dt>Installed</dt><dd>{d(x.licence.installedAt)}</dd>
          </> : <>
            <dt>Trial</dt><dd>{x.daysLeft >= 0 ? `${x.daysLeft} days left (until ${d(x.trialEnds)})` : `ended ${d(x.trialEnds)}`}</dd>
          </>}
          <dt>Installation ID</dt><dd><code>{x.installationId}</code></dd>
        </dl>
        <h3>Modules</h3>
        <ul className="checks">
          {Object.entries(x.moduleNames as Record<string, string>).map(([k, label]) => (
            <li key={k} className={x.modules.includes(k) ? 'yes' : 'no'}>{label}{!x.modules.includes(k) && <span className="muted small"> — not included</span>}</li>
          ))}
          <li className="yes">Visionline data, Insights, Event log, Monitoring, Audit trail <span className="muted small">— always included</span></li>
        </ul>
      </div>
      <div className="panel">
        <h2>Enter a licence key</h2>
        <p className="muted small">Your supplier sends the key as text (starting with <code>SMK1.</code>) or as a <code>.smklic</code> file. Send them the hotel name, the ASSA ABLOY System ID and the installation ID shown here.</p>
        {can('settings.manage') ? <>
          <label className="field"><span>Licence key</span>
            <textarea rows={6} value={key} onChange={(e) => setKey(e.target.value)} placeholder="SMK1.…" spellCheck={false} style={{ fontFamily: 'var(--mono, monospace)', fontSize: 12 }} />
          </label>
          <div className="row">
            <label className="btn">Choose file… <input type="file" accept=".smklic,.txt" hidden onChange={(e) => readFile(e.target.files?.[0])} /></label>
            <button className="btn primary" disabled={busy || key.length < 20} onClick={save}>{busy ? 'Checking…' : 'Install licence'}</button>
          </div>
        </> : <p className="muted">Only hotel administrators can enter a licence.</p>}
        {msg && <div className="alert ok" style={{ marginTop: 12 }}>{msg}</div>}
        <div style={{ marginTop: 12 }}><ErrorNote error={error} /></div>
      </div>
    </div>
  );
}

/** 2.13 When the licence has ended (or belongs to another hotel), a window asks for the new key straight away. */
function LicenceModal({ x, reload }: { x: any; reload: () => void }) {
  const { base, hotel } = useHotel();
  const admin = hotel.permissions.includes('settings.manage');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [closed, setClosed] = useState(() => { try { return sessionStorage.getItem(`smk.licence-modal.${hotel.id}`) === '1'; } catch { return false; } });
  if (closed) return null;
  const close = () => { try { sessionStorage.setItem(`smk.licence-modal.${hotel.id}`, '1'); } catch { /* ignore */ } setClosed(true); };
  const save = async () => {
    setBusy(true); setError(null);
    try { await api(`${base}/licence`, { method: 'PUT', body: { key } }); close(); reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-labelledby="lic-title">
      <div className="modal">
        <h2 id="lic-title">{x.state === 'mismatch' ? 'This licence belongs to another hotel' : x.licence ? 'The licence has ended' : 'The trial has ended'}</h2>
        <p>Changes are paused until a licence key is entered. Keys can still be revoked, reports read and people signed in; doors in Visionline are not affected.</p>
        {admin ? <>
          <label className="field"><span>Licence key from your supplier</span>
            <textarea rows={5} value={key} onChange={(e) => setKey(e.target.value)} placeholder="SMK1.…" spellCheck={false} style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }} /></label>
          <p className="muted small">Installation ID <code>{x.installationId}</code>{x.systemId ? <> · ASSA ABLOY System ID <code>{x.systemId}</code></> : null}: send these to your supplier.</p>
          <ErrorNote error={error} />
          <div className="row end">
            <label className="btn">Choose file… <input type="file" accept=".smklic,.txt" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setKey((await f.text()).trim()); }} /></label>
            <button className="btn" onClick={close}>Later</button>
            <button className="btn primary" disabled={busy || key.length < 20} onClick={save}>{busy ? 'Checking…' : 'Install licence'}</button>
          </div>
        </> : <div className="row end"><span className="muted small" style={{ marginRight: 'auto' }}>Ask a hotel administrator to enter the new licence.</span><button className="btn primary" onClick={close}>OK</button></div>}
      </div>
    </div>
  );
}

/** Band at the top of every page when the trial or licence needs attention. */
export function LicenceBanner() {
  const { base, hotel } = useHotel();
  const ok = hotel.permissions.includes('resources.read') || hotel.permissions.includes('breakfast.read');
  const s = useApi<any>(ok ? `${base}/licence` : null, [hotel.id], 300_000);
  const x = s.data;
  if (!x?.enforced) return null;
  if (x.state === 'expired' || x.state === 'mismatch') return <><LicenceModal x={x} reload={s.reload} />{band(x, hotel)}</>;
  const soon = (x.state === 'trial' || x.state === 'licensed') && x.daysLeft !== null && x.daysLeft <= 14;
  if (!soon && !['grace', 'expired', 'mismatch'].includes(x.state)) return null;
  return band(x, hotel);
}
function band(x: any, hotel: any) {
  const text = x.state === 'expired' ? 'The licence has ended: changes are paused (keys can still be revoked).'
    : x.state === 'mismatch' ? 'This licence belongs to another hotel.'
      : x.state === 'grace' ? `The ${x.licence ? 'licence' : 'trial'} has ended; changes will pause in a few days.`
        : `The ${x.licence ? 'licence' : 'trial'} ends in ${x.daysLeft} day${x.daysLeft === 1 ? '' : 's'}.`;
  return (
    <div className={`sys-banner no-print ${x.state === 'expired' || x.state === 'mismatch' ? '' : 'warn'}`} role="status">
      <strong>Licence</strong><span>{text}</span>{hotel.permissions.includes('settings.manage') && <NavLink to="/settings?tab=licence">Enter a licence →</NavLink>}
    </div>
  );
}
