import { useMemo, useState, type ReactNode } from 'react';
import { useHotel } from '../App';
import { api } from '../api';
import { ErrorNote, PageHead, fmt, useApi } from '../ui';

/** 2.14 System setup report, laid out like the Visionline "System Setup Report": one section per page, printable. */
export function SetupReportPage() {
  const { base, branding } = useHotel();
  const r = useApi<any>(`${base}/reports/setup`);
  if (!r.data) return <><PageHead title="System setup report" /><ErrorNote error={r.error} /></>;
  const x = r.data;
  const Head = ({ title }: { title: string }) => (
    <div className="ssr-head">
      <div>{branding?.logo ? <img src={branding.logo} alt="" /> : <strong>{x.property.name}</strong>}</div>
      <div className="ssr-title"><strong>System Setup Report</strong><em>{title}</em></div>
      <div className="ssr-right"><em>Access Monitoring Tool {x.property.version}</em><span>System ID: {x.property.systemId ?? '—'}</span><span>Property name: {x.property.name}</span></div>
    </div>
  );
  const Sec = ({ title, children }: { title: string; children: ReactNode }) => (
    <section className="ssr-page"><Head title={title} />{children}<div className="ssr-foot"><em>Printed: {fmt.dt(x.printedAt)} by {x.printedBy}</em></div></section>
  );
  const kv = (rows: [string, ReactNode][]) => <dl className="ssr-kv">{rows.map(([k, v]) => <div key={k}><dt>{k}:</dt><dd>{v}</dd></div>)}</dl>;
  return (
    <>
      <PageHead title="System setup report" intro="Your set-up in one printable document: locks, user groups, door groups, keycard types, who has access to what (portal and Visionline) and the main parameters.">
        <button className="btn primary" onClick={() => window.print()}>Print / PDF</button>
      </PageHead>
      <ImportPanel reload={r.reload} imported={x.visionline} />
      <div className="ssr">
        <Sec title="Property">{kv([['Property name', x.property.name], ['System ID', x.property.systemId ?? '—'], ['Time zone', x.property.timezone], ['Version', x.property.version],
          ['Locks', `${x.property.locks} (${x.property.locksOnline} online)`], ['User groups', x.property.userGroups], ['Door groups', x.property.doorGroups], ['Time schedules', x.property.timeSchedules],
          ['Encoders', x.property.encoders.join(', ') || '—'], ['People in Visionline', x.property.visionlineUsers], ['Valid keycards', x.property.validKeycards],
          ['Connector', x.property.connector ? `${x.property.connector.name} ${x.property.connector.version ?? ''}, last seen ${fmt.dt(x.property.connector.lastSeen)}` : 'not connected'],
          ['Licence', x.property.licence ? `${x.property.licence.id}${x.property.licence.expires ? ` until ${x.property.licence.expires}` : ''}` : 'trial']])}</Sec>
        <Sec title="Keycard Types"><table className="ssr-t"><thead><tr><th>Name</th><th>Description</th></tr></thead><tbody>{x.keycardTypes.map(([n, d]: string[]) => <tr key={n}><td>{n}</td><td>{d}</td></tr>)}</tbody></table></Sec>
        <Sec title="User Groups"><table className="ssr-t"><thead><tr><th>Name</th><th>Uniform access</th><th>Override deadbolt</th><th>Override privacy</th><th>Cards with override</th><th>Time schedule</th><th>Doors / door groups</th></tr></thead>
          <tbody>{x.userGroups.map((g: any) => <tr key={g.name}><td>{g.name}</td><td>{g.uniformAccess ? 'Yes' : 'No'}</td><td>{yn(g.overrideDeadbolt)}</td><td>{yn(g.overridePrivacy)}</td><td>{g.cardsWithOverride || '—'}</td><td>{g.timeSchedule ?? 'All week'}</td><td>{g.doors.join(', ') || '—'}</td></tr>)}</tbody></table>
          <p className="small muted">Override: the group's keycards open doors even when the deadbolt or privacy is on (Visionline user group settings). "Not read" = run resource discovery with connector 0.13.1 or newer.</p></Sec>
        <Sec title="Door Groups vs. Rooms"><table className="ssr-t"><thead><tr><th>Door group</th><th>Doors</th></tr></thead><tbody>{x.doorGroups.map((g: any) => <tr key={g.name}><td>{g.name}</td><td>{g.doors.join(', ')}</td></tr>)}</tbody></table></Sec>
        <Sec title="Locks"><table className="ssr-t"><thead><tr><th>Lock</th><th>Door group</th><th>Category</th><th>Online</th></tr></thead><tbody>{x.locks.map((l: any) => <tr key={l.name}><td>{l.name}</td><td>{l.group ?? '—'}</td><td>{l.category ?? '—'}</td><td>{l.online === true ? 'Yes' : l.online === false ? 'No' : '—'}</td></tr>)}</tbody></table></Sec>
        <Sec title="Time Tables">{x.timeSchedules.length ? <ul>{x.timeSchedules.map((t: string) => <li key={t}>{t}</li>)}</ul> : <p>None read from Visionline.</p>}</Sec>
        {x.visionline?.systemSettings && (
          <Sec title="Visionline System Settings">
            <p className="small muted">From the Visionline report "{x.visionline.systemSettings.file}", imported {fmt.dt(x.visionline.systemSettings.importedAt)}.</p>
            {kv(Object.entries(x.visionline.systemSettings.facts as Record<string, string>).slice(0, 80).map(([k, v]) => [k, v]))}
            {x.visionline.systemSettings.options?.length > 0 && <><h4>Visionline options</h4><ul className="ssr-cols">{x.visionline.systemSettings.options.map((o: any) => <li key={o.code}>({o.code}) {o.name}</li>)}</ul></>}
          </Sec>
        )}
        <Sec title="Visionline Operators">
          {kv([['Visionline user used by this portal', x.visionline?.operatorUsed ? `${x.visionline.operatorUsed}${x.visionline.operatorShared ? ' (shared: PMS / interface type)' : ''}` : 'not set'],
            ['Personal Visionline users required', x.visionline?.personalCredentialsRequired ? 'Yes' : 'No']])}
          {x.visionline?.operatorShared && <p className="ssr-warn">Visionline logs every keycard made from the portal under "{x.visionline.operatorUsed}". Change it or add operators: give each person a named Visionline operator.</p>}
          {x.visionline?.operators ? (
            <>
              <p className="small muted">From "{x.visionline.operators.file}", imported {fmt.dt(x.visionline.operators.importedAt)}.</p>
              {x.visionline.operators.shared?.length > 0 && <p className="ssr-warn">Shared operators (PMS / interface type): {x.visionline.operators.shared.join(', ')}. Cards they make cannot be traced to a person: change or add named operators.</p>}
              <table className="ssr-t"><thead><tr>{x.visionline.operators.head.map((h: string) => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>{x.visionline.operators.rows.map((row: string[], i: number) => <tr key={i}>{row.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>
            </>
          ) : <p>Who can do what in Visionline is not given by the Visionline Web API. Export the operator list from Visionline and import it above to show it here.</p>}
        </Sec>
        <Sec title="Access by User Group">
          <table className="ssr-t"><thead><tr><th>User group</th><th>People</th><th>Valid keycards</th><th>Mobile keys</th><th>Override</th><th>Door groups</th><th>Doors</th></tr></thead>
            <tbody>{(x.accessByGroup ?? []).map((g: any) => <tr key={g.name}><td>{g.name}{g.uniformAccess ? ' (uniform)' : ''}</td><td>{g.people}</td><td>{g.cards}</td><td>{g.mobileKeys || '—'}</td>
              <td>{g.overrideDeadbolt ? 'Deadbolt' : '—'}{g.cardsWithOverride ? ` · ${g.cardsWithOverride} card(s)` : ''}</td><td>{g.doorGroups.join(', ') || '—'}</td><td>{g.doors.join(', ') || '—'}</td></tr>)}</tbody></table>
        </Sec>
        <Sec title="Access by Person"><ByPerson rows={x.accessByPerson ?? []} /></Sec>
        <Sec title="System Access (portal operators)"><table className="ssr-t"><thead><tr><th>Name</th><th>E-mail</th><th>Roles</th><th>Two-step</th><th>Last sign-in</th></tr></thead><tbody>{x.access.map((a: any) => <tr key={a.email}><td>{a.name}</td><td>{a.email}</td><td>{a.roles.join(', ')}</td><td>{a.mfa ? 'Yes' : 'No'}</td><td>{a.lastSignIn ? fmt.dt(a.lastSignIn) : 'never'}</td></tr>)}</tbody></table></Sec>
        <Sec title="System Parameters">{kv(x.parameters.map(([k, v]: string[]) => [k, v]))}</Sec>
      </div>
    </>
  );
}

/** Who has access to what, per person: filter on screen, everything when printed. */
function ByPerson({ rows }: { rows: any[] }) {
  const [q, setQ] = useState(''); const [g, setG] = useState('');
  const groups = useMemo(() => [...new Set(rows.map((r) => r.group).filter(Boolean))].sort(), [rows]);
  const t = q.trim().toLowerCase();
  const shown = rows.filter((r) => (!g || r.group === g) && (!t || `${r.name ?? ''} ${r.id} ${r.doors.join(' ')} ${r.doorGroups.join(' ')}`.toLowerCase().includes(t)));
  return (
    <>
      <div className="row no-print" style={{ gap: 8, marginBottom: 8 }}>
        <input className="search" placeholder="Name or door (e.g. Cashier)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter people" />
        <select className="search" value={g} onChange={(e) => setG(e.target.value)} aria-label="User group"><option value="">All user groups</option>{groups.map((x) => <option key={x}>{x}</option>)}</select>
        <span className="small muted">{shown.length} of {rows.length} people with a valid keycard</span>
      </div>
      <table className="ssr-t"><thead><tr><th>Name</th><th>User group</th><th>Cards</th><th>Until</th><th>Door groups</th><th>Doors</th><th>Notes</th></tr></thead>
        <tbody>{shown.map((r) => <tr key={r.id}><td>{r.name ?? r.id}</td><td>{r.group ?? '—'}</td><td>{r.cards}</td><td>{r.until ? fmt.dt(r.until) : '—'}</td><td>{r.doorGroups.join(', ') || '—'}</td>
          <td>{r.doors.length > 12 ? `${r.doors.slice(0, 12).join(', ')} … (${r.doors.length})` : r.doors.join(', ') || '—'}</td>
          <td>{[r.override && 'deadbolt override', r.mobile && 'mobile key', r.portalUser && `portal user: ${r.portalUser}`].filter(Boolean).join(' · ')}</td></tr>)}</tbody></table>
      {!rows.length && <p>No keycards read from Visionline yet (Visionline cards &amp; people).</p>}
    </>
  );
}

/** Upload reports exported from Visionline (System settings, operators, card log): what the Web API does not give. */
function ImportPanel({ reload, imported }: { reload: () => void; imported: any }) {
  const { base, can } = useHotel();
  const list = useApi<any[]>(can('settings.manage') ? `${base}/visionline-imports` : null, []);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!can('settings.manage')) return null;
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const r = await api(`${base}/visionline-imports`, { body: { fileName: f.name, data: btoa(bin) } });
      setMsg(`Imported "${f.name}" as ${KIND[r.kind] ?? r.kind} (${r.rows} ${r.kind === 'system_settings' ? 'sections' : 'rows'}${r.issuers ? `, ${r.issuers} keycards with their Visionline operator` : ''}).`);
      void list.reload(); reload();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const missing = !imported?.systemSettings;
  return (
    <div className="panel no-print">
      <h2>Visionline reports</h2>
      <p className="small">The Visionline Web API does not give the system settings, the Visionline operators or who made each card at the desk. Export them from Visionline and import them here {missing && <strong>(the System settings report is missing)</strong>}: in Visionline, save the <em>System settings</em> report, the <em>operator list</em> and, for "Issued by", a <em>card list with the operator</em> (Excel / text as Visionline saves it, or CSV).</p>
      <ErrorNote error={error} />
      {msg && <div className="alert ok">{msg}</div>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="btn primary" style={{ cursor: busy ? 'wait' : 'pointer' }}>{busy ? 'Importing…' : 'Import a Visionline report'}<input type="file" accept=".xls,.txt,.csv,.tsv,text/plain,text/csv" hidden disabled={busy} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} /></label>
        {(list.data ?? []).map((i) => <span key={i.id} className="chip" style={{ cursor: 'default' }}>{KIND[i.kind] ?? i.kind}: {i.file_name} · {fmt.dt(i.imported_at)}</span>)}
      </div>
    </div>
  );
}
const KIND: Record<string, string> = { system_settings: 'System settings', operators: 'Visionline operators', card_log: 'Card log', user_groups: 'User groups', other: 'Other table' };

const yn = (v: boolean | null | undefined) => (v === true ? 'Yes' : v === false ? 'No' : 'Not read');
