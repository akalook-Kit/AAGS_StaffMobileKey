/**
 * Is a lock still in contact? Pure decision (unit-tested), fed by monitor.ts.
 *
 *  1. An explicit lock event wins: the latest "offline" or "online" code (hotel-defined, from its lock documentation).
 *  2. An open Visionline alarm whose type or text says the door lost contact -> offline.
 *  3. Silence: a lock that normally reports (at least minEvents within learnDays) and has not reported anything for
 *     silentHours -> offline ("no contact"). Locks that rarely report stay "unknown" rather than raising false alarms.
 */
export interface DoorFacts {
  lastEventAt: Date | null;
  eventsInLearnWindow: number;
  lastExplicit: { kind: 'offline' | 'online'; at: Date } | null;
  /** Any event after the last explicit offline event means the lock is talking again. */
  eventAfterExplicit: boolean;
  openOfflineAlarm: { title: string; at: Date | null } | null;
}
export interface DoorPolicy { silentHours: number; learnDays: number; minEvents: number }
export interface DoorVerdict { state: 'online' | 'offline' | 'unknown'; reason: string | null; severity: 'critical' | 'warning' | null }

export function classifyDoor(f: DoorFacts, p: DoorPolicy, now: Date, watchRunning: boolean): DoorVerdict {
  if (f.lastExplicit?.kind === 'offline' && !f.eventAfterExplicit) return { state: 'offline', reason: 'The lock reported that it went offline', severity: 'critical' };
  if (f.openOfflineAlarm) return { state: 'offline', reason: `Visionline alarm: ${f.openOfflineAlarm.title}`, severity: 'critical' };
  if (!f.lastEventAt) return { state: 'unknown', reason: null, severity: null };
  const silentMs = now.getTime() - f.lastEventAt.getTime();
  if (silentMs <= p.silentHours * 3600_000) return { state: 'online', reason: null, severity: null };
  // Silence only counts while the connector's Visionline watch is running, and only for locks that normally report.
  if (!watchRunning || f.eventsInLearnWindow < p.minEvents) return { state: 'unknown', reason: null, severity: null };
  const h = Math.floor(silentMs / 3600_000);
  return { state: 'offline', reason: `No contact for ${h >= 48 ? `${Math.floor(h / 24)} days` : `${h} hours`} (usually reports ${f.eventsInLearnWindow} times in ${p.learnDays} days)`, severity: 'warning' };
}
