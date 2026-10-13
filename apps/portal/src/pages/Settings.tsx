import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, api, sealCredential } from '../api';
import { useHotel } from '../App';
import { ErrorNote, PageHead, Status, fmt, useApi, waitForCommand } from '../ui';
import { DoorMap, groupDoors, resolveScope, type DoorRes } from '../components/DoorMap';

type Field = { k: string; label: string; type?: 'text' | 'number' | 'bool' | 'select'; hint?: string; options?: { v: string; l: string }[]; disabled?: boolean; nullable?: boolean };
const PHASE_LATER = new Set(['guestKeys', 'pmsOccupancy', 'partnerLinks']);

const GENERIC: Record<string, { intro: string; fields: Field[] }> = {
  property: { intro: 'Shown to staff in the app and used for the hotel time zone.', fields: [
    { k: 'displayName', label: 'Hotel name' }, { k: 'supportEmail', label: 'Support email' }, { k: 'supportPhone', label: 'Support phone' },
    { k: 'homepage', label: 'Website', hint: 'https:// only', nullable: true }, { k: 'address', label: 'Main address', nullable: true, hint: 'Shown in the app with the key.' },
    { k: 'country', label: 'Country code', hint: 'Two letters, e.g. CM' },
    { k: 'timezone', label: 'Time zone', hint: 'IANA name, e.g. Africa/Douala. Visionline works in local hotel time.' },
    { k: 'checkInTime', label: 'Standard check-in' }, { k: 'checkOutTime', label: 'Standard check-out' },
  ] },
  policy: { intro: 'Limits the platform enforces before anything reaches Visionline.', fields: [
    { k: 'maxValidityHours', label: 'Longest key (hours)', type: 'number' },
    { k: 'broadDoorThreshold', label: 'Doors that count as broad access', type: 'number', hint: 'Keys with this many doors or more need approval.' },
    { k: 'broadMaxValidityHours', label: 'Longest broad-access key (hours)', type: 'number' },
    { k: 'maxFutureStartDays', label: 'Furthest start date (days ahead)', type: 'number' },
    { k: 'requireApprovalForBroad', label: 'Broad access needs a second person to approve', type: 'bool' },
    { k: 'wrongDoorLimit', label: 'Cancel the card after more than this many wrong-door attempts', type: 'number', hint: 'Visionline lock events 320 “No access to this room” and 323 “Common rooms only”, reported by the connector. 0 switches it off. K Hotel: 5.' },
  ] },
  credential_services: { intro: 'ASSA ABLOY Credential Services (SEOS) tenant used for phone set-up. Use the same URL, user and System ID as the Mobile Access account in Visionline (Options → Mobile Access → account → Server). The password is referenced by secret name, never stored here.', fields: [
    { k: 'baseUrl', label: 'URL', hint: 'Visionline accounts use https://hospitality.credential-services.api.assaabloy.com. The test setup uses the simulator.' },
    { k: 'systemId', label: 'System ID', type: 'number', hint: 'Must match the Visionline Mobile Access account (checked on Connector health).' },
    { k: 'tenantUserRef', label: 'Tenant user secret name' }, { k: 'tenantPasswordRef', label: 'Tenant password secret name' },
  ] },
  features: { intro: 'Modules can be switched on only when they are released, licensed and supported by the connector.', fields: [
    { k: 'staffMobileKeys', label: 'Staff mobile keys', type: 'bool' },
    { k: 'batteryMonitoring', label: 'Battery monitoring', type: 'bool', hint: 'Lock battery alarms from Visionline, read by the connector (version 0.5.0 or newer, with its Visionline watch on).' },
    { k: 'maintenance', label: 'Maintenance requests', type: 'bool', hint: 'Requests from the portal, the staff app and battery alarms; tasks for technicians in the app.' },
    { k: 'guestKeys', label: 'Guest keys (phase 3)', type: 'bool', disabled: true }, { k: 'pmsOccupancy', label: 'Room occupancy from PMS (phase 3)', type: 'bool', disabled: true },
    { k: 'partnerLinks', label: 'Partner links', type: 'bool', disabled: true },
  ] },
};

const TABS = [
  { id: 'property', label: 'Hotel details' },
  { id: 'buildings', label: 'Building addresses' },
  { id: 'visionline', label: 'Visionline' },
  { id: 'templates', label: 'Access templates' },
  { id: 'policy', label: 'Key policy' },
  { id: 'battery', label: 'Battery & maintenance' },
  { id: 'credential_services', label: 'Credential Services' },
  { id: 'features', label: 'Modules' },
];

export function SettingsPage() {
  const [tab, setTab] = useState(() => new URLSearchParams(location.search).get('tab') ?? 'property');
  return (
    <>
      <PageHead title="Settings" intro="Each save creates a new version you can roll back to." />
      <div className="seg" role="tablist" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        {TABS.map((x) => <button key={x.id} role="tab" aria-pressed={tab === x.id} onClick={() => setTab(x.id)}>{x.label}</button>)}
      </div>
      {tab === 'visionline' ? <VisionlineSettings />
        : tab === 'templates' ? <TemplatesSettings />
        : tab === 'battery' ? <ConfigForm key="battery" kind="policy" intro="How battery alarms and maintenance requests are handled. Part of the hotel policy; each save is a new policy version." render={(d, set) => <Phase2Policy data={d} set={set} />} />
        : tab === 'buildings' ? <ConfigForm key="buildings" kind="property" intro="Extra addresses for buildings or wings. Staff see the address (and a map link) for keys that include doors from these door groups." render={(d, set) => <BuildingsEditor data={d} set={set} />} />
        : <ConfigForm key={tab} kind={tab} intro={GENERIC[tab]!.intro} fields={GENERIC[tab]!.fields} />}
    </>
  );
}

/** One versioned configuration document: generic fields or a custom editor, plus version history. */
function ConfigForm({ kind, intro, fields, render, aside }: {
  kind: string; intro: ReactNode; fields?: Field[];
  render?: (data: any, set: (patch: any) => void) => ReactNode; aside?: ReactNode;
}) {
  const { base } = useHotel();
  const cfg = useApi<any>(`${base}/config/${kind}`);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => { if (cfg.data) setData(cfg.data.data ?? {}); }, [cfg.data]);
  if (!data) return <ErrorNote error={cfg.error} />;
  const save = async () => {
    setError(null); setOk(null);
    try { const r = await api(`${base}/config/${kind}`, { method: 'PUT', body: data }); setOk(`Saved as version ${r.version}.`); await cfg.reload(); } catch (e) { setError(e); }
  };
  const rollback = async (v: number) => {
    setError(null); setOk(null);
    try { const r = await api(`${base}/config/${kind}/rollback/${v}`, { body: {} }); setOk(`Version ${v} restored as version ${r.version}.`); await cfg.reload(); } catch (e) { setError(e); }
  };
  const setField = (f: Field, raw: any) => setData({ ...data, [f.k]: f.type === 'number' ? (raw === '' && f.nullable ? null : Number(raw)) : f.nullable && raw === '' ? null : raw });
  const live = cfg.data?.version;
  return (
    <div className="split">
      <div>
        <div className="panel">
          <p className="muted">{intro}</p>
          <ErrorNote error={error} />
          {ok && <div className="alert ok">{ok}</div>}
          {fields && <FieldGrid fields={fields} data={data} set={setField} />}
          {render?.(data, (patch) => setData((d: any) => ({ ...d, ...patch })))}
          <button className="btn primary" onClick={save} style={{ marginTop: 8 }}>Save</button>
        </div>
        {aside}
      </div>
      <div className="panel">
        <h2>Versions</h2>
        {(cfg.data?.history ?? []).length ? (
          <ul className="checklist">{cfg.data.history.map((h: any) => (
            <li key={h.version} style={{ gridTemplateColumns: '1fr auto' }}>
              <div><strong>Version {h.version}</strong>{h.version === live ? ' · live' : ''}<div className="small muted">{fmt.dt(h.created_at)} · {h.created_by ?? 'initial setup'}</div></div>
              {h.version !== live && <button className="btn" onClick={() => rollback(h.version)} title="Publish this version again">Restore</button>}
            </li>
          ))}</ul>
        ) : <p className="muted small">Not saved yet.</p>}
      </div>
    </div>
  );
}

function FieldGrid({ fields, data, set }: { fields: Field[]; data: any; set: (f: Field, raw: any) => void }) {
  return (
    <div className="field-row">
      {fields.map((f) => f.type === 'bool' ? (
        <label key={f.k} className="check" style={{ gridColumn: '1 / -1' }}><input type="checkbox" checked={Boolean(data[f.k])} disabled={f.disabled} onChange={(e) => set(f, e.target.checked)} />
          <span>{f.label}{f.disabled && PHASE_LATER.has(f.k) && <span className="small muted"> — not available yet</span>}{f.hint && <span className="hint" style={{ display: 'block' }}>{f.hint}</span>}</span></label>
      ) : (
        <div className="field" key={f.k}>
          <label htmlFor={f.k}>{f.label}</label>
          {f.type === 'select' ? (
            <select id={f.k} value={data[f.k] ?? ''} onChange={(e) => set(f, e.target.value)}>
              {!f.options?.some((o) => o.v === (data[f.k] ?? '')) && <option value={data[f.k] ?? ''}>{data[f.k] ?? '—'}{data[f.k] ? ' (not discovered)' : ''}</option>}
              {f.options?.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          ) : <input id={f.k} type={f.type === 'number' ? 'number' : 'text'} value={data[f.k] ?? ''} disabled={f.disabled} onChange={(e) => set(f, e.target.value)} />}
          {f.hint && <span className="hint">{f.hint}</span>}
        </div>
      ))}
    </div>
  );
}

// ---- Building addresses ---------------------------------------------------------------------------
function BuildingsEditor({ data, set }: { data: any; set: (p: any) => void }) {
  const { base } = useHotel();
  const doors = useApi<DoorRes[]>(`${base}/resources?kind=door`);
  const groups = groupDoors(doors.data ?? []).map((g) => g.group);
  const list: { address: string; mapUrl?: string | null; doorGroups: string[] }[] = data.buildings ?? [];
  const update = (i: number, patch: any) => set({ buildings: list.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  return (
    <>
      {data.address && <p className="small">Main address: <strong>{data.address}</strong> (Hotel details). It is used for doors not listed below.</p>}
      {list.length === 0 && <div className="empty" style={{ padding: 18 }}>No extra buildings. Add one if some doors are at a different address.</div>}
      {list.map((b, i) => (
        <div key={i} className="panel" style={{ background: '#fffdfc' }}>
          <div className="field-row">
            <div className="field"><label htmlFor={`ba${i}`}>Address</label><input id={`ba${i}`} value={b.address} onChange={(e) => update(i, { address: e.target.value })} placeholder="e.g. Annex, Rue Joss, Bonanjo, Douala" /></div>
            <div className="field"><label htmlFor={`bm${i}`}>Map link <span className="muted small">(optional)</span></label><input id={`bm${i}`} value={b.mapUrl ?? ''} onChange={(e) => update(i, { mapUrl: e.target.value || null })} placeholder="https://maps.google.com/…" /><span className="hint">https:// only. Opens from the staff app.</span></div>
          </div>
          <div className="field"><label>Door groups at this address</label>
            <div className="chips">{groups.map((g) => {
              const on = b.doorGroups.includes(g);
              return <button key={g} type="button" className="chip" aria-pressed={on} onClick={() => update(i, { doorGroups: on ? b.doorGroups.filter((x) => x !== g) : [...b.doorGroups, g] })}>{g}</button>;
            })}{!groups.length && <span className="muted small">Run resource discovery to list door groups.</span>}</div>
          </div>
          <button className="btn danger" onClick={() => set({ buildings: list.filter((_, j) => j !== i) })}>Remove building</button>
        </div>
      ))}
      <button className="btn" onClick={() => set({ buildings: [...list, { address: '', mapUrl: null, doorGroups: [] }] })}>Add building</button>
    </>
  );
}

// ---- Visionline -----------------------------------------------------------------------------------
function VisionlineSettings() {
  const { base, can } = useHotel();
  const res = useApi<any[]>(`${base}/resources`);
  const conns = useApi<any>(`${base}/connectors`, [], 5000);
  const discovered = new Map((res.data ?? []).filter((r) => r.kind === 'usergroup' && r.active).map((r) => [r.external_id, r]));
  const accounts = (res.data ?? []).filter((r) => r.kind === 'mobileaccessaccount').map((r) => ({ v: r.external_id, l: r.name }));
  const conn = (conns.data?.connectors ?? []).find((c: any) => c.status === 'ACTIVE');
  return (
    <>
      <ConnectionPanel conn={conn} canManage={can('connector.manage')} onSaved={conns.reload} />
      <ConfigForm kind="visionline" intro="How keys are created in Visionline. These settings mirror Visionline Options so the platform and the app behave the same way as the lock system."
        render={(d, set) => <VisionlineFields data={d} set={set} accounts={accounts} discovered={discovered} onDiscovered={res.reload} />} />
    </>
  );
}

function ConnectionPanel({ conn, canManage, onSaved }: { conn: any; canManage: boolean; onSaved: () => void }) {
  const { base, hotel } = useHotel();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [accessId, setAccessId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  const h = conn?.health ?? {};
  const save = async () => {
    setBusy(true); setError(null); setOk(null);
    try {
      const sealed = await sealCredential(base, hotel.id, 'property', username, password, undefined, accessId || undefined);
      const r = await api(`${base}/visionline/property-credentials`, { method: 'PUT', body: { username, sealed } });
      setPassword('');
      const c = await waitForCommand(hotel.id, r.commandId, 90_000);
      if (c.status === 'SUCCEEDED') { setOk(`Visionline accepted “${username}”. The connector now uses it for the property.`); setUsername(''); setAccessId(''); onSaved(); }
      else setError(new ApiError(0, c.error?.code ?? 'CONNECTOR_ERROR', c.error?.message ?? 'The connector did not confirm the credentials.'));
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="panel">
      <h2>Connection to Visionline</h2>
      {!conn ? <div className="alert warn">No active connector yet. Install it on the Visionline PC (Connector health).</div> : (
        <dl className="kv" style={{ marginBottom: 16 }}>
          <dt>Visionline URL</dt><dd className="mono">{h.visionlineBaseUrl ?? '—'}</dd>
          <dt>Reachable</dt><dd><Status s={h.visionlineReachable ? 'ACTIVE' : 'FAILED'} label={h.visionlineReachable ? `Yes${h.visionlineApiVersion ? ` · API ${h.visionlineApiVersion}` : ''}` : 'No'} /></dd>
          <dt>Property credentials</dt><dd>{h.credentialsConfigured ? <><span className="mono">{h.propertyUsername ?? 'set on the connector'}</span> <Status s="ACTIVE" label="In use" /></> : <Status s="FAILED" label="Not set" />}</dd>
          <dt>Connector</dt><dd>{conn.name} · version {h.connectorVersion ?? '—'} · seen {fmt.rel(conn.last_seen_at)}</dd>
        </dl>
      )}
      {canManage && conn && (
        <>
          <h3 className="section-title">Change property credentials</h3>
          <p className="small muted">The Visionline operator the connector uses when an operator has no personal credentials. The password is encrypted in this browser for the connector on the Visionline PC; the platform never sees it. The connector tests it with Visionline before switching.</p>
          <ErrorNote error={error} />
          {ok && <div className="alert ok">{ok}</div>}
          <div className="field-row">
            <div className="field"><label htmlFor="pu">Username</label><input id="pu" autoComplete="off" value={username} placeholder={h.propertyUsername ?? ''} onChange={(e) => setUsername(e.target.value)} /></div>
            <div className="field"><label htmlFor="pp">Password</label><input id="pp" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
            <div className="field"><label htmlFor="pa">Access ID <span className="muted small">(if Visionline asks for one)</span></label><input id="pa" autoComplete="off" value={accessId} onChange={(e) => setAccessId(e.target.value)} /></div>
          </div>
          <button className="btn primary" disabled={busy || !username || !password} onClick={save}>{busy ? 'Testing with Visionline…' : 'Test and save'}</button>
        </>
      )}
    </div>
  );
}

function VisionlineFields({ data, set, accounts, discovered, onDiscovered }: {
  data: any; set: (p: any) => void; accounts: { v: string; l: string }[]; discovered: Map<string, any>; onDiscovered: () => void;
}) {
  const { base, hotel, can } = useHotel();
  const groups: string[] = data.userGroups ?? [];
  const [newGroup, setNewGroup] = useState('');
  const [uniform, setUniform] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const create = async (name: string, uniformAccess: boolean) => {
    setBusy(name); setError(null);
    try {
      const r = await api(`${base}/visionline/user-groups`, { body: { userGroup: name, uniformAccess } });
      const c = await waitForCommand(hotel.id, r.commandId, 60_000);
      if (c.status !== 'SUCCEEDED') throw new ApiError(0, c.error?.code ?? 'CONNECTOR_ERROR', c.error?.message ?? 'Visionline did not create the group.');
      onDiscovered();
    } catch (e) { setError(e); } finally { setBusy(null); }
  };
  const add = () => {
    const n = newGroup.trim();
    if (!n || groups.includes(n)) return;
    set({ userGroups: [...groups, n] });
    setNewGroup('');
  };
  const f = (k: string, v: any) => set({ [k]: v });
  return (
    <>
      <h3 className="section-title">Mobile Access (Visionline Options)</h3>
      <div className="field-row">
        <div className="field"><label htmlFor="uuid">Mobile Access UUID</label>
          <input id="uuid" type="number" min={0} max={65535} value={data.mobileAccessUuid ?? ''} onChange={(e) => f('mobileAccessUuid', e.target.value === '' ? null : Number(e.target.value))} />
          <span className="hint">Copy from Visionline: Options → Mobile Access → UUID. K Hotel Bana uses 9. The staff app uses it to find this hotel’s locks.</span></div>
        <div className="field"><label htmlFor="rm">Revoke mobile key</label>
          <select id="rm" value={data.revokeMode ?? 'overridden'} onChange={(e) => f('revokeMode', e.target.value)}>
            <option value="overridden">When overridden</option><option value="expired">When expired</option>
          </select>
          <span className="hint">Must match Visionline Options → Mobile Access. With “when overridden”, changing a key’s doors removes the old key from the phone automatically.</span></div>
      </div>

      <h3 className="section-title">Keys</h3>
      <div className="field-row">
        <div className="field"><label htmlFor="dug">Default staff user group</label>
          <select id="dug" value={data.defaultUserGroup} onChange={(e) => f('defaultUserGroup', e.target.value)}>
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select><span className="hint">Used for staff without their own group.</span></div>
        <div className="field"><label htmlFor="acc">Mobile access account</label>
          <select id="acc" value={data.accountName ?? ''} onChange={(e) => f('accountName', e.target.value || null)}>
            <option value="">Visionline default account</option>
            {data.accountName && !accounts.some((a) => a.v === data.accountName) && <option value={data.accountName}>{data.accountName} (not discovered)</option>}
            {accounts.map((a) => <option key={a.v} value={a.v}>{a.l}</option>)}
          </select></div>
        <div className="field"><label htmlFor="kl">Key label</label><input id="kl" value={data.keyLabel ?? ''} maxLength={32} onChange={(e) => f('keyLabel', e.target.value || null)} />
          <span className="hint">Up to 32 characters. Visionline placeholders such as %ROOMNUM% are allowed.</span></div>
      </div>
      <div className="field-row">
        <div className="field"><label htmlFor="stm">Keys that start later</label>
          <select id="stm" value={data.startTimeMode ?? 'hold'} onChange={(e) => f('startTimeMode', e.target.value)}>
            <option value="hold">Platform creates the key at its start time</option>
            <option value="send">Create now with a future start time (validation test only)</option>
          </select>
          <span className="hint">Every key has a start and an end. The Web API says a staff card’s start time should not be in the future (§7.6.2), so by default the platform waits and creates the key at its start time. Choose the second option only once ASSA ABLOY confirms future start times for staff mobile keys.</span></div>
      </div>
      <label className="check"><input type="checkbox" checked={Boolean(data.requirePersonalCredentials)} onChange={(e) => f('requirePersonalCredentials', e.target.checked)} />
        <span>Operators must use their own Visionline credentials to issue keys<span className="hint" style={{ display: 'block' }}>Each operator adds them under Your account → Visionline credentials. Keys are then recorded in Visionline under that operator’s name.</span></span></label>

      <h3 className="section-title">Staff user groups</h3>
      <p className="small muted">The Visionline user groups staff can belong to. Each group’s doors (set in Visionline) can be added to a key or a template. Uniform-access groups always get exactly the group’s doors.</p>
      <ErrorNote error={error} />
      <ul className="listed">
        {groups.map((g) => {
          const r = discovered.get(g);
          const ops = (r?.data?.doorOperations ?? []) as any[];
          const nDoors = ops.reduce((n, o) => n + (o.doors?.length ?? 0), 0), nGroups = ops.reduce((n, o) => n + (o.doorGroups?.length ?? 0), 0);
          return (
            <li key={g}>
              <div><strong>{g}</strong>{g === data.defaultUserGroup && <span className="small muted"> · default</span>}
                <div className="meta">{r ? <>In Visionline{r.data?.uniformAccess ? ' · uniform access' : ''}{nDoors || nGroups ? ` · ${nDoors ? `${nDoors} ${nDoors === 1 ? "door" : "doors"}` : ''}${nDoors && nGroups ? ', ' : ''}${nGroups ? `${nGroups} door ${nGroups === 1 ? "group" : "groups"}` : ''}` : ' · no doors set'}</> : 'Not found in Visionline yet (run discovery, or create it)'}</div></div>
              <div className="row">
                {!r && can('settings.manage') && <button className="btn" disabled={busy === g} onClick={() => create(g, false)}>{busy === g ? 'Creating…' : 'Create in Visionline'}</button>}
                {g !== data.defaultUserGroup && <button className="btn" onClick={() => set({ userGroups: groups.filter((x) => x !== g) })} title="Stop using this group here. It stays in Visionline.">Remove</button>}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field" style={{ marginBottom: 0 }}><label htmlFor="ng">Add a group</label><input id="ng" value={newGroup} maxLength={60} onChange={(e) => setNewGroup(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="e.g. Engineering" /></div>
        <button className="btn" onClick={add} disabled={!newGroup.trim()}>Add to list</button>
        {can('settings.manage') && <><label className="check" style={{ margin: 0 }}><input type="checkbox" checked={uniform} onChange={(e) => setUniform(e.target.checked)} /><span>Uniform access</span></label>
          <button className="btn" disabled={!newGroup.trim() || Boolean(busy)} onClick={async () => { const n = newGroup.trim(); await create(n, uniform); if (!groups.includes(n)) set({ userGroups: [...groups, n] }); setNewGroup(''); }}>Add and create in Visionline</button></>}
      </div>
      <p className="hint small" style={{ marginTop: 6 }}>Remember to Save so the list is kept. Door access for a group is set in Visionline itself.</p>
    </>
  );
}

// ---- Access templates -----------------------------------------------------------------------------
const EMPTY_TPL = { name: '', description: '', doorIds: [] as string[], doorGroupIds: [] as string[], userGroupIds: [] as string[], allowedJobRoles: [] as string[], isBroad: false, maxValidityHours: 12, timeSchedule: '' };

function TemplatesSettings() {
  const { base, can } = useHotel();
  const tpls = useApi<any[]>(`${base}/templates`);
  const doors = useApi<DoorRes[]>(`${base}/resources?kind=door`);
  const ugs = useApi<any[]>(`${base}/resources?kind=usergroup`);
  const staff = useApi<any[]>(`${base}/staff`);
  const ts = useApi<any[]>(`${base}/resources?kind=timeschedule`);
  const schedules: string[] = (ts.data ?? []).filter((t) => t.active).map((t) => t.external_id);
  const [edit, setEdit] = useState<(typeof EMPTY_TPL & { id?: string }) | null>(null);
  const [error, setError] = useState<unknown>(null);
  const ugMap = useMemo(() => new Map((ugs.data ?? []).filter((g) => g.active).map((g) => {
    const ops = (g.data?.doorOperations ?? []) as any[];
    return [g.external_id, { doors: ops.flatMap((o) => o.doors ?? []) as string[], doorGroups: ops.flatMap((o) => o.doorGroups ?? []) as string[], uniform: Boolean(g.data?.uniformAccess) }];
  })), [ugs.data]);
  const roles = [...new Set((staff.data ?? []).map((s) => s.job_role).filter(Boolean))].sort();
  const count = (t: { doorIds: string[]; doorGroupIds: string[]; userGroupIds: string[] }) => {
    const g = t.userGroupIds.map((u) => ugMap.get(u)).filter(Boolean) as { doors: string[]; doorGroups: string[] }[];
    return resolveScope(doors.data ?? [], [...t.doorIds, ...g.flatMap((x) => x.doors)], [...t.doorGroupIds, ...g.flatMap((x) => x.doorGroups)]).size;
  };
  const fromRow = (t: any) => ({ id: t.id, name: t.name, description: t.description ?? '', doorIds: t.door_ids, doorGroupIds: t.door_group_ids, userGroupIds: t.user_group_ids ?? [], allowedJobRoles: t.allowed_job_roles, isBroad: t.is_broad, maxValidityHours: t.max_validity_hours, timeSchedule: t.time_schedule ?? '' });
  const save = async () => {
    if (!edit) return;
    setError(null);
    const { id, ...body } = edit;
    try {
      await api(id ? `${base}/templates/${id}` : `${base}/templates`, { method: id ? 'PUT' : 'POST', body: { ...body, description: body.description || null, timeSchedule: body.timeSchedule || null } });
      setEdit(null); await tpls.reload();
    } catch (e) { setError(e); }
  };
  const remove = async (id: string) => { setError(null); try { await api(`${base}/templates/${id}`, { method: 'DELETE' }); setEdit(null); await tpls.reload(); } catch (e) { setError(e); } };
  const manage = can('templates.manage');

  if (edit) {
    const pickable = [...ugMap.entries()].filter(([, g]) => !g.uniform);
    return (
      <div className="panel">
        <h2>{edit.id ? `Edit “${edit.name}”` : 'New access template'}</h2>
        <ErrorNote error={error} />
        <div className="field-row">
          <div className="field"><label htmlFor="tn">Name</label><input id="tn" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="e.g. Housekeeping floor 2" /></div>
          <div className="field"><label htmlFor="td">Description <span className="muted small">(optional)</span></label><input id="td" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></div>
          <div className="field"><label htmlFor="th">Longest key (hours)</label><input id="th" type="number" min={1} max={744} value={edit.maxValidityHours} onChange={(e) => setEdit({ ...edit, maxValidityHours: Number(e.target.value) })} /></div>
          <div className="field"><label htmlFor="ts">Visionline time schedule</label>
            <select id="ts" value={edit.timeSchedule} onChange={(e) => setEdit({ ...edit, timeSchedule: e.target.value })}>
              <option value="">None (doors open at any time)</option>
              {edit.timeSchedule && !schedules.includes(edit.timeSchedule) && <option value={edit.timeSchedule}>{edit.timeSchedule} (not discovered)</option>}
              {schedules.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <span className="hint">Only keys from this template carry it.</span></div>
        </div>
        <div className="field"><label>Visionline user groups</label>
          <div className="chips">{pickable.map(([id]) => {
            const on = edit.userGroupIds.includes(id);
            return <button key={id} type="button" className="chip" aria-pressed={on} onClick={() => setEdit({ ...edit, userGroupIds: on ? edit.userGroupIds.filter((x) => x !== id) : [...edit.userGroupIds, id] })}>{id}</button>;
          })}{!pickable.length && <span className="muted small">No discovered user groups with doors.</span>}</div>
          <span className="hint">The doors set on these groups in Visionline are included.</span></div>
        <div className="field"><label>Doors</label>
          <DoorMap doors={doors.data ?? []} doorIds={edit.doorIds} groupIds={edit.doorGroupIds} onChange={(n) => setEdit({ ...edit, doorIds: n.doorIds, doorGroupIds: n.groupIds })} /></div>
        <div className="field"><label>Only for these job roles <span className="muted small">(none selected = everyone)</span></label>
          <div className="chips">{roles.map((r) => {
            const on = edit.allowedJobRoles.includes(r);
            return <button key={r} type="button" className="chip" aria-pressed={on} onClick={() => setEdit({ ...edit, allowedJobRoles: on ? edit.allowedJobRoles.filter((x) => x !== r) : [...edit.allowedJobRoles, r] })}>{r}</button>;
          })}</div></div>
        <label className="check"><input type="checkbox" checked={edit.isBroad} onChange={(e) => setEdit({ ...edit, isBroad: e.target.checked })} /><span>Broad access: always needs approval</span></label>
        <div className="scope-sum" style={{ margin: '14px 0' }}><span className="big">{count(edit)}</span><span>doors in this template.</span></div>
        <div className="row">
          <button className="btn primary" onClick={save} disabled={edit.name.trim().length < 2 || count(edit) === 0}>Save template</button>
          <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
          {edit.id && <button className="btn danger" onClick={() => remove(edit.id!)}>Delete</button>}
        </div>
      </div>
    );
  }
  return (
    <div className="panel flush">
      <div className="row" style={{ padding: '14px 18px', justifyContent: 'space-between' }}>
        <p className="muted" style={{ margin: 0 }}>Ready-made door sets for issuing keys quickly. Templates can combine doors, floors and Visionline user groups.</p>
        {manage && <button className="btn primary" onClick={() => setEdit({ ...EMPTY_TPL })}>New template</button>}
      </div>
      <ErrorNote error={error ?? tpls.error} />
      <table className="grid">
        <thead><tr><th>Template</th><th>Doors</th><th>User groups</th><th>Time schedule</th><th>Job roles</th><th>Longest key</th></tr></thead>
        <tbody>
          {(tpls.data ?? []).map((t) => {
            const v = fromRow(t);
            return (
              <tr key={t.id} className={manage ? 'click' : ''} onClick={() => manage && setEdit(v)}>
                <td><strong>{t.name}</strong>{t.is_broad && <span className="sub">Broad access · needs approval</span>}{t.description && <span className="sub">{t.description}</span>}</td>
                <td>{count(v)}</td>
                <td>{v.userGroupIds.join(', ') || '—'}</td>
                <td>{t.time_schedule || '—'}</td>
                <td>{t.allowed_job_roles.join(', ') || 'Everyone'}</td>
                <td>{t.max_validity_hours} h</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {tpls.data && !tpls.data.length && <div className="empty">No templates yet.</div>}
    </div>
  );
}

/** Settings → Battery & maintenance: policy.battery and policy.maintenance. */
function Phase2Policy({ data, set }: { data: any; set: (patch: any) => void }) {
  const b = { staleAfterDays: 30, autoTicket: 'critical', voltage: { highRange: { low: null, critical: null }, lowRange: { low: null, critical: null } }, ...(data.battery ?? {}) };
  const m = { dueHours: { low: 168, normal: 72, high: 24, urgent: 4 }, notifyJobRoles: ['Maintenance'], staffCanReport: true, ...(data.maintenance ?? {}) };
  const setB = (patch: any) => set({ battery: { ...b, ...patch } });
  const setM = (patch: any) => set({ maintenance: { ...m, ...patch } });
  const volt = (range: 'highRange' | 'lowRange', k: 'low' | 'critical', v: string) => setB({ voltage: { ...b.voltage, [range]: { ...b.voltage[range], [k]: v === '' ? null : Number(v) } } });
  const [roles, setRoles] = useState((m.notifyJobRoles ?? []).join(', '));
  return (
    <>
      <h3 className="section-title">Battery alarms</h3>
      <div className="field-row">
        <div className="field"><label htmlFor="stale">A reading is stale after (days)</label><input id="stale" type="number" min={1} max={365} value={b.staleAfterDays} onChange={(e) => setB({ staleAfterDays: Number(e.target.value) })} />
          <span className="hint">Locks report only when their events reach Visionline.</span></div>
        <div className="field"><label htmlFor="auto">Open a maintenance request automatically for</label>
          <select id="auto" value={b.autoTicket} onChange={(e) => setB({ autoTicket: e.target.value })}>
            <option value="critical">Critical alarms</option><option value="any">Low and critical alarms</option><option value="off">Never (open them by hand)</option>
          </select></div>
      </div>
      <p className="small muted" style={{ marginBottom: 6 }}>Voltage thresholds, for locks that send “Battery level below X volts” events (Visionline events 1056–1081). Leave empty to show the reading without raising alarms. Take the values from your lock models’ documentation.</p>
      <div className="field-row">
        <div className="field"><label htmlFor="hl">6–9 V packs: Low at or below</label><input id="hl" type="number" step={0.2} min={6} max={9} value={b.voltage.highRange.low ?? ''} onChange={(e) => volt('highRange', 'low', e.target.value)} /></div>
        <div className="field"><label htmlFor="hc">6–9 V packs: Critical at or below</label><input id="hc" type="number" step={0.2} min={6} max={9} value={b.voltage.highRange.critical ?? ''} onChange={(e) => volt('highRange', 'critical', e.target.value)} /></div>
        <div className="field"><label htmlFor="ll">3–4.8 V cells: Low at or below</label><input id="ll" type="number" step={0.2} min={3} max={4.8} value={b.voltage.lowRange.low ?? ''} onChange={(e) => volt('lowRange', 'low', e.target.value)} /></div>
        <div className="field"><label htmlFor="lc">3–4.8 V cells: Critical at or below</label><input id="lc" type="number" step={0.2} min={3} max={4.8} value={b.voltage.lowRange.critical ?? ''} onChange={(e) => volt('lowRange', 'critical', e.target.value)} /></div>
      </div>
      <h3 className="section-title">Maintenance requests</h3>
      <p className="small muted" style={{ marginBottom: 6 }}>Time to complete a new request, by priority (hours).</p>
      <div className="field-row">
        {(['urgent', 'high', 'normal', 'low'] as const).map((k) => (
          <div className="field" key={k}><label htmlFor={`due-${k}`}>{k[0]!.toUpperCase() + k.slice(1)}</label><input id={`due-${k}`} type="number" min={1} value={m.dueHours[k]} onChange={(e) => setM({ dueHours: { ...m.dueHours, [k]: Number(e.target.value) } })} /></div>
        ))}
      </div>
      <div className="field"><label htmlFor="roles">Tell staff with these job roles about new requests and battery alarms</label>
        <input id="roles" value={roles} onChange={(e) => { setRoles(e.target.value); setM({ notifyJobRoles: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) }); }} />
        <span className="hint">Comma-separated job roles as on the Staff page, for example Maintenance, Engineering.</span></div>
      <label className="check"><input type="checkbox" checked={m.staffCanReport} onChange={(e) => setM({ staffCanReport: e.target.checked })} /><span>Staff can report a problem from the app</span></label>
    </>
  );
}
