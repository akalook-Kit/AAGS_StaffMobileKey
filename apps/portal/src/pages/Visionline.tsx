import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useHotel } from '../App';
import { ErrorNote, PageHead, fmt, useApi } from '../ui';
import { NoData } from '../components/charts';

/**
 * 2.10 What the portal has read from Visionline: keycards, people, user groups. It all arrives by itself:
 * doors and user groups every few hours, people and keycards on a schedule, and a card made at the Visionline
 * desk within seconds (live feed). Nothing here changes Visionline.
 */
const TABS = [{ id: 'cards', l: 'Keycards' }, { id: 'people', l: 'People' }, { id: 'groups', l: 'User groups' }] as const;

export function VisionlinePage() {
  const { base, can } = useHotel();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') ?? 'cards') as (typeof TABS)[number]['id'];
  const ov = useApi<any>(`${base}/visionline/overview`, [], 20_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  const d = ov.data;
  const refresh = async () => {
    setBusy(true); setError(null); setOk(null);
    try {
      const r = await api(`${base}/visionline/refresh`, { body: {} });
      setOk(`Reading doors and user groups${r.sync?.skipped ? '' : ', people and keycards'} from Visionline now. The lists update by themselves in a few minutes.${r.sync?.skipped ? ` People and keycards: ${r.sync.skipped}` : ''}`);
      await ov.reload();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHead title="Visionline cards & people" intro="Read from the hotel's Visionline by the connector, by itself: doors and user groups every few hours, people and keycards on a schedule, and a card made at the Visionline desk within seconds. Read-only; nothing here changes Visionline.">
        {can('resources.discover') && <button className="btn" onClick={refresh} disabled={busy}>{busy ? 'Asking the connector…' : 'Refresh now'}</button>}
      </PageHead>
      <ErrorNote error={error ?? ov.error} />
      {ok && <div className="alert ok">{ok}</div>}
      {d && <Status d={d} />}
      <div className="seg" role="tablist" style={{ margin: '4px 0 14px', flexWrap: 'wrap' }}>
        {TABS.map((x) => <button key={x.id} role="tab" aria-pressed={tab === x.id} onClick={() => setSp({ tab: x.id })}>{x.l}</button>)}
      </div>
      {tab === 'cards' ? <Cards /> : tab === 'people' ? <People /> : <Groups />}
    </>
  );
}

function Status({ d }: { d: any }) {
  const c = d.connector;
  const problem = !c ? 'No connector is registered yet (Connector health).'
    : !c.online ? 'The connector is offline: nothing new arrives until it is back.'
    : !c.credentials ? 'The connector has no Visionline account yet: enter it in Settings → Visionline.'
    : !c.canSync ? 'This connector does not read people and keycards (installed for a Visionline that is not the hotel\'s own, or older than 0.6.0).'
    : !d.sync.enabled ? 'Reading people and keycards is switched off (Settings → Reports & sync).'
    : null;
  const lastSync = d.sync.last;
  return (
    <>
      {problem && <div className="alert warn">{problem}</div>}
      <div className="mon-tiles">
        <div className="mon-tile ok"><strong>{d.counts.validCards}</strong><span>valid keycards{d.counts.mobileKeys ? ` · ${d.counts.mobileKeys} mobile keys` : ''}{d.counts.newCards24h ? ` · ${d.counts.newCards24h} new in 24 h` : ''}</span></div>
        <div className="mon-tile ok"><strong>{d.counts.people}</strong><span>people in Visionline</span></div>
        <div className="mon-tile ok"><strong>{d.counts.userGroups}</strong><span>user groups</span></div>
        <div className="mon-tile ok"><strong>{d.counts.doors}</strong><span>doors · {d.counts.doorGroups} door groups</span></div>
      </div>
      <p className="small muted" style={{ marginTop: -4 }}>
        Doors and groups: {d.discovery.lastOkAt ? `read ${fmt.rel(d.discovery.lastOkAt)}` : 'not read yet'}{d.discovery.everyHours ? `, every ${d.discovery.everyHours} h` : ', only by hand'}
        {d.discovery.last?.status === 'FAILED' && <span className="bad-text"> · last attempt failed: {d.discovery.last.error?.message ?? 'see Connector health'}</span>}
        {' · '}People and keycards: {d.sync.lastOkAt ? `read ${fmt.rel(d.sync.lastOkAt)}` : 'not read yet'}{d.sync.enabled ? `, every ${d.sync.everyHours} h` : ''}
        {lastSync?.status === 'RUNNING' && ' · reading now…'}
        {lastSync?.status === 'FAILED' && <span className="bad-text"> · last attempt failed: {lastSync.error}</span>}
        {c?.liveCards ? ' · new cards: live' : c ? ' · new cards: at the next sync (connector 0.9.0 records them live)' : ''}
      </p>
    </>
  );
}

const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;
const STATE = (k: any) => k.valid ? 'Valid' : k.cancelled ? 'Cancelled' : k.discarded ? 'Discarded' : k.overridden ? 'Replaced' : k.expired || (k.expires_at && new Date(k.expires_at) < new Date()) ? 'Expired' : k.not_issued ? 'Not issued' : 'No longer valid';

function Filters({ q, setQ, group, setGroup, children }: { q: string; setQ: (v: string) => void; group: string; setGroup: (v: string) => void; children?: React.ReactNode }) {
  const { base } = useHotel();
  const groups = useApi<any[]>(`${base}/visionline/user-groups`);
  return (
    <div className="row" style={{ marginBottom: 12 }}>
      <input aria-label="Search" placeholder="Search name, user or card number" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 260, border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: '7px 10px' }} />
      <select aria-label="User group" value={group} onChange={(e) => setGroup(e.target.value)} style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: '7px 10px' }}>
        <option value="">All user groups</option>
        {(groups.data ?? []).map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
      </select>
      {children}
    </div>
  );
}

function Cards() {
  const { base } = useHotel();
  const [q, setQ] = useState(''); const [group, setGroup] = useState(''); const [state, setState] = useState('valid'); const [kind, setKind] = useState('all');
  const qs = new URLSearchParams({ state, kind, ...(q.trim() ? { q: q.trim() } : {}), ...(group ? { group } : {}) });
  const cards = useApi<any[]>(`${base}/visionline/cards?${qs}`, [qs.toString()], 30_000);
  const sel = { border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: '7px 10px' };
  return (
    <div className="panel flush">
      <div style={{ padding: '14px 16px 0' }}>
        <Filters q={q} setQ={setQ} group={group} setGroup={setGroup}>
          <select aria-label="State" value={state} onChange={(e) => setState(e.target.value)} style={sel}><option value="valid">Valid now</option><option value="ended">No longer valid</option><option value="all">All</option></select>
          <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} style={sel}><option value="all">Keycards and mobile keys</option><option value="card">Keycards only</option><option value="mobile">Mobile keys only</option></select>
        </Filters>
      </div>
      <ErrorNote error={cards.error} />
      {!cards.data ? null : !cards.data.length ? <div style={{ padding: 16 }}><NoData text="No keycards for now" hint="They arrive from Visionline by themselves; new cards within seconds of being made." /></div> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="grid">
            <thead><tr><th>Holder</th><th>User group</th><th>Card</th><th>Kind</th><th>Valid from</th><th>Valid until</th><th className="num">Doors</th><th>State</th><th>Recorded</th></tr></thead>
            <tbody>{cards.data.map((k) => (
              <tr key={k.reg_no}>
                <td>{k.holder_name ?? <span className="muted">{k.card_holder ?? '—'}</span>}{k.holder_name && k.card_holder && <span className="sub">{k.card_holder}</span>}</td>
                <td>{k.user_group ?? '—'}</td>
                <td className="nowrap"><code>{k.reg_no}</code></td>
                <td>{k.mobile_key ? 'Mobile key' : 'Keycard'}</td>
                <td className="nowrap">{k.starts_at ? fmt.dt(k.starts_at) : '—'}</td>
                <td className="nowrap">{k.expires_at ? fmt.dt(k.expires_at) : '—'}</td>
                <td className="num">{k.door_count || (k.door_groups?.length ? `${k.door_groups.length} groups` : '—')}</td>
                <td>{STATE(k)}</td>
                <td className="nowrap">{fmt.rel(k.first_seen_at)}{k.source === 'live' && <span className="sub">live from Visionline</span>}</td>
              </tr>
            ))}</tbody>
          </table>
          {cards.data.length >= 500 && <p className="small muted" style={{ padding: '8px 16px' }}>The first 500 are shown; search or choose a user group to narrow the list.</p>}
        </div>
      )}
    </div>
  );
}

function People() {
  const { base } = useHotel();
  const [q, setQ] = useState(''); const [group, setGroup] = useState('');
  const qs = new URLSearchParams({ ...(q.trim() ? { q: q.trim() } : {}), ...(group ? { group } : {}) });
  const people = useApi<any[]>(`${base}/visionline/people?${qs}`, [qs.toString()], 60_000);
  return (
    <div className="panel flush">
      <div style={{ padding: '14px 16px 0' }}><Filters q={q} setQ={setQ} group={group} setGroup={setGroup} /></div>
      <ErrorNote error={people.error} />
      {!people.data ? null : !people.data.length ? <div style={{ padding: 16 }}><NoData text="No people for now" hint="They are read from Visionline by themselves." /></div> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="grid">
            <thead><tr><th>Name</th><th>Visionline user</th><th>User group</th><th className="num">Valid keycards</th><th>Valid until</th><th>Staff in the portal</th></tr></thead>
            <tbody>{people.data.map((u) => (
              <tr key={u.user_id}>
                <td>{[u.given_name, u.surname].filter(Boolean).join(' ') || '—'}</td>
                <td><code>{u.user_id}</code></td>
                <td>{u.user_group ?? '—'}</td>
                <td className="num">{u.valid_cards}</td>
                <td className="nowrap">{u.valid_until ? fmt.dt(u.valid_until) : '—'}</td>
                <td>{u.staff_name ?? <span className="muted">—</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Groups() {
  const { base } = useHotel();
  const groups = useApi<any[]>(`${base}/visionline/user-groups`, [], 60_000);
  return (
    <div className="panel flush">
      <ErrorNote error={groups.error} />
      {!groups.data ? null : !groups.data.length ? <div style={{ padding: 16 }}><NoData text="No user groups for now" hint="They are read from Visionline by themselves (from its people, then each group's doors)." /></div> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="grid">
            <thead><tr><th>User group</th><th>Doors in Visionline</th><th className="num">People</th><th className="num">Valid keycards</th><th>Staff group</th><th>Read</th></tr></thead>
            <tbody>{groups.data.map((g) => (
              <tr key={g.name}>
                <td><strong>{g.name}</strong>{g.default && <span className="sub">default for staff</span>}</td>
                <td>{!g.inVisionline ? <span className="muted">being read…</span> : `${g.uniformAccess ? 'Uniform access · ' : ''}${g.doors || g.doorGroups ? [g.doors ? n(g.doors, 'door', 'doors') : '', g.doorGroups ? n(g.doorGroups, 'door group', 'door groups') : ''].filter(Boolean).join(', ') : 'No doors set'}`}</td>
                <td className="num">{g.people}</td>
                <td className="num">{g.validCards}</td>
                <td>{g.staffGroup ? 'Yes' : 'No'}</td>
                <td className="nowrap">{g.readAt ? fmt.rel(g.readAt) : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
