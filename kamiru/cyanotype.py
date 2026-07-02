"""Modo cianotipia: negativos digitales para imprimir en acetato.

Flujo físico que este módulo soporta:

    fotograma digital → NEGATIVO impreso en acetato → contacto con papel
    emulsionado + sol (UV) → cianotipia (azul de Prusia) → escaneo → fotograma

Conceptos clave:

* Densidad: cuánta tinta lleva el acetato en un punto (0 = transparente,
  255 = tinta plena). Donde el acetato es transparente pasa el UV y la
  cianotipia se vuelve AZUL OSCURO; donde hay tinta plena queda BLANCO papel.
  Por eso el negativo es "brillo original = densidad": las zonas claras del
  fotograma se imprimen oscuras en el acetato.

* Curva de compensación (estilo "easy digital negatives", pero integrada al
  revés: aquí la app GENERA el negativo ya corregido): la química de la
  cianotipia no responde linealmente a la densidad del negativo. Con la
  calibración (ver calibration.py) se mide la respuesta real del proceso de
  Kamila (su impresora + su acetato + su emulsión + su sol) y se construye una
  LUT de 256 valores que lineariza los tonos finales y aprovecha todo el rango
  dinámico.

* Color de tinta: los negativos no tienen por qué ser grises. La tinta negra
  no siempre es la que mejor bloquea el UV: la calibración ColorBlocker (ver
  calibration.py) encuentra el color que MÁS bloquea en TU impresora. Además
  del color simple se admite un DEGRADADO de densidad (estilo EDN
  ColorBlocker): una rampa de colores de transparente a tinta plena, definida
  por paradas [(densidad, color), ...].

* Espejado: los negativos de contacto se imprimen en espejo para exponer
  "emulsión contra emulsión" (la cara impresa tocando el papel). Así la
  cianotipia final queda derecha, y el escaneo se procesa sin nada especial.
"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageOps


def default_lut() -> list[int]:
    """LUT identidad: densidad = brillo original (sin calibración)."""
    return list(range(256))


def _as_lut_array(lut) -> np.ndarray:
    """Valida/convierte una LUT (lista de 256 enteros 0-255) a numpy uint8."""
    if lut is None:
        return np.arange(256, dtype=np.uint8)
    arr = np.asarray(lut, dtype=np.float64)
    if arr.shape != (256,):
        raise ValueError("La curva de cianotipia debe tener exactamente 256 valores.")
    return np.clip(np.round(arr), 0, 255).astype(np.uint8)


def hex_to_rgb(color: str) -> tuple[int, int, int]:
    """'#RRGGBB' → (r, g, b). Tolera con o sin '#'."""
    c = (color or "#000000").lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    try:
        return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore
    except ValueError:
        return (0, 0, 0)


def rgb_to_hex(rgb) -> str:
    r, g, b = [int(max(0, min(255, v))) for v in rgb]
    return f"#{r:02X}{g:02X}{b:02X}"


def ink_ramp(ink_color: str = "#000000", stops=None) -> np.ndarray:
    """Rampa 256×3 (uint8): color impreso para cada densidad 0..255.

    - Sin stops: interpolación lineal blanco (d=0, sin tinta) → ink_color
      (d=255, tinta plena).
    - Con stops [(densidad, "#RRGGBB"), ...] (estilo EDN ColorBlocker): se
      interpola entre las paradas; si no hay parada en d=0 se ancla en blanco.
    """
    anchors: list[tuple[float, tuple[int, int, int]]] = []
    if stops:
        for st in stops:
            d, col = st[0], st[1]
            rgb = hex_to_rgb(col) if isinstance(col, str) else tuple(int(v) for v in col)
            anchors.append((float(np.clip(d, 0, 255)), rgb))
        anchors.sort(key=lambda a: a[0])
        if anchors[0][0] > 0.5:
            anchors.insert(0, (0.0, (255, 255, 255)))
        if anchors[-1][0] < 254.5:
            anchors.append((255.0, anchors[-1][1]))
    else:
        anchors = [(0.0, (255, 255, 255)), (255.0, hex_to_rgb(ink_color))]

    xs = np.array([a[0] for a in anchors])
    ramp = np.empty((256, 3), dtype=np.uint8)
    d = np.arange(256, dtype=np.float64)
    for ch in range(3):
        ys = np.array([a[1][ch] for a in anchors], dtype=np.float64)
        ramp[:, ch] = np.clip(np.round(np.interp(d, xs, ys)), 0, 255).astype(np.uint8)
    return ramp


def apply_ramp(density: np.ndarray, ramp: np.ndarray) -> np.ndarray:
    """Convierte un mapa de densidad (uint8) en imagen RGB usando la rampa."""
    return ramp[density]


def density_to_rgb(density: np.ndarray, ink_rgb: tuple[int, int, int]) -> np.ndarray:
    """(Compatibilidad) densidad → RGB con tinta simple."""
    ramp = ink_ramp(rgb_to_hex(ink_rgb))
    return apply_ramp(density.astype(np.uint8), ramp)


def make_negative(img: Image.Image, lut=None, ink_color: str = "#000000",
                  stops=None) -> Image.Image:
    """Convierte un fotograma a su negativo de cianotipia.

    1. Pasa a escala de grises (la cianotipia es monocroma).
    2. Aplica la curva de compensación (LUT) para obtener la densidad.
    3. Colorea la densidad con el color/degradado de tinta elegido.
    """
    gray = np.asarray(img.convert("L"))
    lut_arr = _as_lut_array(lut)
    density = lut_arr[gray]
    return Image.fromarray(apply_ramp(density, ink_ramp(ink_color, stops)), "RGB")


def colorize_gray_patch(img: Image.Image, ink_color: str = "#000000",
                        stops=None) -> Image.Image:
    """Colorea un parche en escala de grises interpretándolo como densidad
    INVERTIDA: negro (0) = transparente, blanco (255) = tinta plena.

    Es lo que necesitan los marcadores ArUco/QRs/textos en un negativo: sus
    celdas negras deben quedar transparentes (→ azul oscuro en la copia) y sus
    zonas blancas deben ir con tinta plena (→ blanco papel en la copia).
    """
    gray = np.asarray(img.convert("L"))
    return Image.fromarray(apply_ramp(gray, ink_ramp(ink_color, stops)), "RGB")


def solid_density_color(density_0_255: float, ink_color: str,
                        stops=None) -> tuple[int, int, int]:
    """Color RGB de una densidad constante (para fondos, halos y parches)."""
    ramp = ink_ramp(ink_color, stops)
    return tuple(int(v) for v in ramp[int(np.clip(density_0_255, 0, 255))])


def mirror(img: Image.Image) -> Image.Image:
    """Espejado horizontal (impresión emulsión-contra-emulsión)."""
    return ImageOps.mirror(img)


def simulate_print(negative: Image.Image,
                   paper_rgb=(245, 242, 230),
                   blue_rgb=(23, 49, 92)) -> Image.Image:
    """Simula (aproximadamente) cómo se vería la cianotipia final de un
    negativo. Solo para la VISTA PREVIA de la interfaz: donde el negativo es
    transparente sale azul de Prusia; donde hay tinta plena queda papel.
    """
    gray = np.asarray(negative.convert("L")).astype(np.float32) / 255.0
    # gris del negativo: 1.0 = blanco = transparente = azul pleno en el papel
    exposure = gray  # claridad del negativo ≈ exposición
    out = np.empty(gray.shape + (3,), dtype=np.uint8)
    for ch in range(3):
        p, b = float(paper_rgb[ch]), float(blue_rgb[ch])
        out[..., ch] = np.clip(p + (b - p) * exposure, 0, 255).astype(np.uint8)
    return Image.fromarray(out, "RGB")
