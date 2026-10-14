/**
 * Visionline exchanges dates in hotel LOCAL time without a zone designator, e.g. "20180322T2359"
 * [Web API §4.3.2, §7.5.6]. The connector converts using the hotel's IANA time zone so the cloud
 * can work in UTC. Seconds may be present in responses; minutes precision is used in requests.
 */
function parts(d: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return o as { year: string; month: string; day: string; hour: string; minute: string; second: string };
}

export function toVisionlineLocal(d: Date, timeZone: string): string {
  const p = parts(d, timeZone);
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}`;
}

/** Offset (ms) of timeZone from UTC at instant d. */
function offsetMs(d: Date, timeZone: string): number {
  const p = parts(d, timeZone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

export function fromVisionlineLocal(s: string, timeZone: string): Date {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2})(?::?(\d{2}))?$/.exec(s.trim());
  if (!m) throw new Error(`Not a Visionline local time: ${s}`);
  const naive = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  // Two passes handle DST transitions.
  let t = naive - offsetMs(new Date(naive), timeZone);
  t = naive - offsetMs(new Date(t), timeZone);
  return new Date(t);
}
