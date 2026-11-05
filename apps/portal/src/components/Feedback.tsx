import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useHotel } from '../App';
import { api } from '../api';
import { ErrorNote } from '../ui';
import { tr } from '../i18n';

/** 2.25 "Feedback" on every page: a few words (and a rating if wanted) go to the people who run the portal. */
export function FeedbackButton() {
  const { base } = useHotel();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const send = async () => {
    setBusy(true); setError(null);
    try { await api(`${base}/feedback`, { body: { text, rating, page: `${loc.pathname}${loc.search}`.slice(0, 200) } }); setDone(true); setText(''); setRating(null); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  const close = () => { setOpen(false); setDone(false); setError(null); };
  return (
    <>
      <button type="button" className="fb-button no-print" onClick={() => setOpen(true)} aria-haspopup="dialog">{tr('Feedback')}</button>
      {open && (
        <div className="fb-scrim" role="presentation" onClick={close}>
          <div className="fb-dialog" role="dialog" aria-modal="true" aria-labelledby="fb-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="fb-title">{tr(done ? 'Thank you' : 'What do you think?')}</h2>
            {done ? (
              <><p>{tr('Your feedback was sent. It helps decide what to improve next.')}</p><button className="btn primary" onClick={close}>{tr('Close')}</button></>
            ) : (
              <>
                <p className="small muted">{tr('About this page or the portal in general: what works, what is confusing, what is missing.')}</p>
                <div className="fb-rate" role="group" aria-label="How useful is it (optional)">
                  {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" aria-pressed={rating === n} onClick={() => setRating(rating === n ? null : n)} title={tr(['Not useful', 'A little useful', 'Useful', 'Very useful', 'Excellent'][n - 1]!)}>{n}</button>)}
                  <span className="small muted">{tr(rating ? ['Not useful', 'A little useful', 'Useful', 'Very useful', 'Excellent'][rating - 1]! : 'How useful is it? (optional)')}</span>
                </div>
                <textarea aria-label="Your feedback" rows={5} maxLength={3000} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: I could not find where to extend a keycard." autoFocus />
                <ErrorNote error={error} />
                <div className="row end" style={{ gap: 8 }}><button className="btn" onClick={close}>{tr('Cancel')}</button><button className="btn primary" disabled={busy || text.trim().length < 2} onClick={send}>{tr(busy ? 'Sending…' : 'Send feedback')}</button></div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
