import { useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, api, download } from '../api';
import { useHotel } from '../App';
import { ErrorNote, PageHead, fmt, useApi } from '../ui';
import { NoData } from '../components/charts';
import { parseCsv } from '../csv';

/**
 * Breakfast (2.11): the restaurant looks a room up and records who had breakfast; front office keeps the in-house
 * list (imported from the PMS "in-house guests" report, or typed); managers see the day sheet and reports.
 */
const STATUS: Record<string, [string, string]> = { done: ['Served', 'ok'], partly: ['Partly served', 'warn'], waiting: ['Not come yet', 'idle'], not_included: ['Not in rate', 'idle'] };
const inputStyle = { border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: '8px 10px' } as const;

export function BreakfastPage() {
  const { can } = useHotel();
  const [sp, setSp] = useSearchParams();
  const tabs = [
    ...(can('breakfast.serve') ? [{ id: 'serve', l: 'Restaurant' }] : []),
    { id: 'today', l: 'Today' },
    ...(can('breakfast.manage') ? [{ id: 'list', l: 'In-house list' }] : []),
    { id: 'report', l: 'Reports' },
    ...(can('breakfast.manage') ? [{ id: 'setup', l: 'Setup' }] : []),
  ];
  const tab = tabs.some((t) => t.id === sp.get('tab')) ? sp.get('tab')! : tabs[0]!.id;
  return (
    <>
      <PageHead title="Breakfast" intro="Who is in house today and who has had breakfast. The in-house list comes from the PMS report (or front office); the restaurant records each room as guests arrive." />
      <div className="seg" role="tablist" style={{ margin: '0 0 14px', flexWrap: 'wrap' }}>
        {tabs.map((t) => <button key={t.id} role="tab" aria-pressed={tab === t.id} onClick={() => setSp({ tab: t.id })}>{t.l}</button>)}
      </div>
      {tab === 'serve' ? <Serve /> : tab === 'today' ? <Today /> : tab === 'list' ? <InHouse /> : tab === 'report' ? <Reports /> : <Setup />}
    </>
  );
}

function useDay(date?: string) {
  const { base } = useHotel();
  return useApi<any>(`${base}/breakfast/day${date ? `?date=${date}` : ''}`, [date], 15_000);
}

function Tiles({ t }: { t: any }) {
  return (
    <div className="mon-tiles">
      <div className="mon-tile ok"><strong>{t.rooms}</strong><span>rooms in house · {t.guests} guests</span></div>
      <div className="mon-tile ok"><strong>{t.served} / {t.expected}</strong><span>breakfasts in the rate served</span></div>
      <div className={`mon-tile ${t.remaining ? 'warn' : 'ok'}`}><strong>{t.remaining}</strong><span>not come yet · {t.roomsWaiting} rooms</span></div>
      <div className="mon-tile ok"><strong>{t.paying}</strong><span>paying / walk-in guests</span></div>
    </div>
  );
}

// ---- Restaurant ----------------------------------------------------------------------------------------------
function Serve() {
  const { base } = useHotel();
  const day = useDay();
  const [q, setQ] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const d = day.data;
  const query = q.trim().toUpperCase();
  const rooms = useMemo(() => (d?.rooms ?? []).filter((r: any) => !query || r.room.startsWith(query) || r.stays.some((s: any) => (s.guestName ?? '').toUpperCase().includes(query))), [d, query]);
  const exact = d?.rooms.find((r: any) => r.room === query);
  const serve = async (room: string | undefined, persons: number, kind?: string, note?: string) => {
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await api(`${base}/breakfast/serve`, { body: { room, persons, kind, note } });
      setMsg(`${room ? `Room ${room}` : 'Guest'}: ${persons} ${persons === 1 ? 'breakfast' : 'breakfasts'} recorded${r.kind === 'included' ? ' (in the rate)' : r.kind === 'paying' ? ' as paying' : ' as walk-in'}.`);
      setQ(''); await day.reload();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const undo = async (id: string) => {
    const reason = prompt('Why is this entry wrong? (for example: wrong room)');
    if (!reason) return;
    try { await api(`${base}/breakfast/served/${id}/void`, { body: { reason } }); setMsg('Entry undone.'); await day.reload(); } catch (e) { setError(e); }
  };
  if (!d) return <ErrorNote error={day.error} />;
  const mine = d.served.filter((s: any) => !s.voided).slice(-8).reverse();
  return (
    <>
      <Tiles t={d.totals} />
      <ErrorNote error={error} />
      {msg && <div className="alert ok">{msg}</div>}
      <div className="panel">
        <label htmlFor="bq" style={{ fontWeight: 600 }}>Room number or guest name</label>
        <input id="bq" value={q} onChange={(e) => setQ(e.target.value)} autoFocus autoComplete="off" inputMode="text" placeholder="e.g. 204"
          style={{ ...inputStyle, width: '100%', fontSize: 22, padding: '10px 12px', marginTop: 6 }} />
        {query && !exact && (
          <div className="alert warn" style={{ marginTop: 10 }}>
            Room {query} is not on today's in-house list.{d.policy.allowWalkIns && <> <button className="btn small" disabled={busy} onClick={() => serve(query, 1, 'walk_in', 'Not on the in-house list')}>Record 1 paying guest</button></>}
          </div>
        )}
      </div>
      {!d.rooms.length ? <div className="panel"><NoData text="No rooms on today's in-house list" hint="Front office imports it from the PMS (Breakfast → In-house list)." /></div> : (
        <div className="bf-rooms">
          {rooms.slice(0, 60).map((r: any) => {
            const [label, tone] = STATUS[r.status] ?? [r.status, 'idle'];
            return (
              <div key={r.room} className={`bf-room ${r.status}`}>
                <div className="bf-room-head"><strong className="tag-num">{r.room}</strong><span className={`att-state ${tone}`}>{label}</span></div>
                <div className="small">{r.stays.map((s: any) => s.guestName).filter(Boolean).join(' / ') || <span className="muted">No name</span>}</div>
                <div className="small muted">{r.persons} {r.persons === 1 ? 'guest' : 'guests'} · in rate {r.included} · served {r.servedIncluded}{r.servedPaying ? ` · paying ${r.servedPaying}` : ''}</div>
                <div className="row" style={{ marginTop: 8 }}>
                  {r.remaining > 0 && <button className="btn primary" disabled={busy} onClick={() => serve(r.room, 1)}>+1</button>}
                  {r.remaining > 1 && <button className="btn" disabled={busy} onClick={() => serve(r.room, r.remaining)}>All {r.remaining}</button>}
                  {d.policy.allowWalkIns && <button className="btn" disabled={busy} onClick={() => serve(r.room, 1, 'paying')} title="Breakfast not in the rate, or more people than in the rate">+1 paying</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {mine.length > 0 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <h2>Last entries</h2>
          <table className="grid"><thead><tr><th>Time</th><th>Room</th><th className="num">Persons</th><th>Kind</th><th>By</th><th /></tr></thead>
            <tbody>{mine.map((s: any) => <tr key={s.id}><td>{new Date(s.servedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</td><td>{s.room ?? '—'}</td><td className="num">{s.persons}</td><td>{s.kind === 'included' ? 'In rate' : s.kind === 'paying' ? 'Paying' : 'Walk-in'}</td><td>{s.servedBy ?? ''}</td>
              <td><button className="btn small" onClick={() => undo(s.id)}>Undo</button></td></tr>)}</tbody></table>
        </div>
      )}
    </>
  );
}

// ---- Today (managers) ---------------------------------------------------------------------------------------------
function Today() {
  const { base, hotel } = useHotel();
  const [date, setDate] = useState<string>('');
  const day = useDay(date || undefined);
  const [error, setError] = useState<unknown>(null);
  const d = day.data;
  if (!d) return <ErrorNote error={day.error} />;
  const pdf = async () => {
    try {
      const r = await fetch(`${base}/breakfast/pdf`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('smk.token')}` }, body: JSON.stringify({ date: d.day }) });
      if (!r.ok) throw new ApiError(r.status, 'ERROR', 'Printing failed');
      const url = URL.createObjectURL(await r.blob());
      Object.assign(document.createElement('a'), { href: url, download: `${hotel.slug}-breakfast-${d.day}.pdf` }).click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e); }
  };
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <label htmlFor="bd">Day</label><input id="bd" type="date" value={date || d.day} max={d.today} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
        <span className="muted small">Service {d.policy.serviceFrom}–{d.policy.serviceUntil} ({d.timeZone})</span>
        <button className="btn" onClick={pdf}>Print day sheet (PDF)</button>
      </div>
      <ErrorNote error={error} />
      <Tiles t={d.totals} />
      <div className="panel flush">
        {!d.rooms.length ? <div style={{ padding: 16 }}><NoData text="No rooms on the in-house list for this day" hint="Import the PMS in-house report under In-house list." /></div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="grid">
              <thead><tr><th>Room</th><th>Guest(s)</th><th className="num">Guests</th><th className="num">In rate</th><th className="num">Served</th><th className="num">Paying</th><th>Status</th><th>Last served</th></tr></thead>
              <tbody>{d.rooms.map((r: any) => { const [label, tone] = STATUS[r.status] ?? [r.status, 'idle']; return (
                <tr key={r.room}><td className="tag-num">{r.room}</td><td>{r.stays.map((s: any) => s.guestName).filter(Boolean).join(' / ') || '—'}</td><td className="num">{r.persons}</td><td className="num">{r.included}</td>
                  <td className="num">{r.servedIncluded}</td><td className="num">{r.servedPaying || ''}</td><td><span className={`att-state ${tone}`}>{label}</span></td><td>{r.lastServedAt ? fmt.dt(r.lastServedAt) : ''}</td></tr>); })}</tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ---- In-house list (front office) ----------------------------------------------------------------------------------
const FIELDS = [
  { k: 'room', l: 'Room', match: /^(room|chambre|rm|room ?no|room ?number|n° ?chambre)$/i, required: true },
  { k: 'guestName', l: 'Guest name', match: /^(name|guest|guest ?name|nom|client|last ?name)$/i },
  { k: 'adults', l: 'Adults', match: /^(adults?|adultes?|pax|ad)$/i },
  { k: 'children', l: 'Children', match: /^(children|child|enfants?|ch|kids)$/i },
  { k: 'arrival', l: 'Arrival', match: /^(arrival|arr|check ?in|arrivee|arrivée|from)$/i },
  { k: 'departure', l: 'Departure', match: /^(departure|dep|check ?out|depart|départ|to)$/i },
  { k: 'breakfast', l: 'Breakfast / board', match: /^(breakfast|bkf|bb|board|meal ?plan|petit[- ]?d[ée]jeuner|pension)$/i },
  { k: 'ref', l: 'Reservation no.', match: /^(res|resv|reservation|reservation ?no|confirmation|conf|booking|folio)$/i },
] as const;
/** 16/10/2026, 16.10.2026, 2026-10-16, 16-Oct-26 → YYYY-MM-DD (day first, as hotel PMS reports print it). */
function toIso(v: string): string | undefined {
  const s = v.trim(); if (!s) return undefined;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s); if (m) { const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`; }
  const t = Date.parse(s); if (!Number.isNaN(t)) return new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  return s;
}

function InHouse() {
  const { base } = useHotel();
  const [q, setQ] = useState('');
  const list = useApi<any>(`${base}/breakfast/stays?scope=inhouse${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`, [q]);
  const rooms = useApi<string[]>(`${base}/breakfast/rooms`);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  const today = list.data?.day ?? new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const [f, setF] = useState({ room: '', guestName: '', adults: 2, children: 0, arrival: '', departure: '', breakfast: true, note: '' });
  const [csv, setCsv] = useState<{ head: string[]; rows: string[][] } | null>(null);
  const [map, setMap] = useState<Record<string, number>>({});
  const [replace, setReplace] = useState(true);
  const add = async (e: FormEvent) => {
    e.preventDefault(); setError(null); setOk(null);
    try {
      await api(`${base}/breakfast/stays`, { body: { ...f, arrival: f.arrival || today, departure: f.departure || tomorrow } });
      setOk(`Room ${f.room.toUpperCase()} added.`); setF({ ...f, room: '', guestName: '', note: '' }); await list.reload();
    } catch (er) { setError(er); }
  };
  const checkout = async (id: string, room: string) => {
    if (!confirm(`Room ${room}: guest left? From today the room is no longer on the breakfast list.`)) return;
    try { await api(`${base}/breakfast/stays/${id}/checkout`, { body: {} }); await list.reload(); } catch (er) { setError(er); }
  };
  const readFile = async (file: File) => {
    setError(null); setOk(null);
    const rows = parseCsv(await file.text()).filter((r) => r.some((c) => c.trim()));
    if (rows.length < 2) { setError(new Error('The file has no rows.')); return; }
    const head = rows[0]!.map((h) => h.trim());
    const m: Record<string, number> = {};
    for (const fd of FIELDS) { const i = head.findIndex((h) => fd.match.test(h)); if (i >= 0) m[fd.k] = i; }
    setMap(m); setCsv({ head, rows: rows.slice(1) });
  };
  const doImport = async () => {
    if (!csv) return;
    if (map.room === undefined) { setError(new Error('Choose which column holds the room number.')); return; }
    const val = (r: string[], k: string) => (map[k] === undefined ? undefined : (r[map[k]!] ?? '').trim());
    const rows = csv.rows.map((r) => ({
      room: val(r, 'room'), guestName: val(r, 'guestName') || null, adults: val(r, 'adults') ? Number(val(r, 'adults')) : 1, children: val(r, 'children') ? Number(val(r, 'children')) : 0,
      arrival: val(r, 'arrival') ? toIso(val(r, 'arrival')!) : undefined, departure: val(r, 'departure') ? toIso(val(r, 'departure')!) : undefined,
      breakfast: map.breakfast === undefined ? true : val(r, 'breakfast'), ref: val(r, 'ref') || undefined,
    })).filter((r) => r.room);
    setError(null); setOk(null);
    try {
      const r = await api(`${base}/breakfast/stays/import`, { body: { rows, replace } });
      setOk(`Imported: ${r.added} added, ${r.updated} updated${replace ? `, ${r.ended} no longer in house` : ''}${r.rejected ? `, ${r.rejected} rows not read (${r.errors.slice(0, 3).map((e: any) => `row ${e.row}: ${e.message}`).join('; ')})` : ''}.`);
      setCsv(null); await list.reload();
    } catch (er) { setError(er); }
  };
  const unknownRooms = (list.data?.stays ?? []).filter((s: any) => rooms.data?.length && !rooms.data.includes(s.room)).length;
  return (
    <>
      <ErrorNote error={error ?? list.error} />
      {ok && <div className="alert ok">{ok}</div>}
      <div className="cols">
        <div className="panel">
          <h2>Import from the PMS</h2>
          <p className="small muted" style={{ marginTop: 0 }}>Export the PMS "in-house guests" report as CSV (room, name, adults, children, arrival, departure, board / breakfast, reservation number) and choose it here. Guests stay on the list until their departure.</p>
          <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && void readFile(e.target.files[0])} />
          {csv && (
            <>
              <p className="small" style={{ marginTop: 10 }}>{csv.rows.length} rows. Columns:</p>
              <div className="field-row">
                {FIELDS.map((fd) => (
                  <div key={fd.k} className="field" style={{ marginBottom: 6 }}><label>{fd.l}{'required' in fd && ' *'}</label>
                    <select value={map[fd.k] ?? ''} onChange={(e) => setMap({ ...map, [fd.k]: e.target.value === '' ? undefined as any : Number(e.target.value) })}>
                      <option value="">{fd.k === 'breakfast' ? '(all with breakfast)' : fd.k === 'arrival' ? '(today)' : fd.k === 'departure' ? '(tomorrow)' : '—'}</option>
                      {csv.head.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                    </select></div>
                ))}
              </div>
              <label className="check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /><span>This file is the complete in-house list for today (rooms not in it are taken off)</span></label>
              <div className="row"><button className="btn primary" onClick={doImport}>Import {csv.rows.length} rows</button><button className="btn" onClick={() => setCsv(null)}>Cancel</button></div>
            </>
          )}
        </div>
        <form className="panel" onSubmit={add}>
          <h2>Add a room by hand</h2>
          <div className="field-row">
            <div className="field"><label htmlFor="fr">Room</label><input id="fr" list="bf-rooms" value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })} required maxLength={20} /></div>
            <div className="field"><label htmlFor="fg">Guest name</label><input id="fg" value={f.guestName} onChange={(e) => setF({ ...f, guestName: e.target.value })} maxLength={120} /></div>
          </div>
          <datalist id="bf-rooms">{(rooms.data ?? []).map((r) => <option key={r} value={r} />)}</datalist>
          <div className="field-row">
            <div className="field"><label htmlFor="fa">Adults</label><input id="fa" type="number" min={0} max={20} value={f.adults} onChange={(e) => setF({ ...f, adults: Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor="fc">Children</label><input id="fc" type="number" min={0} max={20} value={f.children} onChange={(e) => setF({ ...f, children: Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor="fd">Departure</label><input id="fd" type="date" min={tomorrow} value={f.departure || tomorrow} onChange={(e) => setF({ ...f, departure: e.target.value })} /></div>
          </div>
          <label className="check"><input type="checkbox" checked={f.breakfast} onChange={(e) => setF({ ...f, breakfast: e.target.checked })} /><span>Breakfast included in the rate</span></label>
          <button className="btn primary">Add</button>
        </form>
      </div>
      <div className="panel flush">
        <div className="row" style={{ padding: '12px 16px 0' }}>
          <h2 style={{ margin: 0 }}>In house on {today}</h2>
          <input aria-label="Search" placeholder="Room or name" value={q} onChange={(e) => setQ(e.target.value)} style={inputStyle} />
          {unknownRooms > 0 && <span className="small muted">{unknownRooms} room numbers are not doors in Visionline (check the import).</span>}
        </div>
        {!list.data ? null : !list.data.stays.length ? <div style={{ padding: 16 }}><NoData text="Nobody on the in-house list yet" hint="Import the PMS report or add rooms by hand." /></div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="grid">
              <thead><tr><th>Room</th><th>Guest</th><th className="num">Adults</th><th className="num">Children</th><th>Arrival</th><th>Departure</th><th>Breakfast</th><th>From</th><th /></tr></thead>
              <tbody>{list.data.stays.map((s: any) => (
                <tr key={s.id}><td className="tag-num">{s.room}</td><td>{s.guestName ?? '—'}</td><td className="num">{s.adults}</td><td className="num">{s.children}</td><td>{s.arrival}</td><td>{s.departure}</td>
                  <td>{s.breakfast ? 'Included' : 'Not included'}</td><td>{s.source === 'import' ? 'PMS import' : s.source === 'pms' ? 'PMS' : 'Front office'}</td>
                  <td><button className="btn small" onClick={() => checkout(s.id, s.room)}>Left</button></td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ---- Reports ----------------------------------------------------------------------------------------------------
function Reports() {
  const { base, hotel } = useHotel();
  const to0 = new Date().toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10), to: to0 });
  const r = useApi<any>(`${base}/breakfast/report?from=${range.from}&to=${range.to}`, [range.from, range.to]);
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <label htmlFor="rf">From</label><input id="rf" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} style={inputStyle} />
        <label htmlFor="rt">To</label><input id="rt" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} style={inputStyle} />
        <button className="btn" onClick={() => download(`${base}/breakfast/export.csv?from=${range.from}&to=${range.to}`, `${hotel.slug}-breakfast-${range.from}_${range.to}.csv`).catch(setError)}>Download (CSV)</button>
      </div>
      <ErrorNote error={error ?? r.error} />
      <div className="panel flush">
        {!r.data ? null : !r.data.days.some((d: any) => d.rooms) ? <div style={{ padding: 16 }}><NoData text="No breakfast days in this period" hint="Days appear once there is an in-house list." /></div> : (
          <table className="grid">
            <thead><tr><th>Day</th><th className="num">Rooms</th><th className="num">Guests</th><th className="num">In rate</th><th className="num">Served</th><th className="num">Not come</th><th className="num">Paying / walk-in</th><th>Rooms not come</th></tr></thead>
            <tbody>{r.data.days.map((d: any) => <tr key={d.day}><td className="nowrap">{d.day}</td><td className="num">{d.rooms}</td><td className="num">{d.guests}</td><td className="num">{d.expected}</td><td className="num">{d.served}</td>
              <td className="num">{d.remaining}</td><td className="num">{d.paying}</td><td className="small">{d.noShowRooms.slice(0, 20).join(', ')}{d.noShowRooms.length > 20 ? ' …' : ''}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ---- Setup -------------------------------------------------------------------------------------------------------
function Setup() {
  const { base } = useHotel();
  const s = useApi<any>(`${base}/breakfast/settings`);
  const [f, setF] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  const v = f ?? s.data;
  if (!v) return <ErrorNote error={s.error} />;
  const save = async () => {
    setError(null); setOk(null);
    try { const r = await api(`${base}/breakfast/settings`, { method: 'PUT', body: v }); setOk(`Saved (policy version ${r.version}).`); setF(null); await s.reload(); } catch (e) { setError(e); }
  };
  return (
    <div className="panel" style={{ maxWidth: 720 }}>
      <ErrorNote error={error} />
      {ok && <div className="alert ok">{ok}</div>}
      <div className="field-row">
        <div className="field"><label htmlFor="sd">Breakfast day starts at</label><input id="sd" type="time" value={v.dayStartsAt} onChange={(e) => setF({ ...v, dayStartsAt: e.target.value })} /><span className="hint">Before this time the restaurant still sees yesterday.</span></div>
        <div className="field"><label htmlFor="sf">Service from</label><input id="sf" type="time" value={v.serviceFrom} onChange={(e) => setF({ ...v, serviceFrom: e.target.value })} /></div>
        <div className="field"><label htmlFor="su">Service until</label><input id="su" type="time" value={v.serviceUntil} onChange={(e) => setF({ ...v, serviceUntil: e.target.value })} /></div>
      </div>
      <label className="check"><input type="checkbox" checked={v.countChildren} onChange={(e) => setF({ ...v, countChildren: e.target.checked })} /><span>Children count as breakfast guests</span></label>
      <label className="check"><input type="checkbox" checked={v.allowWalkIns} onChange={(e) => setF({ ...v, allowWalkIns: e.target.checked })} /><span>The restaurant may record paying guests and rooms not on the list</span></label>
      <p className="small muted">People: give the restaurant team the role "Restaurant (breakfast)" (Operators). Front office (Key Issuer) keeps the in-house list. A direct link to the PMS can later fill the list by itself.</p>
      <button className="btn primary" onClick={save} disabled={!f}>Save</button>
    </div>
  );
}
