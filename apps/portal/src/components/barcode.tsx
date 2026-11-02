/** Code 128 (set B) as SVG: printable ASCII, read by any USB barcode scanner (attendance desks, canteen tills). */
const P = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

export function code128(text: string): string | null {
  if (!text || [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126)) return null;
  const codes = [104, ...[...text].map((c) => c.charCodeAt(0) - 32)];
  const check = codes.reduce((a, c, i) => a + c * (i || 1), 0) % 103;
  return [...codes, check, 106].map((c) => P[c]).join('');
}

export function Barcode({ value, height = 10, className }: { value: string; height?: number; className?: string }) {
  const bars = code128(value);
  if (!bars) return null;
  const quiet = 10;
  let x = quiet;
  const rects: { x: number; w: number }[] = [];
  [...bars].forEach((d, i) => { const w = Number(d); if (i % 2 === 0) rects.push({ x, w }); x += w; });
  const total = x + quiet;
  return (
    <svg className={className} viewBox={`0 0 ${total} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Barcode ${value}`}>
      <rect width={total} height={height} fill="#fff" />
      {rects.map((r, i) => <rect key={i} x={r.x} width={r.w} height={height} fill="#000" />)}
    </svg>
  );
}
