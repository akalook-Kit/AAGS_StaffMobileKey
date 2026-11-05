import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useHotel } from '../App';
import { tr } from '../i18n';
import { api } from '../api';
import { ErrorNote, PageHead, fmt, useApi } from '../ui';
import { RefreshVisionline } from '../components/RefreshVisionline';

/**
 * 2.14 System setup report, laid out like the Visionline "System Setup Report": one section per page, printable.
 * 2.27 Two reports (Armel, 4 Nov): the Visionline report is about Visionline only, with the facts on its first page
 * (version, AES, locks); everything about this portal is in the Portal setup report (?view=portal).
 */
export function SetupReportPage() {
  const { base, branding } = useHotel();
  const [sp, setSp] = useSearchParams();
  const view = sp.get('view') === 'portal' ? 'portal' : 'visionline';
  const r = useApi<any>(`${base}/reports/setup${view === 'portal' ? '?part=portal' : ''}`, [view]);
  const secs = useSeconds(r.loading && !r.data);
  const title = view === 'portal' ? 'Portal setup report' : 'Visionline setup report';
  const tabs = (
    <div className="seg no-print" role="tablist" aria-label={tr('System setup reports')}>
      {(['visionline', 'portal'] as const).map((v) => <button key={v} type="button" role="tab" aria-selected={view === v} aria-pressed={view === v} onClick={() => setSp(v === 'portal' ? { view: 'portal' } : {}, { replace: true })}>{tr(v === 'portal' ? 'Portal setup report' : 'Visionline setup report')}</button>)}
    </div>
  );
  if (!r.data) return (
    <><PageHead title={title} />{tabs}
      <ErrorNote error={r.error} />
      {r.loading && !r.error && <div className="panel" role="status" aria-live="polite"><p><strong>{tr('Preparing the report…')}</strong> {secs} s</p>
        <p className="small muted">{secs < 20 ? tr('It reads every lock, user group and keycard; on a large site this takes a few seconds.') : tr('Still working. If nothing comes after 90 seconds the page says which step is slow.')}</p></div>}
      {!r.loading && !r.error && <div className="alert bad" role="alert">{tr('The server sent no report. Refresh the page; if it stays empty, send a screenshot of Connector health to support.')}</div>}
    </>);
  const x = r.data;
  const gl = x.glance ?? {};
  const Head = ({ title: t }: { title: string }) => (
    <div className="ssr-head">
      <div>{branding?.logo ? <img src={branding.logo} alt="" /> : <strong>{x.property.name}</strong>}</div>
      <div className="ssr-title"><strong>{view === 'portal' ? 'Portal Setup Report' : 'System Setup Report'}</strong><em>{t}</em></div>
      {view === 'portal'
        ? <div className="ssr-right"><em>Access Monitoring Tool {x.property.version}</em><span>Property name: {x.property.name}</span></div>
        : <div className="ssr-right"><em>Visionline {gl.version ?? ''}</em><span>System ID: {gl.systemId ?? '—'}</span><span>Property name: {x.property.name}</span></div>}
    </div>
  );
  const Sec = ({ title: t, children }: { title: string; children: ReactNode }) => (
    <section className="ssr-page"><Head title={t} />{children}<div className="ssr-foot"><em>Printed: {fmt.dt(x.printedAt)} by {x.printedBy}</em></div></section>
  );
  const kv = (rows: [string, ReactNode][]) => <dl className="ssr-kv">{rows.map(([k, v]) => <div key={k}><dt>{k}:</dt><dd>{v}</dd></div>)}</dl>;
  return (
    <>
      <PageHead title={title} intro={view === 'portal'
        ? 'How this portal is set up: version, connector, licence, who can sign in, the Visionline operators linked to people, keycard types and the portal parameters.'
        : 'Visionline only, in one printable document: the version, AES and the locks on the first page, then every room and the user groups that open it, user groups, door groups, locks, Visionline operators, who has access to what and the Visionline system parameters.'}>
        <button className="btn primary" onClick={() => window.print()}>{tr('Print / PDF')}</button>
      </PageHead>
      {tabs}
      {view === 'visionline' && <div className="no-print"><RefreshVisionline onDone={() => setTimeout(() => void r.reload(), 4000)} /></div>}
      {view === 'visionline' && <ImportPanel reload={r.reload} imported={x.visionline} />}
      {view === 'visionline' ? (
      <div className="ssr">
        <Sec title="At a Glance">
          <div className="ssr-glance">
            <div><span>Visionline version</span><strong>{gl.version ?? 'Not known'}</strong><small>{gl.version ? (gl.versionFrom ? `From the System settings report, ${gl.versionFrom}` : '') : 'Import the System settings report (Visionline reports, above).'}</small></div>
            <AesTile gl={gl} />
            <div><span>Locks</span><strong>{gl.locks?.total ?? x.property.locks}</strong><small>{gl.locks?.onlineKnown ? `${gl.locks.online} online · ${gl.locks.offline} offline (stand-alone)` : 'Online state not read'}</small></div>
            <div><span>Clients allowed</span><strong>{gl.clients?.value ?? '—'}</strong><small>{gl.clients ? `[${gl.clients.section}] ${gl.clients.label}` : gl.source ? 'Not in the imported report: Visionline → Help → About / Option code shows it.' : 'Import the System settings report.'}</small></div>
            <div className={gl.mobileLicence?.state === 'licensed' ? 'ok' : gl.mobileLicence?.state === 'demo' ? 'warn' : ''}><span>Mobile key licence</span><strong>{gl.mobileLicence ? ({ licensed: 'Licensed', demo: 'Demo', none: 'None' } as Record<string, string>)[gl.mobileLicence.state] : '—'}</strong><small>{gl.mobileLicence?.evidence ?? 'Import the System settings report.'}</small></div>
            <div className={gl.pmsActivity?.cards ? 'ok' : ''}><span>PMS interface</span><strong>{gl.pmsActivity?.cards ? `${gl.pmsActivity.cards} keycards` : gl.pms?.length || gl.pmsOptions?.length ? 'Set up' : '—'}</strong>
              <small>{gl.pmsActivity?.cards ? `Made through ${gl.pmsActivity.operators.join(', ')}${gl.pmsActivity.last ? `, last ${fmt.dt(gl.pmsActivity.last)}` : ''} (card list imported)` : [...(gl.pmsOptions ?? []), ...(gl.pms ?? []).slice(0, 2).map((p: any) => `${p.label}: ${p.value}`)].join(' · ') || 'No PMS setting in the report'}</small></div>
            <div><span>User groups</span><strong>{gl.userGroups ?? x.property.userGroups}</strong><small>{gl.doorGroups ?? x.property.doorGroups} door groups · {gl.timeSchedules ?? x.property.timeSchedules} time schedules</small></div>
            <div><span>Encoders</span><strong>{(gl.encoders ?? x.property.encoders).length}</strong><small>{(gl.encoders ?? x.property.encoders).join(', ') || '—'}</small></div>
            <div><span>People and keycards</span><strong>{gl.people ?? x.property.visionlineUsers}</strong><small>{gl.validKeycards ?? x.property.validKeycards} valid keycards{gl.operators != null ? ` · ${gl.operators} Visionline operators` : ''}</small></div>
          </div>
          {kv([['System code', gl.systemCode ?? '—'], ['System ID', gl.systemId ?? '—'], ['Visionline version', gl.version ?? 'not in the imported report'],
            ['AES key mode', gl.keyMode?.text ? `${gl.keyMode.text}${gl.keyMode.disableLegacyCardCreated ? ' · "Disable legacy key mode" card created' : ''}` : 'not in the imported report'],
            ...(gl.keyMode?.systemIdLastSet ? [['System ID last set', gl.keyMode.systemIdLastSet] as [string, ReactNode]] : []),
            ['DESFire EV1 enhancement', gl.ev1 ? `${gl.ev1.value} (${gl.ev1.label})` : 'not in the imported report'],
            ...(gl.knownAuth?.length ? [['Card authentications known', gl.knownAuth.join(', ')] as [string, ReactNode]] : []),
            ...(gl.pms ?? []).map((p: any) => [p.label, p.value] as [string, ReactNode]),
            ...(gl.pmsOptions?.length ? [['PMS options', gl.pmsOptions.join(', ')] as [string, ReactNode]] : []), ...(gl.encryption ? [['Card encryption', gl.encryption] as [string, ReactNode]] : []),
            ['Visionline Web API', gl.webApiVersion ?? '—'], ['Firmware pack', gl.firmwarePack ?? '—'],
            ['Mobile Access option', gl.mobileAccess === true ? 'Yes' : gl.mobileAccess === false ? 'No' : '—'], ['Licensed options', gl.options?.length ? `${gl.options.length}` : '—'],
            ['Events recorded', gl.eventsTotal ? `${gl.eventsOn} of ${gl.eventsTotal}` : '—'],
            ...(gl.locksInReport ?? []).map((l: any) => [l.label, l.value] as [string, ReactNode]),
            ...(gl.guestCards ?? []).map((l: any) => [l.label, l.value] as [string, ReactNode]),
            ['Source', gl.source ? `"${gl.source.file}", imported ${fmt.dt(gl.source.importedAt)}; locks, groups and keycards read live from Visionline` : 'Read live from Visionline; System settings report not imported']])}
          <div className="ssr-two">
            <table className="ssr-t"><thead><tr><th>Locks by category</th><th>Locks</th><th>Online</th></tr></thead><tbody>{(gl.locks?.byCategory ?? []).map((c: any) => <tr key={c.name}><td>{c.name}</td><td>{c.n}</td><td>{c.online}</td></tr>)}</tbody></table>
            <table className="ssr-t"><thead><tr><th>Locks by door group</th><th>Locks</th><th>Online</th></tr></thead><tbody>{(gl.locks?.byDoorGroup ?? []).map((c: any) => <tr key={c.name}><td>{c.name}</td><td>{c.n}</td><td>{c.online}</td></tr>)}</tbody></table>
          </div>
        </Sec>
        {(x.insights ?? []).length > 0 && (
          <Sec title="Worth a Look">
            <ul className="ssr-insights">{x.insights.map((i: any, k: number) => <li key={k} className={i.level === 'warn' ? 'ssr-warn' : ''}>{i.text}</li>)}</ul>
          </Sec>
        )}
        {x.roomMatrix && <Sec title="User Groups vs. Rooms"><RoomMatrix m={x.roomMatrix} /></Sec>}
        <Sec title="User Groups"><table className="ssr-t"><thead><tr><th>Name</th><th>Uniform access</th><th>Override deadbolt</th><th>Override privacy</th><th>Cards with override</th><th>Time schedule</th><th>Doors / door groups</th></tr></thead>
          <tbody>{x.userGroups.map((g: any) => <tr key={g.name}><td>{g.name}</td><td>{g.uniformAccess ? 'Yes' : 'No'}</td><td>{yn(g.overrideDeadbolt)}</td><td>{yn(g.overridePrivacy)}</td><td>{g.cardsWithOverride || '—'}</td><td>{g.timeSchedule ?? 'All week'}</td><td>{g.doors.join(', ') || '—'}</td></tr>)}</tbody></table>
          <p className="small muted">Override: the group's keycards open doors even when the deadbolt or privacy is on (Visionline user group settings).</p></Sec>
        <Sec title="Door Groups vs. Rooms"><table className="ssr-t"><thead><tr><th>Door group</th><th>Doors</th></tr></thead><tbody>{x.doorGroups.map((g: any) => <tr key={g.name}><td>{g.name}</td><td>{g.doors.join(', ')}</td></tr>)}</tbody></table></Sec>
        <Sec title="Locks"><table className="ssr-t"><thead><tr><th>Lock</th><th>Door group</th><th>Category</th><th>Online</th></tr></thead><tbody>{x.locks.map((l: any) => <tr key={l.name}><td>{l.name}</td><td>{l.group ?? '—'}</td><td>{l.category ?? '—'}</td><td>{l.online === true ? 'Yes' : l.online === false ? 'No' : '—'}</td></tr>)}</tbody></table></Sec>
        <Sec title="Time Tables">{x.timeSchedules.length ? <ul>{x.timeSchedules.map((t: string) => <li key={t}>{t}</li>)}</ul> : <p>None read from Visionline.</p>}</Sec>
        <Sec title="Visionline Operators">
          {x.visionline?.operators ? (
            <>
              <p className="small muted">From "{x.visionline.operators.file}", imported {fmt.dt(x.visionline.operators.importedAt)}.</p>
              {x.visionline.operators.shared?.length > 0 && <p className="ssr-warn">Shared operators (PMS / interface type): {x.visionline.operators.shared.join(', ')}. Cards they make cannot be traced to a person: change or add named operators.</p>}
              <table className="ssr-t"><thead><tr>{x.visionline.operators.head.map((h: string) => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>{x.visionline.operators.rows.map((row: string[], i: number) => <tr key={i}>{row.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>
            </>
          ) : <p>The Visionline operators are not given by the Visionline Web API. Export the operator list from Visionline and import it above to show it here.</p>}
        </Sec>
        <Sec title="Access by User Group">
          <table className="ssr-t"><thead><tr><th>User group</th><th>People</th><th>Valid keycards</th><th>Mobile keys</th><th>Override</th><th>Door groups</th><th>Doors</th></tr></thead>
            <tbody>{(x.accessByGroup ?? []).map((g: any) => <tr key={g.name}><td>{g.name}{g.uniformAccess ? ' (uniform)' : ''}</td><td>{g.people}</td><td>{g.cards}</td><td>{g.mobileKeys || '—'}</td>
              <td>{g.overrideDeadbolt ? 'Deadbolt' : '—'}{g.cardsWithOverride ? ` · ${g.cardsWithOverride} card(s)` : ''}</td><td>{g.doorGroups.join(', ') || '—'}</td><td>{g.doors.join(', ') || '—'}</td></tr>)}</tbody></table>
        </Sec>
        <Sec title="Access by Person"><ByPerson rows={x.accessByPerson ?? []} /></Sec>
        <Sec title="System Parameters">
          {x.visionline?.systemSettings ? <>
            <p className="small muted">From the Visionline System settings report "{x.visionline.systemSettings.file}", imported {fmt.dt(x.visionline.systemSettings.importedAt)}.</p>
            {(x.visionline.systemSettings.sections ?? []).filter((sec: any) => !/^(components|internal events)$/i.test(sec.name)).map((sec: any) => (
              <div key={sec.name} className="ssr-param"><h4>{sec.name}</h4>
                {sec.name.toLowerCase() === 'events'
                  ? <ul className="ssr-cols">{(x.visionline.systemSettings.events ?? []).flatMap((g: any) => g.items.map((it: any) => <li key={`${g.group}-${it.code}`}>{it.on ? '☑' : '☐'} ({it.code}) {it.name}</li>))}</ul>
                  : sec.name.toLowerCase() === 'options'
                    ? <ul className="ssr-cols">{(x.visionline.systemSettings.options ?? []).map((o: any) => <li key={o.code}>({o.code}) {o.name}</li>)}</ul>
                    : <ul className="ssr-lines">{sec.lines.map((l: string, i: number) => <li key={i}>{l.trim()}</li>)}</ul>}
              </div>))}
          </> : <p className="ssr-warn">The Visionline system parameters come from the Visionline System settings report: import it above (Visionline reports).</p>}
        </Sec>
      </div>
      ) : (
      <div className="ssr">
        <Sec title="Portal at a Glance">
          {kv([['Property name', x.property.name], ['Time zone', x.property.timezone], ['Access Monitoring Tool', x.property.version],
            ['Connector', x.property.connector ? `${x.property.connector.name}${x.property.connector.version ? ` ${x.property.connector.version}` : ''}, last seen ${fmt.dt(x.property.connector.lastSeen)}` : 'not connected'],
            ['Visionline Web API', x.property.connector?.visionlineApi ?? '—'],
            ['Visionline operator used by the portal', x.visionline?.operatorUsed ? `${x.visionline.operatorUsed}${x.visionline.operatorShared ? ' (shared: PMS / interface type)' : ''}` : 'not set'],
            ['Personal Visionline users required', x.visionline?.personalCredentialsRequired ? 'Yes' : 'No'],
            ['Licence', x.property.licence ? `${x.property.licence.id}${x.property.licence.expires ? ` until ${x.property.licence.expires}` : ''}` : 'trial'],
            ['Portal users', `${x.access.length} (${x.access.filter((a: any) => a.mfa).length} with two-step sign-in)`],
            ['Visionline reports imported', [x.visionline?.systemSettings && 'System settings', x.visionline?.operators && 'Operators', x.visionline?.cardLog && 'Card log'].filter(Boolean).join(', ') || 'none']])}
          {(x.portalInsights ?? []).length > 0 && <ul className="ssr-insights">{x.portalInsights.map((i: any, k: number) => <li key={k} className={i.level === 'warn' ? 'ssr-warn' : ''}>{i.text}</li>)}</ul>}
          {x.visionline?.operatorShared && <p className="ssr-warn">Visionline logs every keycard made from the portal under "{x.visionline.operatorUsed}". Give each person a named Visionline operator.</p>}
        </Sec>
        <Sec title="System Access (portal users)"><table className="ssr-t"><thead><tr><th>Name</th><th>E-mail</th><th>Roles</th><th>Two-step</th><th>Last sign-in</th></tr></thead><tbody>{x.access.map((a: any) => <tr key={a.email}><td>{a.name}</td><td>{a.email}</td><td>{a.roles.join(', ')}</td><td>{a.mfa ? 'Yes' : 'No'}</td><td>{a.lastSignIn ? fmt.dt(a.lastSignIn) : 'never'}</td></tr>)}</tbody></table></Sec>
        <Sec title="Visionline Operators and People"><OperatorLinks /><p className="small muted">Which portal user each Visionline operator is, so a keycard made in Visionline shows who issued it.</p></Sec>
        <Sec title="Keycard Types"><table className="ssr-t"><thead><tr><th>Name</th><th>Description</th></tr></thead><tbody>{x.keycardTypes.map(([n, d]: string[]) => <tr key={n}><td>{n}</td><td>{d}</td></tr>)}</tbody></table></Sec>
        <Sec title="Portal Parameters">{kv(x.parameters.map(([k, v]: string[]) => [k, v]))}</Sec>
      </div>
      )}
    </>
  );
}

/** 2.20 Every room against every user group: D = the group opens the door itself, G = through its door group. */
function RoomMatrix({ m }: { m: { groups: string[]; rooms: { name: string; group: string | null; category: string | null; online: boolean | null; access: string[]; groups: number; people: number }[] } }) {
  const [q, setQ] = useState(''); const [dg, setDg] = useState(''); const [ug, setUg] = useState(''); const [only, setOnly] = useState(false);
  const doorGroups = useMemo(() => [...new Set(m.rooms.map((r) => r.group).filter(Boolean) as string[])].sort(), [m]);
  const gi = ug ? m.groups.indexOf(ug) : -1;
  const t = q.trim().toLowerCase();
  const shown = m.rooms.filter((r) => (!dg || r.group === dg) && (!t || r.name.toLowerCase().includes(t)) && (!only || r.groups === 0) && (gi < 0 || r.access[gi]));
  const cols = gi >= 0 ? [gi] : m.groups.map((_, i) => i);
  return (
    <>
      <div className="row no-print" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <input className="search" placeholder="Room" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Room" />
        <select className="search" value={dg} onChange={(e) => setDg(e.target.value)} aria-label="Door group"><option value="">All door groups</option>{doorGroups.map((x) => <option key={x}>{x}</option>)}</select>
        <select className="search" value={ug} onChange={(e) => setUg(e.target.value)} aria-label="User group"><option value="">All user groups</option>{m.groups.map((x) => <option key={x}>{x}</option>)}</select>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> Only rooms no user group opens</label>
        <span className="small muted">{shown.length} of {m.rooms.length} rooms</span>
      </div>
      <p className="small muted">✓ = the user group opens the room itself · ◐ = through its door group · People = holders of a valid staff keycard that opens it. Every room read from Visionline is listed.</p>
      <div className="ssr-matrix-wrap"><table className="ssr-t ssr-matrix">
        <thead><tr><th>Room</th><th>Door group</th>{cols.map((i) => <th key={i} className="rot"><span>{m.groups[i]}</span></th>)}<th>Groups</th><th>People</th></tr></thead>
        <tbody>{shown.map((r) => <tr key={r.name} className={r.groups ? '' : 'none'}><td>{r.name}</td><td>{r.group ?? '—'}</td>
          {cols.map((i) => <td key={i} className="c">{r.access[i] === 'D' ? '✓' : r.access[i] === 'G' ? '◐' : ''}</td>)}<td className="c">{r.groups}</td><td className="c">{r.people}</td></tr>)}</tbody>
      </table></div>
      {!m.rooms.length && <p>No rooms read from Visionline yet: press Refresh from Visionline.</p>}
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
          <td>{[r.override && 'deadbolt override', r.mobile && 'mobile key'].filter(Boolean).join(' · ')}</td></tr>)}</tbody></table>
      {!rows.length && <p>No keycards read from Visionline yet (Visionline cards &amp; people).</p>}
    </>
  );
}

/**
 * 2.21 Which person each Visionline operator is, so a keycard made in Visionline shows "Issued from Visionline ·
 * operator (person)". A user's own verified Visionline sign-in links them automatically.
 */
function OperatorLinks() {
  const { base, can } = useHotel();
  const ops = useApi<any[]>(`${base}/visionline/operators`);
  const users = useApi<any[]>(can('settings.manage') ? `${base}/operators` : null);
  const [error, setError] = useState<unknown>(null);
  if (!ops.data?.length) return null;
  const link = async (vlOperator: string, operatorId: string) => {
    setError(null);
    try { await api(`${base}/visionline/operators/link`, { method: 'PUT', body: { vlOperator, operatorId: operatorId || null } }); await ops.reload(); } catch (e) { setError(e); }
  };
  return (
    <>
      <h4>Who each Visionline operator is</h4>
      <ErrorNote error={error} />
      <table className="ssr-t"><thead><tr><th>Visionline operator</th><th>Template</th><th>Keycards known to be issued</th><th>Person (portal user)</th></tr></thead>
        <tbody>{ops.data.map((o: any) => <tr key={o.name}><td>{o.name}{o.shared ? ' (shared)' : ''}</td><td>{o.template ?? '—'}</td><td>{o.cardsIssued || '—'}</td>
          <td>{can('settings.manage') && users.data && o.portalUser?.by !== 'own Visionline sign-in'
            ? <select className="no-print" aria-label={`Person for ${o.name}`} value={o.portalUser?.id ?? ''} onChange={(e) => void link(o.name, e.target.value)}><option value="">Not linked</option>{users.data.map((u: any) => <option key={u.id} value={u.id}>{u.display_name ?? u.email}</option>)}</select>
            : null}
            <span className={can('settings.manage') && users.data && o.portalUser?.by !== 'own Visionline sign-in' ? 'print-only' : ''}>{o.portalUser ? `${o.portalUser.name}${o.portalUser.by === 'own Visionline sign-in' ? ' (own Visionline sign-in)' : ''}` : '—'}</span></td></tr>)}</tbody></table>
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

/** Seconds since `on` became true (for "Preparing the report… 12 s"). */
function useSeconds(on: boolean) {
  const [n, setN] = useState(0);
  useEffect(() => { setN(0); if (!on) return; const t = setInterval(() => setN((x) => x + 1), 1000); return () => clearInterval(t); }, [on]);
  return n;
}

/**
 * 2.28 AES key mode as Visionline reports it ([Security enhancement process] Key mode, ASSA ABLOY 66 5013 166-1B):
 * Not started = legacy key mode; In progress = AES site key made, locks being prepared, cards still legacy;
 * Finished = Visionline makes AES credentials (then a "Disable legacy key mode" card closes the locks to old cards).
 */
function AesTile({ gl }: { gl: any }) {
  const st = gl.keyMode?.state as string | null | undefined;
  const big = st === 'finished' ? 'AES (finished)' : st === 'in_progress' ? 'In progress' : st === 'not_started' ? 'Legacy key mode' : gl.aes?.enabled === true ? 'Enabled' : gl.aes?.enabled === false ? 'Not enabled' : 'Not shown in the report';
  const tone = st === 'finished' || (!st && gl.aes?.enabled) ? 'ok' : st === 'in_progress' ? 'warn' : st === 'not_started' || gl.aes?.enabled === false ? 'bad' : '';
  const why = st === 'finished' ? (gl.keyMode.disableLegacyCardCreated ? 'Visionline makes AES keycards; the "Disable legacy key mode" card has been made (locks stop accepting old cards once it is shown to each).' : 'Visionline makes AES keycards. Next: make the "Disable legacy key mode" card and show it to every lock.')
    : st === 'in_progress' ? 'AES site key generated; locks are being updated and initialised. Keycards are still made in legacy key mode.'
    : st === 'not_started' ? 'Keycards use the legacy key mode. Visionline 1.28 or newer can switch to AES (ASSA ABLOY guide "Switch to AES key mode").'
    : gl.source ? 'The imported System settings report has no [Security enhancement process] section (Visionline older than 1.28, or an older report): import it again from View → System settings.' : 'Import the System settings report (Visionline reports, above).';
  return <div className={tone}><span>AES key mode</span><strong>{big}</strong><small>{why}{gl.keyMode?.systemIdLastSet ? ` System ID last set ${gl.keyMode.systemIdLastSet}.` : ''}</small></div>;
}
