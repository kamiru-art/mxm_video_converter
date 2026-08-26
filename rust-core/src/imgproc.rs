//! Procesado de imagen: umbrales, CLAHE, aplanado de fondo, contornos.
//! Réplica funcional de las operaciones de OpenCV que usaba la app original.

use crate::img::{resize_gray, Filter, Gray};

// ────────────────────────────────────────────────────────────────
// Desenfoques (box blur iterado ≈ gaussiano; suficiente y rápido)
// ────────────────────────────────────────────────────────────────

/// Box blur separable con radio `r` (bordes extendidos), sobre f32.
fn box_blur_f32(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    if r == 0 {
        return src.to_vec();
    }
    let norm = 1.0 / (2 * r + 1) as f32;
    let ri = r as i64;
    let clampi = |v: i64, n: usize| v.clamp(0, n as i64 - 1) as usize;
    let mut tmp = vec![0.0f32; w * h];
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        // ventana deslizante con bordes extendidos
        let mut acc: f32 = 0.0;
        for i in -ri..=ri {
            acc += row[clampi(i, w)];
        }
        for x in 0..w {
            tmp[y * w + x] = acc * norm;
            let xi = x as i64;
            acc += row[clampi(xi + ri + 1, w)] - row[clampi(xi - ri, w)];
        }
    }
    let mut out = vec![0.0f32; w * h];
    for x in 0..w {
        let col = |y: usize| tmp[y * w + x];
        let mut acc: f32 = 0.0;
        for i in -ri..=ri {
            acc += col(clampi(i, h));
        }
        for y in 0..h {
            out[y * w + x] = acc * norm;
            let yi = y as i64;
            acc += col(clampi(yi + ri + 1, h)) - col(clampi(yi - ri, h));
        }
    }
    out
}

/// Desenfoque "gaussiano" aproximado con 3 pasadas de box blur.
pub fn gaussian_blur_f32(src: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    if sigma <= 0.0 {
        return src.to_vec();
    }
    // radio de box equivalente para 3 pasadas
    let r = (((3.0 * sigma * sigma) / 3.0).sqrt() * 1.5).round().max(1.0) as usize;
    let mut out = src.to_vec();
    for _ in 0..3 {
        out = box_blur_f32(&out, w, h, r);
    }
    out
}

pub fn gaussian_blur_gray(src: &Gray, sigma: f32) -> Gray {
    let f: Vec<f32> = src.data.iter().map(|&v| v as f32).collect();
    let out = gaussian_blur_f32(&f, src.w, src.h, sigma);
    Gray {
        w: src.w,
        h: src.h,
        data: out.iter().map(|&v| v.round().clamp(0.0, 255.0) as u8).collect(),
    }
}

// ────────────────────────────────────────────────────────────────
// Normalización y CLAHE
// ────────────────────────────────────────────────────────────────

pub fn normalize_minmax(src: &Gray) -> Gray {
    let (mut lo, mut hi) = (255u8, 0u8);
    for &v in &src.data {
        lo = lo.min(v);
        hi = hi.max(v);
    }
    if hi <= lo {
        return src.clone();
    }
    let scale = 255.0 / (hi - lo) as f32;
    Gray {
        w: src.w,
        h: src.h,
        data: src.data.iter().map(|&v| (((v - lo) as f32) * scale).round() as u8).collect(),
    }
}

/// CLAHE: ecualización adaptativa limitada (tiles 8×8, clip 3.0), con
/// interpolación bilineal entre las LUT de cada tile — como cv2.createCLAHE.
pub fn clahe(src: &Gray, clip_limit: f32, tiles: usize) -> Gray {
    let (w, h) = (src.w, src.h);
    if w < tiles || h < tiles {
        return src.clone();
    }
    let tw = (w + tiles - 1) / tiles;
    let th = (h + tiles - 1) / tiles;
    // LUT por tile
    let mut luts = vec![[0u8; 256]; tiles * tiles];
    for ty in 0..tiles {
        for tx in 0..tiles {
            let x1 = tx * tw;
            let y1 = ty * th;
            let x2 = ((tx + 1) * tw).min(w);
            let y2 = ((ty + 1) * th).min(h);
            let n = ((x2 - x1) * (y2 - y1)).max(1);
            let mut hist = [0u32; 256];
            for y in y1..y2 {
                for x in x1..x2 {
                    hist[src.at(x, y) as usize] += 1;
                }
            }
            // recorte del histograma y redistribución
            let clip = ((clip_limit * n as f32) / 256.0).max(1.0) as u32;
            let mut excess = 0u32;
            for hv in hist.iter_mut() {
                if *hv > clip {
                    excess += *hv - clip;
                    *hv = clip;
                }
            }
            let bonus = excess / 256;
            for hv in hist.iter_mut() {
                *hv += bonus;
            }
            let mut cdf = 0u32;
            let lut = &mut luts[ty * tiles + tx];
            for i in 0..256 {
                cdf += hist[i];
                lut[i] = ((cdf as f32 / n as f32) * 255.0).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    // interpolación bilineal entre tiles vecinos
    let mut out = vec![0u8; w * h];
    for y in 0..h {
        let fy = (y as f32 - th as f32 / 2.0) / th as f32;
        let ty0 = fy.floor().max(0.0) as usize;
        let ty1 = (ty0 + 1).min(tiles - 1);
        let ay = (fy - fy.floor()).clamp(0.0, 1.0);
        let ay = if fy < 0.0 { 0.0 } else { ay };
        for x in 0..w {
            let fx = (x as f32 - tw as f32 / 2.0) / tw as f32;
            let tx0 = fx.floor().max(0.0) as usize;
            let tx1 = (tx0 + 1).min(tiles - 1);
            let ax = (fx - fx.floor()).clamp(0.0, 1.0);
            let ax = if fx < 0.0 { 0.0 } else { ax };
            let v = src.at(x, y) as usize;
            let v00 = luts[ty0 * tiles + tx0][v] as f32;
            let v01 = luts[ty0 * tiles + tx1][v] as f32;
            let v10 = luts[ty1 * tiles + tx0][v] as f32;
            let v11 = luts[ty1 * tiles + tx1][v] as f32;
            let top = v00 * (1.0 - ax) + v01 * ax;
            let bot = v10 * (1.0 - ax) + v11 * ax;
            out[y * w + x] = (top * (1.0 - ay) + bot * ay).round() as u8;
        }
    }
    Gray { w, h, data: out }
}

/// Aplanado de fondo: divide el canal por una versión muy desenfocada de sí
/// mismo (estimada a escala reducida) y renormaliza. Neutraliza lavados y
/// exposiciones desiguales de la cianotipia.
pub fn flat_field(src: &Gray) -> Gray {
    let (w, h) = (src.w, src.h);
    let k = (w.min(h) / 256).max(1);
    let small = if k > 1 {
        resize_gray(src, (w / k).max(1), (h / k).max(1), Filter::Area)
    } else {
        src.clone()
    };
    let sigma = (small.w.min(small.h) as f32 / 16.0).max(3.0);
    let f: Vec<f32> = small.data.iter().map(|&v| v as f32).collect();
    let bg_small = gaussian_blur_f32(&f, small.w, small.h, sigma);
    let bg_gray = Gray {
        w: small.w,
        h: small.h,
        data: bg_small.iter().map(|&v| v.round().clamp(0.0, 255.0) as u8).collect(),
    };
    let bg = if k > 1 { resize_gray(&bg_gray, w, h, Filter::Triangle) } else { bg_gray };
    let mut out = vec![0u8; w * h];
    for i in 0..w * h {
        let b = (bg.data[i] as f32).max(1.0);
        out[i] = ((src.data[i] as f32 / b) * 128.0).round().clamp(0.0, 255.0) as u8;
    }
    normalize_minmax(&Gray { w, h, data: out })
}

// ────────────────────────────────────────────────────────────────
// Umbrales
// ────────────────────────────────────────────────────────────────

pub fn otsu_threshold(src: &Gray) -> u8 {
    let mut hist = [0u64; 256];
    for &v in &src.data {
        hist[v as usize] += 1;
    }
    let total: u64 = src.data.len() as u64;
    let sum_all: f64 = hist.iter().enumerate().map(|(i, &c)| i as f64 * c as f64).sum();
    let (mut sum_b, mut w_b) = (0.0f64, 0u64);
    let (mut best, mut best_t) = (0.0f64, 0u8);
    for t in 0..256 {
        w_b += hist[t];
        if w_b == 0 {
            continue;
        }
        let w_f = total - w_b;
        if w_f == 0 {
            break;
        }
        sum_b += t as f64 * hist[t] as f64;
        let m_b = sum_b / w_b as f64;
        let m_f = (sum_all - sum_b) / w_f as f64;
        let between = w_b as f64 * w_f as f64 * (m_b - m_f) * (m_b - m_f);
        if between > best {
            best = between;
            best_t = t as u8;
        }
    }
    best_t
}

pub fn threshold_binary(src: &Gray, t: u8) -> Gray {
    Gray {
        w: src.w,
        h: src.h,
        data: src.data.iter().map(|&v| if v > t { 255 } else { 0 }).collect(),
    }
}

/// Umbral adaptativo (media local - C), INVERTIDO como el de ArUco:
/// oscuro → 255 (los marcadores son oscuros sobre claro).
pub fn adaptive_threshold_inv(src: &Gray, win: usize, c: f32) -> Gray {
    let (w, h) = (src.w, src.h);
    let r = (win / 2).max(1);
    let f: Vec<f32> = src.data.iter().map(|&v| v as f32).collect();
    let mean = box_blur_f32(&f, w, h, r);
    let mut out = vec![0u8; w * h];
    for i in 0..w * h {
        out[i] = if (src.data[i] as f32) < mean[i] - c { 255 } else { 0 };
    }
    Gray { w, h, data: out }
}

// ────────────────────────────────────────────────────────────────
// Contornos (seguimiento de bordes sobre binaria) y aproximación poligonal
// ────────────────────────────────────────────────────────────────

/// Contornos EXTERNOS de las regiones blancas de una imagen binaria.
/// Seguimiento de borde estilo Moore, con mapa de visitados.
pub fn find_contours(bin: &Gray) -> Vec<Vec<(f32, f32)>> {
    let (w, h) = (bin.w, bin.h);
    let at = |x: i64, y: i64| -> bool {
        x >= 0 && y >= 0 && x < w as i64 && y < h as i64 && bin.data[y as usize * w + x as usize] > 0
    };
    let mut visited = vec![false; w * h];
    let mut contours = Vec::new();
    // vecinos en orden horario empezando por la izquierda
    const NB: [(i64, i64); 8] = [(-1, 0), (-1, -1), (0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1)];
    for y in 0..h as i64 {
        for x in 0..w as i64 {
            let idx = y as usize * w + x as usize;
            if !at(x, y) || visited[idx] {
                continue;
            }
            // borde: el píxel a la izquierda es fondo
            if at(x - 1, y) {
                // interior de una fila ya recorrida: marcar y seguir
                continue;
            }
            // seguimiento de Moore desde (x, y)
            let start = (x, y);
            let mut contour = Vec::new();
            let mut cur = start;
            let mut backtrack = 0usize; // índice del vecino desde el que llegamos
            loop {
                visited[cur.1 as usize * w + cur.0 as usize] = true;
                contour.push((cur.0 as f32, cur.1 as f32));
                let mut found = false;
                for k in 0..8 {
                    let dir = (backtrack + 1 + k) % 8;
                    let nx = cur.0 + NB[dir].0;
                    let ny = cur.1 + NB[dir].1;
                    if at(nx, ny) {
                        // nuevo backtrack: dirección opuesta al movimiento
                        backtrack = (dir + 4) % 8;
                        cur = (nx, ny);
                        found = true;
                        break;
                    }
                }
                if !found {
                    break; // píxel aislado
                }
                if cur == start && contour.len() > 2 {
                    break;
                }
                if contour.len() > 4 * (w + h) {
                    break; // cinturón de seguridad
                }
            }
            if contour.len() >= 4 {
                contours.push(contour);
            }
        }
    }
    contours
}

/// Aproximación de Douglas-Peucker sobre un contorno CERRADO.
pub fn approx_poly(contour: &[(f32, f32)], epsilon: f32) -> Vec<(f32, f32)> {
    if contour.len() < 3 {
        return contour.to_vec();
    }
    // Para curva cerrada: partir por los dos puntos más alejados entre sí
    // (aproximación: el más lejano del primero, y el más lejano de ese).
    let d2 = |a: (f32, f32), b: (f32, f32)| {
        let (dx, dy) = (a.0 - b.0, a.1 - b.1);
        dx * dx + dy * dy
    };
    let mut i0 = 0usize;
    let mut best = 0.0;
    for (i, &p) in contour.iter().enumerate() {
        let d = d2(contour[0], p);
        if d > best {
            best = d;
            i0 = i;
        }
    }
    let mut i1 = 0usize;
    best = 0.0;
    for (i, &p) in contour.iter().enumerate() {
        let d = d2(contour[i0], p);
        if d > best {
            best = d;
            i1 = i;
        }
    }
    let (a, b) = (i0.min(i1), i0.max(i1));
    let seg1: Vec<(f32, f32)> = contour[a..=b].to_vec();
    let mut seg2: Vec<(f32, f32)> = contour[b..].to_vec();
    seg2.extend_from_slice(&contour[..=a]);
    let mut out = dp(&seg1, epsilon);
    let part2 = dp(&seg2, epsilon);
    out.pop();
    out.extend(part2);
    out.pop();
    out
}

fn dp(points: &[(f32, f32)], epsilon: f32) -> Vec<(f32, f32)> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let (a, b) = (points[0], points[points.len() - 1]);
    let (abx, aby) = (b.0 - a.0, b.1 - a.1);
    let ab_len = (abx * abx + aby * aby).sqrt().max(1e-9);
    let mut max_d = 0.0;
    let mut idx = 0;
    for (i, &p) in points.iter().enumerate().skip(1).take(points.len() - 2) {
        let d = ((p.0 - a.0) * aby - (p.1 - a.1) * abx).abs() / ab_len;
        if d > max_d {
            max_d = d;
            idx = i;
        }
    }
    if max_d > epsilon {
        let mut left = dp(&points[..=idx], epsilon);
        let right = dp(&points[idx..], epsilon);
        left.pop();
        left.extend(right);
        left
    } else {
        vec![a, b]
    }
}

pub fn polygon_area(p: &[(f32, f32)]) -> f32 {
    let n = p.len();
    let mut s = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        s += p[i].0 * p[j].1 - p[j].0 * p[i].1;
    }
    s / 2.0
}

pub fn is_convex(p: &[(f32, f32)]) -> bool {
    let n = p.len();
    if n < 4 {
        return true;
    }
    let mut sign = 0.0f32;
    for i in 0..n {
        let a = p[i];
        let b = p[(i + 1) % n];
        let c = p[(i + 2) % n];
        let cross = (b.0 - a.0) * (c.1 - b.1) - (b.1 - a.1) * (c.0 - b.0);
        if cross.abs() > 1e-6 {
            if sign == 0.0 {
                sign = cross;
            } else if sign * cross < 0.0 {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn otsu_bimodal() {
        let mut g = Gray::new(10, 10, 20);
        for i in 50..100 {
            g.data[i] = 220;
        }
        let t = otsu_threshold(&g);
        assert!(t >= 20 && t < 220);
    }

    #[test]
    fn contours_find_square() {
        let mut g = Gray::new(40, 40, 0);
        for y in 10..30 {
            for x in 10..30 {
                g.data[y * 40 + x] = 255;
            }
        }
        let cs = find_contours(&g);
        assert_eq!(cs.len(), 1);
        let poly = approx_poly(&cs[0], 2.0);
        assert!(poly.len() >= 4 && poly.len() <= 6, "poly={:?}", poly);
    }
}
