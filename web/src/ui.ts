// Utilidades de interfaz compartidas.

import { errMsg } from './errors.ts';
import type { Bytes } from './types.ts';

/** Hijos de `el()`: nodos, texto, o listas anidadas de lo mismo. Un valor
 *  nulo o `false` se omite, así se pueden escribir condicionales en línea. */
export type Child = Node | string | number | null | undefined | false | Child[];

/** Atributos de `el()`: `class`, `html` y `on<evento>` tienen trato especial;
 *  el resto va a `setAttribute`. */
export type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;

function appendChildren(node: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) {
      appendChildren(node, c);
      continue;
    }
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (typeof v !== 'function') node.setAttribute(k, String(v));
  }
  appendChildren(node, children);
  return node;
}

/** Contexto 2D de un OffscreenCanvas, o un error claro: `getContext` puede
 *  devolver null (sin memoria de GPU, lienzo demasiado grande) y sin esto el
 *  fallo saldría como un TypeError sin explicación en la siguiente línea. */
export function context2d(
  c: OffscreenCanvas,
  opts?: CanvasRenderingContext2DSettings,
): OffscreenCanvasRenderingContext2D {
  const ctx = c.getContext('2d', opts);
  if (!ctx) throw new Error('Could not create a 2D canvas context.');
  return ctx;
}

export type ToastKind = '' | 'ok' | 'err';

export function toast(msg: string, kind: ToastKind = ''): void {
  const t = el('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts')?.append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 9000 : 5000);
}

export function download(
  bytes: Bytes | Blob,
  filename: string,
  mime = 'application/octet-stream',
): void {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Tiempo transcurrido y estimación de lo que falta, para una barra de
 *  progreso: "1:23 elapsed · ~2:40 left". Lineal sobre lo hecho hasta
 *  ahora, que es lo que hay: cada hoja cuesta más o menos lo mismo. La
 *  estimación aparece tras la primera unidad y unos segundos, para no
 *  anunciar disparates con una sola muestra. */
export function etaClock(): (done: number, total: number) => string {
  const t0 = performance.now();
  const clock = (ms: number): string => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  return (done, total) => {
    const elapsed = performance.now() - t0;
    let out = `${clock(elapsed)} elapsed`;
    if (done > 0 && total > done && elapsed > 3000) {
      out += ` · ~${clock((elapsed / done) * (total - done))} left`;
    }
    return out;
  };
}

export interface ProgressBar {
  root: HTMLDivElement;
  set(frac: number, text?: string): void;
  hide(): void;
  show(): void;
}

/** Barra de progreso "exposición". Devuelve {root, set(frac, note)}. */
export function progressBar(): ProgressBar {
  const bar = el('div');
  const note = el('div', { class: 'progress-note' });
  const root = el('div', {}, el('div', { class: 'expose' }, bar), note);
  return {
    root,
    set(frac, text = '') {
      bar.style.width = `${Math.round(frac * 100)}%`;
      note.textContent = text;
    },
    hide() {
      root.style.display = 'none';
    },
    show() {
      root.style.display = '';
    },
  };
}

// ── carpetas ────────────────────────────────────────────────────
// El diálogo del sistema filtra por `accept` y entrega archivos sueltos; una
// carpeta llega entera y en el orden que se le antoje al sistema de archivos.
// Lo que sigue la deja en las mismas condiciones: solo lo que la zona acepta,
// ordenado por ruta.

/** Un archivo oculto nunca es parte del proyecto: .DS_Store, los ._recursos
 *  de macOS, .git… y colarlos desordena la numeración de hojas. */
const isHidden = (name: string): boolean => name.startsWith('.');

/** Profundidad máxima al recorrer una carpeta: un enlace simbólico cíclico
 *  (fácil en macOS) colgaría la página sin este tope. */
const MAX_DEPTH = 8;

function acceptParts(accept: string): string[] {
  return String(accept || '')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
}

function acceptsFile(parts: string[], file: File): boolean {
  if (!parts.length) return true;
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  return parts.some((p) => {
    if (p.startsWith('.')) return name.endsWith(p);
    if (p.endsWith('/*')) return type.startsWith(p.slice(0, -1));
    return type === p;
  });
}

/** Orden total y estable por ruta: la numeración de hojas y de fotogramas sale
 *  del orden de los nombres, así que dos recorridos de la misma carpeta tienen
 *  que dar el mismo proyecto. */
function comparePaths(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Lee un directorio ENTERO. `readEntries` devuelve como mucho 100 entradas
 *  por llamada (Chrome), así que hay que insistir hasta la tanda vacía: con
 *  una sola llamada, una carpeta de 300 fotogramas entrega 100 y el proyecto
 *  sale incompleto sin que nada avise. */
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = (): void =>
      reader.readEntries((batch) => {
        if (!batch.length) {
          resolve(all);
          return;
        }
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

interface Collected {
  file: File;
  path: string;
}

/** Recorre una entrada soltada (archivo o carpeta) acumulando {file, path}. */
async function walkEntry(
  entry: FileSystemEntry | null,
  prefix: string,
  out: Collected[],
  depth: number,
): Promise<void> {
  if (!entry || depth > MAX_DEPTH) return;
  if (depth > 0 && isHidden(entry.name)) return; // basura del sistema, y .git enteros
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((res, rej) => fileEntry.file(res, rej));
    out.push({ file, path: prefix + file.name });
  } else if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    for (const child of children) await walkEntry(child, `${prefix}${entry.name}/`, out, depth + 1);
  }
}

async function collectEntries(entries: (FileSystemEntry | null)[]): Promise<Collected[]> {
  const out: Collected[] = [];
  for (const e of entries) await walkEntry(e, '', out, 0);
  return out;
}

export interface DropzoneOptions {
  label: string;
  sublabel?: string;
  accept?: string;
  multiple?: boolean;
  dark?: boolean;
  /** id del rótulo que describe la zona (aria-describedby). */
  describedBy?: string;
  onFiles: (files: File[]) => void;
}

/** Zona de arrastrar/soltar + click. onFiles(File[]).
 *  Acepta carpetas: soltadas (`webkitGetAsEntry`, recorrido recursivo) y, en
 *  las zonas de varios archivos, también elegidas desde el diálogo del
 *  sistema (`webkitdirectory`). Donde el navegador no tenga esas dos cosas,
 *  la zona se comporta como siempre: archivos sueltos. */
export function dropzone({
  label,
  sublabel = '',
  accept = '',
  multiple = false,
  dark = false,
  describedBy = '',
  onFiles,
}: DropzoneOptions): HTMLDivElement {
  const input = el('input', { type: 'file', accept, ...(multiple ? { multiple: '' } : {}) });
  input.addEventListener('change', () => {
    if (input.files?.length) onFiles([...input.files]);
    input.value = '';
  });

  /** Entrega lo que salió de una carpeta: filtrado por `accept` y ordenado. */
  function deliverFromFolder(collected: Collected[]): void {
    const parts = acceptParts(accept);
    const kept = collected
      .filter(
        ({ file, path }) => !isHidden(path.split('/').pop() ?? '') && acceptsFile(parts, file),
      )
      .sort((a, b) => comparePaths(a.path, b.path));
    if (!kept.length) {
      toast('That folder has no files this step can use.', 'err');
      return;
    }
    onFiles(kept.map((c) => c.file));
  }

  // `webkitdirectory` solo selecciona directorios, así que necesita su propio
  // input: el del clic en la zona sigue siendo el de archivos sueltos.
  const canPickFolder = multiple && 'webkitdirectory' in input;
  const dirInput = canPickFolder
    ? el('input', { type: 'file', webkitdirectory: '', multiple: '' })
    : null;
  if (dirInput) {
    dirInput.addEventListener('change', () => {
      const picked = [...(dirInput.files ?? [])].map((f) => ({
        file: f,
        path: f.webkitRelativePath || f.name,
      }));
      dirInput.value = '';
      if (picked.length) deliverFromFolder(picked);
    });
  }
  const folderBtn = dirInput
    ? el(
        'button',
        {
          type: 'button',
          style:
            'display:block; margin:6px auto 0; background:none; border:0; padding:0;' +
            ' font:inherit; font-size:12.5px; color:inherit; opacity:.85;' +
            ' text-decoration:underline; cursor:pointer',
        },
        'or choose a folder…',
      )
    : null;

  const zone = el(
    'div',
    {
      class: `dropzone${dark ? ' dark' : ''}`,
      tabindex: '0',
      role: 'button',
      // el rótulo que la acompaña no es un <label>: sin esto no llegaría a
      // un lector de pantalla (ver la cuarta tarjeta de calibración)
      ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    },
    el('div', {}, el('strong', {}, label)),
    sublabel ? el('div', { class: 'hint', style: 'margin:4px 0 0' }, sublabel) : null,
    folderBtn,
    input,
    dirInput,
  );
  // el botón de carpeta vive DENTRO de la zona: sin esto, su clic burbujearía
  // y abriría además el diálogo de archivos
  if (folderBtn && dirInput) {
    folderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dirInput.click();
    });
  }
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.target !== zone) return; // Enter sobre el botón de carpeta ya es lo suyo
    if (e.key === 'Enter' || e.key === ' ') input.click();
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    // `items` y sus entradas solo valen mientras dura este manejador: hay que
    // sacarlas ANTES del primer await o no queda nada que recorrer.
    const items = e.dataTransfer?.items;
    const entries: (FileSystemEntry | null)[] = [];
    for (let i = 0; items && i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file' && typeof it.webkitGetAsEntry === 'function')
        entries.push(it.webkitGetAsEntry());
    }
    const plain = [...(e.dataTransfer?.files ?? [])];
    if (entries.some((en) => en?.isDirectory)) {
      collectEntries(entries).then(deliverFromFolder, (err: unknown) => {
        toast(`Could not read that folder: ${errMsg(err)}`, 'err');
      });
    } else if (plain.length) {
      onFiles(plain); // archivos sueltos: el camino de siempre, sin filtrar ni reordenar
    }
  });
  return zone;
}

export function field(labelText: string, input: Node, hint = ''): HTMLLabelElement {
  const f = el('label', { class: 'field' }, el('span', {}, labelText), input);
  if (hint) f.append(el('div', { class: 'hint' }, hint));
  return f;
}

export interface NumberInputOptions {
  min?: number;
  max?: number;
  step?: number;
  width?: string;
}

export function numberInput(
  value: number | string,
  { min, max, step = 1, width }: NumberInputOptions = {},
): HTMLInputElement {
  return el('input', {
    type: 'number',
    value,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    step,
    ...(width ? { style: `width:${width}` } : {}),
  });
}

/** Opción de un desplegable: valor a secas (que es también el rótulo) o
 *  [valor, rótulo]. */
export type SelectOption = string | [string, string];

export function select(options: SelectOption[], value: string): HTMLSelectElement {
  return el(
    'select',
    {},
    options.map((o) => {
      const [v, label] = Array.isArray(o) ? o : [o, o];
      return el('option', { value: v, ...(v === value ? { selected: '' } : {}) }, label);
    }),
  );
}

/** Rehace las opciones de un desplegable ya montado (listas de perfiles). */
export function setOptions(sel: HTMLSelectElement, options: SelectOption[]): void {
  sel.replaceChildren(
    ...options.map((o) => {
      const [v, label] = Array.isArray(o) ? o : [o, o];
      return el('option', { value: v }, label);
    }),
  );
}

export interface Check {
  input: HTMLInputElement;
  label: HTMLLabelElement;
}

export function check(labelText: string, checked = false): Check {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  const label = el('label', { class: 'check' }, input, el('span', {}, labelText));
  return { input, label };
}

/** Interpreta "1, 3-5" → Set de enteros 1..maxN (port de parse_ranges). */
export function parseRanges(text: string, maxN: number | null = null): Set<number> {
  const out = new Set<number>();
  if (!text) return out;
  for (let tok of String(text).replaceAll(';', ',').split(',')) {
    tok = tok.trim();
    if (!tok) continue;
    const m = tok.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10),
        b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let n = a; n <= b; n++) if (n >= 1 && (maxN === null || n <= maxN)) out.add(n);
    } else {
      const n = parseInt(tok, 10);
      if (!Number.isNaN(n) && n >= 1 && (maxN === null || n <= maxN)) out.add(n);
    }
  }
  return out;
}

export function selectIndices(n: number, includeText = '', excludeText = ''): number[] {
  const inc = parseRanges(includeText, n);
  const exc = parseRanges(excludeText, n);
  const out: number[] = [];
  for (let i = 1; i <= n; i++) if ((inc.size === 0 || inc.has(i)) && !exc.has(i)) out.push(i);
  return out;
}

export function sanitizeLabel(label: string | number): string {
  const bad = '<>:"/\\|?*';
  let out = '';
  for (const ch of String(label)) out += bad.includes(ch) ? '_' : ch;
  out = out.trim();
  return out || 'frame';
}

export function uniquifyLabels(labels: string[]): string[] {
  const vistas = new Map<string, number>();
  const ocupadas = new Set<string>();
  const out: string[] = [];
  for (let lab of labels) {
    lab = String(lab);
    if (!ocupadas.has(lab)) {
      out.push(lab);
      ocupadas.add(lab);
      vistas.set(lab, 1);
      continue;
    }
    let n = vistas.get(lab) ?? 1;
    let cand: string;
    do {
      n += 1;
      cand = `${lab}_${n}`;
    } while (ocupadas.has(cand));
    vistas.set(lab, n);
    out.push(cand);
    ocupadas.add(cand);
  }
  return out;
}

/** Número de hoja "original" de cada hoja de salida (port). */
export function originalPageNumbers(positions: number[], perPage: number, start = 1): number[] {
  perPage = Math.max(1, perPage);
  const out: number[] = [];
  for (let k = 0; k < positions.length; k += perPage) {
    out.push(start + Math.floor((positions[k] - 1) / perPage));
  }
  return out;
}

export interface GalleryItem {
  data: Blob | string;
  caption?: string;
}

export interface Gallery {
  items: GalleryItem[];
  index: number;
}

/** Vista ampliada centrada de una imagen (Blob o URL). Se cierra con un clic
 *  o con Escape. Con `gallery` ({items:[{data,caption}], index}) las flechas
 *  ← → (y los botones laterales) recorren el lote sin cerrar el visor: en un
 *  informe de 100+ fotogramas, revisarlos uno a uno de otro modo es abrir y
 *  cerrar 100 veces. */
export function lightbox(
  data: Blob | string,
  caption = '',
  gallery: Gallery | null = null,
): () => void {
  const items: GalleryItem[] = gallery?.items?.length ? gallery.items : [{ data, caption }];
  let idx = Math.min(Math.max(gallery?.index ?? 0, 0), items.length - 1);
  let url: string | null = null;

  const img = el('img', {});
  const cap = el('figcaption', {});
  const fig = el('figure', {}, img, cap);
  const prevBtn = el('button', { class: 'lb-nav prev', 'aria-label': 'Previous image' }, '‹');
  const nextBtn = el('button', { class: 'lb-nav next', 'aria-label': 'Next image' }, '›');
  const box = el('div', { class: 'lightbox', role: 'dialog', 'aria-label': 'Image preview' }, fig);
  if (items.length > 1) box.append(prevBtn, nextBtn);

  function render(): void {
    if (url) URL.revokeObjectURL(url);
    const it = items[idx];
    url = it.data instanceof Blob ? URL.createObjectURL(it.data) : null;
    img.src = url ?? (it.data as string);
    img.alt = it.caption ?? '';
    const pos = items.length > 1 ? ` · ${idx + 1} / ${items.length}` : '';
    cap.textContent = `${it.caption ?? ''}${pos}`;
    cap.style.display = cap.textContent ? '' : 'none';
  }
  function step(d: number): void {
    if (items.length < 2) return;
    idx = (idx + d + items.length) % items.length;
    render();
  }
  const close = (): void => {
    box.remove();
    document.removeEventListener('keydown', onKey);
    if (url) URL.revokeObjectURL(url);
    url = null;
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      step(-1);
    }
  };
  const nav: [HTMLButtonElement, number][] = [
    [prevBtn, -1],
    [nextBtn, 1],
  ];
  for (const [btn, d] of nav) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      step(d);
    });
  }
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  render();
  document.body.append(box);
  return close;
}

export function pngUrl(data: Bytes | Blob): string {
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'image/png' });
  return URL.createObjectURL(blob);
}

export function fmtBytes(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}
