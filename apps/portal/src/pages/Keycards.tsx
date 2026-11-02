import { useEffect, useState } from 'react';
import { VerifyCard } from '../components/VerifyCard';
import { KeycardCheck } from '../components/KeycardCheck';
import { useHotel, useTerms } from '../App';
import { api, download } from '../api';
import { Drawer, ErrorNote, PageHead, Status, fmt, useApi, waitForCommand } from '../ui';

type Tab = 'requests' | 'verify' | 'register' | 'attention' | 'lockouts' | 'departures' | 'encoders';
const KIND: Record<string, string> = { new: 'New keycard', replacement: 'Replacement', cancel: 'Cancellation' };
const ST: Record<string, string> = { SUBMITTED: 'Waiting', ISSUED: 'Issued', REJECTED: 'Rejected', COLLECTED: 'Returned / cancelled', CANCELLED: 'Cancelled', WITHDRAWN: 'Withdrawn' };

/**
 * 2.14 Staff keycards: requests (also from the QR page), issuing them in Visionline, the register (HK 001…),
 * returns on resignation, renewal reminders, holders with several cards, unpaid-guest lock-outs, encoders and
 * special cards.
 */
export function KeycardsPage() {
  const { can } = useHotel();
  const t = useTerms();
  const [tab0, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get('tab') as Tab) ?? 'requests');
  const tabs: [Tab, string, boolean][] = [['requests', 'Requests', true], ['verify', 'Verify & extend', can('keycards.read') || can('keycards.manage')], ['register', 'Register', can('keycards.read')], ['attention', 'Renewals & duplicates', can('keycards.read')],
    ['lockouts', 'Unpaid guests', !t.institution && (can('lockout.request') || can('lockout.approve'))], ['departures', 'Departures', !t.institution && can('lockout.request')], ['encoders', 'Encoders & special cards', can('keycards.read')]];
  // 2.16 Guest features (unpaid guests, departures) are for hotels only.
  const tab = tabs.some((x) => x[0] === tab0 && x[2]) ? tab0 : 'requests';
  return (
    <>
      <PageHead title="Staff keycards" intro="Requests for staff keycards and their cancellation, the cards in use and who holds them. Every card is made in Visionline, the key system." />
      <div className="seg" role="tablist" style={{ marginBottom: 16 }}>
        {tabs.filter((t) => t[2]).map(([id, l]) => <button key={id} role="tab" aria-pressed={tab === id} onClick={() => { setTab(id); try { history.replaceState(null, '', `?tab=${id}`); } catch { /* ignore */ } }}>{l}</button>)}
      </div>
      {tab === 'requests' && <Requests />}
      {tab === 'verify' && <KeycardCheck />}
      {tab === 'register' && <Register />}
      {tab === 'attention' && <Attention />}
      {tab === 'lockouts' && <Lockouts />}
      {tab === 'departures' && <Departures />}
      {tab === 'encoders' && <Encoders />}
    </>
  );
}

function Requests() {
  const { base, can } = useHotel();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const list = useApi<any[]>(`${base}/keycards/requests?${new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}) })}`, [q, status], 20_000);
  const [open, setOpen] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="search" placeholder="Name, number, card or department" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <select className="search" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">All</option>{Object.entries(ST).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        {can('keycards.request') && <button className="btn primary" onClick={() => setAdding(true)}>New request</button>}
        {can('keycards.manage') && <button className="btn" onClick={() => api(`${base}/keycards/qr-link`, { body: {} }).then((r) => setQr(`${location.origin}${r.path}`)).catch(setError)}>QR code page</button>}
      </div>
      <ErrorNote error={error ?? list.error} />
      {qr && <QrPanel url={qr} onClose={() => setQr(null)} />}
      <div className="panel flush"><div className="table-scroll">
        {list.data && !list.data.length ? <div className="empty">No requests yet. Managers can ask from the portal or from the QR code page.</div> : (
          <table className="grid"><thead><tr><th>Number</th><th>Person</th><th>Request</th><th>Card</th><th>Manager</th><th>Status</th><th>Issued by</th><th>When</th></tr></thead>
            <tbody>{(list.data ?? []).map((r) => (
              <tr key={r.id} className="click" onClick={() => setOpen(r)}>
                <td className="nowrap"><strong>{r.number}</strong>{r.source === 'qr' && <div className="small muted">QR page</div>}</td>
                <td><strong>{r.givenName} {r.surname}</strong><div className="small muted">{r.department}{r.employeeNo ? ` · ${r.employeeNo}` : ''}</div></td>
                <td>{KIND[r.kind]}<div className="small muted">{r.staffType === 'daily' ? 'Daily staff' : 'Permanent'}{r.quantity > 1 ? ` · ${r.quantity} cards` : ''}</div></td>
                <td className="nowrap">{r.cardLabel ?? <span className="muted">—</span>}{r.cardRegNo && <div className="small muted">VL {r.cardRegNo}</div>}</td>
                <td className="small">{r.managerName}</td>
                <td><span className={`pill ${r.status === 'SUBMITTED' ? 'warn' : ['ISSUED', 'COLLECTED'].includes(r.status) ? 'ok' : ''}`}>{ST[r.status] ?? r.status}</span></td>
                <td className="small">{r.issuedBy ? <>{r.issuedBy}{r.vlOperator && <div className="muted">Visionline: {r.vlOperator}</div>}</> : <span className="muted">—</span>}</td>
                <td className="small">{fmt.dt(r.createdAt)}</td>
              </tr>))}</tbody></table>)}
      </div></div>
      {adding && <RequestForm onClose={(ok) => { setAdding(false); if (ok) void list.reload(); }} />}
      {open && <RequestDrawer r={open} onClose={() => { setOpen(null); void list.reload(); }} />}
    </>
  );
}

/** A QR code drawn in the browser (no outside service): staff scan it to open the request page. */
function QrPanel({ url, onClose }: { url: string; onClose: () => void }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => { void import('../components/qr').then((m) => setSvg(m.qrSvg(url))); }, [url]);
  return (
    <div className="panel">
      <h2>Keycard request page</h2>
      <p className="muted small">Print this and put it in the back office. Anyone with the link can ask (requests still need approval here). Making a new link stops the old one.</p>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {svg && <div className="qr-box" dangerouslySetInnerHTML={{ __html: svg }} />}
        <div><code style={{ wordBreak: 'break-all' }}>{url}</code><div className="row" style={{ marginTop: 10 }}><button className="btn" onClick={() => window.print()}>Print</button><button className="btn" onClick={() => navigator.clipboard?.writeText(url)}>Copy link</button><button className="btn" onClick={onClose}>Close</button></div></div>
      </div>
    </div>
  );
}

export function RequestFields({ v, set, prefixes }: { v: any; set: (p: any) => void; prefixes?: string[] }) {
  const f = (k: string) => (e: { target: { value: string } }) => set({ [k]: e.target.value });
  return (
    <>
      <div className="row" style={{ marginBottom: 12, gap: 8 }}>
      <div className="seg" role="radiogroup" aria-label="Request">
        {(['new', 'replacement', 'cancel'] as const).map((k) => <button type="button" key={k} aria-pressed={v.kind === k} onClick={() => set({ kind: k })}>{KIND[k]}</button>)}
      </div>
      <div className="seg" role="radiogroup" aria-label="Staff">
        <button type="button" aria-pressed={v.staffType === 'permanent'} onClick={() => set({ staffType: 'permanent' })}>Permanent staff</button>
        <button type="button" aria-pressed={v.staffType === 'daily'} onClick={() => set({ staffType: 'daily' })}>Daily staff</button>
      </div>
      </div>
      <div className="field-row">
        <div className="field"><label htmlFor="kr-g">First name</label><input id="kr-g" required maxLength={60} value={v.givenName ?? ''} onChange={f('givenName')} /></div>
        <div className="field"><label htmlFor="kr-s">Surname</label><input id="kr-s" required maxLength={60} value={v.surname ?? ''} onChange={f('surname')} /></div>
      </div>
      <div className="field-row">
        <div className="field"><label htmlFor="kr-d">Department</label><input id="kr-d" required maxLength={80} value={v.department ?? ''} onChange={f('department')} placeholder="Housekeeping" /></div>
        <div className="field"><label htmlFor="kr-j">Job title</label><input id="kr-j" maxLength={80} value={v.jobTitle ?? ''} onChange={f('jobTitle')} /></div>
      </div>
      <div className="field-row">
        <div className="field"><label htmlFor="kr-e">Employee number</label><input id="kr-e" maxLength={40} value={v.employeeNo ?? ''} onChange={f('employeeNo')} /></div>
        <div className="field"><label htmlFor="kr-l">Card number {v.staffType === 'permanent' && v.kind !== 'new' ? '' : '(if known)'}</label><input id="kr-l" maxLength={12} value={v.cardLabel ?? ''} onChange={f('cardLabel')} placeholder={`${prefixes?.[0] ?? 'HK'} 001`} />
          <span className="hint">The number written on the card. Required for permanent staff when the card is issued.</span></div>
      </div>
      {v.staffType === 'daily' && v.kind !== 'cancel' && <div className="field" style={{ maxWidth: 200 }}><label htmlFor="kr-q">How many cards</label><input id="kr-q" type="number" min={1} max={50} value={v.quantity ?? 1} onChange={(e) => set({ quantity: Number(e.target.value) })} /></div>}
      <div className="field-row">
        <div className="field"><label htmlFor="kr-m">Manager asking</label><input id="kr-m" required maxLength={80} value={v.managerName ?? ''} onChange={f('managerName')} placeholder="Housekeeping manager's name" /></div>
        <div className="field"><label htmlFor="kr-h">HR e-mail (optional)</label><input id="kr-h" type="email" value={v.hrEmail ?? ''} onChange={f('hrEmail')} /></div>
      </div>
      {v.kind !== 'cancel' && <div className="field" style={{ maxWidth: 260 }}><label htmlFor="kr-x">Expiry date</label><input id="kr-x" type="date" min={todayDate()} value={v.validUntilDate ?? ''} onChange={f('validUntilDate')} />
        <span className="hint">The card stops working at the end of this day. Empty: {v.staffType === 'daily' ? 'the end of the shift (Settings)' : 'the period set in Settings (one year by default)'}.</span></div>}
      <div className="field"><label htmlFor="kr-r">Reason</label><input id="kr-r" required maxLength={300} value={v.reason ?? ''} onChange={f('reason')} placeholder={v.kind === 'cancel' ? 'Resigned, last day 31 Oct' : 'New starter, Housekeeping floor 2'} /></div>
    </>
  );
}
/** 2.20 Expiry is chosen as a date (Armel, 31 Oct): the card works until the end of that day, hotel computer's time. */
export const todayDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const endOfDay = (d: string) => new Date(`${d}T23:59:00`).toISOString();
const isoToDate = (iso: string | null | undefined) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const clean = ({ validUntilDate, ...v }: any) => ({ ...v, validUntil: validUntilDate ? endOfDay(validUntilDate) : null, jobTitle: v.jobTitle || null, employeeNo: v.employeeNo || null, cardLabel: v.cardLabel || null, hrEmail: v.hrEmail || null, quantity: Number(v.quantity ?? 1) });

function RequestForm({ onClose }: { onClose: (ok: boolean) => void }) {
  const { base } = useHotel();
  const [v, setV] = useState<any>({ kind: 'new', staffType: 'permanent', quantity: 1 });
  const [error, setError] = useState<unknown>(null);
  const save = async () => { setError(null); try { await api(`${base}/keycards/requests`, { body: clean(v) }); onClose(true); } catch (e) { setError(e); } };
  return (
    <Drawer title="New keycard request" onClose={() => onClose(false)} footer={<><span /><div className="row"><button className="btn" onClick={() => onClose(false)}>Cancel</button><button className="btn primary" onClick={save}>Send request</button></div></>}>
      <ErrorNote error={error} />
      <RequestFields v={v} set={(p) => setV({ ...v, ...p })} />
    </Drawer>
  );
}

function RequestDrawer({ r, onClose }: { r: any; onClose: () => void }) {
  const { base, hotel, can } = useHotel();
  const groups = useApi<any[]>(`${base}/resources?kind=usergroup`);
  const enc = useApi<any>(`${base}/keycards/encoders`);
  const [method, setMethod] = useState<'encoder' | 'visionline_desk' | 'existing'>('visionline_desk');
  // 2.17 The person (or their keycard) may already be in Visionline: pick it instead of making a new one.
  const [vlUser, setVlUser] = useState<{ id: string; name: string | null; group: string | null } | null>(null);
  const [encoder, setEncoder] = useState('');
  const [label, setLabel] = useState(r.cardLabel ?? '');
  const [group, setGroup] = useState('');
  const [regNo, setRegNo] = useState(r.cardRegNo ?? '');
  // 2.21 Issued from Visionline: which Visionline operator made it (empty = the user's own Visionline operator).
  const [vlOp, setVlOp] = useState('');
  const [checkOpen, setCheckOpen] = useState(false);
  const vlOps = useApi<any[]>(`${base}/visionline/operators`);
  const [until, setUntil] = useState(isoToDate(r.validUntil));
  const [ret, setRet] = useState('returned');
  const [cmethod, setCmethod] = useState<'expire_now' | 'cancel_card' | 'visionline_desk'>('cancel_card');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => { if (enc.data?.encodeEnabled) { setMethod('encoder'); setEncoder(enc.data.chosen?.[0] ?? ''); setCmethod('expire_now'); } }, [enc.data]);
  const manage = can('keycards.manage');
  const wait = async (commandId: string, msg: string) => {
    setBusy('Waiting for Visionline…');
    const c = await waitForCommand(hotel.id, commandId, 90_000);
    setBusy(null);
    if (c.status === 'SUCCEEDED') setOk(msg); else setError(new Error(c.error?.message ?? `Visionline did not answer (${c.status}).`));
  };
  const issue = async () => {
    setError(null); setOk(null);
    try {
      const x = await api(`${base}/keycards/requests/${r.id}/issue`, { body: { method, encoder: encoder || undefined, cardLabel: label || null, userGroup: group || 'n/a', regNo: regNo || null, vlUserId: vlUser?.id ?? null, vlOperator: method === 'visionline_desk' && vlOp.trim() ? vlOp.trim() : null, validUntil: until ? endOfDay(until) : null, replaceExisting: r.kind === 'replacement' } });
      if (x.commandId) await wait(x.commandId, 'Card encoded in Visionline. Give it to the person.'); else setOk('Recorded as issued.');
    } catch (e) { setBusy(null); setError(e); }
  };
  const collect = async () => {
    setError(null); setOk(null);
    try {
      const x = await api(`${base}/keycards/requests/${r.id}/collect`, { body: { returnState: ret, method: cmethod, encoder: encoder || undefined, regNo: regNo || null } });
      if (x.commandId) await wait(x.commandId, 'Card cancelled in Visionline. HR and security are told by e-mail.'); else setOk('Recorded. HR and security are told by e-mail.');
    } catch (e) { setBusy(null); setError(e); }
  };
  const act = (f: () => Promise<unknown>, msg: string) => async () => { setError(null); setOk(null); try { await f(); setOk(msg); } catch (e) { setError(e); } };
  const userGroups = (groups.data ?? []).map((g: any) => g.external_id ?? g.name);
  return (
    <Drawer title={`${r.number} · ${r.givenName} ${r.surname}`} onClose={onClose}>
      <ErrorNote error={error} />
      {ok && <div className="alert ok">{ok}</div>}
      {busy && <div className="alert warn">{busy}</div>}
      <dl className="kv">
        <dt>Request</dt><dd>{KIND[r.kind]} · {r.staffType === 'daily' ? 'daily staff' : 'permanent staff'}{r.quantity > 1 ? ` · ${r.quantity} cards` : ''}</dd>
        <dt>Status</dt><dd>{ST[r.status] ?? r.status}</dd>
        <dt>Department</dt><dd>{r.department}{r.jobTitle ? ` · ${r.jobTitle}` : ''}</dd>
        <dt>Employee no.</dt><dd>{r.employeeNo ?? '—'}</dd>
        <dt>Card</dt><dd>{r.cardLabel ?? '—'}{r.cardRegNo ? ` · Visionline ${r.cardRegNo}` : ''}</dd>
        {r.cardRegNo && (can('reports.read') || can('keycards.read')) ? <><dt>In Visionline</dt><dd><VerifyCard key={r.cardRegNo} regNo={r.cardRegNo} label="Verify keycard" /></dd></> : null}
        {r.issuedBy && <><dt>Issued by</dt><dd>{r.issuedBy}{r.issuedAt ? ` · ${fmt.dt(r.issuedAt)}` : ''} · {r.issueMethod === 'encoder' ? 'encoded from the portal' : r.issueMethod === 'visionline_desk' ? `issued from Visionline${r.vlOperator ? ` by operator ${r.vlOperator}` : ''}` : 'existing keycard linked'}</dd></>}
        <dt>Manager</dt><dd>{r.managerName}</dd>
        <dt>Reason</dt><dd>{r.reason}</dd>
      </dl>
      {manage && r.kind !== 'cancel' && ['SUBMITTED', 'ISSUED'].includes(r.status) && (
        <section style={{ marginTop: 16 }}>
          <h3>Issue the keycard</h3>
          <div className="seg" style={{ marginBottom: 10 }}>
            <button aria-pressed={method === 'encoder'} disabled={!enc.data?.encodeEnabled} onClick={() => setMethod('encoder')} title={enc.data?.encodeEnabled ? '' : 'Switched off in Settings -> Keycards'}>Encode here</button>
            <button aria-pressed={method === 'visionline_desk'} onClick={() => setMethod('visionline_desk')}>Issued from Visionline</button>
            <button aria-pressed={method === 'existing'} onClick={() => setMethod('existing')} title="The person already holds a keycard in Visionline">Existing keycard</button>
          </div>
          <VlPicker mode={method === 'existing' ? 'card' : 'person'} initial={`${r.givenName} ${r.surname}`}
            onPerson={(p) => { setVlUser(p); if (p?.group) setGroup(p.group); }}
            onCard={(c) => { setRegNo(c.regNo); if (c.group) setGroup(c.group); if (c.holder) setVlUser({ id: c.holder, name: c.name, group: c.group }); }}
            selected={method === 'existing' ? (regNo ? `Keycard ${regNo}` : null) : vlUser ? `${vlUser.name ?? vlUser.id}${vlUser.group ? ` · ${vlUser.group}` : ''}` : null} />
          <div className="field-row">
            <div className="field"><label htmlFor="i-l">Card number</label><input id="i-l" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="HK 001" /></div>
            <div className="field"><label htmlFor="i-g">Visionline user group</label><select id="i-g" value={group} onChange={(e) => setGroup(e.target.value)}><option value="">Choose…</option>{userGroups.map((g: string) => <option key={g}>{g}</option>)}</select></div>
          </div>
          <div className="field-row">
            {method === 'existing' ? null : method === 'encoder' ? <div className="field"><label htmlFor="i-e">Encoder</label><select id="i-e" value={encoder} onChange={(e) => setEncoder(e.target.value)}>{(enc.data?.chosen ?? []).map((n: string) => <option key={n}>{n}</option>)}</select><span className="hint">Place a blank card on it first.</span></div>
              : <><div className="field"><label htmlFor="i-r">Visionline card number (optional)</label><input id="i-r" value={regNo} onChange={(e) => setRegNo(e.target.value.replace(/\D/g, ''))} /></div>
                <div className="field"><label htmlFor="i-o">Visionline operator who made it</label><input id="i-o" list="i-o-list" value={vlOp} onChange={(e) => setVlOp(e.target.value)} maxLength={80} placeholder="You (your Visionline operator)" />
                  <datalist id="i-o-list">{(vlOps.data ?? []).map((o: any) => <option key={o.name} value={o.name}>{o.portalUser ? o.portalUser.name : ''}</option>)}</datalist>
                  <span className="hint">Shown as "Issued from Visionline · operator (person)" wherever the card appears.</span></div></>}
            <div className="field"><label htmlFor="i-u">Expiry date</label><input id="i-u" type="date" min={todayDate()} value={until} onChange={(e) => setUntil(e.target.value)} /><span className="hint">Empty: {r.staffType === 'daily' ? 'end of the shift (Settings)' : 'one year (Settings)'}.</span></div>
          </div>
          <button className="btn primary" disabled={(method === 'existing' ? !regNo : !group) || Boolean(busy)} onClick={issue}>{method === 'encoder' ? 'Encode the card' : method === 'existing' ? 'Link this keycard' : 'Record as issued'}</button>
          {r.status === 'SUBMITTED' && <button className="btn" style={{ marginLeft: 8 }} onClick={act(() => api(`${base}/keycards/requests/${r.id}/reject`, { body: { reason: prompt('Why is it rejected?') ?? '' } }), 'Rejected.')}>Reject</button>}
        </section>
      )}
      {r.status === 'ISSUED' && r.kind !== 'cancel' && (can('keycards.read') || manage) && (
        <details style={{ marginTop: 16 }} open={checkOpen} onToggle={(e) => setCheckOpen((e.target as HTMLDetailsElement).open)}>
          <summary><strong>Verify this keycard at an encoder, or extend it</strong></summary>
          {checkOpen && <KeycardCheck compact expectRegNo={r.cardRegNo} />}
        </details>
      )}
      {manage && (r.kind === 'cancel' || r.status === 'ISSUED') && !['COLLECTED', 'REJECTED'].includes(r.status) && (
        <section style={{ marginTop: 16 }}>
          <h3>Return and cancel the keycard</h3>
          <div className="field-row">
            <div className="field"><label htmlFor="c-s">The card was</label><select id="c-s" value={ret} onChange={(e) => setRet(e.target.value)}><option value="returned">Returned</option><option value="lost">Lost</option><option value="damaged">Damaged</option><option value="not_returned">Not returned</option></select></div>
            <div className="field"><label htmlFor="c-m">Stop it by</label><select id="c-m" value={cmethod} onChange={(e) => setCmethod(e.target.value as any)}>
              <option value="expire_now" disabled={!enc.data?.encodeEnabled || ret !== 'returned'}>Overwriting it at the encoder (expires in 1 minute)</option>
              <option value="cancel_card">Cancelling its number in Visionline</option><option value="visionline_desk">Done in Visionline</option></select></div>
          </div>
          {cmethod === 'expire_now' ? <div className="field" style={{ maxWidth: 260 }}><label htmlFor="c-e">Encoder</label><select id="c-e" value={encoder} onChange={(e) => setEncoder(e.target.value)}>{(enc.data?.chosen ?? []).map((n: string) => <option key={n}>{n}</option>)}</select><span className="hint">Place the returned card on it.</span></div>
            : cmethod === 'cancel_card' && <div className="field" style={{ maxWidth: 260 }}><label htmlFor="c-r">Visionline card number</label><input id="c-r" value={regNo} onChange={(e) => setRegNo(e.target.value.replace(/\D/g, ''))} /></div>}
          <p className="small muted">HR{r.hrEmail ? ` (${r.hrEmail})` : ''} and the security manager get an e-mail when it is done.</p>
          <button className="btn danger-solid" disabled={Boolean(busy)} onClick={collect}>Cancel the keycard</button>
        </section>
      )}
      <div className="row" style={{ marginTop: 16 }}><button className="btn" onClick={act(() => api(`${base}/keycards/requests/${r.id}/share`, { body: {} }), 'Sent to HR.')}>Send to HR</button></div>
      <h3 style={{ marginTop: 16 }}>History</h3>
      <ul className="timeline">{(r.history ?? []).map((h: any, i: number) => <li key={i}><time>{fmt.dt(h.at)}</time> · {h.by}: {h.what}</li>)}
        {(r.notified ?? []).map((n: any, i: number) => <li key={`n${i}`}><time>{fmt.dt(n.at)}</time> · e-mail to {n.to}: {n.ok ? 'sent' : `not sent (${n.error})`}</li>)}</ul>
    </Drawer>
  );
}

function Register() {
  const { base } = useHotel();
  const reg = useApi<any[]>(`${base}/keycards/register`);
  const [q, setQ] = useState('');
  const rows = (reg.data ?? []).filter((r) => !q || `${r.label} ${r.holder ?? ''} ${r.department ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="search" placeholder="Card number, name or department" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <button className="btn" onClick={() => download(`${base}/keycards/register.csv`, 'keycard-register.csv')}>Export for HR (CSV)</button>
      </div>
      <ErrorNote error={reg.error} />
      <div className="panel flush"><div className="table-scroll">
        {reg.data && !rows.length ? <div className="empty">No numbered cards yet. They are added when a request is issued with a card number.</div> : (
          <table className="grid"><thead><tr><th>Card</th><th>Holder</th><th>Department</th><th>Type</th><th>Visionline card</th><th>Issued by</th><th>Valid until</th><th>Status</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.label}><td><strong>{r.label}</strong></td><td>{r.holder ?? '—'}</td><td>{r.department ?? '—'}</td><td>{r.staffType === 'daily' ? 'Daily' : 'Permanent'}</td>
              <td>{r.regNo ?? '—'}</td><td className="small">{r.issuedBy ?? '—'}{r.issuedAt && <div className="muted">{fmt.dt(r.issuedAt)}</div>}</td><td className="small">{r.expiresAt ? fmt.dt(r.expiresAt) : '—'}</td><td><span className={`pill ${r.status === 'in_use' ? 'ok' : r.status === 'lost' ? 'bad' : ''}`}>{r.status.replace('_', ' ')}</span></td></tr>)}</tbody></table>)}
      </div></div>
    </>
  );
}

function Attention() {
  const { base } = useHotel();
  const [days, setDays] = useState(30);
  const a = useApi<any>(`${base}/keycards/attention?days=${days}`, [days]);
  return (
    <>
      <ErrorNote error={a.error} />
      <div className="cols">
        <section className="panel">
          <h2>Keycards to renew</h2>
          <div className="seg" style={{ marginBottom: 10 }}>{[7, 30, 60].map((d) => <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>Within {d} days</button>)}</div>
          {a.data?.expiring?.length ? <table className="grid"><thead><tr><th>Holder</th><th>Group</th><th>Card</th><th>Ends</th></tr></thead>
            <tbody>{a.data.expiring.map((x: any) => <tr key={x.regNo}><td>{x.name}</td><td className="small">{x.group}</td><td className="small">{x.label ?? x.regNo}</td><td className="small nowrap">{fmt.dt(x.expiresAt)}</td></tr>)}</tbody></table>
            : <p className="empty">No staff keycard ends in this period.</p>}
          <p className="small muted">Ask the manager to request a renewal (Requests → New request → Replacement). Keycards read from Visionline (Settings → Reports & sync).</p>
        </section>
        <section className="panel">
          <h2>People with more than one card</h2>
          {a.data?.several?.length ? <table className="grid"><thead><tr><th>Holder</th><th>Group</th><th>Cards</th></tr></thead>
            <tbody>{a.data.several.map((x: any) => <tr key={x.holder}><td>{x.name}</td><td className="small">{x.group}</td><td className="small">{x.cards}: {x.regNos.join(', ')}</td></tr>)}</tbody></table>
            : <p className="empty">Nobody holds more than one valid staff keycard.</p>}
          <p className="small muted">To keep one: make a Replacement request; the new card is encoded with "override", which cancels every older card of that person in Visionline.</p>
        </section>
      </div>
      <section className={`panel${a.data?.generic?.length ? ' panel-warn' : ''}`}>
        <h2>Keycards in a generic name</h2>
        {a.data?.generic?.length ? <>
          <div className="alert warn"><strong>{a.data.generic.length} valid staff keycard{a.data.generic.length === 1 ? '' : 's'}</strong> {a.data.generic.length === 1 ? 'is' : 'are'} held under a name that is not a person ("Staff", "HK 2", "Spare", a number…). Nobody can tell who used {a.data.generic.length === 1 ? 'it' : 'them'} at a door. Issue each card in the name of the person who holds it, or cancel it.</div>
          <table className="grid"><thead><tr><th>Name in Visionline</th><th>Group</th><th>Card</th><th>Ends</th></tr></thead>
            <tbody>{a.data.generic.map((x: any) => <tr key={x.regNo}><td><strong>{x.name || '(no name)'}</strong></td><td className="small">{x.group ?? '—'}</td><td className="small">{x.regNo}</td><td className="small nowrap">{x.expiresAt ? fmt.dt(x.expiresAt) : 'no end date'}</td></tr>)}</tbody></table>
        </> : <p className="empty">Every valid staff keycard is in a person's name.</p>}
        <p className="small muted">Administrators are told through Monitoring while such cards exist.</p>
      </section>
    </>
  );
}

function Lockouts() {
  const { base, can, me } = useHotel();
  const list = useApi<any[]>(`${base}/lockouts`, [], 15_000);
  const enc = useApi<any>(can('keycards.read') ? `${base}/keycards/encoders` : null);
  const [v, setV] = useState<any>({});
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = (f: () => Promise<unknown>, msg: string) => async () => { setError(null); setOk(null); try { await f(); setOk(msg); await list.reload(); } catch (e) { setError(e); } };
  const ST2: Record<string, string> = { REQUESTED: 'Waiting for approval', APPROVED: 'Sent to the lock', REJECTED: 'Rejected', DONE: 'Locked out', RESTORED: 'Settled', FAILED: 'Failed' };
  return (
    <>
      <ErrorNote error={error ?? list.error} />
      {ok && <div className="alert ok">{ok}</div>}
      {can('lockout.request') && (
        <section className="panel">
          <h2>Lock out a guest who has not paid</h2>
          <p className="muted small">A manager approves it. Online lock: a checkout command (the guest's cards stop at once). Offline lock: a 1-minute card is encoded for the room; place it in the lock and the guest's cards stop working.</p>
          <div className="field-row">
            <div className="field"><label htmlFor="lo-r">Room</label><input id="lo-r" value={v.room ?? ''} onChange={(e) => setV({ ...v, room: e.target.value })} /></div>
            <div className="field"><label htmlFor="lo-g">Guest</label><input id="lo-g" value={v.guestName ?? ''} onChange={(e) => setV({ ...v, guestName: e.target.value })} /></div>
            <div className="field"><label htmlFor="lo-a">Amount due</label><input id="lo-a" value={v.amount ?? ''} onChange={(e) => setV({ ...v, amount: e.target.value })} /></div>
          </div>
          <div className="field"><label htmlFor="lo-x">Reason</label><input id="lo-x" value={v.reason ?? ''} onChange={(e) => setV({ ...v, reason: e.target.value })} placeholder="Two nights unpaid, guest informed at 10:00" /></div>
          <button className="btn primary" disabled={!v.room || !v.reason} onClick={run(() => api(`${base}/lockouts`, { body: v }).then(() => setV({})), 'Sent for approval.')}>Ask for approval</button>
        </section>
      )}
      <div className="panel flush"><div className="table-scroll">
        {list.data && !list.data.length ? <div className="empty">No lock-outs.</div> : (
          <table className="grid"><thead><tr><th>When</th><th>Room</th><th>Guest</th><th>Amount</th><th>Reason</th><th>Status</th><th /></tr></thead>
            <tbody>{(list.data ?? []).map((l) => (
              <tr key={l.id}><td className="small nowrap">{fmt.dt(l.createdAt)}</td><td><strong>{l.room}</strong><div className="small muted">{l.doorOnline ? 'online lock' : 'offline lock'}</div></td><td>{l.guestName ?? '—'}</td><td>{l.amount ?? '—'}</td><td className="small">{l.reason}<div className="muted">by {l.requestedBy}{l.approvedBy ? `, approved by ${l.approvedBy}` : ''}</div></td>
                <td><span className={`pill ${l.status === 'DONE' ? 'ok' : l.status === 'REQUESTED' ? 'warn' : l.status === 'FAILED' ? 'bad' : ''}`}>{ST2[l.status]}</span>{l.status === 'DONE' && l.method === 'card_offline' && <div className="small">Place the card in the lock of {l.room}</div>}</td>
                <td className="nowrap">{l.status === 'REQUESTED' && can('lockout.approve') && l.requestedById !== me.id && <>
                  <button className="btn small primary" onClick={run(() => api(`${base}/lockouts/${l.id}/decide`, { body: { approve: true, encoder: enc.data?.chosen?.[0] } }), 'Approved and sent.')}>Approve</button>{' '}
                  <button className="btn small" onClick={run(() => api(`${base}/lockouts/${l.id}/decide`, { body: { approve: false, note: prompt('Note') ?? undefined } }), 'Rejected.')}>Reject</button></>}
                  {['DONE', 'FAILED', 'APPROVED'].includes(l.status) && can('lockout.request') && <button className="btn small" onClick={run(() => api(`${base}/lockouts/${l.id}/restore`, { body: { note: prompt('Settled how? (receipt number)') ?? '' } }), 'Closed as settled. Issue a new key in Opera.')}>Settled</button>}</td></tr>))}</tbody></table>)}
      </div></div>
    </>
  );
}

function Encoders() {
  const { base, hotel, can } = useHotel();
  const e = useApi<any>(`${base}/keycards/encoders`);
  const doors = useApi<any[]>(`${base}/resources?kind=door`);
  const [sp, setSp] = useState<any>({ kind: 'emergency', holder: '' });
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => { setError(null); try { const r = await api(`${base}/keycards/encoders/refresh`, { body: {} }); setBusy(true); const c = await waitForCommand(hotel.id, r.commandId, 60_000); setBusy(false); if (c.status !== 'SUCCEEDED') throw new Error(c.error?.message ?? 'No answer'); await e.reload(); setOk('Encoders read from Visionline.'); } catch (x) { setBusy(false); setError(x); } };
  const special = async () => {
    setError(null); setOk(null);
    try { const r = await api(`${base}/keycards/special`, { body: { ...sp, doorIds: sp.doorIds ?? [], expireTime: sp.until ? new Date(sp.until).toISOString() : undefined } }); setBusy(true); const c = await waitForCommand(hotel.id, r.commandId, 90_000); setBusy(false); if (c.status !== 'SUCCEEDED') throw new Error(c.error?.message ?? 'No answer'); setOk('Card encoded.'); } catch (x) { setBusy(false); setError(x); }
  };
  return (
    <>
      <ErrorNote error={error ?? e.error} />
      {ok && <div className="alert ok">{ok}</div>}
      {busy && <div className="alert warn">Waiting for Visionline…</div>}
      <div className="cols">
        <section className="panel">
          <h2>Encoders</h2>
          <p className="small muted">Read from Visionline. Choose the ones the portal may use in Settings → Keycards (encoding from the portal is {e.data?.encodeEnabled ? 'on' : 'off'}).</p>
          <table className="grid"><thead><tr><th>Encoder</th><th>In Visionline</th><th>Used here</th><th>Last use</th></tr></thead>
            <tbody>{(e.data?.encoders ?? []).map((x: any) => <tr key={x.name}><td><strong>{x.name}</strong></td><td>{x.inVisionline ? 'Yes' : 'Not found'}</td><td>{x.chosen ? 'Yes' : '—'}</td>
              <td className="small">{x.last ? <><Status s={x.last.status} /> {fmt.dt(x.last.at)}{x.last.error ? ` · ${x.last.error}` : ''}</> : 'never'}</td></tr>)}</tbody></table>
          {can('keycards.manage') && <button className="btn" style={{ marginTop: 10 }} onClick={refresh}>Read encoders from Visionline</button>}
        </section>
        {can('keycards.manage') && (
          <section className="panel">
            <h2>Special cards</h2>
            <div className="seg" style={{ marginBottom: 10 }}>{[['emergency', 'Emergency'], ['standOpen', 'Stand open'], ['clearance', 'Clearance'], ['oneTime', 'One-time']].map(([k, l]) => <button key={k} aria-pressed={sp.kind === k} onClick={() => setSp({ ...sp, kind: k })}>{l}</button>)}</div>
            <p className="small muted">{sp.kind === 'emergency' ? 'Opens every lock, also with the deadbolt on. Always valid until cancelled. Keep it in the fire box.' : sp.kind === 'standOpen' ? 'Presented at the chosen doors, it keeps them open (until presented again).' : sp.kind === 'clearance' ? 'Clears guest access from a lock (offline rooms after a checkout).' : 'Opens the chosen doors once.'}</p>
            <div className="field-row">
              <div className="field"><label htmlFor="sp-e">Encoder</label><select id="sp-e" value={sp.encoder ?? ''} onChange={(x) => setSp({ ...sp, encoder: x.target.value })}><option value="">Choose…</option>{(e.data?.chosen ?? []).map((n: string) => <option key={n}>{n}</option>)}</select></div>
              <div className="field"><label htmlFor="sp-h">Held by</label><input id="sp-h" value={sp.holder} onChange={(x) => setSp({ ...sp, holder: x.target.value })} placeholder="Duty manager" /></div>
            </div>
            {['standOpen', 'oneTime'].includes(sp.kind) && <div className="field"><label htmlFor="sp-d">Doors</label><select id="sp-d" multiple size={6} value={sp.doorIds ?? []} onChange={(x) => setSp({ ...sp, doorIds: [...x.target.selectedOptions].map((o) => o.value) })}>{(doors.data ?? []).map((d: any) => <option key={d.external_id} value={d.external_id}>{d.name}</option>)}</select></div>}
            {sp.kind !== 'emergency' && <div className="field" style={{ maxWidth: 260 }}><label htmlFor="sp-u">Valid until</label><input id="sp-u" type="datetime-local" value={sp.until ?? ''} onChange={(x) => setSp({ ...sp, until: x.target.value })} /></div>}
            <button className="btn primary" disabled={!sp.encoder || sp.holder.length < 2 || !e.data?.encodeEnabled} onClick={special}>Encode the card</button>
          </section>
        )}
      </div>
    </>
  );
}

/** After the Opera checkout: online locks get the checkout command (confirmed per door), offline locks the clearance card. */
function Departures() {
  const { base, hotel } = useHotel();
  const d = useApi<any>(`${base}/departures`, [], 15_000);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  const rooms = d.data?.rooms ?? [];
  const todo = (online: boolean) => rooms.filter((r: any) => r.online === online && !['REACHED', 'CLEARED'].includes(r.status ?? ''));
  const send = async (action: 'checkout' | 'cleared', list: string[]) => {
    setError(null); setOk(null);
    try {
      const r = await api(`${base}/departures`, { body: { day: d.data.day, rooms: list, action } });
      if (r.commandId) { const c = await waitForCommand(hotel.id, r.commandId, 120_000); setOk(c.status === 'SUCCEEDED' ? `Checkout reached ${(c.result?.results ?? []).filter((x: any) => x.ok).length} of ${r.sent} online lock(s).` : `Not confirmed: ${c.error?.message ?? c.status}`); }
      else setOk(`${list.length} room(s) recorded as cleared.`);
      await d.reload();
    } catch (e) { setError(e); }
  };
  const label: Record<string, string> = { SENT: 'Sent', REACHED: 'Checkout reached the lock', FAILED: 'Lock not reached', CLEARED: 'Clearance card placed' };
  return (
    <>
      <ErrorNote error={error ?? d.error} />
      {ok && <div className="alert ok">{ok}</div>}
      <section className="panel">
        <h2>Departures {d.data?.day}</h2>
        <p className="small muted">Rooms leaving today (from the Opera in-house list). Online locks: send the checkout so the guest's cards stop at the door, and see that it arrived. Offline locks: staff place the clearance card on the lock, then tick it here.</p>
        <div className="row" style={{ margin: '8px 0 12px' }}>
          <button className="btn primary" disabled={!todo(true).length} onClick={() => send('checkout', todo(true).map((r: any) => r.room))}>Send checkout to {todo(true).length} online room(s)</button>
          <span className="muted small">{todo(false).length} offline room(s) need the clearance card.</span>
        </div>
        {rooms.length ? <table className="grid"><thead><tr><th>Room</th><th>Guest</th><th>Lock</th><th>Status</th><th /></tr></thead>
          <tbody>{rooms.map((r: any) => <tr key={r.room}><td><strong>{r.room}</strong></td><td>{r.guest ?? '—'}</td><td>{r.online ? 'Online' : 'Offline'}</td>
            <td>{r.status ? <span className={`pill ${['REACHED', 'CLEARED'].includes(r.status) ? 'ok' : r.status === 'FAILED' ? 'bad' : 'warn'}`}>{label[r.status]}</span> : <span className="muted">To do</span>}{r.doneBy && <div className="small muted">{r.doneBy} · {fmt.dt(r.doneAt)}</div>}</td>
            <td>{!r.online && r.status !== 'CLEARED' && <button className="btn small" onClick={() => send('cleared', [r.room])}>Clearance card placed</button>}</td></tr>)}</tbody></table>
          : <p className="empty">No departures today on the in-house list. Import today's Opera in-house report in Breakfast.</p>}
      </section>
    </>
  );
}

/** 2.17 Search the people and keycards read from Visionline (to issue without a duplicate, or to link an existing card). */
function VlPicker({ mode, initial, onPerson, onCard, selected }: {
  mode: 'person' | 'card'; initial: string; selected: string | null;
  onPerson: (p: { id: string; name: string | null; group: string | null } | null) => void;
  onCard: (c: { regNo: string; holder: string | null; name: string | null; group: string | null }) => void;
}) {
  const { base } = useHotel();
  const [q, setQ] = useState(initial);
  const [open, setOpen] = useState(false);
  const r = useApi<any>(open ? `${base}/keycards/visionline-search?q=${encodeURIComponent(q.trim())}` : null, [open, q]);
  return (
    <div className="vlpick">
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="small"><strong>{mode === 'card' ? 'Existing keycard' : 'Already in Visionline?'}</strong></span>
        {selected ? <span className="chip on">{selected}</span> : <span className="small muted">{mode === 'card' ? 'choose the keycard below' : 'optional: choose the person so no duplicate is created'}</span>}
        {selected && mode === 'person' && <button type="button" className="btn small" onClick={() => onPerson(null)}>Clear</button>}
        {!open && <button type="button" className="btn small" onClick={() => setOpen(true)}>Search Visionline</button>}
      </div>
      {open && (
        <div className="vlpick-box">
          <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, user id or card number" aria-label="Search Visionline" autoFocus />
          {r.data && (
            <ul className="vlpick-list">
              {mode === 'person' && r.data.people.map((p: any) => (
                <li key={p.user_id}><button type="button" onClick={() => { onPerson({ id: p.user_id, name: p.name, group: p.user_group }); setOpen(false); }}>
                  <strong>{p.name ?? p.user_id}</strong><span>{p.user_group ?? '—'} · {p.cards} valid card{p.cards === 1 ? '' : 's'} · {p.user_id}</span></button></li>))}
              {mode === 'card' && r.data.cards.map((c: any) => (
                <li key={c.reg_no}><button type="button" onClick={() => { onCard({ regNo: c.reg_no, holder: c.card_holder, name: c.name, group: c.user_group }); setOpen(false); }}>
                  <strong>{c.reg_no} · {c.name ?? c.card_holder ?? '—'}</strong><span>{c.user_group ?? '—'}{c.mobile ? ' · mobile key' : ''}{c.expires_at ? ` · until ${fmt.dt(c.expires_at)}` : ''}</span></button></li>))}
              {!(mode === 'person' ? r.data.people : r.data.cards).length && <li className="small muted" style={{ padding: 8 }}>Nothing found. People and keycards come from Visionline by themselves (Visionline cards &amp; people).</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
