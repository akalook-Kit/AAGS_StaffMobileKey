import { useState } from 'react';
import { useHotel } from '../App';
import { api } from '../api';
import { ErrorNote, fmt } from '../ui';

/**
 * 2.22 "Verify": asks Visionline now about one keycard (its holder's cards are read again), because the portal's lists
 * are read on request and can be older than Visionline. Light for Visionline: one person, not a full read.
 */
export function VerifyCard({ regNo, onDone, label = 'Verify with Visionline' }: { regNo: string; onDone?: () => void; label?: string }) {
  const { base } = useHotel();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [res, setRes] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const verify = async () => {
    setBusy(true); setError(null); setRes(null);
    try {
      const s = await api<any>(`${base}/visionline/cards/${encodeURIComponent(regNo)}/verify`, { body: {} });
      const end = Date.now() + 90_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const c = await api<any>(`${base}/visionline/cards/${encodeURIComponent(regNo)}/verify/${s.syncId}`);
        if (c.status === 'FAILED' || c.status === 'EXPIRED') throw new Error(c.error ?? 'Visionline could not be asked about this card.');
        if (c.status === 'SUCCEEDED') {
          const k = c.card;
          setRes(!k || !k.inVisionline ? { tone: 'bad', text: `Card ${regNo} is no longer in Visionline (cancelled, replaced or deleted).` }
            : k.valid ? { tone: 'ok', text: `Verified with Visionline: card ${regNo} is valid${k.expiresAt ? ` until ${fmt.dt(k.expiresAt)}` : ''}, ${k.doorCount} door${k.doorCount === 1 ? '' : 's'}.` }
            : { tone: 'bad', text: `Verified with Visionline: card ${regNo} is NOT valid${k.cancelled ? ' (cancelled)' : k.expiresAt && Date.parse(k.expiresAt) < Date.now() ? ` (ended ${fmt.dt(k.expiresAt)})` : ''}.` });
          onDone?.();
          break;
        }
        if (Date.now() > end) throw new Error('Visionline did not answer in time; try again in a minute.');
      }
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="verify-card">
      <button type="button" className="btn" onClick={verify} disabled={busy} title="Ask Visionline now whether this keycard is valid">{busy ? 'Asking Visionline…' : label}</button>
      {res && <div className={`alert ${res.tone}`} role="status" style={{ marginTop: 8 }}>{res.text}</div>}
      <ErrorNote error={error} />
    </div>
  );
}
