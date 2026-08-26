"""Diagramas de las guías paso a paso (los botones «?» de la interfaz).

Cada paso de una guía (ver guides.py) puede llevar el nombre de un diagrama;
aquí se DIBUJA con Pillow, sin archivos externos, para que el ejecutable siga
siendo un único binario y los dibujos se vean nítidos en cualquier pantalla.

Filosofía de los dibujos: enseñar la FÍSICA del paso, no decorar. Cada diagrama
muestra el objeto real que se tiene delante en ese momento (la hoja, el
acetato, el sol, el escáner, la curva medida) y, cuando el paso trata de un
error frecuente, muestra el contraste correcto/incorrecto.

Uso:
    img = guide_art.render("cya_exponer", ancho=132)   # PIL.Image RGB

Los dibujos se componen a 3× y se reducen con LANCZOS (antialiasing), y se
cachean por (nombre, ancho).
"""

from __future__ import annotations

import math

from PIL import Image, ImageDraw

from . import fonts as fontmod
from .core import _load_font

# Paleta (coherente con gui_common.PALETTE; duplicada aquí para que el módulo
# se pueda usar sin Tk, p. ej. desde las pruebas).
BG = "#FFFFFF"
INK = "#243038"
MUTED = "#8896A2"
LINE = "#C7D0D8"
ACCENT = "#1FA37A"
ACCENT_SOFT = "#D8EFE7"
CYAN = "#17315C"
CYAN_SOFT = "#5C7FB8"
PAPER = "#F6F3E7"
WARN = "#B4562F"
SUN = "#E8A33D"

# Lienzo lógico de todos los diagramas (se escala al ancho pedido).
W, H = 132, 96
SS = 3  # supermuestreo

_CACHE: dict = {}


# ────────────────────────────────────────────────────────────────
# Primitivas
# ────────────────────────────────────────────────────────────────

def _font(px: int):
    # Fuente del sistema (ver fonts.ui_font_path): con la de Pillow por
    # defecto, las etiquetas con acentos saldrían como cuadrados.
    return _load_font(fontmod.ui_font_path(), max(6, int(px)))


def _text(d, xy, txt, px=9, fill=INK, anchor="lt"):
    """Texto en coordenadas lógicas. La fuente se pide ya multiplicada por la
    escala del lienzo (el proxy escala coordenadas, no tamaños de fuente)."""
    fuente = _font(px * getattr(d, "_k", 1))
    try:
        d.text(xy, txt, fill=fill, font=fuente, anchor=anchor)
    except Exception:          # anclas no soportadas en Pillow antiguo
        d.text(xy, txt, fill=fill, font=fuente)


def _sheet(d, box, fill=BG, outline=LINE, width=2, radius=3):
    """Hoja de papel (rectángulo redondeado)."""
    try:
        d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline,
                            width=width)
    except AttributeError:
        d.rectangle(box, fill=fill, outline=outline, width=width)


def _marker(d, x, y, s, dark=INK, light=BG):
    """Marcador ArUco esquemático (marco oscuro + celdas)."""
    d.rectangle([x, y, x + s, y + s], fill=dark)
    c = max(1, s // 4)
    d.rectangle([x + c, y + c, x + s - c, y + s - c], fill=light)
    d.rectangle([x + c, y + c, x + 2 * c - 1, y + 2 * c - 1], fill=dark)


def _qr(d, x, y, s, dark=INK, light=BG):
    """QR esquemático: marco + tres ojos + ruido regular."""
    d.rectangle([x, y, x + s, y + s], fill=light, outline=dark, width=1)
    o = max(2, s // 4)
    for ox, oy in ((0, 0), (s - o, 0), (0, s - o)):
        d.rectangle([x + ox + 1, y + oy + 1, x + ox + o - 1, y + oy + o - 1],
                    outline=dark, width=1)
    step = max(2, s // 7)
    for i in range(o + 2, s - 2, step):
        for j in range(o + 2, s - 2, step):
            if (i + j) % (2 * step) == 0:
                d.rectangle([x + i, y + j, x + i + step - 2, y + j + step - 2],
                            fill=dark)


def _frame(d, box, fill="#DDE5EC", outline=None):
    """Fotograma dentro de una celda (rectángulo con un 'paisaje' mínimo)."""
    x1, y1, x2, y2 = box
    d.rectangle(box, fill=fill, outline=outline)
    h = y2 - y1
    d.polygon([(x1, y2), (x1 + (x2 - x1) * 0.42, y1 + h * 0.35),
               (x1 + (x2 - x1) * 0.72, y2)], fill="#AEC0CE")
    r = max(1, h // 7)
    d.ellipse([x2 - r * 3, y1 + r, x2 - r, y1 + r * 3], fill="#F2C879")


def _arrow(d, p1, p2, fill=ACCENT, width=3, head=7):
    """Flecha recta con punta."""
    x1, y1 = p1
    x2, y2 = p2
    d.line([p1, p2], fill=fill, width=width)
    ang = math.atan2(y2 - y1, x2 - x1)
    for s in (0.6, -0.6):
        d.line([(x2, y2),
                (x2 - head * math.cos(ang - s), y2 - head * math.sin(ang - s))],
               fill=fill, width=width)


def _sun(d, cx, cy, r, fill=SUN):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)
    for k in range(8):
        a = k * math.pi / 4
        d.line([(cx + r * 1.35 * math.cos(a), cy + r * 1.35 * math.sin(a)),
                (cx + r * 2.05 * math.cos(a), cy + r * 2.05 * math.sin(a))],
               fill=fill, width=3)


def _printer(d, box, body="#596B79"):
    """Impresora esquemática (cuerpo + bandeja)."""
    x1, y1, x2, y2 = box
    d.rectangle([x1, y1 + (y2 - y1) * 0.35, x2, y2], fill=body)
    d.rectangle([x1 + (x2 - x1) * 0.15, y1, x2 - (x2 - x1) * 0.15,
                 y1 + (y2 - y1) * 0.4], fill="#7C8C99")
    d.rectangle([x1 + (x2 - x1) * 0.12, y2 - (y2 - y1) * 0.28,
                 x2 - (x2 - x1) * 0.12, y2 - (y2 - y1) * 0.1], fill=BG)


def _scanner(d, box, glass="#2B3B49"):
    """Escáner esquemático: tapa, cristal y barra de luz."""
    x1, y1, x2, y2 = box
    d.rectangle([x1, y1, x2, y2], fill=glass)
    d.rectangle([x1 + 3, y1 + 3, x2 - 3, y2 - 8], fill="#E9EEF2")
    d.line([(x1 + 6, y2 - 12), (x2 - 6, y2 - 12)], fill=ACCENT, width=3)


def _acetate(d, box, tint=(90, 170, 210)):
    """Acetato: cuadrícula de transparencia con un velo azulado."""
    x1, y1, x2, y2 = box
    d.rectangle(box, fill="#FFFFFF")
    c = 6
    for j, yy in enumerate(range(int(y1), int(y2), c)):
        for i, xx in enumerate(range(int(x1), int(x2), c)):
            if (i + j) % 2 == 0:
                d.rectangle([xx, yy, min(xx + c, x2), min(yy + c, y2)],
                            fill="#E7EDF1")
    d.rectangle(box, outline="#9FB6C6", width=2)


def _plot_axes(d, box):
    x1, y1, x2, y2 = box
    d.rectangle(box, fill=BG, outline=LINE, width=2)
    d.line([(x1 + 3, y2 - 3), (x2 - 3, y2 - 3)], fill=MUTED, width=1)
    d.line([(x1 + 3, y1 + 3), (x1 + 3, y2 - 3)], fill=MUTED, width=1)


def _plot_curve(d, box, f, fill=ACCENT, width=3, pts=28):
    """Dibuja y = f(x) con x, y en 0..1 dentro de box (y hacia arriba)."""
    x1, y1, x2, y2 = box
    x1, y1, x2, y2 = x1 + 4, y1 + 4, x2 - 4, y2 - 4
    puntos = []
    for i in range(pts + 1):
        t = i / pts
        v = min(1.0, max(0.0, f(t)))
        puntos.append((x1 + t * (x2 - x1), y2 - v * (y2 - y1)))
    d.line(puntos, fill=fill, width=width, joint="curve")


def _ramp(d, box, n=8, dark=INK, light=BG):
    """Rampa de parches de tono."""
    x1, y1, x2, y2 = box
    w = (x2 - x1) / n
    for i in range(n):
        v = i / (n - 1)
        col = tuple(int(round(_lerp(_rgb(dark)[c], _rgb(light)[c], v)))
                    for c in range(3))
        d.rectangle([x1 + i * w, y1, x1 + (i + 1) * w - 1, y2], fill=col)


def _rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _lerp(a, b, t):
    return a + (b - a) * t


def _grid_sheet(d, box, cols=2, rows=2, qr=False, markers=False,
                frame_fill="#DDE5EC", sheet_fill=BG, outline=LINE):
    """Hoja con una cuadrícula de fotogramas (y opcionalmente QRs/marcadores)."""
    _sheet(d, box, fill=sheet_fill, outline=outline)
    x1, y1, x2, y2 = box
    pad = 10 if markers else 7
    gx1, gy1, gx2, gy2 = x1 + pad, y1 + pad, x2 - pad, y2 - pad
    cw = (gx2 - gx1) / cols
    ch = (gy2 - gy1) / rows
    for r in range(rows):
        for c in range(cols):
            fx1 = gx1 + c * cw + 2
            fy1 = gy1 + r * ch + 2
            fx2 = gx1 + (c + 1) * cw - 2
            fy2 = gy1 + (r + 1) * ch - (8 if qr else 2)
            if fx2 - fx1 > 4 and fy2 - fy1 > 4:
                _frame(d, [fx1, fy1, fx2, fy2], fill=frame_fill)
            if qr and fy2 + 7 < gy2 + 6:
                _qr(d, fx1 + 1, fy2 + 1, 6, dark=INK, light=sheet_fill)
    if markers:
        s = 7
        for mx, my in ((x1 + 2, y1 + 2), (x2 - s - 2, y1 + 2),
                       (x1 + 2, y2 - s - 2), (x2 - s - 2, y2 - s - 2),
                       ((x1 + x2) / 2 - s / 2, y1 + 2),
                       ((x1 + x2) / 2 - s / 2, y2 - s - 2)):
            _marker(d, mx, my, s, dark=INK, light=sheet_fill)


def _cross(d, box, fill=WARN, width=3):
    x1, y1, x2, y2 = box
    d.line([(x1, y1), (x2, y2)], fill=fill, width=width)
    d.line([(x1, y2), (x2, y1)], fill=fill, width=width)


def _check(d, x, y, s=10, fill=ACCENT, width=3):
    d.line([(x, y + s * 0.5), (x + s * 0.38, y + s), (x + s, y)],
           fill=fill, width=width, joint="curve")


# ────────────────────────────────────────────────────────────────
# Diagramas (uno por paso de guía)
# ────────────────────────────────────────────────────────────────

def _d_flujo_calibrar(d):
    _sheet(d, [12, 8, 78, 88])
    _ramp(d, [20, 20, 70, 32])
    for mx, my in ((15, 11), (68, 11), (15, 78), (68, 78)):
        _marker(d, mx, my, 7)
    _qr(d, 20, 40, 14)
    _plot_axes(d, [86, 34, 126, 76])
    _plot_curve(d, [86, 34, 126, 76], lambda t: t ** 0.45)
    _arrow(d, (80, 56), (84, 56), head=5)


def _d_flujo_hojas(d):
    _grid_sheet(d, [10, 8, 74, 88], 2, 3, qr=True, markers=True)
    _arrow(d, (80, 48), (98, 48))
    _grid_sheet(d, [102, 20, 128, 76], 1, 2)


def _d_flujo_fisico(d):
    _sheet(d, [8, 20, 66, 84], fill=PAPER)
    _frame(d, [16, 30, 58, 60], fill="#C9D6E0")
    d.line([(20, 66), (52, 74)], fill=ACCENT, width=5)
    _sun(d, 100, 30, 9)
    _acetate(d, [80, 48, 124, 84])
    _arrow(d, (100, 40), (100, 46), head=5)


def _d_flujo_escanear(d):
    _scanner(d, [8, 12, 70, 84])
    _sheet(d, [16, 22, 62, 66], fill=PAPER)
    _frame(d, [21, 28, 57, 50], fill="#C9D6E0")
    _arrow(d, (74, 48), (92, 48))
    for i in range(3):
        _frame(d, [98, 16 + i * 25, 128, 36 + i * 25], fill="#DDE5EC")


def _d_flujo_video(d):
    d.rectangle([8, 26, 124, 70], fill="#2B3B49")
    for i in range(5):
        x = 12 + i * 23
        _frame(d, [x, 34, x + 19, 62], fill="#B9C9D6")
    for i in range(6):
        x = 10 + i * 20
        d.rectangle([x, 28, x + 8, 32], fill="#8CA0B0")
        d.rectangle([x, 64, x + 8, 68], fill="#8CA0B0")
    _arrow(d, (46, 82), (86, 82), width=3)


# ── Calibración de impresora ────────────────────────────────────

def _d_imp_pagina(d):
    _sheet(d, [22, 6, 110, 90])
    for mx, my in ((26, 10), (97, 10), (26, 77), (97, 77), (62, 10), (62, 77)):
        _marker(d, mx, my, 8)
    _ramp(d, [30, 26, 102, 40], n=10)
    for i, s in enumerate((6, 8, 10)):
        _marker(d, 32 + i * 20, 50, s)
    for i, s in enumerate((7, 9)):
        _qr(d, 34 + i * 22, 64, s + 2)


def _d_imp_imprimir(d):
    _printer(d, [10, 40, 72, 84])
    _sheet(d, [22, 6, 62, 44], fill=BG)
    _ramp(d, [27, 14, 57, 22], n=6)
    d.rounded_rectangle([80, 22, 126, 42], radius=6, fill=ACCENT_SOFT,
                        outline=ACCENT, width=2)
    _text(d, (103, 32), "100%", px=12, fill="#15795A", anchor="mm")
    d.rounded_rectangle([80, 52, 126, 72], radius=6, fill="#F6E4DC",
                        outline=WARN, width=2)
    _text(d, (103, 62), "ajustar", px=9, fill=WARN, anchor="mm")
    _cross(d, [84, 54, 122, 70], width=2)


def _d_imp_escanear(d):
    _scanner(d, [6, 16, 92, 88])
    _sheet(d, [14, 24, 84, 72], fill=BG)
    _ramp(d, [20, 32, 78, 42], n=8)
    for mx, my in ((17, 27), (74, 27), (17, 62), (74, 62)):
        _marker(d, mx, my, 7)
    d.rectangle([10, 20, 88, 76], outline=ACCENT, width=2)
    _text(d, (110, 44), "300", px=10, fill=ACCENT, anchor="mm")
    _text(d, (110, 56), "DPI", px=9, fill=MUTED, anchor="mm")


def _d_imp_analizar(d):
    _sheet(d, [10, 16, 84, 82])
    for mx, my in ((14, 20), (71, 20), (14, 69), (71, 69)):
        _marker(d, mx, my, 7)
    d.line([(21, 46), (74, 46)], fill=ACCENT, width=2)
    for x in (21, 74):
        d.line([(x, 40), (x, 52)], fill=ACCENT, width=2)
    _text(d, (47, 34), "96.5%", px=11, fill="#15795A", anchor="mm")
    _plot_axes(d, [92, 30, 126, 70])
    _plot_curve(d, [92, 30, 126, 70], lambda t: t ** 1.6, fill=CYAN_SOFT)


def _d_imp_guardar(d):
    d.rounded_rectangle([16, 22, 116, 76], radius=8, fill=ACCENT_SOFT,
                        outline=ACCENT, width=2)
    _printer(d, [26, 36, 62, 64], body="#15795A")
    _check(d, 74, 42, 14)
    _text(d, (74, 62), "perfil", px=10, fill="#15795A")


# ── Calibración de cianotipia ───────────────────────────────────

def _d_cya_colorblocker(d):
    _sheet(d, [8, 12, 124, 84], fill="#101820", outline="#33414D")
    cols = [(214, 64, 60), (226, 132, 48), (222, 200, 60), (110, 196, 90),
            (70, 178, 190), (74, 116, 206), (140, 96, 200), (208, 92, 168)]
    for i, c in enumerate(cols):
        for j in range(5):
            v = 0.25 + 0.75 * (j / 4)
            col = tuple(int(round(ch * v)) for ch in c)
            d.rectangle([14 + i * 13, 20 + j * 12, 24 + i * 13, 30 + j * 12],
                        fill=col)
    d.rectangle([13, 19, 25, 31], outline=ACCENT, width=2)


def _d_cya_carta(d):
    _sheet(d, [16, 6, 116, 90], fill="#101820", outline="#33414D")
    for mx, my in ((20, 10), (103, 10), (20, 77), (103, 77)):
        _marker(d, mx, my, 8, dark="#101820", light="#FFFFFF")
    for i in range(7):
        for j in range(3):
            v = int(round(255 * (i * 3 + j) / 20))
            d.rectangle([26 + j * 28, 24 + i * 8, 50 + j * 28, 30 + i * 8],
                        fill=(v, v, v))


def _d_cya_acetato(d):
    _printer(d, [8, 44, 66, 86])
    _acetate(d, [20, 6, 62, 48])
    for i in range(4):
        v = int(round(255 * i / 3))
        d.rectangle([26, 12 + i * 8, 56, 18 + i * 8], fill=(v, v, v))
    d.rounded_rectangle([76, 30, 126, 60], radius=6, fill=ACCENT_SOFT,
                        outline=ACCENT, width=2)
    _text(d, (101, 38), "max", px=10, fill="#15795A", anchor="mm")
    _text(d, (101, 51), "calidad", px=9, fill="#15795A", anchor="mm")


def _d_cya_exponer(d):
    _sun(d, 30, 20, 9)
    for k in range(4):
        x = 56 + k * 14
        _arrow(d, (x, 12), (x, 40), fill=SUN, width=2, head=5)
    _acetate(d, [46, 38, 124, 56])
    d.rectangle([46, 56, 124, 78], fill=CYAN)
    d.rectangle([60, 60, 110, 74], fill="#7FA0CE")
    _text(d, (85, 88), "acetato sobre papel", px=8, fill=MUTED, anchor="mm")


def _d_cya_secar(d):
    d.rectangle([8, 24, 60, 76], fill="#3C6094")
    _text(d, (34, 86), "humedo", px=9, fill=MUTED, anchor="mm")
    _arrow(d, (64, 50), (76, 50), head=6)
    d.rectangle([80, 24, 124, 76], fill=CYAN)
    _text(d, (102, 86), "seco", px=9, fill=CYAN, anchor="mm")


def _d_cya_escanear(d):
    _scanner(d, [8, 14, 88, 86])
    d.rectangle([16, 22, 80, 70], fill=CYAN)
    for i in range(4):
        v = 40 + i * 55
        d.rectangle([22, 28 + i * 10, 74, 35 + i * 10],
                    fill=(v // 2, v // 2 + 20, min(255, v + 60)))
    _text(d, (108, 42), "copia", px=9, fill=CYAN, anchor="mm")
    _text(d, (108, 54), "azul", px=9, fill=CYAN, anchor="mm")


def _d_cya_curva(d):
    caja = [10, 10, 78, 82]
    _plot_axes(d, caja)
    _plot_curve(d, caja, lambda t: t, fill=LINE, width=2)
    _plot_curve(d, caja, lambda t: t ** 2.2, fill=CYAN_SOFT, width=3)
    _plot_curve(d, caja, lambda t: t ** (1 / 2.2), fill=ACCENT, width=3)
    _text(d, (86, 24), "medido", px=8, fill=CYAN_SOFT)
    _text(d, (86, 44), "curva", px=8, fill=ACCENT)
    _text(d, (86, 64), "ideal", px=8, fill=MUTED)


# ── Escaneos ────────────────────────────────────────────────────

def _d_esc_escanear(d):
    _scanner(d, [6, 10, 92, 88])
    _grid_sheet(d, [14, 18, 84, 74], 2, 2, qr=True, markers=True,
                sheet_fill=PAPER)
    d.line([(20, 60), (60, 40)], fill="#B9552F", width=4)
    _text(d, (109, 40), "4", px=13, fill=ACCENT, anchor="mm")
    _text(d, (109, 56), "bordes", px=8, fill=MUTED, anchor="mm")


def _d_esc_archivos(d):
    for i, (x, lab) in enumerate(((6, "scans"), (90, "salida"))):
        d.polygon([(x, 34), (x + 14, 34), (x + 18, 28), (x + 36, 28),
                   (x + 36, 70), (x, 70)], fill="#E6C169")
        _text(d, (x + 18, 78), lab, px=9, fill=MUTED, anchor="mm")
    _sheet(d, [52, 26, 82, 72], fill=BG)
    _text(d, (67, 44), "{ }", px=13, fill=ACCENT, anchor="mm")
    _text(d, (67, 60), "json", px=9, fill=MUTED, anchor="mm")
    _arrow(d, (44, 48), (50, 48), head=5)
    _arrow(d, (84, 48), (88, 48), head=5)


def _d_esc_opciones(d):
    _frame(d, [16, 18, 116, 78], fill="#C9D6E0")
    for x in range(20, 114, 8):
        d.line([(x, 26), (x + 4, 26)], fill=ACCENT, width=2)
        d.line([(x, 70), (x + 4, 70)], fill=ACCENT, width=2)
    for y in range(30, 68, 8):
        d.line([(24, y), (24, y + 4)], fill=ACCENT, width=2)
        d.line([(108, y), (108, y + 4)], fill=ACCENT, width=2)
    _text(d, (66, 48), "bleed", px=10, fill="#15795A", anchor="mm")


def _d_esc_informe(d):
    _sheet(d, [10, 8, 80, 88])
    _grid_sheet(d, [16, 14, 74, 56], 2, 2, sheet_fill=BG, outline=None)
    for mx, my in ((17, 15), (66, 15)):
        _marker(d, mx, my, 6, dark=ACCENT)
    for mx, my in ((17, 48), (66, 48)):
        _marker(d, mx, my, 6, dark=WARN)
    for i in range(3):
        d.line([(18, 64 + i * 7), (72, 64 + i * 7)], fill=LINE, width=3)
    _check(d, 92, 30, 16)
    _text(d, (104, 62), "0.2 mm", px=9, fill=MUTED, anchor="mm")


def _d_esc_rescate(d):
    _sheet(d, [22, 10, 110, 86])
    d.ellipse([44, 26, 88, 70], outline=WARN, width=6)
    d.ellipse([54, 36, 78, 60], fill=BG)
    for a in (45, 135, 225, 315):
        r = math.radians(a)
        d.line([(66 + 14 * math.cos(r), 48 + 14 * math.sin(r)),
                (66 + 24 * math.cos(r), 48 + 24 * math.sin(r))],
               fill=BG, width=4)
    _frame(d, [28, 16, 44, 28], fill="#DDE5EC")
    _frame(d, [88, 68, 104, 80], fill="#DDE5EC")


# ── Marcadores ──────────────────────────────────────────────────

def _d_mk_aruco(d):
    _sheet(d, [12, 4, 120, 80])
    s = 11
    pos = [(16, 8), (61, 8), (105, 8), (16, 36), (105, 36),
           (16, 65), (61, 65), (105, 65)]
    for i, (x, y) in enumerate(pos):
        _marker(d, x, y, s)
        if i in (1, 4):
            d.line([(x - 2, y - 2), (x + s + 2, y + s + 2)], fill="#B9552F",
                   width=4)
    _frame(d, [36, 26, 96, 58], fill="#DDE5EC")
    _text(d, (66, 89), "bastan 3 visibles", px=8, fill=MUTED, anchor="mm")


def _d_mk_qr(d):
    _frame(d, [24, 10, 108, 56], fill="#C9D6E0")
    _qr(d, 30, 62, 24)
    d.line([(60, 68), (104, 68)], fill=INK, width=4)
    d.line([(60, 78), (92, 78)], fill=LINE, width=4)
    _text(d, (66, 90), "hoja / celda / nombre", px=8, fill=MUTED, anchor="mm")


def _d_mk_layout(d):
    _sheet(d, [8, 22, 52, 76], fill=BG)
    _text(d, (30, 40), "{ }", px=15, fill=ACCENT, anchor="mm")
    _text(d, (30, 60), "layout", px=9, fill=MUTED, anchor="mm")
    _arrow(d, (56, 48), (72, 48))
    _grid_sheet(d, [76, 16, 126, 82], 1, 2, qr=True, markers=True)


def _d_mk_grises(d):
    _sheet(d, [30, 8, 118, 88])
    for i in range(6):
        v = int(round(255 * i / 5))
        d.rectangle([36, 16 + i * 12, 54, 26 + i * 12], fill=(v, v, v),
                    outline=LINE)
    _frame(d, [62, 22, 110, 66], fill="#DDE5EC")
    _text(d, (66, 90), "referencia del escaner", px=8, fill=MUTED, anchor="mm")


# ── Cianotipia (hoja) ───────────────────────────────────────────

def _d_cy_invertido(d):
    _frame(d, [8, 20, 58, 66], fill="#D6E1EA")
    _arrow(d, (62, 44), (74, 44), head=6)
    d.rectangle([78, 20, 128, 66], fill="#2A3540")
    d.polygon([(78, 66), (99, 36), (114, 66)], fill="#54606C")
    d.ellipse([116, 26, 124, 34], fill="#101820")
    _text(d, (33, 80), "original", px=9, fill=MUTED, anchor="mm")
    _text(d, (103, 80), "negativo", px=9, fill=CYAN, anchor="mm")


def _d_cy_triangulo(d):
    d.rectangle([8, 8, 124, 88], fill=CYAN)
    _marker(d, 20, 32, 26, dark=CYAN, light="#FFFFFF")
    d.rectangle([58, 34, 84, 60], fill="#FFFFFF")
    d.polygon([(64, 38), (80, 47), (64, 56)], fill=CYAN)
    _check(d, 96, 40, 16, fill="#9FE7C9")
    _text(d, (66, 78), "apunta a la derecha", px=9, fill="#CFE0F2", anchor="mm")


def _d_cy_borde(d):
    d.rectangle([8, 6, 124, 78], fill=CYAN)
    d.rectangle([26, 16, 106, 68], fill="#FFFFFF")
    d.rectangle([32, 22, 100, 62], fill="#4A6E9E")
    d.polygon([(32, 62), (58, 34), (80, 62)], fill="#87A6CE")
    _text(d, (66, 88), "filo blanco = luz bloqueada", px=8, fill=MUTED,
          anchor="mm")


def _d_cy_halos(d):
    d.rectangle([8, 8, 124, 88], fill=CYAN)
    for x, y in ((14, 14), (96, 14), (14, 66), (96, 66)):
        d.rectangle([x, y, x + 22, y + 20], fill="#FFFFFF")
        _marker(d, x + 5, y + 4, 12, dark=CYAN, light="#FFFFFF")
    d.rectangle([44, 38, 90, 58], fill="#FFFFFF")
    _qr(d, 48, 41, 14, dark=CYAN, light="#FFFFFF")
    d.line([(66, 48), (86, 48)], fill=CYAN, width=3)


def _d_cy_bloqueador(d):
    d.rectangle([10, 16, 62, 76], fill="#101820")
    for y in range(22, 74, 9):
        d.line([(12, y), (60, y)], fill="#3B4652", width=3)
    _cross(d, [22, 34, 50, 58], width=4)
    _text(d, (36, 88), "negro 100%", px=9, fill=WARN, anchor="mm")
    d.rectangle([70, 16, 122, 76], fill="#241A32")
    _check(d, 88, 38, 16)
    _text(d, (96, 88), "color denso", px=9, fill="#15795A", anchor="mm")


def _d_cy_curva(d):
    caja = [8, 8, 66, 66]
    _plot_axes(d, caja)
    _plot_curve(d, caja, lambda t: t ** (1 / 2.2), fill=ACCENT)
    for i in range(5):
        v = int(round(40 + 200 * i / 4))
        d.rectangle([74, 8 + i * 12, 124, 18 + i * 12], fill=(v, v, v))
    _text(d, (99, 76), "escalonado", px=8, fill=WARN, anchor="mm")
    for i in range(50):
        v = int(round(40 + 200 * i / 49))
        d.rectangle([8 + i, 74, 9 + i, 86], fill=(v, v, v))
    _text(d, (36, 90), "con dithering", px=8, fill="#15795A", anchor="mm")


# ── Fase ② (hojas) ──────────────────────────────────────────────

def _d_src_video(d):
    d.rectangle([8, 24, 60, 72], fill="#2B3B49")
    d.polygon([(28, 36), (48, 48), (28, 60)], fill="#FFFFFF")
    _text(d, (34, 82), "video", px=9, fill=MUTED, anchor="mm")
    d.polygon([(72, 30), (86, 30), (90, 24), (118, 24), (118, 72), (72, 72)],
              fill="#E6C169")
    _text(d, (95, 82), "carpeta", px=9, fill=MUTED, anchor="mm")


def _d_src_rango(d):
    d.rounded_rectangle([10, 40, 122, 56], radius=6, fill="#E3E8EC",
                        outline=LINE, width=2)
    d.rounded_rectangle([38, 40, 94, 56], radius=6, fill=ACCENT_SOFT,
                        outline=ACCENT, width=2)
    for x in (38, 94):
        d.rectangle([x - 3, 34, x + 3, 62], fill=ACCENT)
    _text(d, (38, 24), "inicio", px=9, fill=MUTED, anchor="mm")
    _text(d, (94, 24), "fin", px=9, fill=MUTED, anchor="mm")
    _text(d, (66, 76), "segundos", px=9, fill=MUTED, anchor="mm")


def _d_grid_fps(d):
    d.line([(8, 62), (124, 62)], fill=LINE, width=2)
    for i in range(12):
        x = 12 + i * 9.5
        alto = 14 if i % 3 == 0 else 7
        col = ACCENT if i % 3 == 0 else LINE
        d.line([(x, 62), (x, 62 - alto)], fill=col, width=3)
    for i in range(4):
        _frame(d, [10 + i * 30, 12, 34 + i * 30, 34], fill="#DDE5EC")
        _arrow(d, (22 + i * 30, 56), (22 + i * 30, 38), head=5)
    _text(d, (66, 80), "1 de cada N", px=9, fill=MUTED, anchor="mm")


def _d_grid_cuadricula(d):
    _grid_sheet(d, [12, 4, 78, 82], 2, 3, qr=False)
    _text(d, (45, 90), "2 x 3", px=9, fill=MUTED, anchor="mm")
    _arrow(d, (82, 48), (94, 48), head=5)
    _text(d, (112, 40), "6", px=15, fill=ACCENT, anchor="mm")
    _text(d, (112, 58), "por hoja", px=8, fill=MUTED, anchor="mm")


def _d_grid_seleccion(d):
    for i in range(6):
        x = 8 + i * 20
        activo = i in (0, 2, 3, 4)
        _frame(d, [x, 30, x + 16, 58], fill="#DDE5EC" if activo else "#EFF2F4")
        if not activo:
            _cross(d, [x + 2, 32, x + 14, 56], width=3)
    _text(d, (66, 76), '"1, 3-5"', px=11, fill=ACCENT, anchor="mm")


def _d_grid_dedup(d):
    for i in range(4):
        _frame(d, [8 + i * 24, 20, 28 + i * 24, 46], fill="#DDE5EC")
    d.rounded_rectangle([30, 16, 100, 50], radius=6, outline=ACCENT, width=2)
    _arrow(d, (66, 54), (66, 64), head=5)
    _frame(d, [46, 66, 86, 88], fill="#DDE5EC")
    _text(d, (110, 78), "x3", px=11, fill=ACCENT, anchor="mm")


def _d_hoja_tamano(d):
    _sheet(d, [30, 6, 102, 90])
    d.rectangle([38, 16, 94, 80], outline=ACCENT, width=2)
    for x in (34, 98):
        d.line([(x, 16), (x, 80)], fill=MUTED, width=1)
    _arrow(d, (34, 48), (38, 48), fill=MUTED, width=2, head=4)
    _arrow(d, (98, 48), (94, 48), fill=MUTED, width=2, head=4)
    _text(d, (66, 48), "margen", px=9, fill="#15795A", anchor="mm")
    _text(d, (12, 48), "A4", px=11, fill=MUTED, anchor="mm")


def _d_hoja_perfil(d):
    _sheet(d, [10, 20, 58, 76], fill=BG)
    d.rectangle([14, 24, 54, 72], outline=LINE, width=1)
    _arrow(d, (62, 48), (74, 48), head=6)
    _sheet(d, [78, 16, 126, 80], fill=BG, outline=ACCENT)
    d.rectangle([82, 20, 122, 76], outline=ACCENT, width=1)
    _text(d, (34, 88), "96.5%", px=9, fill=WARN, anchor="mm")
    _text(d, (102, 88), "compensado", px=9, fill="#15795A", anchor="mm")


def _d_nombres(d):
    _frame(d, [16, 12, 116, 58], fill="#C9D6E0")
    _qr(d, 26, 64, 20)
    d.line([(54, 70), (106, 70)], fill=INK, width=4)
    d.line([(54, 80), (88, 80)], fill=LINE, width=3)
    _text(d, (66, 90), "abc_001", px=10, fill=MUTED, anchor="mm")


def _d_pagenum(d):
    _sheet(d, [22, 6, 110, 90])
    _grid_sheet(d, [28, 12, 104, 66], 2, 2, sheet_fill=BG, outline=None)
    d.rounded_rectangle([80, 70, 104, 84], radius=4, fill=ACCENT_SOFT,
                        outline=ACCENT, width=2)
    _text(d, (92, 77), "03", px=11, fill="#15795A", anchor="mm")


def _d_salida(d):
    for i, (x, lab, col) in enumerate(((8, "PNG", ACCENT),
                                       (50, "PDF", "#B4562F"),
                                       (92, "TIFF", CYAN_SOFT))):
        _sheet(d, [x, 20, x + 32, 72], fill=BG)
        d.polygon([(x + 22, 20), (x + 32, 30), (x + 22, 30)], fill=LINE)
        _text(d, (x + 16, 50), lab, px=10, fill=col, anchor="mm")


def _d_video_final(d):
    for i in range(3):
        _frame(d, [8, 8 + i * 28, 40, 30 + i * 28], fill="#DDE5EC")
    _arrow(d, (46, 48), (60, 48))
    d.rectangle([66, 26, 124, 70], fill="#2B3B49")
    for i in range(3):
        _frame(d, [70 + i * 19, 34, 84 + i * 19, 62], fill="#B9C9D6")
    _text(d, (95, 82), "orden original", px=9, fill=MUTED, anchor="mm")


DIAGRAMS = {
    "flujo_calibrar": _d_flujo_calibrar,
    "flujo_hojas": _d_flujo_hojas,
    "flujo_fisico": _d_flujo_fisico,
    "flujo_escanear": _d_flujo_escanear,
    "flujo_video": _d_flujo_video,
    "imp_pagina": _d_imp_pagina,
    "imp_imprimir": _d_imp_imprimir,
    "imp_escanear": _d_imp_escanear,
    "imp_analizar": _d_imp_analizar,
    "imp_guardar": _d_imp_guardar,
    "cya_colorblocker": _d_cya_colorblocker,
    "cya_carta": _d_cya_carta,
    "cya_acetato": _d_cya_acetato,
    "cya_exponer": _d_cya_exponer,
    "cya_secar": _d_cya_secar,
    "cya_escanear": _d_cya_escanear,
    "cya_curva": _d_cya_curva,
    "esc_escanear": _d_esc_escanear,
    "esc_archivos": _d_esc_archivos,
    "esc_opciones": _d_esc_opciones,
    "esc_informe": _d_esc_informe,
    "esc_rescate": _d_esc_rescate,
    "mk_aruco": _d_mk_aruco,
    "mk_qr": _d_mk_qr,
    "mk_layout": _d_mk_layout,
    "mk_grises": _d_mk_grises,
    "cy_invertido": _d_cy_invertido,
    "cy_triangulo": _d_cy_triangulo,
    "cy_borde": _d_cy_borde,
    "cy_halos": _d_cy_halos,
    "cy_bloqueador": _d_cy_bloqueador,
    "cy_curva": _d_cy_curva,
    "src_video": _d_src_video,
    "src_rango": _d_src_rango,
    "grid_fps": _d_grid_fps,
    "grid_cuadricula": _d_grid_cuadricula,
    "grid_seleccion": _d_grid_seleccion,
    "grid_dedup": _d_grid_dedup,
    "hoja_tamano": _d_hoja_tamano,
    "hoja_perfil": _d_hoja_perfil,
    "nombres": _d_nombres,
    "pagenum": _d_pagenum,
    "salida": _d_salida,
    "video_final": _d_video_final,
}


def render(nombre: str, ancho: int = W) -> Image.Image | None:
    """Dibuja el diagrama `nombre` a `ancho` píxeles (alto proporcional).

    Devuelve None si el nombre no existe (así una guía puede nombrar un
    diagrama que todavía no está dibujado sin romper la interfaz).
    """
    fn = DIAGRAMS.get(nombre)
    if fn is None:
        return None
    clave = (nombre, int(ancho))
    hit = _CACHE.get(clave)
    if hit is not None:
        return hit
    grande = Image.new("RGB", (W * SS, H * SS), BG)
    # Los diagramas se escriben en coordenadas lógicas (132×96) pero se pintan
    # a SS× mediante un proxy que multiplica coordenadas y grosores; reducir
    # después con LANCZOS es lo que les da los bordes suaves.
    fn(_ScaledDraw(ImageDraw.Draw(grande), SS))
    alto = max(1, int(round(H * ancho / W)))
    img = grande.resize((int(ancho), alto), Image.LANCZOS)
    if len(_CACHE) > 120:
        _CACHE.clear()
    _CACHE[clave] = img
    return img


class _ScaledDraw:
    """Proxy de ImageDraw que multiplica todas las coordenadas por `k`.

    Permite escribir los diagramas en un lienzo lógico de 132×96 y dibujarlos
    en realidad a 3× para reducirlos después con antialiasing.
    """

    _COORD_METHODS = {"line", "rectangle", "rounded_rectangle", "polygon",
                      "ellipse", "arc", "chord", "pieslice", "point", "text"}

    def __init__(self, draw, k):
        self._d = draw
        self._k = k

    def __getattr__(self, name):
        attr = getattr(self._d, name)
        if name not in self._COORD_METHODS:
            return attr

        def wrapped(xy, *args, **kwargs):
            for clave in ("width", "radius"):
                if isinstance(kwargs.get(clave), (int, float)):
                    kwargs[clave] = max(1, int(round(kwargs[clave] * self._k)))
            return attr(self._scale(xy), *args, **kwargs)
        return wrapped

    def _scale(self, xy):
        k = self._k
        if isinstance(xy, (list, tuple)) and xy and isinstance(
                xy[0], (int, float)):
            return [v * k for v in xy]
        if isinstance(xy, (list, tuple)):
            return [tuple(v * k for v in p) for p in xy]
        return xy

    def text(self, xy, txt, *args, **kwargs):
        return self._d.text(tuple(v * self._k for v in xy), txt, *args,
                            **kwargs)
