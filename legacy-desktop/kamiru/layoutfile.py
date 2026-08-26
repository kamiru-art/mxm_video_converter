"""Lectura/escritura del archivo puente layout.json (versión 2).

El layout.json conecta la fase de impresión con la fase de escaneo: describe
la geometría exacta de cada hoja (marcadores, celdas, QRs, fotogramas) para
que el procesador de escaneos recorte cada pieza sin adivinar nada.

Esquema v2 (resumen):

    {
      "version": 2,
      "app": "kamiru-studio",
      "proyecto": "nombre del proyecto",
      "modo": "normal" | "cianotipia",
      "espejado": false,
      "lienzo": {"ancho_px", "alto_px", "dpi", "orientacion"},
      "marcadores": {"dict", "cantidad", "lado_px", "bboxes": {"0": [x1,y1,x2,y2], ...}},
      "parche_grises": {"bboxes": [[...], ...], "niveles": [0, 128, 255]} | null,
      "hojas": [
        {"numero": 1, "archivo_hoja": "...",
         "frames": {"etiqueta": {"bbox": [...], "celda": 0,
                                  "archivo_original": "...", "orig_px": [w, h]}},
         "qrs": {"etiqueta": {"bbox": [...], "celda": 0, "texto": "K2|..."}}}
      ],
      "timeline": [{"pos": 1, "etiqueta": "abc_001", "rep": "abc_001"}, ...],
      "video": {"fps_extraccion": 12.0, "origen": "clip.mp4"},
      "originales_dir": "abc_originales"
    }

También se pueden LEER los layout.json de la versión 1 (generados por el
antiguo kamiru_mxm_scans_helper): se convierten al esquema v2 en memoria, de
modo que los proyectos viejos se siguen pudiendo procesar.
"""

from __future__ import annotations

import json
from pathlib import Path

# Geometría implícita de la versión 1 (constantes del generador antiguo).
V1_ARUCO_SIZE_PX = 100
V1_ARUCO_MARGIN_PX = 40
V1_DICT = "DICT_4X4_50"


def save(data: dict, path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def load(path) -> dict:
    """Carga un layout.json (v1 o v2) y lo normaliza al esquema v2."""
    path = Path(path)
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if data.get("version", 1) >= 2:
        return data

    return _from_v1(data)


def _from_v1(data: dict) -> dict:
    """Convierte un layout v1 (kamiru_mxm_scans_helper) al esquema v2."""
    lienzo = data.get("lienzo", {})
    w = int(lienzo.get("ancho_px", 2480))
    h = int(lienzo.get("alto_px", 3508))

    # v1: 4 ArUcos en las esquinas, IDs 0-3 (TL, TR, BR, BL).
    m, s = V1_ARUCO_MARGIN_PX, V1_ARUCO_SIZE_PX
    bboxes = {
        "0": [m, m, m + s, m + s],
        "1": [w - m - s, m, w - m, m + s],
        "2": [w - m - s, h - m - s, w - m, h - m],
        "3": [m, h - m - s, m + s, h - m],
    }

    hojas = []
    for i, hoja in enumerate(data.get("hojas", []), start=1):
        frames = {}
        for nombre, info in hoja.get("frames", {}).items():
            frames[nombre] = {
                "bbox": info["bbox"],
                "celda": None,
                "archivo_original": info.get("archivo_original", nombre),
                "orig_px": None,
            }
        qrs = {}
        for nombre, info in hoja.get("qrs", {}).items():
            qrs[nombre] = {
                "bbox": info["bbox"],
                "celda": None,
                # v1 codificaba solo el nombre del frame en el QR.
                "texto": nombre,
            }
        hojas.append({
            "numero": i,
            "archivo_hoja": hoja.get("archivo_hoja", f"hoja_{i:03d}.tif"),
            "frames": frames,
            "qrs": qrs,
        })

    return {
        "version": 2,
        "app": "kamiru-mxm-v1",
        "proyecto": "",
        "modo": "normal",
        "espejado": False,
        "lienzo": {
            "ancho_px": w,
            "alto_px": h,
            "dpi": int(lienzo.get("ppi", 300)),
            "orientacion": lienzo.get("orientacion", "portrait"),
        },
        "marcadores": {
            "dict": V1_DICT,
            "cantidad": 4,
            "lado_px": s,
            "bboxes": bboxes,
        },
        "parche_grises": None,
        "hojas": hojas,
        "timeline": [],
        "video": {},
        "originales_dir": None,
    }


def sheet_by_number(layout: dict, numero: int):
    """Devuelve la entrada de hoja con ese número, o None."""
    for hoja in layout.get("hojas", []):
        if hoja.get("numero") == numero:
            return hoja
    return None


def label_lookup(layout: dict) -> dict:
    """{etiqueta: (hoja_dict, frame_info)} para búsqueda rápida por etiqueta."""
    out = {}
    for hoja in layout.get("hojas", []):
        for etiqueta, info in hoja.get("frames", {}).items():
            out[etiqueta] = (hoja, info)
    return out
