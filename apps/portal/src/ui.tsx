import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { KEY_STATUS_LABEL, ERROR_HELP, type KeyStatus } from '@smk/shared';
import { api, ApiError } from './api';

export function useApi<T>(path: string | null, deps: unknown[] = [], pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (!path) return;
    try { const d = await api<T>(path); if (alive.current) { setData(d); setError(null); } }
    catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setLoading(false); }
  }, [path, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    alive.current = true;
    setLoading(true);
    void load();
    const t = pollMs ? setInterval(load, pollMs) : undefined;
    return () => { alive.current = false; if (t) clearInterval(t); };
  }, [load, pollMs]);
  return { data, error, loading, reload: load };
}

const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'idle'> = {
  ISSUED: 'ok', ACTIVE: 'ok', SUCCEEDED: 'ok',
  PENDING_APPROVAL: 'warn', SCHEDULED: 'warn', QUEUED: 'warn', ISSUING: 'warn', REVOKING: 'warn', INVITED: 'warn', LEASED: 'warn', PENDING: 'warn',
  FAILED: 'bad', REJECTED: 'bad', EXPIRED: 'idle', REVOKED: 'idle', DELETED: 'idle', SUSPENDED: 'bad', LEFT: 'idle',
};
const LIVE = new Set(['QUEUED', 'ISSUING', 'REVOKING', 'LEASED']);
const OTHER_LABELS: Record<string, string> = { ACTIVE: 'Phone ready', INVITED: 'Invitation sent', DELETED: 'Phone removed', SUSPENDED: 'Suspended', LEFT: 'Left', SUCCEEDED: 'Succeeded', PENDING: 'Pending', LEASED: 'In progress' };

export function Status({ s, label }: { s: string | null | undefined; label?: string }) {
  if (!s) return <span className="muted small">—</span>;
  const t = TONE[s] ?? 'idle';
  return <span className={`pill ${t === 'idle' ? '' : t} ${LIVE.has(s) ? 'live' : ''}`}>{label ?? KEY_STATUS_LABEL[s as KeyStatus] ?? OTHER_LABELS[s] ?? s}</span>;
}

export function ErrorNote({ error, code }: { error: unknown; code?: string | null }) {
  if (!error && !code) return null;
  const c = code ?? (error instanceof ApiError ? error.code : undefined);
  const msg = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  const help = c ? ERROR_HELP[c] : undefined;
  const details = error instanceof ApiError && Array.isArray(error.details) && error.details.length > 1 ? error.details : null;
  return (
    <div className="alert bad" role="alert">
      {msg && <div>{msg}</div>}
      {help && help !== msg && <div style={{ marginTop: 4 }}>{help}</div>}
      {details && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{details.map((d: any, i: number) => <li key={i}>{d.message ?? JSON.stringify(d)}</li>)}</ul>}
    </div>
  );
}

export const fmt = {
  dt: (v?: string | null) => (v ? new Date(v).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'),
  rel: (v?: string | null) => {
    if (!v) return 'never';
    const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
    if (Math.abs(s) < 60) return s >= 0 ? 'just now' : 'in under a minute';
    const m = Math.round(s / 60);
    if (Math.abs(m) < 60) return m > 0 ? `${m} min ago` : `in ${-m} min`;
    const h = Math.round(m / 60);
    return h > 0 ? `${h} h ago` : `in ${-h} h`;
  },
};

export function PageHead({ title, intro, children }: { title: string; intro?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{intro && <p>{intro}</p>}</div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

export function Drawer({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2 style={{ margin: 0 }}>{title}</h2><button className="x" onClick={onClose} aria-label="Close">×</button></header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </aside>
    </>
  );
}

/** Polls a command until it finishes; returns its final state. */
export async function waitForCommand(hotelId: string, commandId: string, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const c = await api(`/api/v1/hotels/${hotelId}/commands/${commandId}`);
    if (['SUCCEEDED', 'FAILED', 'EXPIRED'].includes(c.status) || Date.now() > end) return c;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ---- Brand theming -------------------------------------------------------------------------------
const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
/** Darkens a brand accent until it is readable as text on white (WCAG AA 4.5:1). */
export function readableAccent(hex: string): string {
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  for (let i = 0; i < 40 && contrast(`#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`, '#ffffff') < 4.6; i++) [r, g, b] = [r, g, b].map((v) => Math.round(v * 0.94)) as [number, number, number];
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
export function applyBrand(b: any | null | undefined) {
  if (!b) return;
  const r = document.documentElement.style;
  r.setProperty('--brand', b.primaryColor);
  r.setProperty('--brand-ink', b.textOnPrimary ?? '#ffffff');
  r.setProperty('--brass', b.secondaryColor);
  r.setProperty('--accent-text', readableAccent(b.secondaryColor));
  if (b.backgroundColor) r.setProperty('--bg', b.backgroundColor);
}
