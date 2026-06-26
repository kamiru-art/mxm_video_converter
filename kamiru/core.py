"""Composición de contact sheets a partir de fotogramas extraídos.

El render se hace a alta resolución (DPI configurable) sobre un lienzo del
tamaño de hoja elegido. Los fotogramas se reescalan con remuestreo LANCZOS
(alta calidad) para encajar en cada celda, conservando su relación de aspecto.
No se aplica ninguna corrección de color: las imágenes se pegan tal cual.
"""

from __future__ import annotations

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

    def label_for(self, n: int) -> str:
        """Etiqueta autoincremental para el índice global n (0-based)."""
        num = self.start_index + n
        num_str = str(num)
        if self.leading_zeros > 1:
            num_str = num_str.zfill(self.leading_zeros)
        if self.base_name:
            return f"{self.base_name}{self.separator}{num_str}"
        return num_str


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


def generate(settings: Settings, frame_paths, progress_cb=None, cancel_check=None):
    """Construye y guarda los contact sheets.

    Devuelve un dict con las rutas generadas: {'pages': [...], 'pdf': str|None,
    'frames_dir': str|None}.
    """
    s = settings
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
        # altura nominal de una línea de texto
        tmp = Image.new("RGB", (10, 10))
        _, label_h = _text_size(ImageDraw.Draw(tmp), "Ay1", label_font)
    page_font = None
    if s.page_num_on:
        ppx = paper.pt_to_px(s.page_num_size_pt, dpi)
        page_font = _load_font(s.font_path, ppx)

    # Orientación de la hoja: vertical, horizontal o "mejor ajuste" (la que
    # hace los fotogramas más grandes). Los nombres y el numerador de hoja se
    # colocan respecto a la hoja final, así que se acomodan solos.
    landscape = resolve_landscape(s, frame_paths, label_h, label_gap)
    page_w, page_h = paper.page_size_px(
        s.paper, dpi, landscape, s.custom_w_mm, s.custom_h_mm
    )

    # Geometría de la cuadrícula
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

    out_dir = Path(s.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Exportar fotogramas individuales a máxima calidad (opcional)
    frames_dir = None
    if s.export_frames:
        frames_dir = out_dir / f"{s.out_name}_frames"
        frames_dir.mkdir(parents=True, exist_ok=True)

    per_page = s.per_page
    total = len(frame_paths)
    num_pages = estimate_pages(total, per_page)
    page_paths = []
    page_images_for_pdf = []

    for page_idx in range(num_pages):
        if cancel_check and cancel_check():
            raise _Cancelled()

        canvas = Image.new("RGB", (page_w, page_h), s.bg_color)
        draw = ImageDraw.Draw(canvas)

        start = page_idx * per_page
        chunk = frame_paths[start:start + per_page]

        for cell_idx, fpath in enumerate(chunk):
            global_idx = start + cell_idx
            row = cell_idx // s.cols
            col = cell_idx % s.cols
            cell_x = margin + col * (cell_w + gutter)
            cell_y = margin + row * (cell_h + gutter)

            try:
                with Image.open(fpath) as im:
                    im = im.convert("RGB") if im.mode not in ("RGB", "L") else im
                    src_w, src_h = im.size
                    scale = min(cell_w / src_w, img_area_h / src_h)
                    new_w = max(1, int(round(src_w * scale)))
                    new_h = max(1, int(round(src_h * scale)))
                    resized = im.resize((new_w, new_h), _RESAMPLE)
            except Exception:
                continue

            # El bloque imagen+etiqueta se centra verticalmente dentro de la
            # celda, y la etiqueta queda pegada justo debajo de la imagen (no al
            # fondo de la celda), para que se vea ordenado aunque el frame no
            # llene todo el alto disponible.
            block_h = new_h + (label_area if s.labels_on else 0)
            block_top = cell_y + (cell_h - block_h) / 2
            px = int(round(cell_x + (cell_w - new_w) / 2))
            py = int(round(block_top))
            canvas.paste(resized, (px, py))

            # Exportar el frame individual con su nombre (máxima calidad).
            if frames_dir is not None:
                label_name = s.label_for(global_idx) if s.labels_on else f"{global_idx + 1}"
                try:
                    shutil.copyfile(fpath, frames_dir / f"{label_name}.png")
                except Exception:
                    pass

            # Etiqueta de nombre justo debajo del frame.
            if s.labels_on and label_font is not None:
                text = s.label_for(global_idx)
                tw, th = _text_size(draw, text, label_font)
                tx = int(round(cell_x + (cell_w - tw) / 2))
                ty = int(round(py + new_h + label_gap))
                draw.text((tx, ty), text, fill=s.label_color, font=label_font)

        # Numerador de hoja en la esquina.
        if s.page_num_on and page_font is not None:
            pno = f"{s.page_num_prefix}{s.page_num_start + page_idx}"
            tw, th = _text_size(draw, pno, page_font)
            pad = max(margin // 3, paper.mm_to_px(3, dpi))
            corner = s.page_num_corner
            if corner == "Inferior derecha":
                pos = (page_w - pad - tw, page_h - pad - th)
            elif corner == "Inferior izquierda":
                pos = (pad, page_h - pad - th)
            elif corner == "Superior derecha":
                pos = (page_w - pad - tw, pad)
            else:  # Superior izquierda
                pos = (pad, pad)
            draw.text(pos, pno, fill=s.page_num_color, font=page_font)

        # Guardar página.
        page_base = f"{s.out_name}_p{page_idx + 1:03d}"
        if s.fmt_png:
            ppath = out_dir / f"{page_base}.png"
            canvas.save(ppath, "PNG", dpi=(dpi, dpi), compress_level=6)
            page_paths.append(str(ppath))
        if s.fmt_tiff:
            tpath = out_dir / f"{page_base}.tif"
            canvas.save(tpath, "TIFF", dpi=(dpi, dpi), compression="tiff_lzw")
            page_paths.append(str(tpath))
        if s.fmt_pdf:
            page_images_for_pdf.append(canvas.copy())

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
        "landscape": landscape,
        "orientation": "Horizontal" if landscape else "Vertical",
    }


class _Cancelled(Exception):
    pass
