import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useHotel } from '../App';
import { Drawer, ErrorNote, PageHead, Status, fmt, useApi } from '../ui';
import { IssueKey } from '../components/IssueKey';
import { DoorMap, type DoorRes } from '../components/DoorMap';

const FILTERS = [
  { id: 'live', label: 'Live', status: 'SCHEDULED,QUEUED,ISSUING,ISSUED,REVOKING' },
  { id: 'approval', label: 'Awaiting approval', status: 'PENDING_APPROVAL' },
  { id: 'problems', label: 'Needs attention', status: 'FAILED' },
  { id: 'all', label: 'All', status: '' },
];

export function KeysPage() {
  const { base, can } = useHotel();
  const { keyId } = useParams();
  const nav = useNavigate();
  const [filter, setFilter] = useState('live');
  const [issuing, setIssuing] = useState(false);
  const f = FILTERS.find((x) => x.id === filter)!;
  const keys = useApi<any[]>(`${base}/keys${f.status ? `?status=${f.status}` : ''}`, [filter], 4000);
  const scopeText = (k: any) => { const n = (k.resolvedScope?.doorIds ?? k.requestedScope.resolvedDoorIds).length; return k.templateName ?? k.requestedScope?.templateName ?? `${n} ${n === 1 ? 'door' : 'doors'}`; };

  return (
    <>
      <PageHead title="Mobile keys" intro="Every staff key, from request to expiry. Open a key to see its doors and history.">
        {can('key.issue') && <button className="btn primary" onClick={() => setIssuing(true)}>Issue a key</button>}
      </PageHead>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="seg" role="group" aria-label="Filter">
          {FILTERS.map((x) => <button key={x.id} aria-pressed={filter === x.id} onClick={() => setFilter(x.id)}>{x.label}</button>)}
        </div>
      </div>
      <ErrorNote error={keys.error} />
      <div className="panel flush">
        {keys.data && !keys.data.length ? (
          <div className="empty">{filter === 'approval' ? 'Nothing is waiting for approval.' : filter === 'problems' ? 'No failed requests.' : 'No keys here yet. Issue one to a staff member whose phone is set up.'}</div>
        ) : (
          <table className="grid">
            <thead><tr><th>Staff member</th><th>Access</th><th>Status</th><th>Valid</th><th>Requested by</th></tr></thead>
            <tbody>
              {(keys.data ?? []).map((k) => (
                <tr key={k.id} className="click" onClick={() => nav(`/keys/${k.id}`)}>
                  <td><strong>{k.staffName}</strong><span className="sub">{k.jobRole}</span></td>
                  <td>{scopeText(k)}{k.isBroad && <span className="sub">Broad access</span>}</td>
                  <td><Status s={k.status} />{k.failureMessage && ['FAILED', 'ISSUED'].includes(k.status) && <span className="sub" style={{ color: 'var(--bad)' }}>{k.failureMessage}</span>}</td>
                  <td>{fmt.dt(k.startsAt)}<span className="sub">until {fmt.dt(k.expiresAt)}</span></td>
                  <td>{k.requestedBy}<span className="sub">{fmt.rel(k.createdAt)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {issuing && <IssueKey onClose={() => setIssuing(false)} onIssued={(k) => { setIssuing(false); void keys.reload(); nav(`/keys/${k.id}`); }} />}
      {keyId && <KeyDetail id={keyId} onClose={() => nav('/keys')} onChanged={keys.reload} />}
    </>
  );
}

function KeyDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { base, can, me } = useHotel();
  const nav = useNavigate();
  const [changing, setChanging] = useState(false);
  const k = useApi<any>(`${base}/keys/${id}`, [id], 3000);
  const doors = useApi<DoorRes[]>(`${base}/resources?kind=door`);
  const [error, setError] = useState<unknown>(null);
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<'checkout' | 'cancelCard'>('checkout');
  const act = async (path: string, body: unknown) => {
    setError(null);
    try { await api(`${base}/keys/${id}/${path}`, { body }); await k.reload(); onChanged(); setRevoking(false); } catch (e) { setError(e); }
  };
  const key = k.data;
  if (!key) return <Drawer title="Key" onClose={onClose}><ErrorNote error={k.error} /></Drawer>;
  const scope = key.resolvedScope?.doorIds ?? key.requestedScope.resolvedDoorIds;
  const canApprove = key.status === 'PENDING_APPROVAL' && can('key.approve_broad') && key.requestedBy !== me.displayName;
  const canRevoke = can('key.revoke') && ['PENDING_APPROVAL', 'SCHEDULED', 'QUEUED', 'ISSUING', 'ISSUED'].includes(key.status);
  const canChange = can('key.issue') && key.status === 'ISSUED' && !key.replacedByKeyId && !key.requestedScope?.uniformGroup;
  if (changing) return <IssueKey replaceKey={key} onClose={() => setChanging(false)} onIssued={(nk) => { setChanging(false); onChanged(); nav(`/keys/${nk.id}`); }} />;

  return (
    <Drawer title={`${key.staffName} · ${key.templateName ?? key.requestedScope?.templateName ?? 'custom doors'}`} onClose={onClose} footer={
      <>
        <span className="small muted">Reference {key.correlationId}</span>
        <div className="row">
          {canApprove && <><button className="btn danger" onClick={() => act('reject', {})}>Reject</button><button className="btn primary" onClick={() => act('approve', {})}>Approve</button></>}
          {canChange && !revoking && <button className="btn" onClick={() => setChanging(true)}>Change doors</button>}
          {canRevoke && !revoking && <button className="btn danger" onClick={() => setRevoking(true)}>{['ISSUING', 'ISSUED'].includes(key.status) ? 'Revoke key' : 'Cancel request'}</button>}
        </div>
      </>
    }>
      <ErrorNote error={error} />
      {key.replacedByKeyId && <div className="alert">This key was replaced by <a href={`/keys/${key.replacedByKeyId}`} onClick={(e) => { e.preventDefault(); nav(`/keys/${key.replacedByKeyId}`); }}>a new key with different doors</a>.</div>}
      {key.replacesKeyId && <div className="alert">This key replaces <a href={`/keys/${key.replacesKeyId}`} onClick={(e) => { e.preventDefault(); nav(`/keys/${key.replacesKeyId}`); }}>an earlier key</a> (Visionline override).</div>}
      {key.status === 'FAILED' && <ErrorNote error={key.failureMessage} code={key.failureCode} />}
      {key.status === 'PENDING_APPROVAL' && key.requestedBy === me.displayName && <div className="alert warn">Waiting for a Security Manager or Approver. You can’t approve your own broad-access request.</div>}
      {key.revokeRequested && key.status === 'QUEUED' && <div className="alert warn">Revocation requested. It will be sent as soon as the connector finishes issuing.</div>}
      {revoking && (
        <div className="panel">
          <div className="field"><label htmlFor="rr">Why is this key being revoked?</label><input id="rr" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: shift ended, phone lost" autoFocus /></div>
          {['ISSUING', 'ISSUED'].includes(key.status) && key.credentialId && (
            <div className="field"><label>How</label>
              <div className="seg" role="group">
                <button type="button" aria-pressed={method === 'checkout'} onClick={() => setMethod('checkout')}>Check out</button>
                <button type="button" aria-pressed={method === 'cancelCard'} onClick={() => setMethod('cancelCard')}>Cancel card in Visionline</button>
              </div>
              <span className="hint">{method === 'checkout' ? 'Checks the key out of each of its doors (Web API §7.13.5). The key leaves the phone when all are checked out.' : `Cancels card reg. no. ${key.regNo ?? '(found from the holder)'} in Visionline (§7.7.4). Locks refuse it and the key leaves the app at once. Use for a lost phone or misuse.`}</span>
            </div>
          )}
          <div className="row end"><button className="btn" onClick={() => setRevoking(false)}>Keep key</button><button className="btn danger" disabled={reason.trim().length < 3} onClick={() => act('revoke', { reason, method })}>{method === 'cancelCard' ? 'Cancel card now' : 'Revoke now'}</button></div>
        </div>
      )}
      <div className="split" style={{ gridTemplateColumns: 'minmax(0,1fr) 260px' }}>
        <div>
          <dl className="kv" style={{ marginBottom: 18 }}>
            <dt>Status</dt><dd><Status s={key.status} /> {key.vendorStatus && <span className="small muted">Credential Services: {key.vendorStatus}</span>}</dd>
            <dt>Starts</dt><dd>{fmt.dt(key.startsAt)}{key.status === 'SCHEDULED' ? ' · created in Visionline at this time' : ''}</dd>
            <dt>Ends</dt><dd>{fmt.dt(key.expiresAt)}</dd>
            <dt>Doors</dt><dd>{scope.length}{key.isBroad ? ' · broad access' : ''}{key.requestedScope?.uniformGroup ? ` · set by Visionline user group ${key.requestedScope.uniformGroup}` : ''}</dd>
            <dt>Requested by</dt><dd>{key.requestedBy}{key.reason ? ` — “${key.reason}”` : ''}</dd>
            {key.approvedBy && <><dt>{key.status === 'REJECTED' ? 'Rejected by' : 'Approved by'}</dt><dd>{key.approvedBy}</dd></>}
            {key.revokedBy && <><dt>Revoked by</dt><dd>{key.revokedBy}{key.revokeReason ? ` — “${key.revokeReason}”` : ''}</dd></>}
            {key.issuedAs && <><dt>Created in Visionline by</dt><dd className="mono">{key.issuedAs}</dd></>}
            <dt>Reg. no.</dt><dd className="mono">{key.regNo ?? '—'}<span className="small muted"> {key.regNo ? '(Visionline card registration number)' : key.credentialId ? 'not found in Visionline yet' : 'assigned by Visionline when the key is created'}</span></dd>
            <dt>Credential ID</dt><dd className="mono">{key.credentialId ?? '—'}<span className="small muted"> {key.credentialId ? '(mobile key, used for check-out and Credential Services)' : ''}</span></dd>
            {key.revokeSource && ['REVOKING', 'REVOKED'].includes(key.status) && <><dt>Ended by</dt><dd>{({ operator: 'Revoked in the portal', visionline: 'Card cancelled in Visionline', wrong_door: 'Too many wrong-door attempts (card cancelled automatically)', replaced: 'Doors changed (replaced by a new key)' } as Record<string, string>)[key.revokeSource] ?? key.revokeSource}{key.revokeMethod === 'cancelCard' ? ' · card cancelled' : key.revokeMethod === 'checkout' ? ' · checked out' : ''}</dd></>}
            {(key.wrongDoorCount > 0 || ['ISSUED'].includes(key.status)) && <><dt>Wrong-door attempts</dt><dd>{key.wrongDoorCount}</dd></>}
            <dt>First used</dt><dd>{key.firstUsedAt ? `${fmt.dt(key.firstUsedAt)} at ${key.lastUsedDoor ?? 'a door'}` : 'Not yet'}</dd>
          </dl>
          {(key.lockEvents ?? []).length > 0 && (
            <>
              <h3>Reported by Visionline</h3>
              <table className="grid" style={{ marginBottom: 16 }}>
                <thead><tr><th>Lock time (hotel)</th><th>Door</th><th>What happened</th></tr></thead>
                <tbody>{key.lockEvents.map((e: any, i: number) => (
                  <tr key={i}><td className="mono small">{fmtVl(e.event_time) ?? fmt.dt(e.received_at)}</td><td>{e.door_id ?? '—'}</td>
                    <td>{e.kind === 'card' ? ({ 0: 'Card cancelled', 2: 'Card overridden', 4: 'Card expired', 6: 'Card discarded' } as Record<number, string>)[e.card_status] ?? `Card status ${e.card_status}` : e.eventName}</td></tr>
                ))}</tbody>
              </table>
            </>
          )}
          <h3>Doors on this key</h3>
          <DoorMap doors={doors.data ?? []} doorIds={scope} groupIds={[]} readOnly />
        </div>
        <div>
          <h3>History</h3>
          <ol className="timeline">
            {(key.trail ?? []).map((t: any) => (
              <li key={t.seq}><div>{describe(t)}</div><time>{fmt.dt(t.at)}{t.actor_name ? ` · ${t.actor_name}` : ''}</time></li>
            ))}
          </ol>
        </div>
      </div>
    </Drawer>
  );
}

/** Visionline local time "YYYYMMDDTHHmm[ss]" → "2026-10-13 09:41". */
function fmtVl(v?: string | null) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(v ?? '');
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : null;
}

function describe(t: any): string {
  const d = t.details ?? {};
  switch (t.action) {
    case 'key.requested': return `Requested (${d.status === 'PENDING_APPROVAL' ? 'needs approval' : 'sent to connector'})`;
    case 'key.approved': return 'Approved';
    case 'key.rejected': return 'Rejected';
    case 'command.succeeded': return d.type === 'ISSUE_STAFF_KEY' ? 'Connector created the key in Visionline' : d.type === 'REVOKE_STAFF_KEY' ? 'Connector checked the key out in Visionline' : 'Connector finished';
    case 'command.failed': return `Connector reported a failure: ${d.error?.message ?? ''}`;
    case 'command.expired': return 'No connector response in time';
    case 'key.created_in_visionline': return `Created in Visionline: ${d.regNo ? `reg. no. ${d.regNo}, ` : ''}credential ${d.credentialId}`;
    case 'key.vendor_status': return `Credential Services: ${String(d.credentialStatus).toLowerCase().replace('_', ' ')}`;
    case 'key.first_use_at_door': return `First used at ${d.door ?? 'a door'}`;
    case 'key.revoke_requested': return `Revocation requested${d.reason ? `: ${d.reason}` : ''}`;
    case 'key.cancelled_before_issue': return 'Cancelled before it was issued';
    case 'key.expired': return 'Expired';
    case 'key.failed': return `Failed: ${d.error?.message ?? ''}`;
    case 'key.replaced': return 'Doors changed: replaced by a new key with a new reg. no.';
    case 'key.replacement_requested': return 'Change of doors requested';
    case 'key.cancelled_in_visionline': return `Card ${d.regNo} cancelled in Visionline: key revoked in the app`;
    case 'key.revoke_confirmed_by_visionline': return 'Visionline confirmed the card is cancelled';
    case 'key.overridden_in_visionline': return 'Visionline: card overridden by a newer card';
    case 'key.wrong_door_attempt': return `Refused at ${d.door ?? 'a door'} (${d.event ?? d.eventCode}) · wrong-door attempt ${d.count}`;
    case 'key.wrong_door_limit_reached': return `More than ${d.limit} wrong-door attempts: cancelling the card`;
    case 'key.card_cancelled_in_visionline': return `Card ${d.regNo} cancelled in Visionline`;
    case 'key.reconciled': return `Checked with Credential Services: ${d.vendorStatus}`;
    case 'key.schedule_released': return 'Start time reached; sent to connector';
    default: return t.action;
  }
}
