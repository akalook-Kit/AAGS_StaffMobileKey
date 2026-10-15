import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useHotel } from '../App';
import { ErrorNote, PageHead, useApi } from '../ui';
import { DataTable, Lines, NoData, SERIES } from '../components/charts';

/**
 * Monitoring (2.7): open alerts, doors online/offline, watched (VIP) doors, system health (database size, disk space,
 * connector, backups) and the messages sent. Everything refreshes by itself every 30 seconds.
 */
const TABS = [{ id: 'alerts', l: 'Alerts' }, { id: 'doors', l: 'Doors online / offline' }, { id: 'vip', l: 'Watched doors (VIP)' }, { id: 'system', l: 'System health' }, { id: 'messages', l: 'Messages sent' }] as const;
const SEV = { critical: 'Critical', warning: 'Warning', info: 'Notice' } as const;
const MODE = { first_daily: 'First entrance each day', first_once: 'First entrance only, then stop', every: 'Every entrance' } as const;
const GB = 1024 ** 3, MB = 1024 ** 2;
const gb = (b: number) => `${(b / GB).toFixed(1)} GB`;
const mb = (b: number) => (b >= GB ? `${(b / GB).toFixed(2)} GB` : b >= MB ? `${Math.round(b / MB)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`);

export function MonitoringPage() {
  const { base, can } = useHotel();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') ?? 'alerts') as (typeof TABS)[number]['id'];
  const m = useApi<any>(`${base}/monitoring`, [], 30_000);
  const d = m.data;
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const tz = d?.timeZone;
  const t = (v: string | null) => (v ? new Date(v).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }) : '—');
  const checkNow = async () => { setBusy(true); setError(null); try { await api(`${base}/monitoring/check`, { body: {} }); await m.reload(); } catch (e) { setError(e); } finally { setBusy(false); } };
  const ack = async (id: string) => { try { await api(`${base}/monitoring/alerts/${id}/acknowledge`, { body: {} }); await m.reload(); } catch (e) { setError(e); } };

  return (
    <>
      <PageHead title="Monitoring" intro="Doors that lose contact, watched (VIP) doors, lock alarms, and the health of the server, database and connector. Alerts go by e-mail and SMS to the people set in Settings → Alerts & notifications.">
        {can('alerts.manage') && <button className="btn" onClick={checkNow} disabled={busy}>{busy ? 'Checking…' : 'Check now'}</button>}
      </PageHead>
      <ErrorNote error={error ?? m.error} />
      {d && (
        <div className="mon-tiles">
          <button className={`mon-tile ${d.counts.critical ? 'bad' : 'ok'}`} onClick={() => setSp({ tab: 'alerts' })}><strong>{d.counts.critical}</strong><span>critical alerts</span></button>
          <button className={`mon-tile ${d.counts.warning ? 'warn' : 'ok'}`} onClick={() => setSp({ tab: 'alerts' })}><strong>{d.counts.warning}</strong><span>warnings</span></button>
          <button className={`mon-tile ${d.doors.offline ? 'bad' : d.doors.total ? 'ok' : ''}`} onClick={() => setSp({ tab: 'doors' })}><strong>{d.doors.total ? `${d.doors.online}/${d.doors.total}` : '—'}</strong><span>{d.doors.total ? `doors in contact${d.doors.offline ? ` · ${d.doors.offline} offline` : ''}` : 'no lock has reported yet'}</span></button>
          {d.system.disks.slice(0, 1).map((k: any, i: number) => <button key={i} className={`mon-tile ${k.low ? 'bad' : 'ok'}`} onClick={() => setSp({ tab: 'system' })}><strong>{k.free != null ? gb(k.free) : '?'}</strong><span>free on {k.where.split(' on ')[0]} (limit {d.thresholds.diskMinFreeGb} GB)</span></button>)}
          <button className={`mon-tile ${d.system.database.over ? 'warn' : 'ok'}`} onClick={() => setSp({ tab: 'system' })}><strong>{mb(d.system.database.bytes)}</strong><span>database (limit {d.thresholds.dbMaxMb} MB)</span></button>
        </div>
      )}
      <div className="seg" role="tablist" style={{ margin: '4px 0 14px', flexWrap: 'wrap' }}>
        {TABS.map((x) => <button key={x.id} role="tab" aria-pressed={tab === x.id} onClick={() => setSp({ tab: x.id })}>{x.l}</button>)}
      </div>
      {!d ? null : tab === 'alerts' ? <Alerts d={d} t={t} ack={ack} canAck={can('alerts.manage')} />
        : tab === 'doors' ? <Doors d={d} t={t} />
        : tab === 'vip' ? <Vip d={d} t={t} reload={m.reload} />
        : tab === 'system' ? <System d={d} t={t} />
        : <Messages d={d} t={t} />}
    </>
  );
}

function Alerts({ d, t, ack, canAck }: { d: any; t: (v: string | null) => string; ack: (id: string) => void; canAck: boolean }) {
  if (!d.alerts.length) return <div className="panel"><NoData text="No open alerts" hint="Everything is quiet. Checked every minute." /></div>;
  return (
    <div className="panel" style={{ padding: 0 }}>
      <table className="grid mon-alerts"><thead><tr><th>Severity</th><th>Alert</th><th>Since</th><th>Told</th><th /></tr></thead><tbody>
        {d.alerts.map((a: any) => (
          <tr key={a.id} className={a.severity}>
            <td><span className={`sev ${a.severity}`}>{SEV[a.severity as keyof typeof SEV]}</span></td>
            <td><strong>{a.title}</strong>{a.detail && <div className="small muted">{a.detail}</div>}</td>
            <td className="nowrap">{t(a.opened_at)}</td>
            <td className="small muted">{a.notified_at ? `by e-mail/SMS ${t(a.notified_at)}` : 'not sent'}{a.acknowledged_at && <div>Seen by {a.acknowledged_by} {t(a.acknowledged_at)}</div>}</td>
            <td style={{ textAlign: 'right' }}>{canAck && !a.acknowledged_at && <button className="btn small" onClick={() => ack(a.id)}>Mark as seen</button>}</td>
          </tr>
        ))}
      </tbody></table>
      <p className="small muted" style={{ padding: '8px 14px' }}>Alerts close by themselves when the problem is gone. "Mark as seen" records who is handling it; a disk or connector alert stays red until it is fixed.</p>
    </div>
  );
}

function Doors({ d, t }: { d: any; t: (v: string | null) => string }) {
  const [show, setShow] = useState<'offline' | 'all'>('offline');
  const s = d.doors.settings;
  const list = d.doors.list.filter((x: any) => show === 'all' || x.state === 'offline');
  return (
    <>
      {!d.doors.watching && <div className="alert warn">The connector's Visionline watch is not running, so door contact cannot be followed right now (silence is not counted as offline while the watch is off).</div>}
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <p className="small muted" style={{ margin: 0, maxWidth: '70ch' }}>A door is <b>offline</b> when its lock reports an offline event{s.offlineEventCodes.length ? ` (${s.offlineEventCodes.join(', ')})` : ''}, Visionline raises a "{s.alarmKeywords.slice(0, 2).join('" / "')}" alarm, or a lock that usually reports (at least {s.minEvents} times in {s.learnDays} days) has been silent for {s.silentHours} hours. Quiet doors stay "unknown" instead of raising false alarms.</p>
          <div className="seg"><button aria-pressed={show === 'offline'} onClick={() => setShow('offline')}>Offline ({d.doors.offline})</button><button aria-pressed={show === 'all'} onClick={() => setShow('all')}>All ({d.doors.total})</button></div>
        </div>
        {!d.doors.total ? <NoData text="No lock has reported yet" hint="Doors appear as their locks send events to Visionline. Still looking." />
          : !list.length ? <NoData text="No door is offline" hint="All locks that usually report are in contact. Checked every minute." />
          : <DataTable head={['Door', 'Group', 'State', 'Last contact', 'Why']} rows={list.map((x: any) => [x.name, x.group ?? '—', <span key="s" className={`door-state ${x.state}`}>{x.state === 'online' ? 'In contact' : x.state === 'offline' ? 'Offline' : 'Unknown'}</span>, t(x.last_event_at), x.reason ?? ''])} />}
      </div>
    </>
  );
}

function Vip({ d, t, reload }: { d: any; t: (v: string | null) => string; reload: () => void }) {
  const { base, can } = useHotel();
  const doors = useApi<any[]>(`${base}/resources?kind=door`);
  const [f, setF] = useState({ doorId: '', label: '', mode: 'first_daily' as keyof typeof MODE });
  const [error, setError] = useState<unknown>(null);
  const add = async () => { setError(null); try { await api(`${base}/monitoring/watched-doors`, { body: f }); setF({ doorId: '', label: '', mode: 'first_daily' }); reload(); } catch (e) { setError(e); } };
  const toggle = async (w: any) => { try { await api(`${base}/monitoring/watched-doors/${w.id}`, { method: 'PUT', body: { doorId: w.door_id, label: w.label, mode: w.mode, active: !w.active, watchUntil: w.watch_until } }); reload(); } catch (e) { setError(e); } };
  const remove = async (w: any) => { if (!confirm(`Stop watching ${w.label}?`)) return; try { await api(`${base}/monitoring/watched-doors/${w.id}`, { method: 'DELETE' }); reload(); } catch (e) { setError(e); } };
  return (
    <>
      <ErrorNote error={error} />
      <div className="panel">
        <h2>Watched doors</h2>
        <p className="small muted">The first entrance at a watched door (a VIP room, a suite, the cash office) is highlighted here and in the Event log, and announced by e-mail/SMS to the contacts for "Watched doors (VIP)".</p>
        {!d.watched.length ? <NoData text="No watched doors yet" hint="Add one below." /> : (
          <table className="grid"><thead><tr><th>Door</th><th>Label</th><th>Announce</th><th>Last entrance</th><th>Alerts (7 days)</th><th /></tr></thead><tbody>
            {d.watched.map((w: any) => (
              <tr key={w.id} className={w.active ? 'vip-row' : 'muted'}>
                <td><span className="vip-star" aria-hidden>★</span> {w.door_name}</td><td>{w.label}</td><td className="small">{MODE[w.mode as keyof typeof MODE]}{w.active ? '' : ' · paused'}</td>
                <td>{w.last_entrance_at ? t(w.last_entrance_at) : <span className="muted">none yet</span>}</td><td>{w.alerts_7d}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{can('alerts.manage') && <><button className="btn small" onClick={() => toggle(w)}>{w.active ? 'Pause' : 'Resume'}</button> <button className="btn small ghost" onClick={() => remove(w)}>Remove</button></>}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>
      {can('alerts.manage') && (
        <div className="panel">
          <h2>Watch a door</h2>
          <div className="field-row">
            <div className="field"><label htmlFor="wd">Door</label><select id="wd" value={f.doorId} onChange={(e) => setF({ ...f, doorId: e.target.value, label: f.label || `VIP ${(doors.data ?? []).find((x: any) => x.externalId === e.target.value || x.external_id === e.target.value)?.name ?? ''}`.trim() })}>
              <option value="">Choose a door…</option>{(doors.data ?? []).map((x: any) => <option key={x.externalId ?? x.external_id} value={x.externalId ?? x.external_id}>{x.name}</option>)}</select></div>
            <div className="field"><label htmlFor="wl">Label</label><input id="wl" value={f.label} maxLength={80} placeholder="e.g. VIP - Presidential Suite" onChange={(e) => setF({ ...f, label: e.target.value })} /></div>
            <div className="field"><label htmlFor="wm">Announce</label><select id="wm" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as any })}>{Object.entries(MODE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          </div>
          <button className="btn primary" disabled={!f.doorId || f.label.trim().length < 2} onClick={add}>Watch this door</button>
          <p className="small muted">Entrances come from the locks through the connector's Visionline watch (entrance codes in Settings → Event log).</p>
        </div>
      )}
    </>
  );
}

function System({ d, t }: { d: any; t: (v: string | null) => string }) {
  const s = d.system;
  const pct = Math.min(100, Math.round((s.database.bytes / s.database.limitBytes) * 100));
  return (
    <div className="grid12">
      <section className="vizcard span-6"><header><div><h2>Database</h2><p>{mb(s.database.bytes)} of the {mb(s.database.limitBytes)} limit</p></div></header>
        <div className="vizbody">
          <div className={`meter ${s.database.over ? 'warn' : ''}`} role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Database size against the limit"><i style={{ width: `${pct}%` }} /></div>
          <p className="small">{s.database.over ? <b>Above the limit.</b> : `${pct}% of the limit.`} Make a copy at any time on the server: <code>database-tools.ps1 -Action Copy</code>.</p>
          <DataTable head={['Largest tables', 'Size', 'Rows']} numeric={[1, 2]} rows={s.database.tables.map((x: any) => [x.name, mb(x.bytes), x.rows.toLocaleString()])} />
        </div></section>
      <section className="vizcard span-6"><header><div><h2>Disk space</h2><p>Alert below {d.thresholds.diskMinFreeGb} GB free</p></div></header>
        <div className="vizbody">
          {s.disks.map((k: any, i: number) => (
            <div key={i} className={`disk ${k.low ? 'low' : ''}`}>
              <div className="row" style={{ justifyContent: 'space-between' }}><strong>{k.role}</strong><span className={k.low ? 'sev critical' : 'sev ok'}>{k.low ? 'LOW' : 'OK'}</span></div>
              <div className="small muted">{k.where}{k.at ? ` · reported ${t(k.at)}` : ''}</div>
              {k.free != null ? <><div className={`meter ${k.low ? 'bad' : ''}`}><i style={{ width: `${Math.round(((k.total - k.free) / Math.max(1, k.total)) * 100)}%` }} /></div><div className="small">{gb(k.free)} free of {gb(k.total)}</div></> : <div className="small">Could not read: {k.error}</div>}
            </div>
          ))}
        </div></section>
      <section className="vizcard span-6"><header><div><h2>Database size and free disk over 30 days</h2><p>Sampled every hour</p></div></header>
        <div className="vizbody">
          <Lines points={s.trend.map((x: any) => ({ t: String(x.day).slice(0, 10), values: [Math.round(x.db / MB)] }))} series={[{ name: 'Database (MB)', color: SERIES[0] }]} height={160} label={(v) => new Date(`${v}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} />
        </div></section>
      <section className="vizcard span-6"><header><div><h2>Connector and backups</h2></div></header>
        <div className="vizbody">
          {s.connectors.length ? s.connectors.map((c: any, i: number) => (
            <div key={i} className="disk"><div className="row" style={{ justifyContent: 'space-between' }}><strong>{c.name}</strong><span className={c.online ? 'sev ok' : 'sev critical'}>{c.online ? 'Online' : 'OFFLINE'}</span></div>
              <div className="small muted">Version {c.version ?? '?'} · Visionline {c.visionline == null ? '?' : c.visionline ? 'reachable' : 'NOT reachable'} · last seen {t(c.lastSeenAt)}</div>
              <div className="small muted">{c.watch ?? ''}</div></div>
          )) : <NoData text="No connector registered" hint="Connector health shows how to add one." />}
          <div className="disk"><strong>Database backups</strong>
            <div className="small muted">{s.backup ? (s.backup.failed ? <b className="bad-text">Last backup FAILED: {s.backup.last}</b> : `Last good backup ${s.backup.lastOkAt ?? 'unknown'}`) : 'Shown on the on-premises server (daily at 02:30). Copy now: database-tools.ps1 -Action Copy'}</div></div>
        </div></section>
    </div>
  );
}

function Messages({ d, t }: { d: any; t: (v: string | null) => string }) {
  const ch = d.channels;
  return (
    <div className="panel">
      <p className="small">E-mail: <b>{ch.email ? 'on' : 'off'}</b>{ch.email && !ch.emailPassword ? ' (no mail password set on the server)' : ''} · SMS: <b>{ch.sms ? `on (${ch.smsProvider})` : 'off'}</b>{ch.sms && !ch.smsKey ? ' (no SMS key set on the server)' : ''} · <Link to="/settings?tab=alerts">Settings → Alerts & notifications</Link></p>
      {!d.messages.length ? <NoData text="No messages sent yet" hint="They appear here as alerts are announced." />
        : <DataTable head={['Sent', 'Channel', 'To', 'Message', 'Result']} rows={d.messages.map((x: any) => [t(x.sent_at), x.channel === 'sms' ? 'SMS' : 'E-mail', x.recipient, x.subject, x.status === 'sent' ? 'Sent' : <span key="e" className="bad-text">Failed: {x.error}</span>])} />}
    </div>
  );
}
