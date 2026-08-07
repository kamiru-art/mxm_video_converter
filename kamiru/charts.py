"""Gráficos de los RESULTADOS de calibración (fase ①).

Un perfil de calibración es un montón de números; antes solo se veía una línea
de texto («rango dinámico 72 %»), que no dice si la curva salió sana, si las
sombras se aplastaron o si el ColorBlocker eligió un color raro. Aquí se
dibujan esos resultados para poder juzgarlos de un vistazo, ANTES de gastar
acetato, papel y sol:

    curva_cianotipia()  respuesta medida + curva de compensación + rango
    colorblocker()      color ganador, degradado y comparación con el negro
    impresora()         escala medida, respuesta tonal y tamaños mínimos

Todo con Pillow, sin dependencias nuevas ni archivos externos.
"""

from __future__ import annotations

from PIL import Image, ImageDraw

from . import cyanotype as cyan
from . import fonts as fontmod
from .core import _load_font

BG = "#FFFFFF"
INK = "#243038"
MUTED = "#63707B"
LINE = "#D5DCE2"
GRID = "#EDF1F4"
ACCENT = "#15795A"
CURVE = "#1FA37A"
MEAS = "#3F6DB5"
WARN = "#B4562F"

SS = 2   # supermuestreo para bordes suaves


def _f(px):
    # Fuente del sistema: la de Pillow por defecto es un bitmap ASCII y
    # comería los acentos y las flechas de las etiquetas.
    return _load_font(fontmod.ui_font_path(), max(7, int(px)))


def _txt(d, xy, s, px=11, fill=INK, anchor="lt"):
    try:
        d.text(xy, s, font=_f(px), fill=fill, anchor=anchor)
    except Exception:
        d.text(xy, s, font=_f(px), fill=fill)


def _panel(w, h):
    img = Image.new("RGB", (w * SS, h * SS), BG)
    return img, ImageDraw.Draw(img)


def _finish(img, w, h):
    return img.resize((w, h), Image.LANCZOS)


def _ejes(d, box, k=SS, xlab="", ylab=""):
    x1, y1, x2, y2 = [v * k for v in box]
    d.rectangle([x1, y1, x2, y2], fill=BG, outline=LINE, width=k)
    for i in range(1, 4):
        yy = y1 + (y2 - y1) * i / 4
        xx = x1 + (x2 - x1) * i / 4
        d.line([(x1, yy), (x2, yy)], fill=GRID, width=k)
        d.line([(xx, y1), (xx, y2)], fill=GRID, width=k)
    if xlab:
        _txt(d, ((x1 + x2) / 2, y2 + 6 * k), xlab, px=9 * k, fill=MUTED,
             anchor="mt")
    if ylab:
        _txt(d, (x1, y1 - 11 * k), ylab, px=9 * k, fill=MUTED)


def _serie(d, box, xs, ys, fill, k=SS, width=2, x_max=255.0, y_min=0.0,
           y_max=255.0):
    x1, y1, x2, y2 = [v * k for v in box]
    pad = 3 * k
    x1, y1, x2, y2 = x1 + pad, y1 + pad, x2 - pad, y2 - pad
    span = max(1e-6, y_max - y_min)
    pts = [(x1 + (x / x_max) * (x2 - x1),
            y2 - ((y - y_min) / span) * (y2 - y1)) for x, y in zip(xs, ys)]
    if len(pts) > 1:
        d.line(pts, fill=fill, width=max(1, width * k), joint="curve")


def _leyenda(d, x, y, color, texto, k=SS):
    d.line([(x * k, y * k), ((x + 14) * k, y * k)], fill=color, width=3 * k)
    _txt(d, ((x + 19) * k, (y - 5) * k), texto, px=10 * k, fill=MUTED)


# ────────────────────────────────────────────────────────────────

def curva_cianotipia(prof: dict, w: int = 420, h: int = 190):
    """Respuesta medida del proceso + curva de compensación resultante.

    - Azul: lo que TU proceso hace de verdad (densidad impresa → tono de la
      copia azul). Si es plana en un tramo, ahí la química no distingue tonos.
    - Verde: la curva que la app aplicará a los negativos para compensarla.
    - Gris: la diagonal (proceso ideal, que no existe).
    """
    img, d = _panel(w, h)
    caja = [10, 22, 190, 160]
    _ejes(d, caja, xlab="densidad del negativo →", ylab="tono de la copia ↑")
    resp = prof.get("respuesta") or []
    if resp:
        xs = [float(r[0]) for r in resp]
        ys = [float(r[1]) for r in resp]
        y0, y1 = min(ys), max(ys)
        _serie(d, caja, [0, 255], [y0, y1], LINE, width=2, y_min=y0, y_max=y1)
        _serie(d, caja, xs, ys, MEAS, width=2, y_min=y0, y_max=y1)
    lut = prof.get("lut") or []
    if len(lut) == 256:
        _serie(d, caja, list(range(256)), [float(v) for v in lut], CURVE,
               width=2)

    x = 205
    _txt(d, (x * SS, 20 * SS), "Resultado", px=13 * SS, fill=ACCENT)
    _leyenda(d, x, 46, MEAS, "respuesta medida")
    _leyenda(d, x, 64, CURVE, "curva aplicada")
    _leyenda(d, x, 82, LINE, "proceso ideal")

    rango = float(prof.get("rango_dinamico") or 0.0)
    col = ACCENT if rango >= 0.6 else (WARN if rango < 0.35 else INK)
    _txt(d, (x * SS, 104 * SS), f"Rango dinámico: {rango * 100:.0f} %",
         px=12 * SS, fill=col)
    juicio = ("excelente" if rango >= 0.75 else
              "bueno" if rango >= 0.6 else
              "justo" if rango >= 0.35 else "bajo: revisa exposición y tinta")
    _txt(d, (x * SS, 121 * SS), juicio, px=10 * SS, fill=MUTED)
    n = prof.get("steps") or len(resp)
    _txt(d, (x * SS, 141 * SS), f"{n} parches medidos", px=10 * SS, fill=MUTED)
    tinta = prof.get("ink")
    if tinta:
        d.rectangle([x * SS, 158 * SS, (x + 14) * SS, 170 * SS],
                    fill=tinta, outline=LINE)
        _txt(d, ((x + 20) * SS, 158 * SS), f"tinta {tinta}", px=10 * SS,
             fill=MUTED)
    return _finish(img, w, h)


def colorblocker(prof: dict, w: int = 420, h: int = 190):
    """Color ganador del ColorBlocker, su degradado y el negro de referencia."""
    img, d = _panel(w, h)
    _txt(d, (12 * SS, 12 * SS), "Color que mejor bloquea el UV", px=13 * SS,
         fill=ACCENT)

    mejor = prof.get("mejor_color") or "#000000"
    d.rectangle([12 * SS, 36 * SS, 92 * SS, 96 * SS], fill=mejor,
                outline=LINE, width=SS)
    _txt(d, (12 * SS, 102 * SS), mejor, px=12 * SS, fill=INK)
    matiz = prof.get("mejor_matiz")
    _txt(d, (12 * SS, 120 * SS),
         "matiz K (gris)" if matiz is None else f"matiz {matiz}", px=10 * SS,
         fill=MUTED)

    d.rectangle([108 * SS, 36 * SS, 148 * SS, 96 * SS], fill="#000000",
                outline=LINE, width=SS)
    _txt(d, (108 * SS, 102 * SS), "negro", px=10 * SS, fill=MUTED)

    # Degradado reconstruido con las paradas del perfil (lo que se imprimirá).
    stops = prof.get("stops") or []
    _txt(d, (170 * SS, 30 * SS), "Degradado de tinta (densidad 0 → 255)",
         px=10 * SS, fill=MUTED)
    if stops:
        ramp = cyan.ink_ramp(mejor, stops)
        ancho = 232
        for i in range(ancho):
            c = tuple(int(v) for v in ramp[int(round(255 * i / (ancho - 1)))])
            d.rectangle([(170 + i) * SS, 44 * SS, (171 + i) * SS, 84 * SS],
                        fill=c)
        d.rectangle([170 * SS, 44 * SS, 402 * SS, 84 * SS], outline=LINE,
                    width=SS)
        for i, (dens, col) in enumerate(stops):
            x = 170 + int(232 * float(dens) / 255.0)
            x = min(x, 386)
            d.rectangle([x * SS, 90 * SS, (x + 16) * SS, 104 * SS], fill=col,
                        outline=LINE)
            _txt(d, (x * SS, 108 * SS), f"d{int(dens)}", px=9 * SS, fill=MUTED)

    y = 140
    for nota in (prof.get("notas") or [])[:2]:
        _txt(d, (12 * SS, y * SS), _corta(nota, 78), px=10 * SS, fill=MUTED)
        y += 16
    return _finish(img, w, h)


def impresora(prof: dict, w: int = 420, h: int = 190):
    """Escala medida, respuesta tonal y tamaños mínimos detectables."""
    img, d = _panel(w, h)
    caja = [10, 22, 175, 150]
    _ejes(d, caja, xlab="gris enviado →", ylab="gris impreso ↑")
    tono = prof.get("tono") or []
    if tono:
        pares = sorted((float(t[0]), float(t[1])) for t in tono)
        xs = [p[0] for p in pares]
        ys = [p[1] for p in pares]
        _serie(d, caja, [0, 255], [min(ys), max(ys)], LINE, width=2,
               y_min=min(ys), y_max=max(ys))
        _serie(d, caja, xs, ys, MEAS, width=2, y_min=min(ys), y_max=max(ys))

    x = 192
    _txt(d, (x * SS, 20 * SS), "Perfil de impresora", px=13 * SS, fill=ACCENT)
    sx = float(prof.get("scale_x") or 1.0) * 100
    sy = float(prof.get("scale_y") or 1.0) * 100
    desvia = max(abs(sx - 100), abs(sy - 100)) > 3
    _txt(d, (x * SS, 46 * SS), f"Escala: {sx:.1f} % x {sy:.1f} %", px=12 * SS,
         fill=WARN if desvia else INK)
    _txt(d, (x * SS, 64 * SS),
         "se compensa al generar" if abs(sx - 100) > 0.2 or abs(sy - 100) > 0.2
         else "imprime a tamaño real", px=10 * SS, fill=MUTED)

    mk = prof.get("marker_recomendado_mm")
    qr = prof.get("qr_recomendado_mm")
    _txt(d, (x * SS, 90 * SS), "Tamaños seguros", px=11 * SS, fill=INK)
    _txt(d, (x * SS, 108 * SS), f"marcador  {mk:g} mm" if mk else
         "marcador  —", px=11 * SS, fill=MUTED)
    _txt(d, (x * SS, 124 * SS), f"QR        {qr:g} mm" if qr else "QR        —",
         px=11 * SS, fill=MUTED)
    minmk = prof.get("marker_min_mm")
    if minmk:
        _txt(d, (x * SS, 146 * SS), f"(el menor detectado: {minmk:g} mm)",
             px=9 * SS, fill=MUTED)
    return _finish(img, w, h)


def _corta(texto: str, n: int) -> str:
    t = " ".join(str(texto).split())
    return t if len(t) <= n else t[: n - 1] + "…"


def para_perfil(prof: dict, w: int = 420, h: int = 190):
    """Elige el gráfico que corresponde al tipo de perfil (o None)."""
    tipo = (prof or {}).get("tipo")
    if tipo == "cianotipia":
        return curva_cianotipia(prof, w, h)
    if tipo == "cianotipia_color":
        return colorblocker(prof, w, h)
    if tipo == "impresora":
        return impresora(prof, w, h)
    return None
