"""Reconstrucción del video final a partir de los fotogramas procesados.

Cierra el círculo: video → hojas impresas → pintura/cianotipia → escaneo →
fotogramas procesados → VIDEO FINAL. Usa la línea de tiempo del layout.json
para respetar el orden original e incluso reutilizar los fotogramas
deduplicados (un dibujo pintado una vez aparece en todas sus posiciones).
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from .ffmpeg_utils import FFmpegError, _no_window_kwargs, find_ffmpeg

# Códecs de salida ofrecidos en la interfaz.
CODECS = [
    "MP4 (H.264, compatible con todo)",
    "MP4 (H.264 4:4:4, máxima calidad)",
    "MOV (ProRes 422 HQ, para editar)",
]


def _codec_args(codec_label: str):
    c = (codec_label or "").lower()
    if "prores" in c:
        return ["-c:v", "prores_ks", "-profile:v", "3",
                "-pix_fmt", "yuv422p10le"], ".mov"
    if "4:4:4" in c or "444" in c:
        return ["-c:v", "libx264", "-preset", "slow", "-crf", "10",
                "-pix_fmt", "yuv444p"], ".mp4"
    return ["-c:v", "libx264", "-preset", "slow", "-crf", "14",
            "-pix_fmt", "yuv420p"], ".mp4"


def frames_from_timeline(layout: dict, processed_dir) -> tuple[list[str], list[str]]:
    """Resuelve la secuencia de archivos según la línea de tiempo del layout.

    Para cada posición del video busca el fotograma procesado de su
    REPRESENTANTE (deduplicación). Devuelve (archivos_en_orden, faltantes).
    """
    from .core import sanitize_label

    processed_dir = Path(processed_dir)
    disponibles = {}
    for p in processed_dir.iterdir() if processed_dir.is_dir() else []:
        if p.is_file() and p.suffix.lower() in {".tif", ".tiff", ".png", ".jpg", ".jpeg"}:
            disponibles[p.stem] = str(p)

    timeline = layout.get("timeline") or []
    if not timeline:
        # Sin línea de tiempo: usar todas las etiquetas del layout en orden.
        timeline = []
        pos = 1
        for hoja in layout.get("hojas", []):
            for etiqueta in hoja.get("frames", {}):
                timeline.append({"pos": pos, "etiqueta": etiqueta,
                                 "rep": etiqueta})
                pos += 1

    files, missing = [], []
    for item in sorted(timeline, key=lambda x: x.get("pos", 0)):
        rep = sanitize_label(item.get("rep") or item.get("etiqueta") or "")
        candidates = [rep, f"{rep}_procesado"]
        found = None
        for c in candidates:
            if c in disponibles:
                found = disponibles[c]
                break
        if found:
            files.append(found)
        else:
            missing.append(item.get("etiqueta") or rep)
    return files, sorted(set(missing))


def build_video(files_in_order, fps: float, out_path,
                codec_label: str = CODECS[0], progress_cb=None,
                cancel_check=None) -> str:
    """Construye el video con ffmpeg a partir de una lista ordenada de
    imágenes (admite archivos repetidos gracias al demuxer concat)."""
    if not files_in_order:
        raise ValueError("No hay fotogramas para armar el video.")
    fps = float(fps)
    if fps <= 0:
        raise ValueError("El valor de fps debe ser mayor que 0.")

    ff = find_ffmpeg()
    codec_args, ext = _codec_args(codec_label)
    out_path = Path(out_path)
    if out_path.suffix.lower() not in (".mp4", ".mov", ".mkv"):
        out_path = out_path.with_suffix(ext)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Lista para el demuxer concat (soporta duplicados y rutas Unicode).
    dur = 1.0 / fps
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False,
                                     encoding="utf-8") as f:
        list_path = f.name
        for p in files_in_order:
            escaped = str(Path(p).resolve()).replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")
            f.write(f"duration {dur:.6f}\n")
        # El demuxer concat necesita el último archivo repetido sin duration.
        escaped = str(Path(files_in_order[-1]).resolve()).replace("'", "'\\''")
        f.write(f"file '{escaped}'\n")

    # Dimensiones pares (requisito de yuv420/x264); los recortes escaneados
    # pueden variar 1 px entre sí, así que se normaliza al primer fotograma.
    vf = "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos"

    cmd = [ff, "-hide_banner", "-nostdin", "-y",
           "-f", "concat", "-safe", "0", "-i", list_path,
           "-vf", vf, "-r", f"{fps:g}", "-fps_mode", "cfr",
           *codec_args,
           "-progress", "pipe:1", "-nostats",
           str(out_path)]

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, universal_newlines=True,
                            bufsize=1, **_no_window_kwargs())
    total = len(files_in_order)
    try:
        for line in proc.stdout:
            if cancel_check and cancel_check():
                proc.terminate()
                raise _Cancelled()
            line = line.strip()
            if line.startswith("frame=") and progress_cb:
                try:
                    progress_cb(int(line.split("=", 1)[1]), total)
                except ValueError:
                    pass
        proc.wait()
    finally:
        if proc.poll() is None:
            proc.terminate()
        try:
            Path(list_path).unlink()
        except OSError:
            pass

    if proc.returncode not in (0, None):
        err = ""
        try:
            err = (proc.stderr.read() or "")[-1500:]
        except Exception:
            pass
        # fps_mode es de ffmpeg >= 5; los binarios viejos usan -vsync.
        if "fps_mode" in err or "Unrecognized option" in err:
            raise FFmpegError(
                "Tu ffmpeg es antiguo y no reconoce alguna opción. Actualiza "
                f"las dependencias (pip install -U imageio-ffmpeg).\n{err}")
        raise FFmpegError(f"ffmpeg terminó con error (código {proc.returncode}).\n{err}")

    return str(out_path)


class _Cancelled(Exception):
    pass
