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
* MODO CIANOTIPIA: preprocesado especial (canal rojo + CLAHE) para detectar
  marcadores y QRs sobre los tonos azules variables del azul de Prusia.
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


def _gray_variants(bgr8: np.ndarray, mode: str):
    """Genera versiones en escala de grises del escaneo, en orden de
    probabilidad de éxito según el modo.

    Para cianotipia el canal ROJO es clave: el azul de Prusia es casi negro en
    ese canal, así que marcadores/QRs azules sobre papel claro quedan con
    contraste máximo, sin importar la tonalidad exacta del azul.
    """
    gray = cv2.cvtColor(bgr8, cv2.COLOR_BGR2GRAY)
    red = bgr8[:, :, 2].copy()
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))

    if mode == "cianotipia":
        yield "canal_rojo", red
        yield "canal_rojo_clahe", clahe.apply(red)
        yield "gris", gray
        yield "gris_clahe", clahe.apply(gray)
        yield "gris_norm", cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)
    else:
        yield "gris", gray
        yield "canal_rojo", red
        yield "gris_clahe", clahe.apply(gray)
        yield "canal_rojo_clahe", clahe.apply(red)
        yield "gris_norm", cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)


def _make_detector(dict_name: str):
    aruco_dict = markers.get_dictionary(dict_name)
    params = cv2.aruco.DetectorParameters()
    try:
        params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    except Exception:
        pass
    return cv2.aruco.ArucoDetector(aruco_dict, params)


def _detect_markers_multi(bgr8: np.ndarray, dict_name: str, expected_ids,
                          mode: str):
    """Prueba varias estrategias de preprocesado y devuelve la mejor detección.

    Returns:
        (estrategia, {id: corners_4x2_float32}) — corners en coords de bgr8.
    """
    detector = _make_detector(dict_name)
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


def _refine_corners_fullres(img_full: np.ndarray, proxy_corners: dict,
                            factor: float, dict_name: str, mode: str):
    """Re-detecta cada marcador en un recorte a resolución completa para
    obtener esquinas precisas. Si falla, usa las del proxy reescaladas."""
    detector = _make_detector(dict_name)
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


# ────────────────────────────────────────────────────────────────
# Lectura de códigos QR
# ────────────────────────────────────────────────────────────────

def _decode_qr(crop_bgr: np.ndarray) -> str | None:
    """Decodifica un QR probando varias mejoras de imagen.

    OpenCV primero (sin dependencias nativas); pyzbar de refuerzo si está.
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

    detector = cv2.QRCodeDetector()
    for v in variants:
        try:
            data, pts, _ = detector.detectAndDecode(v)
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

        estrategia, found = _detect_markers_multi(proxy8, dict_name,
                                                  expected_ids, mode)
        res.estrategia = estrategia
        res.marcadores = len(found)
        del proxy, proxy8

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
        res.escala = round(s, 4)

        # 4. Homografía con TODAS las esquinas de TODOS los marcadores (RANSAC).
        src_list, dst_list = [], []
        for mid, corners in refined.items():
            key = str(int(mid))
            if key not in layout_bboxes:
                continue
            dst_c = markers.bbox_corners(layout_bboxes[key]) * s
            src_list.append(corners)
            dst_list.append(dst_c)
        src_pts = np.concatenate(src_list, axis=0)
        dst_pts = np.concatenate(dst_list, axis=0)

        warn = _spread_warning(dst_pts, page_w * s, page_h * s)
        if warn:
            res.advertencias.append(warn)

        diag = float(np.hypot(page_w * s, page_h * s))
        thresh = max(8.0, 0.001 * diag)
        M, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, thresh)
        if M is None:
            res.error = "No se pudo calcular la homografía (marcadores degenerados)."
            return res
        inliers = int(mask.sum()) if mask is not None else len(src_pts)
        if inliers < 8:
            res.advertencias.append(
                f"Pocos puntos consistentes en la alineación ({inliers}).")

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
        hoja, via = _identify_sheet(warp, layout, s)
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
                    crop = _crop_frame(warp, info["bbox"], s, opts.bleed)
                    nombre = f"{scan_path.stem}_celda{i + 1}.tif"
                    ruta = emergencia / nombre
                    if escribir_imagen_robusta(ruta, crop,
                                               [cv2.IMWRITE_TIFF_COMPRESSION, 1]):
                        res.sin_identificar.append(str(ruta))
            res.error = "QRs ilegibles: no se pudo identificar la hoja."
            return res

        res.hoja_numero = hoja.get("numero")
        res.archivo_hoja = hoja.get("archivo_hoja")
        _log(f"    ✓ {scan_path.name}: hoja {res.hoja_numero} identificada "
             f"({via}), {res.marcadores}/{res.marcadores_total} marcadores, "
             f"escala {res.escala:g}×")

        # 7. Recortar y guardar cada fotograma.
        for etiqueta, info in hoja["frames"].items():
            crop = _crop_frame(warp, info["bbox"], s, opts.bleed)
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


def _crop_frame(warp: np.ndarray, bbox, s: float, bleed: float):
    x1, y1, x2, y2 = [int(round(v * s)) for v in bbox]
    x1, y1, x2, y2 = aplicar_bleed(x1, y1, x2, y2, bleed)
    H, W = warp.shape[:2]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(W, x2), min(H, y2)
    if x2 <= x1 or y2 <= y1:
        return None
    return warp[y1:y2, x1:x2].copy()


def _identify_sheet(warp: np.ndarray, layout: dict, s: float):
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
            x1, y1, x2, y2 = [int(round(v * s)) for v in bbox]
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
                    "escala", "frames", "error"])
        for r in results:
            w.writerow([r.scan, r.ok, r.hoja_numero, f"{r.marcadores}/{r.marcadores_total}",
                        r.estrategia, r.escala, len(r.frames), r.error])

    # Miniaturas + HTML.
    thumb_dir = out_dir / "_informe"
    thumb_dir.mkdir(exist_ok=True)
    filas = []
    for r in results:
        estado = "✅" if r.ok else "❌"
        thumbs = []
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
        filas.append(f"""
        <tr>
          <td>{estado}</td><td>{html_mod.escape(r.scan)}</td>
          <td>{r.hoja_numero if r.hoja_numero else '—'}</td>
          <td>{r.marcadores}/{r.marcadores_total}</td>
          <td>{len(r.frames)}</td>
          <td class="warn">{advertencias}{('<br><b>' + error + '</b>') if error else ''}</td>
        </tr>
        <tr><td></td><td colspan="5" class="thumbs">{''.join(thumbs)}</td></tr>""")

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
<tr><th></th><th>Escaneo</th><th>Hoja</th><th>Marcadores</th><th>Frames</th><th>Notas</th></tr>
{''.join(filas)}
</table></body></html>"""
    with open(out_dir / "informe.html", "w", encoding="utf-8") as f:
        f.write(html_doc)


class _Cancelled(Exception):
    pass
