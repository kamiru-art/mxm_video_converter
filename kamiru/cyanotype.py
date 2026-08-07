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
from PIL import Image, ImageFilter, ImageOps


def default_lut() -> list[int]:
    """LUT identidad: densidad = brillo original (sin calibración)."""
    return list(range(256))


def _as_lut_array(lut) -> np.ndarray:
    """Valida/convierte una LUT (256 valores 0-255, enteros o flotantes) a
    numpy float64. Se conserva en flotante para poder aplicar dithering al
    cuantizar: redondear directamente una curva comprimida produce mesetas y
    saltos visibles (posterización) en los degradados."""
    if lut is None:
        return np.arange(256, dtype=np.float64)
    arr = np.asarray(lut, dtype=np.float64)
    if arr.shape != (256,):
        raise ValueError("La curva de cianotipia debe tener exactamente 256 valores.")
    return np.clip(arr, 0, 255)


# ────────────────────────────────────────────────────────────────
# Curva efectiva: fuerza, adaptación al contenido
# ────────────────────────────────────────────────────────────────
#
# La curva calibrada lineariza los tonos finales, pero esa es UNA intención de
# render entre varias: al enderezar las zonas donde la química responde plano,
# comprime otras (p. ej. altas luces) hasta que su textura cae por debajo del
# ruido del proceso. Estos ajustes permiten elegir el reparto tonal:
#
# * FUERZA: mezcla identidad ↔ curva calibrada (0-100 %). El punto medio entre
#   "detalle nativo" y "tonos linearizados".
# * ADAPTACIÓN AL CONTENIDO: redistribuye los tonos de salida según el
#   histograma de LOS FOTOGRAMAS DEL PROYECTO: las zonas tonales pobladas
#   (piel, arena…) reciben más rango de densidad y las vacías lo ceden.
#   Ecualización restringida (suavizada, monótona, con pendiente mínima), no
#   aprendizaje automático: determinista y reproducible.

# Máximo de fotogramas muestreados para el histograma (repartidos por toda la
# selección) y caché de histogramas ya calculados (la vista previa vuelve a
# pedir el mismo en cada cambio de página).
HIST_MAX_FRAMES = 200
_HIST_CACHE: dict = {}


def content_histogram(frame_paths, max_frames: int = HIST_MAX_FRAMES) -> np.ndarray:
    """Histograma de grises (256 bins) del contenido de los fotogramas.

    Muestrea hasta max_frames repartidos por toda la selección, cada uno
    reducido a miniatura (la distribución tonal no necesita resolución).
    """
    paths = [str(p) for p in frame_paths]
    if len(paths) > max_frames:
        idx = np.linspace(0, len(paths) - 1, max_frames).round().astype(int)
        paths = [paths[i] for i in dict.fromkeys(idx.tolist())]
    key = tuple(paths)
    cached = _HIST_CACHE.get(key)
    if cached is not None:
        return cached
    hist = np.zeros(256, dtype=np.float64)
    for p in paths:
        try:
            with Image.open(p) as im:
                g = np.asarray(im.convert("L").resize((96, 96)))
        except Exception:
            continue
        hist += np.bincount(g.ravel(), minlength=256)
    if len(_HIST_CACHE) > 4:
        _HIST_CACHE.clear()
    _HIST_CACHE[key] = hist
    return hist


def effective_lut(lut=None, strength: float = 100.0, adapt: float = 0.0,
                  hist: np.ndarray | None = None):
    """Curva efectiva de densidad: calibrada × fuerza, redistribuida al contenido.

    1. FUERZA (0-100): mezcla lineal identidad ↔ lut calibrada.
    2. ADAPTACIÓN (0-100): compone con T = mezcla de identidad y la CDF del
       histograma del contenido (suavizada y con pendiente mínima para que
       las zonas tonales vacías no colapsen a cero rango). Como la lut
       calibrada lineariza los tonos de SALIDA, componer con T reparte esos
       tonos según donde el contenido tiene detalle.

    Devuelve una lista de 256 flotantes, o None si el resultado es la
    identidad (así make_negative no toca ni un píxel ni mete dithering).
    """
    ident = np.arange(256, dtype=np.float64)
    a = float(np.clip(strength if strength is not None else 100.0, 0, 100)) / 100.0
    base = ident * (1.0 - a) + _as_lut_array(lut) * a

    b = float(np.clip(adapt or 0.0, 0, 100)) / 100.0
    out = base
    if b > 0 and hist is not None and float(np.sum(hist)) > 0:
        h = np.asarray(hist, dtype=np.float64)
        # Suavizado (ventana 21) con bordes extendidos: la CDF debe ser una
        # curva tonal amable, no seguir cada pico del histograma.
        v = 21
        ext = np.pad(h, v // 2, mode="edge")
        h = np.convolve(ext, np.ones(v) / v, mode="valid")
        h = h / max(1e-12, h.sum())
        # Pendiente mínima: las zonas vacías conservan un 15 % de rango
        # proporcional (que un tono no exista HOY no significa aplastarlo).
        piso = 0.15
        h = (h + piso / 256.0) / (1.0 + piso)
        cdf = np.cumsum(h)
        cdf = (cdf - cdf[0]) / max(1e-12, cdf[-1] - cdf[0])
        T = (1.0 - b) * (ident / 255.0) + b * cdf
        out = np.interp(T * 255.0, ident, base)

    if np.allclose(out, ident, atol=1e-9):
        return None
    return [round(float(np.clip(x, 0, 255)), 3) for x in out]


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
                  stops=None, clarity: float = 0.0) -> Image.Image:
    """Convierte un fotograma a su negativo de cianotipia.

    1. Pasa a escala de grises (la cianotipia es monocroma).
    2. MICRO-CONTRASTE opcional (clarity 0-100): máscara de desenfoque de
       radio grande sobre el gris, ANTES de la curva. Refuerza la textura
       local, así el detalle sobrevive dentro de las zonas tonales que la
       curva global comprime (una curva por sí sola no puede dar detalle en
       piel Y arena a la vez; un operador local sí).
    3. Aplica la curva de compensación (LUT) para obtener la densidad.
    4. Colorea la densidad con el color/degradado de tinta elegido.

    Con curva de calibración, la cuantización a 8 bits se hace con DITHERING
    (ruido uniforme ±0.5 antes de redondear, semilla fija): una curva que
    comprime el rango deja menos densidades distintas y sin dithering los
    degradados salen ESCALONADOS (bandas). El ruido subcuántico reparte cada
    salto entre píxeles vecinos y el degradado impreso vuelve a verse continuo.
    Sin curva ni micro-contraste (identidad) no se toca ni un píxel.
    """
    gris = img.convert("L")
    gray = np.asarray(gris)
    c = float(np.clip(clarity or 0.0, 0, 100))
    if c > 0:
        # Radio proporcional al fotograma: micro-contraste, no un borde duro.
        radio = max(2.0, min(gris.size) / 24.0)
        blur = np.asarray(gris.filter(ImageFilter.GaussianBlur(radio)),
                          dtype=np.float32)
        realzado = gray.astype(np.float32) + (c / 100.0) * (gray - blur)
        gray = np.clip(np.round(realzado), 0, 255).astype(np.uint8)
    lut_arr = _as_lut_array(lut)
    density_f = lut_arr[gray]
    if lut is not None:
        rng = np.random.default_rng(12345)  # determinista: hojas reproducibles
        density_f = density_f + rng.uniform(-0.5, 0.5, size=density_f.shape)
    density = np.clip(np.round(density_f), 0, 255).astype(np.uint8)
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


def _density_from_pixels(negative: Image.Image, ink_color=None,
                         stops=None) -> np.ndarray:
    """Densidad estimada (0-255) de cada píxel de un negativo YA COLOREADO.

    Con tinta neutra basta la claridad invertida. Con una tinta de color (o un
    degradado ColorBlocker) NO: un verde flúor a densidad plena es CLARO en
    luminancia, así que leer la claridad como transparencia haría creer que
    esa zona deja pasar el UV cuando en realidad lo bloquea.

    Solución: proyectar el color de cada píxel sobre el EJE DE LA TINTA (la
    recta que va del blanco del acetato a la tinta plena). Ese eje conserva
    los 8 bits de resolución sea cual sea el color — con luminancia, un verde
    flúor solo recorre 40 niveles y la densidad saldría a escalones — y sigue
    siendo válido con degradados de varias paradas (se fuerza monótono, que
    un ColorBlocker puede dar la vuelta a medio camino).
    """
    if not ink_color and not stops:
        return 255.0 - np.asarray(negative.convert("L")).astype(np.float32)
    ramp = ink_ramp(ink_color or "#000000", stops).astype(np.float64)
    eje = ramp[255] - ramp[0]
    norma = float(eje @ eje)
    if norma < 1e-6:      # rampa degenerada (tinta = blanco): sin densidad
        return np.zeros(negative.size[::-1], dtype=np.float32)
    t_ramp = ((ramp - ramp[0]) @ eje) / norma
    # Estrictamente creciente para que la inversa exista.
    t_ramp = np.maximum.accumulate(t_ramp)
    for i in range(1, 256):
        if t_ramp[i] <= t_ramp[i - 1]:
            t_ramp[i] = t_ramp[i - 1] + 1e-6
    rgb = np.asarray(negative.convert("RGB")).astype(np.float64)
    t_pix = ((rgb - ramp[0]) @ eje) / norma
    return np.interp(t_pix, t_ramp,
                     np.arange(256, dtype=np.float64)).astype(np.float32)


def simulate_print(negative: Image.Image,
                   paper_rgb=(245, 242, 230),
                   blue_rgb=(23, 49, 92),
                   response=None, ink_color=None, stops=None) -> Image.Image:
    """Simula (aproximadamente) cómo se vería la cianotipia final de un
    negativo. Solo para la VISTA PREVIA de la interfaz: donde el negativo es
    transparente sale azul de Prusia; donde hay tinta plena queda papel.

    Con `response` (la respuesta medida del perfil de calibración: pares
    [densidad, luminancia]) la simulación es un SOFT-PROOF: en vez del modelo
    lineal genérico, cada densidad pasa por la curva real de TU proceso, así
    que los tonos aplastados o vacíos se ven ANTES de imprimir y exponer.

    Con ink_color/stops la densidad se deduce de la rampa de tinta REAL, así
    que el soft-proof también vale con tintas de color y degradados
    ColorBlocker (ver _density_from_pixels).
    """
    dens = _density_from_pixels(negative, ink_color, stops)
    # densidad 0 = sin tinta = transparente = azul pleno en el papel
    exposure = 1.0 - dens / 255.0
    if response:
        try:
            pares = sorted((float(r[0]), float(r[1])) for r in response)
            dd = np.array([p[0] for p in pares])
            yy = np.maximum.accumulate(np.array([p[1] for p in pares]))
            if len(dd) >= 5 and (yy[-1] - yy[0]) > 5:
                tono = np.interp(dens, dd, yy)
                exposure = 1.0 - (tono - yy[0]) / (yy[-1] - yy[0])
        except Exception:
            pass  # respuesta malformada: se usa el modelo genérico
    out = np.empty(exposure.shape + (3,), dtype=np.uint8)
    for ch in range(3):
        p, b = float(paper_rgb[ch]), float(blue_rgb[ch])
        out[..., ch] = np.clip(p + (b - p) * exposure, 0, 255).astype(np.uint8)
    return Image.fromarray(out, "RGB")


def response_summary(response) -> dict:
    """Diagnóstico de una respuesta medida ([densidad, luminancia]).

    Devuelve {'rango', 'invertida', 'plana'}: sirve para avisar de una
    calibración que salió al revés (se escaneó el ACETATO en vez de la copia
    azul) o sin contraste (exposición mal calculada), en vez de guardar una
    curva que luego arruina todos los negativos del proyecto.
    """
    try:
        pares = sorted((float(r[0]), float(r[1])) for r in response or [])
    except (TypeError, ValueError):
        return {"rango": 0.0, "invertida": False, "plana": True}
    if len(pares) < 3:
        return {"rango": 0.0, "invertida": False, "plana": True}
    y = np.array([p[1] for p in pares])
    n = max(1, len(y) // 4)
    rango = float(y.max() - y.min()) / 255.0
    return {
        "rango": rango,
        "invertida": bool(y[:n].mean() > y[-n:].mean() + 8),
        "plana": rango < 0.10,
    }
