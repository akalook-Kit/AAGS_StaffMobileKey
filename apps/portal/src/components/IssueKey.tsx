import { useMemo, useState } from 'react';
import { api } from '../api';
import { useHotel } from '../App';
import { Drawer, ErrorNote, useApi } from '../ui';
import { DoorMap, resolveScope, type DoorRes } from './DoorMap';

const pad = (n: number) => String(n).padStart(2, '0');
const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Issue a staff mobile key (spec §13.2 steps 5–7). One Idempotency-Key per drawer: retries never double-issue. */
export function IssueKey({ staffId: initialStaff, replaceKey, onClose, onIssued }: { staffId?: string; replaceKey?: any; onClose: () => void; onIssued: (key: any) => void }) {
  const { base } = useHotel();
  const replacing = Boolean(replaceKey);
  if (replaceKey) initialStaff = replaceKey.staffId;
  const ugRes = useApi<any[]>(`${base}/resources?kind=usergroup`);
  const vlCfg = useApi<any>(`${base}/config/visionline`);
  const staff = useApi<any[]>(`${base}/staff`);
  const doors = useApi<DoorRes[]>(`${base}/resources?kind=door`);
  const templates = useApi<any[]>(`${base}/templates`);
  const policy = useApi<any>(`${base}/config/policy`);
  const [idem] = useState(() => crypto.randomUUID());
  const [staffId, setStaffId] = useState(initialStaff ?? '');
  const [templateId, setTemplateId] = useState<string>('');
  const [scope, setScope] = useState<{ doorIds: string[]; groupIds: string[] }>(() => replaceKey
    ? { doorIds: replaceKey.requestedScope?.resolvedDoorIds ?? [], groupIds: [] } : { doorIds: [], groupIds: [] });
  const [userGroupIds, setUserGroupIds] = useState<string[]>([]);
  const [hours, setHours] = useState<number | 'custom'>(8);
  const [customEnd, setCustomEnd] = useState(toLocalInput(new Date(Date.now() + 8 * 3600_000)));
  const [startMode, setStartMode] = useState<'now' | 'later'>('now');
  const [start, setStart] = useState(toLocalInput(new Date(Date.now() + 24 * 3600_000 - (Date.now() % 3600_000))));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const person = staff.data?.find((s) => s.id === staffId);
  const tpl = templates.data?.find((t) => t.id === templateId);
  const allowedTemplates = (templates.data ?? []).filter((t) => !person || !t.allowed_job_roles.length || t.allowed_job_roles.includes(person.job_role));
  const doorList = doors.data ?? [];
  // Visionline user groups carry their own door operations [§5.29]; a key can add a group's doors.
  const ugMap = useMemo(() => new Map((ugRes.data ?? []).filter((g) => g.active).map((g) => {
    const ops = (g.data?.doorOperations ?? []) as { doors?: string[]; doorGroups?: string[] }[];
    return [g.external_id, { doors: ops.flatMap((o) => o.doors ?? []), doorGroups: ops.flatMap((o) => o.doorGroups ?? []), uniform: Boolean(g.data?.uniformAccess) }];
  })), [ugRes.data]);
  const holderGroup: string | null = person ? (person.visionline_user_group ?? vlCfg.data?.data?.defaultUserGroup ?? null) : null;
  const uniform = Boolean(holderGroup && ugMap.get(holderGroup)?.uniform);
  const pickableGroups = [...ugMap.entries()].filter(([, g]) => !g.uniform && (g.doors.length || g.doorGroups.length));
  const effective = useMemo(() => {
    if (uniform) {
      const g = ugMap.get(holderGroup!)!;
      return { doorIds: g.doors, groupIds: g.doorGroups, set: resolveScope(doorList, g.doors, g.doorGroups), baseDoors: new Set<string>(), baseGroups: new Set<string>() };
    }
    const ugs = [...(tpl?.user_group_ids ?? []), ...userGroupIds].map((id) => ugMap.get(id)).filter(Boolean) as { doors: string[]; doorGroups: string[] }[];
    // Doors that come from the template or a user group are fixed; the map adds to them.
    const baseDoors = new Set<string>([...(tpl?.door_ids ?? []), ...ugs.flatMap((g) => g.doors)]);
    const baseGroups = new Set<string>([...(tpl?.door_group_ids ?? []), ...ugs.flatMap((g) => g.doorGroups)]);
    const ids = [...baseDoors, ...scope.doorIds];
    const groups = [...baseGroups, ...scope.groupIds];
    return { doorIds: ids, groupIds: groups, set: resolveScope(doorList, ids, groups), baseDoors, baseGroups };
  }, [tpl, scope, doorList, userGroupIds, ugMap, uniform, holderGroup]);
  const p = policy.data?.data ?? { maxValidityHours: 24, broadDoorThreshold: 15, broadMaxValidityHours: 12 };
  const isBroad = Boolean(tpl?.is_broad) || effective.set.size >= p.broadDoorThreshold;
  const startAt = startMode === 'now' ? new Date() : new Date(start);
  const endAt = hours === 'custom' ? new Date(customEnd) : new Date(startAt.getTime() + hours * 3600_000);
  const maxH = Math.min(p.maxValidityHours, tpl?.max_validity_hours ?? Infinity, isBroad ? p.broadMaxValidityHours : Infinity);
  const validH = (endAt.getTime() - startAt.getTime()) / 3600_000;
  const ready = person && (replacing || person.endpoint_status === 'ACTIVE') && effective.set.size > 0 && validH > 0 && validH <= maxH + 1e-6;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const common = { templateId: uniform ? null : templateId || null, doorIds: uniform ? [] : scope.doorIds, doorGroupIds: uniform ? [] : scope.groupIds, userGroupIds: uniform ? [] : userGroupIds, expiresAt: endAt.toISOString(), reason: reason || null };
      const key = replacing
        ? await api(`${base}/keys/${replaceKey.id}/replace`, { body: common, headers: { 'idempotency-key': idem } })
        : await api(`${base}/keys`, { body: { ...common, staffId, startsAt: startMode === 'later' ? startAt.toISOString() : null }, headers: { 'idempotency-key': idem } });
      onIssued(key);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const eligible = (staff.data ?? []).filter((s) => s.status === 'ACTIVE');
  return (
    <Drawer title={replacing ? `Change doors · ${replaceKey.staffName}` : 'Issue a mobile key'} onClose={onClose} footer={
      <>
        <span className="small muted">{isBroad ? `Broad access: a Security Manager or Approver must approve it, and it can last at most ${p.broadMaxValidityHours} h.` : `Up to ${Number.isFinite(maxH) ? maxH : p.maxValidityHours} h for this scope.`}</span>
        <div className="row"><button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ready || busy} onClick={submit}>{busy ? 'Sending…' : isBroad ? 'Request approval' : replacing ? 'Replace key' : 'Issue key'}</button></div>
      </>
    }>
      <ErrorNote error={error} />
      {replacing && <div className="alert">The new key replaces the current one in Visionline (override). With “Revoke mobile key when overridden” set in Visionline Options, the old key leaves the phone automatically; otherwise the platform revokes it. The new key starts now.</div>}
      {!replacing && <div className="field">
        <label htmlFor="who">Staff member</label>
        <select id="who" value={staffId} onChange={(e) => { setStaffId(e.target.value); setTemplateId(''); }}>
          <option value="">Choose a person…</option>
          {eligible.map((s) => <option key={s.id} value={s.id} disabled={s.endpoint_status !== 'ACTIVE'}>{s.full_name} · {s.job_role}{s.endpoint_status !== 'ACTIVE' ? ' (phone not set up)' : ''}</option>)}
        </select>
        {person && person.endpoint_status !== 'ACTIVE' && <span className="hint">Ask {person.full_name.split(' ')[0]} to sign in to the staff app and set up their phone first.</span>}
        {person && ['ISSUED', 'ISSUING', 'QUEUED', 'SCHEDULED', 'PENDING_APPROVAL', 'REVOKING'].includes(person.key_status) && new Date(person.key_expires_at) > new Date() &&
          <div className="alert warn" style={{ marginTop: 8 }}>{person.full_name} already has a live key. Visionline allows one staff key per person: open it in Mobile keys and use “Change doors”, or revoke it first.</div>}
      </div>}
      {uniform && <div className="alert">{person?.full_name} is in the Visionline user group <strong>{holderGroup}</strong>, which uses uniform access. Visionline puts that group’s doors on the key, so doors can’t be chosen here.</div>}

      {!uniform && <>
      <div className="field">
        <label htmlFor="tpl">Access template</label>
        <select id="tpl" value={templateId} onChange={(e) => { setTemplateId(e.target.value); setScope({ doorIds: [], groupIds: [] }); }}>
          <option value="">No template: choose doors on the map</option>
          {allowedTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.is_broad ? ' · needs approval' : ''}</option>)}
        </select>
        {tpl?.description && <span className="hint">{tpl.description}</span>}
      </div>

      <div className="field">
        <label>Doors</label>
        <span className="hint" style={{ marginBottom: 6 }}>{tpl || userGroupIds.length ? 'Doors from the template or user group are shown. Add more by selecting them.' : 'Select a floor to include all of its doors, or pick individual doors.'}</span>
        <DoorMap doors={doorList} doorIds={effective.doorIds} groupIds={effective.groupIds}
          onChange={(next) => setScope({ doorIds: next.doorIds.filter((d) => !effective.baseDoors.has(d)), groupIds: next.groupIds.filter((g) => !effective.baseGroups.has(g)) })} />
      </div>
      {pickableGroups.length > 0 && (
        <div className="field">
          <label>Add a Visionline user group’s doors</label>
          <div className="chips">
            {pickableGroups.map(([id]) => {
              const fromTpl = (tpl?.user_group_ids ?? []).includes(id);
              const on = fromTpl || userGroupIds.includes(id);
              return <button key={id} type="button" className="chip" aria-pressed={on} disabled={fromTpl}
                onClick={() => setUserGroupIds(on ? userGroupIds.filter((x) => x !== id) : [...userGroupIds, id])}>{id}</button>;
            })}
          </div>
          <span className="hint">The doors set on the group in Visionline are added to this key.</span>
        </div>
      )}
      </>}

      <div className="scope-sum" style={{ marginBottom: 18 }}>
        <span className="big">{effective.set.size}</span>
        <span>{effective.set.size === 1 ? 'door' : 'doors'} will open with this key{person ? ` for ${person.full_name}` : ''}.</span>
      </div>

      <div className="field-row">
        {!replacing && <div className="field">
          <label>Starts</label>
          <div className="seg" role="group"><button type="button" aria-pressed={startMode === 'now'} onClick={() => setStartMode('now')}>Now</button><button type="button" aria-pressed={startMode === 'later'} onClick={() => setStartMode('later')}>Later</button></div>
          {startMode === 'later' && <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} style={{ marginTop: 8 }} />}
          {startMode === 'later' && <span className="hint">Held by the platform and sent to Visionline at this time.</span>}
        </div>}
        <div className="field">
          <label>Valid for</label>
          <div className="seg" role="group">
            {[4, 8, 12].map((h) => <button key={h} type="button" aria-pressed={hours === h} onClick={() => setHours(h)}>{h} h</button>)}
            <button type="button" aria-pressed={hours === 'custom'} onClick={() => setHours('custom')}>End date…</button>
          </div>
          {hours === 'custom' && <input type="datetime-local" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} style={{ marginTop: 8 }} />}
          <span className="hint">{startMode === 'later' ? `Starts ${startAt.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ` : ''}Ends {endAt.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{validH > maxH + 1e-6 ? ` — longer than the ${maxH} h allowed` : ''}</span>
        </div>
      </div>
      <div className="field">
        <label htmlFor="why">Reason <span className="muted small">(kept in the audit trail)</span></label>
        <input id="why" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: morning shift, floor 1 turnover" maxLength={300} />
      </div>
    </Drawer>
  );
}
