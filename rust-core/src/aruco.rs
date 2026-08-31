//! Marcadores ArUco: generación y detección (port funcional del detector de
//! OpenCV usado por la app original, con los mismos diccionarios bit a bit).

use crate::aruco_dicts as dicts;
use crate::geometry::{find_homography_dlt, Pt};
use crate::img::Gray;
use crate::imgproc::{
    adaptive_threshold_inv, approx_poly, find_contours, is_convex, polygon_area,
};
use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Dict {
    Dict4x4_50,
    Dict4x4_100,
    Dict5x5_100,
}

impl Dict {
    pub fn from_name(name: &str) -> Dict {
        match name {
            "DICT_4X4_100" => Dict::Dict4x4_100,
            "DICT_5X5_100" => Dict::Dict5x5_100,
            _ => Dict::Dict4x4_50,
        }
    }
    pub fn n(&self) -> usize {
        match self {
            Dict::Dict4x4_50 | Dict::Dict4x4_100 => dicts::_4X4_50_N,
            Dict::Dict5x5_100 => dicts::_5X5_100_N,
        }
    }
    pub fn markers(&self) -> &'static [u32] {
        match self {
            Dict::Dict4x4_50 => &dicts::_4X4_50,
            Dict::Dict4x4_100 => &dicts::_4X4_100,
            Dict::Dict5x5_100 => &dicts::_5X5_100,
        }
    }
    pub fn size(&self) -> usize {
        self.markers().len()
    }
    pub fn max_correction(&self) -> u32 {
        match self {
            Dict::Dict4x4_50 => dicts::_4X4_50_MAXCORR,
            Dict::Dict4x4_100 => dicts::_4X4_100_MAXCORR,
            Dict::Dict5x5_100 => dicts::_5X5_100_MAXCORR,
        }
    }
}

/// Bits del marcador `id` como matriz n×n (fila mayor, bit MSB primero).
pub fn marker_bits(dict: Dict, id: usize) -> Vec<u8> {
    let n = dict.n();
    let word = dict.markers()[id];
    let total = n * n;
    (0..total).map(|i| ((word >> (total - 1 - i)) & 1) as u8).collect()
}

fn rotate_bits(bits: &[u8], n: usize) -> Vec<u8> {
    // rotación 90° horaria: out[r][c] = in[n-1-c][r]
    let mut out = vec![0u8; n * n];
    for r in 0..n {
        for c in 0..n {
            out[r * n + c] = bits[(n - 1 - c) * n + r];
        }
    }
    out
}

fn hamming(a: &[u8], b: &[u8]) -> u32 {
    a.iter().zip(b).map(|(&x, &y)| (x ^ y) as u32).sum()
}

/// Genera la imagen del marcador (como cv2.aruco.generateImageMarker):
/// borde de 1 módulo negro + n×n bits; blanco = 255.
pub fn generate_marker(dict: Dict, id: usize, size_px: usize) -> Gray {
    let n = dict.n();
    let modules = n + 2;
    let bits = marker_bits(dict, id);
    let mut out = Gray::new(size_px, size_px, 0);
    for y in 0..size_px {
        let my = y * modules / size_px;
        for x in 0..size_px {
            let mx = x * modules / size_px;
            let v = if my == 0 || mx == 0 || my == modules - 1 || mx == modules - 1 {
                0
            } else {
                let bit = bits[(my - 1) * n + (mx - 1)];
                if bit == 1 { 255 } else { 0 }
            };
            out.data[y * size_px + x] = v;
        }
    }
    out
}

// ────────────────────────────────────────────────────────────────
// Detección
// ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
pub struct DetectorParams {
    pub adaptive_windows: &'static [usize],
    pub adaptive_c: f32,
    pub min_perimeter_rate: f32,
    pub approx_accuracy_rate: f32,
    pub error_correction_rate: f32,
    pub max_bad_border_rate: f32,
}

pub const PARAMS_NORMAL: DetectorParams = DetectorParams {
    adaptive_windows: &[9, 23],
    adaptive_c: 7.0,
    min_perimeter_rate: 0.03,
    approx_accuracy_rate: 0.035,
    error_correction_rate: 0.6,
    max_bad_border_rate: 0.35,
};

/// La química come bits y difumina bordes; iluminación desigual.
pub const PARAMS_CYANO: DetectorParams = DetectorParams {
    adaptive_windows: &[15, 31, 45],
    adaptive_c: 7.0,
    min_perimeter_rate: 0.015,
    approx_accuracy_rate: 0.06,
    error_correction_rate: 0.8,
    max_bad_border_rate: 0.45,
};

pub fn params_for_mode(mode: &str) -> DetectorParams {
    if crate::scanproc::is_cyan_mode(mode) {
        PARAMS_CYANO
    } else {
        PARAMS_NORMAL
    }
}

#[derive(Clone, Debug)]
pub struct Detection {
    pub id: usize,
    /// Esquinas TL, TR, BR, BL en la orientación canónica del marcador.
    pub corners: [Pt; 4],
}

#[inline]
fn bilinear(gray: &Gray, x: f64, y: f64) -> f64 {
    let xi = x.floor();
    let yi = y.floor();
    let fx = x - xi;
    let fy = y - yi;
    let cl = |v: f64, n: usize| (v.max(0.0) as usize).min(n - 1);
    let x0 = cl(xi, gray.w);
    let x1 = cl(xi + 1.0, gray.w);
    let y0 = cl(yi, gray.h);
    let y1 = cl(yi + 1.0, gray.h);
    let p00 = gray.at(x0, y0) as f64;
    let p01 = gray.at(x1, y0) as f64;
    let p10 = gray.at(x0, y1) as f64;
    let p11 = gray.at(x1, y1) as f64;
    p00 * (1.0 - fx) * (1.0 - fy) + p01 * fx * (1.0 - fy) + p10 * (1.0 - fx) * fy + p11 * fx * fy
}

/// Muestrea la rejilla (n+2)×(n+2) del candidato y devuelve la media de cada
/// celda (interior central del 60 %).
fn sample_cells(gray: &Gray, quad: &[Pt; 4], modules: usize) -> Vec<f64> {
    let s = modules as f64;
    let dst = [(0.0, 0.0), (s, 0.0), (s, s), (0.0, s)];
    let h = match find_homography_dlt(&dst, &quad[..]) {
        Some(h) => h,
        None => return vec![],
    };
    let mut means = Vec::with_capacity(modules * modules);
    let k = 4; // 4×4 muestras por celda
    for row in 0..modules {
        for col in 0..modules {
            let mut acc = 0.0;
            for j in 0..k {
                for i in 0..k {
                    let u = col as f64 + 0.2 + 0.6 * (i as f64 + 0.5) / k as f64;
                    let v = row as f64 + 0.2 + 0.6 * (j as f64 + 0.5) / k as f64;
                    let p = crate::geometry::apply_h(&h, (u, v));
                    acc += bilinear(gray, p.0, p.1);
                }
            }
            means.push(acc / (k * k) as f64);
        }
    }
    means
}

/// Bits de corrección admitidos al comparar contra el diccionario. La tasa es
/// una fracción de la capacidad del diccionario, pero truncarla dejaba
/// `allowed` en 0 en los 4x4 (`max_correction() == 1`) con cualquier tasa
/// menor que 1: los diccionarios con menos redundancia, que además son los que
/// se imprimen más pequeños, se quedaban sin corrección. Una tasa positiva
/// vale siempre al menos un bit; el tope sigue siendo `max_correction()`, que
/// es el radio dentro del cual la coincidencia con el diccionario es única.
/// Una tasa de 0.0 sigue significando "sin corrección".
fn allowed_correction(dict: Dict, rate: f32) -> u32 {
    let cap = dict.max_correction();
    if cap == 0 || !rate.is_finite() || rate <= 0.0 {
        return 0;
    }
    ((rate * cap as f32).floor() as u32).clamp(1, cap)
}

/// Identifica un candidato: devuelve (id, rotación) si coincide con el
/// diccionario dentro de la corrección permitida.
fn identify(cells: &[f64], dict: Dict, params: &DetectorParams) -> Option<(usize, usize)> {
    let n = dict.n();
    let modules = n + 2;
    if cells.len() != modules * modules {
        return None;
    }
    // Umbral Otsu sobre las medias de celda (equivale al Otsu del warp).
    let mut mini = f64::MAX;
    let mut maxi = f64::MIN;
    for &c in cells {
        mini = mini.min(c);
        maxi = maxi.max(c);
    }
    if maxi - mini < 12.0 {
        return None; // sin contraste: no es un marcador
    }
    let thr = (mini + maxi) / 2.0;
    let bin: Vec<u8> = cells.iter().map(|&c| if c > thr { 1 } else { 0 }).collect();
    // borde mayormente negro
    let mut bad_border = 0usize;
    let border_total = modules * modules - n * n;
    for r in 0..modules {
        for c in 0..modules {
            if r == 0 || c == 0 || r == modules - 1 || c == modules - 1 {
                if bin[r * modules + c] == 1 {
                    bad_border += 1;
                }
            }
        }
    }
    if bad_border as f32 > params.max_bad_border_rate * border_total as f32 {
        return None;
    }
    // bits interiores
    let mut bits = vec![0u8; n * n];
    for r in 0..n {
        for c in 0..n {
            bits[r * n + c] = bin[(r + 1) * modules + (c + 1)];
        }
    }
    let allowed = allowed_correction(dict, params.error_correction_rate);
    let mut best: Option<(usize, usize, u32)> = None;
    let mut rot_bits = bits.clone();
    for rot in 0..4 {
        for (id, _) in dict.markers().iter().enumerate() {
            let mb = marker_bits(dict, id);
            let d = hamming(&rot_bits, &mb);
            if d <= allowed && best.map_or(true, |b| d < b.2) {
                best = Some((id, rot, d));
            }
        }
        if rot < 3 {
            rot_bits = rotate_bits(&rot_bits, n);
        }
    }
    best.map(|(id, rot, _)| (id, rot))
}

/// Refinamiento subpíxel de una esquina (algoritmo de cornerSubPix).
fn refine_corner(gray: &Gray, c: Pt, win: i64) -> Pt {
    let mut cur = c;
    for _ in 0..12 {
        let (mut a11, mut a12, mut a22) = (0.0f64, 0.0, 0.0);
        let (mut b1, mut b2) = (0.0f64, 0.0);
        for dy in -win..=win {
            for dx in -win..=win {
                let x = cur.0 + dx as f64;
                let y = cur.1 + dy as f64;
                if x < 1.0 || y < 1.0 || x >= (gray.w - 2) as f64 || y >= (gray.h - 2) as f64 {
                    continue;
                }
                let gx = (bilinear(gray, x + 1.0, y) - bilinear(gray, x - 1.0, y)) / 2.0;
                let gy = (bilinear(gray, x, y + 1.0) - bilinear(gray, x, y - 1.0)) / 2.0;
                // peso gaussiano
                let r2 = (dx * dx + dy * dy) as f64;
                let wgt = (-r2 / (2.0 * (win as f64 / 2.0).powi(2).max(1.0))).exp();
                let gxx = gx * gx * wgt;
                let gxy = gx * gy * wgt;
                let gyy = gy * gy * wgt;
                a11 += gxx;
                a12 += gxy;
                a22 += gyy;
                b1 += gxx * x + gxy * y;
                b2 += gxy * x + gyy * y;
            }
        }
        let det = a11 * a22 - a12 * a12;
        if det.abs() < 1e-9 {
            break;
        }
        let nx = (a22 * b1 - a12 * b2) / det;
        let ny = (a11 * b2 - a12 * b1) / det;
        let dx = nx - cur.0;
        let dy = ny - cur.1;
        // paso acotado: el sistema puede dispararse en zonas planas
        if dx.abs() > win as f64 || dy.abs() > win as f64 {
            break;
        }
        cur = (nx, ny);
        if dx * dx + dy * dy < 0.0004 {
            break;
        }
    }
    cur
}

/// Detecta marcadores en una imagen de grises.
/// Equivalente a ArucoDetector.detectMarkers: devuelve todas las detecciones
/// (una por id como mucho; se queda la primera).
pub fn detect_markers(gray: &Gray, dict: Dict, params: &DetectorParams) -> Vec<Detection> {
    let mut found: HashMap<usize, Detection> = HashMap::new();
    let max_dim = gray.w.max(gray.h) as f32;
    let min_perimeter = params.min_perimeter_rate * max_dim;
    let n = dict.n();
    let modules = n + 2;

    for &win in params.adaptive_windows {
        let bin = adaptive_threshold_inv(gray, win, params.adaptive_c);
        let contours = find_contours(&bin);
        for contour in &contours {
            let perim: f32 = contour
                .windows(2)
                .map(|p| ((p[1].0 - p[0].0).powi(2) + (p[1].1 - p[0].1).powi(2)).sqrt())
                .sum();
            if perim < min_perimeter || contour.len() < 8 {
                continue;
            }
            let poly = approx_poly(contour, params.approx_accuracy_rate * perim);
            if poly.len() != 4 || !is_convex(&poly) {
                continue;
            }
            let area = polygon_area(&poly).abs();
            if area < 30.0 {
                continue;
            }
            // lados no degenerados
            let mut min_side = f32::MAX;
            for i in 0..4 {
                let j = (i + 1) % 4;
                let d = ((poly[j].0 - poly[i].0).powi(2) + (poly[j].1 - poly[i].1).powi(2)).sqrt();
                min_side = min_side.min(d);
            }
            if min_side < 5.0 {
                continue;
            }
            // orden horario (área positiva con y hacia abajo = horario)
            let mut quad: Vec<Pt> = poly.iter().map(|&(x, y)| (x as f64, y as f64)).collect();
            if polygon_area(&poly) < 0.0 {
                quad.reverse();
            }
            let mut q = [quad[0], quad[1], quad[2], quad[3]];
            let cells = sample_cells(gray, &q, modules);
            if cells.is_empty() {
                continue;
            }
            if let Some((id, rot)) = identify(&cells, dict, params) {
                if found.contains_key(&id) {
                    continue;
                }
                // rotar esquinas para que q[0] sea la TL canónica: si los
                // bits necesitaron `rot` rotaciones horarias para coincidir,
                // la TL canónica está `rot` posiciones hacia atrás.
                q.rotate_right(rot);
                // refinamiento subpíxel
                let side = (polygon_area(&poly).abs()).sqrt() as i64;
                let win_r = (side / 8).clamp(2, 7);
                let refined = [
                    refine_corner(gray, q[0], win_r),
                    refine_corner(gray, q[1], win_r),
                    refine_corner(gray, q[2], win_r),
                    refine_corner(gray, q[3], win_r),
                ];
                found.insert(id, Detection { id, corners: refined });
            }
        }
    }
    found.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::apply_h;
    use crate::img::Gray;

    /// Invierte un módulo interior del marcador ya rasterizado (size_px debe
    /// ser múltiplo de n+2 para que el módulo caiga en píxeles exactos).
    fn flip_module(m: &mut Gray, n: usize, row: usize, col: usize) {
        let cell = m.w / (n + 2);
        let (x0, y0) = ((col + 1) * cell, (row + 1) * cell);
        for y in y0..y0 + cell {
            for x in x0..x0 + cell {
                m.data[y * m.w + x] = 255 - m.data[y * m.w + x];
            }
        }
    }

    /// Distancia de Hamming mínima del diccionario contando las 4 rotaciones
    /// (también las de un marcador consigo mismo): es lo que acota cuántos
    /// bits se pueden corregir sin que dos IDs distintos encajen a la vez.
    fn min_inter_marker_distance(dict: Dict) -> u32 {
        let n = dict.n();
        let size = dict.size();
        let mut min_d = u32::MAX;
        for a in 0..size {
            let ba = marker_bits(dict, a);
            for b in 0..size {
                let mut rot = marker_bits(dict, b);
                for r in 0..4 {
                    if a != b || r != 0 {
                        min_d = min_d.min(hamming(&ba, &rot));
                    }
                    rot = rotate_bits(&rot, n);
                }
            }
        }
        min_d
    }

    #[test]
    fn correction_is_enabled_and_stays_unambiguous() {
        for dict in [Dict::Dict4x4_50, Dict::Dict4x4_100, Dict::Dict5x5_100] {
            let tau = min_inter_marker_distance(dict);
            let cap = dict.max_correction();
            // El propio tope del diccionario tiene que ser decodificación única.
            assert!(2 * cap < tau, "{dict:?}: cap={cap} tau={tau}");
            for (nombre, params) in [("normal", PARAMS_NORMAL), ("cyano", PARAMS_CYANO)] {
                let allowed = allowed_correction(dict, params.error_correction_rate);
                assert!(allowed >= 1, "{dict:?}/{nombre}: corrección desactivada");
                assert!(allowed <= cap, "{dict:?}/{nombre}: allowed={allowed} > cap={cap}");
                assert!(2 * allowed < tau, "{dict:?}/{nombre}: allowed={allowed} tau={tau}");
            }
            // Sin corrección pedida, sin corrección aplicada.
            assert_eq!(allowed_correction(dict, 0.0), 0);
            assert_eq!(allowed_correction(dict, -1.0), 0);
            assert_eq!(allowed_correction(dict, f32::NAN), 0);
            // Una tasa disparatada no puede pasar del radio del diccionario.
            assert_eq!(allowed_correction(dict, 99.0), cap);
        }
    }

    #[test]
    fn detects_4x4_marker_with_one_flipped_bit() {
        // Un bit comido por la pintura o la química. Los 4x4 corrigen uno, que
        // es justo lo que la tasa por defecto desactivaba.
        for id in [0usize, 7, 23, 41] {
            let mut m = generate_marker(Dict::Dict4x4_50, id, 120);
            flip_module(&mut m, 4, 1, 2);
            let mut canvas = Gray::new(400, 400, 255);
            place_marker(&mut canvas, &m, 140, 140);
            let dets = detect_markers(&canvas, Dict::Dict4x4_50, &PARAMS_NORMAL);
            let ids: Vec<usize> = dets.iter().map(|d| d.id).collect();
            assert_eq!(ids, vec![id], "id {id} con un bit invertido");
        }
    }

    fn place_marker(canvas: &mut Gray, m: &Gray, x: usize, y: usize) {
        for j in 0..m.h {
            for i in 0..m.w {
                canvas.data[(y + j) * canvas.w + (x + i)] = m.data[j * m.w + i];
            }
        }
    }

    #[test]
    fn generate_and_detect_roundtrip() {
        let mut canvas = Gray::new(800, 600, 255);
        let ids = [0usize, 3, 7, 11];
        let pos = [(60, 60), (600, 70), (610, 420), (70, 430)];
        for (&id, &(x, y)) in ids.iter().zip(&pos) {
            let m = generate_marker(Dict::Dict4x4_50, id, 100);
            place_marker(&mut canvas, &m, x, y);
        }
        let dets = detect_markers(&canvas, Dict::Dict4x4_50, &PARAMS_NORMAL);
        let mut found: Vec<usize> = dets.iter().map(|d| d.id).collect();
        found.sort();
        assert_eq!(found, vec![0, 3, 7, 11]);
        // esquinas del id 0 cerca de (60,60)-(160,160), con TL primero
        let d0 = dets.iter().find(|d| d.id == 0).unwrap();
        assert!((d0.corners[0].0 - 60.0).abs() < 3.0, "{:?}", d0.corners);
        assert!((d0.corners[0].1 - 60.0).abs() < 3.0);
        assert!((d0.corners[2].0 - 160.0).abs() < 3.0);
    }

    #[test]
    fn detect_rotated_marker_keeps_canonical_order() {
        // marcador girado 90°: las esquinas deben volver en orden canónico
        let m = generate_marker(Dict::Dict4x4_50, 5, 120);
        // rotar la imagen 90° horario
        let mut rot = Gray::new(m.h, m.w, 255);
        for y in 0..m.h {
            for x in 0..m.w {
                rot.data[x * rot.w + (rot.w - 1 - y)] = m.data[y * m.w + x];
            }
        }
        let mut canvas = Gray::new(400, 400, 255);
        place_marker(&mut canvas, &rot, 100, 100);
        let dets = detect_markers(&canvas, Dict::Dict4x4_50, &PARAMS_NORMAL);
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0].id, 5);
        // TL canónica del marcador girado 90° horario queda en la esquina TR de la imagen
        let c = dets[0].corners;
        assert!((c[0].0 - 220.0).abs() < 3.0 && (c[0].1 - 100.0).abs() < 3.0, "{:?}", c);
    }

    #[test]
    fn detect_under_perspective() {
        let mut canvas = Gray::new(700, 700, 255);
        let m = generate_marker(Dict::Dict4x4_50, 9, 140);
        place_marker(&mut canvas, &m, 260, 260);
        // warp suave de la imagen completa
        let ht = [1.05, 0.06, -20.0, 0.03, 0.98, 6.0, 0.00004, 0.00002, 1.0];
        let mut warped = Gray::new(700, 700, 255);
        let hinv = crate::geometry::invert_h(&ht).unwrap();
        for y in 0..700usize {
            for x in 0..700usize {
                let p = apply_h(&hinv, (x as f64, y as f64));
                if p.0 >= 0.0 && p.1 >= 0.0 && p.0 < 699.0 && p.1 < 699.0 {
                    warped.data[y * 700 + x] = bilinear(&canvas, p.0, p.1).round() as u8;
                }
            }
        }
        let dets = detect_markers(&warped, Dict::Dict4x4_50, &PARAMS_NORMAL);
        assert_eq!(dets.len(), 1);
        assert_eq!(dets[0].id, 9);
        // precisión: la esquina TL proyectada debe quedar a < 1.5 px
        let expect = apply_h(&ht, (260.0, 260.0));
        let got = dets[0].corners[0];
        let err = ((got.0 - expect.0).powi(2) + (got.1 - expect.1).powi(2)).sqrt();
        assert!(err < 1.5, "error de esquina: {:.2} px", err);
    }
}
