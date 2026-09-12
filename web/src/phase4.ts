// Fase ④ — Reconstruir el video final desde los fotogramas procesados.

import { errMsg, isCancelled } from './errors.ts';
import { clearOutputs } from './opfs.ts';
import { currentVideo } from './phase1.ts';
import { ph2 } from './phase2.ts';
import { project } from './project.ts';
import type { Layout, TimelineItem } from './types.ts';
import {
  cancelButton,
  check,
  download,
  dropzone,
  el,
  field,
  lockControls,
  numberInput,
  progressBar,
  sanitizeLabel,
  select,
  toast,
} from './ui.ts';
import type { AudioFrom, VideoResult } from './video.ts';
import { buildVideo, buildVideoLossless, buildVideoProres, decodeFrameBitmap } from './video.ts';

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
  const fmtSel = select(
    [
      ['auto', 'Automatic (best supported)'],
      ['mp4', 'MP4 (H.264)'],
      ['webm', 'WebM (VP9/VP8)'],
    ],
    'auto',
  );
  const qualSel = select(
    [
      ['lossless', 'Lossless (PNG frames in a MOV, for editors)'],
      ['prores', 'ProRes 4444 (edit-ready, plays in QuickTime)'],
      ['max', 'Maximum (visually lossless, huge file)'],
      ['very_high', 'Very high'],
      ['high', 'High (recommended)'],
      ['medium', 'Medium'],
      ['low', 'Low (small file)'],
      ['custom', 'Custom bitrate…'],
    ],
    'high',
  );
  const isMovQuality = (): boolean => qualSel.value === 'lossless' || qualSel.value === 'prores';
  const bitrateIn = numberInput(8, { min: 0.5, max: 500, step: 0.5 });
  const bitrateField = field('Bitrate (Mbps)', bitrateIn);
  bitrateField.style.display = 'none';
  qualSel.addEventListener('change', () => {
    bitrateField.style.display = qualSel.value === 'custom' ? '' : 'none';
    fmtSel.disabled = isMovQuality(); // el contenedor es MOV
    refreshResInfo();
  });
  const resSel = select(
    [
      ['original', 'Original (same as the frames)'],
      ['4320', '8K (4320p)'],
      ['2880', '5K (2880p)'],
      ['2160', '4K (2160p)'],
      ['1440', '1440p'],
      ['1080', '1080p (Full HD)'],
      ['720', '720p'],
      ['480', '480p'],
    ],
    'original',
  );
  const resInfo = el('div', { class: 'hint' }, 'Load frames to see the output resolution.');
  let nativeDims: { w: number; h: number } | null = null; // del primer frame disponible

  function evenPair(w: number, h: number): [number, number] {
    return [Math.max(2, Math.round(w / 2) * 2), Math.max(2, Math.round(h / 2) * 2)];
  }
  function outputDims(): { w: number; h: number; upscaled: boolean } | null {
    if (!nativeDims) return null;
    let { w, h } = nativeDims;
    const target = resSel.value === 'original' ? null : parseInt(resSel.value, 10);
    if (target) {
      w = w * (target / h);
      h = target;
    }
    // los MOV (PNG lossless / ProRes) no exigen dimensiones pares; H.264 sí
    const [ew, eh] = isMovQuality()
      ? [Math.max(1, Math.round(w)), Math.max(1, Math.round(h))]
      : evenPair(w, h);
    return { w: ew, h: eh, upscaled: target ? target > nativeDims.h : false };
  }
  function refreshResInfo(): void {
    const d = outputDims();
    if (!d || !nativeDims) {
      resInfo.textContent = 'Load frames to see the output resolution.';
      return;
    }
    resInfo.textContent =
      `Output resolution: ${d.w}×${d.h}` +
      (resSel.value === 'original'
        ? ' (native frame size)'
        : ` (frames are ${nativeDims.w}×${nativeDims.h})`) +
      (d.upscaled ? '. This upscales the frames; expect some softness.' : '');
  }
  resSel.addEventListener('change', refreshResInfo);
  const nameIn = el('input', { type: 'text', placeholder: '= project name' });
  const prog = progressBar();
  prog.hide();

  // ── audio del original ──────────────────────────────────────
  // Los fotogramas son un tramo del video a N fps: el sonido de ese mismo
  // tramo, recortado a lo que dura la secuencia, cae en su sitio solo. El
  // video de la fase ① se usa sin pedirlo mientras sea el mismo proyecto;
  // en otra sesión se suelta aquí.
  let droppedAudio: File | null = null;
  let appliedStart: number | null = null; // inicio_s del layout ya volcado al campo
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
  const preview = el('video', {
    controls: '',
    style: 'max-width:100%; border-radius:6px; margin-top:10px; display:none',
  });

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

  function refresh(): void {
    const l = currentLayout();
    layoutInfo.textContent = l
      ? `Layout: ${l.proyecto || 'project'} · ${l.timeline?.length || 'no'} positions in the timeline`
      : 'Load a layout.json (or process scans in phase ②).';
    if (l?.video?.fps_extraccion) fpsIn.value = String(l.video.fps_extraccion);
    // dónde empieza el tramo en el original: lo dice el layout desde que
    // la fase ① lo apunta; uno antiguo deja el 0 y se corrige a mano. Solo
    // al cambiar de layout: volver a la pestaña no pisa lo tecleado
    const start = l?.video?.inicio_s;
    if (start != null && start !== appliedStart) {
      audioStartIn.value = String(start);
      appliedStart = start;
    }
    refreshAudioInfo();
    const disponibles = availableMap();
    stateInfo.textContent = `${disponibles.size} frames available (phase ② in memory + whatever you drop here).`;
    if (l) {
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
      // dimensiones nativas del primer frame disponible, para mostrar la salida
      const first = files[0];
      if (first) {
        decodeFrameBitmap(first.data)
          .then((bmp) => {
            nativeDims = { w: bmp.width, h: bmp.height };
            bmp.close();
            refreshResInfo();
          })
          .catch(() => {});
      } else {
        nativeDims = null;
        refreshResInfo();
      }
    }
  }

  const buildBtn = el(
    'button',
    { class: 'btn sun', style: 'width:100%; margin-top:10px' },
    'Rebuild video',
  );
  // cancelar a mitad: una exportación 4K larga son minutos. Todo el panel
  // queda bloqueado mientras corre: la calidad o la resolución ya no cambian
  // lo que se está codificando
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
    const ctl = buildCancel.arm();
    const unlock = lockControls(paper, [buildCancel.button]);
    prog.show();
    try {
      // el MOV ProRes se escribe en el disco privado del navegador: fuera
      // los de exportaciones anteriores que ya nadie descarga
      await clearOutputs(10 * 60e3);
      const audio = audioFrom();
      const common = {
        targetH: resSel.value === 'original' ? 0 : parseInt(resSel.value, 10),
        audio,
        signal: ctl.signal,
      };
      // un getter por dibujo ÚNICO (files repite objetos para los dedup):
      // buildVideo cachea los reescalados por identidad del getter
      const getterOf = new Map<Available, () => Promise<ImageBitmap>>();
      const getters = files.map((f) => {
        let g = getterOf.get(f);
        if (!g) {
          g = async () => decodeFrameBitmap(f.data); // TIFF sueltos incluidos
          getterOf.set(f, g);
        }
        return g;
      });
      const fps = parseFloat(fpsIn.value) || 12;
      let out: VideoResult;
      if (qualSel.value === 'lossless') {
        const blobs = files.map((f) => f.data);
        out = await buildVideoLossless(
          blobs,
          fps,
          (i, n) => prog.set(i / (n + 1), `preparing frame ${i}/${n}`),
          common,
        );
      } else if (qualSel.value === 'prores') {
        const blobs = files.map((f) => f.data);
        prog.set(0.02, 'encoding ProRes…');
        out = await buildVideoProres(
          blobs,
          fps,
          (p) => prog.set(p, `encoding ProRes ${Math.round(p * 100)}%`),
          common,
        );
      } else {
        const format = fmtSel.value === 'mp4' ? 'mp4' : fmtSel.value === 'webm' ? 'webm' : 'auto';
        out = await buildVideo(getters, fps, (i, n) => prog.set(i / n, `encoding ${i}/${n}`), {
          format,
          quality: qualSel.value,
          bitrateMbps: parseFloat(bitrateIn.value) || 0,
          ...common,
        });
      }
      // se pidió audio y no lo hay: que no pase en silencio, nunca mejor dicho
      if (audio && !out.audio) {
        toast(
          `${audio.file.name} has no audio track this browser can read: the video is silent.`,
          'err',
        );
      }
      const sound = out.audio ? ' With the original sound.' : '';
      const base = sanitizeLabel(nameIn.value.trim() || l.proyecto || 'video');
      const name = `${base}.${out.ext}`;
      download(out.bytes, name, out.mime);
      if (preview.src) URL.revokeObjectURL(preview.src); // soltar el video anterior
      if (out.ext === 'mov') {
        // los navegadores no decodifican PNG-en-MOV ni ProRes: sin vista previa
        preview.removeAttribute('src');
        preview.style.display = 'none';
        toast(
          qualSel.value === 'prores'
            ? `ProRes MOV saved (${fps} fps).${sound} Open it in QuickTime or your editor; browsers cannot preview it.`
            : `Lossless MOV saved (${fps} fps).${sound} Open it in DaVinci Resolve, Premiere, VLC or IINA; QuickTime and browsers cannot play PNG video. For a QuickTime-playable master use the ProRes 4444 quality.`,
          'ok',
        );
      } else {
        preview.src = URL.createObjectURL(new Blob([out.bytes], { type: out.mime }));
        preview.style.display = '';
        toast(`Video rebuilt (${out.ext.toUpperCase()}, ${fps} fps).${sound}`, 'ok');
      }
    } catch (e) {
      if (isCancelled(e)) {
        toast('Video export cancelled.');
      } else {
        console.error(e);
        toast(`Encoding failed: ${errMsg(e)}`, 'err');
      }
    } finally {
      buildCancel.disarm();
      unlock();
      buildBtn.disabled = false;
      prog.hide();
    }
  });

  const paper = el(
    'div',
    { class: 'paper' },
    el('h2', {}, '③ Final video'),
    el(
      'div',
      { class: 'hint' },
      'Rebuilds the video from the processed frames in their original order, reusing deduplicated drawings wherever they appear.',
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
      sublabel: 'Frames processed in another session: drop the folder here.',
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
      field('Format', fmtSel),
    ),
    el(
      'div',
      { class: 'row' },
      field('Quality', qualSel),
      bitrateField,
      field('Resolution', resSel),
    ),
    resInfo,
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
    el(
      'div',
      { class: 'hint' },
      'Lossless writes every frame as PNG inside a MOV: pixel-identical at any resolution, 8K included. It opens in DaVinci Resolve, Premiere, VLC and IINA; QuickTime Player and browsers cannot play PNG video. ProRes 4444 is the QuickTime-playable master: visually lossless, 10-bit. The other qualities use the browser encoder and are lossy.',
    ),
    field('File name', nameIn),
    buildBtn,
    el('div', { class: 'row tight', style: 'justify-content:center' }, buildCancel.button),
    prog.root,
  );

  const bench = el(
    'div',
    { class: 'bench' },
    el('h2', {}, 'Result'),
    el(
      'div',
      { class: 'hint' },
      'Encoded in your browser: H.264 MP4 or WebM (VP9/AV1) for the lossy qualities, PNG-in-MOV or ProRes 4444 for editing. If the browser encoder rejects a resolution (some machines refuse 5K/8K H.264), the MOV qualities still work.',
    ),
    preview,
  );

  root.append(el('div', { class: 'workbench' }, paper, bench));
  root.addEventListener('mxm:activated', refresh);
  refresh();
}
