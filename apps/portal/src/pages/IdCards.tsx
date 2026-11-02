import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHotel } from '../App';
import { api } from '../api';
import { Drawer, ErrorNote, PageHead, fmt, useApi } from '../ui';
import { Barcode } from '../components/barcode';

type Profile = { id: string; fullName: string; idNumber: string | null; department: string | null; jobTitle: string | null; validUntil: string | null; hasPhoto: boolean; photo?: string | null; vlUserId: string | null; printCount: number; printedAt: string | null };
type Layout = { orientation: 'portrait' | 'landscape'; title: string; showDepartment: boolean; showJobTitle: boolean; showIdNumber: boolean; showValidUntil: boolean; showBarcode: boolean; backText: string; safeMarginMm: number };
type HotelInfo = { name: string | null; phone: string | null; address: string | null; website: string | null };

/**
 * 2.13 Staff ID cards: a profile per person (photo, name, department, ID number) printed on the keycard itself
 * (CR80, 85.6 × 54 mm) with any card printer, or on paper for a sleeve. The barcode carries the ID number for
 * attendance scanners. Visionline keeps the encoding: print on the same card before or after it is encoded.
 */
export function IdCardsPage() {
  const { base } = useHotel();
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const list = useApi<{ profiles: Profile[]; departments: { department: string; n: number }[] }>(`${base}/idcards/profiles?${new URLSearchParams({ ...(q ? { q } : {}), ...(dept ? { department: dept } : {}) })}`, [q, dept]);
  const lay = useApi<{ layout: Layout; hotel: HotelInfo }>(`${base}/idcards/layout`);
  const [sel, setSel] = useState<string[]>([]);
  const [edit, setEdit] = useState<Partial<Profile> | null>(null);
  const [importing, setImporting] = useState(false);
  const [printing, setPrinting] = useState<{ cards: Profile[]; back: boolean } | null>(null);
  const [back, setBack] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  const rows = list.data?.profiles ?? [];
  const all = rows.length > 0 && rows.every((r) => sel.includes(r.id));

  const print = async () => {
    setError(null);
    try {
      const ids = sel.slice(0, 60);
      const cards = await api<Profile[]>(`${base}/idcards/profiles/batch`, { body: { ids } });
      setPrinting({ cards, back });
    } catch (e) { setError(e); }
  };
  const printed = async () => {
    const ids = printing?.cards.map((c) => c.id) ?? [];
    setPrinting(null);
    if (ids.length && confirm(`Did the ${ids.length} card(s) print correctly? OK records them as printed.`)) {
      try { await api(`${base}/idcards/printed`, { body: { ids } }); setOk(`${ids.length} card(s) recorded as printed.`); await list.reload(); } catch (e) { setError(e); }
    }
  };

  return (
    <>
      <PageHead title="Staff ID cards" intro="Photo, name, department and ID number, printed on the keycard (CR80) with any card printer. The barcode carries the ID number for attendance scanners.">
        <input className="search" placeholder="Search name or ID number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <select className="search" value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
          <option value="">All departments</option>
          {(list.data?.departments ?? []).map((d) => <option key={d.department} value={d.department}>{d.department} ({d.n})</option>)}
        </select>
        <button className="btn" onClick={() => setImporting(true)}>Create from…</button>
        <button className="btn primary" onClick={() => setEdit({ fullName: '' })}>Add profile</button>
      </PageHead>
      <ErrorNote error={error ?? list.error} />
      {ok && <div className="alert ok">{ok}</div>}
      {sel.length > 0 && (
        <div className="sel-bar">
          <span><strong>{sel.length}</strong> selected{sel.length > 60 ? ' (the first 60 are printed)' : ''}</span>
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={back} onChange={(e) => setBack(e.target.checked)} /> Print the back as well (duplex printer)</label>
          <button className="btn primary" onClick={print}>Print cards</button>
          <button className="btn" onClick={() => setSel([])}>Clear</button>
        </div>
      )}
      <div className="split idc-split">
        <div className="panel flush">
          {list.data && !rows.length ? <div className="empty">{q || dept ? 'No profile matches.' : 'No profiles yet. Add one, or create them from Visionline people, the attendance list or the staff list.'}</div> : (
            <div className="table-scroll"><table className="grid">
              <thead><tr><th style={{ width: 30 }}><input type="checkbox" aria-label="Select all" checked={all} onChange={() => setSel(all ? [] : rows.map((r) => r.id))} /></th><th>Name</th><th>ID number</th><th>Department</th><th>Photo</th><th>Printed</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id} className="click" onClick={() => setEdit(r)}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${r.fullName}`} checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /></td>
                  <td><strong>{r.fullName}</strong>{r.jobTitle && <div className="small muted">{r.jobTitle}</div>}</td>
                  <td className="nowrap">{r.idNumber ?? <span className="muted">—</span>}</td>
                  <td>{r.department ?? <span className="muted">—</span>}</td>
                  <td>{r.hasPhoto ? <span className="pill ok">Yes</span> : <span className="pill warn">Missing</span>}</td>
                  <td className="small">{r.printCount ? `${r.printCount}× · ${fmt.dt(r.printedAt)}` : <span className="muted">Not yet</span>}</td>
                </tr>))}
              </tbody>
            </table></div>
          )}
        </div>
        <aside className="panel">
          <h2>Card printers</h2>
          <p className="small muted">The cards print at CR80 size (85.6 × 54 mm, the keycard size). Choose the card printer in the print window, “Actual size” (100 %), no margins.</p>
          <ul className="small idc-printers">
            <li><strong>Best for RFID keycards: retransfer printers</strong> print on a film that is then laid on the card, so the bump of the chip and antenna does not spoil the photo, edge to edge: HID Fargo HDP5000 / HDP6600, Evolis Avansia, Matica MC310, Entrust Datacard CR805.</li>
            <li><strong>Direct-to-card (lower cost)</strong>: Zebra ZC300 / ZC350, Evolis Primacy 2, Magicard Rio Pro 360, HID Fargo DTC1500. Works with flat PVC keycards; leave the safe margin set in the layout (1–1.5 mm).</li>
            <li>Check with ASSA ABLOY that the keycard model (MIFARE / VingCard) is printable: some are glossy and need a printable PVC surface.</li>
            <li>Print before encoding in Visionline, or after: printing does not touch the chip.</li>
          </ul>
          {lay.data && <><h3>Preview</h3><IdCard p={edit?.fullName ? (edit as Profile) : sample} layout={lay.data.layout} hotel={lay.data.hotel} /></>}
        </aside>
      </div>
      {edit && lay.data && <ProfileDrawer p={edit} layout={lay.data.layout} hotel={lay.data.hotel} onClose={(saved) => { setEdit(null); if (saved) { setOk(saved); void list.reload(); } }} />}
      {importing && <ImportDrawer onClose={(n) => { setImporting(false); if (n != null) { setOk(`${n} profile(s) created.`); void list.reload(); } }} />}
      {printing && lay.data && <PrintCards cards={printing.cards} back={printing.back} layout={lay.data.layout} hotel={lay.data.hotel} onDone={printed} />}
    </>
  );
}

const sample: Profile = { id: 'sample', fullName: 'Amina Uwase', idNumber: 'EMP-0042', department: 'Housekeeping', jobTitle: 'Room attendant', validUntil: null, hasPhoto: false, vlUserId: null, printCount: 0, printedAt: null };

/** One card, drawn in millimetres so the screen preview and the print are the same. */
export function IdCard({ p, layout, hotel, side = 'front' }: { p: Profile; layout: Layout; hotel: HotelInfo; side?: 'front' | 'back' }) {
  const { branding } = useHotel();
  const name = hotel.name ?? '';
  const logo = branding?.logo as string | undefined;
  const o = layout.orientation;
  const m = `${layout.safeMarginMm}mm`;
  if (side === 'back') {
    return (
      <div className={`idcard ${o} back`} style={{ ['--m' as any]: m }}>
        <div className="idc-back">
          <strong>{name}</strong>
          <p>{layout.backText}</p>
          {hotel.address && <p>{hotel.address}</p>}
          {hotel.phone && <p>{hotel.phone}</p>}
          {layout.showBarcode && p.idNumber && <Barcode value={p.idNumber} className="idc-bar" />}
        </div>
      </div>
    );
  }
  return (
    <div className={`idcard ${o}`} style={{ ['--m' as any]: m }}>
      <div className="idc-band">{logo ? <img src={logo} alt="" /> : <span className="idc-hotel">{name}</span>}<span className="idc-title">{layout.title}</span></div>
      <div className="idc-body">
        <div className="idc-photo">{p.photo ? <img src={p.photo} alt="" /> : <span>Photo</span>}</div>
        <div className="idc-text">
          <div className="idc-name">{p.fullName || 'Name'}</div>
          {layout.showJobTitle && p.jobTitle && <div className="idc-job">{p.jobTitle}</div>}
          {layout.showDepartment && p.department && <div className="idc-dept">{p.department}</div>}
          {layout.showIdNumber && p.idNumber && <div className="idc-id">ID {p.idNumber}</div>}
          {layout.showValidUntil && p.validUntil && <div className="idc-valid">Valid until {p.validUntil}</div>}
        </div>
      </div>
      {layout.showBarcode && p.idNumber && <Barcode value={p.idNumber} className="idc-bar" />}
    </div>
  );
}

/** Resize a photo to 3:4, at most 300 KB, in the browser (nothing is sent until the profile is saved). */
async function toJpeg(src: CanvasImageSource, w: number, h: number): Promise<string> {
  const W = 450, H = 600;
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = c.getContext('2d')!;
  const r = Math.max(W / w, H / h);
  const sw = W / r, sh = H / r;
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.drawImage(src, (w - sw) / 2, Math.max(0, (h - sh) / 3), sw, sh, 0, 0, W, H);
  for (const q of [0.88, 0.8, 0.7, 0.6, 0.5]) { const d = c.toDataURL('image/jpeg', q); if (d.length < 300_000) return d; }
  return c.toDataURL('image/jpeg', 0.4);
}

function ProfileDrawer({ p, layout, hotel, onClose }: { p: Partial<Profile>; layout: Layout; hotel: HotelInfo; onClose: (saved: string | null) => void }) {
  const { base } = useHotel();
  const [f, setF] = useState<Partial<Profile>>(p);
  const [photo, setPhoto] = useState<string | null | undefined>(undefined); // undefined = unchanged
  const [cam, setCam] = useState<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (p.id && p.hasPhoto) api<Profile[]>(`${base}/idcards/profiles/batch`, { body: { ids: [p.id] } }).then((r) => setF((x) => ({ ...x, photo: r[0]?.photo ?? null }))).catch(() => undefined); }, [p.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (video.current && cam) { video.current.srcObject = cam; void video.current.play(); } return undefined; }, [cam]);
  useEffect(() => () => cam?.getTracks().forEach((t) => t.stop()), [cam]);
  const shown = photo === undefined ? f.photo ?? null : photo;
  const set = (k: keyof Profile) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const file = async (fl: File | undefined) => {
    if (!fl) return;
    const img = await createImageBitmap(fl).catch(() => null);
    if (!img) { setError(new Error('This file is not a picture the browser can read (use JPEG or PNG).')); return; }
    setPhoto(await toJpeg(img, img.width, img.height));
  };
  const startCam = async () => {
    setError(null);
    try { setCam(await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 960 } })); } catch { setError(new Error('No camera available, or the browser was not allowed to use it.')); }
  };
  const snap = async () => {
    const v = video.current; if (!v) return;
    setPhoto(await toJpeg(v, v.videoWidth, v.videoHeight));
    cam?.getTracks().forEach((t) => t.stop()); setCam(null);
  };
  const save = async () => {
    setError(null);
    const body: any = { fullName: f.fullName, idNumber: f.idNumber || null, department: f.department || null, jobTitle: f.jobTitle || null, validUntil: f.validUntil || null };
    if (photo !== undefined) body.photo = photo;
    try {
      if (p.id) await api(`${base}/idcards/profiles/${p.id}`, { method: 'PATCH', body }); else await api(`${base}/idcards/profiles`, { body });
      onClose(p.id ? 'Profile saved.' : 'Profile added.');
    } catch (e) { setError(e); }
  };
  const remove = async () => {
    if (!p.id || !confirm(`Remove the profile of ${p.fullName}? The photo is deleted.`)) return;
    try { await api(`${base}/idcards/profiles/${p.id}`, { method: 'DELETE' }); onClose('Profile removed.'); } catch (e) { setError(e); }
  };
  return (
    <Drawer title={p.id ? p.fullName ?? 'Profile' : 'New profile'} onClose={() => onClose(null)}
      footer={<div className="row" style={{ justifyContent: 'space-between', width: '100%' }}>{p.id ? <button className="btn danger" onClick={remove}>Remove</button> : <span />}<div className="row"><button className="btn" onClick={() => onClose(null)}>Cancel</button><button className="btn primary" disabled={!f.fullName?.trim()} onClick={save}>Save</button></div></div>}>
      <ErrorNote error={error} />
      <div className="idc-photo-edit">
        <div className="idc-photo big">{cam ? <video ref={video} muted playsInline /> : shown ? <img src={shown} alt="" /> : <span>No photo</span>}</div>
        <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {cam ? <button className="btn primary" onClick={snap}>Take photo</button> : <button className="btn" onClick={startCam}>Use camera</button>}
          <label className="btn">Choose a picture<input type="file" accept="image/*" hidden onChange={(e) => void file(e.target.files?.[0])} /></label>
          {shown && <button className="btn" onClick={() => setPhoto(null)}>Remove photo</button>}
          <span className="small muted">Face centred, plain light background. Cropped to 3:4 and kept under 300 KB.</span>
        </div>
      </div>
      <div className="field"><label htmlFor="pf-n">Full name</label><input id="pf-n" value={f.fullName ?? ''} onChange={set('fullName')} maxLength={120} /></div>
      <div className="field-row">
        <div className="field"><label htmlFor="pf-i">ID number</label><input id="pf-i" value={f.idNumber ?? ''} onChange={set('idNumber')} maxLength={40} /><span className="hint">Printed and in the barcode.</span></div>
        <div className="field"><label htmlFor="pf-v">Valid until</label><input id="pf-v" type="date" value={f.validUntil ?? ''} onChange={set('validUntil')} /></div>
      </div>
      <div className="field-row">
        <div className="field"><label htmlFor="pf-d">Department</label><input id="pf-d" value={f.department ?? ''} onChange={set('department')} maxLength={80} /></div>
        <div className="field"><label htmlFor="pf-j">Job title</label><input id="pf-j" value={f.jobTitle ?? ''} onChange={set('jobTitle')} maxLength={80} /></div>
      </div>
      {f.vlUserId && <p className="small muted">Linked to Visionline person {f.vlUserId}.</p>}
      <h3>Card</h3>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <IdCard p={{ ...(f as Profile), photo: shown }} layout={layout} hotel={hotel} />
        <IdCard p={{ ...(f as Profile), photo: shown }} layout={layout} hotel={hotel} side="back" />
      </div>
    </Drawer>
  );
}

function ImportDrawer({ onClose }: { onClose: (n: number | null) => void }) {
  const { base } = useHotel();
  const [from, setFrom] = useState<'visionline' | 'attendance' | 'staff'>('visionline');
  const [g, setG] = useState('');
  const [error, setError] = useState<unknown>(null);
  const go = async () => {
    setError(null);
    try { const r = await api(`${base}/idcards/profiles/import`, { body: { from, groups: g.split(',').map((x) => x.trim()).filter(Boolean) } }); onClose(r.created); } catch (e) { setError(e); }
  };
  return (
    <Drawer title="Create profiles" onClose={() => onClose(null)} footer={<button className="btn primary" onClick={go}>Create profiles</button>}>
      <p className="muted">One profile per person who does not have one yet. Add the photos afterwards (or one by one with the camera).</p>
      <div className="seg" role="radiogroup" aria-label="From" style={{ marginBottom: 14 }}>
        <button aria-pressed={from === 'visionline'} onClick={() => setFrom('visionline')}>Visionline people</button>
        <button aria-pressed={from === 'attendance'} onClick={() => setFrom('attendance')}>Attendance list</button>
        <button aria-pressed={from === 'staff'} onClick={() => setFrom('staff')}>Mobile-key staff</button>
      </div>
      <div className="field"><label htmlFor="ig">{from === 'attendance' ? 'Departments' : 'Visionline user groups'} (optional)</label><input id="ig" value={g} onChange={(e) => setG(e.target.value)} placeholder="e.g. Housekeeping, Maintenance" /><span className="hint">Separate with commas. Empty = everybody.{from === 'visionline' ? ' Visionline people are read by Insights (Settings → Reports & sync).' : ''}</span></div>
      <ErrorNote error={error} />
    </Drawer>
  );
}

/** The print sheet: one card per page at the card's size; the browser sends it to the card printer. */
function PrintCards({ cards, back, layout, hotel, onDone }: { cards: Profile[]; back: boolean; layout: Layout; hotel: HotelInfo; onDone: () => void }) {
  const size = layout.orientation === 'portrait' ? '54mm 85.6mm' : '85.6mm 54mm';
  const pages = useMemo(() => cards.flatMap((c) => (back ? [{ c, side: 'front' as const }, { c, side: 'back' as const }] : [{ c, side: 'front' as const }])), [cards, back]);
  useEffect(() => {
    document.body.classList.add('printing-cards');
    const st = Object.assign(document.createElement('style'), { textContent: `@page { size: ${size}; margin: 0 }` });
    document.head.appendChild(st);
    const after = () => onDone();
    window.addEventListener('afterprint', after, { once: true });
    const imgs = [...document.querySelectorAll<HTMLImageElement>('.print-cards img')];
    void Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; })))).then(() => setTimeout(() => window.print(), 150));
    return () => { document.body.classList.remove('printing-cards'); st.remove(); window.removeEventListener('afterprint', after); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(<div className="print-cards">{pages.map((x, i) => <div key={i} className="print-card-page"><IdCard p={x.c} layout={layout} hotel={hotel} side={x.side} /></div>)}</div>, document.body);
}
