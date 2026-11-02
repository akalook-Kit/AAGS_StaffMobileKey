import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useHotel } from '../App';
import { useApi } from '../ui';

/**
 * 2.16 First steps for an administrator, on the Overview until everything is done (or hidden). Each step is
 * ticked from what the platform sees, never by hand.
 */
export function GettingStarted() {
  const { base, can, me, branding, hotel } = useHotel();
  const admin = can('settings.manage') && can('operators.manage');
  const ready = useApi<any>(admin ? `${base}/readiness` : null, [], 15_000).data;
  const ops = useApi<any[]>(admin ? `${base}/operators` : null, [], 30_000).data;
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(`smk.gs.${hotel.id}`) === 'hidden'; } catch { return false; } });
  if (!admin || hidden || !ready || !ops) return null;
  const ok = (id: string) => Boolean(ready.checks?.find((c: any) => c.id === id)?.ok);
  const steps = [
    { done: ok('connector'), label: 'Connector online', to: '/settings?tab=connector', hint: 'On this server, or on another computer: Settings → Connector shows the commands.' },
    { done: ok('credentials') && ok('api'), label: 'Visionline account entered', to: '/settings?tab=visionline', hint: 'The Visionline user the connector signs in with (encrypted for the connector).' },
    { done: /^[1-9]/.test(ready.checks?.find((c: any) => c.id === 'discovery')?.detail ?? ''), label: 'Doors read from Visionline', to: '/connector', hint: 'Connector health → Run resource discovery (it also runs by itself every 6 hours).' },
    { done: Boolean(branding?.logo), label: 'Logo added', to: '/branding', hint: 'Shown in the portal, the staff app and on reports.' },
    { done: ops.length > 1, label: 'People invited', to: '/operators', hint: 'Users → Invite someone. They choose their own password.' },
    { done: me.mfaEnabled, label: 'Two-step sign-in on for you', to: '/account', hint: 'Your account → Two-step sign-in (an authenticator app on your phone).' },
  ];
  const left = steps.filter((s) => !s.done).length;
  if (!left) return null;
  return (
    <div className="panel getting-started">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Getting started · {steps.length - left} of {steps.length} done</h2>
        <button className="btn small" onClick={() => { setHidden(true); try { localStorage.setItem(`smk.gs.${hotel.id}`, 'hidden'); } catch { /* ignore */ } }}>Hide</button>
      </div>
      <ul className="checklist" style={{ marginTop: 10 }}>
        {steps.map((s) => (
          <li key={s.label}><span className={`dot ${s.done ? 'ok' : ''}`} aria-label={s.done ? 'Done' : 'To do'} />
            <div>{s.done ? <strong>{s.label}</strong> : <Link to={s.to}><strong>{s.label}</strong></Link>}{!s.done && <div className="small muted">{s.hint}</div>}</div></li>
        ))}
      </ul>
    </div>
  );
}
