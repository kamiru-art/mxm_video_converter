"""Hojas de rescate: reimprimir SOLO los fotogramas que fallaron.

Después de procesar los escaneos, el informe lista los fotogramas que no se
pudieron recuperar (QR pintado, hoja perdida, escaneo cortado…). Este módulo
regenera hojas de impresión que contienen únicamente esos fotogramas, usando
los MISMOS ajustes de la tanda original (guardados dentro del layout.json) y
las copias de los fotogramas originales que la app guardó al generar.

El resultado incluye su propio layout de rescate: se imprime, se pinta (o se
expone, en cianotipia), se escanea y se procesa apuntando a ese layout; los
fotogramas recuperados caen en la misma carpeta de salida que el resto.
"""

from __future__ import annotations

from pathlib import Path

from . import core, layoutfile


def _safe_join(base: Path, rel: str) -> Path | None:
    """Une base/rel de forma segura para rutas que vienen de un layout.json
    (archivo compartible entre usuarios): rechaza rutas absolutas y cualquier
    salto fuera de ``base`` mediante "..". Devuelve la ruta resuelta o None."""
    if not rel:
        return None
    if Path(rel).is_absolute():
        return None
    try:
        cand = (base / rel).resolve()
        cand.relative_to(base.resolve())
    except (ValueError, OSError):
        return None
    return cand


def generar_hojas_rescate(layout_path, faltantes, out_dir=None, log=None) -> dict:
    """Genera hojas con los fotogramas faltantes.

    Args:
        layout_path: ruta al layout.json ORIGINAL (v2, generado por esta app).
        faltantes: lista de etiquetas a reimprimir.
        out_dir: carpeta de salida (por defecto '<carpeta del layout>/rescate').
        log: callback opcional log(texto).

    Returns:
        El dict que devuelve core.generate() (con 'layout', 'pages', 'pdf'…).
    """
    _log = log or (lambda *_: None)
    layout_path = Path(layout_path)
    layout = layoutfile.load(layout_path)

    ajustes = layout.get("ajustes")
    if not ajustes:
        raise ValueError(
            "Este layout.json no incluye los ajustes de generación (¿es de la "
            "versión antigua?). Genera las hojas con Kamiru Studio para poder "
            "usar hojas de rescate.")

    base_dir = layout_path.parent
    lookup = layoutfile.label_lookup(layout)
    originals_dir = layout.get("originales_dir")

    frames, labels, sin_original = [], [], []
    for etiqueta in faltantes:
        entry = lookup.get(etiqueta)
        ruta = None
        if entry:
            _, info = entry
            cand = _safe_join(base_dir, info.get("archivo_original") or "")
            if cand and cand.is_file():
                ruta = cand
        if ruta is None and originals_dir:
            orig_root = _safe_join(base_dir, originals_dir)
            if orig_root and orig_root.is_dir():
                safe = core.sanitize_label(etiqueta)
                for c in sorted(orig_root.glob(f"{safe}.*")):
                    ruta = c
                    break
        if ruta is None:
            sin_original.append(etiqueta)
            continue
        frames.append(str(ruta))
        labels.append(etiqueta)

    if sin_original:
        _log("⚠️ Sin copia original (no se pueden reimprimir): "
             + ", ".join(sin_original))
        _log("   Consejo: activa «Guardar copia de los fotogramas originales» "
             "al generar las hojas.")
    if not frames:
        raise ValueError(
            "No se encontró la copia original de ningún fotograma faltante; "
            "no hay nada que reimprimir.")

    s = core.Settings(**{k: v for k, v in ajustes.items() if v is not None})
    base_name = s.out_name or "hojas"
    if base_name.endswith("_rescate"):
        base_name = base_name[: -len("_rescate")]
    s.out_name = f"{base_name}_rescate"
    s.out_dir = str(out_dir or (base_dir / "rescate"))
    s.registration_on = True          # las hojas de rescate siempre llevan registro
    s.keep_originals = True
    s.sheets_include = ""
    s.sheets_exclude = ""
    s.page_num_start = 1
    s.page_num_prefix = (s.page_num_prefix or "") + "R"  # se nota que es rescate

    _log(f"Generando hojas de rescate con {len(frames)} fotograma(s)…")
    result = core.generate(s, frames, labels=labels)
    result["sin_original"] = sin_original
    return result
