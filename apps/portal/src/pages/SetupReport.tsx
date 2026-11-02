import type { ReactNode } from 'react';
import { useHotel } from '../App';
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
      <div className="ssr-right"><em>Staff access {x.property.version}</em><span>System ID: {x.property.systemId ?? '—'}</span><span>Property name: {x.property.name}</span></div>
    </div>
  );
  const Sec = ({ title, children }: { title: string; children: ReactNode }) => (
    <section className="ssr-page"><Head title={title} />{children}<div className="ssr-foot"><em>Printed: {fmt.dt(x.printedAt)} by {x.printedBy}</em></div></section>
  );
  const kv = (rows: [string, ReactNode][]) => <dl className="ssr-kv">{rows.map(([k, v]) => <div key={k}><dt>{k}:</dt><dd>{v}</dd></div>)}</dl>;
  return (
    <>
      <PageHead title="System setup report" intro="The hotel's set-up in one printable document: locks, user groups, door groups, keycard types, who has access and the main parameters.">
        <button className="btn primary" onClick={() => window.print()}>Print / PDF</button>
      </PageHead>
      <div className="ssr">
        <Sec title="Property">{kv([['Property name', x.property.name], ['System ID', x.property.systemId ?? '—'], ['Time zone', x.property.timezone], ['Version', x.property.version],
          ['Locks', `${x.property.locks} (${x.property.locksOnline} online)`], ['User groups', x.property.userGroups], ['Door groups', x.property.doorGroups], ['Time schedules', x.property.timeSchedules],
          ['Encoders', x.property.encoders.join(', ') || '—'], ['People in Visionline', x.property.visionlineUsers], ['Valid keycards', x.property.validKeycards],
          ['Connector', x.property.connector ? `${x.property.connector.name} ${x.property.connector.version ?? ''}, last seen ${fmt.dt(x.property.connector.lastSeen)}` : 'not connected'],
          ['Licence', x.property.licence ? `${x.property.licence.id}${x.property.licence.expires ? ` until ${x.property.licence.expires}` : ''}` : 'trial']])}</Sec>
        <Sec title="Keycard Types"><table className="ssr-t"><thead><tr><th>Name</th><th>Description</th></tr></thead><tbody>{x.keycardTypes.map(([n, d]: string[]) => <tr key={n}><td>{n}</td><td>{d}</td></tr>)}</tbody></table></Sec>
        <Sec title="User Groups"><table className="ssr-t"><thead><tr><th>Name</th><th>Uniform access</th><th>Time schedule</th><th>Doors / door groups</th></tr></thead>
          <tbody>{x.userGroups.map((g: any) => <tr key={g.name}><td>{g.name}</td><td>{g.uniformAccess ? 'Yes' : 'No'}</td><td>{g.timeSchedule ?? 'All week'}</td><td>{g.doors.join(', ') || '—'}</td></tr>)}</tbody></table></Sec>
        <Sec title="Door Groups vs. Rooms"><table className="ssr-t"><thead><tr><th>Door group</th><th>Doors</th></tr></thead><tbody>{x.doorGroups.map((g: any) => <tr key={g.name}><td>{g.name}</td><td>{g.doors.join(', ')}</td></tr>)}</tbody></table></Sec>
        <Sec title="Locks"><table className="ssr-t"><thead><tr><th>Lock</th><th>Door group</th><th>Category</th><th>Online</th></tr></thead><tbody>{x.locks.map((l: any) => <tr key={l.name}><td>{l.name}</td><td>{l.group ?? '—'}</td><td>{l.category ?? '—'}</td><td>{l.online === true ? 'Yes' : l.online === false ? 'No' : '—'}</td></tr>)}</tbody></table></Sec>
        <Sec title="Time Tables">{x.timeSchedules.length ? <ul>{x.timeSchedules.map((t: string) => <li key={t}>{t}</li>)}</ul> : <p>None read from Visionline.</p>}</Sec>
        <Sec title="System Access"><table className="ssr-t"><thead><tr><th>Name</th><th>E-mail</th><th>Roles</th><th>Two-step</th><th>Last sign-in</th></tr></thead><tbody>{x.access.map((a: any) => <tr key={a.email}><td>{a.name}</td><td>{a.email}</td><td>{a.roles.join(', ')}</td><td>{a.mfa ? 'Yes' : 'No'}</td><td>{a.lastSignIn ? fmt.dt(a.lastSignIn) : 'never'}</td></tr>)}</tbody></table></Sec>
        <Sec title="System Parameters">{kv(x.parameters.map(([k, v]: string[]) => [k, v]))}</Sec>
      </div>
    </>
  );
}
