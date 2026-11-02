import { RefreshVisionline } from '../components/RefreshVisionline';
import { VerifyCard } from '../components/VerifyCard';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useHotel } from '../App';
import { ErrorNote, PageHead, fmt, useApi } from '../ui';
import { NoData } from '../components/charts';

/**
 * 2.10 What the portal has read from Visionline: keycards, people, user groups. It all arrives by itself:
 * doors and user groups every few hours, people and keycards on a schedule, and a card made at the Visionline
 * desk within seconds (live feed). Nothing here changes Visionline.
 */
const TABS = [{ id: 'cards', l: 'Keycards' }, { id: 'lookup', l: 'Card lookup' }, { id: 'people', l: 'People' }, { id: 'groups', l: 'User groups' }] as const;

export function VisionlinePage() {
  const { base, can } = useHotel();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') ?? 'cards') as (typeof TABS)[number]['id'];
  const ov = useApi<any>(`${base}/visionline/overview`, [], 20_000);
  const d = ov.data;
  return (
    <>
      <PageHead title="Visionline cards & people" intro="Read from your Visionline by the connector: doors, user groups, people and keycards when you press Refresh from Visionline (or on a schedule, Settings → Reports & sync), and a card made in Visionline within seconds. Read-only; nothing here changes Visionline." />
      <RefreshVisionline onDone={() => void ov.reload()} />
      <ErrorNote error={ov.error} />
      {d && <Status d={d} />}
      <div className="seg" role="tablist" style={{ margin: '4px 0 14px', flexWrap: 'wrap' }}>
        {TABS.map((x) => <button key={x.id} role="tab" aria-pressed={tab === x.id} onClick={() => setSp({ tab: x.id })}>{x.l}</button>)}
      </div>
      {tab === 'cards' ? <Cards /> : tab === 'lookup' ? <Lookup encoders={d?.encoders ?? []} canRead={Boolean(d?.connector?.canReadCards)} /> : tab === 'people' ? <People /> : <Groups />}
    </>
  );
}

function Status({ d }: { d: any }) {
  const c = d.connector;
  const problem = !c ? 'No connector is registered yet (Connector health).'
    : !c.online ? 'The connector is offline: nothing new arrives until it is back.'
    : !c.credentials ? 'The connector has no Visionline account yet: enter it in Settings → Visionline.'
    : !c.canSync ? 'This connector does not read people and keycards (installed for a Visionline that is not your own, or older than 0.6.0).'
    : !d.sync.enabled ? 'Reading people and keycards is switched off (Settings → Reports & sync).'
    : null;
  const lastSync = d.sync.last;
  return (
    <>
      {problem && <div className="alert warn">{problem}</div>}
      {d.visionlineOperator?.shared && (
        <div className="alert warn"><strong>Visionline user "{d.visionlineOperator.name}" is shared (PMS / interface type).</strong> Visionline records every keycard made from this portal under that name, so its own card log cannot say who made it. Change it or add operators: give each person their own Visionline operator and let them store it under <em>Your account → Visionline</em>, then switch on <em>Personal Visionline credentials required</em> (Settings → Visionline). This portal always records the portal user for keycards made here.</div>
      )}
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
  const [sp0] = useSearchParams();
  const [q, setQ] = useState(''); const [group, setGroup] = useState(''); const [state, setState] = useState('valid'); const [kind, setKind] = useState('all'); const [deadbolt, setDeadbolt] = useState('any');
  // 2.16.1 "Who can open this door?" and "who has a master keycard?"
  const [door, setDoor] = useState(sp0.get('door') ?? ''); const [master, setMaster] = useState(sp0.get('master') === 'yes');
  const doors = useApi<{ id: string; name: string; group: string | null }[]>(`${base}/visionline/doors`);
  const qs = new URLSearchParams({ state, kind, deadbolt, ...(q.trim() ? { q: q.trim() } : {}), ...(group ? { group } : {}), ...(door ? { door } : {}), ...(master ? { master: 'yes' } : {}) });
  const quick = (doors.data ?? []).filter((d) => /cash|safe|master|store|office|server|bar|kitchen|gm/i.test(d.name)).slice(0, 5);
  const cards = useApi<any[]>(`${base}/visionline/cards?${qs}`, [qs.toString()], 30_000);
  const sel = { border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: '7px 10px' };
  return (
    <div className="panel flush">
      <div style={{ padding: '14px 16px 0' }}>
        <Filters q={q} setQ={setQ} group={group} setGroup={setGroup}>
          <select aria-label="State" value={state} onChange={(e) => setState(e.target.value)} style={sel}><option value="valid">Valid now</option><option value="ended">No longer valid</option><option value="all">All</option></select>
          <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} style={sel}><option value="all">Keycards and mobile keys</option><option value="card">Keycards only</option><option value="mobile">Mobile keys only</option></select>
          <select aria-label="Deadbolt override" value={deadbolt} onChange={(e) => setDeadbolt(e.target.value)} style={sel}><option value="any">Deadbolt override: any</option><option value="yes">Overrides the deadbolt</option><option value="no">Does not override</option><option value="unknown">Not reported by Visionline</option></select>
          <select aria-label="Who can open this door" value={door} onChange={(e) => setDoor(e.target.value)} style={sel}><option value="">Opens: any door</option>{(doors.data ?? []).map((d) => <option key={d.id} value={d.id}>Opens {d.name}{d.group ? ` (${d.group})` : ''}</option>)}</select>
        </Filters>
        <div className="row chips" style={{ margin: '10px 0 4px', flexWrap: 'wrap', gap: 6 }}>
          <span className="small muted">Quick:</span>
          <button type="button" className={`chip${master ? ' on' : ''}`} aria-pressed={master} onClick={() => { setMaster(!master); setDoor(''); }}>Who has a master keycard</button>
          <button type="button" className={`chip${deadbolt === 'yes' ? ' on' : ''}`} aria-pressed={deadbolt === 'yes'} onClick={() => setDeadbolt(deadbolt === 'yes' ? 'any' : 'yes')}>Who can override the deadbolt</button>
          {quick.map((d) => <button type="button" key={d.id} className={`chip${door === d.id ? ' on' : ''}`} aria-pressed={door === d.id} onClick={() => { setDoor(door === d.id ? '' : d.id); setMaster(false); }}>Who can open {d.name}</button>)}
          {(door || master || deadbolt !== 'any' || group) && <button type="button" className="chip" onClick={() => { setDoor(''); setMaster(false); setDeadbolt('any'); setGroup(''); }}>Clear</button>}
        </div>
        {(door || master) && cards.data && <p className="small" style={{ margin: '4px 0 0' }}><strong>{cards.data.length}</strong> {state === 'valid' ? 'valid ' : ''}keycard{cards.data.length === 1 ? '' : 's'} {master ? 'open every room (master)' : `open ${(doors.data ?? []).find((d) => d.id === door)?.name ?? door}`}{group ? `, user group ${group}` : ''}. Door access comes from the card, its door groups and a uniform-access user group.</p>}
      </div>
      <ErrorNote error={cards.error} />
      {!cards.data ? null : !cards.data.length ? <div style={{ padding: 16 }}><NoData text="No keycards for now" hint="They arrive from Visionline by themselves; new cards within seconds of being made." /></div> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="grid">
            <thead><tr><th>Holder</th><th>User group</th><th>Card</th><th>Kind</th><th>Valid from</th><th>Valid until</th><th className="num">Doors</th><th>Deadbolt</th><th>Issued by</th><th>State</th><th>Recorded</th></tr></thead>
            <tbody>{cards.data.map((k) => (
              <tr key={k.reg_no}>
                <td>{k.card_holder ? <Link to={`/access?holder=${encodeURIComponent(k.card_holder)}`}>{k.holder_name ?? k.card_holder}</Link> : <span className="muted">—</span>}{k.holder_name && k.card_holder && <span className="sub">{k.card_holder}</span>}</td>
                <td>{k.user_group ?? '—'}</td>
                <td className="nowrap"><code>{k.reg_no}</code></td>
                <td>{k.mobile_key ? 'Mobile key' : 'Keycard'}</td>
                <td className="nowrap">{k.starts_at ? fmt.dt(k.starts_at) : '—'}</td>
                <td className="nowrap">{k.expires_at ? fmt.dt(k.expires_at) : '—'}</td>
                <td className="num">{k.door_count || (k.door_groups?.length ? `${k.door_groups.length} groups` : '—')}</td>
                <td>{k.deadbolt_override === null || k.deadbolt_override === undefined ? <span className="muted">—</span> : k.deadbolt_override ? <span className="badge warn">Override</span> : 'No'}</td>
                <td>{k.issued_by ?? <span className="muted" title="Made in Visionline, not from this portal: the Visionline Web API does not say which operator made it (Visionline's card log does).">Visionline{k.mobile_key ? ' (mobile key)' : ' desk'}</span>}</td>
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
            <thead><tr><th>Name</th><th>Visionline user</th><th>User group</th><th className="num">Valid keycards</th><th>Valid until</th><th>Also in the portal</th></tr></thead>
            <tbody>{people.data.map((u) => (
              <tr key={u.user_id}>
                <td>{[u.given_name, u.surname].filter(Boolean).join(' ') || '—'}</td>
                <td><code>{u.user_id}</code></td>
                <td>{u.user_group ?? '—'}</td>
                <td className="num">{u.valid_cards}</td>
                <td className="nowrap">{u.valid_until ? fmt.dt(u.valid_until) : '—'}</td>
                <td>{u.portal_user ? <span className="badge">Portal user: {u.portal_user}</span> : null}{u.staff_name && <span className="sub">Staff app: {u.staff_name}</span>}{!u.portal_user && !u.staff_name && <span className="muted">—</span>}</td>
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

/** 2.12 Card lookup: type (or read at an encoder) a card number; see whose it is, validity, doors, who issued it, last uses. */
function Lookup({ encoders, canRead }: { encoders: string[]; canRead: boolean }) {
  const { base, can } = useHotel();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('card') ?? '');
  const reg = sp.get('card');
  const r = useApi<any>(reg ? `${base}/visionline/cards/${encodeURIComponent(reg)}/lookup` : null, [reg]);
  // 2.17 The encoder is always chosen here (remembered on this computer).
  const [enc, setEnc0] = useState(() => { try { const v = localStorage.getItem('smk.encoder'); return v && encoders.includes(v) ? v : encoders[0] ?? ''; } catch { return encoders[0] ?? ''; } });
  const setEnc = (v: string) => { setEnc0(v); try { localStorage.setItem('smk.encoder', v); } catch { /* ignore */ } };
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const show = (v: string) => { const n = new URLSearchParams(sp); n.set('tab', 'lookup'); n.set('card', v.trim()); setSp(n, { replace: true }); };
  const readAtEncoder = async () => {
    setReading(true); setError(null);
    try {
      const { commandId } = await api<any>(`${base}/visionline/encoder/read`, { body: { encoder: enc || encoders[0] } });
      const end = Date.now() + 45_000;
      for (;;) {
        await new Promise((res) => setTimeout(res, 1200));
        const c = await api<any>(`${base}/visionline/encoder/read/${commandId}`);
        if (c.status === 'SUCCEEDED') { const no = c.result?.regNo; if (!no) throw new Error('Visionline answered without a card number.'); setQ(String(no)); show(String(no)); break; }
        if (c.status === 'FAILED' || c.status === 'EXPIRED') throw new Error(c.error?.message ?? 'The card could not be read.');
        if (Date.now() > end) throw new Error('The connector did not answer in time.');
      }
    } catch (e) { setError(e); } finally { setReading(false); }
  };
  const x = r.data;
  return (
    <>
      <div className="panel lookup-bar">
        <form className="row" style={{ flex: '1 1 340px' }} onSubmit={(e) => { e.preventDefault(); if (q.trim()) show(q); }}>
          <input className="search" style={{ flex: 1 }} inputMode="numeric" placeholder="Card number (registration number)…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Card number" />
          <button className="btn primary" disabled={!q.trim()}>Look up</button>
        </form>
        {encoders.length === 0 && <span className="small muted">To read a card lying on an encoder: switch it on in Settings → Reports &amp; sync → Encoders.</span>}
        {encoders.length > 0 && (
          <div className="row">
            <label className="small muted" htmlFor="enc-pick">Encoder</label>
            <select id="enc-pick" className="search" style={{ minWidth: 160 }} value={enc || encoders[0]} onChange={(e) => setEnc(e.target.value)}>{encoders.map((e) => <option key={e} value={e}>{e}</option>)}</select>
            <button className="btn" onClick={readAtEncoder} disabled={reading || !canRead} title={canRead ? 'Put the card on the encoder first' : 'Needs connector 0.10.0'}>{reading ? 'Reading the card…' : `Read the card on ${enc || encoders[0]}`}</button>
            <span className="badge" title="Pilot: confirm on your Visionline before relying on it.">pilot</span>
          </div>
        )}
      </div>
      <ErrorNote error={error ?? r.error} />
      {!reg && <div className="panel"><NoData text="Type a card number to see whose card it is" hint="Holder, user group, validity, doors, deadbolt override, who issued it and where it was last used." /></div>}
      {reg && x && !x.known && <div className="alert warn">Card {x.regNo} matches no keycard read from Visionline and no mobile key issued here. If it was made recently, it appears after the next read; if it shows up at doors, check it in Visionline.</div>}
      {x?.known && (
        <div className="cols">
          <div className="panel">
            <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>{x.card.kind} <span className="mono">{x.regNo}</span></h2>{x.card.valid ? <span className="pill ok">Valid</span> : <span className="pill bad">Not valid</span>}</div>
            {!x.card.mobile && <div style={{ marginTop: 10 }}><VerifyCard key={x.regNo} regNo={x.regNo} onDone={() => void r.reload()} />
              <span className="small muted">{x.card.lastSeen ? `Last read from Visionline ${fmt.dt(x.card.lastSeen)}.` : ''} Verify asks Visionline now about this card only.</span>
              {(can('keycards.read') || can('keycards.manage')) && <div className="small" style={{ marginTop: 4 }}><Link to="/keycards?tab=verify">Card in your hand? Verify it at an encoder and extend it →</Link></div>}</div>}
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>Holder</dt><dd>{x.card.holderId ? <Link to={`/access?holder=${encodeURIComponent(x.card.holderId)}`}>{x.card.holder}</Link> : x.card.holder ?? '—'}</dd>
              <dt>User group</dt><dd>{x.card.group ?? '—'}</dd>
              <dt>Valid</dt><dd>{x.card.startsAt ? `${fmt.dt(x.card.startsAt)} → ` : 'until '}{x.card.expiresAt ? fmt.dt(x.card.expiresAt) : 'no end'}</dd>
              <dt>Kind</dt><dd>{x.card.mobile ? 'Mobile key (a phone: Visionline shows its serial as FFFFFFFF)' : 'Keycard'}</dd>
              <dt>Issued by</dt><dd>{x.card.issuedBy ?? <span className="muted" title="The Visionline Web API does not say which Visionline operator made a card; Visionline's own card log does.">Visionline (operator not reported)</span>}</dd>
              <dt>Deadbolt override</dt><dd>{x.card.deadbolt == null ? <span className="muted">not reported by Visionline</span> : x.card.deadbolt ? <span className="badge warn">Yes</span> : 'No'}</dd>
              {x.card.timeSchedule && <><dt>Time schedule</dt><dd>{x.card.timeSchedule}</dd></>}
              {x.card.cancelled && <><dt>State</dt><dd className="bad-text">Cancelled in Visionline</dd></>}
            </dl>
            <h3 style={{ marginTop: 16 }}>Doors ({x.card.doors.length || x.card.doorCount || 0}){x.card.doorGroups?.length ? ` · ${x.card.doorGroups.length} door groups` : ''}</h3>
            <div className="chips">{x.card.doors.slice(0, 60).map((d: string) => <span key={d} className="chip" style={{ cursor: 'default' }}>{d}</span>)}{x.card.doorGroups?.map((g: string) => <span key={g} className="chip" style={{ cursor: 'default' }}>▦ {g}</span>)}</div>
          </div>
          <div className="panel">
            <h2>Last uses at doors (90 days)</h2>
            {!x.uses.length ? <NoData text="Not seen at a door yet" hint="Entrances appear as the locks report them." /> : (
              <ul className="tl wide">{x.uses.map((u: any, i: number) => <li key={i} className={u.category}><time>{fmt.dt(u.at)}</time><span className="tl-what">{u.category === 'entrance' ? 'Entered' : 'Refused at'} <b>{u.door ?? 'a door'}</b></span></li>)}</ul>)}
          </div>
        </div>
      )}
    </>
  );
}
