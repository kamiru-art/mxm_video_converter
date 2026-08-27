//! Procesador de escaneos: port fiel de la fase ② de la app original.
//! Alinea cada escaneo con los marcadores ArUco (multi-estrategia, espejo y
//! polaridad automáticos), lo identifica por QR y recorta cada fotograma.

use crate::aruco::{detect_markers, params_for_mode, Dict};
use crate::geometry::{apply_h, find_homography_ransac, Pt, H3};
use crate::img::{DynImg, Gray, Rgb};
use crate::imgproc::{clahe, flat_field, normalize_minmax};
use crate::layoutfile;
use crate::qr::{decode_qr_rgb, parse_qr_payload};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const PROXY_SIDES: [usize; 2] = [2400, 1200];
pub const RESIDUAL_OUTLIER_MM: f64 = 2.5;
pub const RESIDUAL_WARN_MM: f64 = 1.0;
pub const FINE_ALIGN_MIN_MM: f64 = 0.15;
pub const MAX_IMAGE_PIXELS: usize = 250_000_000;

#[derive(Clone)]
pub struct ScanOptions {
    pub bleed: f64,
    pub min_markers: usize,
    pub mode: String, // auto | normal | cianotipia
    pub resize_to_original: bool,
    pub normalize_patches: bool,
    pub fine_align: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        ScanOptions {
            bleed: 0.015,
            min_markers: 3,
            mode: "auto".into(),
            resize_to_original: false,
            normalize_patches: false,
            fine_align: true,
        }
    }
}

// ────────────────────────────────────────────────────────────────
// Variantes de grises (estrategias de preprocesado)
// ────────────────────────────────────────────────────────────────

fn gray_variants_base(rgb: &Rgb, mode: &str) -> Vec<(String, Gray)> {
    let gray = rgb.to_gray();
    let red = rgb.red_channel();
    if mode == "cianotipia" {
        vec![
            ("canal_rojo".into(), red.clone()),
            ("rojo_aplanado".into(), flat_field(&red)),
            ("canal_rojo_clahe".into(), clahe(&red, 3.0, 8)),
            ("gris".into(), gray.clone()),
            ("gris_clahe".into(), clahe(&gray, 3.0, 8)),
            ("gris_norm".into(), normalize_minmax(&gray)),
        ]
    } else {
        vec![
            ("gris".into(), gray.clone()),
            ("canal_rojo".into(), red.clone()),
            ("gris_clahe".into(), clahe(&gray, 3.0, 8)),
            ("canal_rojo_clahe".into(), clahe(&red, 3.0, 8)),
            ("rojo_aplanado".into(), flat_field(&red)),
            ("gris_norm".into(), normalize_minmax(&gray)),
        ]
    }
}

/// Resultado de la detección multi-estrategia.
pub struct MultiDetect {
    pub strategy: String,
    pub found: HashMap<u32, [Pt; 4]>,
    pub inverted: bool,
    pub escalated: bool,
}

/// Prueba variantes de preprocesado (ambas polaridades) y perfiles del
/// detector; devuelve la mejor detección. Port de _detect_markers_multi.
/// `target`: cuántos marcadores hay REALMENTE en una hoja. En layouts sin QR
/// `expected` es la unión de los IDs de todas las hojas, así que sin este tope
/// el detector agotaría todas las variantes buscando marcadores inexistentes.
pub fn detect_markers_multi(
    rgb: &Rgb,
    dict: Dict,
    expected: &[u32],
    mode: &str,
    polaridad: &str,
    escalar: bool,
    target: usize,
) -> MultiDetect {
    let expected_set: std::collections::HashSet<u32> = expected.iter().cloned().collect();
    let target = target.min(expected_set.len()).max(1);
    let solido = 3usize.max(target / 2);
    let mut profiles: Vec<(&str, bool)> = vec![(mode, false)];
    if escalar && mode != "cianotipia" {
        profiles.push(("cianotipia", true));
    }
    let mut best = MultiDetect {
        strategy: String::new(),
        found: HashMap::new(),
        inverted: false,
        escalated: false,
    };
    for (prof_mode, escalated) in profiles {
        let params = params_for_mode(prof_mode);
        let mut detect_on = |name: &str, g: &Gray, inverted: bool, best: &mut MultiDetect| -> bool {
            let dets = detect_markers(g, dict, &params);
            let mut found: HashMap<u32, [Pt; 4]> = HashMap::new();
            for d in dets {
                let id = d.id as u32;
                if expected_set.contains(&id) && !found.contains_key(&id) {
                    found.insert(id, d.corners);
                }
            }
            if found.len() > best.found.len() {
                best.strategy = format!(
                    "{}{}{}",
                    name,
                    if inverted { "_invertido" } else { "" },
                    if escalated { "_ciano" } else { "" }
                );
                best.found = found;
                best.inverted = inverted;
                best.escalated = escalated;
            }
            best.found.len() >= target
        };

        let inv_first = polaridad == "invertida_primero";
        let base = gray_variants_base(rgb, prof_mode);
        let mut completo = false;
        for (name, g) in &base {
            let img = if inv_first { g.invert() } else { g.clone() };
            if detect_on(name, &img, inv_first, &mut best) {
                completo = true;
                break;
            }
        }
        if !completo && polaridad != "normal" && best.found.len() < solido {
            for (name, g) in &base {
                let img = if inv_first { g.clone() } else { g.invert() };
                if detect_on(name, &img, !inv_first, &mut best) {
                    break;
                }
            }
        }
        if best.found.len() >= solido {
            break;
        }
    }
    best
}

/// Detección en proxy con prueba de espejo y mapeo exacto a resolución
/// completa. Devuelve además si hubo que voltear la imagen.
pub struct OrientedDetect {
    pub strategy: String,
    pub found: HashMap<u32, [Pt; 4]>,
    pub flipped: bool,
    pub inverted: bool,
    pub escalated: bool,
}

pub fn detect_oriented(
    img: &mut DynImg,
    dict: Dict,
    expected: &[u32],
    mode: &str,
    target: usize,
) -> OrientedDetect {
    let (w, _h) = img.size();
    let target = target.min(expected.len()).max(1);
    let objetivo = 3usize.max(target / 2);

    let mut out = OrientedDetect {
        strategy: String::new(),
        found: HashMap::new(),
        flipped: false,
        inverted: false,
        escalated: false,
    };
    let mut factor = 1.0f64;
    let mut wp = w;
    let mut factor_prev: Option<f64> = None;
    'outer: for (idx, &max_side) in PROXY_SIDES.iter().enumerate() {
        let (proxy, f) = img.proxy_rgb8(max_side);
        if let Some(fp) = factor_prev {
            if (f - fp).abs() < 1e-9 {
                continue;
            }
        }
        factor_prev = Some(f);
        let sufijo = if idx > 0 { "_bin" } else { "" };
        for flip in [false, true] {
            let cara = if flip { proxy.flip_horizontal() } else { proxy.clone() };
            let det = detect_markers_multi(&cara, dict, expected, mode, "ambas", true, target);
            if det.found.len() > out.found.len() {
                out.strategy = format!(
                    "{}{}{}",
                    det.strategy,
                    if flip { "_espejado" } else { "" },
                    sufijo
                );
                out.found = det.found;
                out.flipped = flip;
                out.inverted = det.inverted;
                out.escalated = det.escalated;
                factor = f;
                wp = cara.w;
            }
            if out.found.len() >= objetivo {
                break 'outer;
            }
        }
    }

    if out.flipped {
        img.flip_horizontal();
    }
    // mapear esquinas proxy → resolución completa (con el volteo exacto)
    let mut full: HashMap<u32, [Pt; 4]> = HashMap::new();
    for (id, corners) in &out.found {
        let mut cf = *corners;
        for c in cf.iter_mut() {
            if out.flipped {
                c.0 = (w as f64 - 1.0) - ((wp as f64 - 1.0) - c.0) * factor;
                c.1 *= factor;
            } else {
                c.0 *= factor;
                c.1 *= factor;
            }
        }
        full.insert(*id, cf);
    }
    out.found = full;
    out
}

/// Re-detecta cada marcador en un recorte a resolución completa (subpíxel).
pub fn refine_corners_fullres(
    img: &DynImg,
    full: &HashMap<u32, [Pt; 4]>,
    dict: Dict,
    mode: &str,
    polaridad: &str,
) -> HashMap<u32, [Pt; 4]> {
    let (w, h) = img.size();
    let params = params_for_mode(mode);
    let mut refined = HashMap::new();
    for (&mid, corners) in full {
        let xs: Vec<f64> = corners.iter().map(|c| c.0).collect();
        let ys: Vec<f64> = corners.iter().map(|c| c.1).collect();
        let x1 = xs.iter().cloned().fold(f64::MAX, f64::min);
        let x2 = xs.iter().cloned().fold(f64::MIN, f64::max);
        let y1 = ys.iter().cloned().fold(f64::MAX, f64::min);
        let y2 = ys.iter().cloned().fold(f64::MIN, f64::max);
        let side = (x2 - x1).max(y2 - y1);
        let pad = side * 0.6;
        let rx1 = ((x1 - pad).max(0.0)) as usize;
        let ry1 = ((y1 - pad).max(0.0)) as usize;
        let rx2 = ((x2 + pad) as usize).min(w);
        let ry2 = ((y2 + pad) as usize).min(h);
        if rx2.saturating_sub(rx1) < 8 || ry2.saturating_sub(ry1) < 8 {
            refined.insert(mid, *corners);
            continue;
        }
        let crop = img.crop_rgb8(rx1, ry1, rx2, ry2);
        let mut found: Option<[Pt; 4]> = None;
        for (_, g) in variants_with_polarity(&crop, mode, polaridad) {
            let dets = detect_markers(&g, dict, &params);
            for d in dets {
                if d.id as u32 == mid {
                    found = Some(d.corners);
                    break;
                }
            }
            if found.is_some() {
                break;
            }
        }
        match found {
            Some(mut c) => {
                for p in c.iter_mut() {
                    p.0 += rx1 as f64;
                    p.1 += ry1 as f64;
                }
                refined.insert(mid, c);
            }
            None => {
                refined.insert(mid, *corners);
            }
        }
    }
    refined
}

fn variants_with_polarity(rgb: &Rgb, mode: &str, polaridad: &str) -> Vec<(String, Gray)> {
    let base = gray_variants_base(rgb, mode);
    let mut out = Vec::new();
    match polaridad {
        "invertida_primero" => {
            for (n, g) in &base {
                out.push((format!("{n}_invertido"), g.invert()));
            }
            for (n, g) in base {
                out.push((n, g));
            }
        }
        "normal" => {
            for (n, g) in base {
                out.push((n, g));
            }
        }
        _ => {
            for (n, g) in &base {
                out.push((n.clone(), g.clone()));
            }
            for (n, g) in base {
                out.push((format!("{n}_invertido"), g.invert()));
            }
        }
    }
    out
}

// ────────────────────────────────────────────────────────────────
// Escala, correspondencias y residuos
// ────────────────────────────────────────────────────────────────

pub fn bbox_corners(b: [f64; 4]) -> [Pt; 4] {
    [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])]
}

fn layout_bbox(layout_bboxes: &Value, id: u32) -> Option<[f64; 4]> {
    layout_bboxes.get(id.to_string()).and_then(layoutfile::bbox_of)
}

pub fn estimate_scale(detected: &HashMap<u32, [Pt; 4]>, layout_bboxes: &Value) -> Option<f64> {
    let mut ids: Vec<u32> = detected
        .keys()
        .cloned()
        .filter(|id| layout_bbox(layout_bboxes, *id).is_some())
        .collect();
    ids.sort();
    if ids.len() < 2 {
        return None;
    }
    let center_scan: HashMap<u32, Pt> = ids
        .iter()
        .map(|&id| {
            let c = detected[&id];
            (id, ((c[0].0 + c[1].0 + c[2].0 + c[3].0) / 4.0, (c[0].1 + c[1].1 + c[2].1 + c[3].1) / 4.0))
        })
        .collect();
    let center_lay: HashMap<u32, Pt> = ids
        .iter()
        .map(|&id| {
            let b = layout_bbox(layout_bboxes, id).unwrap();
            (id, ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0))
        })
        .collect();
    let mut ratios = Vec::new();
    for i in 0..ids.len() {
        for j in i + 1..ids.len() {
            let (a, b) = (ids[i], ids[j]);
            let ds = ((center_scan[&a].0 - center_scan[&b].0).powi(2)
                + (center_scan[&a].1 - center_scan[&b].1).powi(2))
            .sqrt();
            let dl = ((center_lay[&a].0 - center_lay[&b].0).powi(2)
                + (center_lay[&a].1 - center_lay[&b].1).powi(2))
            .sqrt();
            if dl > 1.0 {
                ratios.push(ds / dl);
            }
        }
    }
    if ratios.is_empty() {
        return None;
    }
    ratios.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Some(ratios[ratios.len() / 2])
}

fn correspondences(
    refined: &HashMap<u32, [Pt; 4]>,
    layout_bboxes: &Value,
    s: f64,
) -> (Vec<Pt>, Vec<Pt>) {
    let mut src = Vec::new();
    let mut dst = Vec::new();
    let mut ids: Vec<u32> = refined.keys().cloned().collect();
    ids.sort();
    for id in ids {
        if let Some(b) = layout_bbox(layout_bboxes, id) {
            let corners = refined[&id];
            for k in 0..4 {
                src.push(corners[k]);
                let bc = bbox_corners(b);
                dst.push((bc[k].0 * s, bc[k].1 * s));
            }
        }
    }
    (src, dst)
}

/// Campo de residuos: (puntos_layout, errores, residuo_medio_por_marcador).
fn residual_field(
    m: &H3,
    refined: &HashMap<u32, [Pt; 4]>,
    layout_bboxes: &Value,
    s: f64,
) -> (Vec<Pt>, Vec<Pt>, HashMap<u32, f64>) {
    let mut pts = Vec::new();
    let mut errs = Vec::new();
    let mut per_marker = HashMap::new();
    for (&mid, corners) in refined {
        if let Some(b) = layout_bbox(layout_bboxes, mid) {
            let bc = bbox_corners(b);
            let mut acc = 0.0;
            for k in 0..4 {
                let proj = apply_h(m, corners[k]);
                let dst = (bc[k].0 * s, bc[k].1 * s);
                pts.push(dst);
                errs.push((proj.0 - dst.0, proj.1 - dst.1));
                acc += ((proj.0 - dst.0).powi(2) + (proj.1 - dst.1).powi(2)).sqrt();
            }
            per_marker.insert(mid, acc / 4.0);
        }
    }
    (pts, errs, per_marker)
}

fn px_per_mm(layout: &Value, s: f64) -> f64 {
    let dpi = layout["lienzo"]["dpi"].as_f64().unwrap_or(300.0);
    (s * dpi / 25.4).max(1e-6)
}

/// Corrector local de recortes (papel deformado): interpola el campo de
/// residuos con ponderación por distancia inversa. Serializable para poder
/// cruzar el puente WASM↔JS en el camino con warp por WebGPU.
#[derive(Serialize, Deserialize, Clone)]
pub struct LocalShift {
    pub pts: Vec<Pt>,
    pub errs: Vec<Pt>,
    pub eps2: f64,
}

impl LocalShift {
    pub fn shift(&self, bbox: [f64; 4]) -> (f64, f64) {
        let cx = (bbox[0] + bbox[2]) / 2.0;
        let cy = (bbox[1] + bbox[3]) / 2.0;
        let mut wsum = 0.0;
        let mut dx = 0.0;
        let mut dy = 0.0;
        for i in 0..self.pts.len() {
            let d2 = (self.pts[i].0 - cx).powi(2) + (self.pts[i].1 - cy).powi(2);
            let w = 1.0 / (d2 + self.eps2);
            wsum += w;
            dx += w * self.errs[i].0;
            dy += w * self.errs[i].1;
        }
        if wsum <= 0.0 {
            return (0.0, 0.0);
        }
        (dx / wsum, dy / wsum)
    }
}

fn make_local_shift(
    m: &H3,
    refined: &HashMap<u32, [Pt; 4]>,
    layout_bboxes: &Value,
    s: f64,
    px_mm: f64,
) -> Option<LocalShift> {
    let (pts, errs, _) = residual_field(m, refined, layout_bboxes, s);
    if pts.len() < 16 {
        return None;
    }
    let umbral = (FINE_ALIGN_MIN_MM * px_mm).max(0.75);
    let mut norms: Vec<f64> = errs.iter().map(|e| (e.0 * e.0 + e.1 * e.1).sqrt()).collect();
    norms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if norms[norms.len() / 2] < umbral {
        return None;
    }
    let mut sides: Vec<f64> = refined
        .keys()
        .filter_map(|id| layout_bbox(layout_bboxes, *id))
        .map(|b| (b[2] - b[0]) * s)
        .collect();
    sides.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let eps2 = if sides.is_empty() { 100.0 } else { sides[sides.len() / 2].powi(2) };
    Some(LocalShift { pts, errs, eps2 })
}

/// Recuperación guiada de marcadores perdidos.
pub fn recover_missing_markers(
    img: &DynImg,
    refined: &HashMap<u32, [Pt; 4]>,
    layout_bboxes: &Value,
    s: f64,
    dict: Dict,
    mode: &str,
    thresh: f64,
    polaridad: &str,
) -> HashMap<u32, [Pt; 4]> {
    let mut out = HashMap::new();
    let all_ids: Vec<u32> = layout_bboxes
        .as_object()
        .map(|o| o.keys().filter_map(|k| k.parse().ok()).collect())
        .unwrap_or_default();
    let missing: Vec<u32> = all_ids.iter().cloned().filter(|id| !refined.contains_key(id)).collect();
    if missing.is_empty() || refined.len() < 3 {
        return out;
    }
    let (src, dst) = correspondences(refined, layout_bboxes, s);
    if src.is_empty() {
        return out;
    }
    // homografía preliminar layout → escaneo
    let m0 = match find_homography_ransac(&dst, &src, thresh) {
        Some((m, _)) => m,
        None => return out,
    };
    let (w, h) = img.size();
    let params = params_for_mode(mode);
    for mid in missing {
        let b = match layout_bbox(layout_bboxes, mid) {
            Some(b) => b,
            None => continue,
        };
        let bc = bbox_corners(b);
        let proj: Vec<Pt> = bc.iter().map(|&(x, y)| apply_h(&m0, (x * s, y * s))).collect();
        let x1 = proj.iter().map(|p| p.0).fold(f64::MAX, f64::min);
        let x2 = proj.iter().map(|p| p.0).fold(f64::MIN, f64::max);
        let y1 = proj.iter().map(|p| p.1).fold(f64::MAX, f64::min);
        let y2 = proj.iter().map(|p| p.1).fold(f64::MIN, f64::max);
        let side = (x2 - x1).max(y2 - y1);
        if side < 6.0 {
            continue;
        }
        let pad = side;
        let rx1 = ((x1 - pad).max(0.0)) as usize;
        let ry1 = ((y1 - pad).max(0.0)) as usize;
        let rx2 = ((x2 + pad) as usize).min(w);
        let ry2 = ((y2 + pad) as usize).min(h);
        if rx2.saturating_sub(rx1) < 12 || ry2.saturating_sub(ry1) < 12 {
            continue;
        }
        let mut crop = img.crop_rgb8(rx1, ry1, rx2, ry2);
        let mut k = 1.0f64;
        if side < 60.0 {
            k = 3.0;
            crop = crate::img::resize_rgb(
                &crop,
                (crop.w as f64 * k) as usize,
                (crop.h as f64 * k) as usize,
                crate::img::Filter::Triangle,
            );
        }
        for (_, g) in variants_with_polarity(&crop, mode, polaridad) {
            let dets = detect_markers(&g, dict, &params);
            let mut got = None;
            for d in dets {
                if d.id as u32 == mid {
                    got = Some(d.corners);
                    break;
                }
            }
            if let Some(mut c) = got {
                for p in c.iter_mut() {
                    p.0 = p.0 / k + rx1 as f64;
                    p.1 = p.1 / k + ry1 as f64;
                }
                out.insert(mid, c);
                break;
            }
        }
    }
    out
}

// ────────────────────────────────────────────────────────────────
// Recorte y proceso completo de un escaneo
// ────────────────────────────────────────────────────────────────

pub fn aplicar_bleed(x1: f64, y1: f64, x2: f64, y2: f64, factor: f64) -> (f64, f64, f64, f64) {
    let (w, h) = (x2 - x1, y2 - y1);
    let (rx, ry) = ((w * factor).trunc(), (h * factor).trunc());
    (x1 + rx, y1 + ry, x2 - rx, y2 - ry)
}

fn crop_frame(
    warp: &DynImg,
    bbox: [f64; 4],
    s: f64,
    bleed: f64,
    local: Option<&LocalShift>,
) -> Option<DynImg> {
    let mut fx1 = bbox[0] * s;
    let mut fy1 = bbox[1] * s;
    let mut fx2 = bbox[2] * s;
    let mut fy2 = bbox[3] * s;
    if let Some(ls) = local {
        let (dx, dy) = ls.shift([fx1, fy1, fx2, fy2]);
        fx1 += dx;
        fx2 += dx;
        fy1 += dy;
        fy2 += dy;
    }
    let (x1, y1, x2, y2) = aplicar_bleed(fx1.round(), fy1.round(), fx2.round(), fy2.round(), bleed);
    let (w, h) = warp.size();
    let x1 = (x1.max(0.0)) as usize;
    let y1 = (y1.max(0.0)) as usize;
    let x2 = (x2.max(0.0) as usize).min(w);
    let y2 = (y2.max(0.0) as usize).min(h);
    if x2 <= x1 || y2 <= y1 {
        return None;
    }
    Some(warp.crop(x1, y1, x2, y2))
}

fn crop_frame_rgb8(
    warp: &DynImg,
    bbox: [f64; 4],
    s: f64,
    bleed: f64,
    local: Option<&LocalShift>,
) -> Option<Rgb> {
    crop_frame(warp, bbox, s, bleed, local).map(|d| d.to_rgb8())
}

fn identify_sheet<'a>(
    warp: &DynImg,
    layout: &'a Value,
    s: f64,
    local: Option<&LocalShift>,
) -> Option<(&'a Value, String)> {
    let hojas = layout.get("hojas")?.as_array()?;
    let mut probadas: std::collections::HashSet<String> = std::collections::HashSet::new();
    for hoja_geom in hojas {
        if let Some(qrs) = hoja_geom.get("qrs").and_then(|v| v.as_object()) {
            for (_etq, qinfo) in qrs {
                let bbox = match layoutfile::bbox_of(&qinfo["bbox"]) {
                    Some(b) => b,
                    None => continue,
                };
                let key = format!("{:?}", bbox);
                if !probadas.insert(key) {
                    continue;
                }
                // bleed negativo = ampliar 35 % por lado
                let crop = match crop_frame_rgb8(warp, bbox, s, -0.35, local) {
                    Some(c) => c,
                    None => continue,
                };
                let texto = match decode_qr_rgb(&crop) {
                    Some(t) => t,
                    None => continue,
                };
                let payload = match parse_qr_payload(&texto) {
                    Some(p) => p,
                    None => continue,
                };
                let proy_qr = payload.proyecto.clone().unwrap_or_default();
                let proy_layout = layout.get("proyecto").and_then(|v| v.as_str()).unwrap_or("");
                if !proy_qr.trim().is_empty()
                    && !proy_layout.trim().is_empty()
                    && proy_qr.trim() != proy_layout.trim()
                {
                    continue; // QR de otro proyecto
                }
                if let Some(hn) = payload.hoja {
                    if let Some(hoja) = layoutfile::sheet_by_number(layout, hn) {
                        return Some((hoja, format!("QR from '{}'", payload.etiqueta)));
                    }
                }
                // v1: buscar la hoja que contiene la etiqueta
                let lab = payload.etiqueta;
                if !lab.is_empty() {
                    for h in hojas {
                        if h.get("frames").and_then(|f| f.get(&lab)).is_some() {
                            return Some((h, format!("QR v1 de '{lab}'")));
                        }
                    }
                }
            }
        }
    }
    None
}

/// Resultado del procesamiento de un escaneo.
pub struct ScanOutput {
    /// Informe JSON (compatible con ScanResult de la app original).
    pub result: Value,
    /// Recortes identificados: (etiqueta, imagen en profundidad nativa).
    pub frames: Vec<(String, DynImg)>,
    /// Recortes sin identificar (modo emergencia): (nombre_sugerido, imagen).
    pub unidentified: Vec<(String, DynImg)>,
    /// Miniatura de diagnóstico (alineación con rectángulos de colores).
    pub overlay: Option<Rgb>,
}

/// Marcadores del layout resueltos: mapa id→bbox (uniendo `ids_por_hoja` +
/// `bboxes_pos` cuando existen — hojas sin QR) y el mapa hoja→IDs.
pub struct LayoutMarkers {
    pub bboxes: Value,
    pub ids_por_hoja: Option<HashMap<i64, Vec<u32>>>,
    pub dict: Dict,
}

pub fn resolve_markers(layout: &Value) -> LayoutMarkers {
    let minfo = &layout["marcadores"];
    let dict = Dict::from_name(minfo["dict"].as_str().unwrap_or("DICT_4X4_50"));
    let iph: Option<HashMap<i64, Vec<u32>>> = minfo
        .get("ids_por_hoja")
        .and_then(|v| v.as_object())
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| {
                    let num = k.parse::<i64>().ok()?;
                    let ids: Vec<u32> = v
                        .as_array()?
                        .iter()
                        .filter_map(|x| x.as_u64().map(|u| u as u32))
                        .collect();
                    Some((num, ids))
                })
                .collect()
        })
        .filter(|m: &HashMap<i64, Vec<u32>>| !m.is_empty());
    let bboxes = match (&iph, minfo.get("bboxes_pos").and_then(|v| v.as_array())) {
        (Some(iph), Some(pos)) => {
            let mut map = serde_json::Map::new();
            for ids in iph.values() {
                for (j, id) in ids.iter().enumerate() {
                    if let Some(b) = pos.get(j) {
                        map.insert(id.to_string(), b.clone());
                    }
                }
            }
            Value::Object(map)
        }
        _ => minfo["bboxes"].clone(),
    };
    LayoutMarkers { bboxes, ids_por_hoja: iph, dict }
}

/// Vota la hoja por los IDs de marcador detectados. Gana la hoja con más IDs
/// propios; un empate estricto = None (no identificable solo por marcadores).
pub fn vote_sheet(
    ids_por_hoja: &HashMap<i64, Vec<u32>>,
    detected: &HashSet<u32>,
) -> Option<(i64, usize)> {
    let mut best: Option<(i64, usize)> = None;
    let mut tied = false;
    for (&num, ids) in ids_por_hoja {
        let score = ids.iter().filter(|id| detected.contains(id)).count();
        match best {
            Some((_, b)) if score > b => {
                best = Some((num, score));
                tied = false;
            }
            Some((_, b)) if score == b => tied = true,
            None => best = Some((num, score)),
            _ => {}
        }
    }
    let (num, score) = best?;
    if tied || score == 0 {
        return None;
    }
    Some((num, score))
}

/// Identifica la hoja por los IDs de marcador detectados (hojas sin QR).
fn identify_by_markers<'a>(
    layout: &'a Value,
    ids_por_hoja: &HashMap<i64, Vec<u32>>,
    detected: &HashSet<u32>,
) -> Option<(&'a Value, String)> {
    let (num, score) = vote_sheet(ids_por_hoja, detected)?;
    layoutfile::sheet_by_number(layout, num)
        .map(|h| (h, format!("marker IDs ({score} matching)")))
}

pub fn base_report(scan_name: &str) -> Value {
    json!({
        "scan": scan_name,
        "ok": false,
        "hoja_numero": Value::Null,
        "archivo_hoja": Value::Null,
        "marcadores": 0,
        "marcadores_total": 0,
        "estrategia": "",
        "escala": 0.0,
        "advertencias": [],
        "error": "",
        "espejado": false,
        "residual_mm": 0.0,
    })
}

/// Resultado de la fase de detección/alineación (pasos 1–4c).
pub struct DetectData {
    /// Homografía escaneo (ya des-espejado) → lienzo del layout × s.
    pub m: H3,
    pub s: f64,
    pub flipped: bool,
    pub out_w: usize,
    pub out_h: usize,
    pub refined: HashMap<u32, [Pt; 4]>,
    pub local: Option<LocalShift>,
}

macro_rules! warn_res {
    ($res:expr, $($arg:tt)*) => {
        $res["advertencias"].as_array_mut().unwrap().push(json!(format!($($arg)*)));
    };
}

/// Fase de detección: marcadores, escala, homografía y corrector local.
/// Muta `res` (informe) y voltea `img` en el sitio si llegó espejado.
/// Err(()) = fallo; el error ya quedó escrito en `res`.
pub fn detect_scan(
    img: &mut DynImg,
    layout: &Value,
    opts: &ScanOptions,
    markers: &LayoutMarkers,
    res: &mut Value,
) -> Result<DetectData, ()> {
    macro_rules! warn {
        ($($arg:tt)*) => { warn_res!(res, $($arg)*) };
    }
    macro_rules! fail {
        ($($arg:tt)*) => {{
            res["error"] = json!(format!($($arg)*));
            return Err(());
        }};
    }

    let mode = if opts.mode == "auto" {
        layout.get("modo").and_then(|v| v.as_str()).unwrap_or("normal").to_string()
    } else {
        opts.mode.clone()
    };

    let lienzo = &layout["lienzo"];
    let page_w = lienzo["ancho_px"].as_f64().unwrap_or(0.0);
    let page_h = lienzo["alto_px"].as_f64().unwrap_or(0.0);
    if page_w <= 0.0 || page_h <= 0.0 || (page_w * page_h) as usize > MAX_IMAGE_PIXELS {
        fail!("The layout declares an impossible canvas ({page_w}×{page_h} px).");
    }
    let dict = markers.dict;
    let expected: Vec<u32> = markers
        .bboxes
        .as_object()
        .map(|o| o.keys().filter_map(|k| k.parse().ok()).collect())
        .unwrap_or_default();
    if expected.is_empty() {
        fail!("The layout is invalid or incomplete (no markers).");
    }
    // Cuántos marcadores hay físicamente en UNA hoja (en layouts sin QR,
    // `expected` es la unión de los IDs de todas las hojas).
    let per_sheet = markers
        .ids_por_hoja
        .as_ref()
        .and_then(|iph| iph.values().map(|v| v.len()).max())
        .unwrap_or(expected.len());
    res["marcadores_total"] = json!(per_sheet);

    // 1. Detección en proxy con espejo automático.
    let mut det = detect_oriented(img, dict, &expected, &mode, per_sheet);

    // 1b. Con identidad por marcadores: votar la hoja candidata YA y
    // restringir el resto del proceso a sus IDs. Sin esto, el afinado y la
    // recuperación guiada buscan los IDs de las demás hojas, releen los
    // marcadores reales como IDs ajenos (con la rotación equivocada) y el
    // control de residuos los tiene que descartar uno a uno.
    let restricted: Option<Vec<u32>> = markers.ids_por_hoja.as_ref().and_then(|iph| {
        let detected: HashSet<u32> = det.found.keys().cloned().collect();
        vote_sheet(iph, &detected).and_then(|(num, _)| iph.get(&num).cloned())
    });
    let layout_bboxes_owned: Value = match &restricted {
        Some(ids) => {
            let idset: HashSet<u32> = ids.iter().cloned().collect();
            det.found.retain(|id, _| idset.contains(id));
            let mut map = serde_json::Map::new();
            for id in ids {
                if let Some(b) = markers.bboxes.get(id.to_string()) {
                    map.insert(id.to_string(), b.clone());
                }
            }
            res["marcadores_total"] = json!(ids.len());
            Value::Object(map)
        }
        None => markers.bboxes.clone(),
    };
    let layout_bboxes = &layout_bboxes_owned;

    res["estrategia"] = json!(det.strategy);
    res["marcadores"] = json!(det.found.len());
    res["espejado"] = json!(det.flipped);
    if det.flipped {
        if layout.get("espejado").and_then(|v| v.as_bool()).unwrap_or(true) {
            warn!("The scan arrived MIRRORED (film exposed flipped?); it was flipped back automatically before processing.");
        } else {
            warn!("Mirrored scan (unexpected: the negative was generated without mirroring); flipped back automatically.");
        }
    }
    if det.found.len() < 2.max(opts.min_markers) {
        fail!(
            "Only {} of {} markers were detected (minimum: {}). Check that the markers are not covered and that the whole sheet is inside the scan.",
            det.found.len(),
            expected.len(),
            opts.min_markers
        );
    }
    let polaridad = if det.inverted { "invertida_primero" } else { "ambas" };
    let det_mode = if det.escalated { "cianotipia".to_string() } else { mode.clone() };
    if det.inverted {
        warn!("Markers with INVERTED POLARITY (normal-mode sheet exposed as cyanotype?); they were detected in negative.");
    }

    // 2. Afinado a resolución completa.
    let mut refined = refine_corners_fullres(img, &det.found, dict, &det_mode, polaridad);

    // 3. Escala medida.
    let mut s = match estimate_scale(&refined, layout_bboxes) {
        Some(s) if (0.2..=12.0).contains(&s) => s,
        other => fail!("Could not estimate the scan scale (s={:?}).", other),
    };
    let diag = ((page_w * s).powi(2) + (page_h * s).powi(2)).sqrt();
    let thresh = (0.001 * diag).max(8.0);

    // 3b. Recuperación guiada.
    let extra = recover_missing_markers(img, &refined, layout_bboxes, s, dict, &det_mode, thresh, polaridad);
    if !extra.is_empty() {
        let mut ids: Vec<u32> = extra.keys().cloned().collect();
        ids.sort();
        warn!("Recovered {} marker(s) in the guided second pass ({:?}).", extra.len(), ids);
        refined.extend(extra);
        res["marcadores"] = json!(refined.len());
        if let Some(s2) = estimate_scale(&refined, layout_bboxes) {
            if (0.2..=12.0).contains(&s2) {
                s = s2;
            }
        }
    }
    res["escala"] = json!((s * 10000.0).round() / 10000.0);

    // 4. Homografía RANSAC con todas las esquinas.
    let (src, dst) = correspondences(&refined, layout_bboxes, s);
    if src.is_empty() {
        fail!("No detected marker exists in the layout.");
    }
    // advertencia de dispersión
    {
        let x1 = dst.iter().map(|p| p.0).fold(f64::MAX, f64::min);
        let x2 = dst.iter().map(|p| p.0).fold(f64::MIN, f64::max);
        let y1 = dst.iter().map(|p| p.1).fold(f64::MAX, f64::min);
        let y2 = dst.iter().map(|p| p.1).fold(f64::MIN, f64::max);
        let cover = ((x2 - x1) * (y2 - y1)) / (page_w * s * page_h * s).max(1.0);
        if cover < 0.25 {
            warn!("The detected markers cover little of the sheet; alignment may lose precision near the far edges.");
        }
    }
    let (mut m, mask) = match find_homography_ransac(&src, &dst, thresh) {
        Some(r) => r,
        None => fail!("Could not compute the homography (degenerate markers)."),
    };
    let inliers = mask.iter().filter(|&&b| b).count();
    if inliers < 8 {
        warn!("Few consistent points in the alignment ({inliers}).");
    }

    // 4b. Control de precisión por residuos.
    let px_mm = px_per_mm(layout, s);
    let (_, _, resid) = residual_field(&m, &refined, layout_bboxes, s);
    if !resid.is_empty() {
        let mut vals: Vec<f64> = resid.values().cloned().collect();
        vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let med = vals[vals.len() / 2];
        let lim = (RESIDUAL_OUTLIER_MM * px_mm).max(3.0 * med);
        let mut malos: Vec<u32> = resid.iter().filter(|(_, &r)| r > lim).map(|(&i, _)| i).collect();
        malos.sort();
        if !malos.is_empty() && refined.len() - malos.len() >= 3.max(opts.min_markers) {
            for mid in &malos {
                refined.remove(mid);
            }
            res["marcadores"] = json!(refined.len());
            warn!("Marker(s) {:?} discarded due to inconsistent residual (> {:.1} mm).", malos, lim / px_mm);
            let (src2, dst2) = correspondences(&refined, layout_bboxes, s);
            if let Some((m2, _)) = find_homography_ransac(&src2, &dst2, thresh) {
                m = m2;
            }
        }
        let (_, _, resid2) = residual_field(&m, &refined, layout_bboxes, s);
        if !resid2.is_empty() {
            let mut v2: Vec<f64> = resid2.values().cloned().collect();
            v2.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let residual_mm = (v2[v2.len() / 2] / px_mm * 1000.0).round() / 1000.0;
            res["residual_mm"] = json!(residual_mm);
            if residual_mm > RESIDUAL_WARN_MM {
                warn!("Imprecise alignment (residual ±{residual_mm:.1} mm): the paper probably warped when wet. Crops are corrected locally using nearby markers.");
            }
        }
    }

    // 4c. Corrector local.
    let local = if opts.fine_align {
        make_local_shift(&m, &refined, layout_bboxes, s, px_mm)
    } else {
        None
    };

    // 5. Dimensiones del enderezado.
    let out_w = (page_w * s).round() as usize;
    let out_h = (page_h * s).round() as usize;
    if out_w == 0 || out_h == 0 || out_w * out_h > MAX_IMAGE_PIXELS {
        fail!("The requested rectification is disproportionate ({out_w}×{out_h} px); check the layout.");
    }
    Ok(DetectData { m, s, flipped: det.flipped, out_w, out_h, refined, local })
}

/// Entrada mínima de la fase final (serializable a través del puente JS).
#[derive(Serialize, Deserialize)]
pub struct FinishInput {
    pub s: f64,
    pub refined_ids: HashSet<u32>,
    pub local: Option<LocalShift>,
}

/// Fase final sobre la hoja YA enderezada: normalización opcional,
/// identificación (IDs de marcador → QR → eliminación) y recortes.
pub fn finish_scan(
    mut warp: DynImg,
    scan_name: &str,
    layout: &Value,
    opts: &ScanOptions,
    claimed_sheets: &HashMap<i64, String>,
    markers: &LayoutMarkers,
    fin: FinishInput,
    mut res: Value,
) -> ScanOutput {
    let mut frames_out: Vec<(String, DynImg)> = Vec::new();
    let mut unidentified: Vec<(String, DynImg)> = Vec::new();
    let s = fin.s;
    let local = fin.local;

    macro_rules! warn {
        ($($arg:tt)*) => { warn_res!(res, $($arg)*) };
    }

    // 5b. Normalización con la tira de grises (opcional).
    if opts.normalize_patches {
        if let Some(patch_info) = layout.get("parche_grises").filter(|v| !v.is_null()) {
            if normalize_with_patches(&mut warp, patch_info, s, local.as_ref()) {
                warn!("Levels normalized with the patch strip.");
            }
        }
    }

    // 6. Identificación: primero por IDs de marcador (hojas sin QR), luego
    // por QR (proyectos con QR / legados), luego por eliminación.
    let mut hoja: Option<(&Value, String)> = None;
    if let Some(iph) = &markers.ids_por_hoja {
        hoja = identify_by_markers(layout, iph, &fin.refined_ids);
    }
    if hoja.is_none() {
        hoja = identify_sheet(&warp, layout, s, local.as_ref());
    }
    if hoja.is_none() {
        if let Some(hojas) = layout.get("hojas").and_then(|v| v.as_array()) {
            if hojas.len() == 1 {
                let numero = hojas[0].get("numero").and_then(|v| v.as_i64());
                let reclamada = numero.and_then(|n| claimed_sheets.get(&n));
                match reclamada {
                    Some(otro) if otro != scan_name => {
                        warn!("No identity found and sheet {} was already claimed by '{}': this scan goes to 'unidentified' to avoid overwriting it.", numero.unwrap(), otro);
                    }
                    _ => {
                        hoja = Some((&hojas[0], "only sheet in the layout".into()));
                        warn!("No marker identity or readable QR: sheet identified by elimination (the layout has a single sheet). Verify in the report that this scan belongs to this project.");
                    }
                }
            }
        }
    }

    let plantilla: Option<&Value> = hoja.as_ref().map(|(h, _)| *h).or_else(|| {
        layout.get("hojas").and_then(|v| v.as_array()).and_then(|a| a.first())
    });

    // Miniatura de diagnóstico (antes de decidir el error, como la original).
    let overlay = build_overlay(&warp, s, &markers.bboxes, &fin.refined_ids, plantilla, local.as_ref());

    let (hoja, via) = match hoja {
        Some(hv) => hv,
        None => {
            warn!("Sheet not identified: crops saved as 'unidentified'.");
            if let Some(pl) = plantilla {
                if let Some(fs) = pl.get("frames").and_then(|v| v.as_object()) {
                    let mut items: Vec<(&String, &Value)> = fs.iter().collect();
                    items.sort_by_key(|(_, info)| info.get("celda").and_then(|c| c.as_i64()).unwrap_or(0));
                    for (i, (_lab, info)) in items.iter().enumerate() {
                        if let Some(b) = layoutfile::bbox_of(&info["bbox"]) {
                            if let Some(crop) = crop_frame(&warp, b, s, opts.bleed, local.as_ref()) {
                                let stem = scan_name.rsplit_once('.').map(|(a, _)| a).unwrap_or(scan_name);
                                unidentified.push((format!("{}_celda{}", stem, i + 1), crop));
                            }
                        }
                    }
                }
            }
            res["error"] = json!("The sheet could not be identified (no marker identity or readable QR).");
            return ScanOutput { result: res, frames: frames_out, unidentified, overlay };
        }
    };

    res["hoja_numero"] = hoja.get("numero").cloned().unwrap_or(Value::Null);
    res["archivo_hoja"] = hoja.get("archivo_hoja").cloned().unwrap_or(Value::Null);
    res["via"] = json!(via);

    // 7. Recortar cada fotograma.
    if let Some(fs) = hoja.get("frames").and_then(|v| v.as_object()) {
        for (etiqueta, info) in fs {
            let b = match layoutfile::bbox_of(&info["bbox"]) {
                Some(b) => b,
                None => continue,
            };
            let mut crop = match crop_frame(&warp, b, s, opts.bleed, local.as_ref()) {
                Some(c) => c,
                None => {
                    warn!("Empty crop for '{etiqueta}'.");
                    continue;
                }
            };
            if opts.resize_to_original {
                if let Some(op) = info.get("orig_px").and_then(|v| v.as_array()) {
                    if op.len() == 2 {
                        let ow = op[0].as_u64().unwrap_or(0) as usize;
                        let oh = op[1].as_u64().unwrap_or(0) as usize;
                        if ow > 0 && oh > 0 {
                            crop = crate::img::resize_dyn(&crop, ow, oh, crate::img::Filter::Lanczos3);
                        }
                    }
                }
            }
            frames_out.push((etiqueta.clone(), crop));
        }
    }
    res["ok"] = json!(!frames_out.is_empty());
    ScanOutput { result: res, frames: frames_out, unidentified, overlay }
}

/// Procesa UN escaneo contra un layout normalizado v2 (camino todo-en-WASM).
/// `claimed_sheets`: hojas ya identificadas en el lote (nº → escaneo).
pub fn process_scan(
    mut img: DynImg,
    scan_name: &str,
    layout: &Value,
    opts: &ScanOptions,
    claimed_sheets: &HashMap<i64, String>,
) -> ScanOutput {
    let markers = resolve_markers(layout);
    let mut res = base_report(scan_name);
    let det = match detect_scan(&mut img, layout, opts, &markers, &mut res) {
        Ok(d) => d,
        Err(()) => {
            return ScanOutput { result: res, frames: Vec::new(), unidentified: Vec::new(), overlay: None }
        }
    };
    let warp = crate::geometry::warp_perspective(&img, &det.m, det.out_w, det.out_h);
    drop(img);
    let fin = FinishInput {
        s: det.s,
        refined_ids: det.refined.keys().cloned().collect(),
        local: det.local,
    };
    finish_scan(warp, scan_name, layout, opts, claimed_sheets, &markers, fin, res)
}

fn normalize_with_patches(
    warp: &mut DynImg,
    patch_info: &Value,
    s: f64,
    local: Option<&LocalShift>,
) -> bool {
    let bboxes = match patch_info.get("bboxes").and_then(|v| v.as_array()) {
        Some(b) => b,
        None => return false,
    };
    let niveles: Vec<i64> = match patch_info.get("niveles").and_then(|v| v.as_array()) {
        Some(n) => n.iter().filter_map(|x| x.as_i64()).collect(),
        None => return false,
    };
    if niveles.is_empty() || bboxes.len() != niveles.len() {
        return false;
    }
    let i_black = niveles.iter().enumerate().min_by_key(|(_, &n)| n).unwrap().0;
    let i_white = niveles.iter().enumerate().max_by_key(|(_, &n)| n).unwrap().0;
    let maxv = match warp {
        DynImg::U8(_) => 255.0f64,
        DynImg::U16(_) => 65535.0,
    };
    let mean_of = |b: &Value| -> Option<[f64; 3]> {
        let bb = layoutfile::bbox_of(b)?;
        let crop = crop_frame(warp, bb, s, 0.25, local)?;
        let mut acc = [0.0f64; 3];
        let mut n = 0.0;
        match &crop {
            DynImg::U8(i) => {
                for p in i.data.chunks_exact(3) {
                    for c in 0..3 {
                        acc[c] += p[c] as f64;
                    }
                    n += 1.0;
                }
            }
            DynImg::U16(i) => {
                for p in i.data.chunks_exact(3) {
                    for c in 0..3 {
                        acc[c] += p[c] as f64;
                    }
                    n += 1.0;
                }
            }
        }
        if n == 0.0 {
            return None;
        }
        Some([acc[0] / n, acc[1] / n, acc[2] / n])
    };
    let black = match mean_of(&bboxes[i_black]) {
        Some(b) => b,
        None => return false,
    };
    let white = match mean_of(&bboxes[i_white]) {
        Some(w) => w,
        None => return false,
    };
    let black_t = maxv * (*niveles.iter().min().unwrap() as f64 / 255.0);
    let white_t = maxv * (*niveles.iter().max().unwrap() as f64 / 255.0);
    for c in 0..3 {
        if white[c] - black[c] < maxv * 0.05 {
            return false; // parches ilegibles
        }
    }
    match warp {
        DynImg::U8(i) => {
            for p in i.data.chunks_exact_mut(3) {
                for c in 0..3 {
                    let v = (p[c] as f64 - black[c]) * ((white_t - black_t) / (white[c] - black[c])) + black_t;
                    p[c] = v.round().clamp(0.0, 255.0) as u8;
                }
            }
        }
        DynImg::U16(i) => {
            for p in i.data.chunks_exact_mut(3) {
                for c in 0..3 {
                    let v = (p[c] as f64 - black[c]) * ((white_t - black_t) / (white[c] - black[c])) + black_t;
                    p[c] = v.round().clamp(0.0, 65535.0) as u16;
                }
            }
        }
    }
    true
}

/// Miniatura de diagnóstico: verde = marcador detectado, rojo = perdido,
/// azul = frames, naranja = QRs (misma convención que el informe original).
fn build_overlay(
    warp: &DynImg,
    s: f64,
    layout_bboxes: &Value,
    refined_ids: &HashSet<u32>,
    plantilla: Option<&Value>,
    local: Option<&LocalShift>,
) -> Option<Rgb> {
    let (w, h) = warp.size();
    let k = (1600.0 / w.max(h) as f64).min(1.0);
    let (mini, _f) = warp.proxy_rgb8((w.max(h) as f64 * k) as usize);
    let mut mini = mini;
    let t = 2i64;
    let mut rect = |bbox: [f64; 4], color: [u8; 3], thick: i64, shift: bool| {
        let mut b = [bbox[0] * s, bbox[1] * s, bbox[2] * s, bbox[3] * s];
        if shift {
            if let Some(ls) = local {
                let (dx, dy) = ls.shift(b);
                b[0] += dx;
                b[2] += dx;
                b[1] += dy;
                b[3] += dy;
            }
        }
        let kk = mini.w as f64 / w as f64;
        mini.stroke_rect(
            (b[0] * kk) as i64,
            (b[1] * kk) as i64,
            (b[2] * kk) as i64,
            (b[3] * kk) as i64,
            thick,
            color,
        );
    };
    if let Some(obj) = layout_bboxes.as_object() {
        for (mid, bb) in obj {
            if let Some(b) = layoutfile::bbox_of(bb) {
                let ok = mid.parse::<u32>().ok().map_or(false, |id| refined_ids.contains(&id));
                rect(b, if ok { [0, 200, 0] } else { [230, 0, 0] }, if ok { t } else { t * 2 }, false);
            }
        }
    }
    if let Some(pl) = plantilla {
        if let Some(fs) = pl.get("frames").and_then(|v| v.as_object()) {
            for (_, info) in fs {
                if let Some(b) = layoutfile::bbox_of(&info["bbox"]) {
                    rect(b, [0, 140, 255], t, true);
                }
            }
        }
        if let Some(qs) = pl.get("qrs").and_then(|v| v.as_object()) {
            for (_, info) in qs {
                if let Some(b) = layoutfile::bbox_of(&info["bbox"]) {
                    rect(b, [255, 165, 0], t, true);
                }
            }
        }
    }
    Some(mini)
}
