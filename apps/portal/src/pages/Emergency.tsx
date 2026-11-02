import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useHotel } from '../App';
import { api } from '../api';
import { ErrorNote, PageHead, fmt, useApi } from '../ui';
import { useReauth } from '../components/Reauth';

const KIND: Record<string, string> = { fire: 'Fire', evacuation: 'Evacuation', drill: 'Drill', other: 'Other emergency' };
const STATUS: Record<string, string> = { REQUESTED: 'Waiting for confirmation', ACTIVE: 'Active', ENDED: 'Ended', CANCELLED: 'Cancelled' };

/**
 * 2.13 Emergency: start (one person) and confirm (a second person), both re-entering their password; roll call on
 * the live occupancy screen; emergency mobile keys for responders; history. Nothing here is needed to see or print
 * who is in the building: that is always available on Live occupancy.
 */
export function EmergencyPage() {
  const { base, me, can } = useHotel();
  const d = useApi<any>(`${base}/emergency`, [], 15_000);
  const [withReauth, reauthDialog] = useReauth();
  const [kind, setKind] = useState('fire');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [pick, setPick] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = (f: () => Promise<unknown>, msg: string) => async () => { setError(null); setOk(null); try { await f(); setOk(msg); await d.reload(); } catch (e) { setError(e); } };
  if (!d.data) return <><PageHead title="Emergency" /><ErrorNote error={d.error} /></>;
  const open = d.data.emergencies.find((e: any) => e.status === 'REQUESTED' || e.status === 'ACTIVE');
  const r = d.data.readiness;
  const manage = can('emergency.manage');
  const rollCount = open ? Object.values(open.roll ?? {}).filter((x: any) => x?.safe).length : 0;

  return (
    <>
      <PageHead title="Emergency" intro="Start an emergency or a drill, keep the roll call and give responders access. Who is in the building is always on Live occupancy, also without starting anything.">
        <Link className="btn primary" to="/muster">Live occupancy</Link>
      </PageHead>
      {reauthDialog}
      <ErrorNote error={error} />
      {ok && <div className="alert ok">{ok}</div>}

      {open ? (
        <div className={`panel em-panel ${open.status === 'ACTIVE' ? 'active' : ''}`}>
          <h2>{KIND[open.kind]} · {STATUS[open.status]}</h2>
          <p>{open.reason}</p>
          <dl className="kv">
            <dt>Started by</dt><dd>{open.requestedBy} · {fmt.dt(open.requestedAt)}</dd>
            <dt>Confirmed by</dt><dd>{open.confirmedBy ? `${open.confirmedBy} · ${fmt.dt(open.activatedAt)}` : 'Not yet: a second person with emergency rights confirms it here.'}</dd>
            <dt>Roll call</dt><dd>{rollCount} ticked as safe (on <Link to="/muster">Live occupancy</Link>)</dd>
          </dl>
          {manage && (
            <div className="row" style={{ marginTop: 14 }}>
              {open.status === 'REQUESTED' && open.requestedById !== me.id && (
                <button className="btn danger-solid" onClick={() => withReauth((t) => api(`${base}/emergency/${open.id}/confirm`, { body: {}, headers: { 'x-smk-reauth': t } }).then(() => { setOk('Emergency confirmed.'); return d.reload(); })).catch(setError)}>Confirm emergency</button>
              )}
              {open.status === 'REQUESTED' && open.requestedById === me.id && <span className="muted">Ask a second person (security manager, duty manager or another fire warden) to confirm it.</span>}
              <input className="search" placeholder="Note to close it (e.g. all clear from the fire brigade)" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 320 }} />
              <button className="btn" disabled={note.trim().length < 3} onClick={run(() => api(`${base}/emergency/${open.id}/end`, { body: { note } }), open.status === 'ACTIVE' ? 'Emergency ended.' : 'Request cancelled.')}>{open.status === 'ACTIVE' ? 'End emergency' : 'Cancel request'}</button>
            </div>
          )}
          {open.status === 'ACTIVE' && open.kind !== 'drill' && manage && can('key.issue') && (
            <div style={{ marginTop: 18 }}>
              <h3>Emergency mobile keys for responders</h3>
              {!r.template ? <p className="muted">Choose the emergency key template first (Settings → Safety & emergency).</p> : (
                <>
                  <p className="muted small">Template “{r.template.name}”, valid {r.keyHours} hours. The two-person confirmation counts as the approval for broad access. Only staff whose phone is set up are listed.</p>
                  <div className="menu-picks">{r.responders.map((p: any) => (
                    <label key={p.id} className="check"><input type="checkbox" checked={pick.includes(p.id)} onChange={(e) => setPick(e.target.checked ? [...pick, p.id] : pick.filter((x) => x !== p.id))} /> {p.name} <span className="muted small">{p.role}</span></label>))}
                  </div>
                  <button className="btn primary" disabled={!pick.length} onClick={run(async () => {
                    const x = await api(`${base}/emergency/${open.id}/keys`, { body: { staffIds: pick } });
                    const bad = x.results.filter((y: any) => !y.ok);
                    if (bad.length) throw new Error(`${x.results.length - bad.length} key(s) sent, ${bad.length} failed: ${bad.map((y: any) => y.error).join('; ')}`);
                  }, 'Emergency keys sent to Visionline. They appear in the phones within a minute.')}>Issue emergency keys ({pick.length})</button>
                </>
              )}
            </div>
          )}
          {open.actions?.length > 0 && <ul className="timeline" style={{ marginTop: 16 }}>{open.actions.map((a: any, i: number) => <li key={i}><time>{fmt.dt(a.at)}</time> · {a.by}: {a.what}</li>)}</ul>}
        </div>
      ) : manage ? (
        <div className="panel">
          <h2>Start an emergency or a drill</h2>
          <p className="muted">One person starts it, a second person confirms it; both re-enter their password. Use a drill to practise the roll call: no keys are issued during a drill.</p>
          <div className="row">
            <div className="seg" role="radiogroup" aria-label="Kind">
              {Object.entries(KIND).map(([k, l]) => <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}
            </div>
            <input className="search" style={{ minWidth: 320, flex: 1 }} placeholder="What is happening and where (e.g. smoke on floor 2, east wing)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn danger-solid" disabled={reason.trim().length < 3} onClick={() => withReauth((t) => api(`${base}/emergency`, { body: { kind, reason }, headers: { 'x-smk-reauth': t } }).then(() => { setReason(''); setOk('Started. A second person must confirm it.'); return d.reload(); })).catch(setError)}>{kind === 'drill' ? 'Start drill' : `Start emergency (${KIND[kind]?.toLowerCase()})`}</button>
          </div>
        </div>
      ) : <div className="panel"><p className="muted">No emergency is open.</p></div>}

      <div className="cols">
        <section className="panel">
          <h2>Readiness</h2>
          <ul className="checklist">
            <li><span className={`dot${r.emergencyCards > 0 ? ' ok' : ''}`} /><div><strong>Emergency keycards in Visionline: {r.emergencyCards}</strong><div className="small muted">Counted from the keycards read from Visionline (group or type “emergency”). Keep them in the fire box and at reception; they open every lock, also with the deadbolt on.</div></div></li>
            <li><span className={`dot${r.template ? ' ok' : ''}`} /><div><strong>Emergency key template: {r.template?.name ?? 'not chosen'}</strong><div className="small muted">Settings → Safety & emergency.</div></div></li>
            <li><span className={`dot${r.responders.length ? ' ok' : ''}`} /><div><strong>Responders with a phone ready: {r.responders.length}</strong><div className="small muted">Security, engineering and duty managers with the staff app set up.</div></div></li>
            <li><span className="dot idle" /><div><strong>Open all guest rooms remotely: not available</strong><div className="small muted">{r.remoteOpen.reason}</div></div></li>
          </ul>
        </section>
        <section className="panel">
          <h2>History</h2>
          {d.data.emergencies.length ? (
            <table className="grid"><thead><tr><th>When</th><th>Kind</th><th>Status</th><th>By</th></tr></thead>
              <tbody>{d.data.emergencies.map((e: any) => <tr key={e.id}><td>{fmt.dt(e.requestedAt)}</td><td>{KIND[e.kind]}</td><td>{STATUS[e.status]}</td><td className="small">{[e.requestedBy, e.confirmedBy].filter(Boolean).join(' + ')}</td></tr>)}</tbody></table>
          ) : <p className="empty">No emergencies or drills recorded yet.</p>}
        </section>
      </div>
    </>
  );
}
