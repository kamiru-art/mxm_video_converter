// Fase ④ — Reconstruir el video final desde los fotogramas procesados,
// siempre sin pérdida (export.ts): no hay calidades que elegir.

import { errMsg, isCancelled } from './errors.ts';
import type { AudioFrom, ExportKind, ExportStage, SequencePlan } from './export.ts';
import { exportLossless, planSequence } from './export.ts';
import { clearOutputs, holdFrames } from './opfs.ts';
import { currentVideo } from './phase1.ts';
import { ph2 } from './phase2.ts';
import { createPlayer } from './player.ts';
import { project } from './project.ts';
import type { Layout, TimelineItem } from './types.ts';
import {
  cancelButton,
  check,
  download,
  dropzone,
  el,
  field,
  fmtBytes,
  lockControls,
  numberInput,
  progressBar,
  sanitizeLabel,
  select,
  toast,
} from './ui.ts';

/** Un fotograma disponible para el video: el Blob PNG (o el archivo suelto). */
interface Available {
  data: Blob;
}

/** Resuelve la secuencia de imágenes según la línea de tiempo del layout
 *  (port de frames_from_timeline: deduplicados reutilizados, alias). */
function framesFromTimeline(
  layout: Layout,
  disponibles: Map<string, Available>,
): { files: Available[]; missing: string[] } {
  // alias etiqueta→claves desambiguadas
  const alias = new Map<string, string[]>();
  for (const h of layout.hojas ?? []) {
    for (const [clave, info] of Object.entries(h.frames ?? {})) {
      const et = info?.etiqueta;
      if (et && et !== clave) {
        const k = sanitizeLabel(et);
        const list = alias.get(k) ?? [];
        list.push(sanitizeLabel(clave));
        alias.set(k, list);
      }
    }
  }
  let timeline: TimelineItem[] = layout.timeline ?? [];
  if (!timeline.length) {
    timeline = [];
    let pos = 1;
    for (const h of layout.hojas ?? []) {
      for (const et of Object.keys(h.frames ?? {})) {
        timeline.push({ pos: pos++, etiqueta: et, rep: et });
      }
    }
  }
  const files: Available[] = [];
  const missing = new Set<string>();
  for (const item of [...timeline].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))) {
    const rep = sanitizeLabel(item.rep ?? item.etiqueta ?? '');
    const candidates = [rep, `${rep}_procesado`, ...(alias.get(rep) ?? [])];
    let found: Available | null = null;
    for (const c of candidates) {
      const hit = disponibles.get(c);
      if (hit) {
        found = hit;
        break;
      }
    }
    if (found) files.push(found);
    else missing.add(item.etiqueta ?? rep);
  }
  return { files, missing: [...missing].sort() };
}

export function mountPhase4(root: HTMLElement): void {
  let layout: Layout | null = null;
  const extraFrames = new Map<string, Blob>(); // stem → Blob (fotogramas sueltos del usuario)

  const layoutInfo = el('div', { class: 'hint' });
  const stateInfo = el('div', { class: 'hint' });
  const missingBox = el('div');
  const fpsIn = numberInput(12, { min: 0.1, step: 0.1 });
  // no es una calidad: los dos guardan los mismos píxeles, sin pérdida.
  // Es dónde se van a abrir
  const kindSel = select(
    [
      ['mov', 'MOV video (Resolve, Premiere, After Effects, VLC)'],
      ['frames', 'Numbered PNG frames in a ZIP (any editor, Final Cut)'],
    ],
    'mov',
  );
  const planInfo = el(
    'div',
    { class: 'hint', 'aria-live': 'polite' },
    'Load frames to see what will be saved.',
  );
  const nameIn = el('input', {
    type: 'text',
    placeholder: 'Project name…',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const prog = progressBar();
  prog.hide();
  const player = createPlayer();

  // ── audio del original ──────────────────────────────────────
  // Los fotogramas son un tramo del video a N fps: el sonido de ese mismo
  // tramo, recortado a lo que dura la secuencia, cae en su sitio solo. El
  // video de la fase ① se usa sin pedirlo mientras sea el mismo proyecto;
  // en otra sesión se suelta aquí.
  let droppedAudio: File | null = null;
  let appliedStart: number | null = null; // inicio_s del layout ya volcado al campo
  let appliedFps: number | null = null; // fps_extraccion del layout ya volcado al campo
  const audioCheck = check('Add the sound of the original video, in sync with the frames', true);
  const audioStartIn = numberInput(0, { min: 0, step: 0.01 });
  const audioInfo = el('div', { class: 'hint' });
  const audioDz = dropzone({
    label: 'Original video (for its audio)',
    sublabel: 'Optional: the clip the frames came from. Only its sound is used.',
    accept: 'video/*,.mov,.mp4,.mkv,.webm,.avi,.mpg,.mpeg,.m4v',
    onFiles: ([f]) => {
      droppedAudio = f;
      audioCheck.input.checked = true;
      refreshAudioInfo();
    },
  });
  interface AudioPick {
    file: File;
    from: string;
  }
  function audioPick(): AudioPick | null {
    if (droppedAudio) return { file: droppedAudio, from: 'dropped here' };
    const v = currentVideo();
    const l = currentLayout();
    // el de la fase ① vale si el layout es de ese mismo video (o no dice)
    if (v && (!l?.video?.origen || l.video.origen === v.name)) return { file: v, from: 'phase ①' };
    return null;
  }
  function audioFrom(): AudioFrom | undefined {
    const pick = audioPick();
    if (!pick || !audioCheck.input.checked) return undefined;
    const start = parseFloat(audioStartIn.value);
    return { file: pick.file, start: Number.isFinite(start) && start > 0 ? start : 0 };
  }
  function refreshAudioInfo(): void {
    const pick = audioPick();
    const l = currentLayout();
    if (!pick) {
      audioInfo.textContent =
        'No original video at hand: drop it above to add its sound. The video comes out silent otherwise.';
      return;
    }
    const fpsOut = parseFloat(fpsIn.value) || 0;
    const fpsSrc = l?.video?.fps_extraccion ?? 0;
    const start = parseFloat(audioStartIn.value) || 0;
    let txt = `Audio from ${pick.file.name} (${pick.from}), from ${start.toFixed(2)} s of it.`;
    if (fpsSrc && fpsOut && Math.abs(fpsOut - fpsSrc) > 1e-6) {
      const ratio = fpsOut / fpsSrc;
      txt += ` The frames were extracted at ${fpsSrc} fps: at ${fpsOut} fps the drawings run ${ratio.toFixed(2)}× ${ratio > 1 ? 'faster' : 'slower'} than the sound and drift apart. Use ${fpsSrc} fps to keep them together.`;
    }
    audioInfo.textContent = txt;
  }
  audioCheck.input.addEventListener('change', refreshAudioInfo);
  audioStartIn.addEventListener('change', refreshAudioInfo);
  fpsIn.addEventListener('change', refreshAudioInfo);

  function currentLayout(): Layout | null {
    if (layout) return layout;
    if (ph2.layout) return ph2.layout;
    if (project.layoutJson) return JSON.parse(project.layoutJson) as Layout;
    return null;
  }

  function availableMap(): Map<string, Available> {
    const map = new Map<string, Available>();
    for (const [label, png] of project.processedFrames) {
      map.set(sanitizeLabel(label), { data: png });
    }
    for (const [stemName, blob] of extraFrames) {
      map.set(stemName, { data: blob });
    }
    return map;
  }

  /** Lo que se va a guardar, en una línea: tamaño, profundidad, y cuántos
   *  dibujos van tal cual. */
  function describePlan(p: SequencePlan): string {
    const depth = p.sixteen ? '16 bits per channel' : '8 bits per channel';
    const touched =
      p.conform === 0
        ? 'every drawing is copied as it is'
        : `${p.passthrough} of ${p.unique} drawings copied as they are, ${p.conform} brought to that size and depth` +
          (p.resized ? ` (${p.resized} of a really different size, fitted with Lanczos)` : '');
    return `Lossless: ${p.w}×${p.h}, ${depth}${p.alpha ? ' with transparency' : ''}, ${p.frames} frames; ${touched}.`;
  }

  let planSeq = 0;
  function refreshPlan(files: Blob[]): void {
    const seq = ++planSeq;
    if (!files.length) {
      planInfo.textContent = 'Load frames to see what will be saved.';
      return;
    }
    planInfo.textContent = 'Reading the frames…';
    planSequence(files)
      .then(({ plan }) => {
        if (seq === planSeq) planInfo.textContent = describePlan(plan);
      })
      .catch((e: unknown) => {
        if (seq === planSeq) planInfo.textContent = `Some frames cannot be read: ${errMsg(e)}`;
      });
  }

  function refresh(): void {
    const l = currentLayout();
    layoutInfo.textContent = l
      ? `Layout: ${l.proyecto || 'project'} · ${l.timeline?.length || 'no'} positions in the timeline`
      : 'Load a layout.json (or process scans in phase ②).';
    // los fps y el inicio del sonido salen del layout, pero sólo cuando el
    // layout CAMBIA: volver a la pestaña o soltar más fotogramas no pisa lo
    // que el usuario haya tecleado
    const fpsSrc = l?.video?.fps_extraccion;
    if (fpsSrc != null && fpsSrc !== appliedFps) {
      fpsIn.value = String(fpsSrc);
      appliedFps = fpsSrc;
    }
    // uno antiguo deja el 0 y se corrige a mano
    const start = l?.video?.inicio_s;
    if (start != null && start !== appliedStart) {
      audioStartIn.value = String(start);
      appliedStart = start;
    }
    refreshAudioInfo();
    const disponibles = availableMap();
    stateInfo.textContent = `${disponibles.size} frames available (phase ② in memory + whatever you drop here).`;
    if (!l) {
      refreshPlan([]);
      return;
    }
    const { files, missing } = framesFromTimeline(l, disponibles);
    missingBox.replaceChildren(
      missing.length
        ? el(
            'div',
            { class: 'missing-box' },
            el('strong', {}, `Missing ${missing.length}: `),
            missing.slice(0, 40).join(', ') + (missing.length > 40 ? '…' : ''),
          )
        : el('div', { class: 'allok-box' }, `All ${files.length} video positions have a frame.`),
    );
    refreshPlan(files.map((f) => f.data));
  }

  const buildBtn = el(
    'button',
    { class: 'btn sun', type: 'button', style: 'width:100%; margin-top:10px' },
    'Save the video',
  );
  // cancelar a mitad: una exportación 4K larga son minutos. Todo el panel
  // queda bloqueado mientras corre
  const buildCancel = cancelButton('Cancel');
  buildBtn.addEventListener('click', async () => {
    const l = currentLayout();
    if (!l) {
      toast('No layout.', 'err');
      return;
    }
    const { files, missing } = framesFromTimeline(l, availableMap());
    if (!files.length) {
      toast('There are no frames to build the video.', 'err');
      return;
    }
    if (
      missing.length &&
      !confirm(
        `${missing.length} frames are missing; the video will skip those positions. Continue?`,
      )
    )
      return;
    buildBtn.disabled = true;
    let release: (() => void) | undefined;
    const ctl = buildCancel.arm();
    const unlock = lockControls(paper, [buildCancel.button]);
    prog.show();
    player.clear();
    try {
      // el archivo se escribe en el disco privado del navegador: fuera los
      // de exportaciones anteriores que ya nadie descarga
      await clearOutputs(10 * 60e3);
      // y que nadie borre los fotogramas de debajo mientras se leen (la
      // fase ② los borra al vaciar su informe)
      release = holdFrames();
      const audio = audioFrom();
      const fps = parseFloat(fpsIn.value) || 12;
      const kind = kindSel.value as ExportKind;
      const base = sanitizeLabel(nameIn.value.trim() || l.proyecto || 'video');
      const frames = files.map((f) => f.data);
      // qué está pasando, no sólo cuánto va: una exportación larga que sólo
      // enseña un número parece colgada en cuanto el número deja de subir
      const labels: Record<ExportStage, (d: number, t: number) => string> = {
        preparing: (d, t) => `bringing ${t} drawing(s) to one size and depth: ${d}/${t}`,
        sound: (d) => `reading the sound of the original… ${Math.round(d * 100)}%`,
        writing: (d, t) => `writing frame ${d}/${t}`,
      };
      const weight: Record<ExportStage, [number, number]> = {
        preparing: [0, 0.6],
        sound: [0.6, 0.7],
        writing: [0.7, 1],
      };
      const out = await exportLossless(frames, fps, {
        kind,
        audio,
        baseName: base,
        signal: ctl.signal,
        onProgress: (stage, d, t) => {
          const [a, b] = weight[stage];
          prog.set(a + (b - a) * (t ? d / t : 1), labels[stage](d, t));
        },
      });
      // se pidió audio y no lo hay: que no pase en silencio, nunca mejor
      // dicho, y con el motivo de verdad, que no siempre es el mismo
      if (audio && !out.audio) {
        toast(
          `${out.audioNote ?? `${audio.file.name} has no audio track this browser can read`}: the video is silent.`,
          'err',
        );
      }
      download(out.bytes, `${base}.${out.ext}`, out.mime);
      const size = fmtBytes(out.bytes instanceof Blob ? out.bytes.size : out.bytes.byteLength);
      const sound = out.audio ? ', with the original sound' : '';
      toast(
        kind === 'mov'
          ? `Lossless MOV saved: ${out.plan.w}×${out.plan.h}, ${fps} fps, ${size}${sound}. It opens in DaVinci Resolve, Premiere, After Effects, VLC and IINA; QuickTime and phones do not play PNG video, so watch it in the preview.`
          : `Lossless frames saved: ${out.plan.frames} PNG files, ${size}${sound}. Import them as an image sequence at ${fps} fps.`,
        'ok',
      );
      player.load(frames, fps, audio);
    } catch (e) {
      if (isCancelled(e)) {
        toast('Video export cancelled.');
      } else {
        console.error(e);
        toast(`Saving failed: ${errMsg(e)}`, 'err');
      }
    } finally {
      release?.();
      buildCancel.disarm();
      unlock();
      buildBtn.disabled = false;
      prog.hide();
    }
  });

  const previewBtn = el('button', { class: 'btn ghost small', type: 'button' }, 'Preview');
  previewBtn.addEventListener('click', () => {
    const l = currentLayout();
    if (!l) {
      toast('No layout.', 'err');
      return;
    }
    const { files } = framesFromTimeline(l, availableMap());
    if (!files.length) {
      toast('There are no frames to preview.', 'err');
      return;
    }
    player.load(
      files.map((f) => f.data),
      parseFloat(fpsIn.value) || 12,
      audioFrom(),
    );
  });

  const paper = el(
    'div',
    { class: 'paper' },
    el('h2', {}, '③ Final video'),
    el(
      'div',
      { class: 'hint' },
      'Rebuilds the video from the processed frames in their original order, reusing deduplicated drawings wherever they appear. Nothing is compressed away: every pixel, at full depth.',
    ),
    dropzone({
      label: 'Project layout.json (optional if you come from phase ②)',
      accept: '.json',
      onFiles: async ([f]) => {
        try {
          layout = JSON.parse(await f.text()) as Layout;
          refresh();
        } catch (e) {
          toast(errMsg(e), 'err');
        }
      },
    }),
    layoutInfo,
    el('h3', {}, 'Frames'),
    dropzone({
      label: 'Add processed frames from files (optional)',
      sublabel:
        'Frames processed in another session (PNG or TIFF, 8 or 16 bit): drop the folder here.',
      accept: 'image/*,.tif,.tiff',
      multiple: true,
      onFiles: (files) => {
        for (const f of files) extraFrames.set(sanitizeLabel(f.name.replace(/\.[^.]+$/, '')), f);
        refresh();
      },
    }),
    stateInfo,
    missingBox,
    el('h3', {}, 'Output'),
    el(
      'div',
      { class: 'row' },
      field('Frames per second', fpsIn, 'From the project; editable.'),
      field('Save as', kindSel),
    ),
    planInfo,
    el('h3', {}, 'Sound'),
    audioDz,
    el(
      'div',
      { class: 'row' },
      audioCheck.label,
      field(
        'Audio starts at (s)',
        audioStartIn,
        'Where the extracted range began in the original; filled in from the layout.',
      ),
    ),
    audioInfo,
    field('File name', nameIn),
    buildBtn,
    el('div', { class: 'row tight', style: 'justify-content:center' }, buildCancel.button),
    prog.root,
  );

  const bench = el(
    'div',
    { class: 'bench' },
    el('h2', {}, 'Preview'),
    el(
      'div',
      { class: 'hint' },
      'The saved file has no losses, and browsers and phones cannot play lossless video: watch it here instead, with its sound.',
    ),
    el('div', { class: 'btn-row' }, previewBtn),
    player.root,
  );

  root.append(el('div', { class: 'workbench' }, paper, bench));
  root.addEventListener('mxm:activated', refresh);
  refresh();
}
