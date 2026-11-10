/**
 * 2.33.1 French everywhere (Armel, 10 Nov: errors and the whole system must stay in French).
 *
 * Pages are written in English. When French is chosen, every text the portal shows is looked up in the French
 * dictionary (i18n.ts and i18n-fr.ts) as it appears on the page: page text, buttons, form labels, tooltips,
 * placeholders, and the messages and errors that come back from the server. Texts with numbers or names in them are
 * matched by pattern ("{0} min ago" → "il y a {0} min"). Anything not in the dictionary stays as it is, so a page never
 * breaks. Names, card numbers, room numbers and anything in an input box are never changed. Dates and numbers follow
 * the chosen language too.
 *
 * Elements marked translate="no" (or class "notranslate") are left alone: people's names, codes, file paths.
 */
import { lang, trAny } from './i18n';

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'KBD', 'SAMP', 'TEXTAREA', 'INPUT', 'NOSCRIPT']);
const ATTRS = ['placeholder', 'title', 'aria-label', 'data-tip', 'alt'] as const;
/** The value this module last wrote into a text node / attribute: when it is still there, nothing to do. */
const wrote = new WeakMap<Node, string>();
const wroteAttr = new WeakMap<Element, Record<string, string>>();
let observer: MutationObserver | null = null;
let changedSomething = false;

function skipped(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    if (SKIP_TAGS.has(e.tagName)) return true;
    if (e.getAttribute('translate') === 'no' || e.classList.contains('notranslate') || (e as HTMLElement).isContentEditable) return true;
  }
  return false;
}

/** The English value React last put in a text node (its value when it is not one this module wrote). */
const english = (n: Text) => { const v = n.nodeValue ?? ''; return wrote.get(n) === v ? (orig.get(n) ?? v) : v; };
const orig = new WeakMap<Node, string>();

function write(n: Text, en: string, value: string) {
  orig.set(n, en);
  wrote.set(n, value);
  if (n.nodeValue !== value) n.nodeValue = value;
}

/**
 * A sentence the page builds from pieces ("Readiness · " + 1 + " of " + 7 + " ready") is several text nodes side by
 * side. When an element holds only text, the pieces are read together and translated as one sentence; the French
 * goes in the first piece and the others are left empty (React keeps its own nodes, so later updates still arrive
 * here and the sentence is translated again).
 */
function together(el: Element): boolean {
  const kids = el.childNodes;
  if (kids.length < 2 || kids.length > 12) return false;
  for (const k of kids) if (k.nodeType !== Node.TEXT_NODE) return false;
  const parts = [...kids].map((k) => english(k as Text));
  const whole = parts.join('');
  const t = whole.trim();
  if (t.length < 2 || !/[A-Za-z]{2}/.test(t)) return false;
  const f = trAny(t);
  if (f === t) return false;
  const lead = whole.slice(0, whole.indexOf(t)), tail = whole.slice(whole.indexOf(t) + t.length);
  [...kids].forEach((k, i) => write(k as Text, parts[i]!, i === 0 ? lead + f + tail : ''));
  changedSomething = true;
  return true;
}

function text(n: Text) {
  const v = n.nodeValue ?? '';
  if (wrote.get(n) === v) return;
  const parent = n.parentElement;
  if (!parent || skipped(parent)) return;
  if (together(parent)) return;
  // Not a whole sentence: undo pieces of an earlier sentence translation, then translate this piece alone.
  if (parent.childNodes.length > 1) {
    for (const k of parent.childNodes) if (k !== n && k.nodeType === Node.TEXT_NODE && wrote.get(k) === k.nodeValue && orig.has(k)) {
      const en = orig.get(k)!; const tk = en.trim(); const fk = tk.length > 1 ? trAny(tk) : tk;
      write(k as Text, en, fk === tk ? en : en.replace(tk, fk));
    }
  }
  const t = v.trim();
  if (t.length < 2 || !/[A-Za-z]/.test(t)) return;
  const f = trAny(t);
  if (f === t) return;
  write(n, v, v.replace(t, f));
  changedSomething = true;
}

function attrs(el: Element) {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v || !/[A-Za-z]/.test(v)) continue;
    const mine = wroteAttr.get(el);
    if (mine?.[a] === v) continue;
    if (skipped(el.parentElement) && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') continue;
    const f = trAny(v.trim());
    if (f === v.trim()) continue;
    wroteAttr.set(el, { ...(mine ?? {}), [a]: f });
    el.setAttribute(a, f);
    changedSomething = true;
  }
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) { text(root as Text); return; }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) attrs(root as Element);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) text(n as Text); else attrs(n as Element);
  }
}

function title() {
  const t = document.title;
  const f = trAny(t);
  if (f !== t) document.title = f;
}

/** Starts or stops translating the page for the current language. Called at start and on every language change. */
export function translatePage() {
  if (typeof document === 'undefined') return;
  if (lang() !== 'fr') {
    observer?.disconnect();
    observer = null;
    // English texts written over by French: the simplest correct way back is a fresh page.
    if (changedSomething) { changedSomething = false; location.reload(); }
    return;
  }
  if (observer) return;
  walk(document.body);
  title();
  observer = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') text(m.target as Text);
      else if (m.type === 'attributes') attrs(m.target as Element);
      else m.addedNodes.forEach((n) => walk(n));
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
  new MutationObserver(title).observe(document.querySelector('title') ?? document.head, { childList: true, subtree: true, characterData: true });
}

/** Dates and numbers in the chosen language where the code asks for "this computer's" format. */
function localeDefault() {
  const D = Date.prototype as any;
  const N = Number.prototype as any;
  for (const [proto, name] of [[D, 'toLocaleString'], [D, 'toLocaleDateString'], [D, 'toLocaleTimeString'], [N, 'toLocaleString']] as const) {
    const orig = proto[name];
    proto[name] = function (this: unknown, locales?: string | string[], options?: object) {
      return orig.call(this, locales ?? (lang() === 'fr' ? 'fr-FR' : undefined), options);
    };
  }
  const DTF = Intl.DateTimeFormat;
  (Intl as any).DateTimeFormat = function (locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
    return new DTF(locales ?? (lang() === 'fr' ? 'fr-FR' : undefined), options);
  } as any;
  Object.assign((Intl as any).DateTimeFormat, DTF);
  (Intl as any).DateTimeFormat.prototype = DTF.prototype;
  (Intl as any).DateTimeFormat.supportedLocalesOf = DTF.supportedLocalesOf;
}

if (typeof window !== 'undefined') {
  localeDefault();
  window.addEventListener('smk:lang', () => translatePage());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => translatePage());
  else translatePage();
}
