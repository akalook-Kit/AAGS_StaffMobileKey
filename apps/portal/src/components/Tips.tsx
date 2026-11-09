import { useEffect, useRef, useState } from 'react';
import { tr } from '../i18n';

/**
 * 2.29 Hover help (Armel, 5 Nov: "on each item a bit of explanation on how it works … it should disappear
 * automatically if the cursor is moved"). Any element with a data-tip="…" attribute shows that text in a small bubble
 * after the mouse rests on it for a moment (or it gets keyboard focus); the bubble goes as soon as the mouse moves
 * off, a key is pressed or the page scrolls. One bubble for the whole portal, drawn above everything, so it is never
 * cut by a scrolling menu. Can be switched off under My account → Menu & appearance (kept on this computer).
 */
const KEY = 'smk.tips';
export const tipsOn = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };
export function setTipsOn(on: boolean) { try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* ignore */ } window.dispatchEvent(new Event('smk:tips')); }

export function TipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; side: 'right' | 'below' | 'above' } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const current = useRef<Element | null>(null);
  useEffect(() => {
    let enabled = tipsOn();
    const onToggle = () => { enabled = tipsOn(); if (!enabled) hide(); };
    const hide = () => { window.clearTimeout(timer.current); current.current = null; setTip(null); };
    const show = (el: Element, delay: number) => {
      if (!enabled) return;
      const text = el.getAttribute('data-tip');
      if (!text) return;
      window.clearTimeout(timer.current);
      current.current = el;
      timer.current = window.setTimeout(() => {
        if (current.current !== el || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        const W = window.innerWidth, H = window.innerHeight;
        const inRail = Boolean(el.closest('.rail'));
        if (inRail && r.right + 300 < W) setTip({ text: tr(text), x: r.right + 10, y: Math.min(Math.max(8, r.top), H - 120), side: 'right' });
        else if (r.bottom + 110 < H) setTip({ text: tr(text), x: Math.min(Math.max(8, r.left), W - 308), y: r.bottom + 8, side: 'below' });
        else setTip({ text: tr(text), x: Math.min(Math.max(8, r.left), W - 308), y: Math.max(8, r.top - 8), side: 'above' });
      }, delay);
    };
    const over = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-tip]');
      if (el === current.current) return;
      if (!el) { hide(); return; }
      setTip(null); show(el, 450);
    };
    const focus = (e: FocusEvent) => { const el = (e.target as Element | null)?.closest?.('[data-tip]'); if (el && (e.target as HTMLElement).matches(':focus-visible')) show(el, 250); };
    document.addEventListener('mouseover', over);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('keydown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    window.addEventListener('smk:tips', onToggle);
    return () => {
      document.removeEventListener('mouseover', over); document.removeEventListener('focusin', focus); document.removeEventListener('focusout', hide);
      document.removeEventListener('mousedown', hide, true); document.removeEventListener('keydown', hide, true);
      window.removeEventListener('scroll', hide, true); window.removeEventListener('blur', hide); window.removeEventListener('smk:tips', onToggle);
      window.clearTimeout(timer.current);
    };
  }, []);
  if (!tip) return null;
  return (
    <div className={`tip-bubble tip-${tip.side} no-print`} role="tooltip" style={{ left: tip.x, top: tip.y, transform: tip.side === 'above' ? 'translateY(-100%)' : undefined }}>
      {tip.text}
    </div>
  );
}
