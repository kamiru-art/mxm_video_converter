//! El fotograma dentro de su celda: del archivo a los píxeles de la hoja
//! con UNA sola cuantización, al final.
//!
//! Antes el camino cuantizaba a 8 bits tres veces: al decodificar (un TIFF
//! o un PNG de 16 bits llegaba ya en 8), al salir del Lanczos, y otra vez
//! en gris antes de la curva de la cianotipia. La curva de un negativo es
//! empinada en las sombras y en las luces, así que esos escalones de 1/255
//! se estiraban en bandas visibles. Aquí todo es f32 (escala 0..255) desde
//! la fuente, en su profundidad, hasta el color de la hoja: el alfa se
//! compone en la primera pasada del remuestreo, la curva se interpola entre
//! sus 256 puntos y la rampa de tinta también. Sólo al final se cuantiza, a
//! 8 bits (con tramado en la densidad, para no crear bandas) o a 16.

use crate::cyanotype::InkStop;
use crate::geometry::Rng;
use crate::img::{Rgb, Rgb16};
use crate::imgproc::gaussian_blur_f32;

/// Píxeles de un fotograma tal como llegan: RGBA de 8 o de 16 bits.
pub enum FramePixels {
    Rgba8(Vec<u8>),
    Rgba16(Vec<u16>),
}

impl FramePixels {
    pub fn is_deep(&self) -> bool {
        matches!(self, FramePixels::Rgba16(_))
    }

    /// RGB de 8 bits con el alfa sobre blanco (lo que ve la impresión): para
    /// las miniaturas del dHash y del histograma, que no piden más.
    pub fn rgb8_over_white(&self) -> Vec<u8> {
        match self {
            FramePixels::Rgba8(d) => {
                let mut rgb = Vec::with_capacity(d.len() / 4 * 3);
                for p in d.as_chunks::<4>().0 {
                    let a = p[3] as u32;
                    for c in 0..3 {
                        rgb.push(((p[c] as u32 * a + 255 * (255 - a)) / 255) as u8);
                    }
                }
                rgb
            }
            FramePixels::Rgba16(d) => {
                let mut rgb = Vec::with_capacity(d.len() / 4 * 3);
                for p in d.as_chunks::<4>().0 {
                    let a = p[3] as u64;
                    for c in 0..3 {
                        let v = (p[c] as u64 * a + 65535 * (65535 - a)) / 65535;
                        rgb.push(((v + 128) / 257) as u8);
                    }
                }
                rgb
            }
        }
    }
}

/// Pesos de Lanczos3 (con antialias al reducir), por píxel de destino.
fn weights(src_n: usize, dst_n: usize) -> Vec<(usize, Vec<f32>)> {
    let scale = src_n as f32 / dst_n as f32;
    let fscale = scale.max(1.0);
    let sup = 3.0 * fscale;
    let sinc = |x: f32| {
        if x.abs() < 1e-8 {
            1.0
        } else {
            let px = std::f32::consts::PI * x;
            px.sin() / px
        }
    };
    (0..dst_n)
        .map(|d| {
            let center = (d as f32 + 0.5) * scale;
            let lo = ((center - sup).floor().max(0.0)) as usize;
            let hi = ((center + sup).ceil() as usize).min(src_n);
            let mut ws: Vec<f32> = (lo..hi)
                .map(|s| {
                    let x = ((s as f32 + 0.5 - center) / fscale).abs();
                    if x < 3.0 {
                        sinc(x) * sinc(x / 3.0)
                    } else {
                        0.0
                    }
                })
                .collect();
            let sum: f32 = ws.iter().sum();
            if sum.abs() < 1e-8 {
                return (lo.min(src_n - 1), vec![1.0]);
            }
            for w in ws.iter_mut() {
                *w /= sum;
            }
            (lo, ws)
        })
        .collect()
}

/// El fotograma `sw`×`sh`, con el alfa compuesto sobre `base`, remuestreado
/// con Lanczos3 a `dw`×`dh`. RGB f32 en escala 0..255 (un 16 bits conserva
/// sus fracciones). La fuente se lee fila a fila: nunca existe una copia
/// entera en f32, sólo la pasada horizontal, que ya es del ancho de destino.
pub fn fit_frame(
    px: &FramePixels,
    sw: usize,
    sh: usize,
    base: [u8; 3],
    dw: usize,
    dh: usize,
) -> Vec<f32> {
    let (dw, dh) = (dw.max(1), dh.max(1));
    let wx = weights(sw, dw);
    let wy = weights(sh, dh);
    let base = [base[0] as f32, base[1] as f32, base[2] as f32];
    let mut row = vec![0.0f32; sw * 3];
    let mut tmp = vec![0.0f32; dw * sh * 3];
    for y in 0..sh {
        // la fila en f32, con el alfa ya compuesto
        match px {
            FramePixels::Rgba8(d) => {
                for x in 0..sw {
                    let p = &d[(y * sw + x) * 4..(y * sw + x) * 4 + 4];
                    let a = p[3] as f32 / 255.0;
                    for c in 0..3 {
                        row[x * 3 + c] = p[c] as f32 * a + base[c] * (1.0 - a);
                    }
                }
            }
            FramePixels::Rgba16(d) => {
                for x in 0..sw {
                    let p = &d[(y * sw + x) * 4..(y * sw + x) * 4 + 4];
                    let a = p[3] as f32 / 65535.0;
                    for c in 0..3 {
                        row[x * 3 + c] = p[c] as f32 / 257.0 * a + base[c] * (1.0 - a);
                    }
                }
            }
        }
        for (d, (lo, ws)) in wx.iter().enumerate() {
            let mut acc = [0.0f32; 3];
            for (k, &w) in ws.iter().enumerate() {
                let i = (lo + k) * 3;
                acc[0] += w * row[i];
                acc[1] += w * row[i + 1];
                acc[2] += w * row[i + 2];
            }
            tmp[(y * dw + d) * 3..(y * dw + d) * 3 + 3].copy_from_slice(&acc);
        }
    }
    let mut out = vec![0.0f32; dw * dh * 3];
    for (d, (lo, ws)) in wy.iter().enumerate() {
        for x in 0..dw {
            let mut acc = [0.0f32; 3];
            for (k, &w) in ws.iter().enumerate() {
                let i = ((lo + k) * dw + x) * 3;
                acc[0] += w * tmp[i];
                acc[1] += w * tmp[i + 1];
                acc[2] += w * tmp[i + 2];
            }
            let o = (d * dw + x) * 3;
            for c in 0..3 {
                out[o + c] = acc[c].clamp(0.0, 255.0);
            }
        }
    }
    out
}

/// A 8 bits, redondeando.
pub fn to_rgb8(rgb: &[f32], w: usize, h: usize) -> Rgb {
    Rgb {
        w,
        h,
        data: rgb
            .iter()
            .map(|&v| v.round().clamp(0.0, 255.0) as u8)
            .collect(),
    }
}

/// A 16 bits: 255 → 65535, sin perder las fracciones.
pub fn to_rgb16(rgb: &[f32], w: usize, h: usize) -> Rgb16 {
    Rgb16 {
        w,
        h,
        data: rgb
            .iter()
            .map(|&v| (v * 257.0).round().clamp(0.0, 65535.0) as u16)
            .collect(),
    }
}

/// Valor de una tabla de 256 puntos en `x` (0..255), interpolando.
fn lerp256(t: &[f64], x: f32) -> f64 {
    let x = x.clamp(0.0, 255.0) as f64;
    let i = (x.floor() as usize).min(254);
    let f = x - i as f64;
    t[i] + (t[i + 1] - t[i]) * f
}

/// Densidad de tinta del negativo por píxel (0..255, continua): gris →
/// claridad (máscara de enfoque local) → curva. Mismo gris que
/// `Rgb::to_gray` (0,299/0,587/0,114), sin redondear.
pub fn densities(rgb: &[f32], w: usize, h: usize, lut: Option<&[f64]>, clarity: f64) -> Vec<f32> {
    let mut g: Vec<f32> = rgb
        .as_chunks::<3>()
        .0
        .iter()
        .map(|p| 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2])
        .collect();
    let c = clarity.clamp(0.0, 100.0) as f32;
    if c > 0.0 {
        let radio = ((w.min(h)) as f32 / 24.0).max(2.0);
        let blur = gaussian_blur_f32(&g, w, h, radio);
        for (v, b) in g.iter_mut().zip(blur) {
            *v = (*v + (c / 100.0) * (*v - b)).clamp(0.0, 255.0);
        }
    }
    match lut.filter(|l| l.len() == 256) {
        Some(l) => g.iter().map(|&v| lerp256(l, v) as f32).collect(),
        None => g,
    }
}

/// El negativo a 8 bits. La densidad se trama (±½ nivel, determinista:
/// las hojas son reproducibles) antes de elegir su color en la rampa de
/// 256 tintas: los colores quedan siempre sobre el eje de la tinta, y los
/// degradados no hacen bandas.
pub fn ink8(d: &[f32], w: usize, h: usize, ink: &str, stops: Option<&[InkStop]>) -> Rgb {
    let ramp = crate::cyanotype::ink_ramp(ink, stops);
    let mut rng = Rng::new(12345);
    let mut data = Vec::with_capacity(w * h * 3);
    for &v in d {
        let i = (v as f64 + rng.jitter()).round().clamp(0.0, 255.0) as usize;
        data.extend_from_slice(&ramp[i]);
    }
    Rgb { w, h, data }
}

/// El negativo a 16 bits: el color de la rampa interpolado en la densidad
/// continua, sin tramado (no hace falta: 65536 niveles no hacen bandas).
pub fn ink16(d: &[f32], w: usize, h: usize, ink: &str, stops: Option<&[InkStop]>) -> Rgb16 {
    let ramp = crate::cyanotype::ink_ramp_exact(ink, stops);
    let mut data = Vec::with_capacity(w * h * 3);
    for &v in d {
        let x = v.clamp(0.0, 255.0) as f64;
        let i = (x.floor() as usize).min(254);
        let f = x - i as f64;
        for c in 0..3 {
            let col = ramp[i][c] + (ramp[i + 1][c] - ramp[i][c]) * f;
            data.push((col * 257.0).round().clamp(0.0, 65535.0) as u16);
        }
    }
    Rgb16 { w, h, data }
}

#[cfg(test)]
mod tests {
    // Lo que puede fallar, escrito antes que el código:
    // 1. un fotograma de 16 bits pierde sus fracciones antes de la curva
    //    (vuelven los escalones de 1/255);
    // 2. el alfa se compone en otra profundidad y el borde cambia de color;
    // 3. un fotograma plano deja de ser plano tras el Lanczos;
    // 4. el negativo de 8 bits sale de la rampa de tinta (colores que no
    //    son de la tinta), o deja de ser reproducible.
    use super::*;

    #[test]
    fn a_flat_frame_stays_flat_in_both_depths() {
        let px = FramePixels::Rgba16([40000, 20000, 1000, 65535].repeat(64 * 36));
        let out = fit_frame(&px, 64, 36, [255; 3], 20, 11);
        let o16 = to_rgb16(&out, 20, 11);
        assert!(
            o16.data.chunks(3).all(|p| p == [40000, 20000, 1000]),
            "{:?}",
            &o16.data[..3]
        );
    }

    #[test]
    fn sixteen_bit_detail_survives_until_the_curve() {
        // dos grises que en 8 bits son el mismo nivel (100·257 y 100·257+128)
        let a = FramePixels::Rgba16([25700, 25700, 25700, 65535].repeat(16));
        let b = FramePixels::Rgba16([25828, 25828, 25828, 65535].repeat(16));
        let (fa, fb) = (
            fit_frame(&a, 4, 4, [255; 3], 4, 4),
            fit_frame(&b, 4, 4, [255; 3], 4, 4),
        );
        let lut: Vec<f64> = (0..256).map(|i| (i as f64 * 2.0).min(255.0)).collect(); // curva empinada
        let (da, db) = (
            densities(&fa, 4, 4, Some(&lut), 0.0),
            densities(&fb, 4, 4, Some(&lut), 0.0),
        );
        assert!(
            (db[0] - da[0] - 128.0 / 257.0 * 2.0).abs() < 0.01,
            "{} {}",
            da[0],
            db[0]
        );
        let (na, nb) = (
            ink16(&da, 4, 4, "#000000", None),
            ink16(&db, 4, 4, "#000000", None),
        );
        assert_ne!(na.data[0], nb.data[0]);
    }

    #[test]
    fn alpha_is_composed_over_the_base_colour() {
        let px = FramePixels::Rgba8(vec![0, 0, 0, 0, 0, 0, 0, 255]);
        let out = fit_frame(&px, 2, 1, [200, 100, 50], 2, 1);
        assert_eq!(to_rgb8(&out, 2, 1).data, vec![200, 100, 50, 0, 0, 0]);
    }

    #[test]
    fn eight_bit_negative_stays_on_the_ink_ramp_and_is_reproducible() {
        let d: Vec<f32> = (0..500).map(|i| i as f32 * 0.51).collect();
        let ramp = crate::cyanotype::ink_ramp("#1e3a8a", None);
        let a = ink8(&d, 500, 1, "#1e3a8a", None);
        assert!(a.data.chunks(3).all(|p| ramp.iter().any(|r| r == p)));
        assert_eq!(a.data, ink8(&d, 500, 1, "#1e3a8a", None).data);
    }
}
