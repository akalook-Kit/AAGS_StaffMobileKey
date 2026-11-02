import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useHotel } from '../App';
import { api } from '../api';
import { ErrorNote, fmt, useApi, waitForCommand } from '../ui';

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const endOfDayIso = (d: string) => new Date(`${d}T23:59:00`).toISOString();
const day = (v?: string | null) => (v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

/**
 * 2.23 Verify a keycard at an encoder and extend it: a card brought back is placed on the encoder, Visionline says whose
 * it is and until when it works; if needed it is written again with a new expiry date (also a card that had ended:
 * "make it work again"). Used on Staff keycards (Verify & extend) and on an issued request.
 */
export function KeycardCheck({ expectRegNo, compact }: { expectRegNo?: string | null; compact?: boolean }) {
  const { base, hotel, can } = useHotel();
  const enc = useApi<any>(`${base}/keycards/encoders`);
  const names: string[] = enc.data ? (enc.data.chosen?.length ? enc.data.chosen : (enc.data.encoders ?? []).map((e: any) => e.name)) : [];
  const [encoder, setEncoder0] = useState('');
  useEffect(() => {
    if (encoder || !names.length) return;
    let v = ''; try { v = localStorage.getItem('smk.encoder') ?? ''; } catch { /* ignore */ }
    setEncoder0(names.includes(v) ? v : names[0]!);
  }, [names.join('|')]);
  const setEncoder = (v: string) => { setEncoder0(v); try { localStorage.setItem('smk.encoder', v); } catch { /* ignore */ } };
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [x, setX] = useState<any>(null);
  const [readId, setReadId] = useState<string | null>(null);
  const [until, setUntil] = useState(plusDays(180));
  const [reactivate, setReactivate] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const read = async () => {
    setError(null); setDone(null); setX(null); setReactivate(false); setBusy('Reading the card on the encoder…');
    try {
      const r = await api<any>(`${base}/keycards/check/read`, { body: { encoder } });
      setReadId(r.readId);
      const end = Date.now() + 45_000;
      for (;;) {
        await new Promise((res) => setTimeout(res, 1200));
        const c = await api<any>(`${base}/keycards/check/${r.readId}`);
        if (c.status === 'SUCCEEDED') { setX(c); break; }
        if (c.status === 'FAILED' || c.status === 'EXPIRED') throw new Error(c.error ?? 'The card could not be read. Is it lying on the encoder?');
        if (Date.now() > end) throw new Error('The connector did not answer in time.');
      }
    } catch (e) { setError(e); } finally { setBusy(null); }
  };
  const extend = async () => {
    if (!readId || !x) return;
    setError(null); setDone(null); setBusy('Writing the new expiry date: leave the card on the encoder…');
    try {
      const r = await api<any>(`${base}/keycards/check/${readId}/extend`, { body: { validUntil: endOfDayIso(until), reactivate } });
      const c = await waitForCommand(hotel.id, r.commandId, 120_000);
      if (c.status !== 'SUCCEEDED') throw new Error(c.error?.message ?? `Visionline did not answer (${c.status}).`);
      const reg = c.result?.regNo;
      setDone(`Done: the keycard${x.card.label ? ` ${x.card.label}` : ''} of ${x.card.holder ?? x.card.holderId} works until ${day(endOfDayIso(until))}${reg && reg !== x.card.regNo ? ` (Visionline card number now ${reg})` : ''}. Read it again to check.`);
      setX(null); setReadId(null);
    } catch (e) { setError(e); } finally { setBusy(null); }
  };

  const k = x?.card;
  const ended = k && !k.valid;
  return (
    <div className={compact ? '' : 'panel'}>
      {!compact && <h2>Verify a keycard and extend it</h2>}
      <p className="small muted">Place the keycard on the encoder and read it: Visionline itself says whose card it is, its doors and until when it works. Then, if needed, give it a new expiry date (the card stays on the encoder).</p>
      {enc.data && !names.length && <div className="alert warn">No encoder yet: Staff keycards → Encoders &amp; special cards → read them from Visionline, and choose them in Settings → Keycards &amp; encoders.</div>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="small muted" htmlFor="kc-enc">Encoder</label>
        <select id="kc-enc" className="search" style={{ minWidth: 150 }} value={encoder} onChange={(e) => setEncoder(e.target.value)}>{names.map((n) => <option key={n} value={n}>{n}</option>)}</select>
        <button className="btn primary" onClick={read} disabled={!encoder || Boolean(busy)}>{busy?.startsWith('Reading') ? busy : `Read the card on ${encoder || 'the encoder'}`}</button>
      </div>
      <ErrorNote error={error} />
      {busy && !busy.startsWith('Reading') && <div className="alert warn" role="status">{busy}</div>}
      {done && <div className="alert ok" role="status">{done}</div>}
      {k && (
        <div style={{ marginTop: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>Keycard {k.label ? <strong>{k.label}</strong> : null} <span className="mono small">{k.regNo}</span></h3>
            {k.valid ? <span className="pill ok">Works · until {k.expiresAt ? day(k.expiresAt) : 'no end'}</span>
              : <span className="pill bad">{k.cancelled ? 'Cancelled' : k.overridden ? 'Replaced by a newer card' : 'Ended'}{k.expiresAt ? ` · ${day(k.expiresAt)}` : ''}</span>}
          </div>
          {expectRegNo && k.regNo && expectRegNo !== k.regNo && <div className="alert warn">This is not the card of this request (expected Visionline card {expectRegNo}, read {k.regNo}).</div>}
          {k.genericName && <div className="alert warn">This keycard is in a generic name ({k.holder || k.holderId}): nobody can tell who uses it. Put it in the person's name in Visionline.</div>}
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Holder</dt><dd>{k.holder ?? k.holderId ?? '—'}{k.group ? ` · ${k.group}` : ''}</dd>
            <dt>Doors</dt><dd>{k.doors.length} door{k.doors.length === 1 ? '' : 's'}{k.doorGroups.length ? ` · door groups ${k.doorGroups.join(', ')}` : ''}{k.timeSchedule ? ` · time schedule ${k.timeSchedule}` : ''}
              {k.doors.length > 0 && <div className="chips" style={{ marginTop: 4 }}>{k.doors.slice(0, 24).map((d: string) => <span key={d} className="chip" style={{ cursor: 'default' }}>{d}</span>)}{k.doors.length > 24 && <span className="small muted">+{k.doors.length - 24}</span>}</div>}</dd>
            <dt>Issued by</dt><dd>{k.issuedBy ?? '—'}</dd>
            {k.request && <><dt>Request</dt><dd>{k.request.number} · {k.request.status.toLowerCase()}</dd></>}
            {k.registerStatus && <><dt>Register</dt><dd>{k.label} · {String(k.registerStatus).replace('_', ' ')}</dd></>}
            <dt>Read</dt><dd className="small muted">from Visionline at {x.encoder}, {fmt.dt(x.readAt)}{can('reports.read') && k.regNo ? <> · <Link to={`/visionline?tab=lookup&card=${k.regNo}`}>where it was used</Link></> : null}</dd>
          </dl>
          {x.extend.possible ? (
            <section style={{ marginTop: 12 }}>
              <h4 style={{ margin: '0 0 6px' }}>{ended ? 'Make it work again with a new expiry date' : 'Extend: new expiry date'}</h4>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {[180, 360, 730].map((n) => <button key={n} type="button" className="btn" aria-pressed={until === plusDays(n)} onClick={() => setUntil(plusDays(n))}>{n} days</button>)}
                <input type="date" className="search" aria-label="New expiry date" min={plusDays(1)} value={until} onChange={(e) => setUntil(e.target.value)} />
              </div>
              {ended && <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={reactivate} onChange={(e) => setReactivate(e.target.checked)} /> This card {k.cancelled ? 'was cancelled' : 'had ended'}: I confirm it should work again for {k.holder ?? k.holderId}.</label>}
              {k.otherValidCards > 0 && <p className="small" style={{ color: 'var(--warn-ink, #8a5a00)' }}>{k.holder ?? 'This person'} has {k.otherValidCards} other valid staff card{k.otherValidCards === 1 ? '' : 's'}: Visionline keeps one staff card per person, so {k.otherValidCards === 1 ? 'it stops' : 'they stop'} working.</p>}
              <p className="small muted">Same holder, doors and door groups; only the expiry date changes. Leave the card on {x.encoder}.</p>
              <button className="btn primary" disabled={Boolean(busy) || !until || (ended && !reactivate)} onClick={extend}>{ended ? 'Make it work until' : 'Extend to'} {until ? day(endOfDayIso(until)) : '…'}</button>
            </section>
          ) : x.extend.blockers.length > 0 && <div className="alert" style={{ marginTop: 10 }}><strong>Cannot be extended here:</strong><ul style={{ margin: '4px 0 0 18px' }}>{x.extend.blockers.map((b: string) => <li key={b}>{b}</li>)}</ul></div>}
        </div>
      )}
    </div>
  );
}
