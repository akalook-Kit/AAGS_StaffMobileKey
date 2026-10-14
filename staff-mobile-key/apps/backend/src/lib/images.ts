import { badRequest } from './errors.ts';

/** Brand asset validation (spec §13.4.1): type, size, dimensions, aspect ratio. SVG is refused (script risk). */
export function validateImageDataUrl(dataUrl: string, o: { maxKb: number; minWidth: number; maxAspect: number; label: string }) {
  const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw badRequest('INVALID_IMAGE', `${o.label} must be a PNG, JPEG or WebP image.`);
  const buf = Buffer.from(m[3]!, 'base64');
  if (buf.length > o.maxKb * 1024) throw badRequest('IMAGE_TOO_LARGE', `${o.label} is ${Math.ceil(buf.length / 1024)} KB; the limit is ${o.maxKb} KB.`);
  const dim = imageSize(buf, m[2]!);
  if (!dim) throw badRequest('INVALID_IMAGE', `${o.label} could not be read.`);
  if (dim.width < o.minWidth) throw badRequest('IMAGE_TOO_SMALL', `${o.label} must be at least ${o.minWidth}px wide (it is ${dim.width}px).`);
  const aspect = Math.max(dim.width / dim.height, dim.height / dim.width);
  if (aspect > o.maxAspect) throw badRequest('BAD_ASPECT', `${o.label} aspect ratio ${aspect.toFixed(1)}:1 exceeds ${o.maxAspect}:1.`);
  return dim;
}

export function imageSize(b: Buffer, kind: string): { width: number; height: number } | null {
  try {
    if (kind === 'png' && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (kind === 'jpeg' && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1]!;
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
    if (kind === 'webp' && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = b.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
    }
  } catch { /* fallthrough */ }
  return null;
}

const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
export function contrastRatio(a: string, b: string) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}
