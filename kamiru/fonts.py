"""Descubrimiento de fuentes del sistema, multiplataforma.

Pillow necesita la RUTA a un archivo de fuente (.ttf/.otf/.ttc), no solo el
nombre de la familia. Aquí escaneamos las carpetas de fuentes típicas de cada
sistema operativo y construimos un diccionario {nombre visible: ruta}.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Extensiones de fuente que Pillow puede abrir con ImageFont.truetype.
_FONT_EXTS = {".ttf", ".otf", ".ttc"}


def _candidate_dirs():
    dirs = []
    home = Path.home()
    if sys.platform == "darwin":  # macOS
        dirs += [
            Path("/System/Library/Fonts"),
            Path("/System/Library/Fonts/Supplemental"),
            Path("/Library/Fonts"),
            home / "Library" / "Fonts",
        ]
    elif sys.platform.startswith("win"):  # Windows
        windir = os.environ.get("WINDIR", r"C:\Windows")
        dirs += [
            Path(windir) / "Fonts",
            home / "AppData" / "Local" / "Microsoft" / "Windows" / "Fonts",
        ]
    else:  # Linux y otros Unix
        dirs += [
            Path("/usr/share/fonts"),
            Path("/usr/local/share/fonts"),
            home / ".fonts",
            home / ".local" / "share" / "fonts",
        ]
    return [d for d in dirs if d.exists()]


def _nice_name(path: Path) -> str:
    """Nombre legible a partir del archivo, p. ej. 'DejaVuSans-Bold' -> 'DejaVu Sans Bold'."""
    stem = path.stem
    # Separa CamelCase y guiones/underscores en palabras.
    out = []
    prev_lower = False
    for ch in stem.replace("_", "-").replace("-", " "):
        if ch.isupper() and prev_lower:
            out.append(" ")
        out.append(ch)
        prev_lower = ch.islower()
    name = "".join(out)
    return " ".join(name.split())


# Caché del escaneo de fuentes: recorrer /usr/share/fonts (o C:\Windows\Fonts)
# tarda cientos de milisegundos y varias partes de la app lo piden (interfaz,
# hojas de calibración, diagramas de las guías). Se devuelve una COPIA porque
# la interfaz añade al dict las fuentes que la usuaria elige por archivo.
_DISCOVER_CACHE: dict = {}


def discover_fonts():
    """Devuelve un dict ordenado {nombre visible: ruta_str} de fuentes disponibles."""
    if _DISCOVER_CACHE:
        return dict(_DISCOVER_CACHE)
    found = {}
    for d in _candidate_dirs():
        try:
            for path in d.rglob("*"):
                if path.suffix.lower() in _FONT_EXTS and path.is_file():
                    name = _nice_name(path)
                    # Evita duplicados de nombre, prefiere la primera ruta encontrada.
                    if name not in found:
                        found[name] = str(path)
        except (PermissionError, OSError):
            continue
    ordenadas = dict(sorted(found.items(), key=lambda kv: kv[0].lower()))
    _DISCOVER_CACHE.update(ordenadas)
    return dict(ordenadas)


# Familias preferidas como valor por defecto (la primera que exista, gana).
_PREFERRED = [
    "Helvetica", "Arial", "Helvetica Neue", "DejaVu Sans", "Verdana",
    "Segoe UI", "Roboto", "Liberation Sans", "Noto Sans", "Tahoma",
]


def default_font(fonts: dict):
    """Elige una fuente por defecto razonable de entre las descubiertas.

    Devuelve (nombre_visible, ruta) o (None, None) si no se encontró ninguna.
    """
    if not fonts:
        return None, None
    lowered = {k.lower(): (k, v) for k, v in fonts.items()}
    for pref in _PREFERRED:
        # Coincidencia exacta primero.
        if pref.lower() in lowered:
            return lowered[pref.lower()]
    for pref in _PREFERRED:
        # Coincidencia parcial (p. ej. 'Arial' dentro de 'Arial Unicode').
        for low, (name, path) in lowered.items():
            if pref.lower() in low:
                return name, path
    # Último recurso: la primera alfabéticamente.
    first = next(iter(fonts.items()))
    return first[0], first[1]


_UI_FONT: list = []


def ui_font_path():
    """Ruta de la fuente para los textos que la app DIBUJA (hojas de
    calibración, diagramas de las guías, gráficos de resultados).

    La fuente por defecto de Pillow es un bitmap ASCII: sin esto, cualquier
    acento o flecha («Tamaños», «0 → 255») sale como un cuadrado vacío.
    Devuelve None si no se encontró ninguna fuente del sistema.
    """
    if not _UI_FONT:
        try:
            _, path = default_font(discover_fonts())
        except Exception:
            path = None
        _UI_FONT.append(path)
    return _UI_FONT[0]
