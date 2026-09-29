// Vista previa del video final, dentro de la página.
//
// El video que se guarda no tiene pérdida (PNG en MOV, o una secuencia de
// PNG), y ningún navegador ni ningún teléfono reproduce eso. Así que la
// vista previa no sale del archivo: pasa los mismos fotogramas, en el mismo
// orden y a los mismos fps, sobre un lienzo, con el sonido del original
// sonando debajo. Es una vista: las imágenes van reducidas al tamaño de la
// pantalla y a 8 bits; lo que se guarda no pasa por aquí.

import type { AudioFrom } from './export.ts';
import { run } from './pool.ts';
import { context2d, el } from './ui.ts';

/** Memoria máxima de la vista previa (bitmaps reducidos, RGBA). */
const BUDGET_BYTES = 160e6;
/** Ancho máximo de un fotograma en la vista previa. */
const MAX_W = 1280;

function isTiff(head: Uint8Array): boolean {
  return (
    (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0) ||
    (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a)
  );
}

/** Un fotograma a tamaño de vista previa. Los TIFF los decodifica el
 *  núcleo: sólo Safari los abre por su cuenta. */
async function previewBitmap(blob: Blob, maxW: number): Promise<ImageBitmap> {
  let full: ImageBitmap;
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (isTiff(head)) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const d = await run('decode_image', { bytes }, [bytes.buffer]);
    full = await createImageBitmap(
      new ImageData(
        new Uint8ClampedArray(d.rgba.buffer, d.rgba.byteOffset, d.w * d.h * 4),
        d.w,
        d.h,
      ),
    );
  } else {
    full = await createImageBitmap(blob);
  }
  if (full.width <= maxW) return full;
  const w = maxW;
  const h = Math.max(1, Math.round((full.height / full.width) * maxW));
  const c = new OffscreenCanvas(w, h);
  const ctx = context2d(c);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, w, h);
  full.close();
  return c.transferToImageBitmap();
}

export interface Player {
  root: HTMLElement;
  /** Carga una secuencia (en orden, con repetidos) para verla a `fps`. */
  load(frames: Blob[], fps: number, audio?: AudioFrom): void;
  /** Para y suelta todo (al empezar otra exportación, al salir). */
  clear(): void;
}

export function createPlayer(): Player {
  const canvas = el('canvas', {
    class: 'player-canvas',
    role: 'img',
    'aria-label': 'Preview of the final video',
  });
  const ctx = canvas.getContext('2d');
  const playBtn = el('button', { class: 'btn small', type: 'button', disabled: true }, 'Play');
  const scrub = el('input', {
    type: 'range',
    min: '0',
    max: '0',
    value: '0',
    step: '1',
    'aria-label': 'Frame',
    disabled: true,
  });
  const info = el('span', { class: 'hint player-info', 'aria-live': 'polite' });
  const root = el(
    'div',
    { class: 'player', hidden: true },
    canvas,
    el('div', { class: 'player-bar' }, playBtn, scrub, info),
  );

  let seq: Blob[] = [];
  let fps = 12;
  let bitmaps = new Map<Blob, ImageBitmap>();
  let loading = 0; // generación: una carga nueva deja de lado la anterior
  let playing = false;
  let raf = 0;
  let t0 = 0;
  let from = 0; // fotograma en el que empezó la reproducción
  let current = 0;
  let sound: HTMLVideoElement | null = null;
  let soundUrl = '';
  let soundStart = 0;

  function show(i: number): void {
    current = Math.max(0, Math.min(seq.length - 1, i));
    scrub.value = String(current);
    const bmp = bitmaps.get(seq[current]);
    if (bmp && ctx) {
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
    }
    info.textContent = `${current + 1} / ${seq.length} · ${(current / fps).toFixed(2)} s`;
  }

  function tick(): void {
    if (!playing) return;
    // con sonido, el reloj es el sonido: la imagen lo sigue a él
    const t =
      sound && !sound.paused
        ? sound.currentTime - soundStart
        : from / fps + (performance.now() - t0) / 1000;
    const i = Math.floor(t * fps + 1e-6);
    if (i >= seq.length) {
      pause();
      show(seq.length - 1);
      return;
    }
    if (i !== current) show(i);
    raf = requestAnimationFrame(tick);
  }

  function pause(): void {
    playing = false;
    cancelAnimationFrame(raf);
    sound?.pause();
    playBtn.textContent = 'Play';
  }

  async function play(): Promise<void> {
    if (!seq.length) return;
    if (current >= seq.length - 1) show(0);
    playing = true;
    playBtn.textContent = 'Pause';
    from = current;
    t0 = performance.now();
    if (sound) {
      try {
        sound.currentTime = soundStart + current / fps;
        await sound.play();
      } catch {
        // el navegador no reproduce ese original (un AVI, un HEVC en
        // Firefox): la vista previa sigue muda, con su propio reloj
        releaseSound();
        t0 = performance.now();
      }
    }
    raf = requestAnimationFrame(tick);
  }

  function releaseSound(): void {
    if (sound) {
      sound.pause();
      sound.removeAttribute('src');
      sound.load();
    }
    if (soundUrl) URL.revokeObjectURL(soundUrl);
    sound = null;
    soundUrl = '';
  }

  playBtn.addEventListener('click', () => {
    if (playing) pause();
    else void play();
  });
  scrub.addEventListener('input', () => {
    const wasPlaying = playing;
    pause();
    show(parseInt(scrub.value, 10) || 0);
    if (wasPlaying) void play();
  });

  function clear(): void {
    pause();
    loading++;
    for (const b of bitmaps.values()) b.close();
    bitmaps = new Map();
    seq = [];
    releaseSound();
    root.hidden = true;
  }

  function load(frames: Blob[], rate: number, audio?: AudioFrom): void {
    clear();
    if (!frames.length) return;
    const gen = loading;
    seq = frames;
    fps = rate > 0 ? rate : 12;
    root.hidden = false;
    scrub.max = String(frames.length - 1);
    scrub.disabled = true;
    playBtn.disabled = true;
    if (audio) {
      soundUrl = URL.createObjectURL(audio.file);
      sound = el('video', { playsinline: '', preload: 'auto' });
      sound.src = soundUrl;
      soundStart = audio.start;
    }
    const uniq = [...new Set(frames)];
    void (async () => {
      // todos los dibujos caben en el presupuesto: el ancho sale de ahí
      const first = await previewBitmap(uniq[0], MAX_W);
      if (gen !== loading) {
        first.close();
        return;
      }
      const aspect = first.height / first.width;
      const maxW = Math.max(
        160,
        Math.min(MAX_W, Math.floor(Math.sqrt(BUDGET_BYTES / (4 * uniq.length * aspect)))),
      );
      bitmaps.set(uniq[0], first.width <= maxW ? first : await previewBitmap(uniq[0], maxW));
      if (bitmaps.get(uniq[0]) !== first) first.close();
      show(0);
      for (let i = 1; i < uniq.length; i++) {
        const bmp = await previewBitmap(uniq[i], maxW);
        if (gen !== loading) {
          bmp.close();
          return;
        }
        bitmaps.set(uniq[i], bmp);
        info.textContent = `Loading the preview… ${i + 1} / ${uniq.length}`;
      }
      scrub.disabled = false;
      playBtn.disabled = false;
      show(0);
    })().catch((e: unknown) => {
      console.warn('[player] preview failed:', e);
      if (gen === loading) info.textContent = 'The preview could not be loaded.';
    });
  }

  return { root, load, clear };
}
