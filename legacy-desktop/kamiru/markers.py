"""Marcadores de registro: ArUco redundantes y códigos QR.

Los marcadores ArUco permiten alinear matemáticamente el escaneo de una hoja
pintada (corrigen rotación, perspectiva y escala). En la versión 2 se colocan
MÁS de 4 marcadores (hasta 12) repartidos por el borde de la hoja: como la
homografía se calcula con TODOS los marcadores detectados (RANSAC), la hoja se
puede procesar aunque varios marcadores queden tapados, pintados o recortados.

Los códigos QR identifican cada fotograma. El contenido usa un formato compacto
versionado ("K2|proyecto|hoja|celda|etiqueta") de modo que UN solo QR legible
en la hoja basta para identificarla completa.

Para el modo cianotipia, los marcadores/QRs se dibujan INVERTIDOS (celdas
claras sobre fondo oscuro): al imprimir el negativo en acetato y exponerlo al
sol, el positivo resultante muestra los marcadores con la polaridad estándar
(celdas oscuras sobre fondo claro), listos para detectarse en el escaneo.
"""

from __future__ import annotations

import cv2
import numpy as np
import qrcode
from PIL import Image, ImageOps

# Diccionarios ArUco soportados. El 4x4 es el más fácil de detectar a tamaños
# pequeños; 50 IDs es más que suficiente (usamos como mucho 12).
ARUCO_DICTS = {
    "DICT_4X4_50": cv2.aruco.DICT_4X4_50,
    "DICT_4X4_100": cv2.aruco.DICT_4X4_100,
    "DICT_5X5_100": cv2.aruco.DICT_5X5_100,
}
DEFAULT_DICT = "DICT_4X4_50"

# Cantidades de marcadores admitidas en la interfaz.
MARKER_COUNTS = [4, 8, 12]

# Prefijo/versión del contenido de los QR.
QR_PREFIX = "K2"


def get_dictionary(dict_name: str = DEFAULT_DICT):
    """Devuelve el diccionario ArUco de OpenCV a partir de su nombre."""
    tipo = ARUCO_DICTS.get(dict_name, cv2.aruco.DICT_4X4_50)
    return cv2.aruco.getPredefinedDictionary(tipo)


# ────────────────────────────────────────────────────────────────
# Generación de imágenes (ArUco / QR)
# ────────────────────────────────────────────────────────────────

def marker_patch(marker_id: int, side_px: int, quiet_px: int,
                 dict_name: str = DEFAULT_DICT, inverted: bool = False) -> Image.Image:
    """Genera un parche con un marcador ArUco y su zona de silencio.

    El parche mide (side_px + 2*quiet_px) de lado: el marcador va centrado y la
    zona de silencio (borde claro alrededor) garantiza la detección aunque el
    fondo de la hoja no sea blanco.

    Si inverted=True se invierte TODO el parche (marcador y zona de silencio),
    que es lo que necesita un negativo de cianotipia.
    """
    aruco_dict = get_dictionary(dict_name)
    marker = cv2.aruco.generateImageMarker(aruco_dict, int(marker_id), int(side_px))
    patch = np.full((side_px + 2 * quiet_px, side_px + 2 * quiet_px), 255, np.uint8)
    patch[quiet_px:quiet_px + side_px, quiet_px:quiet_px + side_px] = marker
    if inverted:
        patch = 255 - patch
    return Image.fromarray(patch).convert("RGB")


def qr_image(text: str, size_px: int, inverted: bool = False) -> Image.Image:
    """Genera un QR (con su borde de silencio) del tamaño pedido en píxeles.

    Corrección de errores alta (H): tolera hasta ~30 % del código dañado, útil
    si queda algo de pintura o la tonalidad del papel varía (cianotipia).
    """
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=10,
        border=2,
    )
    qr.add_data(text)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("L")
    img = img.resize((size_px, size_px), Image.NEAREST)
    if inverted:
        img = ImageOps.invert(img)
    return img.convert("RGB")


# ────────────────────────────────────────────────────────────────
# Posiciones de los marcadores en la hoja
# ────────────────────────────────────────────────────────────────

def marker_layout(page_w: int, page_h: int, count: int, side_px: int,
                  margin_px: int, quiet_px: int) -> dict[int, tuple[int, int]]:
    """Posiciones (top-left del PARCHE) de los marcadores en la hoja.

    Devuelve {id: (x, y)} donde (x, y) es la esquina superior-izquierda del
    parche (marcador + zona de silencio). Los IDs son estables:

        0-3   esquinas: TL, TR, BR, BL
        4-7   centros de borde: arriba, derecha, abajo, izquierda
        8-11  tercios de los bordes largos (arriba x2, abajo x2)

    Con count=4 solo esquinas; count=8 añade los centros de borde; count=12
    añade dos marcadores más por borde horizontal.
    """
    count = int(count)
    if count not in MARKER_COUNTS:
        count = min(MARKER_COUNTS, key=lambda c: abs(c - count))

    patch = side_px + 2 * quiet_px
    m = margin_px
    x_left, x_right = m, page_w - m - patch
    y_top, y_bot = m, page_h - m - patch
    x_mid = (page_w - patch) // 2
    y_mid = (page_h - patch) // 2

    pos = {
        0: (x_left, y_top),      # TL
        1: (x_right, y_top),     # TR
        2: (x_right, y_bot),     # BR
        3: (x_left, y_bot),      # BL
    }
    if count >= 8:
        pos.update({
            4: (x_mid, y_top),   # borde superior, centro
            5: (x_right, y_mid),  # borde derecho, centro
            6: (x_mid, y_bot),   # borde inferior, centro
            7: (x_left, y_mid),  # borde izquierdo, centro
        })
    if count >= 12:
        x_13 = x_left + (x_right - x_left) // 3
        x_23 = x_left + (x_right - x_left) * 2 // 3
        pos.update({
            8: (x_13, y_top),
            9: (x_23, y_top),
            10: (x_13, y_bot),
            11: (x_23, y_bot),
        })
    return pos


def marker_bboxes(page_w: int, page_h: int, count: int, side_px: int,
                  margin_px: int, quiet_px: int) -> dict[int, list[int]]:
    """Bounding boxes [x1, y1, x2, y2] del CUADRADO ArUco real (sin la zona de
    silencio) para cada marcador. Son las coordenadas que se guardan en el
    layout.json y que el procesador de escaneos usa como puntos teóricos."""
    out = {}
    for mid, (px, py) in marker_layout(page_w, page_h, count, side_px,
                                       margin_px, quiet_px).items():
        x1, y1 = px + quiet_px, py + quiet_px
        out[mid] = [x1, y1, x1 + side_px, y1 + side_px]
    return out


def bbox_corners(bbox) -> np.ndarray:
    """Esquinas (TL, TR, BR, BL) de un bbox axis-aligned, como float32."""
    x1, y1, x2, y2 = [float(v) for v in bbox]
    return np.array([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], dtype=np.float32)


# ────────────────────────────────────────────────────────────────
# Contenido de los QR
# ────────────────────────────────────────────────────────────────

def qr_payload(project: str, sheet_num: int, cell_idx: int, label: str) -> str:
    """Serializa la identidad de una celda: 'K2|proyecto|hoja|celda|etiqueta'."""
    proj = (project or "").replace("|", "/")
    lab = (label or "").replace("|", "/")
    return f"{QR_PREFIX}|{proj}|{int(sheet_num)}|{int(cell_idx)}|{lab}"


def parse_qr_payload(text: str):
    """Interpreta el contenido de un QR.

    Devuelve un dict {'proyecto', 'hoja', 'celda', 'etiqueta'} para QRs v2, o
    {'etiqueta': texto} para QRs antiguos (v1 codificaba solo el nombre), o
    None si el texto está vacío.
    """
    if not text:
        return None
    parts = text.split("|")
    if len(parts) == 5 and parts[0] == QR_PREFIX:
        try:
            return {
                "proyecto": parts[1],
                "hoja": int(parts[2]),
                "celda": int(parts[3]),
                "etiqueta": parts[4],
            }
        except ValueError:
            return None
    # Compatibilidad con QRs de la versión 1 (solo el nombre del frame).
    return {"proyecto": None, "hoja": None, "celda": None, "etiqueta": text}
