import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useHotel, useTerms } from '../App';
import { api, download } from '../api';
import { ErrorNote, PageHead, fmt, useApi } from '../ui';
import { lang, tr } from '../i18n';

/**
 * 2.27 Reports: daily and monthly reports in one place. Each can be read on screen, downloaded as a PDF (with a
 * fingerprint, checkable later) or CSV for Excel, e-mailed now, or e-mailed every day / every month (administrators).
 */
export function ReportsPage() {
  const { base, can } = useHotel();
  const t = useTerms();
  const cat = useApi<any>(`${base}/reports-centre`);
  const [sp, setSp] = useSearchParams();
  const x = cat.data;
  const id = sp.get('r') ?? x?.reports?.[0]?.id ?? null;
  const def = x?.reports?.find((r: any) => r.id === id);
  const groups = ['Daily and monthly', 'Keycards', 'Doors', 'Locks'];
  const more: [string, string, boolean][] = [
    ['/insights', 'Insights and your own reports', can('reports.read')], ['/charts', 'My charts', can('reports.read') || can('events.read')],
    ['/events', 'Event log (printable)', can('events.read')], ['/room-keycards', 'Keycards per room', can('events.read')],
    ['/settings?tab=accounts', 'Accounts daily report', can('settings.manage') && !t.institution], ['/setup-report', 'Visionline setup report', can('settings.manage')],
    ['/setup-report?view=portal', 'Portal setup report', can('settings.manage')], ['/audit', 'Audit trail', can('audit.read')]];
  return (
    <>
      <PageHead title="Reports" intro="Daily and monthly reports: read them here, download them (PDF or Excel), or have them e-mailed every day or every month." />
      <ErrorNote error={cat.error} />
      <div className="rep-layout">
        <nav className="rep-list" aria-label={tr('Reports')}>
          {groups.map((g) => {
            const items = (x?.reports ?? []).filter((r: any) => r.group === g);
            if (!items.length) return null;
            return (
              <div key={g}>
                <h3>{tr(g)}</h3>
                {items.map((r: any) => <button key={r.id} type="button" data-tip={r.about} aria-current={r.id === id ? 'page' : undefined} onClick={() => { const n = new URLSearchParams(sp); n.set('r', r.id); setSp(n, { replace: true }); }}>{tr(r.title)}</button>)}
              </div>
            );
          })}
          <div>
            <h3>{tr('More reports')}</h3>
            {more.filter((m) => m[2]).map(([to, l]) => <Link key={to} to={to}>{tr(l)}</Link>)}
          </div>
        </nav>
        <div className="rep-main">
          {def && x && <ReportView key={def.id} def={def} cat={x} />}
          {x?.canSchedule && <Schedules cat={x} onChange={() => void cat.reload()} />}
        </div>
      </div>
    </>
  );
}

function ReportView({ def, cat }: { def: any; cat: any }) {
  const { base } = useHotel();
  const now = def.periods.includes('now');
  const [period, setPeriod] = useState<'day' | 'month'>(now ? 'day' : def.periods[0]);
  const [day, setDay] = useState<string>(cat.yesterday);
  const [month, setMonth] = useState<string>(cat.lastMonth);
  const date = period === 'day' ? day : month;
  const q = `period=${period}&date=${encodeURIComponent(date)}`;
  const r = useApi<any>(`${base}/reports-centre/${def.id}?${q}`, [def.id, q]);
  const [emails, setEmails] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSent(null); setError(null); }, [q]);
  const send = async () => {
    setBusy(true); setError(null); setSent(null);
    try {
      const list = emails.split(/[\s,;]+/).filter(Boolean);
      const res = await api<any>(`${base}/reports-centre/${def.id}/send`, { body: { period, date, emails: list } });
      setSent(res.failed?.length ? `${tr('Sent')}: ${res.sent}. ${tr('Not sent')}: ${res.failed.join('; ')}` : `${tr('Sent to')} ${list.join(', ')}.`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const x = r.data;
  return (
    <section className="panel">
      <h2 style={{ marginBottom: 4 }}>{tr(def.title)}</h2>
      <p className="small muted" style={{ marginTop: 0 }}>{tr(def.about)}</p>
      {!now && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="seg">{def.periods.filter((p: string) => p !== 'now').map((p: 'day' | 'month') => <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)}>{p === 'day' ? tr('Day') : tr('Month')}</button>)}</div>
          {period === 'day' ? (
            <>
              <input type="date" className="search" aria-label={tr('Day')} value={day} max={cat.today} onChange={(e) => e.target.value && setDay(e.target.value)} />
              <button type="button" className="btn small" onClick={() => setDay(cat.yesterday)}>{tr('Yesterday')}</button>
              <button type="button" className="btn small" onClick={() => setDay(cat.today)}>{tr('Today so far')}</button>
            </>
          ) : (
            <>
              <input type="month" className="search" aria-label={tr('Month')} value={month} max={cat.month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
              <button type="button" className="btn small" onClick={() => setMonth(cat.lastMonth)}>{tr('Last month')}</button>
              <button type="button" className="btn small" onClick={() => setMonth(cat.month)}>{tr('This month so far')}</button>
            </>
          )}
        </div>
      )}
      <ErrorNote error={r.error ?? error} />
      {x && (
        <>
          <p className="small" style={{ margin: '12px 0 8px' }}><strong>{periodLabel(x, period, now)}</strong> <span className="muted">({x.timezone})</span></p>
          <div className="rep-figures">{x.summary.map(([k, v]: [string, string]) => <div key={k}><strong>{v}</strong><span>{tr(k)}</span></div>)}</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
            <button className="btn primary" data-tip="A PDF with a fingerprint: Verify a PDF (Event log) shows whether anyone changed it." onClick={() => download(`${base}/reports-centre/${def.id}/pdf?${q}`, `${def.id}-${date}.pdf`)}>{tr('Download PDF')}</button>
            <button className="btn" data-tip="A file that opens in Excel, with every line of the report." onClick={() => download(`${base}/reports-centre/${def.id}/csv?${q}`, `${def.id}-${date}.csv`)}>{tr('Download for Excel (CSV)')}</button>
          </div>
          <div className="table-scroll">
            {!x.rows.length ? <p className="empty">{tr('Nothing in this period.')}</p> : (
              <table className="grid"><thead><tr>{x.columns.map((c: any) => <th key={c.label} style={c.align === 'right' ? { textAlign: 'right' } : undefined}>{tr(c.label)}</th>)}</tr></thead>
                <tbody>{x.rows.slice(0, 500).map((row: string[], i: number) => <tr key={i} className={x.tones?.[i] === 'error' ? 'row-bad' : x.tones?.[i] === 'warning' ? 'row-warn' : undefined}>
                  {row.map((v, j) => <td key={j} className={j ? 'small' : undefined} style={x.columns[j]?.align === 'right' ? { textAlign: 'right' } : undefined}>{def.id === 'daily-summary' && (j === 0 || x.columns[j]?.label === 'Note') ? tr(v) : v}</td>)}</tr>)}</tbody></table>
            )}
            {x.rows.length > 500 && <p className="small muted">{tr('The first 500 lines are shown; the PDF and the CSV have all of them.')} ({x.rows.length})</p>}
          </div>
          {x.note && <p className="small muted">{tr(x.note)}</p>}
          <div className="rep-send">
            <label htmlFor="rep-to" className="small">{tr('E-mail this report now to')}</label>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input id="rep-to" className="search" style={{ flex: '1 1 260px' }} placeholder="name@hotel.com, other@hotel.com" value={emails} onChange={(e) => setEmails(e.target.value)} />
              <button className="btn" disabled={busy || !emails.trim() || !cat.emailOn} onClick={send} title={cat.emailOn ? '' : tr('E-mail is not set up (Settings → Alerts & notifications).')}>{busy ? tr('Sending…') : tr('Send by e-mail')}</button>
            </div>
            {!cat.emailOn && <span className="hint">{tr('E-mail is not set up (Settings → Alerts & notifications).')}</span>}
            {sent && <div className="alert ok" role="status">{sent}</div>}
          </div>
        </>
      )}
    </section>
  );
}

function Schedules({ cat, onChange }: { cat: any; onChange: () => void }) {
  const { base } = useHotel();
  const [report, setReport] = useState(cat.reports[0]?.id ?? '');
  const [freq, setFreq] = useState<'daily' | 'monthly'>('daily');
  const [time, setTime] = useState('07:00');
  const [emails, setEmails] = useState('');
  const [error, setError] = useState<unknown>(null);
  const add = async () => {
    setError(null);
    try { await api(`${base}/report-schedules`, { body: { report, frequency: freq, sendTime: time, emails: emails.split(/[\s,;]+/).filter(Boolean) } }); setEmails(''); onChange(); } catch (e) { setError(e); }
  };
  const del = async (id: string) => { try { await api(`${base}/report-schedules/${id}`, { method: 'DELETE' }); onChange(); } catch (e) { setError(e); } };
  const title = (id: string) => tr(cat.reports.find((r: any) => r.id === id)?.title ?? id);
  return (
    <section className="panel">
      <h2>{tr('Reports sent by e-mail')}</h2>
      <p className="small muted">{tr('Every day: the previous day\'s report, at the time you choose. Every month: the previous month\'s report, on the 1st. The PDF and the CSV are attached.')}</p>
      {cat.schedules?.length ? (
        <div className="table-scroll"><table className="grid"><thead><tr><th>{tr('Report')}</th><th>{tr('When')}</th><th>{tr('To')}</th><th>{tr('Last sent')}</th><th></th></tr></thead>
          <tbody>{cat.schedules.map((s: any) => <tr key={s.id}><td>{title(s.report)}</td><td className="small">{s.frequency === 'daily' ? tr('Every day') : tr('Every month (1st)')} {s.send_time}</td>
            <td className="small">{s.emails.join(', ')}</td><td className="small">{s.last_sent_at ? `${fmt.dt(s.last_sent_at)} (${s.last_period})` : tr('not yet')}{s.last_error && <div className="bad-text">{s.last_error}</div>}</td>
            <td><button className="btn small" onClick={() => void del(s.id)}>{tr('Stop')}</button></td></tr>)}</tbody></table></div>
      ) : <p className="empty">{tr('No report is e-mailed yet.')}</p>}
      <div className="field-row" style={{ marginTop: 12 }}>
        <div className="field"><label htmlFor="s-r">{tr('Report')}</label><select id="s-r" value={report} onChange={(e) => setReport(e.target.value)}>{cat.reports.map((r: any) => <option key={r.id} value={r.id}>{tr(r.title)}</option>)}</select></div>
        <div className="field"><label htmlFor="s-f">{tr('How often')}</label><select id="s-f" value={freq} onChange={(e) => setFreq(e.target.value as any)}><option value="daily">{tr('Every day (previous day)')}</option><option value="monthly">{tr('Every month (previous month)')}</option></select></div>
        <div className="field" style={{ maxWidth: 120 }}><label htmlFor="s-t">{tr('Time')}</label><input id="s-t" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></div>
      </div>
      <div className="field"><label htmlFor="s-e">{tr('E-mail addresses')}</label><input id="s-e" value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="gm@hotel.com, security@hotel.com" /></div>
      <ErrorNote error={error} />
      <button className="btn primary" disabled={!emails.trim()} onClick={add}>{tr('Add')}</button>
      {!cat.emailOn && <p className="small muted">{tr('E-mail is not set up (Settings → Alerts & notifications).')}</p>}
    </section>
  );
}

/** The period in the chosen language (the server writes it in English for the PDF). */
function periodLabel(x: any, period: 'day' | 'month', now: boolean) {
  if (lang() === 'en') return x.period;
  const loc = lang();
  const at = new Date(new Date(x.from).getTime() + 3_600_000 * 12);
  if (now) return `${tr('As of')} ${new Intl.DateTimeFormat(loc, { timeZone: x.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(x.from))}`;
  return new Intl.DateTimeFormat(loc, period === 'day' ? { timeZone: x.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' } : { timeZone: x.timezone, month: 'long', year: 'numeric' }).format(at);
}
