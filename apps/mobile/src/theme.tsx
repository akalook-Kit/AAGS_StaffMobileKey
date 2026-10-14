import { createContext, useContext } from 'react';
import { Platform } from 'react-native';

export interface Brand {
  appName: string; primary: string; secondary: string; background: string; onPrimary: string; font?: string; logo?: string | null; hero?: string | null; logoScale: number;
  w: { keysTitle: string; accessAreas: string; validUntil: string; lockStatus: string; support: string; tapInstruction: string };
}
export const DEFAULT_BRAND: Brand = {
  appName: 'Staff Key', primary: '#1F2933', secondary: '#C9A86A', background: '#F7F5F0', onPrimary: '#FFFFFF', logo: null, hero: null, logoScale: 1,
  w: { keysTitle: 'Mobile Keys', accessAreas: 'Access Areas', validUntil: 'Valid Until', lockStatus: 'Lock Status', support: 'Support', tapInstruction: 'Hold your phone near the lock' },
};
const FONTS: Record<string, string | undefined> = {
  serif: Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia, serif' }),
  rounded: Platform.select({ ios: 'Avenir Next', android: 'sans-serif-medium', default: '"Trebuchet MS", sans-serif' }),
  system: undefined,
};
export function brandFrom(cfg: any): Brand {
  const b = cfg?.branding;
  if (!b) return DEFAULT_BRAND;
  return {
    appName: b.appName, primary: b.primaryColor, secondary: b.secondaryColor, background: b.backgroundColor ?? DEFAULT_BRAND.background,
    onPrimary: b.textOnPrimary ?? '#FFFFFF', font: FONTS[b.fontFamily ?? 'system'], logo: b.logo ?? null, hero: b.heroImage ?? null,
    logoScale: ({ small: 0.75, medium: 1, large: 1.35 } as Record<string, number>)[b.logoSize?.app ?? 'medium'] ?? 1,
    w: { ...DEFAULT_BRAND.w, ...(b.wording ?? {}) },
  };
}
export const BrandCtx = createContext<Brand>(DEFAULT_BRAND);
export const useBrand = () => useContext(BrandCtx);

export const ink = { text: '#1C1715', muted: '#5E524D', faint: '#8A7D77', line: '#E4D8D2', card: '#FFFFFF', ok: '#17694A', okBg: '#DFF0E7', warn: '#8A5A00', warnBg: '#FBEDCC', bad: '#A3271C', badBg: '#F9E0DC' };
