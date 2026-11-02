import { useState } from 'react';
import { api } from '../api';
import { useHotel } from '../App';
import { Drawer, ErrorNote, fmt, useApi } from '../ui';

/**
 * 2.17 Notice board on the Overview: short posts from the administrators (with an optional picture), newest first,
 * pinned ones on top. "Also on the sign-in page" posts are seen before signing in, so nothing confidential there.
 */
export interface Notice { id: string; title: string; body: string; kind: 'info' | 'important' | 'tip' | 'event'; pinned: boolean; startsAt: string; image: string | null; public?: boolean; endsAt?: string | null; author?: string | null }
export const KIND_LABEL: Record<Notice['kind'], string> = { info: 'News', important: 'Important', tip: 'Tip', event: 'Event' };

export function NoticeCard({ n, actions }: { n: Notice; actions?: React.ReactNode }) {
  return (
    <article className={`notice notice-${n.kind}`}>
      {n.image && <img src={n.image} alt="" className="notice-img" />}
      <div className="notice-body">
        <div className="notice-meta"><span className={`notice-kind k-${n.kind}`}>{n.pinned ? '📌 ' : ''}{KIND_LABEL[n.kind]}</span><span>{fmt.dt(n.startsAt)}{n.author ? ` · ${n.author}` : ''}{n.public ? ' · also on the sign-in page' : ''}</span></div>
        <h3>{n.title}</h3>
        {n.body && <p>{n.body}</p>}
        {actions && <div className="row" style={{ marginTop: 8 }}>{actions}</div>}
      </div>
    </article>
  );
}

export function Notices() {
  const { base, can } = useHotel();
  const admin = can('settings.manage');
  const list = useApi<Notice[]>(`${base}/notices${admin ? '?all=1' : ''}`, [], 60_000);
  const [edit, setEdit] = useState<Partial<Notice> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const items = list.data ?? [];
  const live = items.filter((n) => new Date(n.startsAt) <= new Date() && (!n.endsAt || new Date(n.endsAt) > new Date()));
  if (!items.length && !admin) return null;
  const del = async (n: Notice) => { if (!confirm(`Delete "${n.title}"?`)) return; try { await api(`${base}/notices/${n.id}`, { method: 'DELETE' }); void list.reload(); } catch (e) { setError(e); } };
  return (
    <section className="panel notices-panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Notice board</h2>
        {admin && <button className="btn small" onClick={() => setEdit({ kind: 'info', title: '', body: '', public: false, pinned: false })}>New post</button>}
      </div>
      <ErrorNote error={error ?? list.error} />
      {!items.length && <p className="small muted" style={{ margin: '10px 0 0' }}>Post news, reminders or tips for everyone here (for example "Return your keycard when you leave"). Posts marked "also on the sign-in page" are seen before signing in.</p>}
      <div className="notices">
        {(admin ? items : live).slice(0, admin ? 12 : 6).map((n) => (
          <NoticeCard key={n.id} n={n} actions={admin ? <><button className="btn small" onClick={() => setEdit(n)}>Edit</button><button className="btn small" onClick={() => del(n)}>Delete</button>{!live.includes(n) && <span className="small muted">not shown now</span>}</> : undefined} />
        ))}
      </div>
      {edit && <NoticeForm n={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void list.reload(); }} />}
    </section>
  );
}

function NoticeForm({ n, onClose, onSaved }: { n: Partial<Notice>; onClose: () => void; onSaved: () => void }) {
  const { base } = useHotel();
  const [v, setV] = useState<Partial<Notice>>(n);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Notice>) => setV({ ...v, ...p });
  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { setError(new Error('A JPEG, PNG or WebP picture.')); return; }
    // Shrink to 900 px wide so posts stay light.
    const img = new Image(); const url = URL.createObjectURL(f);
    img.onload = () => {
      const w = Math.min(900, img.width), h = Math.round(img.height * (w / img.width));
      const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d')!.drawImage(img, 0, 0, w, h);
      const data = c.toDataURL('image/jpeg', 0.8); URL.revokeObjectURL(url);
      if (data.length > 550_000) setError(new Error('The picture is too large; choose a smaller one.')); else set({ image: data });
    };
    img.src = url;
  };
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = { title: v.title, body: v.body ?? '', kind: v.kind ?? 'info', public: Boolean(v.public), pinned: Boolean(v.pinned), endsAt: v.endsAt || null, image: v.image ?? null };
      if (v.id) await api(`${base}/notices/${v.id}`, { method: 'PUT', body }); else await api(`${base}/notices`, { body });
      onSaved();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Drawer title={v.id ? 'Edit post' : 'New post'} onClose={onClose} footer={<><span /><div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || (v.title ?? '').trim().length < 2} onClick={save}>{busy ? 'Saving…' : 'Publish'}</button></div></>}>
      <ErrorNote error={error} />
      <div className="field"><label htmlFor="nt">Title</label><input id="nt" value={v.title ?? ''} maxLength={120} onChange={(e) => set({ title: e.target.value })} autoFocus /></div>
      <div className="field"><label htmlFor="nb">Text</label><textarea id="nb" rows={5} maxLength={2000} value={v.body ?? ''} onChange={(e) => set({ body: e.target.value })} /></div>
      <div className="field"><label>Kind</label><div className="seg">{(Object.keys(KIND_LABEL) as Notice['kind'][]).map((k) => <button key={k} type="button" aria-pressed={(v.kind ?? 'info') === k} onClick={() => set({ kind: k })}>{KIND_LABEL[k]}</button>)}</div></div>
      <div className="field"><label htmlFor="ni">Picture (optional)</label><input id="ni" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => pick(e.target.files?.[0])} />
        {v.image && <div className="row" style={{ marginTop: 8 }}><img src={v.image} alt="" style={{ maxWidth: 220, borderRadius: 8 }} /><button type="button" className="btn small" onClick={() => set({ image: null })}>Remove</button></div>}</div>
      <div className="field"><label htmlFor="ne">Show until (optional)</label><input id="ne" type="date" value={v.endsAt ? String(v.endsAt).slice(0, 10) : ''} onChange={(e) => set({ endsAt: e.target.value ? new Date(`${e.target.value}T23:59:00`).toISOString() : null })} /></div>
      <label className="check"><input type="checkbox" checked={Boolean(v.pinned)} onChange={(e) => set({ pinned: e.target.checked })} /><span>Pin on top</span></label>
      <label className="check"><input type="checkbox" checked={Boolean(v.public)} onChange={(e) => set({ public: e.target.checked })} /><span>Also on the sign-in page<span className="hint" style={{ display: 'block' }}>Seen by anyone who opens the portal address, before signing in. Nothing confidential.</span></span></label>
    </Drawer>
  );
}
