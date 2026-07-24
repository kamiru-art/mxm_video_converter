#!/usr/bin/env python3
"""Prueba de integración del pipeline completo de Kamiru Studio (sin GUI).

Simula el mundo físico: genera hojas, las "imprime y escanea" (rotación +
perspectiva + ruido + marcadores tapados + reescalado), las procesa y verifica
que cada fotograma se recupere con el nombre y la geometría correctos. También
prueba el modo cianotipia (con tonos azules variables), la calibración, la
deduplicación, las hojas de rescate y la reconstrucción del video.

Uso:  python3 tests/test_pipeline.py
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

# La consola de Windows usa cp1252 por defecto y no puede imprimir los
# emojis/box-drawing de este reporte; se fuerza UTF-8 (con reemplazo).
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

import cv2
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kamiru import calibration, core, cyanotype, dedup, layoutfile, markers, rescue, scan  # noqa: E402

TMP = Path(tempfile.mkdtemp(prefix="kamiru_test_"))
PASSED = []


def check(name, cond, detail=""):
    status = "OK " if cond else "FALLO"
    print(f"  [{status}] {name}" + (f" — {detail}" if detail and not cond else ""))
    PASSED.append((name, bool(cond)))
    return cond


def make_frames(dir_, n=10, size=(640, 360), dup_pairs=()):
    """Crea fotogramas sintéticos distinguibles; dup_pairs=(i, j) hace j≈i."""
    dir_ = Path(dir_)
    dir_.mkdir(parents=True, exist_ok=True)
    paths = []
    rng = np.random.default_rng(7)
    base_imgs = {}
    for i in range(n):
        dup_of = None
        for a, b in dup_pairs:
            if i == b:
                dup_of = a
        if dup_of is not None and dup_of in base_imgs:
            arr = base_imgs[dup_of].copy()
        else:
            w, h = size
            x = np.linspace(0, 1, w)[None, :]
            y = np.linspace(0, 1, h)[:, None]
            # Gradientes suaves (frecuencias bajas: sobreviven al reescalado).
            r = (127.5 + 127.5 * np.sin(2 * np.pi * (x * (1 + i * 0.5) + i * 0.13))).astype(np.uint8)
            g = (127.5 + 127.5 * np.sin(2 * np.pi * (y * (1.3 + i * 0.4) - i * 0.31))).astype(np.uint8) * np.ones((1, w), np.uint8)
            b = np.full((h, w), (40 + i * 37) % 255, np.uint8)
            arr = np.dstack([r * np.ones((h, 1), np.uint8), g, b])
            noise = rng.integers(0, 8, arr.shape, dtype=np.uint8)
            arr = cv2.add(arr, noise)
            base_imgs[i] = arr
        img = Image.fromarray(arr, "RGB")
        d = ImageDraw.Draw(img)
        d.rectangle([10, 10, 130, 60], fill="white", outline="black", width=3)
        d.text((22, 22), f"F{i + 1:02d}", fill="black")
        p = dir_ / f"frame_{i + 1:03d}.png"
        img.save(p)
        paths.append(str(p))
    return paths


def fake_scan(sheet_path, out_path, angle_deg=1.8, scale=3.1, occlude_bboxes=(),
              persp=0.004, noise=6, tint=None, seed=3):
    """Simula imprimir+escanear una hoja: reescala (otro DPI), rota, aplica
    perspectiva, mete la hoja sobre un fondo (cama del escáner), tapa
    marcadores y añade ruido. tint=(b,g,r) multiplica canales (cianotipia)."""
    img = cv2.imread(str(sheet_path), cv2.IMREAD_COLOR)
    assert img is not None, f"no pude leer {sheet_path}"

    for (x1, y1, x2, y2) in occlude_bboxes:
        cv2.rectangle(img, (x1, y1), (x2, y2), (137, 140, 150), -1)

    img = cv2.resize(img, (0, 0), fx=scale, fy=scale,
                     interpolation=cv2.INTER_CUBIC)
    h, w = img.shape[:2]

    if tint is not None:
        f = np.array(tint, np.float32)
        img = np.clip(img.astype(np.float32) * f[None, None, :], 0, 255).astype(np.uint8)

    # Lienzo mayor (cama del escáner) con margen.
    margin = int(0.06 * max(h, w))
    canvas = np.full((h + 2 * margin, w + 2 * margin, 3), 96, np.uint8)

    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    rng = np.random.default_rng(seed)
    jitter = rng.uniform(-persp, persp, (4, 2)).astype(np.float32) * [w, h]
    dst = src + jitter + margin
    center = dst.mean(axis=0)
    ang = np.deg2rad(angle_deg)
    rot = np.float32([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]])
    dst = (dst - center) @ rot.T + center
    M = cv2.getPerspectiveTransform(src, dst.astype(np.float32))
    warped = cv2.warpPerspective(img, M, (canvas.shape[1], canvas.shape[0]),
                                 dst=canvas, borderMode=cv2.BORDER_TRANSPARENT,
                                 flags=cv2.INTER_LINEAR)
    out = canvas if warped is None else warped

    n = rng.normal(0, noise, out.shape).astype(np.int16)
    out = np.clip(out.astype(np.int16) + n, 0, 255).astype(np.uint8)
    cv2.imwrite(str(out_path), out)
    return out_path


def settings_base(out_dir, **kw):
    base = dict(
        paper="A4", orientation="Vertical", dpi=200, margin_mm=10, gutter_mm=5,
        cols=2, rows=2, labels_on=True, base_name="test", separator="_",
        leading_zeros=3, start_index=1, font_size_pt=10,
        registration_on=True, marker_count=8, marker_size_mm=9.0,
        marker_margin_mm=4.0, qr_on=True, qr_size_mm=12.0, gray_patch_on=True,
        project_name="prueba", out_dir=str(out_dir), out_name="test",
        fmt_png=True, fmt_pdf=False, fmt_tiff=False, keep_originals=True,
    )
    base.update(kw)
    return core.Settings(**base)


# ════════════════════════════════════════════════════════════════
print("\n══ 1. Generación de hojas con registro (modo normal) ══")
frames_dir = TMP / "frames"
frame_paths = make_frames(frames_dir, n=7)
out1 = TMP / "hojas_normal"
s = settings_base(out1)
labels = [f"test_{i + 1:03d}" for i in range(len(frame_paths))]
timeline = [{"pos": i + 1, "etiqueta": labels[i], "rep": labels[i]}
            for i in range(len(frame_paths))]
res = core.generate(s, frame_paths, labels=labels, timeline=timeline,
                    video_meta={"fps_extraccion": 6.0, "origen": "sintetico"})
check("genera hojas PNG", len(res["pages"]) == 2, str(res["pages"]))
check("exporta layout.json", res["layout"] and Path(res["layout"]).is_file())
check("guarda copias originales", res["originals_dir"]
      and len(list(Path(res["originals_dir"]).iterdir())) == 7)

layout = layoutfile.load(res["layout"])
check("layout v2 con 8 marcadores", len(layout["marcadores"]["bboxes"]) == 8)
check("layout con ajustes (rescate)", bool(layout.get("ajustes")))
check("layout con timeline", len(layout["timeline"]) == 7)
check("layout con parche de grises", bool(layout.get("parche_grises")))

# ════════════════════════════════════════════════════════════════
print("\n══ 2. Escaneo simulado + procesamiento (marcadores tapados) ══")
scans1 = TMP / "scans_normal"
scans1.mkdir()
# Hoja 1: intacta, rotada 2°. Hoja 2: DOS marcadores tapados y rotación fuerte.
mk = layout["marcadores"]["bboxes"]
occ = [tuple(int(v) for v in mk["1"]), tuple(int(v) for v in mk["6"])]
occ = [(x1 - 6, y1 - 6, x2 + 6, y2 + 6) for (x1, y1, x2, y2) in occ]
fake_scan(res["pages"][0], scans1 / "scan_a.png", angle_deg=2.0, scale=3.0)
fake_scan(res["pages"][1], scans1 / "scan_b.png", angle_deg=-7.5, scale=2.6,
          occlude_bboxes=occ, seed=11)

outp1 = TMP / "procesado_normal"
rep = scan.procesar_carpeta(scans1, res["layout"], outp1,
                            scan.ScanOptions(threads=2, bleed=0.012),
                            log=lambda t: print("   ", t))
check("2/2 escaneos OK", rep["escaneos_ok"] == 2, json.dumps(rep, default=str)[:400])
check("7/7 frames extraídos", rep["frames_extraidos"] == 7,
      f"faltan: {rep['etiquetas_faltantes']}")
check("informe HTML generado", (outp1 / "informe.html").is_file())

r_b = [r for r in rep["resultados"] if r["scan"] == "scan_b.png"][0]
check("hoja 2 procesada con marcadores tapados (6/8)",
      r_b["ok"] and r_b["marcadores"] <= 6, f"marcadores={r_b['marcadores']}")

# Verificación geométrica: el contenido del frame recuperado debe parecerse
# al original (correlación de la versión en miniatura).
orig = cv2.imread(frame_paths[0])
rec_path = list(outp1.glob("test_001*.tif"))[0]
rec = cv2.imread(str(rec_path))
orig_s = cv2.resize(orig, (160, 90)).astype(np.float32)
rec_s = cv2.resize(rec, (160, 90)).astype(np.float32)
corr = float(np.corrcoef(orig_s.ravel(), rec_s.ravel())[0, 1])
check("frame recuperado se parece al original", corr > 0.9, f"corr={corr:.3f}")

# ════════════════════════════════════════════════════════════════
print("\n══ 3. Escaneo en cualquier orientación (180°) ══")
scans_rot = TMP / "scans_rot"
scans_rot.mkdir()
fake_scan(res["pages"][0], scans_rot / "scan_flip.png", angle_deg=180.0,
          scale=2.4, seed=5)
rep_rot = scan.procesar_carpeta(scans_rot, res["layout"], TMP / "proc_rot",
                                scan.ScanOptions(threads=1, report=False))
check("hoja de cabeza procesada", rep_rot["escaneos_ok"] == 1,
      str(rep_rot["escaneos_fallidos"]))

# ════════════════════════════════════════════════════════════════
print("\n══ 4. Modo cianotipia (negativo → copia azul → procesado) ══")
out2 = TMP / "hojas_cyano"
s2 = settings_base(out2, mode="cianotipia", cyan_mirror=True,
                   cyan_bg="completo",
                   cyan_ink="#000000", out_name="cyano", project_name="cyano")
res2 = core.generate(s2, frame_paths[:4], labels=labels[:4])
check("genera negativo cianotipia", len(res2["pages"]) == 1)

# Simular el proceso físico: negativo espejado → contacto → copia azul.
neg = cv2.imread(res2["pages"][0], cv2.IMREAD_COLOR)
neg = cv2.flip(neg, 1)  # el contacto des-espeja
gray = cv2.cvtColor(neg, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
# La CLARIDAD del negativo es transparencia: deja pasar el UV → azul.
paperc = np.array([214, 228, 238], np.float32)   # papel (BGR)
bluec = np.array([98, 52, 22], np.float32)        # azul de Prusia (BGR)
expo = gray[..., None]
cyano_print = (paperc[None, None, :] * (1 - expo) + bluec[None, None, :] * expo)
cyano_print = np.clip(cyano_print, 0, 255).astype(np.uint8)
cyano_path = TMP / "cyano_print.png"
cv2.imwrite(str(cyano_path), cyano_print)

scans2 = TMP / "scans_cyano"
scans2.mkdir()
fake_scan(cyano_path, scans2 / "scan_cyano.png", angle_deg=-3.2, scale=2.8,
          tint=(1.06, 0.97, 0.9), seed=21)
outp2 = TMP / "procesado_cyano"
rep2 = scan.procesar_carpeta(scans2, res2["layout"], outp2,
                             scan.ScanOptions(threads=1, mode="auto"),
                             log=lambda t: print("   ", t))
check("cianotipia procesada (modo auto)", rep2["escaneos_ok"] == 1,
      str([r["error"] for r in rep2["resultados"]]))
check("4/4 frames de cianotipia", rep2["frames_extraidos"] == 4,
      f"faltan: {rep2['etiquetas_faltantes']}")
r2 = rep2["resultados"][0]
# El escaneo simulado es una homografía pura: el residuo debe ser casi nulo.
# (Vigila regresiones de precisión de esquinas, p. ej. detectInvertedMarker.)
check("informe con residuo de alineación subpíxel", "residual_mm" in r2
      and 0.0 <= r2["residual_mm"] < 0.3, str(r2.get("residual_mm")))
check("overlay de diagnóstico generado", r2.get("overlay")
      and (outp2 / r2["overlay"]).is_file(), str(r2.get("overlay")))

# ════════════════════════════════════════════════════════════════
print("\n══ 4b. Cianotipia ESPEJADA (acetato expuesto al revés) ══")
# El negativo se imprime espejado; si se expone con la tinta hacia arriba, la
# copia azul sale EN ESPEJO (el caso real que rompía la segmentación: los
# ArUco son quirales). Aquí NO se des-espeja antes de simular la copia.
neg_m = cv2.imread(res2["pages"][0], cv2.IMREAD_COLOR)  # sin cv2.flip
gray_m = cv2.cvtColor(neg_m, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
expo_m = gray_m[..., None]
print_m = np.clip(paperc[None, None, :] * (1 - expo_m)
                  + bluec[None, None, :] * expo_m, 0, 255).astype(np.uint8)
pm_path = TMP / "cyano_espejo.png"
cv2.imwrite(str(pm_path), print_m)
scans2b = TMP / "scans_cyano_espejo"
scans2b.mkdir()
fake_scan(pm_path, scans2b / "scan_espejo.png", angle_deg=2.1, scale=2.6,
          tint=(1.06, 0.97, 0.9), seed=23)
proc2b = TMP / "proc_espejo"
rep2b = scan.procesar_carpeta(scans2b, res2["layout"], proc2b,
                              scan.ScanOptions(threads=1, report=False),
                              log=lambda t: print("   ", t))
check("cianotipia espejada procesada", rep2b["escaneos_ok"] == 1,
      str([r["error"] for r in rep2b["resultados"]]))
check("espejado detectado y corregido", rep2b["resultados"][0]["espejado"])
check("4/4 frames de la copia espejada", rep2b["frames_extraidos"] == 4,
      f"faltan: {rep2b['etiquetas_faltantes']}")
# El contenido recuperado debe estar al DERECHO (no en espejo).
orig_g = cv2.cvtColor(cv2.resize(cv2.imread(frame_paths[0]), (160, 90)),
                      cv2.COLOR_BGR2GRAY).astype(np.float32)
rec_m = cv2.imread(str(list(proc2b.glob("test_001*.tif"))[0]))
rec_g = cv2.cvtColor(cv2.resize(rec_m, (160, 90)),
                     cv2.COLOR_BGR2GRAY).astype(np.float32)
corr_ok = float(np.corrcoef(orig_g.ravel(), rec_g.ravel())[0, 1])
corr_mir = float(np.corrcoef(orig_g[:, ::-1].ravel(), rec_g.ravel())[0, 1])
check("contenido recuperado al derecho", corr_ok > 0.5 and corr_ok > corr_mir,
      f"corr={corr_ok:.3f} vs espejo={corr_mir:.3f}")

# ════════════════════════════════════════════════════════════════
print("\n══ 4c. Fondo desigual (lavado/exposición no uniforme) ══")
# Como en las copias reales: media hoja mucho más oscura que la otra, con los
# marcadores del borde inferior casi ahogados en azul.
h_p, w_p = cyano_print.shape[:2]
sombra = (np.linspace(1.30, 0.40, h_p)[:, None]
          * np.linspace(1.05, 0.85, w_p)[None, :])[..., None].astype(np.float32)
uneven = np.clip(cyano_print.astype(np.float32) * sombra, 0, 255).astype(np.uint8)
un_path = TMP / "cyano_desigual.png"
cv2.imwrite(str(un_path), uneven)
scans2c = TMP / "scans_cyano_desigual"
scans2c.mkdir()
fake_scan(un_path, scans2c / "scan_desigual.png", angle_deg=-2.6, scale=2.5,
          tint=(1.04, 0.97, 0.92), seed=29)
rep2c = scan.procesar_carpeta(scans2c, res2["layout"], TMP / "proc_desigual",
                              scan.ScanOptions(threads=1, report=False),
                              log=lambda t: print("   ", t))
check("fondo desigual procesado", rep2c["escaneos_ok"] == 1,
      str([r["error"] for r in rep2c["resultados"]]))
check("4/4 frames con fondo desigual", rep2c["frames_extraidos"] == 4,
      f"faltan: {rep2c['etiquetas_faltantes']}")

# ════════════════════════════════════════════════════════════════
print("\n══ 4d. QRs ilegibles + layout de una sola hoja (descarte) ══")
lay2 = layoutfile.load(res2["layout"])
qr_occ = []
for q in lay2["hojas"][0]["qrs"].values():
    x1, y1, x2, y2 = [int(v) for v in q["bbox"]]
    pad = (x2 - x1) // 2
    qr_occ.append((x1 - pad, y1 - pad, x2 + pad, y2 + pad))
scans2d = TMP / "scans_cyano_noqr"
scans2d.mkdir()
fake_scan(cyano_path, scans2d / "scan_noqr.png", angle_deg=1.7, scale=2.4,
          occlude_bboxes=qr_occ, tint=(1.05, 0.97, 0.91), seed=37)
rep2d = scan.procesar_carpeta(scans2d, res2["layout"], TMP / "proc_noqr",
                              scan.ScanOptions(threads=1, report=False),
                              log=lambda t: print("   ", t))
check("hoja única identificada por descarte (sin QRs)",
      rep2d["escaneos_ok"] == 1,
      str([r["error"] for r in rep2d["resultados"]]))
check("4/4 frames sin QRs legibles", rep2d["frames_extraidos"] == 4,
      f"faltan: {rep2d['etiquetas_faltantes']}")

# ════════════════════════════════════════════════════════════════
print("\n══ 4e. Papel deformado (encogimiento húmedo) ══")
# Deformación suave no proyectiva sobre la copia: el procesado debe seguir
# funcionando y el residuo debe aparecer en el informe.
h_p, w_p = cyano_print.shape[:2]
yy, xx = np.meshgrid(np.arange(h_p, dtype=np.float32),
                     np.arange(w_p, dtype=np.float32), indexing="ij")
amp = 14.0  # px a 200 dpi ≈ 1.8 mm de ondulación
map_x = xx + amp * np.sin(2 * np.pi * xx / w_p)
map_y = yy + amp * np.sin(2 * np.pi * yy / h_p)
deform = cv2.remap(cyano_print, map_x, map_y, cv2.INTER_LINEAR,
                   borderMode=cv2.BORDER_REPLICATE)
df_path = TMP / "cyano_deforme.png"
cv2.imwrite(str(df_path), deform)
scans2e = TMP / "scans_cyano_deforme"
scans2e.mkdir()
fake_scan(df_path, scans2e / "scan_deforme.png", angle_deg=1.9, scale=2.5,
          tint=(1.05, 0.97, 0.92), seed=43)
rep2e = scan.procesar_carpeta(scans2e, res2["layout"], TMP / "proc_deforme",
                              scan.ScanOptions(threads=1, report=False),
                              log=lambda t: print("   ", t))
r2e = rep2e["resultados"][0]
check("papel deformado procesado", rep2e["escaneos_ok"] == 1
      and rep2e["frames_extraidos"] == 4,
      str([r["error"] for r in rep2e["resultados"]]))
check("la deformación se mide y reporta", r2e["residual_mm"] > 0.1,
      f"residuo={r2e['residual_mm']}")

# Corrector local: con desplazamientos conocidos en los marcadores, el
# recorte cercano a un marcador debe moverse ≈ como ese marcador, y el del
# centro ≈ como la media.
page = 1000.0
bb_test = {"0": [50, 50, 100, 100], "1": [900, 50, 950, 100],
           "2": [900, 900, 950, 950], "3": [50, 900, 100, 950]}
despl = {0: (6.0, 0.0), 1: (0.0, 6.0), 2: (-6.0, 0.0), 3: (0.0, -6.0)}
ref_test = {}
for mid, b in bb_test.items():
    dx, dy = despl[int(mid)]
    ref_test[int(mid)] = markers.bbox_corners(b) + np.float32([dx, dy])
shift_fn = scan._make_local_shift(np.eye(3), ref_test, bb_test, 1.0, px_mm=1.0)
check("corrector local activo con residuo alto", shift_fn is not None)
sx, sy = shift_fn((60, 60, 90, 90))       # pegado al marcador 0
cx, cy = shift_fn((480, 480, 520, 520))   # centro de la hoja
check("recorte junto a un marcador sigue a ese marcador",
      abs(sx - 6.0) < 1.5 and abs(sy) < 1.5, f"({sx:.2f}, {sy:.2f})")
check("recorte central promedia los residuos",
      abs(cx) < 1.0 and abs(cy) < 1.0, f"({cx:.2f}, {cy:.2f})")
# Y con residuo subpíxel no corrige nada (no mete ruido).
ref_zero = {int(m): markers.bbox_corners(b) for m, b in bb_test.items()}
check("corrector inactivo con residuo subpíxel",
      scan._make_local_shift(np.eye(3), ref_zero, bb_test, 1.0,
                             px_mm=1.0) is None)

# ════════════════════════════════════════════════════════════════
print("\n══ 4f. Testigo de orientación: no rompe el marcador TL ══")
# Con marcadores de 8 mm y halo de 5 mm (ahorro), el halo del triángulo debe
# quedar FUERA del parche TL; si lo invade, el marcador 0 pierde su borde en
# la copia azul y deja de detectarse.
s4f = settings_base(TMP / "hojas_testigo", mode="cianotipia", cyan_mirror=True,
                    cyan_bg="ahorro", cyan_halo_mm=5.0, marker_size_mm=8.0,
                    out_name="testigo", project_name="testigo")
res4f = core.generate(s4f, frame_paths[:4], labels=labels[:4])
check("avisos de tamaños arriesgados en cianotipia",
      any("8" in a and "10" in a for a in res4f["avisos"]),
      str(res4f["avisos"]))
neg4f = cv2.flip(cv2.imread(res4f["pages"][0]), 1)
g4f = cv2.cvtColor(neg4f, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
print4f = np.clip(paperc[None, None, :] * (1 - g4f[..., None])
                  + bluec[None, None, :] * g4f[..., None], 0, 255).astype(np.uint8)
_, found4f = scan._detect_markers_multi(print4f, "DICT_4X4_50",
                                        list(range(8)), "cianotipia")
check("marcador TL detectable junto al testigo (8 mm + halo 5 mm)",
      0 in found4f, f"detectados: {sorted(found4f)}")
# El numerador de hoja se corre hacia dentro y no debe romper el marcador de
# su esquina (por defecto «Inferior derecha» = id 2).
check("marcador de la esquina del numerador intacto", 2 in found4f,
      f"detectados: {sorted(found4f)}")

# ════════════════════════════════════════════════════════════════
print("\n══ 4g. Borde bloqueador alrededor de los frames ══")
s4g = settings_base(TMP / "hojas_borde", mode="cianotipia", cyan_mirror=True,
                    cyan_bg="ahorro", cyan_frame_border_mm=0.8,
                    out_name="borde", project_name="borde")
res4g = core.generate(s4g, frame_paths[:1], labels=labels[:1])
neg_b = cv2.flip(cv2.imread(res4g["pages"][0]), 1)  # coords del layout
lay_b = layoutfile.load(res4g["layout"])
fx1, fy1, fx2, fy2 = list(lay_b["hojas"][0]["frames"].values())[0]["bbox"]
bpx = max(1, round(0.8 / 25.4 * 200))
franja = neg_b[fy1 - bpx:fy1, fx1 + 5:fx2 - 5]  # justo encima del frame
check("borde bloqueador de tinta plena presente", franja.mean() < 40,
      f"media={franja.mean():.0f}")
s4g0 = settings_base(TMP / "hojas_borde0", mode="cianotipia", cyan_mirror=True,
                     cyan_bg="ahorro", cyan_frame_border_mm=0.0,
                     out_name="borde0", project_name="borde0")
res4g0 = core.generate(s4g0, frame_paths[:1], labels=labels[:1])
neg_b0 = cv2.flip(cv2.imread(res4g0["pages"][0]), 1)
lay_b0 = layoutfile.load(res4g0["layout"])
gx1, gy1, gx2, gy2 = list(lay_b0["hojas"][0]["frames"].values())[0]["bbox"]
franja0 = neg_b0[gy1 - bpx:gy1, gx1 + 5:gx2 - 5]
check("borde bloqueador desactivable (0 mm)", franja0.mean() > 220,
      f"media={franja0.mean():.0f}")

# ════════════════════════════════════════════════════════════════
print("\n══ 4h. Color del bloqueador personalizado (impresoras que odian el negro) ══")
# Con degradado ColorBlocker el bloqueador termina en negro puro; el color
# personalizado debe reemplazarlo en TODO lo externo: fondo completo, halos
# y borde bloqueador — sin tocar la tinta de las imágenes.
BLOQ = "#20304A"          # azul denso, BGR en cv2 = (74, 48, 32)
bloq_bgr = np.array([0x4A, 0x30, 0x20])
s4h = settings_base(TMP / "hojas_bloq", mode="cianotipia", cyan_mirror=True,
                    cyan_bg="completo", cyan_block_color=BLOQ,
                    cyan_frame_border_mm=0.8, out_name="bloq",
                    project_name="bloq")
res4h = core.generate(s4h, frame_paths[:4], labels=labels[:4])
neg_h = cv2.flip(cv2.imread(res4h["pages"][0]), 1)
check("fondo completo usa el color del bloqueador",
      np.abs(neg_h[4, neg_h.shape[1] // 2].astype(int) - bloq_bgr).max() <= 2,
      f"pixel={neg_h[4, neg_h.shape[1] // 2].tolist()}")
lay_h = layoutfile.load(res4h["layout"])
hx1, hy1, hx2, hy2 = list(lay_h["hojas"][0]["frames"].values())[0]["bbox"]
borde_px = neg_h[hy1 - 2, (hx1 + hx2) // 2].astype(int)
check("borde bloqueador usa el color del bloqueador",
      np.abs(borde_px - bloq_bgr).max() <= 2, f"pixel={borde_px.tolist()}")
# En modo ahorro, el halo del marcador también usa el color.
s4h2 = settings_base(TMP / "hojas_bloq2", mode="cianotipia", cyan_mirror=True,
                     cyan_bg="ahorro", cyan_block_color=BLOQ,
                     out_name="bloq2", project_name="bloq2")
res4h2 = core.generate(s4h2, frame_paths[:4], labels=labels[:4])
neg_h2 = cv2.flip(cv2.imread(res4h2["pages"][0]), 1)
lay_h2 = layoutfile.load(res4h2["layout"])
mk0 = lay_h2["marcadores"]["bboxes"]["0"]
lado0 = lay_h2["marcadores"]["lado_px"]
halo_px = round(5.0 / 25.4 * 200)
halo_pixel = neg_h2[(mk0[1] + mk0[3]) // 2,
                    mk0[0] - lado0 // 4 - halo_px // 2].astype(int)
check("halo del marcador usa el color del bloqueador",
      np.abs(halo_pixel - bloq_bgr).max() <= 2, f"pixel={halo_pixel.tolist()}")
# Y el escaneo de esa hoja se sigue procesando (el bloqueador azul denso es
# oscuro: bloquea el UV y mantiene el contraste de los marcadores).
neg_h2f = cv2.imread(res4h2["pages"][0])
neg_h2f = cv2.flip(neg_h2f, 1)
g4h = cv2.cvtColor(neg_h2f, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
p4h = np.clip(paperc[None, None, :] * (1 - g4h[..., None])
              + bluec[None, None, :] * g4h[..., None], 0, 255).astype(np.uint8)
p4h_path = TMP / "bloq_print.png"
cv2.imwrite(str(p4h_path), p4h)
scans4h = TMP / "scans_bloq"
scans4h.mkdir()
fake_scan(p4h_path, scans4h / "scan_bloq.png", angle_deg=1.4, scale=2.5,
          tint=(1.05, 0.97, 0.92), seed=47)
rep4h = scan.procesar_carpeta(scans4h, res4h2["layout"], TMP / "proc_bloq",
                              scan.ScanOptions(threads=1, report=False),
                              log=lambda t: print("   ", t))
check("hoja con bloqueador de color se procesa (4/4)",
      rep4h["escaneos_ok"] == 1 and rep4h["frames_extraidos"] == 4,
      str([r["error"] for r in rep4h["resultados"]]))
# Carta de calibración con fondo personalizado.
carta_bloq = TMP / "tira_bloq.png"
calibration.generar_tira_cianotipia(carta_bloq, "A4", 200, "#000000",
                                    mirror=False, block_color=BLOQ)
tb = cv2.imread(str(carta_bloq))
check("carta de calibración con fondo personalizado",
      np.abs(tb[4, tb.shape[1] // 2].astype(int) - bloq_bgr).max() <= 2,
      f"pixel={tb[4, tb.shape[1] // 2].tolist()}")
# Aviso si el color de bloqueador es demasiado claro.
s4h3 = settings_base(TMP / "hojas_bloq3", mode="cianotipia",
                     cyan_block_color="#DDDDCC", out_name="bloq3")
check("aviso con bloqueador demasiado claro",
      any("claro" in a for a in core.cyanotype_size_warnings(s4h3)),
      str(core.cyanotype_size_warnings(s4h3)))

# ════════════════════════════════════════════════════════════════
print("\n══ 5. Deduplicación perceptual ══")
dup_dir = TMP / "frames_dup"
dup_paths = make_frames(dup_dir, n=6, dup_pairs=((0, 1), (0, 2), (3, 5)))
rep_idx, rep_of = dedup.find_duplicates(dup_paths, threshold=4)
check("detecta 3 duplicados (6→3 únicos)", len(rep_idx) == 3,
      f"únicos={rep_idx}, rep_of={rep_of}")
check("mapa de duplicados correcto", rep_of[1] == 0 and rep_of[2] == 0
      and rep_of[5] == 3)

# ════════════════════════════════════════════════════════════════
print("\n══ 6. Calibración de impresora ══")
test_page = TMP / "prueba_impresora.png"
calibration.generar_pagina_prueba_impresora(test_page, "A4", 200)
# Simular impresora que encoge al 96.5% + escaneo a otro DPI.
page = cv2.imread(str(test_page))
h, w = page.shape[:2]
shrunk = cv2.resize(page, (int(w * 0.965), int(h * 0.965)))
printed = np.full_like(page, 255)
y0 = (h - shrunk.shape[0]) // 2
x0 = (w - shrunk.shape[1]) // 2
printed[y0:y0 + shrunk.shape[0], x0:x0 + shrunk.shape[1]] = shrunk
printed_path = TMP / "prueba_impresa.png"
cv2.imwrite(str(printed_path), printed)
scan_cal = TMP / "scan_cal.png"
fake_scan(printed_path, scan_cal, angle_deg=0.8, scale=1.9, noise=3, seed=9)
# El "escáner" produce 200*1.9 = 380 dpi efectivos.
prof = calibration.analizar_prueba_impresora(scan_cal, "A4", 200,
                                             scan_dpi=200 * 1.9,
                                             log=lambda t: print("   ", t))
check("mide la escala de impresión (~96.5 %)",
      abs(prof["scale_x"] - 0.965) < 0.012 and abs(prof["scale_y"] - 0.965) < 0.012,
      f"sx={prof['scale_x']}, sy={prof['scale_y']}")
check("rampa tonal medida", len(prof["tono"]) >= 18, str(len(prof["tono"])))
check("recomienda tamaños de marcador/QR",
      prof["marker_recomendado_mm"] > 0 and prof["qr_recomendado_mm"] > 0)

print("\n══ 7. Calibración de cianotipia ══")
strip = TMP / "tira_cyano.png"
calibration.generar_tira_cianotipia(strip, "A4", 200, "#000000", mirror=True)
neg = cv2.imread(str(strip))
neg = cv2.flip(neg, 1)
grayn = cv2.cvtColor(neg, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
# Proceso no lineal (gamma 1.8) para que la curva tenga algo que corregir.
expo = grayn ** 1.8
tira_print = (paperc[None, None, :] * (1 - expo[..., None])
              + bluec[None, None, :] * expo[..., None]).astype(np.uint8)
tira_path = TMP / "tira_print.png"
cv2.imwrite(str(tira_path), tira_print)
scan_tira = TMP / "scan_tira.png"
fake_scan(tira_path, scan_tira, angle_deg=1.2, scale=2.0, noise=3, seed=13)
prof_c = calibration.analizar_tira_cianotipia(scan_tira, "A4", 200,
                                              log=lambda t: print("   ", t))
lut = prof_c["lut"]
check("LUT de 256 valores monótona", len(lut) == 256
      and all(lut[i] <= lut[i + 1] for i in range(255)))
check("rango dinámico medido", 0.2 < prof_c["rango_dinamico"] <= 1.0,
      str(prof_c["rango_dinamico"]))
# La curva debe compensar la gamma: en el medio debe apartarse de la identidad.
check("curva no trivial (compensa)", abs(lut[128] - 128) > 10, f"lut[128]={lut[128]}")
# Y debe ser SUAVE en los medios tonos: sin saltos de escalera entre valores
# consecutivos (vigila la regresión del cummax crudo, que posterizaba los
# degradados). Los extremos se excluyen: donde la respuesta física es plana,
# la inversa exacta es vertical y un salto ahí no es escalonado visible.
saltos = [lut[i + 1] - lut[i] for i in range(8, 247)]
check("curva suave en medios tonos, sin escalones", max(saltos) < 5.0,
      f"salto_max={max(saltos):.2f}")

print("\n══ 7b. Calibración con la carta EN ESPEJO ══")
# La carta expuesta con el acetato al revés: la copia sale espejada. Sin la
# corrección, la alineación fallaría (o mediría los parches cruzados).
grayn_m = cv2.cvtColor(cv2.imread(str(strip)), cv2.COLOR_BGR2GRAY)
expo_tm = (grayn_m.astype(np.float32) / 255.0) ** 1.8
tira_m = (paperc[None, None, :] * (1 - expo_tm[..., None])
          + bluec[None, None, :] * expo_tm[..., None]).astype(np.uint8)
tm_path = TMP / "tira_espejo.png"
cv2.imwrite(str(tm_path), tira_m)
scan_tm = TMP / "scan_tira_espejo.png"
fake_scan(tm_path, scan_tm, angle_deg=-1.1, scale=2.0, noise=3, seed=17)
prof_m = calibration.analizar_tira_cianotipia(scan_tm, "A4", 200,
                                              log=lambda t: print("   ", t))
lut_m = prof_m["lut"]
check("carta espejada: LUT monótona y compensadora",
      len(lut_m) == 256 and all(lut_m[i] <= lut_m[i + 1] for i in range(255))
      and abs(lut_m[128] - 128) > 10, f"lut[128]={lut_m[128]}")
check("carta espejada ≈ carta al derecho",
      abs(lut_m[128] - lut[128]) < 25,
      f"espejo={lut_m[128]} vs derecho={lut[128]}")

# ════════════════════════════════════════════════════════════════
print("\n══ 8. Hojas de rescate ══")
# Fingir que faltaron 2 frames y regenerar hojas solo con ellos.
falt = ["test_002", "test_005"]
res_resc = rescue.generar_hojas_rescate(res["layout"], falt,
                                        log=lambda t: print("   ", t))
check("genera hoja de rescate", res_resc["num_generated"] == 1)
lay_resc = layoutfile.load(res_resc["layout"])
et = set()
for h_ in lay_resc["hojas"]:
    et.update(h_["frames"].keys())
check("la hoja de rescate contiene los faltantes", et == set(falt), str(et))

# Y el escaneo de la hoja de rescate se procesa hacia la misma salida.
scans_r = TMP / "scans_rescate"
scans_r.mkdir()
pages_r = res_resc["pages"]
fake_scan(pages_r[0], scans_r / "scan_r.png", angle_deg=1.0, scale=2.5, seed=31)
rep_r = scan.procesar_carpeta(scans_r, res_resc["layout"], outp1,
                              scan.ScanOptions(threads=1, report=False))
check("rescate procesado", rep_r["frames_extraidos"] == 2,
      f"faltan: {rep_r['etiquetas_faltantes']}")

# ════════════════════════════════════════════════════════════════
print("\n══ 9. Video final (timeline + dedup) ══")
try:
    from kamiru import videoout
    files, missing = videoout.frames_from_timeline(layout, outp1)
    check("timeline resuelta sin faltantes", len(files) == 7 and not missing,
          f"files={len(files)}, missing={missing}")
    vid = videoout.build_video(files, 6.0, TMP / "final.mp4",
                               videoout.CODECS[0])
    check("video MP4 creado", Path(vid).stat().st_size > 10000)
except Exception as e:
    check("video final", False, f"{type(e).__name__}: {e}")

# ════════════════════════════════════════════════════════════════
print("\n══ 9b. Cianotipia en modo AHORRO DE TINTA (fondo azul + halos) ══")
out3 = TMP / "hojas_cyano_ahorro"
s3 = settings_base(out3, mode="cianotipia", cyan_mirror=True, cyan_bg="ahorro",
                   cyan_halo_mm=3.0, out_name="ahorro", project_name="ahorro")
res3 = core.generate(s3, frame_paths[:4], labels=labels[:4])
neg3 = cv2.imread(res3["pages"][0], cv2.IMREAD_COLOR)
# El negativo en ahorro debe tener MUCHA menos tinta que el de fondo completo.
tinta_ahorro = (cv2.cvtColor(neg3, cv2.COLOR_BGR2GRAY) < 128).mean()
neg_full = cv2.imread(res2["pages"][0], cv2.IMREAD_COLOR)
tinta_full = (cv2.cvtColor(neg_full, cv2.COLOR_BGR2GRAY) < 128).mean()
check("modo ahorro usa mucha menos tinta",
      tinta_ahorro < tinta_full * 0.6,
      f"ahorro={tinta_ahorro:.2f} vs completo={tinta_full:.2f}")

# Proceso físico + escaneo + procesamiento del modo ahorro.
neg3 = cv2.flip(neg3, 1)
gray3 = cv2.cvtColor(neg3, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
expo3 = gray3[..., None]
print3 = (paperc[None, None, :] * (1 - expo3)
          + bluec[None, None, :] * expo3).astype(np.uint8)
print3_path = TMP / "cyano_ahorro_print.png"
cv2.imwrite(str(print3_path), print3)
scans3 = TMP / "scans_ahorro"
scans3.mkdir()
fake_scan(print3_path, scans3 / "scan_ahorro.png", angle_deg=2.4, scale=2.7,
          tint=(1.05, 0.96, 0.92), seed=41)
rep3 = scan.procesar_carpeta(scans3, res3["layout"], TMP / "proc_ahorro",
                             scan.ScanOptions(threads=1, report=False),
                             log=lambda t: print("   ", t))
check("modo ahorro procesado (fondo azul)", rep3["escaneos_ok"] == 1,
      str([r["error"] for r in rep3["resultados"]]))
check("4/4 frames en modo ahorro", rep3["frames_extraidos"] == 4,
      f"faltan: {rep3['etiquetas_faltantes']}")

# ════════════════════════════════════════════════════════════════
print("\n══ 9c. Carta EDN 2.2 (256 tonos) ══")
edn = TMP / "edn256.png"
calibration.generar_tira_cianotipia(edn, "A4", 200, "#000000", mirror=True,
                                    target="edn256")
neg_e = cv2.flip(cv2.imread(str(edn)), 1)
gray_e = cv2.cvtColor(neg_e, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
expo_e = (gray_e ** 1.6)[..., None]
print_e = (paperc[None, None, :] * (1 - expo_e)
           + bluec[None, None, :] * expo_e).astype(np.uint8)
pe_path = TMP / "edn_print.png"
cv2.imwrite(str(pe_path), print_e)
scan_e = TMP / "scan_edn.png"
fake_scan(pe_path, scan_e, angle_deg=-1.4, scale=2.1, noise=3, seed=51)
prof_e = calibration.analizar_tira_cianotipia(scan_e, "A4", 200,
                                              target="edn256",
                                              log=lambda t: print("   ", t))
check("EDN 256: mide 256 parches", prof_e["steps"] == 256
      and len(prof_e["respuesta"]) >= 250, str(len(prof_e["respuesta"])))
lut_e = prof_e["lut"]
check("EDN 256: LUT monótona y compensadora",
      all(lut_e[i] <= lut_e[i + 1] for i in range(255))
      and abs(lut_e[128] - 128) > 8, f"lut[128]={lut_e[128]}")
saltos_e = [lut_e[i + 1] - lut_e[i] for i in range(8, 247)]
check("EDN 256: curva suave en medios tonos", max(saltos_e) < 6.0,
      f"salto_max={max(saltos_e):.2f}")

# ════════════════════════════════════════════════════════════════
print("\n══ 9d. EDN ColorBlocker (elección del color de tinta) ══")
cb = TMP / "colorblocker.png"
calibration.generar_colorblocker(cb, "A4", 200, mirror=True)
neg_cb = cv2.flip(cv2.imread(str(cb)), 1)
# Física simulada realista: la tinta ROJA/cálida bloquea el UV mejor que la
# negra (el negro de impresora FILTRA algo de UV — la premisa del
# ColorBlocker). Transmisión por canal + fuga en tintas oscuras.
f_cb = neg_cb.astype(np.float32) / 255.0
Rf, Gf, Bf = f_cb[..., 2], f_cb[..., 1], f_cb[..., 0]
leak = 0.22 * (1.0 - np.maximum(np.maximum(Rf, Gf), Bf))  # tinta oscura = fuga
trans = 0.05 * Rf + 0.25 * Gf + 0.9 * Bf + leak
expo_cb = np.clip(trans, 0, 1)[..., None]
print_cb = (paperc[None, None, :] * (1 - expo_cb)
            + bluec[None, None, :] * expo_cb).astype(np.uint8)
pcb_path = TMP / "cb_print.png"
cv2.imwrite(str(pcb_path), print_cb)
scan_cb = TMP / "scan_cb.png"
fake_scan(pcb_path, scan_cb, angle_deg=1.1, scale=1.8, noise=3, seed=61)
prof_cb = calibration.analizar_colorblocker(scan_cb, "A4", 200,
                                            log=lambda t: print("   ", t))
mejor_rgb = [int(prof_cb["mejor_color"][i:i + 2], 16) for i in (1, 3, 5)]
check("ColorBlocker: el mejor color es cálido (R alto, B bajo)",
      mejor_rgb[0] > 180 and mejor_rgb[2] < 120, prof_cb["mejor_color"])
check("ColorBlocker: 3 paradas de degradado", len(prof_cb["stops"]) == 3
      and prof_cb["stops"][0][0] == 0 and prof_cb["stops"][2][0] == 255,
      str(prof_cb["stops"]))

# Y el degradado se puede usar para generar negativos.
s_grad = settings_base(TMP / "hojas_grad", mode="cianotipia",
                       cyan_ink=prof_cb["mejor_color"],
                       cyan_ink_stops=prof_cb["stops"], out_name="grad")
res_grad = core.generate(s_grad, frame_paths[:2], labels=labels[:2])
check("negativo con degradado ColorBlocker", len(res_grad["pages"]) == 1)

# ════════════════════════════════════════════════════════════════
print("\n══ 9e. Mejor ajuste con intercambio de cuadrícula ══")
tall_dir = TMP / "frames_tall"
tall = make_frames(tall_dir, n=1, size=(360, 640))  # frames verticales
s_fit = core.Settings(paper="A4", dpi=200, cols=4, rows=5, labels_on=True,
                      orientation="Mejor ajuste (automático)")
s_fit._frame_paths = tall
landscape, cols, rows = core.resolve_page_layout(s_fit, tall, 20, 5)
area_auto = core._frame_fit_area(s_fit, landscape, 360, 640, 20, 5, cols, rows)
area_v = core._frame_fit_area(s_fit, False, 360, 640, 20, 5, 4, 5)
area_h = core._frame_fit_area(s_fit, True, 360, 640, 20, 5, 4, 5)
check("mejor ajuste ≥ ambas orientaciones manuales",
      area_auto >= max(area_v, area_h) - 1e-6,
      f"auto={area_auto:.0f} V={area_v:.0f} H={area_h:.0f}")
check("con frames verticales intercambia la cuadrícula (4×5→5×4)",
      (cols, rows) == (5, 4), f"eligió {cols}×{rows}, landscape={landscape}")

# ════════════════════════════════════════════════════════════════
print("\n══ 10. Compatibilidad con layout v1 (app antigua) ══")
v1 = {
    "lienzo": {"ancho_px": 2480, "alto_px": 3508, "ppi": 300,
               "orientacion": "portrait"},
    "hojas": [{"archivo_hoja": "hoja_001.tif",
               "frames": {"CLIP018": {"bbox": [300, 300, 1100, 800],
                                       "archivo_original": "CLIP018.tif"}},
               "qrs": {"CLIP018": {"bbox": [500, 850, 620, 970]}}}],
}
v1_path = TMP / "layout_v1.json"
with open(v1_path, "w", encoding="utf-8") as f:
    json.dump(v1, f)
lv1 = layoutfile.load(v1_path)
check("layout v1 se convierte a v2", lv1["version"] == 2
      and len(lv1["marcadores"]["bboxes"]) == 4
      and lv1["hojas"][0]["frames"]["CLIP018"]["bbox"] == [300, 300, 1100, 800])

# ════════════════════════════════════════════════════════════════
print("\n══ 11. Humo de la GUI (construcción completa de la app) ══")
# Construye la App real con TODAS sus fases y pestañas: detecta errores que
# solo aparecen al montar la interfaz (p. ej. mezclar pack y grid en un mismo
# frame → TclError al arrancar el ejecutable). En los builds de Windows y
# macOS del workflow hay display y este test corre de verdad; en entornos
# sin display (runner Linux, contenedores) se salta sin fallar.
_tk_ok = False
try:
    import tkinter as _tk_mod
    _probe = _tk_mod.Tk()
    _probe.destroy()
    _tk_ok = True
except Exception as _e:
    print(f"  [SKIP] tkinter/display no disponible ({type(_e).__name__}): "
          "los builds de Windows/macOS sí ejecutan este test")
if _tk_ok:
    try:
        from kamiru import app as _app_mod
        _a = _app_mod.App()
        _a.update_idletasks()
        _a.update()
        check("la app construye todas las fases y pestañas", True)
        # Y en el tamaño MÍNIMO de ventana, los botones de acción de cada
        # fase deben seguir visibles (regresión v2.4.1: las pestañas crecieron
        # más que la pantalla y pack recortó la barra con «Vista previa» y
        # «Generar hojas»).
        _a.geometry("1100x860")
        _a.update()
        _fuera = []
        for _fase, _nombre in ((_a.sheets_phase, "preview_btn"),
                               (_a.sheets_phase, "run_btn"),
                               (_a.scans_phase, "run_btn"),
                               (_a.video_phase, "run_btn")):
            _a.phases_nb.select(_fase)
            _a.update()
            _btn = getattr(_fase, _nombre)
            _dentro = (_btn.winfo_viewable()
                       and _btn.winfo_rooty() + _btn.winfo_height()
                       <= _a.winfo_rooty() + _a.winfo_height())
            if not _dentro:
                _fuera.append(f"{type(_fase).__name__}.{_nombre}")
        check("botones de acción visibles en ventana mínima (1100x860)",
              not _fuera, f"fuera de pantalla: {_fuera}")
        # Campo hex de los selectores de color: acepta lo que reporta el
        # ColorBlocker (#B2FF66, b2ff66, #fa0…).
        _PF = _app_mod.PhaseFrame
        check("normalización de códigos hex en selectores de color",
              _PF.hex_normalizado("b2ff66") == "#B2FF66"
              and _PF.hex_normalizado("#fa0") == "#FFAA00"
              and _PF.hex_normalizado("no-es-hex") is None)
        # Autowrap: las descripciones deben SEGUIR el ancho de su columna en
        # vez de quedar clavadas (antes fijas en 380/740 px). NO se comprueba
        # redimensionando la ventana: en Windows/macOS el geometry() pasa por
        # el window manager real y se aplica de forma ASÍNCRONA (un update()
        # no basta), lo que hacía el test intermitente. En su lugar se dispara
        # un <Configure> SINTÉTICO directo sobre una etiqueta: si el cableado
        # de enable_autowrap existe, su handler fija wraplength = ancho - 8;
        # si no, la etiqueta se queda en su valor fijo. Determinista en las
        # tres plataformas, sin window manager ni timing.
        def _primera_etiqueta_con_wrap(w):
            for _ch in w.winfo_children():
                r = _primera_etiqueta_con_wrap(_ch)
                if r is not None:
                    return r
            if w.winfo_class() == "TLabel":
                try:
                    if int(str(w.cget("wraplength"))) > 0:
                        return w
                except Exception:
                    pass
            return None

        _a.phases_nb.select(_a.calib_phase)
        _a.update()
        _lbl = _primera_etiqueta_con_wrap(_a.calib_phase)
        _autowrap_ok = False
        _detalle = "sin etiquetas con wraplength en la fase de calibración"
        if _lbl is not None:
            _lbl.event_generate("<Configure>", width=888)
            _wl = int(str(_lbl.cget("wraplength")))
            _autowrap_ok = _wl == 880  # max(120, 888 - 8)
            _detalle = f"wraplength={_wl} tras <Configure> sintético de 888"
        check("las descripciones siguen el ancho de la columna (autowrap)",
              _autowrap_ok, _detalle)
        # El log no debe morir con emojis fuera del BMP (Tk de Windows).
        try:
            _a.scans_phase._append_log("📋 prueba de emoji fuera del BMP")
            _emoji_ok = True
        except Exception:
            _emoji_ok = False
        check("el log tolera emojis fuera del BMP (📋)", _emoji_ok)
        _a.destroy()
    except Exception as _e:
        check("la app construye todas las fases y pestañas", False,
              f"{type(_e).__name__}: {_e}")

# ════════════════════════════════════════════════════════════════
print("\n══ 12. Saneado de nombres y contención de rutas ══")

# sanitize_label es la ÚNICA defensa contra que una etiqueta de un layout
# compartido escriba fuera de la carpeta de salida.
check("sanitize_label neutraliza separadores de ruta",
      "/" not in core.sanitize_label("../../etc/passwd")
      and "\\" not in core.sanitize_label("..\\..\\windows")
      and ":" not in core.sanitize_label("C:/temp/x"))
check("sanitize_label nunca devuelve vacío",
      core.sanitize_label("") == "frame" and core.sanitize_label("   ") == "frame")

# Etiquetas repetidas: antes la segunda pisaba a la primera en el layout.json
# y ese fotograma no se podía recuperar nunca del escaneo.
_labs = core.uniquify_labels(["toma", "toma", "otra", "toma", "toma_2"])
check("uniquify_labels no deja duplicados",
      len(_labs) == len(set(_labs)) == 5, str(_labs))
check("uniquify_labels conserva la primera aparición intacta",
      _labs[0] == "toma" and _labs[2] == "otra", str(_labs))

# Dos archivos con el mismo nombre sin extensión deben acabar en DOS entradas
# del layout (el bug real: 'toma.png' y 'toma.jpg' colisionaban).
_col_dir = TMP / "colision"
_col_dir.mkdir(parents=True, exist_ok=True)
for _ext in (".png", ".jpg"):
    _im = Image.new("RGB", (120, 90), (200, 60, 60) if _ext == ".png" else (60, 60, 200))
    _im.save(_col_dir / f"toma{_ext}")
_col_paths = [str(_col_dir / "toma.png"), str(_col_dir / "toma.jpg")]
_s_col = settings_base(TMP / "hojas_colision", out_name="colision",
                       project_name="colision")
_res_col = core.generate(_s_col, _col_paths, labels=["toma", "toma"])
_lay_col = layoutfile.load(_res_col["layout"])
_n_frames_col = sum(len(h.get("frames", {})) for h in _lay_col["hojas"])
check("etiquetas repetidas no pierden fotogramas en el layout",
      _n_frames_col == 2, f"frames en el layout={_n_frames_col} (esperado 2)")

# out_name viene de 'ajustes' de un layout compartido en el flujo de rescate.
_ev_out = TMP / "evasion" / "salida"
_s_ev = settings_base(_ev_out, out_name="../../fuera_evil", project_name="ev")
_res_ev = core.generate(_s_ev, frame_paths[:2], labels=labels[:2])
_generados = list(_res_ev["pages"]) + [_res_ev["layout"]]
_escapados = [p for p in _generados if p and
              _ev_out.resolve() != Path(p).resolve().parent]
check("out_name con '..' no escribe fuera de la carpeta de salida",
      not _escapados, f"escaparon: {_escapados}")

# rescue._safe_join: contención de las rutas que vienen del layout.
check("_safe_join rechaza rutas absolutas",
      rescue._safe_join(TMP, "/etc/passwd") is None)
check("_safe_join rechaza el salto con '..'",
      rescue._safe_join(TMP, "../../secreto.png") is None)
check("_safe_join acepta una relativa contenida",
      rescue._safe_join(TMP, "sub/x.png") == (TMP / "sub" / "x.png").resolve())

# ════════════════════════════════════════════════════════════════
print("\n══ 13. Robustez ante layouts y escaneos hostiles ══")

_scan_cualquiera = Path(res["pages"][0])

# Un layout.json malformado tumbaba la tanda ENTERA de escaneos.
for _nombre, _mal in (
    ("sin lienzo", {"marcadores": {"bboxes": {}}, "hojas": []}),
    ("ancho no numérico", {"lienzo": {"ancho_px": "x", "alto_px": 100},
                           "marcadores": {"bboxes": {}}, "hojas": []}),
    ("sin marcadores", {"lienzo": {"ancho_px": 100, "alto_px": 100},
                        "hojas": []}),
):
    try:
        _r = scan._process_one(_scan_cualquiera, _mal, TMP / "hostil_out",
                               scan.ScanOptions(report=False), "normal")
        _ok_mal = bool(_r.error)
    except Exception as _e:
        _ok_mal = False
        _r = None
    check(f"layout malformado ({_nombre}) falla solo ese escaneo", _ok_mal,
          "lanzó excepción en vez de devolver error" if _r is None else "sin error")

# Lienzo desproporcionado: reserva de memoria descomunal al enderezar.
_bomba_layout = {"lienzo": {"ancho_px": 10 ** 6, "alto_px": 10 ** 6},
                 "marcadores": {"dict": "DICT_4X4_50",
                                "bboxes": {"0": [0, 0, 10, 10]}},
                 "hojas": []}
try:
    _r_bomba = scan._process_one(_scan_cualquiera, _bomba_layout,
                                 TMP / "hostil_out",
                                 scan.ScanOptions(report=False), "normal")
    _ok_bomba = bool(_r_bomba.error)
except Exception:
    _ok_bomba = False
check("lienzo desproporcionado se rechaza sin reservar memoria", _ok_bomba)

# Bomba de descompresión: se comprueba el tope bajando el umbral.
_max_orig = scan.MAX_IMAGE_PIXELS
try:
    scan.MAX_IMAGE_PIXELS = 100          # 10×10 px como máximo
    _leida = scan.leer_imagen_robusta(_scan_cualquiera)
    check("imagen por encima del tope de píxeles se rechaza", _leida is None)
finally:
    scan.MAX_IMAGE_PIXELS = _max_orig
check("con el tope normal la misma imagen se lee bien",
      scan.leer_imagen_robusta(_scan_cualquiera) is not None)

# QR de OTRO proyecto: antes se aceptaba y se recortaba con esta geometría.
_page0 = cv2.imread(res["pages"][0], cv2.IMREAD_COLOR)
_hoja_ok, _via_ok = scan._identify_sheet(_page0, layout, 1.0, None)
check("el QR identifica la hoja dentro del mismo proyecto",
      _hoja_ok is not None, f"via={_via_ok}")
_layout_otro = json.loads(json.dumps(layout))
_layout_otro["proyecto"] = "PROYECTO_COMPLETAMENTE_DISTINTO"
_hoja_x, _ = scan._identify_sheet(_page0, _layout_otro, 1.0, None)
check("un QR de otro proyecto NO identifica la hoja", _hoja_x is None)

# parse_qr_payload: decodifica texto que viene de un QR (entrada no confiable).
check("parse_qr_payload lee el formato v2",
      markers.parse_qr_payload(markers.qr_payload("proy", 3, 2, "et"))
      == {"proyecto": "proy", "hoja": 3, "celda": 2, "etiqueta": "et"})
check("parse_qr_payload trata el texto suelto como QR v1",
      markers.parse_qr_payload("solo_etiqueta")["etiqueta"] == "solo_etiqueta")
check("parse_qr_payload devuelve None con texto vacío",
      markers.parse_qr_payload("") is None)
check("parse_qr_payload no revienta con basura",
      markers.parse_qr_payload("K2|p|no_numero|x|et") is None
      and markers.parse_qr_payload("|||||||") is not None)

# ════════════════════════════════════════════════════════════════
print("\n══ 14. ffmpeg: sondeo, extracción y manejo de errores ══")
try:
    from kamiru import ffmpeg_utils

    _ff = ffmpeg_utils.find_ffmpeg()
    check("se localiza un ffmpeg utilizable", bool(_ff))

    _vid_path = str(TMP / "final.mp4")
    _info = ffmpeg_utils.probe(_ff, _vid_path)
    check("probe mide la resolución del video",
          _info.width > 0 and _info.height > 0,
          f"{_info.width}×{_info.height}")
    check("probe mide una duración positiva", _info.duration > 0,
          f"duracion={_info.duration}")

    _ex_dir = TMP / "extraidos"
    _got = ffmpeg_utils.extract_frames(_ff, _vid_path, str(_ex_dir))
    # El video se armó con 7 imágenes; el demuxer concat repite la última sin
    # 'duration' (ver videoout.build_video), así que salen 7 u 8 fotogramas.
    check("extract_frames recupera todos los fotogramas del video",
          7 <= len(_got) <= 8, f"extraídos={len(_got)}")
    check("los fotogramas extraídos son imágenes legibles",
          all(cv2.imread(p) is not None for p in _got[:3]))

    # max_frames corta antes (vista previa rápida).
    _got2 = ffmpeg_utils.extract_frames(_ff, _vid_path, str(TMP / "extraidos2"),
                                        max_frames=3)
    check("extract_frames respeta max_frames", len(_got2) <= 3,
          f"extraídos={len(_got2)}")

    # Un archivo que no es video debe dar FFmpegError, no colgarse ni pasar.
    _no_video = TMP / "no_es_video.mp4"
    _no_video.write_bytes(b"esto no es un video" * 100)
    try:
        ffmpeg_utils.extract_frames(_ff, str(_no_video), str(TMP / "extraidos3"))
        _ok_err = False
    except ffmpeg_utils.FFmpegError:
        _ok_err = True
    except Exception:
        _ok_err = False
    check("un archivo que no es video lanza FFmpegError", _ok_err)
except Exception as _e:
    check("pruebas de ffmpeg", False, f"{type(_e).__name__}: {_e}")

# ════════════════════════════════════════════════════════════════
print("\n══ 15. Dedup → video: «pintar una vez, reutilizar» ══")
try:
    from kamiru import videoout as _vo

    # La línea de tiempo de la sección 9 tenía rep == etiqueta en todas las
    # posiciones, así que NUNCA se ejercitaba la reutilización: un dibujo
    # pintado una sola vez debe reaparecer en todas sus posiciones del video.
    _lay_reuse = json.loads(json.dumps(layout))
    _lay_reuse["timeline"] = [
        {"pos": 1, "etiqueta": labels[0], "rep": labels[0]},
        {"pos": 2, "etiqueta": labels[1], "rep": labels[0]},   # reutilizado
        {"pos": 3, "etiqueta": labels[2], "rep": labels[2]},
        {"pos": 4, "etiqueta": labels[3], "rep": labels[0]},   # reutilizado
    ]
    _files_r, _miss_r = _vo.frames_from_timeline(_lay_reuse, outp1)
    check("el representante deduplicado se reutiliza en cada posición",
          len(_files_r) == 4 and not _miss_r
          and _files_r[0] == _files_r[1] == _files_r[3]
          and _files_r[2] != _files_r[0],
          f"files={len(_files_r)} missing={_miss_r}")

    # El orden lo manda 'pos', no el orden de aparición en la lista.
    _lay_orden = json.loads(json.dumps(layout))
    _lay_orden["timeline"] = [
        {"pos": 2, "etiqueta": labels[1], "rep": labels[1]},
        {"pos": 1, "etiqueta": labels[0], "rep": labels[0]},
    ]
    _files_o, _ = _vo.frames_from_timeline(_lay_orden, outp1)
    check("la línea de tiempo se ordena por 'pos'",
          len(_files_o) == 2 and Path(_files_o[0]).stem.startswith(labels[0]),
          f"primero={Path(_files_o[0]).stem if _files_o else None}")

    # Un representante sin archivo procesado se reporta como faltante.
    _lay_falta = json.loads(json.dumps(layout))
    _lay_falta["timeline"] = [{"pos": 1, "etiqueta": "no_existe",
                               "rep": "no_existe"}]
    _f2, _m2 = _vo.frames_from_timeline(_lay_falta, outp1)
    check("un representante sin archivo se reporta como faltante",
          not _f2 and _m2 == ["no_existe"], f"files={_f2} missing={_m2}")

    # Y el video se arma de verdad con archivos repetidos (demuxer concat).
    _vid_r = _vo.build_video(_files_r, 6.0, TMP / "reuso.mp4", _vo.CODECS[0])
    check("se construye el video con fotogramas repetidos",
          Path(_vid_r).stat().st_size > 5000)
except Exception as _e:
    check("dedup → video", False, f"{type(_e).__name__}: {_e}")

# ════════════════════════════════════════════════════════════════
fails = [n for n, ok in PASSED if not ok]
print(f"\n{'=' * 56}\nResultado: {len(PASSED) - len(fails)}/{len(PASSED)} pruebas OK")
if fails:
    print("FALLARON:", ", ".join(fails))
    sys.exit(1)
print(f"(archivos temporales en {TMP})")
shutil.rmtree(TMP, ignore_errors=True)
print("TODO OK ✅")
