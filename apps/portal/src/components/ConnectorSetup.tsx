import { useState } from 'react';
import { api } from '../api';
import { useHotel } from '../App';
import { ErrorNote, Status, fmt, useApi } from '../ui';

/**
 * 2.16 Settings → Connector: the connector on this server (as installed) or on another computer of the network.
 * For another computer the page writes the commands with the addresses filled in. Nothing here is a secret: the
 * connector token is shown once when it is made, and passwords are never part of a command.
 */
type Setup = { location: 'server' | 'remote'; computerAddress?: string | null; serverUrl?: string | null; visionlineUrl?: string | null };

function Cmd({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cmd-box">
      <code aria-label={label}>{text}</code>
      <button type="button" className="btn small" onClick={() => { void navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

export function ConnectorSetupEditor({ data, set }: { data: any; set: (patch: any) => void }) {
  const s: Setup = { location: 'server', computerAddress: '', serverUrl: '', visionlineUrl: '', ...(data.connectorSetup ?? {}) };
  const up = (patch: Partial<Setup>) => set({ connectorSetup: { ...s, ...patch } });
  const guessServer = /^https:/.test(location.origin) && !/localhost|127\.0\.0\.1/.test(location.host) ? location.origin : '';
  const serverUrl = (s.serverUrl || guessServer || 'https://<this server>:8443').replace(/\/$/, '');
  const vl = (s.visionlineUrl || 'https://<Visionline server>/api/v1').replace(/\/$/, '');
  const pc = s.computerAddress || '<connector computer address>';
  const vlHost = (() => { try { return new URL(vl).host; } catch { return '<Visionline server>'; } })();
  return (
    <>
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>Where does the connector run?</legend>
        <label className="check"><input type="radio" name="loc" checked={s.location === 'server'} onChange={() => up({ location: 'server' })} />
          <span><strong>On this server</strong><span className="hint" style={{ display: 'block' }}>Installed with Access Monitoring Tool on the Visionline server. Nothing to do here.</span></span></label>
        <label className="check"><input type="radio" name="loc" checked={s.location === 'remote'} onChange={() => up({ location: 'remote' })} />
          <span><strong>On another computer</strong><span className="hint" style={{ display: 'block' }}>Access Monitoring Tool is on one computer and the connector on another one of the same network (usually the Visionline server).</span></span></label>
      </fieldset>
      {s.location === 'remote' && (
        <>
          <div className="field-row">
            <div className="field"><label htmlFor="ca">Connector computer's address</label><input id="ca" value={s.computerAddress ?? ''} placeholder="192.168.1.50" onChange={(e) => up({ computerAddress: e.target.value.trim() || null })} />
              <span className="hint">Its IP address on the network (ipconfig on that computer). Only this address may use the connector entrance.</span></div>
            <div className="field"><label htmlFor="su">This server, as the connector computer reaches it</label><input id="su" value={s.serverUrl ?? ''} placeholder={guessServer || 'https://smk-server:8443'} onChange={(e) => up({ serverUrl: e.target.value.trim() || null })} />
              <span className="hint">The portal address used on the network (https, port 8443 unless changed).</span></div>
          </div>
          <div className="field"><label htmlFor="vu">Visionline Web API, as the connector computer reaches it</label><input id="vu" value={s.visionlineUrl ?? ''} placeholder="https://localhost/api/v1" onChange={(e) => up({ visionlineUrl: e.target.value.trim() || null })} />
            <span className="hint">https://localhost/api/v1 when the connector computer is the Visionline server; otherwise https://&lt;Visionline server&gt;/api/v1.</span></div>

          <h3 className="section-title">Steps</h3>
          <ol className="steps">
            <li><strong>On this server</strong> (PowerShell, Run as administrator): let only the connector computer in, and save this server's certificate for it.
              <Cmd label="Server command" text={`& "C:\\Program Files\\StaffMobileKey\\Platform\\set-connector-access.ps1" -Allow ${pc}`} />
              <span className="hint">If a connector was installed on this server too, add <code>-StopLocalConnector</code> so only one runs.</span></li>
            <li><strong>Copy to the connector computer</strong>: the connector package (<code>staff-mobile-key-connector-0.13.1.zip</code>, unzipped) and <code>C:\ProgramData\StaffMobileKey\Platform\gateway.cer</code> from this server. It needs Node.js 22 LTS.</li>
            <li><strong>On the connector computer</strong>, in the unzipped folder: save Visionline's certificate.
              <Cmd label="Visionline certificate" text={`.\\visionline-probe.ps1 -Url ${vl} -TlsOnly -SaveCert .\\visionline.crt`} /></li>
            <li><strong>Make a connector token</strong> (right, <em>Connectors</em>) and copy it. It is shown once.</li>
            <li><strong>Install the connector</strong> there; it asks for the token.
              <Cmd label="Install command" text={`.\\install.ps1 -PlatformUrl ${serverUrl} -PlatformCaFile .\\gateway.cer -VisionlineUrl ${vl} -CaFile .\\visionline.crt`} /></li>
            <li><strong>Check</strong>: the connector shows <em>Online</em> on the right, reporting from {pc}. Then enter the Visionline account under <em>Settings → Visionline</em>.</li>
          </ol>
          <p className="small muted">The connector only connects out: to this server ({serverUrl.replace(/^https:\/\//, '')}) and to Visionline ({vlHost}). Both certificates are checked; verification is never switched off. The connector entrance is closed to every other address and to the outside entrance.</p>
        </>
      )}
    </>
  );
}

/** Connectors known to the platform: online, where they report from, and a new token. */
export function ConnectorsAside() {
  const { base, can } = useHotel();
  const conns = useApi<any>(`${base}/connectors`, [], 5000);
  const [name, setName] = useState('Connector computer');
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const make = async () => { setError(null); try { const r = await api(`${base}/connectors`, { body: { name } }); setToken(r.token); await conns.reload(); } catch (e) { setError(e); } };
  return (
    <div className="panel">
      <h2>Connectors</h2>
      <ErrorNote error={error ?? conns.error} />
      {(conns.data?.connectors ?? []).filter((c: any) => c.status === 'ACTIVE').map((c: any) => (
        <div key={c.id} style={{ marginBottom: 10 }}>
          <strong>{c.name}</strong> <Status s={c.online ? 'ACTIVE' : 'FAILED'} label={c.online ? 'Online' : 'Offline'} />
          <div className="small muted">{c.last_address ? `Reporting from ${c.last_address.replace(/^::ffff:/, '')}` : 'Not seen yet'}{c.last_seen_at ? ` · ${fmt.rel(c.last_seen_at)}` : ''}{c.health?.connectorVersion ? ` · ${c.health.connectorVersion}` : ''}</div>
        </div>
      ))}
      {!(conns.data?.connectors ?? []).length && <p className="small muted">None yet.</p>}
      {can('connector.manage') && (token ? (
        <>
          <p className="small">Copy this token now; the connector installer asks for it. It is not shown again.</p>
          <div className="token-box">{token}</div>
          <div className="row" style={{ marginTop: 8 }}><button className="btn small" onClick={() => navigator.clipboard?.writeText(token)}>Copy token</button><button className="btn small" onClick={() => setToken(null)}>Done</button></div>
        </>
      ) : (
        <div className="row" style={{ marginTop: 8 }}>
          <input aria-label="Connector name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
          <button className="btn" onClick={make}>Make a token</button>
        </div>
      ))}
    </div>
  );
}
