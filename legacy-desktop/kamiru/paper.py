"""Tamaños de hoja (en milímetros) y utilidades de conversión a píxeles."""

from __future__ import annotations

# Dimensiones en milímetros (ancho, alto) en orientación VERTICAL (portrait).
PAPER_SIZES_MM = {
    "A3": (297.0, 420.0),
    "A4": (210.0, 297.0),
    "A5": (148.0, 210.0),
    "A6": (105.0, 148.0),
    "B4": (250.0, 353.0),
    "B5": (176.0, 250.0),
    "Carta (Letter)": (215.9, 279.4),
    "Oficio (Legal)": (215.9, 355.6),
    "Tabloide (Tabloid)": (279.4, 431.8),
    "Personalizado": None,  # se define con ancho/alto manuales
}

# Orden de aparición en el menú desplegable.
PAPER_ORDER = [
    "A4",
    "A3",
    "A5",
    "A6",
    "B4",
    "B5",
    "Carta (Letter)",
    "Oficio (Legal)",
    "Tabloide (Tabloid)",
    "Personalizado",
]

MM_PER_INCH = 25.4


def mm_to_px(mm: float, dpi: int) -> int:
    """Convierte milímetros a píxeles para una resolución (DPI) dada."""
    return int(round(mm / MM_PER_INCH * dpi))


def pt_to_px(pt: float, dpi: int) -> int:
    """Convierte puntos tipográficos (1/72 pulgada) a píxeles a un DPI dado."""
    return max(1, int(round(pt / 72.0 * dpi)))


def page_size_px(paper_name: str, dpi: int, landscape: bool,
                 custom_w_mm: float = 210.0, custom_h_mm: float = 297.0):
    """Devuelve (ancho_px, alto_px) de la hoja según tamaño, DPI y orientación."""
    dims = PAPER_SIZES_MM.get(paper_name)
    if dims is None:  # Personalizado
        w_mm, h_mm = float(custom_w_mm), float(custom_h_mm)
    else:
        w_mm, h_mm = dims
    if landscape:
        w_mm, h_mm = h_mm, w_mm
    return mm_to_px(w_mm, dpi), mm_to_px(h_mm, dpi)
