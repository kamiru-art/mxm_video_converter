//! Homografías: estimación DLT normalizada, RANSAC y warp de perspectiva.

use crate::img::{DynImg, Rgb, Rgb16};

pub type Pt = (f64, f64);

/// Matriz 3×3 en orden de filas.
pub type H3 = [f64; 9];

pub fn apply_h(h: &H3, p: Pt) -> Pt {
    let d = h[6] * p.0 + h[7] * p.1 + h[8];
    let d = if d.abs() < 1e-12 { 1e-12 } else { d };
    (
        (h[0] * p.0 + h[1] * p.1 + h[2]) / d,
        (h[3] * p.0 + h[4] * p.1 + h[5]) / d,
    )
}

pub fn invert_h(h: &H3) -> Option<H3> {
    let m = h;
    let det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6])
        + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if det.abs() < 1e-12 {
        return None;
    }
    let inv_det = 1.0 / det;
    Some([
        (m[4] * m[8] - m[5] * m[7]) * inv_det,
        (m[2] * m[7] - m[1] * m[8]) * inv_det,
        (m[1] * m[5] - m[2] * m[4]) * inv_det,
        (m[5] * m[6] - m[3] * m[8]) * inv_det,
        (m[0] * m[8] - m[2] * m[6]) * inv_det,
        (m[2] * m[3] - m[0] * m[5]) * inv_det,
        (m[3] * m[7] - m[4] * m[6]) * inv_det,
        (m[1] * m[6] - m[0] * m[7]) * inv_det,
        (m[0] * m[4] - m[1] * m[3]) * inv_det,
    ])
}

/// Autovector del menor autovalor de una matriz simétrica 9×9 (Jacobi).
fn smallest_eigenvector(mut a: [[f64; 9]; 9]) -> [f64; 9] {
    let mut v = [[0.0f64; 9]; 9];
    for i in 0..9 {
        v[i][i] = 1.0;
    }
    for _sweep in 0..60 {
        // mayor elemento fuera de la diagonal
        let mut off = 0.0;
        for i in 0..9 {
            for j in i + 1..9 {
                off += a[i][j] * a[i][j];
            }
        }
        if off < 1e-22 {
            break;
        }
        for p in 0..9 {
            for q in p + 1..9 {
                if a[p][q].abs() < 1e-15 {
                    continue;
                }
                let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..9 {
                    let akp = a[k][p];
                    let akq = a[k][q];
                    a[k][p] = c * akp - s * akq;
                    a[k][q] = s * akp + c * akq;
                }
                for k in 0..9 {
                    let apk = a[p][k];
                    let aqk = a[q][k];
                    a[p][k] = c * apk - s * aqk;
                    a[q][k] = s * apk + c * aqk;
                }
                for k in 0..9 {
                    let vkp = v[k][p];
                    let vkq = v[k][q];
                    v[k][p] = c * vkp - s * vkq;
                    v[k][q] = s * vkp + c * vkq;
                }
            }
        }
    }
    let mut min_i = 0;
    for i in 1..9 {
        if a[i][i] < a[min_i][min_i] {
            min_i = i;
        }
    }
    let mut out = [0.0; 9];
    for k in 0..9 {
        out[k] = v[k][min_i];
    }
    out
}

fn normalize_pts(pts: &[Pt]) -> (Vec<Pt>, H3) {
    let n = pts.len() as f64;
    let (mut cx, mut cy) = (0.0, 0.0);
    for p in pts {
        cx += p.0;
        cy += p.1;
    }
    cx /= n;
    cy /= n;
    let mut d = 0.0;
    for p in pts {
        d += ((p.0 - cx).powi(2) + (p.1 - cy).powi(2)).sqrt();
    }
    d /= n;
    let s = if d > 1e-12 { std::f64::consts::SQRT_2 / d } else { 1.0 };
    let t: H3 = [s, 0.0, -s * cx, 0.0, s, -s * cy, 0.0, 0.0, 1.0];
    let out = pts.iter().map(|&p| ((p.0 - cx) * s, (p.1 - cy) * s)).collect();
    (out, t)
}

fn mat_mul(a: &H3, b: &H3) -> H3 {
    let mut o = [0.0; 9];
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
            }
        }
    }
    o
}

/// Homografía src→dst por DLT normalizado (mínimos cuadrados con ≥4 pares).
pub fn find_homography_dlt(src: &[Pt], dst: &[Pt]) -> Option<H3> {
    if src.len() < 4 || src.len() != dst.len() {
        return None;
    }
    let (sn, ts) = normalize_pts(src);
    let (dn, td) = normalize_pts(dst);
    // A^T·A directamente (2N filas → 9×9 simétrica)
    let mut ata = [[0.0f64; 9]; 9];
    for i in 0..sn.len() {
        let (x, y) = sn[i];
        let (u, v) = dn[i];
        let rows: [[f64; 9]; 2] = [
            [-x, -y, -1.0, 0.0, 0.0, 0.0, u * x, u * y, u],
            [0.0, 0.0, 0.0, -x, -y, -1.0, v * x, v * y, v],
        ];
        for r in rows.iter() {
            for a in 0..9 {
                for b in 0..9 {
                    ata[a][b] += r[a] * r[b];
                }
            }
        }
    }
    let hvec = smallest_eigenvector(ata);
    let hn: H3 = [
        hvec[0], hvec[1], hvec[2], hvec[3], hvec[4], hvec[5], hvec[6], hvec[7], hvec[8],
    ];
    // desnormalizar: H = Td^-1 · Hn · Ts
    let td_inv = invert_h(&td)?;
    let h = mat_mul(&mat_mul(&td_inv, &hn), &ts);
    if h[8].abs() < 1e-12 {
        return Some(h);
    }
    let mut out = h;
    for v in out.iter_mut() {
        *v /= h[8];
    }
    Some(out)
}

/// PRNG xorshift64* determinista (RANSAC reproducible).
pub struct Rng(u64);
impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.max(1))
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
    /// Uniforme en [-0.5, 0.5)
    pub fn jitter(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64 - 0.5
    }
}

/// Homografía robusta con RANSAC + reajuste con inliers.
/// Devuelve (H, máscara de inliers) como cv2.findHomography(..., RANSAC).
pub fn find_homography_ransac(src: &[Pt], dst: &[Pt], thresh: f64) -> Option<(H3, Vec<bool>)> {
    let n = src.len();
    if n < 4 {
        return None;
    }
    if n == 4 {
        let h = find_homography_dlt(src, dst)?;
        return Some((h, vec![true; 4]));
    }
    let mut rng = Rng::new(0x4D584D_u64);
    let t2 = thresh * thresh;
    let mut best_inliers: Vec<bool> = Vec::new();
    let mut best_count = 0usize;
    let iters = 2000usize;
    for _ in 0..iters {
        // 4 índices distintos
        let mut idx = [0usize; 4];
        let mut k = 0;
        while k < 4 {
            let c = rng.below(n);
            if !idx[..k].contains(&c) {
                idx[k] = c;
                k += 1;
            }
        }
        let s: Vec<Pt> = idx.iter().map(|&i| src[i]).collect();
        let d: Vec<Pt> = idx.iter().map(|&i| dst[i]).collect();
        let h = match find_homography_dlt(&s, &d) {
            Some(h) => h,
            None => continue,
        };
        let mut count = 0;
        let mut mask = vec![false; n];
        for i in 0..n {
            let p = apply_h(&h, src[i]);
            let dx = p.0 - dst[i].0;
            let dy = p.1 - dst[i].1;
            if dx * dx + dy * dy < t2 {
                mask[i] = true;
                count += 1;
            }
        }
        if count > best_count {
            best_count = count;
            best_inliers = mask;
            if best_count as f64 > 0.95 * n as f64 {
                break;
            }
        }
    }
    if best_count < 4 {
        return None;
    }
    let s: Vec<Pt> = (0..n).filter(|&i| best_inliers[i]).map(|i| src[i]).collect();
    let d: Vec<Pt> = (0..n).filter(|&i| best_inliers[i]).map(|i| dst[i]).collect();
    let h = find_homography_dlt(&s, &d)?;
    Some((h, best_inliers))
}

// ────────────────────────────────────────────────────────────────
// Warp de perspectiva (muestreo inverso bicúbico Catmull-Rom)
// ────────────────────────────────────────────────────────────────

#[inline]
fn cubic_w(t: f64) -> [f64; 4] {
    // Catmull-Rom (a = -0.5), pesos para muestras en -1, 0, 1, 2
    let t2 = t * t;
    let t3 = t2 * t;
    [
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1.0,
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2,
    ]
}

fn warp_generic<T: Copy + Into<f64>>(
    data: &[T],
    sw: usize,
    sh: usize,
    m: &H3,
    out_w: usize,
    out_h: usize,
    maxv: f64,
    to_t: impl Fn(f64) -> T,
    fill: [T; 3],
) -> Vec<T> {
    // m: src→dst; muestreamos con la inversa
    let minv = invert_h(m).unwrap_or([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
    let mut out = Vec::with_capacity(out_w * out_h * 3);
    for _ in 0..out_w * out_h {
        out.extend_from_slice(&fill);
    }
    let swi = sw as i64;
    let shi = sh as i64;
    for y in 0..out_h {
        for x in 0..out_w {
            let (sx, sy) = apply_h(&minv, (x as f64, y as f64));
            if sx < -1.5 || sy < -1.5 || sx > sw as f64 + 0.5 || sy > sh as f64 + 0.5 {
                continue;
            }
            let x0 = sx.floor();
            let y0 = sy.floor();
            let wx = cubic_w(sx - x0);
            let wy = cubic_w(sy - y0);
            let xi = x0 as i64;
            let yi = y0 as i64;
            let o = (y * out_w + x) * 3;
            for c in 0..3 {
                let mut acc = 0.0f64;
                for j in 0..4 {
                    let yy = (yi - 1 + j as i64).clamp(0, shi - 1) as usize;
                    let mut rowacc = 0.0f64;
                    for i in 0..4 {
                        let xx = (xi - 1 + i as i64).clamp(0, swi - 1) as usize;
                        rowacc += wx[i] * data[(yy * sw + xx) * 3 + c].into();
                    }
                    acc += wy[j] * rowacc;
                }
                out[o + c] = to_t(acc.clamp(0.0, maxv));
            }
        }
    }
    out
}

/// Equivalente a cv2.warpPerspective(img, M, (out_w, out_h)) con interpolación
/// bicúbica. Conserva la profundidad (8 o 16 bits).
pub fn warp_perspective(img: &DynImg, m: &H3, out_w: usize, out_h: usize) -> DynImg {
    match img {
        DynImg::U8(i) => DynImg::U8(Rgb {
            w: out_w,
            h: out_h,
            data: warp_generic(&i.data, i.w, i.h, m, out_w, out_h, 255.0, |v| v.round() as u8, [0u8; 3]),
        }),
        DynImg::U16(i) => DynImg::U16(Rgb16 {
            w: out_w,
            h: out_h,
            data: warp_generic(&i.data, i.w, i.h, m, out_w, out_h, 65535.0, |v| v.round() as u16, [0u16; 3]),
        }),
    }
}

/// Warp de una imagen RGB de 8 bits con color de relleno (compensación de
/// escala de impresora: lo que queda fuera se pinta del fondo de la hoja).
pub fn warp_rgb_fill(img: &Rgb, m: &H3, out_w: usize, out_h: usize, fill: [u8; 3]) -> Rgb {
    Rgb {
        w: out_w,
        h: out_h,
        data: warp_generic(&img.data, img.w, img.h, m, out_w, out_h, 255.0, |v| v.round() as u8, fill),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn homography_identity() {
        let src = vec![(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0), (50.0, 20.0)];
        let h = find_homography_dlt(&src, &src).unwrap();
        let p = apply_h(&h, (33.0, 77.0));
        assert!((p.0 - 33.0).abs() < 1e-6 && (p.1 - 77.0).abs() < 1e-6);
    }

    #[test]
    fn homography_known_projective() {
        // proyectiva no trivial
        let ht: H3 = [1.2, 0.1, 5.0, -0.05, 0.9, 12.0, 0.0002, -0.0001, 1.0];
        let src: Vec<Pt> = vec![
            (10.0, 10.0), (400.0, 30.0), (390.0, 500.0), (20.0, 480.0),
            (200.0, 250.0), (100.0, 100.0), (300.0, 400.0),
        ];
        let dst: Vec<Pt> = src.iter().map(|&p| apply_h(&ht, p)).collect();
        let h = find_homography_dlt(&src, &dst).unwrap();
        for &p in &src {
            let q1 = apply_h(&ht, p);
            let q2 = apply_h(&h, p);
            assert!((q1.0 - q2.0).abs() < 1e-3 && (q1.1 - q2.1).abs() < 1e-3);
        }
    }

    #[test]
    fn ransac_rejects_outliers() {
        let ht: H3 = [0.9, 0.05, 30.0, -0.02, 1.1, -10.0, 0.0001, 0.0, 1.0];
        let mut src: Vec<Pt> = Vec::new();
        let mut rng = Rng::new(7);
        for _ in 0..40 {
            src.push((rng.below(1000) as f64, rng.below(1400) as f64));
        }
        let mut dst: Vec<Pt> = src.iter().map(|&p| apply_h(&ht, p)).collect();
        // 8 outliers gordos
        for i in 0..8 {
            dst[i * 5].0 += 300.0;
        }
        let (h, mask) = find_homography_ransac(&src, &dst, 3.0).unwrap();
        let inl = mask.iter().filter(|&&b| b).count();
        assert!(inl >= 30, "solo {} inliers", inl);
        let p = apply_h(&h, (500.0, 500.0));
        let q = apply_h(&ht, (500.0, 500.0));
        assert!((p.0 - q.0).abs() < 1.0 && (p.1 - q.1).abs() < 1.0);
    }
}
