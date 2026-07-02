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

import cv2
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kamiru import calibration, core, cyanotype, dedup, layoutfile, rescue, scan  # noqa: E402

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
fails = [n for n, ok in PASSED if not ok]
print(f"\n{'=' * 56}\nResultado: {len(PASSED) - len(fails)}/{len(PASSED)} pruebas OK")
if fails:
    print("FALLARON:", ", ".join(fails))
    sys.exit(1)
print(f"(archivos temporales en {TMP})")
shutil.rmtree(TMP, ignore_errors=True)
print("TODO OK ✅")
