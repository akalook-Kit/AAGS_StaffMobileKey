import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useHotel } from '../App';
import { api, download } from '../api';
import { ErrorNote, PageHead, useApi } from '../ui';

const KIND: Record<string, string> = { fire: 'Fire', evacuation: 'Evacuation', drill: 'Drill', other: 'Emergency' };
const hm = (iso: string | null, tz?: string) => (iso ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso)) : '—');

/**
 * 2.13 Live occupancy: who is in the building now, for the security desk screen and for evacuations.
 * Refreshes by itself; "Full screen" turns it into a wall display. During an emergency each room and person can be
 * ticked as safe (roll call).
 */
export function MusterPage() {
  const { base, can, hotel } = useHotel();
  const m = useApi<any>(`${base}/muster`, [hotel.id], 20_000);
  const wrap = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [full, setFull] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [roll, setRoll] = useState<Record<string, any> | null>(null);
  useEffect(() => { const f = () => setFull(Boolean(document.fullscreenElement)); document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); }, []);
  useEffect(() => { setRoll(m.data?.emergency?.roll ?? null); }, [m.data]);
  const v = m.data;
  const em = v?.emergency;
  const s = q.trim().toLowerCase();
  const people = useMemo(() => (v?.people ?? []).filter((p: any) => !s || `${p.name} ${p.group ?? ''} ${p.lastDoor ?? ''}`.toLowerCase().includes(s)), [v, s]);
  const groups = useMemo(() => {
    const g = new Map<string, any[]>();
    for (const p of people) { const k = p.kind === 'visitor' ? 'Visitors & contractors' : p.group ?? 'No group'; g.set(k, [...(g.get(k) ?? []), p]); }
    return [...g.entries()];
  }, [people]);
  const floors = useMemo(() => {
    const f = new Map<string, any[]>();
    for (const r of v?.rooms ?? []) if (!s || r.room.toLowerCase().includes(s) || r.names.some((n: string) => n.toLowerCase().includes(s))) f.set(r.floor, [...(f.get(r.floor) ?? []), r]);
    return [...f.entries()];
  }, [v, s]);
  if (!v) return <><PageHead title="Live occupancy" /><ErrorNote error={m.error} /></>;

  const safe = (key: string) => Boolean(roll?.[key]?.safe);
  const toggle = async (key: string) => {
    if (!em) return;
    setError(null);
    try { const r = await api(`${base}/emergency/${em.id}/roll`, { body: { key, safe: !safe(key) } }); setRoll(r.roll); } catch (e) { setError(e); }
  };
  const due = [...v.rooms.filter((r: any) => r.status !== 'empty').map((r: any) => `room:${r.room}`), ...v.people.map((p: any) => `person:${p.key}`)];
  const accounted = due.filter(safe).length;

  return (
    <div ref={wrap} className={`muster${full ? ' wall' : ''}${em ? ' alarm' : ''}`}>
      <PageHead title="Live occupancy" intro={<>Who is in the building now, from door activity, attendance and the in-house list. Updated {hm(v.at, v.tz)} · refreshes every 20 seconds.</>}>
        <input className="search" placeholder="Find a room or a person" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a room or a person" />
        <button className="btn" onClick={() => (full ? document.exitFullscreen() : wrap.current?.requestFullscreen?.())}>{full ? 'Leave full screen' : 'Full screen'}</button>
        <button className="btn primary" onClick={() => download(`${base}/muster/pdf`, `evacuation-list-${new Date().toISOString().slice(0, 16).replace(':', '')}.pdf`).catch(setError)}>Print evacuation list</button>
      </PageHead>
      {em && (
        <div className="em-banner" role="alert">
          <strong>{KIND[em.kind] ?? 'Emergency'}{em.status === 'REQUESTED' ? ' - waiting for a second person to confirm' : ''}</strong>
          <span>{em.reason} · since {hm(em.activatedAt ?? em.requestedAt, v.tz)}</span>
          <span className="em-count">{accounted} of {due.length} accounted for</span>
          {can('emergency.manage') && <Link to="/emergency" className="btn small">Emergency page</Link>}
        </div>
      )}
      <ErrorNote error={error} />
      <div className="figures muster-figures">
        <div><div className="v">{v.totals.staff}</div><div className="l">Staff on site</div></div>
        <div><div className="v">{v.totals.guests}</div><div className="l">Guests in house ({v.totals.roomsInHouse} rooms)</div></div>
        <div><div className="v">{v.totals.roomsActivity}</div><div className="l">Other rooms opened in the last {v.policy.roomActivityHours} h</div></div>
        <div><div className="v">{v.totals.visitors}</div><div className="l">Visitors / contractors</div></div>
      </div>
      <div className="muster-grid">
        <section className="panel">
          <h2>Rooms</h2>
          <div className="legend-row small muted">
            <span><i className="sw in" /> In house (guest list)</span><span><i className="sw act" /> Door opened recently</span><span><i className="sw" /> No sign of use</span>{em && <span><i className="sw safe" /> Checked / safe</span>}
          </div>
          {!v.sources.inHouseList && <p className="small muted">No in-house list for today: guests are shown only from door activity. Import the PMS in-house report in Breakfast, or keep the list there.</p>}
          {floors.length ? floors.map(([f, rooms]) => (
            <div key={f} className="floor">
              <div className="floor-label">Floor {f}<span className="n">{rooms.filter((r: any) => r.status === 'in_house').length} in house · {rooms.reduce((a: number, r: any) => a + r.guests, 0)} guests</span></div>
              <div className="doors">
                {rooms.map((r: any) => {
                  const k = `room:${r.room}`;
                  const title = r.status === 'in_house' ? `${r.room}: ${r.guests} guest(s)${r.names.length ? ` - ${r.names.join(', ')}` : ''}${r.lastEntry ? ` · door opened ${hm(r.lastEntry, v.tz)}` : ''}` : r.status === 'activity' ? `${r.room}: door opened ${hm(r.lastEntry, v.tz)}${r.lastBy ? ` by ${r.lastBy}` : ''}` : `${r.room}: no sign of use`;
                  return (
                    <button key={r.room} className={`room-tile ${r.status}${safe(k) ? ' safe' : ''}`} title={title} aria-label={title} disabled={!em || r.status === 'empty'} aria-pressed={em ? safe(k) : undefined} onClick={() => toggle(k)}>
                      {r.room}{r.guests > 0 && <small>{r.guests}</small>}
                    </button>
                  );
                })}
              </div>
            </div>
          )) : <p className="empty">No rooms found. Rooms are the doors whose name is a room number.</p>}
        </section>
        <section className="panel">
          <h2>People on site <span className="muted small">({people.length})</span></h2>
          {groups.length ? groups.map(([g, list]) => (
            <div key={g} className="muster-group">
              <h3>{g} <span className="muted">{list.length}</span></h3>
              <ul>
                {list.map((p: any) => {
                  const k = `person:${p.key}`;
                  return (
                    <li key={p.key} className={safe(k) ? 'safe' : ''}>
                      {em ? <label className="check"><input type="checkbox" checked={safe(k)} onChange={() => toggle(k)} /> <strong>{p.name}</strong></label> : <strong>{p.name}</strong>}
                      <span className="muted small">{p.lastDoor ? `${p.lastDoor} · ${hm(p.lastAt, v.tz)}` : p.source.includes('attendance') ? `checked in ${hm(p.lastAt, v.tz)}` : hm(p.lastAt, v.tz)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )) : <p className="empty">Nobody seen at a door in the last {v.policy.staffOnSiteHours} hours.</p>}
        </section>
      </div>
      <p className="small muted">
        Locks record who opens a door, not who leaves: people count as on site for {v.policy.staffOnSiteHours} hours after their last door (or until they check out at attendance), rooms count as used for {v.policy.roomActivityHours} hours after the door was opened.
        Treat this as the starting point of a sweep, not as proof that an area is empty. Offline locks report their entries later.
        {v.sources.doorEventsCapped ? ' Only the latest 5,000 door entries were read.' : ''}
      </p>
    </div>
  );
}
