"""Calibración de impresora y de proceso de cianotipia.

CALIBRACIÓN DE IMPRESORA
    1. La app genera una PÁGINA DE PRUEBA con marcadores ArUco de posición
       conocida, una rampa de tonos y marcadores/QRs de varios tamaños.
    2. Kamila la imprime al 100 % (sin "ajustar a página") y la escanea.
    3. La app analiza el escaneo y mide:
       - la ESCALA real de impresión (si la impresora encoge/estira la página),
       - la RESPUESTA TONAL (cómo imprime los grises),
       - el TAMAÑO MÍNIMO de marcador ArUco y de QR que se detectan bien.
    4. Todo se guarda como un PERFIL DE IMPRESORA que luego se aplica al
       generar hojas (compensación de escala, tamaños recomendados).

CALIBRACIÓN DE CIANOTIPIA (estilo "easy digital negatives", integrado)
    1. La app genera una TIRA DE CALIBRACIÓN: un negativo para acetato con
       parches de densidad conocida (de transparente a tinta plena), con el
       mismo color de tinta y espejado que usará en sus negativos reales.
    2. Kamila la imprime en acetato, expone la cianotipia al sol, la revela,
       la seca y la escanea.
    3. La app mide el tono azul real que produjo cada densidad y construye la
       CURVA DE COMPENSACIÓN (LUT) que lineariza los tonos y aprovecha todo el
       rango dinámico del proceso (su impresora + su acetato + su química +
       su sol). También informa el rango dinámico logrado y da sugerencias.
    4. La curva se guarda como PERFIL DE CIANOTIPIA y se aplica al generar
       los negativos.
"""

from __future__ import annotations

import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

from . import cyanotype as cyan
from . import markers, paper
from .core import _load_font, _text_size
from .scan import (_detect_markers_multi, _estimate_scale,
                   _refine_corners_fullres, _to_u8, leer_imagen_robusta)

# Geometría fija de las páginas de calibración (en mm).
CAL_MARKER_MM = 10.0      # lado de los marcadores de registro
CAL_MARGIN_MM = 5.0       # margen de los marcadores al borde
RAMP_STEPS = 21           # pasos de la rampa tonal (0..100 %)
SIZE_TEST_MM = [4.0, 5.0, 6.0, 8.0, 10.0, 12.0]   # tamaños de ArUco a probar
SIZE_TEST_IDS = [20, 21, 22, 23, 24, 25]           # IDs reservados para el test
QR_TEST_MM = [8.0, 10.0, 12.0]

CYANO_STEPS = 21          # parches de la tira de cianotipia


def _mm(v, dpi):
    return paper.mm_to_px(v, dpi)


# ────────────────────────────────────────────────────────────────
# PÁGINA DE PRUEBA DE IMPRESORA
# ────────────────────────────────────────────────────────────────

def printer_test_geometry(paper_name: str = "A4", dpi: int = 300) -> dict:
    """Geometría determinista de la página de prueba (para generar y analizar)."""
    page_w, page_h = paper.page_size_px(paper_name, dpi, landscape=False)
    side = _mm(CAL_MARKER_MM, dpi)
    quiet = max(2, side // 7)
    margin = _mm(CAL_MARGIN_MM, dpi)
    mk_pos = markers.marker_layout(page_w, page_h, 8, side, margin, quiet)
    mk_bboxes = markers.marker_bboxes(page_w, page_h, 8, side, margin, quiet)

    band = margin + side + 2 * quiet + _mm(6, dpi)
    content_x1, content_x2 = band, page_w - band

    # Rampa tonal: 21 parches en 2 filas.
    ramp = []
    patch_w = (content_x2 - content_x1 - _mm(2, dpi) * 10) // 11
    patch_h = _mm(12, dpi)
    y0 = band + _mm(22, dpi)
    for i in range(RAMP_STEPS):
        row, col = divmod(i, 11)
        x = content_x1 + col * (patch_w + _mm(2, dpi))
        y = y0 + row * (patch_h + _mm(6, dpi))
        nivel = int(round(255 * (1 - i / (RAMP_STEPS - 1))))  # 255=blanco → 0=negro
        ramp.append({"bbox": [x, y, x + patch_w, y + patch_h], "nivel": nivel})

    # Test de tamaños de ArUco.
    size_test = []
    y_size = y0 + 2 * (patch_h + _mm(6, dpi)) + _mm(14, dpi)
    x = content_x1
    for mm_size, mid in zip(SIZE_TEST_MM, SIZE_TEST_IDS):
        s_px = _mm(mm_size, dpi)
        q_px = max(2, s_px // 7)
        size_test.append({"id": mid, "mm": mm_size,
                          "pos": [x, y_size], "lado_px": s_px, "quiet_px": q_px})
        x += s_px + 2 * q_px + _mm(8, dpi)

    # Test de tamaños de QR.
    qr_test = []
    y_qr = y_size + _mm(max(SIZE_TEST_MM), dpi) + _mm(16, dpi)
    x = content_x1
    for mm_size in QR_TEST_MM:
        s_px = _mm(mm_size, dpi)
        qr_test.append({"mm": mm_size, "bbox": [x, y_qr, x + s_px, y_qr + s_px],
                        "texto": f"KQR|{mm_size:g}"})
        x += s_px + _mm(10, dpi)

    return {
        "paper": paper_name, "dpi": dpi,
        "page_w": page_w, "page_h": page_h,
        "marker_side": side, "marker_quiet": quiet,
        "marker_positions": mk_pos, "marker_bboxes": mk_bboxes,
        "ramp": ramp, "size_test": size_test, "qr_test": qr_test,
    }


def generar_pagina_prueba_impresora(out_path, paper_name: str = "A4",
                                    dpi: int = 300) -> str:
    """Genera la página de prueba y la guarda (TIFF o PNG según extensión)."""
    g = printer_test_geometry(paper_name, dpi)
    canvas = Image.new("RGB", (g["page_w"], g["page_h"]), "#FFFFFF")
    draw = ImageDraw.Draw(canvas)
    font = _load_font(None, _mm(4, dpi))
    font_small = _load_font(None, _mm(2.6, dpi))

    for mid, (px, py) in g["marker_positions"].items():
        patch = markers.marker_patch(mid, g["marker_side"], g["marker_quiet"])
        canvas.paste(patch, (int(px), int(py)))

    band = g["ramp"][0]["bbox"][0]
    draw.text((band, band), "Kamiru Studio — Prueba de impresora", fill="black",
              font=font)
    draw.text((band, band + _mm(6, dpi)),
              f"Imprime esta página al 100 % (SIN «ajustar a página») en {paper_name} "
              f"a {dpi} DPI. Luego escanéala completa y analízala en la app.",
              fill="black", font=font_small)

    for p in g["ramp"]:
        n = p["nivel"]
        draw.rectangle(p["bbox"], fill=(n, n, n), outline=(120, 120, 120))
    y_leg = g["ramp"][0]["bbox"][1] - _mm(5, dpi)
    draw.text((g["ramp"][0]["bbox"][0], y_leg),
              "Rampa tonal (blanco → negro)", fill="black", font=font_small)

    for t in g["size_test"]:
        patch = markers.marker_patch(t["id"], t["lado_px"], t["quiet_px"])
        canvas.paste(patch, (int(t["pos"][0]), int(t["pos"][1])))
        draw.text((t["pos"][0], t["pos"][1] + t["lado_px"] + 2 * t["quiet_px"] + _mm(1, dpi)),
                  f"{t['mm']:g} mm", fill="black", font=font_small)
    draw.text((g["size_test"][0]["pos"][0],
               g["size_test"][0]["pos"][1] - _mm(5, dpi)),
              "Tamaños de marcador ArUco", fill="black", font=font_small)

    for t in g["qr_test"]:
        qr = markers.qr_image(t["texto"], t["bbox"][2] - t["bbox"][0])
        canvas.paste(qr, (int(t["bbox"][0]), int(t["bbox"][1])))
        draw.text((t["bbox"][0], t["bbox"][3] + _mm(1, dpi)),
                  f"{t['mm']:g} mm", fill="black", font=font_small)
    draw.text((g["qr_test"][0]["bbox"][0],
               g["qr_test"][0]["bbox"][1] - _mm(5, dpi)),
              "Tamaños de QR", fill="black", font=font_small)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fmt = "TIFF" if out_path.suffix.lower() in (".tif", ".tiff") else "PNG"
    canvas.save(str(out_path), fmt, dpi=(dpi, dpi))
    return str(out_path)


def _align_to_canonical(scan_path, geometry, mode="normal"):
    """Detecta los marcadores del escaneo y lo alinea al lienzo canónico.

    Devuelve (warp_bgr8, escala, marcadores_detectados, refined_corners).
    """
    img = leer_imagen_robusta(scan_path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError(f"No se pudo leer el escaneo: {scan_path}")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.ndim == 3 and img.shape[2] == 4:
        img = np.ascontiguousarray(img[:, :, :3])

    H, W = img.shape[:2]
    factor = max(1.0, max(H, W) / 2400.0)
    proxy = cv2.resize(img, (int(W / factor), int(H / factor)),
                       interpolation=cv2.INTER_AREA) if factor > 1 else img
    proxy8 = _to_u8(proxy)

    bboxes = {str(k): v for k, v in geometry["marker_bboxes"].items()}
    expected = [int(k) for k in bboxes]
    _, found = _detect_markers_multi(proxy8, markers.DEFAULT_DICT, expected, mode)
    if len(found) < 3:
        raise ValueError(
            f"Solo se detectaron {len(found)} marcadores de referencia en el "
            f"escaneo; se necesitan al menos 3. Asegúrate de escanear la "
            f"página completa y derecha.")

    refined = _refine_corners_fullres(img, found, factor, markers.DEFAULT_DICT, mode)
    s = _estimate_scale(refined, bboxes)
    if not s:
        raise ValueError("No se pudo estimar la escala del escaneo.")

    src, dst = [], []
    for mid, corners in refined.items():
        key = str(int(mid))
        if key in bboxes:
            src.append(corners)
            dst.append(markers.bbox_corners(bboxes[key]) * s)
    M, _ = cv2.findHomography(np.concatenate(src), np.concatenate(dst),
                              cv2.RANSAC, 12.0)
    if M is None:
        raise ValueError("No se pudo alinear el escaneo (homografía degenerada).")
    out_w = int(round(geometry["page_w"] * s))
    out_h = int(round(geometry["page_h"] * s))
    warp = cv2.warpPerspective(_to_u8(img), M, (out_w, out_h),
                               flags=cv2.INTER_CUBIC)
    return warp, s, refined, factor


def _patch_mean(warp, bbox, s, shrink=0.25):
    x1, y1, x2, y2 = [int(round(v * s)) for v in bbox]
    dx, dy = int((x2 - x1) * shrink), int((y2 - y1) * shrink)
    region = warp[y1 + dy:y2 - dy, x1 + dx:x2 - dx]
    if region.size == 0:
        return None
    if region.ndim == 3:
        gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    else:
        gray = region
    return float(gray.mean())


def analizar_prueba_impresora(scan_path, paper_name: str = "A4",
                              dpi: int = 300, scan_dpi: float | None = None,
                              log=None) -> dict:
    """Analiza el escaneo de la página de prueba y devuelve un perfil."""
    _log = log or (lambda *_: None)
    g = printer_test_geometry(paper_name, dpi)
    warp, s, refined, _ = _align_to_canonical(scan_path, g)
    _log(f"Página alineada ({len(refined)} marcadores, escala {s:.3f}×).")

    notas = []

    # ── Escala de impresión ─────────────────────────────────────
    # DPI real del escaneo: parámetro del usuario o metadatos del archivo.
    if not scan_dpi:
        try:
            with Image.open(scan_path) as im:
                info_dpi = im.info.get("dpi")
            if info_dpi and info_dpi[0] > 1:
                scan_dpi = float(info_dpi[0])
        except Exception:
            scan_dpi = None

    scale_x = scale_y = None
    if scan_dpi:
        bboxes = g["marker_bboxes"]

        def _center_mm_nominal(mid):
            b = bboxes[mid]
            return ((b[0] + b[2]) / 2.0 / dpi * 25.4,
                    (b[1] + b[3]) / 2.0 / dpi * 25.4)

        def _center_mm_scan(mid):
            c = refined[mid].mean(axis=0)
            return (c[0] / scan_dpi * 25.4, c[1] / scan_dpi * 25.4)

        sx_list, sy_list = [], []
        ids = [m for m in refined if m in bboxes]
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                a, b = ids[i], ids[j]
                nax, nay = _center_mm_nominal(a)
                nbx, nby = _center_mm_nominal(b)
                sax, say = _center_mm_scan(a)
                sbx, sby = _center_mm_scan(b)
                if abs(nbx - nax) > 40:
                    sx_list.append(abs(sbx - sax) / abs(nbx - nax))
                if abs(nby - nay) > 40:
                    sy_list.append(abs(sby - say) / abs(nby - nay))
        if sx_list and sy_list:
            scale_x = float(np.median(sx_list))
            scale_y = float(np.median(sy_list))
            _log(f"Escala medida de impresión: {scale_x * 100:.2f} % (horizontal), "
                 f"{scale_y * 100:.2f} % (vertical).")
            if abs(scale_x - 1) > 0.03 or abs(scale_y - 1) > 0.03:
                notas.append(
                    "La impresora escala más de un 3 %: probablemente el "
                    "controlador tiene activado «ajustar a página». Se "
                    "recomienda desactivarlo e imprimir al 100 %.")
        else:
            notas.append("No se pudieron medir distancias suficientes para la escala.")
    else:
        notas.append(
            "El escaneo no trae DPI en sus metadatos y no se indicó: no se "
            "pudo medir la escala de impresión (solo la respuesta tonal y "
            "los tamaños mínimos).")

    # ── Respuesta tonal ─────────────────────────────────────────
    tono = []
    for p in g["ramp"]:
        m = _patch_mean(warp, p["bbox"], s)
        if m is not None:
            tono.append([int(p["nivel"]), round(m, 1)])
    if tono:
        med = [t[1] for t in tono]
        if max(med) - min(med) < 60:
            notas.append("La rampa tonal tiene poco contraste en el escaneo; "
                         "revisa la exposición del escáner.")

    # ── Tamaño mínimo de marcador ───────────────────────────────
    detector_ids = SIZE_TEST_IDS
    warp_bgr = warp if warp.ndim == 3 else cv2.cvtColor(warp, cv2.COLOR_GRAY2BGR)
    _, found_sizes = _detect_markers_multi(warp_bgr, markers.DEFAULT_DICT,
                                           detector_ids, "normal")
    detectados_mm = sorted(t["mm"] for t in g["size_test"] if t["id"] in found_sizes)
    marker_min = detectados_mm[0] if detectados_mm else None
    if marker_min is None:
        notas.append("Ningún marcador del test de tamaños se detectó: usa "
                     "marcadores de 10-12 mm y revisa la calidad de impresión.")
        marker_rec = 12.0
    else:
        marker_rec = max(5.0, round(marker_min * 1.25 * 2) / 2)
        _log(f"Marcador más pequeño detectado: {marker_min:g} mm "
             f"(recomendado: {marker_rec:g} mm).")

    # ── Tamaño mínimo de QR ─────────────────────────────────────
    from .scan import _decode_qr
    qr_ok_mm = []
    for t in g["qr_test"]:
        x1, y1, x2, y2 = [int(round(v * s)) for v in t["bbox"]]
        pad = int((x2 - x1) * 0.3)
        crop = warp[max(0, y1 - pad):y2 + pad, max(0, x1 - pad):x2 + pad]
        data = _decode_qr(crop)
        if data == t["texto"]:
            qr_ok_mm.append(t["mm"])
    qr_min = min(qr_ok_mm) if qr_ok_mm else None
    if qr_min is None:
        notas.append("Ningún QR del test se pudo leer: usa QRs de 12 mm o más.")
        qr_rec = 12.0
    else:
        qr_rec = max(8.0, round(qr_min * 1.2 * 2) / 2)
        _log(f"QR más pequeño legible: {qr_min:g} mm (recomendado: {qr_rec:g} mm).")

    return {
        "tipo": "impresora",
        "fecha": time.strftime("%Y-%m-%d %H:%M:%S"),
        "paper": paper_name,
        "dpi": dpi,
        "scan_dpi": scan_dpi,
        "scale_x": round(scale_x, 4) if scale_x else 1.0,
        "scale_y": round(scale_y, 4) if scale_y else 1.0,
        "tono": tono,
        "marker_min_mm": marker_min,
        "marker_recomendado_mm": marker_rec,
        "qr_min_mm": qr_min,
        "qr_recomendado_mm": qr_rec,
        "notas": notas,
    }


# ────────────────────────────────────────────────────────────────
# TIRA DE CALIBRACIÓN DE CIANOTIPIA
# ────────────────────────────────────────────────────────────────

def cyanotype_strip_geometry(paper_name: str = "A4", dpi: int = 300,
                             steps: int = CYANO_STEPS) -> dict:
    """Geometría determinista de la tira de calibración de cianotipia."""
    page_w, page_h = paper.page_size_px(paper_name, dpi, landscape=False)
    side = _mm(CAL_MARKER_MM, dpi)
    quiet = max(2, side // 7)
    margin = _mm(CAL_MARGIN_MM, dpi)
    mk_pos = markers.marker_layout(page_w, page_h, 8, side, margin, quiet)
    mk_bboxes = markers.marker_bboxes(page_w, page_h, 8, side, margin, quiet)

    band = margin + side + 2 * quiet + _mm(6, dpi)
    content_x1, content_x2 = band, page_w - band

    cols = 3
    rows = (steps + cols - 1) // cols
    gap = _mm(4, dpi)
    patch_w = (content_x2 - content_x1 - (cols - 1) * gap) // cols
    patch_h = _mm(16, dpi)
    y0 = band + _mm(24, dpi)
    patches = []
    for i in range(steps):
        row, col = divmod(i, cols)
        x = content_x1 + col * (patch_w + gap)
        y = y0 + row * (patch_h + gap + _mm(5, dpi))
        densidad = int(round(255 * i / (steps - 1)))
        patches.append({"bbox": [x, y, x + patch_w, y + patch_h],
                        "densidad": densidad})

    return {
        "paper": paper_name, "dpi": dpi, "steps": steps,
        "page_w": page_w, "page_h": page_h,
        "marker_side": side, "marker_quiet": quiet,
        "marker_positions": mk_pos, "marker_bboxes": mk_bboxes,
        "patches": patches,
    }


def generar_tira_cianotipia(out_path, paper_name: str = "A4", dpi: int = 300,
                            ink_color: str = "#000000", mirror: bool = True,
                            steps: int = CYANO_STEPS) -> str:
    """Genera el negativo de la tira de calibración para imprimir en acetato.

    IMPORTANTE: usa el mismo color de tinta y el mismo espejado que se usarán
    en los negativos reales, para que la medición represente el proceso real.
    """
    g = cyanotype_strip_geometry(paper_name, dpi, steps)
    bg = cyan.solid_density_color(255, ink_color)  # tinta plena de fondo
    canvas = Image.new("RGB", (g["page_w"], g["page_h"]), bg)
    draw = ImageDraw.Draw(canvas)
    font = _load_font(None, _mm(4, dpi))
    font_small = _load_font(None, _mm(2.8, dpi))
    text_color = "#FFFFFF" if sum(cyan.hex_to_rgb(ink_color)) < 420 else "#000000"

    for mid, (px, py) in g["marker_positions"].items():
        patch = markers.marker_patch(mid, g["marker_side"], g["marker_quiet"],
                                     inverted=True)
        canvas.paste(patch, (int(px), int(py)))

    band = g["patches"][0]["bbox"][0]
    draw.text((band, band), "Kamiru Studio — Calibración de cianotipia",
              fill=text_color, font=font)
    draw.text((band, band + _mm(6, dpi)),
              "Imprime en acetato al 100 %, expón tu cianotipia como siempre, "
              "revela, seca y escanea el RESULTADO AZUL (no el acetato).",
              fill=text_color, font=font_small)

    for i, p in enumerate(g["patches"]):
        color = cyan.solid_density_color(p["densidad"], ink_color)
        draw.rectangle(p["bbox"], fill=color)
        draw.text((p["bbox"][0], p["bbox"][3] + _mm(1, dpi)),
                  f"{i + 1:02d} · d={p['densidad']}", fill=text_color,
                  font=font_small)

    if mirror:
        canvas = cyan.mirror(canvas)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fmt = "TIFF" if out_path.suffix.lower() in (".tif", ".tiff") else "PNG"
    canvas.save(str(out_path), fmt, dpi=(dpi, dpi))
    return str(out_path)


def analizar_tira_cianotipia(scan_path, paper_name: str = "A4", dpi: int = 300,
                             steps: int = CYANO_STEPS, log=None) -> dict:
    """Analiza el escaneo de la CIANOTIPIA de la tira y construye la curva.

    Devuelve un perfil con la LUT de compensación (256 valores), la respuesta
    medida y notas/sugerencias.
    """
    _log = log or (lambda *_: None)
    g = cyanotype_strip_geometry(paper_name, dpi, steps)
    warp, s, refined, _ = _align_to_canonical(scan_path, g, mode="cianotipia")
    _log(f"Tira alineada ({len(refined)} marcadores, escala {s:.3f}×).")

    # Luminancia medida de cada parche (densidad creciente → más blanco).
    respuesta = []  # [densidad, luminancia]
    for p in g["patches"]:
        m = _patch_mean(warp, p["bbox"], s)
        if m is not None:
            respuesta.append([int(p["densidad"]), round(m, 1)])
    if len(respuesta) < max(5, steps // 2):
        raise ValueError(
            "No se pudieron medir suficientes parches; revisa que el escaneo "
            "esté completo, plano y bien iluminado.")

    d = np.array([r[0] for r in respuesta], dtype=np.float64)
    y = np.array([r[1] for r in respuesta], dtype=np.float64)

    # La física dice que Y crece con la densidad (más tinta = menos exposición
    # = más claro). El ruido de medición puede romper la monotonía: se fuerza.
    orden = np.argsort(d)
    d, y = d[orden], y[orden]
    y_mono = np.maximum.accumulate(y)

    y_min, y_max = float(y_mono[0]), float(y_mono[-1])
    rango = (y_max - y_min) / 255.0
    notas = []
    _log(f"Rango dinámico medido: {rango * 100:.0f} % "
         f"(azul más oscuro {y_min:.0f} → blanco papel {y_max:.0f}).")
    if rango < 0.35:
        notas.append(
            "Rango dinámico bajo (<35 %). Sugerencias: aumenta el tiempo de "
            "exposición, verifica que la tinta plena del acetato realmente "
            "bloquee la luz (imprime en calidad máxima / doble pasada) y "
            "revisa el lavado.")
    if rango > 0.85:
        notas.append("Excelente rango dinámico. 💙")

    # LUT de compensación: para el gris de entrada g (0=negro deseado,
    # 255=blanco deseado) se busca la densidad que produce el tono final
    # linealmente repartido entre el azul más oscuro y el blanco papel.
    g_in = np.arange(256, dtype=np.float64)
    y_target = y_min + (g_in / 255.0) * (y_max - y_min)
    # Interpolación inversa Y→densidad (y_mono es no-decreciente).
    lut = np.interp(y_target, y_mono, d)
    lut = np.clip(np.round(lut), 0, 255).astype(int).tolist()

    return {
        "tipo": "cianotipia",
        "fecha": time.strftime("%Y-%m-%d %H:%M:%S"),
        "paper": paper_name,
        "dpi": dpi,
        "steps": steps,
        "lut": lut,
        "respuesta": respuesta,
        "rango_dinamico": round(rango, 3),
        "notas": notas,
    }
