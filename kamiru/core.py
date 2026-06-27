"""Composición de contact sheets a partir de fotogramas extraídos.

El render se hace a alta resolución (DPI configurable) sobre un lienzo del
tamaño de hoja elegido. Los fotogramas se reescalan con remuestreo LANCZOS
(alta calidad) para encajar en cada celda, conservando su relación de aspecto.
No se aplica ninguna corrección de color: las imágenes se pegan tal cual.
"""

from __future__ import annotations

import copy
import math
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from . import paper

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

        # Salida
        self.out_dir = kw.get("out_dir", "")
        self.out_name = kw.get("out_name", "contact_sheet")
        self.fmt_png = bool(kw.get("fmt_png", True))
        self.fmt_pdf = bool(kw.get("fmt_pdf", True))
        self.fmt_tiff = bool(kw.get("fmt_tiff", False))
        self.export_frames = bool(kw.get("export_frames", False))

    # -- Derivados --------------------------------------------------------
    @property
    def per_page(self) -> int:
        return max(1, self.cols * self.rows)

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

    def page_label_for(self, page_idx: int) -> str:
        """Número de hoja (con prefijo y ceros a la izquierda) para page_idx 0-based."""
        num = self.page_num_start + page_idx
        num_str = str(num)
        if self.page_num_zeros > 1:
            num_str = num_str.zfill(self.page_num_zeros)
        return f"{self.page_num_prefix}{num_str}"


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


def _frame_fit_area(s, landscape, src_w, src_h, label_h, label_gap) -> float:
    """Área (en px²) que ocuparía un fotograma de tamaño (src_w, src_h) dentro
    de una celda para la orientación dada. Sirve para decidir el "mejor ajuste":
    se compara esta área en vertical y en horizontal y gana la mayor.
    """
    dpi = s.dpi
    page_w, page_h = paper.page_size_px(
        s.paper, dpi, landscape, s.custom_w_mm, s.custom_h_mm
    )
    margin = paper.mm_to_px(s.margin_mm, dpi)
    gutter = paper.mm_to_px(s.gutter_mm, dpi)
    content_w = page_w - 2 * margin
    content_h = page_h - 2 * margin
    if content_w <= 0 or content_h <= 0:
        return -1.0
    cell_w = (content_w - (s.cols - 1) * gutter) / s.cols
    cell_h = (content_h - (s.rows - 1) * gutter) / s.rows
    label_area = (label_h + label_gap) if s.labels_on else 0
    img_area_h = cell_h - label_area
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


def resolve_landscape(s, frame_paths, label_h=0, label_gap=0) -> bool:
    """Decide si la hoja va en horizontal según la orientación elegida.

    - "Vertical"  -> False
    - "Horizontal" -> True
    - "Mejor ajuste" -> la orientación que maximiza el área impresa de los
      fotogramas (usa la relación de aspecto del primer fotograma).
    """
    o = (s.orientation or "").strip().lower()
    if o.startswith("horizontal"):
        return True
    if o.startswith("vertical"):
        return False
    src_w, src_h = _first_frame_aspect(frame_paths)
    area_portrait = _frame_fit_area(s, False, src_w, src_h, label_h, label_gap)
    area_landscape = _frame_fit_area(s, True, src_w, src_h, label_h, label_gap)
    return area_landscape > area_portrait


class _Layout:
    """Geometría calculada de una hoja (tamaño, celdas, fuentes…)."""
    __slots__ = (
        "dpi", "margin", "gutter", "label_gap", "label_font", "label_h",
        "page_font", "landscape", "page_w", "page_h", "cell_w", "cell_h",
        "label_area", "img_area_h",
    )


def _build_layout(s: Settings) -> _Layout:
    """Calcula tamaño de hoja, celdas y fuentes a partir de los ajustes."""
    dpi = s.dpi
    margin = paper.mm_to_px(s.margin_mm, dpi)
    gutter = paper.mm_to_px(s.gutter_mm, dpi)
    label_gap = paper.mm_to_px(s.label_gap_mm, dpi) if s.labels_on else 0

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

    # Orientación: vertical, horizontal o "mejor ajuste".
    frame_paths = getattr(s, "_frame_paths", None) or []
    landscape = resolve_landscape(s, frame_paths, label_h, label_gap)
    page_w, page_h = paper.page_size_px(
        s.paper, dpi, landscape, s.custom_w_mm, s.custom_h_mm
    )

    content_w = page_w - 2 * margin
    content_h = page_h - 2 * margin
    if content_w <= 0 or content_h <= 0:
        raise ValueError("Los márgenes son demasiado grandes para el tamaño de hoja.")

    cell_w = (content_w - (s.cols - 1) * gutter) / s.cols
    cell_h = (content_h - (s.rows - 1) * gutter) / s.rows
    label_area = (label_h + label_gap) if s.labels_on else 0
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
    L.cell_w, L.cell_h = cell_w, cell_h
    L.label_area, L.img_area_h = label_area, img_area_h
    return L


def _render_page(s: Settings, L: _Layout, chunk, page_idx: int,
                 numbers=None) -> "Image.Image":
    """Dibuja una sola hoja y devuelve la imagen (no la guarda en disco).

    numbers: lista paralela a TODOS los fotogramas con el número a mostrar en
    cada etiqueta (numeración original). Si es None, se usa la numeración
    continua (start_index + posición).
    """
    canvas = Image.new("RGB", (L.page_w, L.page_h), s.bg_color)
    draw = ImageDraw.Draw(canvas)
    start = page_idx * s.per_page

    for cell_idx, fpath in enumerate(chunk):
        global_idx = start + cell_idx
        row = cell_idx // s.cols
        col = cell_idx % s.cols
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

        # Bloque imagen+etiqueta centrado en la celda; etiqueta pegada bajo la
        # imagen para que se vea ordenado aunque el frame no llene la celda.
        block_h = new_h + (L.label_area if s.labels_on else 0)
        block_top = cell_y + (L.cell_h - block_h) / 2
        px = int(round(cell_x + (L.cell_w - new_w) / 2))
        py = int(round(block_top))
        canvas.paste(resized, (px, py))

        if s.labels_on and L.label_font is not None:
            if numbers is not None and global_idx < len(numbers):
                text = s.format_label(numbers[global_idx])
            else:
                text = s.label_for(global_idx)
            tw, th = _text_size(draw, text, L.label_font)
            tx = int(round(cell_x + (L.cell_w - tw) / 2))
            ty = int(round(py + new_h + L.label_gap))
            draw.text((tx, ty), text, fill=s.label_color, font=L.label_font)

    # Numerador de hoja en la esquina (con prefijo y ceros a la izquierda).
    if s.page_num_on and L.page_font is not None:
        pno = s.page_label_for(page_idx)
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
        draw.text(pos, pno, fill=s.page_num_color, font=L.page_font)

    return canvas


def render_preview(settings: Settings, frame_paths, page_idx: int = 0,
                   numbers=None, max_dpi: int = 150):
    """Genera (en memoria) UNA hoja de muestra para previsualizar.

    Usa un DPI reducido (proporcional, así que es representativo) para que sea
    rápido. Devuelve (imagen_PIL, num_paginas_totales).
    """
    s = copy.copy(settings)
    s.dpi = min(int(settings.dpi), int(max_dpi))
    s._frame_paths = frame_paths  # para que resolve_landscape use estos frames
    L = _build_layout(s)
    per_page = s.per_page
    num_pages = estimate_pages(len(frame_paths), per_page)
    page_idx = max(0, min(page_idx, max(0, num_pages - 1)))
    chunk = frame_paths[page_idx * per_page: page_idx * per_page + per_page]
    return _render_page(s, L, chunk, page_idx, numbers=numbers), num_pages


def generate(settings: Settings, frame_paths, numbers=None,
             progress_cb=None, cancel_check=None):
    """Construye y guarda los contact sheets.

    numbers: lista paralela a frame_paths con el número a usar en cada etiqueta
    (numeración original). Si es None, se numera de forma continua.

    Devuelve un dict con las rutas generadas: {'pages': [...], 'pdf': str|None,
    'frames_dir': str|None, ...}.
    """
    s = settings
    s._frame_paths = frame_paths  # para resolve_landscape ("mejor ajuste")
    L = _build_layout(s)
    dpi = L.dpi

    out_dir = Path(s.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Exportar fotogramas individuales a máxima calidad (opcional).
    frames_dir = None
    if s.export_frames:
        frames_dir = out_dir / f"{s.out_name}_frames"
        frames_dir.mkdir(parents=True, exist_ok=True)
        for gidx, fpath in enumerate(frame_paths):
            num = numbers[gidx] if numbers is not None else (s.start_index + gidx)
            label_name = s.format_label(num) if s.labels_on else str(num)
            try:
                shutil.copyfile(fpath, frames_dir / f"{label_name}.png")
            except Exception:
                pass

    per_page = s.per_page
    num_pages = estimate_pages(len(frame_paths), per_page)
    # Ceros en el nombre de archivo: respeta page_num_zeros pero garantiza que
    # las hojas se ordenen bien aunque haya muchas.
    file_digits = max(s.page_num_zeros, len(str(max(1, num_pages))))
    page_paths = []
    page_images_for_pdf = []

    for page_idx in range(num_pages):
        if cancel_check and cancel_check():
            raise _Cancelled()

        chunk = frame_paths[page_idx * per_page: page_idx * per_page + per_page]
        canvas = _render_page(s, L, chunk, page_idx, numbers=numbers)

        page_base = f"{s.out_name}_p{str(page_idx + 1).zfill(file_digits)}"
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

        if progress_cb:
            progress_cb(page_idx + 1, num_pages)

    # PDF combinado (todas las páginas en un solo archivo, listo para imprimir).
    pdf_path = None
    if s.fmt_pdf and page_images_for_pdf:
        pdf_path = str(out_dir / f"{s.out_name}.pdf")
        first, rest = page_images_for_pdf[0], page_images_for_pdf[1:]
        first.save(
            pdf_path, "PDF", save_all=True, append_images=rest,
            resolution=float(dpi),
        )

    return {
        "pages": page_paths,
        "pdf": pdf_path,
        "frames_dir": str(frames_dir) if frames_dir else None,
        "num_pages": num_pages,
        "landscape": L.landscape,
        "orientation": "Horizontal" if L.landscape else "Vertical",
    }


class _Cancelled(Exception):
    pass
