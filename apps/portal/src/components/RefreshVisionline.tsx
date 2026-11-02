import { useState } from 'react';
import { api } from '../api';
import { useHotel } from '../App';
import { ErrorNote, fmt, useApi } from '../ui';

/**
 * 2.20 "Refresh from Visionline" (Armel, 31 Oct): after lock data was uploaded to Visionline or its resources were
 * refreshed, read doors, groups, people and keycards now — on request rather than on a schedule, to spare Visionline.
 */
export function RefreshVisionline({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const { base, can } = useHotel();
  const lr = useApi<{ readMode: string; doors: string | null; people: string | null; running: boolean }>(`${base}/visionline/last-read`, [], 15_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setError(null); setOk(null);
    try {
      const r = await api<any>(`${base}/visionline/refresh`, { body: {} });
      setOk(`Reading Visionline now${r.sync?.skipped ? ' (doors and user groups)' : ' (doors, user groups, people and keycards)'}. The pages update by themselves in a few minutes.`);
      void lr.reload(); onDone?.();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const d = lr.data;
  const last = d ? [d.doors && `doors ${fmt.rel(d.doors)}`, d.people && `people and keycards ${fmt.rel(d.people)}`].filter(Boolean).join(' · ') : '';
  return (
    <div className={`refresh-vl${compact ? ' compact' : ''}`}>
      <div className="row" style={{ alignItems: 'center', gap: 10 }}>
        {can('resources.discover') && <button className="btn" onClick={go} disabled={busy || d?.running}>{busy ? 'Asking the connector…' : d?.running ? 'Reading Visionline…' : 'Refresh from Visionline'}</button>}
        <span className="small muted">{last ? `Last read: ${last}` : 'Not read from Visionline yet'}{d?.readMode === 'onRequest' ? ' · read on request' : ''}</span>
      </div>
      {ok && <div className="alert ok" style={{ marginTop: 8 }}>{ok}</div>}
      <ErrorNote error={error} />
    </div>
  );
}
