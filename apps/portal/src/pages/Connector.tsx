import { useState } from 'react';
import { api } from '../api';
import { useHotel } from '../App';
import { ErrorNote, PageHead, Status, fmt, useApi, waitForCommand } from '../ui';

/** Connector health and the guided Visionline readiness checklist (spec §12.1.1, §13.4.5). */
export function ConnectorPage() {
  const { base, hotel, can } = useHotel();
  const ready = useApi<any>(`${base}/readiness`, [], 5000);
  const conns = useApi<any>(`${base}/connectors`, [], 5000);
  const res = useApi<any[]>(`${base}/resources`, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [name, setName] = useState('Visionline PC');

  const run = async (label: string, path: string) => {
    setBusy(label); setMsg(null);
    try {
      const { commandId } = await api(`${base}/${path}`, { body: {} });
      const c = await waitForCommand(hotel.id, commandId);
      if (c.status === 'SUCCEEDED') setMsg({ tone: 'ok', text: label === 'discover' ? `Discovery finished: ${c.result.resources.length} items read from Visionline.` : 'Visionline connection test passed.' });
      else setMsg({ tone: 'bad', text: `${c.error?.message ?? c.status}` });
      await Promise.all([ready.reload(), res.reload()]);
    } catch (e) { setMsg({ tone: 'bad', text: (e as Error).message }); } finally { setBusy(null); }
  };
  const register = async () => {
    try { const r = await api(`${base}/connectors`, { body: { name } }); setToken(r.token); await conns.reload(); } catch (e) { setMsg({ tone: 'bad', text: (e as Error).message }); }
  };
  const checks = ready.data?.checks ?? [];
  const okCount = checks.filter((c: any) => c.ok).length;
  const kinds = (k: string) => (res.data ?? []).filter((r) => r.kind === k && r.active);

  return (
    <>
      <PageHead title="Connector health" intro="The connector runs on the Visionline PC and connects out to this platform. Visionline is never exposed to the internet.">
        {can('connector.manage') && <button className="btn" disabled={!!busy} onClick={() => run('validate', 'connector/validate')}>{busy === 'validate' ? 'Testing…' : 'Test Visionline connection'}</button>}
        {can('resources.discover') && <button className="btn primary" disabled={!!busy} onClick={() => run('discover', 'resources/discover')}>{busy === 'discover' ? 'Reading Visionline…' : 'Run resource discovery'}</button>}
      </PageHead>
      {msg && <div className={`alert ${msg.tone}`}>{msg.text}</div>}
      <ErrorNote error={ready.error} />
      <div className="split">
        <div>
          <div className="panel">
            <h2>Readiness · {okCount} of {checks.length} ready</h2>
            <ul className="checklist">
              {checks.map((c: any) => (
                <li key={c.id}><span className={`dot ${c.ok ? 'ok' : ''}`} aria-label={c.ok ? 'Ready' : 'Not ready'} /><div><strong>{c.label}</strong><div className="small muted">{c.detail}</div></div></li>
              ))}
            </ul>
          </div>
          <div className="panel">
            <h2>Discovered from Visionline</h2>
            <dl className="kv">
              <dt>Doors</dt><dd>{kinds('door').length} in {kinds('doorgroup').length} door groups ({kinds('doorgroup').map((g) => g.name).join(', ') || 'none'})</dd>
              <dt>User groups</dt><dd>{kinds('usergroup').map((g) => g.name).join(', ') || 'none found'}</dd>
              <dt>Time schedules</dt><dd>{kinds('timeschedule').map((g) => g.name).join(', ') || 'none'}</dd>
              <dt>Mobile access accounts</dt><dd>{kinds('mobileaccessaccount').map((g) => `${g.name} (system ${g.data.systemID})`).join(', ') || 'none'}</dd>
              <dt>Last discovery</dt><dd>{fmt.rel(kinds('door')[0]?.discovered_at)}</dd>
            </dl>
          </div>
          <div className="panel">
            <h2>Waiting for ASSA ABLOY confirmation</h2>
            <p className="small muted">The hotel has decided how each point should work; these remain to be confirmed by ASSA ABLOY for the installed Visionline version.</p>
            {(ready.data?.vendorConfirmations ?? []).map((v: any) => (
              <details key={v.id} style={{ borderTop: '1px solid var(--line-2)', padding: '8px 0' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 500 }}>{v.question}</summary>
                <p className="small" style={{ marginTop: 6 }}><strong>Documented:</strong> {v.documented}</p>
                {v.decided && <p className="small"><strong>Hotel decision:</strong> {v.decided}</p>}
                <p className="small"><strong>What the platform does:</strong> {v.implemented}</p>
              </details>
            ))}
            {(ready.data?.vendorDecisions ?? []).length > 0 && (
              <>
                <h3 style={{ marginTop: 14 }}>Settled</h3>
                <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>{ready.data.vendorDecisions.map((d: any) => <li key={d.id}>{d.decision}</li>)}</ul>
              </>
            )}
          </div>
        </div>
        <div>
          {(conns.data?.connectors ?? []).map((c: any) => (
            <div className="panel" key={c.id}>
              <h2>{c.name}</h2>
              <p><Status s={c.status !== 'ACTIVE' ? 'DELETED' : c.online ? 'ACTIVE' : 'FAILED'} label={c.status !== 'ACTIVE' ? 'Disabled' : c.online ? 'Online' : 'Offline'} /> <span className="small muted">last seen {fmt.rel(c.last_seen_at)}</span></p>
              {c.health && (
                <dl className="kv" style={{ gridTemplateColumns: '130px 1fr' }}>
                  <dt>Visionline</dt><dd>{c.health.visionlineReachable ? 'Reachable' : 'Not reachable'}</dd>
                  <dt>Certificate</dt><dd>{c.health.tlsTrust}</dd>
                  <dt>Last session</dt><dd>{fmt.rel(c.health.lastSuccessfulSessionAt)}</dd>
                  <dt>Queue</dt><dd>{c.health.queueDepth} waiting, {c.health.inFlight} in progress</dd>
                  <dt>Clock offset</dt><dd>{Math.round(c.health.clockOffsetMs / 1000)} s</dd>
                  <dt>Visionline watch</dt><dd>{c.health.visionlineWatch ?? 'Not available (update the connector)'}</dd>
                  <dt>Battery events</dt><dd>{(c.health.capabilities ?? []).includes('battery-events') ? 'Read with the watch' : 'No (connector 0.5.0+ with the watch on)'}</dd>
                  {c.health.readOnly && <><dt>Mode</dt><dd><Status s="QUEUED" label="Read-only: will not issue or revoke" /></dd></>}
                  <dt>Version</dt><dd>{c.health.connectorVersion}</dd>
                  <dt>Last error</dt><dd>{c.health.lastError ?? 'None'}</dd>
                </dl>
              )}
              {!c.installation_uuid && <p className="small muted">Waiting for the connector to sign in with its token.</p>}
            </div>
          ))}
          <div className="panel">
            <h2>Command queue</h2>
            <dl className="kv" style={{ gridTemplateColumns: '170px 1fr' }}>
              <dt>Waiting</dt><dd>{conns.data?.queue?.pending ?? 0}</dd>
              <dt>Being processed</dt><dd>{conns.data?.queue?.leased ?? 0}</dd>
              <dt>Expired (24 h)</dt><dd>{conns.data?.queue?.expired24h ?? 0}</dd>
              <dt>Failed (24 h)</dt><dd>{conns.data?.queue?.failed24h ?? 0}</dd>
              <dt>Vendor callbacks</dt><dd>{conns.data?.callbacks?.ok ? 'Registered' : conns.data?.callbacks?.error ?? 'Not registered yet'}</dd>
            </dl>
          </div>
          {can('connector.manage') && (
            <div className="panel">
              <h2>Register a connector</h2>
              {token ? (
                <>
                  <p className="small">Copy this token now. The connector installer (install.ps1) asks for it; you can also paste it on the connector status page (http://127.0.0.1:8090 on the Visionline PC). It will not be shown again.</p>
                  <div className="token-box">{token}</div>
                  <div className="row" style={{ marginTop: 10 }}><button className="btn small" onClick={() => navigator.clipboard?.writeText(token)}>Copy token</button><button className="btn small" onClick={() => setToken(null)}>Done</button></div>
                </>
              ) : (
                <>
                  <div className="field"><label htmlFor="cn">Name</label><input id="cn" value={name} onChange={(e) => setName(e.target.value)} /></div>
                  <button className="btn" onClick={register}>Create token</button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
