"""Composición de contact sheets a partir de fotogramas extraídos.

El render se hace a alta resolución (DPI configurable) sobre un lienzo del
tamaño de hoja elegido. Los fotogramas se reescalan con remuestreo LANCZOS
(alta calidad) para encajar en cada celda, conservando su relación de aspecto.
En modo normal no se aplica ninguna corrección de color: las imágenes se pegan
tal cual.

Novedades v2:
  * Marcadores de registro (ArUco redundantes) + QR por fotograma, para poder
    imprimir, pintar, escanear y recuperar cada fotograma automáticamente.
  * Modo cianotipia: la hoja se genera como NEGATIVO (invertido, con curva de
    compensación, color de tinta configurable y espejado opcional) listo para
    imprimir en acetato.
  * Selección de hojas a generar ("1, 3-5"), para reimprimir solo algunas.
  * Compensación de escala de impresora (desde un perfil de calibración).
  * Tira de parches de grises opcional para normalizar el escaneo.
  * Exportación de layout.json v2 + copia de los fotogramas originales (para
    hojas de rescate).
"""

from __future__ import annotations

import copy
import math
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from . import cyanotype as cyan
from . import layoutfile, markers, paper

# Posiciones admitidas para el numerador de hoja.
CORNERS = [
    "Inferior derecha",
    "Inferior izquierda",
    "Superior derecha",
    "Superior izquierda",
]

# Orientación de la hoja. "Mejor ajuste" elige automáticamente la orientación
# (vertical u horizontal) que hace los fotogramas más grandes.
ORIENTATIONS = [
    "Mejor ajuste (automático)",
    "Vertical",
    "Horizontal",
]

# Cómo numerar los nombres de los fotogramas cuando se incluye/excluye.
NUMBERING = [
    "Continua (1, 2, 3…)",
    "Original (posición en el video)",
]

# Cómo numerar las HOJAS cuando se incluye/excluye.
PAGE_NUMBERING = [
    "Continua (1, 2, 3…)",
    "Original (según los fotogramas)",
]

# Modos de impresión.
MODES = ["normal", "cianotipia"]

# Valores nominales de la tira de parches de grises (0 = negro, 255 = blanco).
PATCH_LEVELS = [0, 64, 128, 192, 255]

try:
    _RESAMPLE = Image.Resampling.LANCZOS  # Pillow >= 9.1
except AttributeError:  # Pillow antiguo
    _RESAMPLE = Image.LANCZOS


class Settings:
    """Contenedor simple con todas las opciones de un contact sheet."""

    def __init__(self, **kw):
        # Hoja
        self.paper = kw.get("paper", "A4")
        # Orientación: "Vertical", "Horizontal" o "Mejor ajuste (automático)".
        # Se acepta el antiguo `landscape` (bool) por compatibilidad.
        self.orientation = kw.get("orientation")
        if self.orientation is None:
            self.orientation = "Horizontal" if kw.get("landscape") else "Vertical"
        self.dpi = int(kw.get("dpi", 300))
        self.custom_w_mm = float(kw.get("custom_w_mm", 210.0))
        self.custom_h_mm = float(kw.get("custom_h_mm", 297.0))
        self.margin_mm = float(kw.get("margin_mm", 10.0))
        self.gutter_mm = float(kw.get("gutter_mm", 5.0))   # espaciado entre frames
        self.bg_color = kw.get("bg_color", "#FFFFFF")

        # Cuadrícula
        self.cols = int(kw.get("cols", 4))
        self.rows = int(kw.get("rows", 5))

        # Etiquetas (nombres de los frames)
        self.labels_on = bool(kw.get("labels_on", True))
        self.base_name = kw.get("base_name", "abc")
        self.separator = kw.get("separator", "_")
        self.leading_zeros = int(kw.get("leading_zeros", 1))  # nº total de dígitos
        self.start_index = int(kw.get("start_index", 1))
        self.font_path = kw.get("font_path") or None
        self.font_size_pt = float(kw.get("font_size_pt", 9.0))
        self.label_gap_mm = float(kw.get("label_gap_mm", 1.5))  # margen frame<->texto
        self.label_color = kw.get("label_color", "#000000")

        # Numerador de hoja (página)
        self.page_num_on = bool(kw.get("page_num_on", True))
        self.page_num_corner = kw.get("page_num_corner", "Inferior derecha")
        self.page_num_prefix = kw.get("page_num_prefix", "")
        self.page_num_start = int(kw.get("page_num_start", 1))
        self.page_num_zeros = int(kw.get("page_num_zeros", 1))  # ceros a la izq.
        self.page_num_size_pt = float(kw.get("page_num_size_pt", 11.0))
        self.page_num_color = kw.get("page_num_color", "#000000")

        # ── Marcadores de registro (para escanear de vuelta) ─────────────
        self.registration_on = bool(kw.get("registration_on", False))
        self.marker_count = int(kw.get("marker_count", 8))       # 4, 8 o 12
        self.marker_size_mm = float(kw.get("marker_size_mm", 8.0))
        self.marker_margin_mm = float(kw.get("marker_margin_mm", 4.0))
        self.marker_dict = kw.get("marker_dict", markers.DEFAULT_DICT)
        self.qr_on = bool(kw.get("qr_on", True))
        self.qr_size_mm = float(kw.get("qr_size_mm", 10.0))
        self.gray_patch_on = bool(kw.get("gray_patch_on", False))
        self.project_name = kw.get("project_name", "")

        # ── Modo de impresión ────────────────────────────────────────────
        self.mode = kw.get("mode", "normal")  # "normal" | "cianotipia"
        self.cyan_mirror = bool(kw.get("cyan_mirror", True))
        self.cyan_ink = kw.get("cyan_ink", "#000000")
        # LUT de 256 valores (de un perfil de calibración) o None (identidad).
        self.cyan_curve = kw.get("cyan_curve") or None
        # Fondo del negativo: "ahorro" = solo halos entintados alrededor de
        # marcadores/QRs/nombres (gasta MUCHA menos tinta; el fondo de la
        # cianotipia queda azul); "completo" = todo el fondo entintado (el
        # fondo de la cianotipia queda blanco papel).
        self.cyan_bg = kw.get("cyan_bg", "ahorro")
        self.cyan_halo_mm = float(kw.get("cyan_halo_mm", 3.0))
        # Degradado de tinta opcional (perfil ColorBlocker):
        # [[densidad, "#RRGGBB"], ...]. None = color simple (cyan_ink).
        self.cyan_ink_stops = kw.get("cyan_ink_stops") or None

        # ── Compensación de impresora (de un perfil de calibración) ─────
        self.print_scale_x = float(kw.get("print_scale_x", 1.0))
        self.print_scale_y = float(kw.get("print_scale_y", 1.0))

        # ── Salida ───────────────────────────────────────────────────────
        self.out_dir = kw.get("out_dir", "")
        self.out_name = kw.get("out_name", "contact_sheet")
        self.fmt_png = bool(kw.get("fmt_png", True))
        self.fmt_pdf = bool(kw.get("fmt_pdf", True))
        self.fmt_tiff = bool(kw.get("fmt_tiff", False))
        self.export_frames = bool(kw.get("export_frames", False))
        # Qué hojas generar ("" = todas). Ej.: "1, 3-5".
        self.sheets_include = kw.get("sheets_include", "")
        self.sheets_exclude = kw.get("sheets_exclude", "")
        # Guardar copia de los originales junto al layout (hojas de rescate).
        self.keep_originals = bool(kw.get("keep_originals", True))

    # -- Derivados --------------------------------------------------------
    @property
    def per_page(self) -> int:
        return max(1, self.cols * self.rows)

    @property
    def is_cyanotype(self) -> bool:
        return (self.mode or "normal").lower().startswith("cian")

    def format_label(self, num: int) -> str:
        """Aplica nombre base + separador + ceros a la izquierda a un número."""
        num_str = str(num)
        if self.leading_zeros > 1:
            num_str = num_str.zfill(self.leading_zeros)
        if self.base_name:
            return f"{self.base_name}{self.separator}{num_str}"
        return num_str

    def label_for(self, n: int) -> str:
        """Etiqueta continua para el índice global n (0-based)."""
        return self.format_label(self.start_index + n)

    def format_page_label(self, num: int) -> str:
        """Aplica prefijo + ceros a la izquierda a un número de hoja."""
        num_str = str(num)
        if self.page_num_zeros > 1:
            num_str = num_str.zfill(self.page_num_zeros)
        return f"{self.page_num_prefix}{num_str}"

    def page_label_for(self, page_idx: int) -> str:
        """Número de hoja continuo (con prefijo y ceros) para page_idx 0-based."""
        return self.format_page_label(self.page_num_start + page_idx)


def _load_font(path, size_px: int):
    """Carga una fuente TrueType/OpenType; cae a la fuente por defecto si falla."""
    if path:
        try:
            p = str(path)
            if p.lower().endswith(".ttc"):
                return ImageFont.truetype(p, size_px, index=0)
            return ImageFont.truetype(p, size_px)
        except Exception:
            pass
    # Fallback: fuente por defecto de Pillow. En versiones recientes (>=10.1)
    # admite un tamaño, así que la respetamos para que el texto sea legible a
    # alta resolución; en versiones antiguas se usa el bitmap pequeño.
    try:
        return ImageFont.load_default(size=size_px)
    except TypeError:
        try:
            return ImageFont.load_default()
        except Exception:
            return None
    except Exception:
        return None


def _text_size(draw, text, font):
    """Tamaño (w, h) de un texto, compatible con varias versiones de Pillow."""
    if font is None:
        return (len(text) * 6, 11)
    try:
        l, t, r, b = draw.textbbox((0, 0), text, font=font)
        return (r - l, b - t)
    except AttributeError:
        return draw.textsize(text, font=font)


def estimate_pages(num_frames: int, per_page: int) -> int:
    if num_frames <= 0:
        return 0
    return math.ceil(num_frames / max(1, per_page))


def parse_ranges(text, max_n=None):
    """Convierte un texto tipo '1, 3-5, 8' en un conjunto de enteros 1-based.

    Acepta comas o punto y coma como separadores y rangos con guion ('3-5').
    Los tokens inválidos se ignoran. Si max_n se indica, se descartan los
    números fuera de [1, max_n].
    """
    result = set()
    if not text:
        return result
    for tok in str(text).replace(";", ",").split(","):
        tok = tok.strip()
        if not tok:
            continue
        if "-" in tok.lstrip("-"):  # rango (evita confundir un negativo suelto)
            a_str, _, b_str = tok.partition("-")
            try:
                a, b = int(a_str.strip()), int(b_str.strip())
            except ValueError:
                continue
            if a > b:
                a, b = b, a
            for n in range(a, b + 1):
                if n >= 1 and (max_n is None or n <= max_n):
                    result.add(n)
        else:
            try:
                n = int(tok)
            except ValueError:
                continue
            if n >= 1 and (max_n is None or n <= max_n):
                result.add(n)
    return result


def select_indices(n, include_text="", exclude_text=""):
    """Devuelve las posiciones 1-based que sobreviven al incluir/excluir.

    - include vacío  -> todas (salvo las excluidas).
    - include con datos -> solo esas posiciones.
    - exclude -> se quitan (tiene prioridad sobre include).
    """
    inc = parse_ranges(include_text, n)
    exc = parse_ranges(exclude_text, n)
    return [i for i in range(1, n + 1)
            if (not inc or i in inc) and i not in exc]


def select_frames(frame_paths, include_text="", exclude_text=""):
    """Filtra los fotogramas por su posición 1-based (ver select_indices)."""
    idx = select_indices(len(frame_paths), include_text, exclude_text)
    return [frame_paths[i - 1] for i in idx]


def original_page_numbers(positions, per_page, start=1):
    """Número de hoja "original" de cada hoja de salida.

    Dadas las posiciones originales (1-based) de los fotogramas seleccionados y
    cuántos caben por hoja, devuelve para cada hoja el número que tendría en la
    secuencia completa (sin incluir/excluir), basándose en el primer fotograma
    de la hoja. Ej.: con per_page=4, una hoja que empieza en el fotograma 9 es
    la hoja 3 (los fotogramas 1-4 → hoja 1, 5-8 → hoja 2, 9-12 → hoja 3).
    """
    per_page = max(1, int(per_page))
    out = []
    for k in range(0, len(positions), per_page):
        first_pos = positions[k]
        out.append(start + (first_pos - 1) // per_page)
    return out


def sanitize_label(label: str) -> str:
    """Convierte una etiqueta en un nombre de archivo seguro."""
    bad = '<>:"/\\|?*'
    out = "".join(("_" if ch in bad else ch) for ch in str(label))
    return out.strip() or "frame"


# Campos de Settings que se guardan en el layout.json para poder regenerar
# hojas idénticas más tarde (p. ej. hojas de rescate). Se excluyen las rutas
# de salida (dependen de la máquina/sesión).
_SNAPSHOT_FIELDS = [
    "paper", "orientation", "dpi", "custom_w_mm", "custom_h_mm", "margin_mm",
    "gutter_mm", "bg_color", "cols", "rows", "labels_on", "base_name",
    "separator", "leading_zeros", "start_index", "font_path", "font_size_pt",
    "label_gap_mm", "label_color", "page_num_on", "page_num_corner",
    "page_num_prefix", "page_num_start", "page_num_zeros", "page_num_size_pt",
    "page_num_color", "registration_on", "marker_count", "marker_size_mm",
    "marker_margin_mm", "marker_dict", "qr_on", "qr_size_mm", "gray_patch_on",
    "project_name", "mode", "cyan_mirror", "cyan_ink", "cyan_curve",
    "cyan_bg", "cyan_halo_mm", "cyan_ink_stops",
    "print_scale_x", "print_scale_y", "out_name", "fmt_png", "fmt_pdf",
    "fmt_tiff",
]


def settings_snapshot(s: Settings) -> dict:
    """Foto JSON-serializable de los ajustes (para el layout.json)."""
    return {k: getattr(s, k, None) for k in _SNAPSHOT_FIELDS}


def _meta_content_height(s: Settings, label_h: int, dpi: int) -> int:
    """Alto del contenido de la fila de metadatos bajo cada frame
    (etiqueta y/o QR), sin contar el margen frame<->metadatos."""
    h = label_h if s.labels_on else 0
    if s.registration_on and s.qr_on:
        h = max(h, paper.mm_to_px(s.qr_size_mm, dpi))
    return h


def _frame_fit_area(s, landscape, src_w, src_h, meta_h, label_gap,
                    cols=None, rows=None) -> float:
    """Área (en px²) que ocuparía un fotograma de tamaño (src_w, src_h) dentro
    de una celda para la orientación y cuadrícula dadas. Sirve para decidir el
    "mejor ajuste": se comparan las combinaciones y gana la mayor.
    """
    cols = cols or s.cols
    rows = rows or s.rows
    dpi = s.dpi
    page_w, page_h = paper.page_size_px(
        s.paper, dpi, landscape, s.custom_w_mm, s.custom_h_mm
    )
    margin = _effective_margin(s, dpi)
    gutter = paper.mm_to_px(s.gutter_mm, dpi)
    content_w = page_w - 2 * margin
    content_h = page_h - 2 * margin
    if content_w <= 0 or content_h <= 0:
        return -1.0
    cell_w = (content_w - (cols - 1) * gutter) / cols
    cell_h = (content_h - (rows - 1) * gutter) / rows
    meta_area = (meta_h + label_gap) if meta_h > 0 else 0
    img_area_h = cell_h - meta_area
    if cell_w <= 1 or img_area_h <= 1 or src_w <= 0 or src_h <= 0:
        return -1.0
    scale = min(cell_w / src_w, img_area_h / src_h)
    return (src_w * scale) * (src_h * scale)


def _first_frame_aspect(frame_paths):
    """Relación de aspecto (w, h) del primer fotograma legible; 16:9 por defecto."""
    for fp in frame_paths:
        try:
            with Image.open(fp) as im:
                w, h = im.size
            if w > 0 and h > 0:
                return w, h
        except Exception:
            continue
    return 16, 9


def resolve_page_layout(s, frame_paths, meta_h=0, label_gap=0):
    """Decide orientación Y cuadrícula según la opción elegida.

    - "Vertical"   -> (False, cols, rows)
    - "Horizontal" -> (True, cols, rows)
    - "Mejor ajuste" -> prueba las 4 combinaciones (vertical/horizontal ×
      cuadrícula tal cual / columnas↔filas intercambiadas) y devuelve la que
      hace los fotogramas MÁS GRANDES. Intercambiar la cuadrícula mantiene la
      misma cantidad de imágenes por hoja, así que es equivalente a lo que se
      elegiría a mano al rotar la hoja (esto corrige que el "mejor ajuste"
      antiguo produjera áreas impresas menores que la elección manual).
    """
    o = (s.orientation or "").strip().lower()
    if o.startswith("horizontal"):
        return True, s.cols, s.rows
    if o.startswith("vertical"):
        return False, s.cols, s.rows

    src_w, src_h = _first_frame_aspect(frame_paths)
    candidates = [(False, s.cols, s.rows), (True, s.cols, s.rows)]
    if s.cols != s.rows:
        candidates += [(False, s.rows, s.cols), (True, s.rows, s.cols)]
    best, best_area = candidates[0], -1.0
    for landscape, cols, rows in candidates:
        area = _frame_fit_area(s, landscape, src_w, src_h, meta_h, label_gap,
                               cols, rows)
        if area > best_area + 1e-9:
            best, best_area = (landscape, cols, rows), area
    return best


def resolve_landscape(s, frame_paths, meta_h=0, label_gap=0) -> bool:
    """(Compatibilidad) Solo la orientación de resolve_page_layout()."""
    return resolve_page_layout(s, frame_paths, meta_h, label_gap)[0]


def _marker_dims(s: Settings, dpi: int):
    """(lado_px, quiet_px, patch_px) del marcador a la resolución dada."""
    side = max(8, paper.mm_to_px(s.marker_size_mm, dpi))
    quiet = max(2, side // 7)
    return side, quiet, side + 2 * quiet


def _effective_margin(s: Settings, dpi: int) -> int:
    """Margen efectivo: el del usuario, ampliado si hace falta para que quepa
    la banda de marcadores de registro."""
    margin = paper.mm_to_px(s.margin_mm, dpi)
    if s.registration_on:
        _, _, patch = _marker_dims(s, dpi)
        band = paper.mm_to_px(s.marker_margin_mm, dpi) + patch \
            + paper.mm_to_px(2.0, dpi)  # respiro entre marcadores y contenido
        margin = max(margin, band)
    return margin


class _Layout:
    """Geometría calculada de una hoja (tamaño, celdas, fuentes…)."""
    __slots__ = (
        "dpi", "margin", "gutter", "label_gap", "label_font", "label_h",
        "page_font", "landscape", "page_w", "page_h", "cell_w", "cell_h",
        "label_area", "img_area_h", "meta_h", "qr_px", "cols", "rows",
        "marker_side", "marker_quiet", "marker_patch", "marker_margin",
        "marker_positions", "marker_bboxes", "patch_strip", "halo_px",
    )


def _build_layout(s: Settings) -> _Layout:
    """Calcula tamaño de hoja, celdas y fuentes a partir de los ajustes."""
    dpi = s.dpi
    margin = _effective_margin(s, dpi)
    gutter = paper.mm_to_px(s.gutter_mm, dpi)

    # Fuentes (no dependen de la orientación, así que se calculan antes).
    label_font = None
    label_h = 0
    if s.labels_on:
        fpx = paper.pt_to_px(s.font_size_pt, dpi)
        label_font = _load_font(s.font_path, fpx)
        tmp = Image.new("RGB", (10, 10))
        _, label_h = _text_size(ImageDraw.Draw(tmp), "Ay1", label_font)
    page_font = None
    if s.page_num_on:
        ppx = paper.pt_to_px(s.page_num_size_pt, dpi)
        page_font = _load_font(s.font_path, ppx)

    meta_h = _meta_content_height(s, label_h, dpi)
    label_gap = paper.mm_to_px(s.label_gap_mm, dpi) if meta_h > 0 else 0

    # Orientación y cuadrícula: vertical, horizontal o "mejor ajuste" (que
    # puede intercambiar columnas↔filas para agrandar los fotogramas).
    frame_paths = getattr(s, "_frame_paths", None) or []
    landscape, cols, rows = resolve_page_layout(s, frame_paths, meta_h, label_gap)
    page_w, page_h = paper.page_size_px(
        s.paper, dpi, landscape, s.custom_w_mm, s.custom_h_mm
    )

    content_w = page_w - 2 * margin
    content_h = page_h - 2 * margin
    if content_w <= 0 or content_h <= 0:
        raise ValueError("Los márgenes son demasiado grandes para el tamaño de hoja.")

    cell_w = (content_w - (cols - 1) * gutter) / cols
    cell_h = (content_h - (rows - 1) * gutter) / rows
    label_area = (meta_h + label_gap) if meta_h > 0 else 0
    img_area_h = cell_h - label_area
    if cell_w <= 1 or img_area_h <= 1:
        raise ValueError(
            "No hay espacio suficiente para las celdas. Reduce columnas/filas, "
            "los márgenes, el espaciado o sube el tamaño de hoja/DPI."
        )

    L = _Layout()
    L.dpi, L.margin, L.gutter, L.label_gap = dpi, margin, gutter, label_gap
    L.label_font, L.label_h, L.page_font = label_font, label_h, page_font
    L.landscape, L.page_w, L.page_h = landscape, page_w, page_h
    L.cols, L.rows = cols, rows
    L.cell_w, L.cell_h = cell_w, cell_h
    L.label_area, L.img_area_h = label_area, img_area_h
    L.meta_h = meta_h
    L.qr_px = paper.mm_to_px(s.qr_size_mm, dpi) if (s.registration_on and s.qr_on) else 0
    L.halo_px = paper.mm_to_px(max(0.0, s.cyan_halo_mm), dpi)

    # Geometría de los marcadores de registro (igual en todas las hojas).
    if s.registration_on:
        side, quiet, patch = _marker_dims(s, dpi)
        mmargin = paper.mm_to_px(s.marker_margin_mm, dpi)
        L.marker_side, L.marker_quiet, L.marker_patch = side, quiet, patch
        L.marker_margin = mmargin
        L.marker_positions = markers.marker_layout(
            page_w, page_h, s.marker_count, side, mmargin, quiet)
        L.marker_bboxes = markers.marker_bboxes(
            page_w, page_h, s.marker_count, side, mmargin, quiet)
        L.patch_strip = _patch_strip_geometry(s, L) if s.gray_patch_on else None
    else:
        L.marker_side = L.marker_quiet = L.marker_patch = L.marker_margin = 0
        L.marker_positions = L.marker_bboxes = None
        L.patch_strip = None
    return L


def _patch_strip_geometry(s: Settings, L: _Layout):
    """Tira vertical de parches de grises en la banda izquierda, entre el
    marcador TL y el del centro-izquierda (zona siempre libre de marcadores).

    Devuelve una lista [(bbox, nivel), ...] o None si no hay sitio.
    """
    side = L.marker_side
    gap = max(2, side // 8)
    n = len(PATCH_LEVELS)
    total_h = n * side + (n - 1) * gap
    y_free_top = L.marker_margin + L.marker_patch + gap * 2
    y_free_bot = (L.page_h - side) // 2 - gap * 2 if s.marker_count >= 8 \
        else L.page_h - L.marker_margin - L.marker_patch - gap * 2
    if y_free_bot - y_free_top < total_h:
        return None
    x = L.marker_margin + L.marker_quiet
    y0 = y_free_top + ((y_free_bot - y_free_top) - total_h) // 2
    strip = []
    for i, nivel in enumerate(PATCH_LEVELS):
        y = y0 + i * (side + gap)
        strip.append(([x, y, x + side, y + side], nivel))
    return strip


# ────────────────────────────────────────────────────────────────
# Render de una hoja
# ────────────────────────────────────────────────────────────────

def _ink_full_color(s: Settings):
    """Color de la tinta plena (densidad máxima) del negativo."""
    return cyan.solid_density_color(255, s.cyan_ink, s.cyan_ink_stops)


def _cyan_saving(s: Settings) -> bool:
    """True si el negativo usa el modo AHORRO DE TINTA (fondo transparente y
    solo halos entintados alrededor de marcadores/QRs/nombres)."""
    return s.is_cyanotype and (s.cyan_bg or "ahorro").lower().startswith("ahorro")


def _page_bg_color(s: Settings):
    if s.is_cyanotype:
        if _cyan_saving(s):
            # Fondo transparente (sin tinta): la cianotipia queda azul en las
            # zonas muertas y se ahorra muchísima tinta.
            return "#FFFFFF"
        # Fondo = tinta plena: bloquea el UV y la cianotipia queda blanca
        # alrededor de los fotogramas (igual que el papel en modo normal).
        return _ink_full_color(s)
    return s.bg_color


def _label_text_color(s: Settings) -> str:
    if s.is_cyanotype:
        # Texto = densidad 0 (transparente): sale AZUL OSCURO en la copia,
        # sobre el rectángulo entintado (que sale blanco papel).
        return "#FFFFFF"
    return s.label_color


def _page_num_color(s: Settings) -> str:
    if s.is_cyanotype:
        return "#FFFFFF"
    return s.page_num_color


def _halo_rect(draw: ImageDraw.ImageDraw, s: Settings, bbox, halo_px: int):
    """Rectángulo de tinta plena detrás de un elemento (modo ahorro): da al
    marcador/QR/nombre un fondo bloqueador para que en la copia azul quede
    sobre blanco y se distinga del fondo azul."""
    x1, y1, x2, y2 = bbox
    draw.rectangle([x1 - halo_px, y1 - halo_px, x2 + halo_px, y2 + halo_px],
                   fill=_ink_full_color(s))


def _label_text_for(s: Settings, labels, numbers, global_idx: int) -> str:
    """Etiqueta del fotograma global_idx (0-based dentro de la selección)."""
    if labels is not None and global_idx < len(labels):
        return str(labels[global_idx])
    if numbers is not None and global_idx < len(numbers):
        return s.format_label(numbers[global_idx])
    return s.label_for(global_idx)


def _draw_registration_frame(s: Settings, L: _Layout, canvas: Image.Image):
    """Dibuja los marcadores ArUco y la tira de parches (si procede).

    En cianotipia los parches se interpretan como DENSIDAD (negro del marcador
    = transparente → azul en la copia; blanco = tinta plena → papel), lo que
    los deja con polaridad estándar en la copia azul y respeta el color o
    degradado de tinta elegido. En modo ahorro, cada marcador recibe además un
    halo entintado para destacar sobre el fondo azul.
    """
    draw = ImageDraw.Draw(canvas)
    saving = _cyan_saving(s)
    for mid, (px, py) in L.marker_positions.items():
        patch = markers.marker_patch(mid, L.marker_side, L.marker_quiet,
                                     s.marker_dict, inverted=False)
        if s.is_cyanotype:
            if saving:
                _halo_rect(draw, s, [px, py, px + patch.width, py + patch.height],
                           L.halo_px)
            patch = cyan.colorize_gray_patch(patch, s.cyan_ink, s.cyan_ink_stops)
        canvas.paste(patch, (int(px), int(py)))
    if L.patch_strip:
        if saving:
            xs = [b for b, _ in L.patch_strip]
            _halo_rect(draw, s, [min(b[0] for b in xs), min(b[1] for b in xs),
                                 max(b[2] for b in xs), max(b[3] for b in xs)],
                       L.halo_px)
        for bbox, nivel in L.patch_strip:
            if s.is_cyanotype:
                color = cyan.solid_density_color(nivel, s.cyan_ink,
                                                 s.cyan_ink_stops)
            else:
                color = (nivel, nivel, nivel)
            draw.rectangle(bbox, fill=color)


def _render_page(s: Settings, L: _Layout, chunk, page_idx: int,
                 numbers=None, page_numbers=None, labels=None,
                 chunk_paths_meta=None):
    """Dibuja una sola hoja y devuelve (imagen, registro_de_geometría).

    numbers: lista paralela a TODOS los fotogramas con el número a mostrar en
    cada etiqueta (numeración original). Si es None, se usa la numeración
    continua (start_index + posición).
    labels: lista paralela a TODOS los fotogramas con la etiqueta ya formateada
    (tiene prioridad sobre numbers).
    page_numbers: lista con el número de hoja a mostrar en cada página. Si es
    None, se usa la numeración continua de hoja (page_num_start + page_idx).
    chunk_paths_meta: opcional, lista paralela a chunk con dicts extra a copiar
    en el registro de cada frame (p. ej. tamaño original).

    El registro de geometría contiene la posición exacta de cada frame y QR
    (para el layout.json); es None si el registro está desactivado.
    """
    canvas = Image.new("RGB", (L.page_w, L.page_h), _page_bg_color(s))
    draw = ImageDraw.Draw(canvas)
    start = page_idx * s.per_page

    if page_numbers is not None and page_idx < len(page_numbers):
        sheet_num = page_numbers[page_idx]
    else:
        sheet_num = s.page_num_start + page_idx

    record = None
    if s.registration_on:
        _draw_registration_frame(s, L, canvas)
        record = {"numero": int(sheet_num), "frames": {}, "qrs": {}}

    label_color = _label_text_color(s)
    saving = _cyan_saving(s)

    for cell_idx, fpath in enumerate(chunk):
        global_idx = start + cell_idx
        row = cell_idx // L.cols
        col = cell_idx % L.cols
        cell_x = L.margin + col * (L.cell_w + L.gutter)
        cell_y = L.margin + row * (L.cell_h + L.gutter)

        try:
            with Image.open(fpath) as im:
                im = im.convert("RGB") if im.mode not in ("RGB", "L") else im
                src_w, src_h = im.size
                scale = min(L.cell_w / src_w, L.img_area_h / src_h)
                new_w = max(1, int(round(src_w * scale)))
                new_h = max(1, int(round(src_h * scale)))
                resized = im.resize((new_w, new_h), _RESAMPLE)
        except Exception:
            continue

        if s.is_cyanotype:
            resized = cyan.make_negative(resized, s.cyan_curve, s.cyan_ink,
                                         s.cyan_ink_stops)

        # Bloque imagen+metadatos centrado en la celda; los metadatos van
        # pegados bajo la imagen para que se vea ordenado aunque el frame no
        # llene la celda.
        block_h = new_h + L.label_area
        block_top = cell_y + (L.cell_h - block_h) / 2
        px = int(round(cell_x + (L.cell_w - new_w) / 2))
        py = int(round(block_top))
        canvas.paste(resized, (px, py))

        text = _label_text_for(s, labels, numbers, global_idx)

        # Fila de metadatos: [QR] [texto], centrada bajo el frame.
        meta_top = py + new_h + L.label_gap
        qr_bbox = None
        if L.qr_px > 0 and record is not None:
            payload = markers.qr_payload(s.project_name or s.out_name,
                                         sheet_num, cell_idx, text)
            qr_img = markers.qr_image(payload, L.qr_px, inverted=False)
            if s.is_cyanotype:
                qr_img = cyan.colorize_gray_patch(qr_img, s.cyan_ink,
                                                  s.cyan_ink_stops)
            tw = th = 0
            if s.labels_on and L.label_font is not None:
                tw, th = _text_size(draw, text, L.label_font)
            gap_qr_text = max(6, L.qr_px // 8) if tw else 0
            total_w = L.qr_px + gap_qr_text + tw
            qx = int(round(cell_x + (L.cell_w - total_w) / 2))
            qy = int(round(meta_top + (L.meta_h - L.qr_px) / 2))
            if saving:
                # Halo entintado detrás de toda la fila de metadatos.
                _halo_rect(draw, s,
                           [qx, min(qy, int(meta_top)),
                            qx + total_w, max(qy + L.qr_px,
                                              int(meta_top + L.meta_h))],
                           L.halo_px)
            canvas.paste(qr_img, (qx, qy))
            qr_bbox = [qx, qy, qx + L.qr_px, qy + L.qr_px]
            if tw:
                tx = qx + L.qr_px + gap_qr_text
                ty = int(round(meta_top + (L.meta_h - th) / 2))
                draw.text((tx, ty), text, fill=label_color, font=L.label_font)
            record["qrs"][text] = {
                "bbox": qr_bbox, "celda": cell_idx, "texto": payload,
            }
        elif s.labels_on and L.label_font is not None:
            tw, th = _text_size(draw, text, L.label_font)
            tx = int(round(cell_x + (L.cell_w - tw) / 2))
            ty = int(round(meta_top + (L.meta_h - th) / 2))
            if saving:
                _halo_rect(draw, s, [tx, ty, tx + tw, ty + th], L.halo_px)
            draw.text((tx, ty), text, fill=label_color, font=L.label_font)

        if record is not None:
            meta = {"bbox": [px, py, px + new_w, py + new_h],
                    "celda": cell_idx,
                    "archivo_original": Path(fpath).name,
                    "orig_px": [src_w, src_h]}
            if chunk_paths_meta and cell_idx < len(chunk_paths_meta):
                meta.update(chunk_paths_meta[cell_idx] or {})
            record["frames"][text] = meta

    # Numerador de hoja en la esquina (con prefijo y ceros a la izquierda).
    if s.page_num_on and L.page_font is not None:
        pno = s.format_page_label(sheet_num)
        tw, th = _text_size(draw, pno, L.page_font)
        pad = max(L.margin // 3, paper.mm_to_px(3, L.dpi))
        corner = s.page_num_corner
        if corner == "Inferior derecha":
            pos = (L.page_w - pad - tw, L.page_h - pad - th)
        elif corner == "Inferior izquierda":
            pos = (pad, L.page_h - pad - th)
        elif corner == "Superior derecha":
            pos = (L.page_w - pad - tw, pad)
        else:  # Superior izquierda
            pos = (pad, pad)
        if saving:
            _halo_rect(draw, s, [pos[0], pos[1], pos[0] + tw, pos[1] + th],
                       max(4, L.halo_px // 2))
        draw.text(pos, pno, fill=_page_num_color(s), font=L.page_font)

    return canvas, record


# ────────────────────────────────────────────────────────────────
# Compensación de impresora y espejado
# ────────────────────────────────────────────────────────────────

def _needs_print_scale(s: Settings) -> bool:
    return abs(s.print_scale_x - 1.0) > 1e-4 or abs(s.print_scale_y - 1.0) > 1e-4


def _apply_print_scale_img(canvas: Image.Image, s: Settings) -> Image.Image:
    """Pre-escala el contenido alrededor del centro de la hoja para compensar
    el encogimiento/estiramiento medido de la impresora. Si la impresora
    imprime al 97 % (scale=0.97), el contenido se agranda 1/0.97 para que el
    resultado físico tenga las medidas nominales."""
    if not _needs_print_scale(s):
        return canvas
    sx, sy = s.print_scale_x, s.print_scale_y
    w, h = canvas.size
    cx, cy = w / 2.0, h / 2.0
    matrix = (sx, 0.0, cx * (1.0 - sx), 0.0, sy, cy * (1.0 - sy))
    return canvas.transform((w, h), Image.AFFINE, matrix,
                            resample=Image.BICUBIC,
                            fillcolor=_page_bg_color(s))


def _scale_point(x, y, s: Settings, page_w, page_h):
    cx, cy = page_w / 2.0, page_h / 2.0
    return (cx + (x - cx) / s.print_scale_x,
            cy + (y - cy) / s.print_scale_y)


def _scale_bbox(bbox, s: Settings, page_w, page_h):
    if not _needs_print_scale(s):
        return [int(round(v)) for v in bbox]
    x1, y1 = _scale_point(bbox[0], bbox[1], s, page_w, page_h)
    x2, y2 = _scale_point(bbox[2], bbox[3], s, page_w, page_h)
    return [int(round(x1)), int(round(y1)), int(round(x2)), int(round(y2))]


# ────────────────────────────────────────────────────────────────
# Vista previa y generación
# ────────────────────────────────────────────────────────────────

def render_preview(settings: Settings, frame_paths, page_idx: int = 0,
                   numbers=None, page_numbers=None, labels=None,
                   max_dpi: int = 150, simulate_cyanotype: bool = False):
    """Genera (en memoria) UNA hoja de muestra para previsualizar.

    Usa un DPI reducido (proporcional, así que es representativo) para que sea
    rápido. Devuelve (imagen_PIL, num_paginas_totales).

    simulate_cyanotype: si la hoja es un negativo de cianotipia, devuelve una
    simulación aproximada de cómo se vería la copia azul final (solo preview).
    """
    s = copy.copy(settings)
    s.dpi = min(int(settings.dpi), int(max_dpi))
    s._frame_paths = frame_paths  # para que resolve_landscape use estos frames
    L = _build_layout(s)
    per_page = s.per_page
    num_pages = estimate_pages(len(frame_paths), per_page)
    page_idx = max(0, min(page_idx, max(0, num_pages - 1)))
    chunk = frame_paths[page_idx * per_page: page_idx * per_page + per_page]
    img, _ = _render_page(s, L, chunk, page_idx, numbers=numbers,
                          page_numbers=page_numbers, labels=labels)
    img = _apply_print_scale_img(img, s)
    if s.is_cyanotype:
        if simulate_cyanotype:
            img = cyan.simulate_print(img)
        elif s.cyan_mirror:
            img = cyan.mirror(img)
    return img, num_pages


def generate(settings: Settings, frame_paths, numbers=None, page_numbers=None,
             labels=None, timeline=None, video_meta=None,
             progress_cb=None, cancel_check=None):
    """Construye y guarda los contact sheets.

    numbers: lista paralela a frame_paths con el número a usar en cada etiqueta
    (numeración original). Si es None, se numera de forma continua.
    labels: lista paralela a frame_paths con las etiquetas YA formateadas
    (tiene prioridad sobre numbers; necesaria para nombres de archivo
    originales y deduplicación).
    page_numbers: lista con el número de cada hoja (numeración original de hoja).
    Si es None, se numera de forma continua (page_num_start + posición). Afecta
    al numerador impreso y al nombre de archivo de cada hoja.
    timeline: lista de dicts {"pos", "etiqueta", "rep"} (línea de tiempo
    completa del video, con duplicados) que se guarda en el layout.json.
    video_meta: dict con metadatos del video (fps de extracción, origen…).

    Devuelve un dict con las rutas generadas: {'pages': [...], 'pdf': str|None,
    'frames_dir': str|None, 'layout': str|None, ...}.
    """
    s = settings
    s._frame_paths = frame_paths  # para resolve_landscape ("mejor ajuste")
    L = _build_layout(s)
    dpi = L.dpi

    out_dir = Path(s.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    per_page = s.per_page
    num_pages = estimate_pages(len(frame_paths), per_page)

    def _label_of(gidx):
        return _label_text_for(s, labels, numbers, gidx)

    # Exportar fotogramas individuales a máxima calidad (opcional).
    frames_dir = None
    if s.export_frames:
        frames_dir = out_dir / f"{s.out_name}_frames"
        frames_dir.mkdir(parents=True, exist_ok=True)
        for gidx, fpath in enumerate(frame_paths):
            try:
                shutil.copyfile(
                    fpath,
                    frames_dir / f"{sanitize_label(_label_of(gidx))}.png")
            except Exception:
                pass

    # Copia de los ORIGINALES para poder regenerar hojas (rescate) aunque los
    # fotogramas extraídos del video vivieran en una carpeta temporal.
    originals_dir = None
    originals_map = {}
    if s.registration_on and s.keep_originals:
        originals_dir = out_dir / f"{s.out_name}_originales"
        originals_dir.mkdir(parents=True, exist_ok=True)
        for gidx, fpath in enumerate(frame_paths):
            label = sanitize_label(_label_of(gidx))
            ext = Path(fpath).suffix or ".png"
            dest = originals_dir / f"{label}{ext}"
            try:
                shutil.copyfile(fpath, dest)
                originals_map[gidx] = f"{originals_dir.name}/{dest.name}"
            except Exception:
                pass

    def _pnum(k):
        if page_numbers is not None and k < len(page_numbers):
            return page_numbers[k]
        return s.page_num_start + k

    # Qué hojas generar (por posición de hoja 1-based en esta tanda).
    pages_selected = set(select_indices(num_pages, s.sheets_include,
                                        s.sheets_exclude))

    # Ceros en el nombre de archivo: respeta page_num_zeros pero garantiza que
    # las hojas se ordenen bien aunque los números sean grandes (orden original).
    max_pnum = max([_pnum(k) for k in range(num_pages)] + [1])
    file_digits = max(s.page_num_zeros, len(str(max(1, max_pnum))))
    page_paths = []
    page_images_for_pdf = []
    sheet_records = []
    ext_hoja = ".tif" if s.fmt_tiff else ".png"

    total_selected = max(1, len(pages_selected))
    done_count = 0

    for page_idx in range(num_pages):
        if cancel_check and cancel_check():
            raise _Cancelled()

        chunk = frame_paths[page_idx * per_page: page_idx * per_page + per_page]
        selected = (page_idx + 1) in pages_selected
        page_base = f"{s.out_name}_p{str(_pnum(page_idx)).zfill(file_digits)}"

        # La geometría se registra SIEMPRE (el layout.json describe todas las
        # hojas); el render caro solo se hace para las hojas seleccionadas.
        chunk_meta = []
        for cell_idx in range(len(chunk)):
            gidx = page_idx * per_page + cell_idx
            extra = {}
            if gidx in originals_map:
                extra["archivo_original"] = originals_map[gidx]
            chunk_meta.append(extra)

        if selected:
            canvas, record = _render_page(
                s, L, chunk, page_idx, numbers=numbers,
                page_numbers=page_numbers, labels=labels,
                chunk_paths_meta=chunk_meta)
            canvas = _apply_print_scale_img(canvas, s)
            if s.is_cyanotype and s.cyan_mirror:
                canvas = cyan.mirror(canvas)

            if s.fmt_png:
                ppath = out_dir / f"{page_base}.png"
                canvas.save(ppath, "PNG", dpi=(dpi, dpi), compress_level=6)
                page_paths.append(str(ppath))
            if s.fmt_tiff:
                tpath = out_dir / f"{page_base}.tif"
                canvas.save(tpath, "TIFF", dpi=(dpi, dpi), compression="tiff_lzw")
                page_paths.append(str(tpath))
            if s.fmt_pdf:
                page_images_for_pdf.append(canvas)
            done_count += 1
            if progress_cb:
                progress_cb(done_count, total_selected)
        else:
            # Solo geometría (sin renderizar la imagen completa).
            _, record = _render_geometry_only(
                s, L, chunk, page_idx, numbers=numbers,
                page_numbers=page_numbers, labels=labels,
                chunk_paths_meta=chunk_meta)

        if record is not None:
            record["archivo_hoja"] = f"{page_base}{ext_hoja}" if s.fmt_tiff or s.fmt_png else f"{page_base}.png"
            record["generada"] = bool(selected)
            # Compensación de impresora: las coordenadas del layout describen
            # los píxeles REALES del archivo generado.
            if _needs_print_scale(s):
                for fr in record["frames"].values():
                    fr["bbox"] = _scale_bbox(fr["bbox"], s, L.page_w, L.page_h)
                for qr in record["qrs"].values():
                    qr["bbox"] = _scale_bbox(qr["bbox"], s, L.page_w, L.page_h)
            sheet_records.append(record)

    # PDF combinado (todas las páginas en un solo archivo, listo para imprimir).
    pdf_path = None
    if s.fmt_pdf and page_images_for_pdf:
        pdf_path = str(out_dir / f"{s.out_name}.pdf")
        first, rest = page_images_for_pdf[0], page_images_for_pdf[1:]
        first.save(
            pdf_path, "PDF", save_all=True, append_images=rest,
            resolution=float(dpi),
        )

    # layout.json v2 (solo si hay marcadores de registro).
    layout_path = None
    if s.registration_on and sheet_records:
        marker_bboxes = {
            str(mid): _scale_bbox(bbox, s, L.page_w, L.page_h)
            for mid, bbox in L.marker_bboxes.items()
        }
        patch_info = None
        if L.patch_strip:
            patch_info = {
                "bboxes": [_scale_bbox(b, s, L.page_w, L.page_h)
                           for b, _ in L.patch_strip],
                "niveles": [n for _, n in L.patch_strip],
            }
        layout_data = {
            "version": 2,
            "app": "kamiru-studio",
            "proyecto": s.project_name or s.out_name,
            "modo": "cianotipia" if s.is_cyanotype else "normal",
            "fondo_cianotipia": (s.cyan_bg if s.is_cyanotype else None),
            "espejado": bool(s.is_cyanotype and s.cyan_mirror),
            "lienzo": {
                "ancho_px": L.page_w,
                "alto_px": L.page_h,
                "dpi": dpi,
                "orientacion": "landscape" if L.landscape else "portrait",
            },
            "marcadores": {
                "dict": s.marker_dict,
                "cantidad": int(s.marker_count),
                "lado_px": L.marker_side,
                "bboxes": marker_bboxes,
            },
            "parche_grises": patch_info,
            "hojas": sheet_records,
            "timeline": timeline or [],
            "video": video_meta or {},
            "originales_dir": originals_dir.name if originals_dir else None,
            "ajustes": settings_snapshot(s),
        }
        layout_path = str(out_dir / f"{s.out_name}_layout.json")
        layoutfile.save(layout_data, layout_path)

    return {
        "pages": page_paths,
        "pdf": pdf_path,
        "frames_dir": str(frames_dir) if frames_dir else None,
        "originals_dir": str(originals_dir) if originals_dir else None,
        "layout": layout_path,
        "num_pages": num_pages,
        "num_generated": done_count,
        "landscape": L.landscape,
        "orientation": "Horizontal" if L.landscape else "Vertical",
        "grid": f"{L.cols}×{L.rows}",
        "grid_swapped": (L.cols, L.rows) != (s.cols, s.rows),
    }


def _render_geometry_only(s: Settings, L: _Layout, chunk, page_idx,
                          numbers=None, page_numbers=None, labels=None,
                          chunk_paths_meta=None):
    """Calcula el registro de geometría de una hoja SIN renderizar la imagen.

    Replica los cálculos de _render_page (posición de frames y QRs) leyendo
    solo el tamaño de cada imagen. Mantener en sincronía con _render_page.
    """
    start = page_idx * s.per_page
    if page_numbers is not None and page_idx < len(page_numbers):
        sheet_num = page_numbers[page_idx]
    else:
        sheet_num = s.page_num_start + page_idx

    if not s.registration_on:
        return None, None

    record = {"numero": int(sheet_num), "frames": {}, "qrs": {}}
    tmp = Image.new("RGB", (10, 10))
    draw = ImageDraw.Draw(tmp)

    for cell_idx, fpath in enumerate(chunk):
        global_idx = start + cell_idx
        row = cell_idx // L.cols
        col = cell_idx % L.cols
        cell_x = L.margin + col * (L.cell_w + L.gutter)
        cell_y = L.margin + row * (L.cell_h + L.gutter)
        try:
            with Image.open(fpath) as im:
                src_w, src_h = im.size
        except Exception:
            continue
        scale = min(L.cell_w / src_w, L.img_area_h / src_h)
        new_w = max(1, int(round(src_w * scale)))
        new_h = max(1, int(round(src_h * scale)))
        block_h = new_h + L.label_area
        block_top = cell_y + (L.cell_h - block_h) / 2
        px = int(round(cell_x + (L.cell_w - new_w) / 2))
        py = int(round(block_top))

        text = _label_text_for(s, labels, numbers, global_idx)
        meta_top = py + new_h + L.label_gap
        if L.qr_px > 0:
            payload = markers.qr_payload(s.project_name or s.out_name,
                                         sheet_num, cell_idx, text)
            tw = th = 0
            if s.labels_on and L.label_font is not None:
                tw, th = _text_size(draw, text, L.label_font)
            gap_qr_text = max(6, L.qr_px // 8) if tw else 0
            total_w = L.qr_px + gap_qr_text + tw
            qx = int(round(cell_x + (L.cell_w - total_w) / 2))
            qy = int(round(meta_top + (L.meta_h - L.qr_px) / 2))
            record["qrs"][text] = {
                "bbox": [qx, qy, qx + L.qr_px, qy + L.qr_px],
                "celda": cell_idx, "texto": payload,
            }
        meta = {"bbox": [px, py, px + new_w, py + new_h],
                "celda": cell_idx,
                "archivo_original": Path(fpath).name,
                "orig_px": [src_w, src_h]}
        if chunk_paths_meta and cell_idx < len(chunk_paths_meta):
            meta.update(chunk_paths_meta[cell_idx] or {})
        record["frames"][text] = meta

    return None, record


class _Cancelled(Exception):
    pass
