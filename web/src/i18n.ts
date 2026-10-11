// Idioma de la interfaz: inglés, que es el del código, o español.
//
// El texto de la página se escribe en inglés en cada fase, como siempre. En
// español, este módulo traduce lo que llega al documento: cada nodo de texto
// y los atributos que se leen (title, placeholder, aria-label, alt), al
// aparecer o al cambiar, con el diccionario de i18n-es.ts. Al volver al
// inglés se devuelve a cada nodo su texto original. Así el idioma cambia al
// momento y sin recargar, que borraría el proyecto en curso, y nada fuera de
// la interfaz (nombres de archivo, informe.json, hojas impresas) cambia.
//
// Lo que no pasa por el documento lo traduce quien lo muestra con `tr`: los
// diálogos de confirm() y el texto dibujado en un lienzo. La ayuda tiene su
// propia versión en español (help-es.ts) y aquí se salta.
//
// El diccionario y la ayuda en español se cargan aparte, la primera vez que
// hacen falta: quien usa la página en inglés no los descarga al abrirla
// (main.ts los trae después en segundo plano, para que sigan ahí sin
// conexión o tras un despliegue).

import type * as Dict from './i18n-es.ts';

export type Lang = 'en' | 'es';

const KEY = 'mxm.lang';
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
/** Lo que no se traduce: código, lo que escribe el usuario, y lo que lleva
 *  `data-i18n="skip"` (la ayuda, que tiene su propia versión). */
const SKIP = 'script, style, textarea, [contenteditable], [data-i18n="skip"]';

let current: Lang = 'en';
let dict: typeof Dict | null = null;
let helpHtml = '';
let loading: Promise<void> | null = null;

/** Trae el diccionario y la ayuda en español (una vez). */
export function loadSpanish(): Promise<void> {
  loading ??= Promise.all([import('./i18n-es.ts'), import('./help-es.ts')]).then(
    ([d, h]) => {
      dict = d;
      helpHtml = h.HELP_ES;
    },
    (e: unknown) => {
      loading = null; // otro intento la próxima vez
      throw e;
    },
  );
  return loading;
}

/** La ayuda en español; vacía hasta que se cargó. */
export function helpEs(): string {
  return helpHtml;
}
let observer: MutationObserver | null = null;

/** Texto original y traducido de cada nodo o atributo traducido. */
interface Rec {
  en: string;
  es: string;
}
const textRecs = new WeakMap<Text, Rec>();
const attrRecs = new WeakMap<Element, Map<string, Rec>>();

/** Lo que llegó al documento en español sin traducción (para las pruebas). */
const misses = new Set<string>();

// ── El diccionario ───────────────────────────────────────────

let exact: Map<string, string> | null = null;

interface Template {
  re: RegExp;
  /** El trozo literal más largo: si no está en el texto, ni se prueba. */
  probe: string;
  literal: number;
  es: string;
  /** Los huecos entre comillas («Preset “{0}” saved»): llevan un nombre
   *  que puso el usuario, y no se traducen. */
  quoted: Set<string>;
}
let templates: Template[] = [];

/** `{0}`: cualquier texto (que a su vez se traduce); `{#0}`: un número. Se
 *  compila la primera vez que hace falta el español, y una plantilla que no
 *  compile se salta: el inglés no depende nunca del diccionario. */
function compile(): Map<string, string> {
  if (exact) return exact;
  exact = new Map(Object.entries(dict?.EXACT ?? {}).map(([en, es]) => [norm(en), es]));
  for (const [en, es] of dict?.TEMPLATES ?? []) {
    const parts = norm(en).split(/(\{#?\d\})/);
    const named = new Set<string>();
    let src = '';
    let probe = '';
    let literal = 0;
    for (const p of parts) {
      const ph = /^\{(#?)(\d)\}$/.exec(p);
      if (ph) {
        const name = `${ph[1] ? 'n' : 's'}${ph[2]}`;
        // el mismo hueco dos veces: la segunda tiene que decir lo mismo
        if (named.has(name)) src += `\\k<${name}>`;
        else src += ph[1] ? `(?<${name}>-?\\d[\\d.,]*)` : `(?<${name}>.+?)`;
        named.add(name);
      } else {
        src += p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        literal += p.length;
        if (p.length > probe.length) probe = p;
      }
    }
    try {
      const quoted = new Set([...en.matchAll(/“\{#?(\d)\}”/g)].map((q) => q[1]));
      templates.push({ re: new RegExp(`^${src}$`), probe, literal, es, quoted });
    } catch (e) {
      console.warn('[i18n] skipped a template:', en, e);
    }
  }
  templates = templates.sort((a, b) => b.literal - a.literal);
  return exact;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** `key` en español, o null si el diccionario no lo tiene. */
function lookup(key: string, depth: number): string | null {
  const hit = compile().get(key);
  if (hit != null) return hit;
  for (const t of templates) {
    if (!key.includes(t.probe)) continue;
    const m = t.re.exec(key);
    if (!m?.groups) continue;
    const g = m.groups;
    return t.es.replace(/\{(#?)(\d)\}/g, (_, num: string, i: string) => {
      const n = g[`n${i}`];
      const v = g[`s${i}`];
      if (v == null || (num && n != null)) return n ?? '';
      if (t.quoted.has(i) || depth >= 3 || ignored(v)) return v;
      const inner = lookup(v, depth + 1);
      // lo que queda en inglés dentro de un hueco también se apunta, si es
      // una frase (un mensaje de error); una palabra suelta es un nombre
      if (inner == null && /\s/.test(v)) miss(v);
      return inner ?? v;
    });
  }
  // los textos que la página compone de trozos: «12 frames · 3 sheets»
  for (const sep of [' · ', ' — ', ' / ', '; ']) {
    if (!key.includes(sep)) continue;
    const parts = key.split(sep);
    const out = parts.map((p) => (ignored(p) ? p : lookup(p, depth + 1)));
    if (out.every((p) => p != null)) return out.join(sep);
  }
  // y de frases: un aviso que suma dos mensajes
  // sin lookbehind: un Safari anterior a 16.4 no podría ni cargar el módulo
  const sentences = key.replace(/([.!?:])\s+(?=[A-Z“"(«¿])/g, '$1\u0000').split('\u0000');
  if (sentences.length > 1) {
    const out = sentences.map((p) => lookup(p, depth + 1));
    if (out.every((p) => p != null)) return out.join(' ');
  }
  return null;
}

/** Lo que no es lenguaje: números, nombres de archivo, siglas. */
function ignored(key: string): boolean {
  // «e.g.» también es lenguaje, aunque no tenga dos letras seguidas
  return !/[A-Za-z]\.?[A-Za-z]/.test(key) || (dict?.IGNORE ?? []).some((re) => re.test(key));
}

function miss(key: string): void {
  if (misses.size < 500) misses.add(key);
}

/** `text` en el idioma actual, conservando los espacios de los extremos. */
function translate(text: string): string {
  const key = norm(text);
  if (!key || ignored(key)) return text;
  const es = lookup(key, 0);
  if (es == null) {
    miss(key);
    return text;
  }
  const lead = /^\s*/.exec(text)?.[0] ?? '';
  const trail = /\s*$/.exec(text)?.[0] ?? '';
  return lead + es + trail;
}

/** Un texto que la página no pone en el documento (confirm(), un lienzo),
 *  en el idioma actual. */
export function tr(en: string): string {
  // un confirm() separa párrafos con una línea en blanco: se conservan
  return current === 'es' ? en.split('\n\n').map(translate).join('\n\n') : en;
}

// ── El documento ─────────────────────────────────────────────

function skipped(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return !!el?.closest(SKIP);
}

function doText(node: Text): void {
  const rec = textRecs.get(node);
  if (rec && node.data === rec.es) return; // lo puso este módulo
  const es = translate(node.data);
  if (es === node.data) {
    textRecs.delete(node);
    return;
  }
  textRecs.set(node, { en: node.data, es });
  node.data = es;
}

function doAttr(el: Element, name: string): void {
  const v = el.getAttribute(name);
  let recs = attrRecs.get(el);
  const rec = recs?.get(name);
  if (v == null || (rec && v === rec.es)) return;
  const es = translate(v);
  if (es === v) {
    recs?.delete(name);
    return;
  }
  if (!recs) {
    recs = new Map();
    attrRecs.set(el, recs);
  }
  recs.set(name, { en: v, es });
  el.setAttribute(name, es);
}

/** Recorre `root` y traduce (español) o devuelve el original (inglés). */
function walk(root: Node, toEs: boolean): void {
  if (skipped(root)) return;
  const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n instanceof Element && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let n: Node | null = it.currentNode; n; n = it.nextNode()) {
    if (n instanceof Text) {
      if (toEs) doText(n);
      else {
        const rec = textRecs.get(n);
        if (rec && n.data === rec.es) n.data = rec.en;
        textRecs.delete(n);
      }
    } else if (n instanceof Element) {
      if (toEs) for (const a of ATTRS) doAttr(n, a);
      else {
        const recs = attrRecs.get(n);
        if (!recs) continue;
        for (const [a, rec] of recs) if (n.getAttribute(a) === rec.es) n.setAttribute(a, rec.en);
        attrRecs.delete(n);
      }
    }
  }
}

/** Cuánto trabaja el traductor (para las pruebas): milisegundos y lotes. */
const stats = { ms: 0, batches: 0 };

function onMutations(ms: MutationRecord[]): void {
  const t0 = performance.now();
  for (const m of ms) {
    if (m.type === 'childList') {
      // también en inglés: un nodo traducido que la página guardó aparte y
      // vuelve a poner (un menú, la vista ampliada) vuelve en inglés
      for (const n of m.addedNodes) walk(n, current === 'es');
    } else if (current === 'es' && !skipped(m.target)) {
      if (m.type === 'characterData' && m.target instanceof Text) doText(m.target);
      else if (m.type === 'attributes' && m.target instanceof Element && m.attributeName)
        doAttr(m.target, m.attributeName);
    }
  }
  stats.ms += performance.now() - t0;
  stats.batches++;
}

const TITLE_EN = document.title;

/** El último idioma pedido: si se pide otro mientras carga el español, gana
 *  el último. */
let wanted: Lang = 'en';

async function apply(lang: Lang): Promise<void> {
  wanted = lang;
  if (lang === 'es') {
    try {
      await loadSpanish();
    } catch (e) {
      // sin el diccionario (sin conexión antes de haberlo traído) la página
      // sigue en inglés
      console.warn('[i18n] could not load Spanish:', e);
      wanted = current;
      return;
    }
    if (wanted !== 'es') return;
  }
  current = lang;
  document.documentElement.lang = lang;
  document.title = lang === 'es' ? translate(TITLE_EN) : TITLE_EN;
  // el observador se pone la primera vez que hace falta el español: quien
  // no cambia de idioma no paga nada
  if (lang === 'es' && !observer) {
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
  }
  walk(document.body, lang === 'es');
  // lo que cambió de idioma por dentro (el observador lo verá después, ya
  // traducido) lo ve también quien lo necesite redibujar: la ayuda, un lienzo
  for (const b of document.querySelectorAll<HTMLButtonElement>('#lang-switch [data-lang]')) {
    b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  }
  document.dispatchEvent(new CustomEvent('mxm:lang', { detail: lang }));
}

export function lang(): Lang {
  return current;
}

/** Pone el idioma guardado (inglés si no hay) y conecta el selector. */
export function startI18n(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    saved = null;
  }
  document.getElementById('lang-switch')?.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const l = e.target.closest<HTMLElement>('[data-lang]')?.dataset.lang;
    if ((l !== 'en' && l !== 'es') || l === current) return;
    try {
      localStorage.setItem(KEY, l);
    } catch {
      // sin almacenamiento el idioma dura lo que la pestaña
    }
    void apply(l);
  });
  if (saved !== 'es') return;
  // en español desde el principio: la página no se enseña en inglés
  // mientras llega el diccionario (con un tope, por si no llega)
  const root = document.documentElement;
  root.classList.add('i18n-wait');
  const show = (): void => root.classList.remove('i18n-wait');
  const cap = setTimeout(show, 3000);
  void apply('es').finally(() => {
    clearTimeout(cap);
    show();
  });
}

// para las pruebas (e2e-i18n.mts): lo que quedó sin traducir y lo que costó
Object.assign(globalThis, { __i18nMisses: misses, __i18nStats: stats });
