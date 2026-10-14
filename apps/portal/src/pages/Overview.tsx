import { Link, useNavigate } from 'react-router-dom';
import { useHotel } from '../App';
import { ErrorNote, PageHead, Status, fmt, useApi } from '../ui';

export function Overview() {
  const { base, hotel, me, can } = useHotel();
  const nav = useNavigate();
  const s = useApi<any>(can('key.read') ? `${base}/summary` : null, [], 5000);
  const att = useApi<any>(`${base}/attention`, [], 15_000).data;
  const d = s.data;
  const n = (k: string) => d?.keys?.[k] ?? 0;
  const hour = new Date().getHours();
  return (
    <>
      <PageHead title={`Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, ${me.displayName.split(' ')[0]}`} intro={`What is happening with staff access at ${hotel.name} right now.`}>
        {can('key.issue') && <Link className="btn primary" to="/keys">Issue a key</Link>}
      </PageHead>
      <ErrorNote error={s.error} />
      {att && (att.battery || att.maintenance) && (
        <div className="attn">
          {att.battery && <Link to="/battery" className={att.battery.critical ? 'bad' : att.battery.low ? 'warn' : 'ok'}><strong>{att.battery.critical + att.battery.low}</strong><span>lock batteries low or critical{att.battery.critical ? ` (${att.battery.critical} critical)` : ''}{att.battery.unacknowledged ? ` · ${att.battery.unacknowledged} not acknowledged` : ''}</span></Link>}
          {att.maintenance && <Link to="/maintenance" className={att.maintenance.overdue || att.maintenance.urgent ? 'bad' : att.maintenance.unassigned ? 'warn' : 'ok'}><strong>{att.maintenance.open}</strong><span>open maintenance requests{att.maintenance.unassigned ? ` · ${att.maintenance.unassigned} unassigned` : ''}{att.maintenance.overdue ? ` · ${att.maintenance.overdue} overdue` : ''}</span></Link>}
        </div>
      )}
      {d && (
        <>
          <div className="figures">
            <div><div className="v">{n('ISSUED')}</div><div className="l">keys active now</div></div>
            <div><div className="v">{n('PENDING_APPROVAL')}</div><div className="l">waiting for approval</div></div>
            <div><div className="v">{n('QUEUED') + n('ISSUING') + n('SCHEDULED')}</div><div className="l">on the way to phones</div></div>
            <div><div className="v">{d.staff.onboarded}<span style={{ fontSize: 18, color: 'var(--ink-3)' }}>/{d.staff.total}</span></div><div className="l">staff phones set up</div></div>
          </div>
          <div className="split">
            <div className="panel flush">
              <div style={{ padding: '16px 20px 4px' }}><h2>Latest activity</h2></div>
              {d.recent.length ? (
                <table className="grid"><tbody>
                  {d.recent.map((k: any) => (
                    <tr key={k.id} className="click" onClick={() => nav(`/keys/${k.id}`)}>
                      <td><strong>{k.staffName}</strong><span className="sub">{k.templateName ?? `${k.requestedScope.resolvedDoorIds.length === 1 ? '1 door' : `${k.requestedScope.resolvedDoorIds.length} doors`}`}</span></td>
                      <td><Status s={k.status} /></td>
                      <td className="small muted" style={{ textAlign: 'right' }}>{fmt.rel(k.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody></table>
              ) : <div className="empty">No keys issued yet.</div>}
            </div>
            <div className="panel">
              <h2>Hotel connector</h2>
              {d.connector ? (
                <>
                  <p><Status s={d.connector.online ? 'ACTIVE' : 'FAILED'} label={d.connector.online ? 'Online' : 'Offline'} /> <span className="muted small">last seen {fmt.rel(d.connector.lastSeenAt)}</span></p>
                  <dl className="kv">
                    <dt>Visionline</dt><dd>{d.connector.health?.visionlineReachable ? 'Reachable' : 'Not reachable'}</dd>
                    <dt>Waiting commands</dt><dd>{d.connector.health?.queueDepth ?? 0}</dd>
                    <dt>Clock offset</dt><dd>{Math.round((d.connector.health?.clockOffsetMs ?? 0) / 1000)} s</dd>
                  </dl>
                  {!d.connector.online && <div className="alert bad" style={{ marginTop: 12 }}>Keys cannot be issued or revoked until the connector on the Visionline PC is back online. Requests made now will wait, then expire.</div>}
                </>
              ) : <p className="muted">No connector registered yet.</p>}
              {can('connector.read') && <Link to="/connector" className="small">Open connector health</Link>}
            </div>
          </div>
        </>
      )}
    </>
  );
}
