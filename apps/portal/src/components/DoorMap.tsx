export interface DoorRes { external_id: string; name: string; data: { doorGroup?: string | null; online?: boolean | null }; active: boolean }

/** Groups doors by Visionline door group; floors first in natural order, then everything else. */
export function groupDoors(doors: DoorRes[]) {
  const m = new Map<string, DoorRes[]>();
  for (const d of doors.filter((x) => x.active)) {
    const g = d.data.doorGroup ?? 'Other';
    m.set(g, [...(m.get(g) ?? []), d]);
  }
  const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  return [...m.entries()]
    .sort(([a], [b]) => (/^floor/i.test(a) === /^floor/i.test(b) ? natural(a, b) : /^floor/i.test(a) ? -1 : 1))
    .map(([group, ds]) => ({ group, doors: ds.sort((x, y) => natural(x.external_id, y.external_id)) }));
}

export function resolveScope(doors: DoorRes[], doorIds: string[], groupIds: string[]) {
  const s = new Set(doorIds);
  for (const d of doors) if (d.active && d.data.doorGroup && groupIds.includes(d.data.doorGroup)) s.add(d.external_id);
  return s;
}

/**
 * The door map: every Visionline door as a key-tag tile, rows per floor/door group.
 * Selecting a floor selects the door group (resolved to doors at issue time, spec §12.4).
 */
export function DoorMap({ doors, doorIds, groupIds, onChange, readOnly }: {
  doors: DoorRes[]; doorIds: string[]; groupIds: string[]; readOnly?: boolean;
  onChange?: (next: { doorIds: string[]; groupIds: string[] }) => void;
}) {
  const selected = resolveScope(doors, doorIds, groupIds);
  // Read-only maps (an issued key) show only the floors/groups the key touches.
  const groups = groupDoors(doors).filter((g) => !readOnly || g.doors.some((d) => selected.has(d.external_id)));
  const toggleGroup = (g: string) => {
    if (!onChange) return;
    const on = groupIds.includes(g);
    const inGroup = new Set(doors.filter((d) => d.data.doorGroup === g).map((d) => d.external_id));
    onChange({ groupIds: on ? groupIds.filter((x) => x !== g) : [...groupIds, g], doorIds: doorIds.filter((d) => !inGroup.has(d)) });
  };
  const toggleDoor = (d: DoorRes) => {
    if (!onChange) return;
    const g = d.data.doorGroup ?? '';
    if (groupIds.includes(g)) {
      // Turning one door off inside a selected floor converts the floor into its remaining doors.
      const rest = doors.filter((x) => x.data.doorGroup === g && x.external_id !== d.external_id && x.active).map((x) => x.external_id);
      onChange({ groupIds: groupIds.filter((x) => x !== g), doorIds: [...doorIds, ...rest] });
    } else {
      onChange({ groupIds, doorIds: doorIds.includes(d.external_id) ? doorIds.filter((x) => x !== d.external_id) : [...doorIds, d.external_id] });
    }
  };
  if (!groups.length) return <div className="empty">No doors yet. Run resource discovery on the Connector health page.</div>;
  return (
    <div className="doormap">
      {groups.map(({ group, doors: ds }) => {
        const n = ds.filter((d) => selected.has(d.external_id)).length;
        return (
          <div className="floor" key={group}>
            <button type="button" aria-pressed={groupIds.includes(group)} onClick={() => toggleGroup(group)} disabled={readOnly}>
              {group}<span className="n">{n ? `${n} of ${ds.length}` : `${ds.length} ${ds.length === 1 ? 'door' : 'doors'}`}</span>
            </button>
            <div className="doors">
              {ds.map((d) => (
                <button key={d.external_id} type="button" className={`door ${d.name.length > 4 ? 'wide' : ''} ${d.data.online === false ? 'offline' : ''}`}
                  aria-pressed={selected.has(d.external_id)} onClick={() => toggleDoor(d)} disabled={readOnly} title={d.name}>
                  {d.name}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
