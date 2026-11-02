import qrcode from 'qrcode-generator';

/** QR code as SVG, made in the browser (nothing is sent to an outside service). */
export function qrSvg(text: string): string {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
}
