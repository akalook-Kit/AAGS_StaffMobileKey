import { useState } from 'react';
import { api, download } from '../api';
import { useHotel } from '../App';
import { ErrorNote, PageHead, fmt, useApi } from '../ui';

export function AuditPage() {
  const { base, can, hotel } = useHotel();
  const [filter, setFilter] = useState('');
  const [extra, setExtra] = useState<any[]>([]);
  const list = useApi<any[]>(`${base}/audit?limit=60${filter ? `&action=${filter}` : ''}`, [filter]);
  const [verify, setVerify] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const rows = [...(list.data ?? []), ...extra];
  const more = async () => {
    const last = rows[rows.length - 1];
    try { setExtra([...extra, ...(await api(`${base}/audit?limit=60&before=${last.seq}${filter ? `&action=${filter}` : ''}`))]); } catch (e) { setError(e); }
  };
  return (
    <>
      <PageHead title="Audit trail" intro="Every privileged action, in order. Records are chained by hash, so any edit or deletion is detectable.">
        <button className="btn" onClick={async () => setVerify(await api(`${base}/audit/verify`))}>Check integrity</button>
        {can('audit.export') && <button className="btn" onClick={() => download(`${base}/audit/export`, `audit-${hotel.slug}.csv`).catch(setError)}>Export CSV</button>}
      </PageHead>
      <ErrorNote error={error ?? list.error} />
      {verify && <div className={`alert ${verify.ok ? 'ok' : 'bad'}`}>{verify.ok ? `Integrity confirmed: ${verify.records} records, chain intact.` : `Integrity check FAILED at record ${verify.brokenAt}. Escalate to security.`}</div>}
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="seg" role="group" aria-label="Filter">
          {[['', 'Everything'], ['key.', 'Keys'], ['endpoint.', 'Phones'], ['staff.', 'Staff'], ['operator.', 'Operators'], ['config.', 'Settings'], ['command.', 'Connector']].map(([v, l]) => (
            <button key={v} aria-pressed={filter === v} onClick={() => { setFilter(v!); setExtra([]); }}>{l}</button>
          ))}
        </div>
      </div>
      <div className="panel flush">
        <table className="grid">
          <thead><tr><th>#</th><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.seq}>
                <td className="tag-num">{r.seq}</td>
                <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmt.dt(r.at)}</td>
                <td>{r.actor_name ?? (r.actor_type === 'vendor' ? 'ASSA ABLOY' : r.actor_type === 'system' ? 'Platform' : r.actor_type)}<span className="sub">{r.actor_type}</span></td>
                <td><code>{r.action}</code>{r.correlation_id && <span className="sub mono">{r.correlation_id.slice(0, 16)}…</span>}</td>
                <td className="small muted" style={{ maxWidth: 420 }}><Details d={r.details} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length >= 60 && <div style={{ padding: 12, textAlign: 'center' }}><button className="btn small" onClick={more}>Show older</button></div>}
      </div>
    </>
  );
}

function Details({ d }: { d: any }) {
  const entries = Object.entries(d ?? {}).filter(([, v]) => v !== null && v !== undefined).slice(0, 6);
  if (!entries.length) return null;
  return <>{entries.map(([k, v]) => <div key={k}><strong>{k}</strong>: {typeof v === 'object' ? JSON.stringify(v).slice(0, 140) : String(v)}</div>)}</>;
}
