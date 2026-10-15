import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Small SVG chart kit for the Insights page. Rules (dataviz method): one axis per chart, thin marks with 4px
 * rounded data ends, 2px surface gaps between stacked segments, hairline solid grid, text in ink tokens (never
 * the series colour), a legend for 2+ series, a hover/focus tooltip that never gates (every chart has a table
 * view), categorical colours in fixed order (validated: blue, orange, aqua), status colours only for status.
 */
export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'] as const;

export const fmtN = (n: number | null | undefined) => n == null ? '—' : Math.abs(n) >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K` : n.toLocaleString();

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(Math.max(220, Math.floor(e[0]!.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Clean axis ticks: 0, step, 2·step… covering max. */
function ticks(max: number, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1000) / 1000);
  if (out[out.length - 1]! < max) out.push(out[out.length - 1]! + step);
  return out;
}

/** A rect with a 4px rounded end on the right (horizontal) or top (vertical); square at the baseline. */
function endRounded(x: number, y: number, w: number, h: number, dir: 'right' | 'up', r = 4) {
  if (w <= 0 || h <= 0) return '';
  if (dir === 'right') {
    const rr = Math.min(r, w, h / 2);
    return `M${x},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x} Z`;
  }
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

// ---- Empty state: no data yet, the page keeps checking -------------------------------------------
export function NoData({ text = 'No data for now', hint = 'Still looking - this updates by itself.' }: { text?: string; hint?: string }) {
  return <div className="viz-empty no-data" role="status"><span className="pulse" aria-hidden />{text}<span className="muted"> · {hint}</span></div>;
}

// ---- Tooltip -----------------------------------------------------------------------------------------
interface Tip { x: number; y: number; title: string; rows: { label: string; value: string; color?: string }[] }
function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="viz-tip" style={{ left: tip.x, top: tip.y }} role="status">
      <div className="viz-tip-t">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div key={i} className="viz-tip-r">{r.color && <span className="key" style={{ background: r.color }} />}<strong>{r.value}</strong><span>{r.label}</span></div>
      ))}
    </div>
  );
}

export function Legend({ series }: { series: { name: string; color: string }[] }) {
  if (series.length < 2) return null;
  return <div className="viz-legend">{series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}</div>;
}

// ---- Horizontal bars (single or stacked) ---------------------------------------------------------
export interface BarRow { key: string; label: string; sub?: string; values: number[] }
export function HBars({ rows, series, onSelect, max: maxIn, unit = '', empty = 'No data for this period yet' }: {
  rows: BarRow[]; series: { name: string; color: string }[]; onSelect?: (r: BarRow) => void; max?: number; unit?: string; empty?: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  if (!rows.length || rows.every((r) => r.values.every((v) => !v))) return <NoData text={empty} />;
  const labelW = Math.min(170, Math.max(90, w * 0.3));
  const valueW = 48;
  const plotW = Math.max(60, w - labelW - valueW - 8);
  const rowH = 30, barH = 14;
  const total = (r: BarRow) => r.values.reduce((a, b) => a + b, 0);
  const max = Math.max(1, maxIn ?? Math.max(...rows.map(total)));
  const scale = (v: number) => (v / max) * plotW;
  const h = rows.length * rowH + 6;
  const show = (r: BarRow, el: Element) => {
    const box = el.getBoundingClientRect(), host = ref.current!.getBoundingClientRect();
    setTip({ x: Math.min(box.right - host.left + 8, w - 190), y: box.top - host.top - 6, title: r.label,
      rows: [...(series.length > 1 ? [{ label: 'total', value: `${fmtN(total(r))}${unit}` }] : []), ...r.values.map((v, i) => ({ label: series[i]!.name, value: `${fmtN(v)}${unit}`, color: series[i]!.color }))] });
  };
  return (
    <div ref={ref} className="viz" onMouseLeave={() => setTip(null)}>
      <svg width={w} height={h} role="img" aria-label={`${series.map((s) => s.name).join(', ')} by ${rows.length} rows`}>
        {ticks(max).map((t) => <line key={t} x1={labelW + scale(t)} x2={labelW + scale(t)} y1={0} y2={h - 4} className="viz-grid" />)}
        {rows.map((r, i) => {
          const y = i * rowH + (rowH - barH) / 2;
          let x = labelW;
          const segs = r.values.map((v, k) => {
            const sw = scale(v);
            const last = r.values.slice(k + 1).every((n) => n === 0);
            const seg = v > 0 ? <path key={k} d={last ? endRounded(x, y, Math.max(sw, 2), barH, 'right') : `M${x},${y}h${Math.max(sw - 2, 1)}v${barH}h${-Math.max(sw - 2, 1)}Z`} fill={series[k]!.color} /> : null;
            x += sw;
            return seg;
          });
          return (
            <g key={r.key} className={`viz-row${onSelect ? ' clickable' : ''}`} tabIndex={0} role={onSelect ? 'button' : undefined}
              aria-label={`${r.label}: ${r.values.map((v, k) => `${series[k]!.name} ${v}`).join(', ')}`}
              onMouseMove={(e) => show(r, e.currentTarget)} onFocus={(e) => show(r, e.currentTarget)} onBlur={() => setTip(null)}
              onClick={() => onSelect?.(r)} onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && onSelect) { e.preventDefault(); onSelect(r); } }}>
              <rect x={0} y={i * rowH} width={w} height={rowH} className="viz-hit" />
              <text x={labelW - 10} y={i * rowH + rowH / 2} className="viz-label" textAnchor="end" dominantBaseline="central">{r.label.length > 24 ? `${r.label.slice(0, 23)}…` : r.label}</text>
              {segs}
              <text x={labelW + scale(total(r)) + 6} y={i * rowH + rowH / 2} className="viz-value" dominantBaseline="central">{fmtN(total(r))}{unit}</text>
            </g>
          );
        })}
        <line x1={labelW} x2={labelW} y1={0} y2={h - 4} className="viz-axis" />
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

// ---- Lines over time (one axis, up to 3 series) --------------------------------------------------
export function Lines({ points, series, height = 210, label }: {
  points: { t: string; values: number[] }[]; series: { name: string; color: string }[]; height?: number; label: (t: string) => string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length || points.every((p) => p.values.every((v) => !v))) return <NoData text="No data for this period yet" />;
  const left = 38, right = 14, top = 10, bottom = 26;
  const pw = Math.max(80, w - left - right), ph = height - top - bottom;
  const max = Math.max(1, ...points.flatMap((p) => p.values));
  const tk = ticks(max);
  const ymax = tk[tk.length - 1]!;
  const x = (i: number) => left + (points.length === 1 ? pw / 2 : (i / (points.length - 1)) * pw);
  const y = (v: number) => top + ph - (v / ymax) * ph;
  const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(pw / 70))));
  const near = (clientX: number) => {
    const host = ref.current!.getBoundingClientRect();
    const rel = clientX - host.left - left;
    return Math.max(0, Math.min(points.length - 1, Math.round((rel / pw) * (points.length - 1))));
  };
  const hp = hover != null ? points[hover]! : null;
  return (
    <div ref={ref} className="viz" onMouseLeave={() => setHover(null)}>
      <svg width={w} height={height} role="img" aria-label={`${series.map((s) => s.name).join(' and ')} over time`}
        tabIndex={0} onMouseMove={(e) => setHover(near(e.clientX))}
        onKeyDown={(e) => { if (e.key === 'ArrowRight') setHover((h) => Math.min(points.length - 1, (h ?? -1) + 1)); if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? points.length) - 1)); }}
        onFocus={() => setHover(points.length - 1)} onBlur={() => setHover(null)}>
        {tk.map((t) => <g key={t}><line x1={left} x2={left + pw} y1={y(t)} y2={y(t)} className="viz-grid" /><text x={left - 6} y={y(t)} className="viz-tick" textAnchor="end" dominantBaseline="central">{fmtN(t)}</text></g>)}
        {points.map((p, i) => (i % every === 0 && (i === points.length - 1 || x(points.length - 1) - x(i) > 64)) || i === points.length - 1 ? <text key={p.t} x={x(i)} y={height - 8} className="viz-tick" textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>{label(p.t)}</text> : null)}
        <line x1={left} x2={left + pw} y1={top + ph} y2={top + ph} className="viz-axis" />
        {series.map((s, k) => (
          <g key={s.name}>
            <path d={points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.values[k] ?? 0)}`).join(' ')} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={x(points.length - 1)} cy={y(points[points.length - 1]!.values[k] ?? 0)} r={4} fill={s.color} className="viz-dot" />
          </g>
        ))}
        {hp && hover != null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={top} y2={top + ph} className="viz-cross" />
            {series.map((s, k) => <circle key={k} cx={x(hover)} cy={y(hp.values[k] ?? 0)} r={4} fill={s.color} className="viz-dot" />)}
          </g>
        )}
      </svg>
      {hp && hover != null && <Tooltip tip={{ x: Math.min(x(hover) + 10, w - 180), y: 4, title: label(hp.t), rows: series.map((s, k) => ({ label: s.name, value: fmtN(hp.values[k] ?? 0), color: s.color })) }} />}
    </div>
  );
}

// ---- One 100% bar for a status breakdown (battery states) ------------------------------------------
export function StatusBar({ parts }: { parts: { label: string; n: number; tone: 'crit' | 'serious' | 'warn' | 'good' | 'idle' | 'none'; icon: string }[] }) {
  const total = parts.reduce((a, p) => a + p.n, 0) || 1;
  return (
    <div className="statusbar">
      <div className="statusbar-track" role="img" aria-label={parts.map((p) => `${p.label} ${p.n}`).join(', ')}>
        {parts.filter((p) => p.n > 0).map((p) => <span key={p.label} className={`sb-seg ${p.tone}`} style={{ flexGrow: p.n }} title={`${p.label}: ${p.n}`} />)}
      </div>
      <ul className="statusbar-legend">
        {parts.map((p) => <li key={p.label}><span className={`dot ${p.tone}`} aria-hidden>{p.icon}</span><strong>{p.n}</strong> {p.label} <span className="muted">({Math.round((p.n / total) * 100)}%)</span></li>)}
      </ul>
    </div>
  );
}

// ---- KPI tile --------------------------------------------------------------------------------------
export function Kpi({ label, value, sub, delta, upIsGood, spark, onClick, tone }: {
  label: string; value: string; sub?: ReactNode; delta?: { now: number; prev: number } | null; upIsGood?: boolean; spark?: number[]; onClick?: () => void; tone?: 'bad' | 'warn';
}) {
  const d = delta && delta.prev > 0 ? Math.round(((delta.now - delta.prev) / delta.prev) * 100) : delta && delta.now > 0 && delta.prev === 0 ? null : delta ? 0 : undefined;
  const dir = d == null || d === 0 ? 'flat' : d > 0 ? 'up' : 'down';
  const good = dir === 'flat' ? null : (dir === 'up') === Boolean(upIsGood);
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={`kpi${onClick ? ' clickable' : ''}${tone ? ` ${tone}` : ''}`} onClick={onClick} type={onClick ? 'button' : undefined}>
      <span className="kpi-l">{label}</span>
      <span className="kpi-top"><span className="kpi-v">{value}</span>{spark && spark.length > 1 && <Spark values={spark} />}</span>
      <span className="kpi-s">
        {d !== undefined && delta && (d === null ? <span className="delta">new this period</span>
          : <span className={`delta ${good === null ? '' : good ? 'good' : 'bad'}`}>{dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'} {Math.abs(d)}%<span className="muted"> vs previous</span></span>)}
        {sub && <span className="muted">{sub}</span>}
      </span>
    </Tag>
  );
}

function Spark({ values }: { values: number[] }) {
  const w = 84, h = 24, max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * (w - 4) + 2},${h - 2 - (v / max) * (h - 4)}`).join(' ');
  return <svg className="spark" width={w} height={h} aria-hidden><polyline points={pts} fill="none" stroke="var(--series-1)" strokeWidth={1.5} strokeLinejoin="round" /></svg>;
}

// ---- Card with a chart/table toggle ----------------------------------------------------------------
export function VizCard({ title, sub, chart, table, actions, span = 6, filtered }: {
  title: string; sub?: ReactNode; chart: ReactNode; table?: ReactNode; actions?: ReactNode; span?: 4 | 6 | 8 | 12; filtered?: string[];
}) {
  const [asTable, setAsTable] = useState(false);
  useEffect(() => { if (window.matchMedia?.('(forced-colors: active)').matches) setAsTable(true); }, []);
  return (
    <section className={`vizcard span-${span}`} aria-label={title}>
      <header>
        <div><h2>{title}</h2>{sub && <p>{sub}</p>}</div>
        <div className="row">
          {filtered?.length ? <span className="chip-f" title="Filters applied to this visual">⧩ {filtered.join(' · ')}</span> : null}
          {actions}
          {table && <button className="btn small ghost" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>{asTable ? 'Chart' : 'Table'}</button>}
        </div>
      </header>
      <div className="vizbody">{asTable && table ? table : chart}</div>
    </section>
  );
}

export function DataTable({ head, rows, numeric = [] }: { head: string[]; rows: (string | number | null | ReactNode)[][]; numeric?: number[] }) {
  if (!rows.length) return <NoData text="No rows yet" />;
  return (
    <div className="viz-table-wrap"><table className="grid viz-table">
      <thead><tr>{head.map((h, i) => <th key={i} className={numeric.includes(i) ? 'num' : ''}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={numeric.includes(j) ? 'num' : ''}>{c ?? '—'}</td>)}</tr>)}</tbody>
    </table></div>
  );
}
