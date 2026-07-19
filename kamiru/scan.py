"""Procesador de escaneos: de la hoja pintada/expuesta a fotogramas digitales.

Toma los escaneos (TIFF/PNG/JPG a cualquier resolución), los alinea
matemáticamente usando los marcadores ArUco, identifica cada hoja por sus
códigos QR y recorta cada fotograma según el layout.json. Sin Photoshop.

Mejoras v2 sobre el procesador original:

* MARCADORES REDUNDANTES: la homografía se estima con RANSAC usando las 4
  esquinas de TODOS los marcadores detectados. Con 8-12 marcadores en la hoja,
  se puede alinear aunque varios estén tapados, pintados o cortados (bastan 3).
* AFINADO A RESOLUCIÓN COMPLETA: los marcadores se detectan primero en un
  proxy pequeño (rápido) y luego se re-detectan en recortes a resolución
  completa para lograr precisión subpíxel real.
* ESCALA AUTOMÁTICA: ya no se asume "escaneo a 1200 PPI"; la escala real del
  escaneo se mide con los propios marcadores, así que cualquier resolución
  de escaneo funciona.
* MODO CIANOTIPIA: preprocesado especial (canal rojo + CLAHE + aplanado de
  fondo) para detectar marcadores y QRs sobre los tonos azules variables del
  azul de Prusia, con parámetros del detector ArUco afinados para bordes
  químicos difusos e iluminación desigual.
* ESCANEOS ESPEJADOS: los ArUco son quirales; si la cianotipia se expuso con
  el acetato al revés, la copia (y su escaneo) salen en espejo. Se detecta
  automáticamente, se voltea el escaneo y se avisa en el informe.
* RECUPERACIÓN GUIADA: los marcadores que la pasada global pierde (lavados,
  poco contraste) se re-buscan localmente donde DEBERÍAN estar según una
  homografía preliminar.
* CONTROL DE PRECISIÓN: tras la alineación se mide el error de reproyección
  de cada marcador; los inconsistentes se descartan y el residuo final se
  publica en el informe. Si el papel se deformó (se moja y encoge), los
  recortes se corrigen localmente con el campo de residuos de los marcadores.
* QR SIN DEPENDENCIAS NATIVAS: se decodifica con OpenCV (pyzbar es opcional).
  Un solo QR legible en la hoja basta para identificarla (formato v2).
* PARALELISMO: varios escaneos se procesan a la vez (OpenCV libera el GIL en
  las operaciones pesadas). Pensado para máquinas potentes.
* MODO EMERGENCIA: si los marcadores se detectan pero ningún QR es legible,
  los recortes se guardan igualmente en una carpeta 'sin_identificar/' para
  no perder el arte.
* INFORME: al final se genera un informe (JSON + HTML con miniaturas + CSV)
  con el estado de cada hoja y cada fotograma, y la lista de fotogramas
  faltantes para poder generar hojas de rescate.
* ESCANEOS EN CUALQUIER ORIENTACIÓN: la hoja puede escanearse rotada o de
  cabeza; los marcadores la enderezan igual.
* 16 BITS: si el escáner entrega 16 bits por canal, se conservan de punta a
  punta (alineación, recorte y guardado).
"""

from __future__ import annotations

import csv
import gc
import html as html_mod
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from . import layoutfile, markers

SUPPORTED_EXTENSIONS = {".tif", ".tiff", ".png", ".jpg", ".jpeg", ".bmp", ".webp"}

# Lado máximo del proxy usado para la detección rápida de marcadores.
PROXY_MAX_SIDE = 2400

try:  # pyzbar es OPCIONAL (requiere libzbar); OpenCV es el decodificador base.
    from pyzbar.pyzbar import decode as _pyzbar_decode  # type: ignore
    _HAS_PYZBAR = True
except Exception:
    _HAS_PYZBAR = False


# ────────────────────────────────────────────────────────────────
# E/S robusta de imágenes (rutas Unicode en Windows, TIFFs exóticos)
# ────────────────────────────────────────────────────────────────
#
# BUG CLÁSICO DE OPENCV EN WINDOWS: cv2.imread()/imwrite() no soportan rutas
# con tildes/ñ (usan la codepage ANSI). Solución: Python lee/escribe los bytes
# (Unicode nativo) y OpenCV solo (de)codifica en memoria.

def leer_imagen_robusta(path, flags: int = cv2.IMREAD_UNCHANGED):
    """Lee una imagen tolerando rutas no-ASCII y TIFFs que OpenCV no abre."""
    path = Path(path)
    ruta_str = str(path)

    if ruta_str.isascii():
        img = cv2.imread(ruta_str, flags)
        if img is not None:
            return img

    try:
        buffer = np.fromfile(ruta_str, dtype=np.uint8)
        if buffer.size > 0:
            img = cv2.imdecode(buffer, flags)
            if img is not None:
                return img
    except (OSError, ValueError):
        pass

    try:
        from PIL import Image

        with Image.open(path) as pil_img:
            arr = np.array(pil_img)
        if arr.ndim == 3 and arr.shape[2] == 4:
            arr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGRA)
        elif arr.ndim == 3 and arr.shape[2] == 3:
            arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
        return arr
    except Exception:
        return None


def escribir_imagen_robusta(path, img, params=None) -> bool:
    """Guarda una imagen tolerando rutas no-ASCII en Windows."""
    path = Path(path)
    ruta_str = str(path)
    params = params or []

    if ruta_str.isascii():
        try:
            if cv2.imwrite(ruta_str, img, params):
                return True
        except cv2.error:
            pass

    ext = path.suffix if path.suffix else ".tif"
    try:
        ok, buffer = cv2.imencode(ext, img, params)
        if not ok:
            return False
        buffer.tofile(ruta_str)
        return True
    except (cv2.error, OSError):
        return False


# ────────────────────────────────────────────────────────────────
# Opciones y resultados
# ────────────────────────────────────────────────────────────────

@dataclass
class ScanOptions:
    """Opciones del procesamiento de escaneos."""
    bleed: float = 0.015              # recorte perimetral (fracción por lado)
    min_markers: int = 3              # marcadores mínimos para alinear
    threads: int = 3                  # escaneos procesados en paralelo
    mode: str = "auto"                # auto | normal | cianotipia
    resize_to_original: bool = False  # reescalar cada frame a su tamaño digital
    normalize_patches: bool = False   # normalizar niveles con la tira de grises
    report: bool = True               # generar informe HTML/JSON/CSV
    output_suffix: str = ""           # sufijo para los archivos de salida
    fine_align: bool = True           # corregir recortes con el campo de
                                      # residuos (papel deformado en húmedo)


@dataclass
class ScanResult:
    scan: str = ""
    ok: bool = False
    hoja_numero: int | None = None
    archivo_hoja: str | None = None
    marcadores: int = 0
    marcadores_total: int = 0
    estrategia: str = ""
    escala: float = 0.0
    frames: dict = field(default_factory=dict)      # etiqueta -> ruta guardada
    sin_identificar: list = field(default_factory=list)
    advertencias: list = field(default_factory=list)
    error: str = ""
    segundos: float = 0.0
    espejado: bool = False            # el escaneo llegó en espejo (se corrigió)
    residual_mm: float = 0.0          # error mediano de alineación (mm)
    overlay: str = ""                 # miniatura de diagnóstico (ruta relativa)


# ────────────────────────────────────────────────────────────────
# Preprocesado del escaneo (estrategias de detección)
# ────────────────────────────────────────────────────────────────

def _to_u8(img: np.ndarray) -> np.ndarray:
    """Convierte cualquier profundidad a 8 bits (solo para detección)."""
    if img.dtype == np.uint16:
        return (img >> 8).astype(np.uint8)
    if img.dtype != np.uint8:
        lo, hi = float(img.min()), float(img.max())
        if hi <= lo:
            return np.zeros(img.shape[:2], np.uint8)
        return ((img - lo) * (255.0 / (hi - lo))).astype(np.uint8)
    return img


def _flat_field(channel: np.ndarray) -> np.ndarray:
    """Aplana la densidad de fondo no uniforme (lavados y exposiciones
    desiguales típicos de la cianotipia): divide el canal por una versión muy
    desenfocada de sí mismo y renormaliza. Los marcadores quedan con contraste
    homogéneo aunque media hoja esté mucho más oscura que la otra."""
    sigma = max(15.0, min(channel.shape[:2]) / 16.0)
    fondo = cv2.GaussianBlur(channel, (0, 0), sigma)
    flat = cv2.divide(channel, cv2.max(fondo, 1), scale=128.0)
    return cv2.normalize(flat, None, 0, 255, cv2.NORM_MINMAX)


def _gray_variants(bgr8: np.ndarray, mode: str):
    """Genera versiones en escala de grises del escaneo, en orden de
    probabilidad de éxito según el modo.

    Para cianotipia el canal ROJO es clave: el azul de Prusia es casi negro en
    ese canal, así que marcadores/QRs azules sobre papel claro quedan con
    contraste máximo, sin importar la tonalidad exacta del azul. El APLANADO
    de fondo neutraliza los gradientes de densidad (media hoja lavada más
    oscura que la otra) que arruinan los umbrales globales.
    """
    gray = cv2.cvtColor(bgr8, cv2.COLOR_BGR2GRAY)
    red = bgr8[:, :, 2].copy()
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))

    if mode == "cianotipia":
        yield "canal_rojo", red
        yield "rojo_aplanado", _flat_field(red)
        yield "canal_rojo_clahe", clahe.apply(red)
        yield "gris", gray
        yield "gris_clahe", clahe.apply(gray)
        yield "gris_norm", cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)
    else:
        yield "gris", gray
        yield "canal_rojo", red
        yield "gris_clahe", clahe.apply(gray)
        yield "canal_rojo_clahe", clahe.apply(red)
        yield "rojo_aplanado", _flat_field(red)
        yield "gris_norm", cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)


def _make_detector(dict_name: str, mode: str = "normal",
                   inverted: bool = False):
    """Detector ArUco configurado según el modo.

    inverted=True activa detectInvertedMarker; OJO: ese flag sesga las
    esquinas de los marcadores de polaridad NORMAL (~10-15 px hacia fuera),
    así que solo se usa como último recurso en la recuperación guiada de
    marcadores perdidos, nunca en la detección principal.
    """
    aruco_dict = markers.get_dictionary(dict_name)
    params = cv2.aruco.DetectorParameters()
    try:
        params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    except Exception:
        pass
    if mode == "cianotipia":
        # El proceso químico come bits y difumina bordes; la iluminación de la
        # hoja es desigual. Se relajan los umbrales del detector: los falsos
        # positivos no preocupan porque solo se aceptan los IDs esperados y la
        # homografía RANSAC + el filtro de residuos descartan inconsistentes.
        try:
            params.errorCorrectionRate = 0.8         # bordes comidos por la química
            params.adaptiveThreshWinSizeMax = 45     # iluminación desigual
            params.adaptiveThreshWinSizeStep = 6
            params.minMarkerPerimeterRate = 0.015    # marcadores pequeños
            params.polygonalApproxAccuracyRate = 0.06  # cuadrados imperfectos
            params.maxErroneousBitsInBorderRate = 0.45
        except Exception:
            pass
    if inverted:
        try:
            params.detectInvertedMarker = True
        except Exception:
            pass
    return cv2.aruco.ArucoDetector(aruco_dict, params)


def _detect_markers_multi(bgr8: np.ndarray, dict_name: str, expected_ids,
                          mode: str):
    """Prueba varias estrategias de preprocesado y devuelve la mejor detección.

    Returns:
        (estrategia, {id: corners_4x2_float32}) — corners en coords de bgr8.
    """
    detector = _make_detector(dict_name, mode)
    expected = set(int(i) for i in expected_ids)
    best_name, best = "", {}

    for name, gray in _gray_variants(bgr8, mode):
        corners, ids, _ = detector.detectMarkers(gray)
        found = {}
        if ids is not None:
            for i, mid in enumerate(ids.flatten()):
                mid = int(mid)
                if mid in expected and mid not in found:
                    found[mid] = corners[i][0].astype(np.float32)
        if len(found) > len(best):
            best_name, best = name, found
        if len(best) >= len(expected):
            break
    return best_name, best


def _detect_oriented(proxy8: np.ndarray, dict_name: str, expected_ids,
                     mode: str):
    """Detección en el proxy probando también la imagen ESPEJADA.

    Los ArUco son quirales: si la cianotipia se expuso con el acetato al revés
    (o se escaneó el propio acetato), la copia sale en espejo y los marcadores
    no aparecen — o peor, el espejo de alguno coincide por azar con otro id y
    produce una alineación plausible pero incorrecta. Si al derecho no
    aparecen todos, se intenta en espejo y gana la orientación con más
    marcadores (empate → al derecho).

    Returns:
        (estrategia, {id: corners}, flipped) — corners en coords de la
        orientación GANADORA (si flipped=True, del proxy volteado).
    """
    estrategia, found = _detect_markers_multi(proxy8, dict_name,
                                              expected_ids, mode)
    if len(found) >= len(set(int(i) for i in expected_ids)):
        return estrategia, found, False
    estrategia_f, found_f = _detect_markers_multi(
        cv2.flip(proxy8, 1), dict_name, expected_ids, mode)
    if len(found_f) > len(found):
        return f"{estrategia_f}_espejado", found_f, True
    return estrategia, found, False


def _refine_corners_fullres(img_full: np.ndarray, proxy_corners: dict,
                            factor: float, dict_name: str, mode: str):
    """Re-detecta cada marcador en un recorte a resolución completa para
    obtener esquinas precisas. Si falla, usa las del proxy reescaladas."""
    detector = _make_detector(dict_name, mode)
    H, W = img_full.shape[:2]
    refined = {}

    for mid, c in proxy_corners.items():
        c_full = c * factor
        x1, y1 = c_full.min(axis=0)
        x2, y2 = c_full.max(axis=0)
        side = max(x2 - x1, y2 - y1)
        pad = side * 0.6
        rx1, ry1 = max(0, int(x1 - pad)), max(0, int(y1 - pad))
        rx2, ry2 = min(W, int(x2 + pad)), min(H, int(y2 + pad))
        if rx2 - rx1 < 8 or ry2 - ry1 < 8:
            refined[mid] = c_full
            continue

        crop = img_full[ry1:ry2, rx1:rx2]
        crop8 = _to_u8(crop)
        found = None
        for _, gray in _gray_variants(crop8, mode):
            corners, ids, _ = detector.detectMarkers(gray)
            if ids is not None:
                for i, did in enumerate(ids.flatten()):
                    if int(did) == mid:
                        found = corners[i][0].astype(np.float32)
                        break
            if found is not None:
                break
        if found is not None:
            found[:, 0] += rx1
            found[:, 1] += ry1
            refined[mid] = found
        else:
            refined[mid] = c_full
    return refined


def _recover_missing_markers(img_full: np.ndarray, refined: dict,
                             layout_bboxes: dict, s: float, dict_name: str,
                             mode: str, thresh: float) -> dict:
    """Segunda pasada GUIADA: busca los marcadores no detectados justo donde
    deberían estar.

    Con una homografía preliminar (layout → escaneo) construida con los
    marcadores ya encontrados, se proyecta la posición esperada de cada
    marcador perdido, se recorta esa zona a resolución completa (ampliándola
    si es pequeña) y se re-detecta con todas las variantes de preprocesado.
    Recupera marcadores lavados o de bajo contraste que la pasada global
    pierde. Solo se acepta el id esperado en cada zona.

    Returns: {id: corners_4x2_float32} extra, en coords de img_full.
    """
    missing = [int(k) for k in layout_bboxes if int(k) not in refined]
    if not missing or len(refined) < 3:
        return {}

    src_list, dst_list = [], []
    for mid, corners in refined.items():
        key = str(int(mid))
        if key not in layout_bboxes:
            continue
        src_list.append(markers.bbox_corners(layout_bboxes[key]) * s)
        dst_list.append(corners)
    if not src_list:
        return {}
    M0, _ = cv2.findHomography(np.concatenate(src_list),
                               np.concatenate(dst_list), cv2.RANSAC, thresh)
    if M0 is None:
        return {}

    detector = _make_detector(dict_name, mode)
    # Último recurso por zona: detector con polaridad invertida (sus esquinas
    # son menos precisas, pero el filtro de residuos vigila el resultado).
    detector_inv = _make_detector(dict_name, mode, inverted=True)
    H, W = img_full.shape[:2]
    out = {}
    for mid in missing:
        corners_lay = markers.bbox_corners(layout_bboxes[str(mid)]) * s
        proj = cv2.perspectiveTransform(corners_lay[None], M0)[0]
        x1, y1 = proj.min(axis=0)
        x2, y2 = proj.max(axis=0)
        side = float(max(x2 - x1, y2 - y1))
        if side < 6:
            continue
        pad = side  # margen generoso: la homografía preliminar es aproximada
        rx1, ry1 = max(0, int(x1 - pad)), max(0, int(y1 - pad))
        rx2, ry2 = min(W, int(x2 + pad)), min(H, int(y2 + pad))
        if rx2 - rx1 < 12 or ry2 - ry1 < 12:
            continue
        crop8 = _to_u8(img_full[ry1:ry2, rx1:rx2])
        if crop8.ndim == 2:
            crop8 = cv2.cvtColor(crop8, cv2.COLOR_GRAY2BGR)
        k = 1.0
        if side < 60:  # marcadores diminutos: ampliar mejora la decodificación
            k = 3.0
            crop8 = cv2.resize(crop8, (0, 0), fx=k, fy=k,
                               interpolation=cv2.INTER_CUBIC)
        for det in (detector, detector_inv):
            for _, gray in _gray_variants(crop8, mode):
                corners, ids, _ = det.detectMarkers(gray)
                if ids is None:
                    continue
                for i, did in enumerate(ids.flatten()):
                    if int(did) == mid:
                        c = corners[i][0].astype(np.float32) / k
                        c[:, 0] += rx1
                        c[:, 1] += ry1
                        out[mid] = c
                        break
                if mid in out:
                    break
            if mid in out:
                break
    return out


# ────────────────────────────────────────────────────────────────
# Control de precisión de la alineación
# ────────────────────────────────────────────────────────────────

def _marker_residuals(M: np.ndarray, refined: dict, layout_bboxes: dict,
                      s: float) -> dict:
    """Error medio de reproyección de cada marcador (px del lienzo alineado):
    distancia entre sus esquinas detectadas proyectadas con M y sus posiciones
    teóricas del layout."""
    out = {}
    for mid, corners in refined.items():
        key = str(int(mid))
        if key not in layout_bboxes:
            continue
        proj = cv2.perspectiveTransform(
            corners.reshape(1, -1, 2).astype(np.float64), M)[0]
        dst = markers.bbox_corners(layout_bboxes[key]).astype(np.float64) * s
        out[int(mid)] = float(np.mean(np.linalg.norm(proj - dst, axis=1)))
    return out


def _px_per_mm(layout: dict, s: float) -> float:
    """Píxeles por milímetro en el lienzo alineado (layout × escala)."""
    dpi = float(layout.get("lienzo", {}).get("dpi")
                or layout.get("lienzo", {}).get("ppi") or 300)
    return max(1e-6, s * dpi / 25.4)


def _make_local_shift(M: np.ndarray, refined: dict, layout_bboxes: dict,
                      s: float):
    """Corrector local de recortes para papel deformado.

    El papel de cianotipia se moja, encoge y se ondula: una homografía global
    no puede seguir esa deformación, así que el contenido queda corrido
    respecto al layout aunque los marcadores se detecten perfectos. Aquí se
    mide el residuo (dónde cayó realmente cada esquina de marcador en el
    lienzo alineado vs. dónde debería) y se interpola ese campo de vectores
    (ponderación por distancia inversa) para desplazar cada recorte hacia
    donde el contenido quedó de verdad.

    Devuelve una función bbox→(dx, dy) en px del lienzo alineado, o None si el
    residuo es subpíxel (nada que corregir). El desplazamiento interpolado es
    una combinación convexa de los residuos medidos, así que queda acotado por
    el residuo máximo observado.
    """
    pts, errs = [], []
    for mid, corners in refined.items():
        key = str(int(mid))
        if key not in layout_bboxes:
            continue
        proj = cv2.perspectiveTransform(
            corners.reshape(1, -1, 2).astype(np.float64), M)[0]
        dst = markers.bbox_corners(layout_bboxes[key]).astype(np.float64) * s
        pts.append(dst)
        errs.append(proj - dst)
    if len(pts) < 4:
        return None
    pts = np.concatenate(pts)
    errs = np.concatenate(errs)
    if float(np.median(np.linalg.norm(errs, axis=1))) < 0.75:
        return None  # residuo subpíxel: la homografía global basta

    sides = [(b[2] - b[0]) * s for b in
             (layout_bboxes[str(int(m))] for m in refined
              if str(int(m)) in layout_bboxes)]
    eps2 = float(np.median(sides)) ** 2 if sides else 100.0

    def shift(bbox_px):
        cx = (bbox_px[0] + bbox_px[2]) / 2.0
        cy = (bbox_px[1] + bbox_px[3]) / 2.0
        d2 = ((pts[:, 0] - cx) ** 2) + ((pts[:, 1] - cy) ** 2)
        w = 1.0 / (d2 + eps2)
        w /= w.sum()
        delta = w @ errs
        return float(delta[0]), float(delta[1])

    return shift


# ────────────────────────────────────────────────────────────────
# Lectura de códigos QR
# ────────────────────────────────────────────────────────────────

def _qr_detectors():
    """Detectores de QR disponibles, del mejor al básico.

    QRCodeDetectorAruco (OpenCV ≥ 4.8) localiza mucho mejor los QRs de bajo
    contraste o bordes difusos (cianotipia); el clásico queda de respaldo.
    """
    dets = []
    try:
        dets.append(cv2.QRCodeDetectorAruco())
    except Exception:
        pass
    dets.append(cv2.QRCodeDetector())
    return dets


def _decode_qr(crop_bgr: np.ndarray) -> str | None:
    """Decodifica un QR probando varias mejoras de imagen.

    OpenCV primero (sin dependencias nativas); pyzbar de refuerzo si está.
    Variantes: gris/canal rojo, ampliación, Otsu, umbral adaptativo con cierre
    morfológico (fondo desigual), inversión y, como último recurso, espejo.
    """
    if crop_bgr is None or crop_bgr.size == 0:
        return None
    crop8 = _to_u8(crop_bgr)
    if crop8.ndim == 3 and crop8.shape[2] == 4:
        crop8 = crop8[:, :, :3]

    if crop8.ndim == 3:
        gray = cv2.cvtColor(crop8, cv2.COLOR_BGR2GRAY)
        red = crop8[:, :, 2]
    else:
        gray = crop8
        red = crop8

    variants = []
    for base in (gray, red):
        v = base
        if min(v.shape[:2]) < 240:  # los QR pequeños se decodifican mejor ampliados
            k = max(2, int(round(280 / max(1, min(v.shape[:2])))))
            v = cv2.resize(v, (0, 0), fx=k, fy=k, interpolation=cv2.INTER_CUBIC)
        variants.append(v)
        _, otsu = cv2.threshold(v, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
        variants.append(otsu)
        bs = max(31, (min(v.shape[:2]) // 6) | 1)
        adap = cv2.adaptiveThreshold(v, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                     cv2.THRESH_BINARY, bs, 5)
        variants.append(cv2.morphologyEx(adap, cv2.MORPH_CLOSE,
                                         np.ones((3, 3), np.uint8)))
    variants.append(255 - variants[1])  # polaridad invertida (Otsu del gris)

    detectors = _qr_detectors()
    for det in detectors:
        for v in variants:
            try:
                data, _, _ = det.detectAndDecode(v)
            except cv2.error:
                data = ""
            if data:
                return data

    if _HAS_PYZBAR:
        for v in variants:
            try:
                codes = _pyzbar_decode(v)
            except Exception:
                codes = []
            if codes:
                try:
                    return codes[0].data.decode("utf-8")
                except Exception:
                    continue

    # Último recurso: QR en espejo (hoja expuesta/escaneada al revés que no
    # pasó por la corrección global).
    for v in variants[:2]:
        try:
            data, _, _ = detectors[0].detectAndDecode(cv2.flip(v, 1))
        except cv2.error:
            data = ""
        if data:
            return data
    return None


# ────────────────────────────────────────────────────────────────
# Utilidades geométricas
# ────────────────────────────────────────────────────────────────

def aplicar_bleed(x1, y1, x2, y2, factor):
    """Encoge el bbox un porcentaje por lado (evita bordes de papel)."""
    w, h = x2 - x1, y2 - y1
    rx, ry = int(w * factor), int(h * factor)
    return x1 + rx, y1 + ry, x2 - rx, y2 - ry


def _estimate_scale(detected: dict, layout_bboxes: dict) -> float | None:
    """Escala escaneo/layout medida con distancias entre centros de marcadores."""
    ids = [m for m in detected if str(m) in layout_bboxes]
    if len(ids) < 2:
        return None
    centers_scan = {m: detected[m].mean(axis=0) for m in ids}
    centers_lay = {}
    for m in ids:
        b = layout_bboxes[str(m)]
        centers_lay[m] = np.array([(b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0])
    ratios = []
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = ids[i], ids[j]
            d_scan = float(np.linalg.norm(centers_scan[a] - centers_scan[b]))
            d_lay = float(np.linalg.norm(centers_lay[a] - centers_lay[b]))
            if d_lay > 1:
                ratios.append(d_scan / d_lay)
    if not ratios:
        return None
    return float(np.median(ratios))


def _spread_warning(dst_pts: np.ndarray, page_w: float, page_h: float):
    """Advierte si los marcadores detectados están muy agrupados (la
    extrapolación de la homografía pierde precisión lejos de ellos)."""
    x1, y1 = dst_pts.min(axis=0)
    x2, y2 = dst_pts.max(axis=0)
    cover = ((x2 - x1) * (y2 - y1)) / max(1.0, page_w * page_h)
    if cover < 0.25:
        return ("Los marcadores detectados cubren poca superficie de la hoja; "
                "la alineación puede perder precisión en los bordes lejanos.")
    return None


# ────────────────────────────────────────────────────────────────
# Procesamiento de un escaneo
# ────────────────────────────────────────────────────────────────

def _process_one(scan_path: Path, layout: dict, out_dir: Path,
                 opts: ScanOptions, mode: str, log=None) -> ScanResult:
    t0 = time.time()
    res = ScanResult(scan=scan_path.name)
    _log = log or (lambda *_: None)

    lienzo = layout["lienzo"]
    page_w, page_h = int(lienzo["ancho_px"]), int(lienzo["alto_px"])
    minfo = layout["marcadores"]
    dict_name = minfo.get("dict", markers.DEFAULT_DICT)
    layout_bboxes = minfo["bboxes"]
    expected_ids = [int(k) for k in layout_bboxes.keys()]
    res.marcadores_total = len(expected_ids)

    img = leer_imagen_robusta(scan_path, cv2.IMREAD_UNCHANGED)
    if img is None:
        res.error = "No se pudo leer el archivo (¿corrupto o abierto en otro programa?)."
        return res
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.ndim == 3 and img.shape[2] == 4:
        img = np.ascontiguousarray(img[:, :, :3])

    try:
        # 1. Proxy pequeño para detección rápida.
        H, W = img.shape[:2]
        factor = max(1.0, max(H, W) / float(PROXY_MAX_SIDE))
        if factor > 1.0:
            proxy = cv2.resize(img, (int(W / factor), int(H / factor)),
                               interpolation=cv2.INTER_AREA)
        else:
            proxy = img
        proxy8 = _to_u8(proxy)
        if proxy8.ndim == 2:
            proxy8 = cv2.cvtColor(proxy8, cv2.COLOR_GRAY2BGR)

        estrategia, found, flipped = _detect_oriented(proxy8, dict_name,
                                                      expected_ids, mode)
        res.estrategia = estrategia
        res.marcadores = len(found)
        res.espejado = bool(flipped)
        del proxy, proxy8
        if flipped:
            img = cv2.flip(img, 1)
            res.advertencias.append(
                "El escaneo llegó EN ESPEJO (¿acetato expuesto al revés?); "
                "se volteó automáticamente antes de procesar.")

        if len(found) < max(2, int(opts.min_markers)):
            res.error = (f"Solo se detectaron {len(found)} de "
                         f"{len(expected_ids)} marcadores (mínimo: "
                         f"{opts.min_markers}). Revisa que los marcadores no "
                         f"estén tapados y que la hoja completa esté en el escaneo.")
            return res

        # 2. Afinado de esquinas a resolución completa.
        refined = _refine_corners_fullres(img, found, factor, dict_name, mode)

        # 3. Escala real del escaneo (medida, no asumida).
        s = _estimate_scale(refined, layout_bboxes)
        if s is None or not (0.2 <= s <= 12.0):
            res.error = f"No se pudo estimar la escala del escaneo (s={s})."
            return res

        diag = float(np.hypot(page_w * s, page_h * s))
        thresh = max(8.0, 0.001 * diag)

        # 3b. Recuperación guiada de los marcadores que faltan (lavados o de
        # bajo contraste): se buscan localmente donde deberían estar.
        extra = _recover_missing_markers(img, refined, layout_bboxes, s,
                                         dict_name, mode, thresh)
        if extra:
            refined.update(extra)
            res.marcadores = len(refined)
            res.advertencias.append(
                f"Recuperados {len(extra)} marcador(es) en la segunda pasada "
                f"guiada ({sorted(extra)}).")
            s2 = _estimate_scale(refined, layout_bboxes)
            if s2 is not None and 0.2 <= s2 <= 12.0:
                s = s2
        res.escala = round(s, 4)

        # 4. Homografía con TODAS las esquinas de TODOS los marcadores (RANSAC).
        def _assemble(refined_dict):
            src_l, dst_l = [], []
            for mid, corners in refined_dict.items():
                key = str(int(mid))
                if key not in layout_bboxes:
                    continue
                src_l.append(corners)
                dst_l.append(markers.bbox_corners(layout_bboxes[key]) * s)
            return (np.concatenate(src_l, axis=0),
                    np.concatenate(dst_l, axis=0))

        src_pts, dst_pts = _assemble(refined)

        warn = _spread_warning(dst_pts, page_w * s, page_h * s)
        if warn:
            res.advertencias.append(warn)

        M, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, thresh)
        if M is None:
            res.error = "No se pudo calcular la homografía (marcadores degenerados)."
            return res
        inliers = int(mask.sum()) if mask is not None else len(src_pts)
        if inliers < 8:
            res.advertencias.append(
                f"Pocos puntos consistentes en la alineación ({inliers}).")

        # 4b. Control de precisión: residuo de reproyección por marcador.
        # Un marcador mal identificado o con esquinas corridas dentro del
        # umbral RANSAC sesga todos los recortes en silencio; aquí se detecta,
        # se descarta y se recalcula la homografía.
        px_mm = _px_per_mm(layout, s)
        resid = _marker_residuals(M, refined, layout_bboxes, s)
        if resid:
            med = float(np.median(list(resid.values())))
            lim = max(2.5 * px_mm, 3.0 * med)
            malos = [m for m, r in resid.items() if r > lim]
            if malos and len(refined) - len(malos) >= max(
                    3, int(opts.min_markers)):
                for m in malos:
                    refined.pop(m, None)
                res.advertencias.append(
                    f"Marcador(es) {sorted(malos)} descartados por residuo "
                    f"inconsistente (> {lim / px_mm:.1f} mm).")
                src_pts, dst_pts = _assemble(refined)
                M2, _ = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, thresh)
                if M2 is not None:
                    M = M2
                resid = _marker_residuals(M, refined, layout_bboxes, s)
            res.residual_mm = round(
                float(np.median(list(resid.values()))) / px_mm, 3)
            if res.residual_mm > 1.0:
                res.advertencias.append(
                    f"Alineación imprecisa (residuo ±{res.residual_mm:.1f} mm): "
                    "el papel probablemente se deformó al mojarse. Los "
                    "recortes se corrigen localmente con los marcadores "
                    "cercanos.")

        # 4c. Corrector local de recortes (papel deformado en húmedo).
        local_shift = None
        if opts.fine_align:
            local_shift = _make_local_shift(M, refined, layout_bboxes, s)

        out_w, out_h = int(round(page_w * s)), int(round(page_h * s))
        warp = cv2.warpPerspective(img, M, (out_w, out_h),
                                   flags=cv2.INTER_LANCZOS4)
        del img
        gc.collect()

        # 5. Normalización opcional con la tira de parches de grises.
        if opts.normalize_patches and layout.get("parche_grises"):
            warp = _normalize_with_patches(warp, layout["parche_grises"], s,
                                           res)

        # 6. Identificar la hoja con CUALQUIER QR legible.
        hoja, via = _identify_sheet(warp, layout, s, local_shift)
        if hoja is None and len(layout.get("hojas", [])) == 1:
            # Descarte: si el layout describe UNA sola hoja, tiene que ser esa.
            hoja = layout["hojas"][0]
            via = "única hoja del layout"
            res.advertencias.append(
                "Ningún QR legible: hoja identificada por descarte (el layout "
                "tiene una sola hoja).")
        if hoja is None:
            # Modo emergencia: guardar recortes sin identidad.
            res.advertencias.append(
                "Ningún QR legible: recortes guardados en 'sin_identificar/'.")
            emergencia = out_dir / "sin_identificar"
            emergencia.mkdir(parents=True, exist_ok=True)
            plantilla = layout["hojas"][0] if layout.get("hojas") else None
            if plantilla:
                for i, (_, info) in enumerate(sorted(
                        plantilla["frames"].items(),
                        key=lambda kv: kv[1].get("celda") or 0)):
                    crop = _crop_frame(warp, info["bbox"], s, opts.bleed,
                                       local_shift)
                    nombre = f"{scan_path.stem}_celda{i + 1}.tif"
                    ruta = emergencia / nombre
                    if escribir_imagen_robusta(ruta, crop,
                                               [cv2.IMWRITE_TIFF_COMPRESSION, 1]):
                        res.sin_identificar.append(str(ruta))
            if opts.report:
                _save_overlay(out_dir, scan_path, warp, s, layout,
                              layout_bboxes, refined, plantilla, res)
            res.error = "QRs ilegibles: no se pudo identificar la hoja."
            return res

        res.hoja_numero = hoja.get("numero")
        res.archivo_hoja = hoja.get("archivo_hoja")
        _log(f"    ✓ {scan_path.name}: hoja {res.hoja_numero} identificada "
             f"({via}), {res.marcadores}/{res.marcadores_total} marcadores, "
             f"escala {res.escala:g}×"
             + (f", residuo ±{res.residual_mm:g} mm" if res.residual_mm else "")
             + (" (espejado)" if res.espejado else ""))

        if opts.report:
            _save_overlay(out_dir, scan_path, warp, s, layout, layout_bboxes,
                          refined, hoja, res)

        # 7. Recortar y guardar cada fotograma.
        for etiqueta, info in hoja["frames"].items():
            crop = _crop_frame(warp, info["bbox"], s, opts.bleed, local_shift)
            if crop is None or crop.size == 0:
                res.advertencias.append(f"Recorte vacío para '{etiqueta}'.")
                continue
            if opts.resize_to_original and info.get("orig_px"):
                ow, oh = int(info["orig_px"][0]), int(info["orig_px"][1])
                if ow > 0 and oh > 0:
                    interp = (cv2.INTER_AREA
                              if ow < crop.shape[1] else cv2.INTER_LANCZOS4)
                    crop = cv2.resize(crop, (ow, oh), interpolation=interp)
            from .core import sanitize_label
            nombre = f"{sanitize_label(etiqueta)}{opts.output_suffix}.tif"
            ruta = out_dir / nombre
            if escribir_imagen_robusta(ruta, crop,
                                       [cv2.IMWRITE_TIFF_COMPRESSION, 1]):
                res.frames[etiqueta] = str(ruta)
            else:
                res.advertencias.append(f"No se pudo guardar '{nombre}'.")

        res.ok = len(res.frames) > 0
        return res
    except MemoryError:
        res.error = ("Memoria insuficiente para este escaneo. Cierra otros "
                     "programas o baja el número de procesos en paralelo.")
        return res
    except Exception as e:  # un escaneo malo no debe tumbar el lote
        res.error = f"{type(e).__name__}: {e}"
        return res
    finally:
        res.segundos = round(time.time() - t0, 2)
        gc.collect()


def _crop_frame(warp: np.ndarray, bbox, s: float, bleed: float,
                local_shift=None):
    fx1, fy1, fx2, fy2 = [v * s for v in bbox]
    if local_shift is not None:
        dx, dy = local_shift((fx1, fy1, fx2, fy2))
        fx1, fx2 = fx1 + dx, fx2 + dx
        fy1, fy2 = fy1 + dy, fy2 + dy
    x1, y1, x2, y2 = (int(round(fx1)), int(round(fy1)),
                      int(round(fx2)), int(round(fy2)))
    x1, y1, x2, y2 = aplicar_bleed(x1, y1, x2, y2, bleed)
    H, W = warp.shape[:2]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(W, x2), min(H, y2)
    if x2 <= x1 or y2 <= y1:
        return None
    return warp[y1:y2, x1:x2].copy()


def _identify_sheet(warp: np.ndarray, layout: dict, s: float,
                    local_shift=None):
    """Busca un QR legible para identificar la hoja.

    Con el formato v2 el contenido del QR incluye el número de hoja, así que
    aunque se pruebe la geometría de otra hoja, el texto decodificado apunta a
    la hoja correcta. Devuelve (hoja_dict, descripcion) o (None, None).
    """
    hojas = layout.get("hojas", [])
    probadas = set()
    for hoja_geom in hojas:
        for etiqueta, qinfo in hoja_geom.get("qrs", {}).items():
            bbox = tuple(qinfo["bbox"])
            if bbox in probadas:
                continue
            probadas.add(bbox)
            fx1, fy1, fx2, fy2 = [v * s for v in bbox]
            if local_shift is not None:
                dx, dy = local_shift((fx1, fy1, fx2, fy2))
                fx1, fx2 = fx1 + dx, fx2 + dx
                fy1, fy2 = fy1 + dy, fy2 + dy
            x1, y1, x2, y2 = (int(round(fx1)), int(round(fy1)),
                              int(round(fx2)), int(round(fy2)))
            pad = int((x2 - x1) * 0.35)
            H, W = warp.shape[:2]
            cx1, cy1 = max(0, x1 - pad), max(0, y1 - pad)
            cx2, cy2 = min(W, x2 + pad), min(H, y2 + pad)
            if cx2 <= cx1 or cy2 <= cy1:
                continue
            texto = _decode_qr(warp[cy1:cy2, cx1:cx2])
            payload = markers.parse_qr_payload(texto) if texto else None
            if not payload:
                continue
            if payload.get("hoja") is not None:
                hoja = layoutfile.sheet_by_number(layout, payload["hoja"])
                if hoja is not None:
                    return hoja, f"QR de '{payload.get('etiqueta', '?')}'"
            # QR v1: solo la etiqueta; buscar la hoja que la contiene.
            lab = payload.get("etiqueta")
            if lab:
                for h in hojas:
                    if lab in h.get("frames", {}):
                        return h, f"QR v1 de '{lab}'"
    return None, None


def _save_overlay(out_dir: Path, scan_path: Path, warp: np.ndarray, s: float,
                  layout: dict, layout_bboxes: dict, refined: dict,
                  hoja: dict | None, res: ScanResult) -> None:
    """Miniatura de diagnóstico del escaneo alineado: marcadores detectados
    (verde) y perdidos (rojo), recortes de fotogramas (azul) y QRs (naranja).
    Cuando algo mapea mal, aquí se ve dónde y por qué en dos segundos."""
    try:
        k = min(1.0, 1600.0 / max(warp.shape[:2]))
        mini = _to_u8(warp)
        if k < 1.0:
            mini = cv2.resize(mini, (0, 0), fx=k, fy=k,
                              interpolation=cv2.INTER_AREA)
        if mini.ndim == 2:
            mini = cv2.cvtColor(mini, cv2.COLOR_GRAY2BGR)
        else:
            mini = mini.copy()
        t = 2  # grosor de línea en la miniatura

        def _rect(bbox, color, thick):
            p1 = (int(round(bbox[0] * s * k)), int(round(bbox[1] * s * k)))
            p2 = (int(round(bbox[2] * s * k)), int(round(bbox[3] * s * k)))
            cv2.rectangle(mini, p1, p2, color, thick)

        detectados = {int(m) for m in refined}
        for mid, bbox in layout_bboxes.items():
            ok = int(mid) in detectados
            _rect(bbox, (0, 200, 0) if ok else (0, 0, 230), t if ok else t * 2)
        plantilla = hoja or (layout["hojas"][0] if layout.get("hojas") else None)
        if plantilla:
            for info in plantilla.get("frames", {}).values():
                _rect(info["bbox"], (255, 140, 0), t)
            for qinfo in plantilla.get("qrs", {}).values():
                _rect(qinfo["bbox"], (0, 165, 255), t)
        texto = (f"{res.marcadores}/{res.marcadores_total} marcadores"
                 + (f" | residuo {res.residual_mm:g} mm" if res.residual_mm else "")
                 + (" | ESPEJADO" if res.espejado else ""))
        cv2.putText(mini, texto, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                    (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(mini, texto, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                    (255, 255, 255), 1, cv2.LINE_AA)

        thumb_dir = out_dir / "_informe"
        thumb_dir.mkdir(parents=True, exist_ok=True)
        ruta = thumb_dir / f"{scan_path.stem}_alineacion.jpg"
        if escribir_imagen_robusta(ruta, mini, [cv2.IMWRITE_JPEG_QUALITY, 82]):
            res.overlay = f"_informe/{ruta.name}"
    except Exception:
        pass  # el diagnóstico nunca debe tumbar el procesamiento


def _normalize_with_patches(warp: np.ndarray, patch_info: dict, s: float,
                            res: ScanResult):
    """Normaliza niveles usando los parches negro/blanco de la tira.

    Corrección LINEAL por canal (mapea el negro y el blanco medidos a sus
    valores nominales). Es una ayuda opcional: apagada por defecto para
    respetar la filosofía de "no tocar el color".
    """
    try:
        bboxes = patch_info["bboxes"]
        niveles = patch_info["niveles"]
        i_black = niveles.index(min(niveles))
        i_white = niveles.index(max(niveles))
        maxv = 65535.0 if warp.dtype == np.uint16 else 255.0

        def _mean(bbox):
            x1, y1, x2, y2 = [int(round(v * s)) for v in bbox]
            x1, y1, x2, y2 = aplicar_bleed(x1, y1, x2, y2, 0.25)
            region = warp[max(0, y1):y2, max(0, x1):x2]
            if region.size == 0:
                return None
            return region.reshape(-1, region.shape[-1]).mean(axis=0)

        black = _mean(bboxes[i_black])
        white = _mean(bboxes[i_white])
        if black is None or white is None:
            return warp
        black_t = maxv * (min(niveles) / 255.0)
        white_t = maxv * (max(niveles) / 255.0)
        out = warp.astype(np.float32)
        for ch in range(out.shape[-1]):
            b, w = float(black[ch]), float(white[ch])
            if w - b < maxv * 0.05:
                return warp  # parches ilegibles; no tocar
            out[..., ch] = (out[..., ch] - b) * ((white_t - black_t) / (w - b)) + black_t
        out = np.clip(out, 0, maxv)
        res.advertencias.append("Niveles normalizados con la tira de parches.")
        return out.astype(warp.dtype)
    except Exception:
        return warp


# ────────────────────────────────────────────────────────────────
# Lote completo + informe
# ────────────────────────────────────────────────────────────────

def listar_escaneos(input_dir) -> list[Path]:
    input_dir = Path(input_dir)
    return sorted([p for p in input_dir.iterdir()
                   if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS])


def procesar_carpeta(input_dir, layout_path, output_dir,
                     opts: ScanOptions | None = None,
                     progress_cb=None, cancel_check=None, log=None) -> dict:
    """Procesa todos los escaneos de una carpeta. Devuelve el informe (dict).

    progress_cb(hechos, total) y log(texto) pueden llamarse desde varios hilos.
    """
    opts = opts or ScanOptions()
    _log = log or (lambda *_: None)
    input_dir = Path(input_dir)
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    layout = layoutfile.load(layout_path)
    mode = opts.mode
    if mode == "auto":
        mode = layout.get("modo", "normal")
    _log(f"Layout: {Path(layout_path).name}  ·  modo de detección: {mode}")

    scans = listar_escaneos(input_dir)
    if not scans:
        raise FileNotFoundError(
            f"No se encontraron imágenes en {input_dir} "
            f"(extensiones: {', '.join(sorted(SUPPORTED_EXTENSIONS))}).")
    _log(f"{len(scans)} escaneo(s) por procesar con {opts.threads} en paralelo…")

    results: list[ScanResult] = []
    done = 0
    lock = threading.Lock()

    def _run(p: Path) -> ScanResult:
        if cancel_check and cancel_check():
            r = ScanResult(scan=p.name)
            r.error = "Cancelado."
            return r
        return _process_one(p, layout, out_dir, opts, mode, log=_log)

    with ThreadPoolExecutor(max_workers=max(1, int(opts.threads))) as ex:
        futures = {ex.submit(_run, p): p for p in scans}
        for fut in as_completed(futures):
            r = fut.result()
            with lock:
                results.append(r)
                done += 1
            if r.error and r.error != "Cancelado.":
                _log(f"    ⚠️ {r.scan}: {r.error}")
            if progress_cb:
                progress_cb(done, len(scans))

    if cancel_check and cancel_check():
        raise _Cancelled()

    results.sort(key=lambda r: r.scan)
    reporte = _build_report(layout, results, out_dir, opts)
    if opts.report:
        _write_report_files(reporte, results, out_dir)
        _log(f"Informe guardado en: {out_dir / 'informe.html'}")
    return reporte


def _build_report(layout: dict, results: list[ScanResult], out_dir: Path,
                  opts: ScanOptions) -> dict:
    esperadas = {}
    for hoja in layout.get("hojas", []):
        for etiqueta in hoja.get("frames", {}):
            esperadas[etiqueta] = hoja.get("numero")

    extraidas = {}
    for r in results:
        extraidas.update(r.frames)

    faltantes = sorted([e for e in esperadas if e not in extraidas])
    hojas_ok = sorted({r.hoja_numero for r in results if r.ok and r.hoja_numero})
    hojas_fallidas = [r.scan for r in results if not r.ok]

    return {
        "fecha": time.strftime("%Y-%m-%d %H:%M:%S"),
        "salida": str(out_dir),
        "modo": layout.get("modo", "normal"),
        "escaneos_procesados": len(results),
        "escaneos_ok": sum(1 for r in results if r.ok),
        "hojas_identificadas": hojas_ok,
        "escaneos_fallidos": hojas_fallidas,
        "frames_extraidos": len(extraidas),
        "frames_esperados": len(esperadas),
        "etiquetas_faltantes": faltantes,
        "resultados": [r.__dict__ for r in results],
    }


def _write_report_files(reporte: dict, results: list[ScanResult],
                        out_dir: Path) -> None:
    # JSON (para la app: hojas de rescate, reconstrucción de video…).
    with open(out_dir / "informe.json", "w", encoding="utf-8") as f:
        json.dump(reporte, f, indent=2, ensure_ascii=False)

    # CSV sencillo.
    with open(out_dir / "informe.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["escaneo", "ok", "hoja", "marcadores", "estrategia",
                    "escala", "espejado", "residual_mm", "frames", "error"])
        for r in results:
            w.writerow([r.scan, r.ok, r.hoja_numero, f"{r.marcadores}/{r.marcadores_total}",
                        r.estrategia, r.escala, r.espejado, r.residual_mm,
                        len(r.frames), r.error])

    # Miniaturas + HTML.
    thumb_dir = out_dir / "_informe"
    thumb_dir.mkdir(exist_ok=True)
    filas = []
    for r in results:
        estado = "✅" if r.ok else "❌"
        thumbs = []
        if r.overlay:
            thumbs.append(
                f'<figure><img src="{html_mod.escape(r.overlay)}" '
                f'style="max-width:420px">'
                f"<figcaption>alineación (verde=marcador detectado, "
                f"rojo=perdido, azul=frames, naranja=QRs)</figcaption></figure>")
        for etiqueta, ruta in sorted(r.frames.items()):
            tpath = thumb_dir / (Path(ruta).stem + "_mini.jpg")
            try:
                img = leer_imagen_robusta(Path(ruta), cv2.IMREAD_COLOR)
                if img is not None:
                    h, w2 = img.shape[:2]
                    k = 220.0 / max(1, w2)
                    mini = cv2.resize(img, (int(w2 * k), int(h * k)),
                                      interpolation=cv2.INTER_AREA)
                    escribir_imagen_robusta(tpath, mini,
                                            [cv2.IMWRITE_JPEG_QUALITY, 82])
                    thumbs.append(
                        f'<figure><img src="_informe/{tpath.name}">'
                        f"<figcaption>{html_mod.escape(etiqueta)}</figcaption></figure>")
            except Exception:
                pass
        advertencias = "<br>".join(html_mod.escape(a) for a in r.advertencias)
        error = html_mod.escape(r.error or "")
        residuo = f"±{r.residual_mm:g} mm" if r.residual_mm else "—"
        if r.espejado:
            residuo += " · 🪞 espejado"
        filas.append(f"""
        <tr>
          <td>{estado}</td><td>{html_mod.escape(r.scan)}</td>
          <td>{r.hoja_numero if r.hoja_numero else '—'}</td>
          <td>{r.marcadores}/{r.marcadores_total}</td>
          <td>{residuo}</td>
          <td>{len(r.frames)}</td>
          <td class="warn">{advertencias}{('<br><b>' + error + '</b>') if error else ''}</td>
        </tr>
        <tr><td></td><td colspan="6" class="thumbs">{''.join(thumbs)}</td></tr>""")

    faltantes = reporte["etiquetas_faltantes"]
    faltantes_html = (
        "<p class='missing'><b>Fotogramas faltantes ("
        + str(len(faltantes)) + "):</b> "
        + ", ".join(html_mod.escape(x) for x in faltantes)
        + "<br>Usa el botón <i>«Generar hojas de rescate»</i> en la app para "
          "reimprimir solo estos.</p>") if faltantes else \
        "<p class='allok'><b>🎉 No falta ningún fotograma.</b></p>"

    html_doc = f"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Informe de procesamiento — Kamiru Studio</title>
<style>
 body {{ font-family: system-ui, sans-serif; margin: 2em; color: #243038; }}
 h1 {{ color: #15795A; }}
 table {{ border-collapse: collapse; width: 100%; }}
 td, th {{ border: 1px solid #D5DCE2; padding: 6px 10px; vertical-align: top; }}
 th {{ background: #E5EBEF; text-align: left; }}
 .thumbs figure {{ display: inline-block; margin: 4px; text-align: center; }}
 .thumbs img {{ border: 1px solid #ccc; display: block; }}
 .thumbs figcaption {{ font-size: 11px; color: #6B7B88; }}
 .warn {{ color: #8a6d3b; font-size: 13px; }}
 .missing {{ background: #fdecea; padding: 1em; border-radius: 8px; }}
 .allok {{ background: #e8f6ef; padding: 1em; border-radius: 8px; }}
</style></head><body>
<h1>Informe de procesamiento de escaneos</h1>
<p>{reporte['fecha']} · modo <b>{reporte['modo']}</b> ·
 {reporte['escaneos_ok']}/{reporte['escaneos_procesados']} escaneos correctos ·
 {reporte['frames_extraidos']}/{reporte['frames_esperados']} fotogramas extraídos</p>
{faltantes_html}
<table>
<tr><th></th><th>Escaneo</th><th>Hoja</th><th>Marcadores</th><th>Alineación</th><th>Frames</th><th>Notas</th></tr>
{''.join(filas)}
</table></body></html>"""
    with open(out_dir / "informe.html", "w", encoding="utf-8") as f:
        f.write(html_doc)


class _Cancelled(Exception):
    pass
