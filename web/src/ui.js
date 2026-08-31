// Utilidades de interfaz compartidas.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

export function toast(msg, kind = '') {
  const t = el('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 9000 : 5000);
}

export function download(bytes, filename, mime = 'application/octet-stream') {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Barra de progreso "exposición". Devuelve {root, set(frac, note)}. */
export function progressBar() {
  const bar = el('div');
  const note = el('div', { class: 'progress-note' });
  const root = el('div', {}, el('div', { class: 'expose' }, bar), note);
  return {
    root,
    set(frac, text = '') {
      bar.style.width = `${Math.round(frac * 100)}%`;
      note.textContent = text;
    },
    hide() { root.style.display = 'none'; },
    show() { root.style.display = ''; },
  };
}

// ── carpetas ────────────────────────────────────────────────────
// El diálogo del sistema filtra por `accept` y entrega archivos sueltos; una
// carpeta llega entera y en el orden que se le antoje al sistema de archivos.
// Lo que sigue la deja en las mismas condiciones: solo lo que la zona acepta,
// ordenado por ruta.

/** Un archivo oculto nunca es parte del proyecto: .DS_Store, los ._recursos
 *  de macOS, .git… y colarlos desordena la numeración de hojas. */
const isHidden = (name) => name.startsWith('.');

/** Profundidad máxima al recorrer una carpeta: un enlace simbólico cíclico
 *  (fácil en macOS) colgaría la página sin este tope. */
const MAX_DEPTH = 8;

function acceptParts(accept) {
  return String(accept || '').split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
}

function acceptsFile(parts, file) {
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
function comparePaths(a, b) {
  return a.localeCompare(b, undefined, { numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Lee un directorio ENTERO. `readEntries` devuelve como mucho 100 entradas
 *  por llamada (Chrome), así que hay que insistir hasta la tanda vacía: con
 *  una sola llamada, una carpeta de 300 fotogramas entrega 100 y el proyecto
 *  sale incompleto sin que nada avise. */
function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) { resolve(all); return; }
      all.push(...batch);
      next();
    }, reject);
    next();
  });
}

/** Recorre una entrada soltada (archivo o carpeta) acumulando {file, path}. */
async function walkEntry(entry, prefix, out, depth) {
  if (!entry || depth > MAX_DEPTH) return;
  if (depth > 0 && isHidden(entry.name)) return; // basura del sistema, y .git enteros
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: prefix + file.name });
  } else if (entry.isDirectory) {
    const children = await readAllEntries(entry.createReader());
    for (const child of children) await walkEntry(child, `${prefix}${entry.name}/`, out, depth + 1);
  }
}

async function collectEntries(entries) {
  const out = [];
  for (const e of entries) await walkEntry(e, '', out, 0);
  return out;
}

/** Zona de arrastrar/soltar + click. onFiles(File[]).
 *  Acepta carpetas: soltadas (`webkitGetAsEntry`, recorrido recursivo) y, en
 *  las zonas de varios archivos, también elegidas desde el diálogo del
 *  sistema (`webkitdirectory`). Donde el navegador no tenga esas dos cosas,
 *  la zona se comporta como siempre: archivos sueltos. */
export function dropzone({ label, sublabel = '', accept = '', multiple = false, dark = false, onFiles }) {
  const input = el('input', { type: 'file', accept, ...(multiple ? { multiple: '' } : {}) });
  input.addEventListener('change', () => {
    if (input.files.length) onFiles([...input.files]);
    input.value = '';
  });

  /** Entrega lo que salió de una carpeta: filtrado por `accept` y ordenado. */
  function deliverFromFolder(collected) {
    const parts = acceptParts(accept);
    const kept = collected
      .filter(({ file, path }) => !isHidden(path.split('/').pop()) && acceptsFile(parts, file))
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
  const dirInput = canPickFolder ? el('input', { type: 'file', webkitdirectory: '', multiple: '' }) : null;
  if (dirInput) {
    dirInput.addEventListener('change', () => {
      const picked = [...dirInput.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
      dirInput.value = '';
      if (picked.length) deliverFromFolder(picked);
    });
  }
  const folderBtn = dirInput
    ? el('button', {
        type: 'button',
        style: 'display:block; margin:6px auto 0; background:none; border:0; padding:0;'
          + ' font:inherit; font-size:12.5px; color:inherit; opacity:.85;'
          + ' text-decoration:underline; cursor:pointer',
      }, 'or choose a folder…')
    : null;

  const zone = el(
    'div',
    { class: `dropzone${dark ? ' dark' : ''}`, tabindex: '0', role: 'button' },
    el('div', {}, el('strong', {}, label)),
    sublabel ? el('div', { class: 'hint', style: 'margin:4px 0 0' }, sublabel) : null,
    folderBtn,
    input,
    dirInput,
  );
  // el botón de carpeta vive DENTRO de la zona: sin esto, su clic burbujearía
  // y abriría además el diálogo de archivos
  folderBtn?.addEventListener('click', (e) => { e.stopPropagation(); dirInput.click(); });
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.target !== zone) return; // Enter sobre el botón de carpeta ya es lo suyo
    if (e.key === 'Enter' || e.key === ' ') input.click();
  });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    // `items` y sus entradas solo valen mientras dura este manejador: hay que
    // sacarlas ANTES del primer await o no queda nada que recorrer.
    const items = e.dataTransfer.items;
    const entries = [];
    for (let i = 0; items && i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file' && it.webkitGetAsEntry) entries.push(it.webkitGetAsEntry());
    }
    const plain = [...e.dataTransfer.files];
    if (entries.some((en) => en?.isDirectory)) {
      collectEntries(entries).then(deliverFromFolder, (err) => {
        toast(`Could not read that folder: ${err?.message ?? err}`, 'err');
      });
    } else if (plain.length) {
      onFiles(plain); // archivos sueltos: el camino de siempre, sin filtrar ni reordenar
    }
  });
  return zone;
}

export function field(labelText, input, hint = '') {
  const f = el('label', { class: 'field' }, el('span', {}, labelText), input);
  if (hint) f.append(el('div', { class: 'hint' }, hint));
  return f;
}

export function numberInput(value, { min, max, step = 1, width } = {}) {
  return el('input', {
    type: 'number', value, ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}), step,
    ...(width ? { style: `width:${width}` } : {}),
  });
}

export function select(options, value) {
  const s = el('select', {}, options.map((o) => {
    const [v, label] = Array.isArray(o) ? o : [o, o];
    return el('option', { value: v, ...(v === value ? { selected: '' } : {}) }, label);
  }));
  return s;
}

export function check(labelText, checked = false) {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  const label = el('label', { class: 'check' }, input, el('span', {}, labelText));
  return { input, label };
}

/** Interpreta "1, 3-5" → Set de enteros 1..maxN (port de parse_ranges). */
export function parseRanges(text, maxN = null) {
  const out = new Set();
  if (!text) return out;
  for (let tok of String(text).replaceAll(';', ',').split(',')) {
    tok = tok.trim();
    if (!tok) continue;
    const m = tok.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let n = a; n <= b; n++) if (n >= 1 && (maxN === null || n <= maxN)) out.add(n);
    } else {
      const n = parseInt(tok, 10);
      if (!Number.isNaN(n) && n >= 1 && (maxN === null || n <= maxN)) out.add(n);
    }
  }
  return out;
}

export function selectIndices(n, includeText = '', excludeText = '') {
  const inc = parseRanges(includeText, n);
  const exc = parseRanges(excludeText, n);
  const out = [];
  for (let i = 1; i <= n; i++) if ((inc.size === 0 || inc.has(i)) && !exc.has(i)) out.push(i);
  return out;
}

export function sanitizeLabel(label) {
  const bad = '<>:"/\\|?*';
  let out = '';
  for (const ch of String(label)) out += bad.includes(ch) ? '_' : ch;
  out = out.trim();
  return out || 'frame';
}

export function uniquifyLabels(labels) {
  const vistas = new Map();
  const ocupadas = new Set();
  const out = [];
  for (let lab of labels) {
    lab = String(lab);
    if (!ocupadas.has(lab)) {
      out.push(lab); ocupadas.add(lab); vistas.set(lab, 1);
      continue;
    }
    let n = vistas.get(lab) ?? 1;
    let cand;
    do { n += 1; cand = `${lab}_${n}`; } while (ocupadas.has(cand));
    vistas.set(lab, n);
    out.push(cand); ocupadas.add(cand);
  }
  return out;
}

/** Número de hoja "original" de cada hoja de salida (port). */
export function originalPageNumbers(positions, perPage, start = 1) {
  perPage = Math.max(1, perPage);
  const out = [];
  for (let k = 0; k < positions.length; k += perPage) {
    out.push(start + Math.floor((positions[k] - 1) / perPage));
  }
  return out;
}

/** Vista ampliada centrada de una imagen (Blob o URL). Se cierra con un clic
 *  o con Escape. Con `gallery` ({items:[{data,caption}], index}) las flechas
 *  ← → (y los botones laterales) recorren el lote sin cerrar el visor: en un
 *  informe de 100+ fotogramas, revisarlos uno a uno de otro modo es abrir y
 *  cerrar 100 veces. */
export function lightbox(data, caption = '', gallery = null) {
  const items = gallery?.items?.length ? gallery.items : [{ data, caption }];
  let idx = Math.min(Math.max(gallery?.index ?? 0, 0), items.length - 1);
  let url = null;

  const img = el('img', {});
  const cap = el('figcaption', {});
  const fig = el('figure', {}, img, cap);
  const prevBtn = el('button', { class: 'lb-nav prev', 'aria-label': 'Previous image' }, '‹');
  const nextBtn = el('button', { class: 'lb-nav next', 'aria-label': 'Next image' }, '›');
  const box = el('div', { class: 'lightbox', role: 'dialog', 'aria-label': 'Image preview' }, fig);
  if (items.length > 1) box.append(prevBtn, nextBtn);

  function render() {
    if (url) URL.revokeObjectURL(url);
    const it = items[idx];
    url = it.data instanceof Blob ? URL.createObjectURL(it.data) : null;
    img.src = url ?? it.data;
    img.alt = it.caption ?? '';
    const pos = items.length > 1 ? ` · ${idx + 1} / ${items.length}` : '';
    cap.textContent = `${it.caption ?? ''}${pos}`;
    cap.style.display = cap.textContent ? '' : 'none';
  }
  function step(d) {
    if (items.length < 2) return;
    idx = (idx + d + items.length) % items.length;
    render();
  }
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey);
    if (url) URL.revokeObjectURL(url);
    url = null;
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  };
  for (const [btn, d] of [[prevBtn, -1], [nextBtn, 1]]) {
    btn.addEventListener('click', (e) => { e.stopPropagation(); step(d); });
  }
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  render();
  document.body.append(box);
  return close;
}

export function pngUrl(data) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'image/png' });
  return URL.createObjectURL(blob);
}

export function fmtBytes(n) {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}
