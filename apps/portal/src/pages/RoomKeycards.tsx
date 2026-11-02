import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { auth, ApiError } from '../api';
import { useHotel, useTerms } from '../App';
import { ErrorNote, PageHead, useApi } from '../ui';

/**
 * 2.15 Keycards used per room: which keycards opened each room (or were refused) in a period, whose they are and
 * who issued them. Like the event log, it leaves the platform only as a server-made PDF with a fingerprint.
 */
interface Card { card: string; kind: string; holder: string | null; group: string | null; issuedBy: string; entries: number; refused: number; first: string; last: string; validThen: boolean | null }
interface Room { door: string; doorId: string | null; entries: number; refused: number; cards: Card[] }
const PERIODS = [{ id: '24h', l: 'Last 24 h', d: 1 }, { id: '7d', l: '7 days', d: 7 }, { id: '30d', l: '30 days', d: 30 }, { id: '90d', l: '90 days', d: 90 }] as const;

export function RoomKeycardsPage() {
  const { base, hotel } = useHotel();
  const t = useTerms();
  const [sp, setSp] = useSearchParams();
  const period = PERIODS.find((p) => p.id === sp.get('p')) ?? PERIODS[1];
  const scope = sp.get('scope') === 'all' ? 'all' : 'rooms';
  const [q, setQ] = useState('');
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); n.set(k, v); setSp(n, { replace: true }); };
  // The window is fixed when the period is chosen (not on every render).
  const range = useMemo(() => { const to = new Date(); return { from: new Date(to.getTime() - period.d * 86400_000).toISOString(), to: to.toISOString() }; }, [period.id, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const qs = new URLSearchParams({ ...range, scope }).toString();
  const r = useApi<{ tz: string; truncated: boolean; rooms: Room[]; totals: Record<string, number> }>(`${base}/reports/room-keycards?${qs}`, [qs]);
  const tz = r.data?.tz;
  const fmt = (v: string) => new Intl.DateTimeFormat(undefined, { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(v));
  const needle = q.trim().toLowerCase();
  const rooms = (r.data?.rooms ?? []).filter((x) => !needle || x.door.toLowerCase().includes(needle)
    || x.cards.some((c) => `${c.card} ${c.holder ?? ''} ${c.issuedBy} ${c.group ?? ''}`.toLowerCase().includes(needle)));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [printed, setPrinted] = useState<string | null>(null);
  const printPdf = async () => {
    setBusy(true); setError(null); setPrinted(null);
    try {
      const res = await fetch(`${base}/reports/room-keycards/pdf`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` }, body: JSON.stringify({ ...range, scope }) });
      if (!res.ok) { const j = await res.json().catch(() => null); throw new ApiError(res.status, j?.error?.code ?? 'ERROR', j?.error?.message ?? 'Printing failed'); }
      const url = URL.createObjectURL(await res.blob());
      const name = `${hotel.slug}-keycards-per-room-${new Date().toISOString().slice(0, 10)}.pdf`;
      Object.assign(document.createElement('a'), { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setPrinted(`PDF ready (${name}). Report ID ${res.headers.get('x-report-id')}. Check a copy later with "Verify a PDF" on the Event log.`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHead title="Keycards per room" intro={<>Which keycards opened each room or were refused, whose they are and who issued them. Offline locks appear once their events are uploaded to Visionline, at the time the lock recorded them.</>}>
        <button className="btn primary" disabled={busy || !r.data} onClick={printPdf}>{busy ? 'Printing…' : 'Print PDF'}</button>
      </PageHead>
      <ErrorNote error={error ?? r.error} />
      {printed && <div className="alert ok">{printed}</div>}
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="row">
            <div className="seg" role="group" aria-label="Period">{PERIODS.map((p) => <button key={p.id} aria-pressed={p.id === period.id} onClick={() => set('p', p.id)}>{p.l}</button>)}</div>
            <div className="seg" role="group" aria-label="Doors"><button aria-pressed={scope === 'rooms'} onClick={() => set('scope', 'rooms')}>{t.Rooms}</button><button aria-pressed={scope === 'all'} onClick={() => set('scope', 'all')}>All doors</button></div>
          </div>
          <input className="search" type="search" placeholder="Room, card, holder or issuer" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {r.data && (
          <div className="figures" style={{ marginBottom: 12 }}>
            <div><div className="v">{r.data.totals.rooms}</div><div className="l">{scope === 'rooms' ? 'rooms' : 'doors'} used</div></div>
            <div><div className="v">{r.data.totals.cards}</div><div className="l">keycards</div></div>
            <div><div className="v" style={{ color: 'var(--ok)' }}>{r.data.totals.entries}</div><div className="l">entries</div></div>
            <div><div className="v" style={{ color: r.data.totals.refused ? 'var(--bad)' : undefined }}>{r.data.totals.refused}</div><div className="l">refused</div></div>
          </div>
        )}
        {r.data?.truncated && <div className="alert warn">More than 20 000 door events in this period: only the newest are counted. Choose a shorter period.</div>}
        {r.data && !rooms.length && <div className="empty">No keycard was used at {scope === 'rooms' ? `one of the ${t.rooms}` : 'a door'} in this period{needle ? ' that matches the search' : ''}.</div>}
        {rooms.length > 0 && (
          <table className="grid">
            <thead><tr><th>Room / door</th><th>Card</th><th>Holder</th><th>Issued by</th><th style={{ textAlign: 'right' }}>Entries</th><th style={{ textAlign: 'right' }}>Refused</th><th>First</th><th>Last</th></tr></thead>
            <tbody>{rooms.flatMap((room) => room.cards.map((c, i) => (
              <tr key={`${room.door}-${c.card}`} style={i === 0 ? { borderTop: '2px solid var(--line)' } : undefined}>
                <td>{i === 0 ? <strong>{room.door}</strong> : null}{i === 0 && <span className="sub">{room.cards.length} card{room.cards.length === 1 ? '' : 's'}</span>}</td>
                <td>{c.card}<span className="sub">{c.kind}{c.validThen === false ? ' · not valid then' : ''}</span></td>
                <td>{c.holder ?? <span className="muted">—</span>}{c.group && <span className="sub">{c.group}</span>}</td>
                <td>{c.issuedBy}</td>
                <td style={{ textAlign: 'right' }}>{c.entries}</td>
                <td style={{ textAlign: 'right', color: c.refused ? 'var(--bad)' : undefined }}>{c.refused}</td>
                <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmt(c.first)}</td><td className="small" style={{ whiteSpace: 'nowrap' }}>{fmt(c.last)}</td>
              </tr>
            )))}</tbody>
          </table>
        )}
        <p className="small muted" style={{ marginTop: 12 }}>
          <strong>Issued by:</strong> mobile keys and keycards handled on the Keycards page show the portal user. Other keycards show "Visionline desk": the Visionline Web API does not say which desk operator encoded a card (Visionline's own card log does). Guest cards are matched to the in-house list when it is imported.
        </p>
      </div>
    </>
  );
}
