// Tipos compartidos entre la interfaz, el pool y el worker: la forma de los
// ajustes, del layout.json y de lo que devuelve el núcleo Rust.
//
// Las claves en español (hojas, marcadores, ajustes, etiqueta…) son el
// formato en disco de layout.json y de los perfiles guardados: un proyecto
// escrito por una versión anterior tiene que seguir cargando. No se renombran.

/** Bytes sobre un ArrayBuffer de verdad (no compartido): lo que exige un
 *  Blob y lo que se puede transferir a un worker. Todo lo que cruza la
 *  frontera con el núcleo es de este tipo. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Degradado de tres paradas del ColorBlocker: [posición, color hex]. */
export type CyanStops = [number, string][];

/** Ajustes de generación de hojas (fase ①). Es también la sección `ajustes`
 *  del layout.json v2, así que se serializa entera hacia el núcleo. */
export interface Settings {
  paper: string;
  orientation: string;
  dpi: number;
  custom_w_mm: number;
  custom_h_mm: number;
  margin_mm: number;
  gutter_mm: number;
  bg_color: string;
  alpha_mode: string;
  alpha_bg_color: string;
  alpha_border_color: string;
  alpha_border_mm: number;
  cols: number;
  rows: number;
  labels_on: boolean;
  base_name: string;
  separator: string;
  leading_zeros: number;
  start_index: number;
  font_size_pt: number;
  label_gap_mm: number;
  label_color: string;
  page_num_on: boolean;
  page_num_corner: string;
  page_num_prefix: string;
  page_num_start: number;
  page_num_zeros: number;
  page_num_size_pt: number;
  page_num_color: string;
  registration_on: boolean;
  marker_count: number;
  marker_size_mm: number;
  marker_margin_mm: number;
  marker_dict: string;
  qr_on: boolean;
  qr_size_mm: number;
  gray_patch_on: boolean;
  project_name: string;
  mode: string;
  cyan_mirror: boolean;
  cyan_ink: string;
  cyan_curve: number[] | null;
  cyan_curve_strength: number;
  cyan_adaptive: number;
  cyan_clarity: number;
  cyan_bg: string;
  cyan_halo_mm: number;
  cyan_frame_border_mm: number;
  cyan_block_color: string | null;
  cyan_ink_stops: CyanStops | null;
  print_scale_x: number;
  print_scale_y: number;
  out_name: string;
  fmt_png: boolean;
  fmt_pdf: boolean;
  fmt_tiff: boolean;
  /** Hojas a generar ("3, 5-7"); vacío = todas. Solo en la generación. */
  sheets_include?: string;
  sheets_exclude?: string;
}

/** Claves de `T` cuyo valor es de un tipo dado: para enlazar controles. */
export type NumberKeys<T> = { [K in keyof T]-?: T[K] extends number ? K : never }[keyof T];
export type StringKeys<T> = { [K in keyof T]-?: T[K] extends string ? K : never }[keyof T];
export type BooleanKeys<T> = { [K in keyof T]-?: T[K] extends boolean ? K : never }[keyof T];

// ── layout.json ─────────────────────────────────────────────────

export interface VideoMeta {
  fps_extraccion?: number;
  origen?: string;
  /** Tramo del video original del que salieron los fotogramas, en
   *  segundos: la fase ④ toma de ahí el audio para el video final. */
  inicio_s?: number;
  fin_s?: number;
}

export interface LayoutFrame {
  etiqueta?: string;
  archivo_original?: string;
  [key: string]: unknown;
}

export interface LayoutSheet {
  numero: number;
  frames?: Record<string, LayoutFrame>;
  qrs?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TimelineItem {
  pos: number;
  etiqueta: string;
  rep: string;
}

/** layout.json v1 o v2: el núcleo normaliza, aquí solo se lee lo que la
 *  interfaz necesita para el informe y la línea de tiempo. */
export interface Layout {
  version?: number;
  proyecto?: string;
  modo?: string;
  hojas?: LayoutSheet[];
  timeline?: TimelineItem[];
  ajustes?: Partial<Settings>;
  video?: VideoMeta;
  marcadores?: { ids_por_hoja?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

/** Lo que devuelve `compute_layout`: páginas, rejilla, avisos. */
export interface LayoutInfo {
  landscape: boolean;
  cols: number;
  rows: number;
  grid_swapped?: boolean;
  marker_capacity?: number;
  avisos?: string[];
  [key: string]: unknown;
}

// ── fase ②: resultados del núcleo ───────────────────────────────

/** Entrada del informe de UN escaneo (el JSON `result` de scan_process). */
export interface ScanResult {
  scan: string;
  ok: boolean;
  hoja_numero: number | null;
  via?: string;
  marcadores: number;
  marcadores_total: number;
  residual_mm?: number | null;
  espejado?: boolean;
  escala?: number;
  estrategia?: string;
  error?: string | null;
  advertencias?: string[];
  [key: string]: unknown;
}

/** Un recorte tal como sale del núcleo: bytes PNG. */
export interface CoreFrame {
  label: string;
  png: Bytes;
}

/** Salida de scan_process y scan_finish. `result` es ScanResult en JSON. */
export interface ScanOutput {
  result: string;
  frames: CoreFrame[];
  sin_identificar: CoreFrame[];
  overlay: Bytes | null;
}

/** Salida (JSON) de scan_detect: la homografía para el warp en la GPU y el
 *  estado opaco que scan_finish necesita de vuelta. */
export interface DetectOutput {
  ok: boolean;
  res: ScanResult;
  m: number[];
  flipped: boolean;
  out_w: number;
  out_h: number;
  s: unknown;
  refined_ids: unknown;
  local: unknown;
}

/** Salida de decode_image: RGBA de 8 bits. */
export interface DecodedImage {
  w: number;
  h: number;
  rgba: Bytes;
  had_alpha: boolean;
  sixteen?: boolean;
}

/** Salida de render_sheet. `record` es el registro de la hoja en JSON. */
export interface RenderSheetOutput {
  png?: Bytes;
  record: string;
  page_w: number;
  page_h: number;
}

/** Agrupación de dibujos repetidos sobre la selección actual. */
export interface DedupGroups {
  reps: number[];
  rep_of: number[];
}

// ── calibración: perfiles guardados ─────────────────────────────

export interface PrinterProfile {
  scale_x: number;
  scale_y: number;
  marker_min_mm?: number | null;
  qr_min_mm?: number | null;
  marker_recomendado_mm?: number;
  qr_recomendado_mm?: number;
  notas?: string[];
}

export interface CyanProfile {
  lut: number[];
  respuesta?: [number, number][];
  rango_dinamico?: number;
  ink?: string;
  notas?: string[];
}

export interface ColorProfile {
  mejor_color: string;
  stops?: CyanStops;
  notas?: string[];
}

/** Lo que la fase ① guarda con un preset además de los ajustes. */
export interface Phase1Persist {
  naming: 'auto' | 'original';
  numbering: 'sequential' | 'original';
  pageNumbering: 'sequential' | 'original';
  dedupOn: boolean;
}

export interface PresetProfile {
  settings: Partial<Settings>;
  fase?: Partial<Phase1Persist>;
}
