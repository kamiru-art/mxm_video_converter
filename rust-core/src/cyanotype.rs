//! Modo cianotipia: negativos digitales para imprimir en acetato.
//! Port fiel del módulo original (densidad, curvas, tintas, simulación).

use crate::geometry::Rng;
use crate::img::{Gray, Rgb};
use crate::imgproc::gaussian_blur_f32;

pub fn hex_to_rgb(color: &str) -> [u8; 3] {
    let c = color.trim().trim_start_matches('#');
    let c: String = if c.len() == 3 {
        c.chars().flat_map(|ch| [ch, ch]).collect()
    } else {
        c.to_string()
    };
    if c.len() != 6 || !c.bytes().all(|b| b.is_ascii_hexdigit()) {
        return [0, 0, 0];
    }
    let p = |i: usize| u8::from_str_radix(&c[i..i + 2], 16).unwrap_or(0);
    [p(0), p(2), p(4)]
}

pub fn rgb_to_hex(rgb: [u8; 3]) -> String {
    format!("#{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2])
}

/// Parada de degradado: (densidad 0-255, color).
pub type InkStop = (f64, [u8; 3]);

/// Rampa 256×3: color impreso para cada densidad 0..255.
/// Sin stops: blanco (d=0) → ink_color (d=255). Con stops (ColorBlocker):
/// interpolación entre paradas, ancladas en blanco si falta d=0.
pub fn ink_ramp(ink_color: &str, stops: Option<&[InkStop]>) -> [[u8; 3]; 256] {
    let mut anchors: Vec<(f64, [f64; 3])> = Vec::new();
    match stops {
        Some(ss) if !ss.is_empty() => {
            for &(d, col) in ss {
                anchors.push((d.clamp(0.0, 255.0), [col[0] as f64, col[1] as f64, col[2] as f64]));
            }
            anchors.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            if anchors[0].0 > 0.5 {
                anchors.insert(0, (0.0, [255.0, 255.0, 255.0]));
            }
            if anchors.last().unwrap().0 < 254.5 {
                let last = anchors.last().unwrap().1;
                anchors.push((255.0, last));
            }
        }
        _ => {
            let ink = hex_to_rgb(ink_color);
            anchors = vec![
                (0.0, [255.0, 255.0, 255.0]),
                (255.0, [ink[0] as f64, ink[1] as f64, ink[2] as f64]),
            ];
        }
    }
    let mut ramp = [[0u8; 3]; 256];
    for d in 0..256 {
        let x = d as f64;
        // buscar el segmento
        let mut i = 0;
        while i + 1 < anchors.len() && anchors[i + 1].0 < x {
            i += 1;
        }
        let (x0, c0) = anchors[i];
        let (x1, c1) = anchors[(i + 1).min(anchors.len() - 1)];
        let t = if x1 > x0 { ((x - x0) / (x1 - x0)).clamp(0.0, 1.0) } else { 0.0 };
        for ch in 0..3 {
            ramp[d][ch] = (c0[ch] + (c1[ch] - c0[ch]) * t).round().clamp(0.0, 255.0) as u8;
        }
    }
    ramp
}

/// Color RGB de una densidad constante (fondos, halos, parches).
pub fn solid_density_color(density: f64, ink_color: &str, stops: Option<&[InkStop]>) -> [u8; 3] {
    let ramp = ink_ramp(ink_color, stops);
    ramp[(density.clamp(0.0, 255.0)) as usize]
}

/// LUT efectiva de densidad: (calibrada × fuerza) ∘ adaptación al contenido.
/// Devuelve None si el resultado es la identidad (no tocar ni un píxel).
pub fn effective_lut(
    lut: Option<&[f64]>,
    strength: f64,
    adapt: f64,
    hist: Option<&[f64; 256]>,
) -> Option<Vec<f64>> {
    let ident: Vec<f64> = (0..256).map(|i| i as f64).collect();
    let a = (strength.clamp(0.0, 100.0)) / 100.0;
    let cal: Vec<f64> = match lut {
        Some(l) if l.len() == 256 => l.iter().map(|&v| v.clamp(0.0, 255.0)).collect(),
        _ => ident.clone(),
    };
    let base: Vec<f64> = (0..256).map(|i| ident[i] * (1.0 - a) + cal[i] * a).collect();

    let b = (adapt.clamp(0.0, 100.0)) / 100.0;
    let mut out = base.clone();
    if b > 0.0 {
        if let Some(h) = hist {
            let total: f64 = h.iter().sum();
            if total > 0.0 {
                // suavizado ventana 21 con bordes extendidos
                let v = 21usize;
                let half = v / 2;
                let mut sm = [0.0f64; 256];
                for i in 0..256 {
                    let mut acc = 0.0;
                    for k in 0..v {
                        let idx = (i as i64 + k as i64 - half as i64).clamp(0, 255) as usize;
                        acc += h[idx];
                    }
                    sm[i] = acc / v as f64;
                }
                let s: f64 = sm.iter().sum::<f64>().max(1e-12);
                // pendiente mínima: 15 % de rango proporcional
                let piso = 0.15;
                let mut hh = [0.0f64; 256];
                for i in 0..256 {
                    hh[i] = (sm[i] / s + piso / 256.0) / (1.0 + piso);
                }
                let mut cdf = [0.0f64; 256];
                let mut acc = 0.0;
                for i in 0..256 {
                    acc += hh[i];
                    cdf[i] = acc;
                }
                let c0 = cdf[0];
                let cr = (cdf[255] - c0).max(1e-12);
                for i in 0..256 {
                    cdf[i] = (cdf[i] - c0) / cr;
                }
                for i in 0..256 {
                    let t = (1.0 - b) * (i as f64 / 255.0) + b * cdf[i];
                    let x = t * 255.0;
                    let lo = x.floor().clamp(0.0, 255.0) as usize;
                    let hi = (lo + 1).min(255);
                    let f = x - lo as f64;
                    out[i] = base[lo] * (1.0 - f) + base[hi] * f;
                }
            }
        }
    }
    let is_ident = out.iter().enumerate().all(|(i, &v)| (v - i as f64).abs() < 1e-9);
    if is_ident {
        None
    } else {
        Some(out.iter().map(|&v| v.clamp(0.0, 255.0)).collect())
    }
}

/// Convierte un fotograma a su negativo de cianotipia:
/// gris → micro-contraste (clarity) → LUT (con dithering) → rampa de tinta.
pub fn make_negative(
    img: &Rgb,
    lut: Option<&[f64]>,
    ink_color: &str,
    stops: Option<&[InkStop]>,
    clarity: f64,
) -> Rgb {
    let gray = img.to_gray();
    let mut gvals: Vec<f64> = gray.data.iter().map(|&v| v as f64).collect();
    let c = clarity.clamp(0.0, 100.0);
    if c > 0.0 {
        let radio = ((gray.w.min(gray.h)) as f32 / 24.0).max(2.0);
        let f32s: Vec<f32> = gray.data.iter().map(|&v| v as f32).collect();
        let blur = gaussian_blur_f32(&f32s, gray.w, gray.h, radio);
        for i in 0..gvals.len() {
            gvals[i] = (gvals[i] + (c / 100.0) * (gvals[i] - blur[i] as f64)).clamp(0.0, 255.0);
        }
    }
    let ramp = ink_ramp(ink_color, stops);
    let has_lut = lut.map_or(false, |l| l.len() == 256);
    let lut_arr: Vec<f64> = if has_lut {
        lut.unwrap().to_vec()
    } else {
        (0..256).map(|i| i as f64).collect()
    };
    let mut rng = Rng::new(12345); // determinista: hojas reproducibles
    let mut out = Vec::with_capacity(gray.w * gray.h * 3);
    for &g in &gvals {
        let gi = g.round().clamp(0.0, 255.0) as usize;
        let mut d = lut_arr[gi];
        if has_lut {
            d += rng.jitter(); // dithering subcuántico: sin bandas
        }
        let di = d.round().clamp(0.0, 255.0) as usize;
        out.extend_from_slice(&ramp[di]);
    }
    Rgb { w: gray.w, h: gray.h, data: out }
}

/// Colorea un parche gris interpretándolo como densidad INVERTIDA
/// (negro=transparente, blanco=tinta plena): marcadores/QRs/textos en negativos.
pub fn colorize_gray_patch(img: &Gray, ink_color: &str, stops: Option<&[InkStop]>) -> Rgb {
    let ramp = ink_ramp(ink_color, stops);
    let mut out = Vec::with_capacity(img.w * img.h * 3);
    for &v in &img.data {
        out.extend_from_slice(&ramp[v as usize]);
    }
    Rgb { w: img.w, h: img.h, data: out }
}

/// Densidad estimada de un negativo YA COLOREADO: proyección de cada píxel
/// sobre el eje de la tinta (válido con tintas de color y degradados).
fn density_from_pixels(neg: &Rgb, ink_color: Option<&str>, stops: Option<&[InkStop]>) -> Vec<f32> {
    if ink_color.is_none() && stops.is_none() {
        let g = neg.to_gray();
        return g.data.iter().map(|&v| 255.0 - v as f32).collect();
    }
    let ramp = ink_ramp(ink_color.unwrap_or("#000000"), stops);
    let r0 = [ramp[0][0] as f64, ramp[0][1] as f64, ramp[0][2] as f64];
    let r255 = [ramp[255][0] as f64, ramp[255][1] as f64, ramp[255][2] as f64];
    let eje = [r255[0] - r0[0], r255[1] - r0[1], r255[2] - r0[2]];
    let norma = eje[0] * eje[0] + eje[1] * eje[1] + eje[2] * eje[2];
    if norma < 1e-6 {
        return vec![0.0; neg.w * neg.h];
    }
    let mut t_ramp = [0.0f64; 256];
    for d in 0..256 {
        let c = [ramp[d][0] as f64, ramp[d][1] as f64, ramp[d][2] as f64];
        t_ramp[d] = ((c[0] - r0[0]) * eje[0] + (c[1] - r0[1]) * eje[1] + (c[2] - r0[2]) * eje[2]) / norma;
    }
    // estrictamente creciente para que la inversa exista
    for i in 1..256 {
        if t_ramp[i] <= t_ramp[i - 1] {
            t_ramp[i] = t_ramp[i - 1] + 1e-6;
        }
    }
    let mut out = Vec::with_capacity(neg.w * neg.h);
    for p in neg.data.chunks_exact(3) {
        let t = ((p[0] as f64 - r0[0]) * eje[0]
            + (p[1] as f64 - r0[1]) * eje[1]
            + (p[2] as f64 - r0[2]) * eje[2])
            / norma;
        // interpolación inversa t → densidad
        let d = if t <= t_ramp[0] {
            0.0
        } else if t >= t_ramp[255] {
            255.0
        } else {
            let mut lo = 0usize;
            let mut hi = 255usize;
            while hi - lo > 1 {
                let mid = (lo + hi) / 2;
                if t_ramp[mid] <= t {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            lo as f64 + (t - t_ramp[lo]) / (t_ramp[hi] - t_ramp[lo]).max(1e-12)
        };
        out.push(d as f32);
    }
    out
}

/// Simula la cianotipia final de un negativo (vista previa / soft-proof).
/// `response`: pares [densidad, luminancia] medidos por la calibración.
pub fn simulate_print(
    neg: &Rgb,
    response: Option<&[(f64, f64)]>,
    ink_color: Option<&str>,
    stops: Option<&[InkStop]>,
) -> Rgb {
    let paper = [245.0f64, 242.0, 230.0];
    let blue = [23.0f64, 49.0, 92.0];
    let dens = density_from_pixels(neg, ink_color, stops);
    let mut expo: Vec<f64> = dens.iter().map(|&d| 1.0 - d as f64 / 255.0).collect();
    if let Some(resp) = response {
        let mut pares: Vec<(f64, f64)> = resp.to_vec();
        pares.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        if pares.len() >= 5 {
            let dd: Vec<f64> = pares.iter().map(|p| p.0).collect();
            let mut yy: Vec<f64> = pares.iter().map(|p| p.1).collect();
            for i in 1..yy.len() {
                yy[i] = yy[i].max(yy[i - 1]);
            }
            let range = yy[yy.len() - 1] - yy[0];
            if range > 5.0 {
                for (i, &d) in dens.iter().enumerate() {
                    let x = d as f64;
                    // interp lineal en (dd, yy)
                    let tono = if x <= dd[0] {
                        yy[0]
                    } else if x >= dd[dd.len() - 1] {
                        yy[yy.len() - 1]
                    } else {
                        let mut k = 0;
                        while k + 1 < dd.len() && dd[k + 1] < x {
                            k += 1;
                        }
                        let t = (x - dd[k]) / (dd[k + 1] - dd[k]).max(1e-12);
                        yy[k] + (yy[k + 1] - yy[k]) * t
                    };
                    expo[i] = 1.0 - (tono - yy[0]) / range;
                }
            }
        }
    }
    let mut out = Vec::with_capacity(neg.w * neg.h * 3);
    for &e in &expo {
        for ch in 0..3 {
            let v = paper[ch] + (blue[ch] - paper[ch]) * e;
            out.push(v.round().clamp(0.0, 255.0) as u8);
        }
    }
    Rgb { w: neg.w, h: neg.h, data: out }
}

/// Diagnóstico de una respuesta medida: rango, invertida, plana.
pub fn response_summary(response: &[(f64, f64)]) -> (f64, bool, bool) {
    let mut pares: Vec<(f64, f64)> = response.to_vec();
    pares.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    if pares.len() < 3 {
        return (0.0, false, true);
    }
    let y: Vec<f64> = pares.iter().map(|p| p.1).collect();
    let n = (y.len() / 4).max(1);
    let ymax = y.iter().cloned().fold(f64::MIN, f64::max);
    let ymin = y.iter().cloned().fold(f64::MAX, f64::min);
    let rango = (ymax - ymin) / 255.0;
    let head: f64 = y[..n].iter().sum::<f64>() / n as f64;
    let tail: f64 = y[y.len() - n..].iter().sum::<f64>() / n as f64;
    (rango, head > tail + 8.0, rango < 0.10)
}

/// Histograma de grises (256 bins) de un conjunto de miniaturas de fotogramas.
pub fn accumulate_histogram(hist: &mut [f64; 256], thumb: &Rgb) {
    let g = thumb.to_gray();
    for &v in &g.data {
        hist[v as usize] += 1.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ramp_simple() {
        let r = ink_ramp("#000000", None);
        assert_eq!(r[0], [255, 255, 255]);
        assert_eq!(r[255], [0, 0, 0]);
        assert_eq!(r[128], [127, 127, 127]);
    }

    #[test]
    fn ramp_with_stops() {
        let stops = vec![(0.0, [255u8, 255, 255]), (255.0, [0u8, 128, 0])];
        let r = ink_ramp("#000000", Some(&stops));
        assert_eq!(r[255], [0, 128, 0]);
    }

    #[test]
    fn negative_inverts_via_identity_lut() {
        // sin curva: densidad = brillo → un píxel blanco sale tinta plena
        let img = Rgb::new(4, 4, [255, 255, 255]);
        let neg = make_negative(&img, None, "#000000", None, 0.0);
        assert_eq!(neg.px(0, 0), [0, 0, 0]);
        let img = Rgb::new(4, 4, [0, 0, 0]);
        let neg = make_negative(&img, None, "#000000", None, 0.0);
        assert_eq!(neg.px(0, 0), [255, 255, 255]);
    }

    #[test]
    fn density_roundtrip_colored_ink() {
        // negativo con tinta verde: la densidad se recupera por el eje de tinta
        let img = Rgb::new(2, 2, [128, 128, 128]);
        let neg = make_negative(&img, None, "#00FF00", None, 0.0);
        let d = density_from_pixels(&neg, Some("#00FF00"), None);
        assert!((d[0] - 128.0).abs() < 2.0, "d={}", d[0]);
    }

    #[test]
    fn response_diagnostics() {
        // invertida: más densidad → más oscuro
        let resp: Vec<(f64, f64)> = (0..21).map(|i| (i as f64 * 12.75, 250.0 - i as f64 * 10.0)).collect();
        let (_, inv, _) = response_summary(&resp);
        assert!(inv);
        // sana
        let resp: Vec<(f64, f64)> = (0..21).map(|i| (i as f64 * 12.75, 30.0 + i as f64 * 10.0)).collect();
        let (rango, inv, plana) = response_summary(&resp);
        assert!(!inv && !plana && rango > 0.5);
    }

    #[test]
    fn effective_lut_identity_is_none() {
        assert!(effective_lut(None, 100.0, 0.0, None).is_none());
        let lut: Vec<f64> = (0..256).map(|i| i as f64).collect();
        assert!(effective_lut(Some(&lut), 100.0, 0.0, None).is_none());
        let lut2: Vec<f64> = (0..256).map(|i| (i as f64 * 0.5)).collect();
        assert!(effective_lut(Some(&lut2), 100.0, 0.0, None).is_some());
        // fuerza 0 anula la curva
        assert!(effective_lut(Some(&lut2), 0.0, 0.0, None).is_none());
    }

    #[test]
    fn hex_to_rgb_survives_non_ascii() {
        // c.len() cuenta bytes: "€€" son 6 bytes y 2 caracteres, así que pasaba
        // el control de longitud y luego &c[0..2] partía un carácter y reventaba.
        assert_eq!(hex_to_rgb("€€"), [0, 0, 0]);
        assert_eq!(hex_to_rgb("€"), [0, 0, 0]);
        assert_eq!(hex_to_rgb("#zzzzzz"), [0, 0, 0]);
        // los válidos siguen funcionando
        assert_eq!(hex_to_rgb("#FF8000"), [255, 128, 0]);
        assert_eq!(hex_to_rgb("f80"), [255, 136, 0]);
    }
}
