"""Modo cianotipia: negativos digitales para imprimir en acetato.

Flujo físico que este módulo soporta:

    fotograma digital → NEGATIVO impreso en acetato → contacto con papel
    emulsionado + sol (UV) → cianotipia (azul de Prusia) → escaneo → fotograma

Conceptos clave:

* Densidad: cuánta tinta lleva el acetato en un punto (0 = transparente,
  1 = tinta plena). Donde el acetato es transparente pasa el UV y la
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

* Color de tinta: los negativos no tienen por qué ser grises. Algunas tintas
  bloquean el UV mejor con color (p. ej. tonos naranjas/ámbar rinden más
  densidad UV en muchas impresoras de inyección). El color se elige libre.

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


def density_to_rgb(density: np.ndarray, ink_rgb: tuple[int, int, int]) -> np.ndarray:
    """Convierte un mapa de densidad (0..255) en imagen RGB del negativo.

    densidad 0   → blanco (sin tinta, acetato transparente)
    densidad 255 → color de tinta pleno
    """
    d = density.astype(np.float32) / 255.0
    out = np.empty(density.shape + (3,), dtype=np.uint8)
    for ch in range(3):
        ink = float(ink_rgb[ch])
        out[..., ch] = np.clip(255.0 + (ink - 255.0) * d, 0, 255).astype(np.uint8)
    return out


def make_negative(img: Image.Image, lut=None,
                  ink_color: str = "#000000") -> Image.Image:
    """Convierte un fotograma a su negativo de cianotipia.

    1. Pasa a escala de grises (la cianotipia es monocroma).
    2. Aplica la curva de compensación (LUT) para obtener la densidad.
    3. Colorea la densidad con el color de tinta elegido.
    """
    gray = np.asarray(img.convert("L"))
    lut_arr = _as_lut_array(lut)
    density = lut_arr[gray]
    rgb = density_to_rgb(density, hex_to_rgb(ink_color))
    return Image.fromarray(rgb, "RGB")


def solid_density_color(density_0_255: float, ink_color: str) -> tuple[int, int, int]:
    """Color RGB de una densidad constante (para fondos y parches)."""
    d = np.array([[np.clip(density_0_255, 0, 255)]], dtype=np.uint8)
    return tuple(int(v) for v in density_to_rgb(d, hex_to_rgb(ink_color))[0, 0])


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
