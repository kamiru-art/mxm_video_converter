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

/** Zona de arrastrar/soltar + click. onFiles(FileList). */
export function dropzone({ label, sublabel = '', accept = '', multiple = false, dark = false, onFiles }) {
  const input = el('input', { type: 'file', accept, ...(multiple ? { multiple: '' } : {}) });
  input.addEventListener('change', () => {
    if (input.files.length) onFiles([...input.files]);
    input.value = '';
  });
  const zone = el(
    'div',
    { class: `dropzone${dark ? ' dark' : ''}`, tabindex: '0', role: 'button' },
    el('div', {}, el('strong', {}, label)),
    sublabel ? el('div', { class: 'hint', style: 'margin:4px 0 0' }, sublabel) : null,
    input,
  );
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
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

export function pngUrl(bytes) {
  return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
}

export function fmtBytes(n) {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}
