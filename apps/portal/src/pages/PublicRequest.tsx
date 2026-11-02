import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorNote } from '../ui';
import { RequestFields, endOfDay } from './Keycards';

/** 2.14 The page behind the QR code: managers ask for a staff keycard (or its cancellation) without signing in. */
export function PublicRequestPage({ token }: { token: string }) {
  const [info, setInfo] = useState<any>(null);
  const [v, setV] = useState<any>({ kind: 'new', staffType: 'permanent', quantity: 1 });
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<any>(null);
  useEffect(() => { api(`/api/v1/public/keycard-requests/${token}`).then(setInfo).catch(setError); }, [token]);
  const send = async () => {
    setError(null);
    try { setDone(await api(`/api/v1/public/keycard-requests/${token}`, { body: { ...v, validUntilDate: undefined, validUntil: v.validUntilDate ? endOfDay(v.validUntilDate) : null, jobTitle: v.jobTitle || null, employeeNo: v.employeeNo || null, cardLabel: v.cardLabel || null, hrEmail: v.hrEmail || null } })); } catch (e) { setError(e); }
  };
  return (
    <div className="setup"><div className="setup-card" style={{ maxWidth: 680 }}>
      <div className="setup-kicker">{info?.hotel ?? 'Staff keycards'}</div>
      <h1>Keycard request</h1>
      {done ? <div className="alert ok">Request <strong>{done.number}</strong> was sent. Front office or security will prepare the card; keep this number.</div> : (
        <>
          <p className="muted">Ask for a new staff keycard, a replacement, or the cancellation of a keycard (resignation, lost card). The card is made by front office or security.</p>
          <ErrorNote error={error} />
          {info && <form onSubmit={(e) => { e.preventDefault(); void send(); }}><RequestFields v={v} set={(p) => setV({ ...v, ...p })} prefixes={info.labelPrefixes} /><button className="btn primary">Send request</button></form>}
        </>
      )}
    </div></div>
  );
}
