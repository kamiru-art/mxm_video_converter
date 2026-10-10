// Lo que la página sabe del equipo para repartir la memoria: si es un
// teléfono (o una tableta) y cuánta RAM conviene suponer.
//
// Un teléfono no da menos calidad: corre el mismo núcleo con la misma
// profundidad de bits. Lo que cambia es cuánta memoria aguanta la pestaña
// antes de que el sistema la cierre: Safari en iPhone lo hace cerca de 1 a
// 1,5 GB, y Android cierra la pestaña cuando el sistema necesita la
// memoria. Por eso aquí se trabaja más despacio (menos a la vez), y se
// pregunta antes de un trabajo que, aun solo, ya es demasiado grande.

import { fmtBytes } from './ui.ts';

function detectMobile(): boolean {
  // Chromium lo dice; una tableta Android dice `false`, y la mira la
  // expresión de abajo
  if (navigator.userAgentData?.mobile) return true;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  // un iPad se presenta como un Mac de escritorio; ningún Mac tiene
  // pantalla táctil
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

const MOBILE = detectMobile();

/** Teléfono o tableta. */
export function isMobile(): boolean {
  return MOBILE;
}

/** RAM en GB con la que se reparte la memoria. En un ordenador, la que
 *  informa el navegador (Chrome, con tope de 8) o 4 si no la informa (Safari,
 *  Firefox). En un teléfono, 2 si no la informa (todos los iPhone), y nunca
 *  más de 4: la pestaña de un teléfono recibe mucho menos que la RAM total. */
export function deviceRamGb(): number {
  const reported = navigator.deviceMemory;
  if (!MOBILE) return reported || 4;
  return Math.min(reported || 2, 4);
}

/** Memoria de UN trabajo (un escaneo, una hoja, un fotograma) por encima de
 *  la cual un teléfono pregunta antes de empezar. Por debajo del cierre de la
 *  pestaña en iPhone, porque la página, el navegador y lo que rodea al
 *  trabajo usan parte de esa memoria. */
const PHONE_HEAVY_BYTES = 600e6;

/** En un teléfono, pregunta antes de un trabajo que necesita mucha memoria a
 *  la vez. En un ordenador, o por debajo del umbral, no pregunta y devuelve
 *  `true`. `what` empieza la frase: "The scan “a.tif”", "One sheet"… */
export function confirmHeavyOnPhone(what: string, peakBytes: number): boolean {
  if (!MOBILE || !(peakBytes >= PHONE_HEAVY_BYTES)) return true;
  return confirm(
    `${what} needs about ${fmtBytes(peakBytes)} of memory at one time. That is a lot for a phone: the browser can close this tab before the end, and then the work in progress is lost. If it finishes, the result has the full quality. A computer does it safely.\n\nContinue on this phone?`,
  );
}
