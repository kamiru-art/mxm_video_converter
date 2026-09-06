// Ajustes por defecto de la fase ① y su normalización. Vive aparte de
// phase1.ts para que la prueba de punta a punta no arrastre toda la interfaz
// solo por los valores por defecto.

import type { Settings, StringKeys } from './types.ts';

// Los ajustes guardados antes de unificar la interfaz en inglés llevan los
// valores en español. El núcleo Rust sigue aceptando ambos, pero los
// desplegables solo tienen los nuevos: sin esta tabla, cargar un preset
// antiguo dejaría el control en la primera opción y cambiaría el proyecto.
const LEGACY_VALUES: Partial<Record<StringKeys<Settings>, Record<string, string>>> = {
  paper: {
    'Carta (Letter)': 'Letter',
    'Oficio (Legal)': 'Legal',
    'Tabloide (Tabloid)': 'Tabloid',
    Personalizado: 'Custom',
  },
  orientation: {
    'Mejor ajuste (automático)': 'auto',
    'Mejor ajuste (automatico)': 'auto',
    Vertical: 'portrait',
    Horizontal: 'landscape',
  },
  page_num_corner: {
    'Inferior derecha': 'Bottom right',
    'Inferior izquierda': 'Bottom left',
    'Superior derecha': 'Top right',
    'Superior izquierda': 'Top left',
  },
  alpha_mode: { ninguno: 'none', color: 'color', borde: 'border' },
  cyan_bg: { ahorro: 'saving', completo: 'full' },
  mode: { cianotipia: 'cyanotype', normal: 'normal' },
};

/** Traduce al vocabulario actual los ajustes que vengan de una versión
 *  anterior (localStorage, un preset exportado o el layout de un proyecto). */
export function normalizeSettings<T extends Partial<Settings>>(settings: T): T {
  const out = { ...settings };
  for (const [key, table] of Object.entries(LEGACY_VALUES) as [
    StringKeys<Settings>,
    Record<string, string>,
  ][]) {
    const v = out[key];
    if (typeof v === 'string' && table[v]) out[key] = table[v];
  }
  return out;
}

export function defaultSettings(): Settings {
  return {
    paper: 'A4',
    orientation: 'auto',
    dpi: 300,
    custom_w_mm: 210,
    custom_h_mm: 297,
    margin_mm: 10,
    gutter_mm: 5,
    bg_color: '#FFFFFF',
    alpha_mode: 'none',
    alpha_bg_color: '#000000',
    alpha_border_color: '#000000',
    alpha_border_mm: 0.5,
    cols: 4,
    rows: 5,
    labels_on: true,
    base_name: 'abc',
    separator: '_',
    leading_zeros: 3,
    start_index: 1,
    font_size_pt: 9,
    label_gap_mm: 1.5,
    label_color: '#000000',
    page_num_on: true,
    page_num_corner: 'Bottom right',
    page_num_prefix: '',
    page_num_start: 1,
    page_num_zeros: 1,
    page_num_size_pt: 11,
    page_num_color: '#000000',
    registration_on: true,
    marker_count: 8,
    marker_size_mm: 10,
    marker_margin_mm: 4,
    marker_dict: 'DICT_5X5_100',
    qr_on: false,
    qr_size_mm: 10,
    gray_patch_on: false,
    project_name: '',
    mode: 'normal',
    cyan_mirror: true,
    cyan_ink: '#000000',
    cyan_curve: null,
    cyan_curve_strength: 100,
    cyan_adaptive: 0,
    cyan_clarity: 0,
    cyan_bg: 'saving',
    cyan_halo_mm: 5,
    cyan_frame_border_mm: 0.8,
    cyan_block_color: null,
    cyan_ink_stops: null,
    print_scale_x: 1,
    print_scale_y: 1,
    out_name: 'hojas',
    fmt_png: true,
    fmt_pdf: true,
    fmt_tiff: false,
  };
}

/** El modo cianotipia se guarda como "cyanotype"; los proyectos anteriores
 *  lo llamaban "cianotipia". */
export function isCyanotype(s: Pick<Partial<Settings>, 'mode'>): boolean {
  const m = String(s.mode ?? '').toLowerCase();
  return m.startsWith('cyan') || m.startsWith('cian');
}
