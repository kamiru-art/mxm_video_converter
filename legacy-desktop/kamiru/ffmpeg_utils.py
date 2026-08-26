"""Localización de ffmpeg, sondeo de metadatos y extracción de fotogramas.

Estrategia de calidad / color:
  * Los fotogramas se extraen a PNG, que es un formato SIN PÉRDIDA.
  * NO se aplica ningún filtro de color, escalado ni reencuadre. El único paso
    inevitable es la conversión YUV->RGB que hace el decodificador para poder
    guardar PNG; eso es exactamente lo que muestra cualquier reproductor y no
    constituye una "corrección" ni alteración del color.
  * No se fuerza -pix_fmt, de modo que si el origen es de 10 bits se conserva la
    profundidad en el PNG.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path


class FFmpegError(RuntimeError):
    pass


class _StderrDrain:
    """Vacía stderr de ffmpeg en segundo plano.

    ffmpeg escribe diagnósticos del decodificador por stderr. Si nadie lee esa
    tubería, el sistema operativo la llena (~64 KB) y ffmpeg se BLOQUEA al
    escribir; como está bloqueado deja de emitir el progreso por stdout y el
    bucle lector se queda esperando una línea que no llega nunca (deadlock
    clásico de tuberías: colgaba la app con un video corrupto y dejaba el
    botón de cancelar inservible).

    Este hilo lee continuamente y conserva solo la cola del texto, que es lo
    que se muestra al usuario si ffmpeg termina con error.
    """

    _MAX_LINES = 400

    def __init__(self, stream, keep_chars: int = 1500):
        self._stream = stream
        self._keep = keep_chars
        self._lines: list[str] = []
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        try:
            for line in self._stream:
                self._lines.append(line)
                if len(self._lines) > self._MAX_LINES:
                    del self._lines[: self._MAX_LINES // 2]
        except (OSError, ValueError):
            pass

    def text(self, timeout: float = 2.0) -> str:
        """Texto final de stderr (espera brevemente a que el hilo termine)."""
        self._thread.join(timeout)
        return "".join(self._lines)[-self._keep:]


def _no_window_kwargs():
    """Evita que en Windows aparezca una ventana de consola al lanzar ffmpeg."""
    if sys.platform.startswith("win"):
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        return {"startupinfo": si,
                "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    return {}


def find_ffmpeg() -> str:
    """Devuelve la ruta a un ejecutable de ffmpeg utilizable.

    Prioriza el binario empaquetado por imageio-ffmpeg (igual en todos los
    sistemas, no requiere que el usuario instale nada). Si no está disponible,
    usa el ffmpeg del sistema (PATH).
    """
    try:
        import imageio_ffmpeg  # type: ignore
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and Path(exe).exists():
            return exe
    except Exception:
        pass

    exe = shutil.which("ffmpeg")
    if exe:
        return exe

    raise FFmpegError(
        "No se encontró ffmpeg. Instala las dependencias con "
        "'pip install -r requirements.txt' (incluye imageio-ffmpeg) o instala "
        "ffmpeg en tu sistema."
    )


# --- Sondeo de metadatos -------------------------------------------------

_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
_VIDEO_RE = re.compile(r"Stream #\d+:\d+.*Video:.*?(\d{2,5})x(\d{2,5})")
_FPS_RE = re.compile(r"(\d+(?:\.\d+)?)\s*fps")


class VideoInfo:
    def __init__(self, duration=0.0, width=0, height=0, fps=0.0):
        self.duration = duration  # segundos (float)
        self.width = width
        self.height = height
        self.fps = fps

    @property
    def duration_hhmmss(self) -> str:
        s = int(self.duration)
        return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


def probe(ffmpeg: str, video_path: str) -> VideoInfo:
    """Sondea duración, resolución y fps del video leyendo la salida de ffmpeg."""
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", video_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        **_no_window_kwargs(),
    )
    text = (proc.stderr or b"").decode("utf-8", "replace")

    info = VideoInfo()
    m = _DURATION_RE.search(text)
    if m:
        h, mn, sec = m.groups()
        info.duration = int(h) * 3600 + int(mn) * 60 + float(sec)
    m = _VIDEO_RE.search(text)
    if m:
        info.width, info.height = int(m.group(1)), int(m.group(2))
    m = _FPS_RE.search(text)
    if m:
        info.fps = float(m.group(1))
    return info


# --- Extracción de fotogramas -------------------------------------------

_FRAME_RE = re.compile(r"frame=\s*(\d+)")


def extract_frames(
    ffmpeg: str,
    video_path: str,
    out_dir: str,
    start: float = 0.0,
    end=None,
    fps=None,
    progress_cb=None,
    cancel_check=None,
    max_frames=None,
):
    """Extrae fotogramas a PNG (sin pérdida) en out_dir.

    Parámetros:
      start, end : recorte en segundos. end=None => hasta el final del video.
      fps        : fotogramas por segundo a muestrear. None => TODOS los
                   fotogramas del rango (un PNG por cada cuadro del video).
      progress_cb: callback(frames_procesados, total_estimado) para la barra.
      cancel_check: callable que devuelve True si se debe abortar.
      max_frames : si se indica, detiene la extracción tras ese número de
                   fotogramas (útil para una vista previa rápida).

    Devuelve la lista ordenada de rutas PNG generadas.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-y"]

    # Búsqueda de inicio antes de -i (rápida). Suficientemente precisa para uso
    # artístico; evita reprocesar todo el video.
    if start and start > 0:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", video_path]
    if end is not None and end > start:
        cmd += ["-t", f"{(end - start):.3f}"]

    # Filtro de muestreo de fps SOLO si se pidió un fps concreto.
    if fps is not None and float(fps) > 0:
        cmd += ["-vf", f"fps={_fps_arg(fps)}"]

    # Sin -pix_fmt: se conserva la profundidad/píxel nativos en el PNG.
    pattern = str(out / "frame_%06d.png")
    cmd += [
        "-an", "-sn", "-dn",          # ignora audio/subtítulos/datos
        "-progress", "pipe:1", "-nostats",
        pattern,
    ]

    # Estimación de total para la barra de progreso.
    total_est = None
    if fps is not None and float(fps) > 0 and end is not None:
        total_est = max(1, int(round((end - start) * float(fps))))

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
        bufsize=1,
        **_no_window_kwargs(),
    )
    # stderr se vacía en paralelo: si no, ffmpeg se bloquea al llenarlo y el
    # bucle de abajo espera para siempre un progreso que ya no llega.
    errdrain = _StderrDrain(proc.stderr)

    reached_max = False
    try:
        for line in proc.stdout:
            if cancel_check and cancel_check():
                proc.terminate()
                raise _Cancelled()
            line = line.strip()
            if line.startswith("frame="):
                m = _FRAME_RE.search(line)
                if m:
                    done = int(m.group(1))
                    if progress_cb:
                        progress_cb(done, total_est)
                    if max_frames and done >= max_frames:
                        reached_max = True
                        proc.terminate()
                        break
        proc.wait()
    finally:
        if proc.poll() is None:
            proc.terminate()

    # Si paramos a propósito por max_frames, el código de salida no es 0 y es
    # esperado; no se trata como error.
    if not reached_max and proc.returncode not in (0, None):
        raise FFmpegError(
            f"ffmpeg terminó con error (código {proc.returncode}).\n"
            f"{errdrain.text()}")

    frames = sorted(str(p) for p in out.glob("frame_*.png"))
    if max_frames:
        frames = frames[:max_frames]
    if not frames:
        raise FFmpegError(
            "No se extrajo ningún fotograma. Revisa el rango de tiempo y el "
            "valor de fps."
        )
    return frames


def _fps_arg(fps) -> str:
    """Formatea el fps para ffmpeg admitiendo decimales (p. ej. 0.5)."""
    f = float(fps)
    if f == int(f):
        return str(int(f))
    return repr(f)


class _Cancelled(Exception):
    """Señal interna de cancelación por parte del usuario."""
    pass
