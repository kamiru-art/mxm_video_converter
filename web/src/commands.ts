// El contrato entre el pool (hilo principal) y el worker: para cada comando,
// qué argumentos lleva y qué devuelve. `run()` en pool.ts y la tabla de
// manejadores en worker.ts se tipan con esta misma tabla, así que un comando
// que cambie de forma se detecta en los dos lados al compilar.

import type { Bytes, DecodedImage, ImageInfo, RenderSheetOutput, ScanOutput } from './types.ts';

/** Un fotograma de video tal como sale del decodificador: un ImageBitmap
 *  (WebCodecs, 8 bits), RGBA de 8 bits sin comprimir (ffmpeg.wasm) o, de una
 *  fuente de más de 8 bits, sus planos sin convertir (DeepFrame). Los tres
 *  son transferibles: el fotograma se mueve al worker, no se copia. */
export type FrameSource = ImageBitmap | RawRgba | DeepFrame;

/** Cómo leer los planos de un DeepFrame (rust-core/src/yuv.rs). */
export interface DeepSpec {
  /** I420P10, I422P10, I444P10, I420P12… (WebCodecs) o RGB48LE (ffmpeg). */
  format: string;
  w: number;
  h: number;
  /** Desplazamiento y paso de fila, en bytes, de cada plano. */
  planes: { offset: number; stride: number }[];
  matrix: 'bt601' | 'bt709' | 'bt2020';
  fullRange: boolean;
  /** Grados en el sentido de las agujas del reloj (metadatos del video). */
  rotation: number;
}

/** Un fotograma de más de 8 bits por canal, aún en los planos del
 *  decodificador: el núcleo lo pasa a RGB de 16 bits. */
export interface DeepFrame {
  data: Bytes;
  spec: DeepSpec;
}

/** Píxeles RGBA de 8 bits sin comprimir, con su tamaño. */
export interface RawRgba {
  rgba: Bytes;
  w: number;
  h: number;
}

/** Lo que devuelve encode_frame: el PNG sin pérdida a resolución nativa (si
 *  se pidió) y la miniatura (si se pidió), como píxeles crudos. Crudos y no
 *  como ImageBitmap porque el hilo principal la vuelca de todos modos en un
 *  OffscreenCanvas propio (ProjectFrame.thumb), y 147 KB de RGBA se
 *  transfieren igual de rápido y sin depender de la GPU del worker. (Los
 *  ImageBitmap transferidos en las dos direcciones llegan bien también en
 *  Safari: medido en frames.ts.) */
export interface EncodedFrame {
  png: Blob | null;
  thumb: RawRgba | null;
  w: number;
  h: number;
  /** El fotograma tenía más de 8 bits y el PNG es de 16. */
  deep?: boolean;
}

export interface Commands {
  version: { args: Record<string, never>; result: string };
  compute_layout: {
    args: { settings: string; firstW: number; firstH: number };
    result: string;
  };
  render_sheet: {
    args: {
      settings: string;
      firstW: number;
      firstH: number;
      meta: string;
      pixels?: Bytes;
      labels: string;
      sheetNum: number;
      render: boolean;
      finish?: string;
      response?: string;
    };
    result: RenderSheetOutput;
  };
  assemble_layout: {
    args: {
      settings: string;
      firstW: number;
      firstH: number;
      records: string;
      timeline: string;
      video: string;
      originalesDir?: string;
    };
    result: string;
  };
  dedup_hashes: { args: { meta: string; pixels: Bytes }; result: string };
  group_duplicates: { args: { hashes: string; threshold?: number }; result: string };
  content_histogram: { args: { meta: string; pixels: Bytes }; result: string };
  effective_curve: {
    args: { lut?: string; strength?: number; adapt?: number; hist?: string };
    result: string;
  };
  decode_image: { args: { bytes: Bytes }; result: DecodedImage };
  /** RGBA de 16 bits (little-endian), para las hojas: sin bajar a 8. */
  decode_image16: { args: { bytes: Bytes }; result: { w: number; h: number; rgba16: Bytes } };
  scan_process: {
    args: { bytes: Bytes; name: string; layout: string; opts?: string; claims?: string };
    result: ScanOutput;
  };
  scan_detect: {
    args: { rgba: Bytes; w: number; h: number; name: string; layout: string; opts?: string };
    result: string;
  };
  scan_finish: {
    args: {
      rgba: Bytes;
      w: number;
      h: number;
      name: string;
      layout: string;
      opts?: string;
      claims?: string;
      state: string;
    };
    result: ScanOutput;
  };
  resize_rgba: {
    args: { rgba: Bytes; w: number; h: number; outW: number; outH: number };
    result: Bytes;
  };
  /** Cabecera de una imagen (PNG, TIFF…) sin decodificar los píxeles. */
  probe_image: { args: { bytes: Bytes }; result: ImageInfo };
  /** Un fotograma del video final: PNG de w×h a 16 bits si `sixteen`, con
   *  alfa si `alpha`, sin bajar nunca su profundidad (conform.rs). */
  conform_frame: {
    args: { bytes: Bytes; w: number; h: number; sixteen: boolean; alpha: boolean };
    result: Bytes;
  };
  /** Un DeepFrame a RGB de 16 bits: el PNG de 16 bits, el RGBA de 16 bits
   *  que recibe una hoja y la miniatura de 8 bits, según se pidan. */
  deep_frame: {
    args: { frame: DeepFrame; png?: boolean; rgba16?: boolean; thumbW?: number };
    result: { w: number; h: number; png?: Bytes; rgba16?: Bytes; thumb?: RawRgba };
  };
  /** PNG sin pérdida de un buffer RGBA de 8 bits: bytes, no un Blob. */
  encode_png_rgba: { args: { rgba: Bytes; w: number; h: number }; result: Bytes };
  encode_tiff: { args: { png: Bytes }; result: Bytes };
  printer_test_png: { args: { paper: string; dpi: number }; result: Bytes };
  analyze_printer_test: {
    args: { bytes: Bytes; paper: string; dpi: number; scanDpi?: number };
    result: string;
  };
  cyan_strip_png: {
    args: {
      paper: string;
      dpi: number;
      ink: string;
      mirror: boolean;
      target: string;
      stops?: string;
      blockColor?: string;
    };
    result: Bytes;
  };
  analyze_cyan_strip: {
    args: {
      bytes: Bytes;
      paper: string;
      dpi: number;
      target: string;
      ink?: string;
      stops?: string;
      blockColor?: string;
    };
    result: string;
  };
  colorblocker_png: {
    args: { paper: string; dpi: number; mirror: boolean; blockColor?: string };
    result: Bytes;
  };
  analyze_colorblocker: { args: { bytes: Bytes; paper: string; dpi: number }; result: string };
  // Sin núcleo: PNG y miniatura de un fotograma de video (ver frames.ts)
  encode_frame: {
    /** `png` por defecto true; sin `thumbW` no hay miniatura. */
    args: { image: FrameSource; thumbW?: number; png?: boolean };
    result: EncodedFrame;
  };
  // PDF con estado (una instancia por worker; el pool lo enruta al worker 0).
  // Va en streaming: pdf_add devuelve los bytes de ESA página y pdf_finish
  // el cierre; el archivo es la concatenación, en orden, de todo lo devuelto
  pdf_new: { args: { dpi: number }; result: null };
  pdf_add: { args: { png: Bytes }; result: Bytes };
  pdf_finish: { args: Record<string, never>; result: Bytes };
  pdf_abort: { args: Record<string, never>; result: null };
}

export type CommandName = keyof Commands;
export type CommandArgs<K extends CommandName> = Commands[K]['args'];
export type CommandResult<K extends CommandName> = Commands[K]['result'];

/** Mensaje del pool al worker. */
export interface WorkerRequest {
  id: number;
  cmd: CommandName;
  args: unknown;
}

/** Respuesta del worker. `mem` y `pinned` viajan en TODAS para que el pool
 *  pueda reciclar workers hinchados sin perder un PDF a medias. */
export interface WorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
  mem: number;
  pinned: boolean;
  /** El núcleo hizo panic: el módulo queda en estado dudoso. */
  poisoned?: boolean;
}
