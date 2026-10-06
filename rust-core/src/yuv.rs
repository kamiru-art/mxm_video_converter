//! Fotogramas de video de más de 8 bits, a RGB de 16 bits.
//!
//! El navegador dibuja cada fotograma en un lienzo de 8 bits: un clip de 10
//! bits (HEVC Main 10 de cámara, VP9 perfil 2, AV1 de 10 bits, ProRes) perdía
//! dos bits por canal antes de llegar a la hoja. Aquí entran los planos tal
//! como los decodificó el navegador (`VideoFrame.copyTo`, formatos I4xxP10 e
//! I4xxP12) o el RGB de 16 bits que da ffmpeg.wasm (`rgb48le`), y salen en RGB
//! de 16 bits con la matriz y el rango del propio fotograma.
//!
//! Formas en que esto puede salir mal, y qué hace el código con cada una (los
//! tests del final las cubren una a una):
//!  1. Un buffer más corto que los planos que declara la descripción: error,
//!     nunca una lectura fuera de rango.
//!  2. Un paso de fila (stride) menor que la fila: error.
//!  3. Ancho o alto impar en 4:2:0 / 4:2:2: el plano de croma mide la mitad
//!     redondeada hacia arriba; la última columna y la última fila no se salen.
//!  4. w·h que desborda en wasm32 o pasa del tope de píxeles: error.
//!  5. Un formato desconocido: error que lo nombra.
//!  6. Códigos fuera del rango legal (pie y techo del rango limitado, un valor
//!     de 12 bits en un campo de 10): se recortan, no dan la vuelta.
//!  7. La matriz equivocada: un rojo puro de BT.709 leído como BT.601 sale
//!     anaranjado; se elige la del fotograma.
//!  8. El rango: negro y blanco del rango limitado caen exactos en 0 y 65535;
//!     en rango completo, el código máximo es 65535.
//!  9. La rotación de los metadatos (un móvil en vertical): 90 y 270 cambian
//!     ancho por alto y el píxel de arriba a la izquierda acaba en la esquina
//!     que toca.
//! 10. Formatos con alfa (I420AP10…): el plano de alfa se acepta y se ignora;
//!     un fotograma de video entra opaco, como en el camino de 8 bits.
//! 11. `RGB48LE` pasa sin tocar: ffmpeg ya convirtió.
//! 12. Los valores de 16 bits llegan little-endian, como los deja `copyTo`.

use crate::img::Rgb16;
use crate::scanproc::MAX_IMAGE_PIXELS;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Matrix {
    Bt601,
    Bt709,
    Bt2020,
}

impl Matrix {
    pub fn parse(s: &str) -> Result<Matrix, String> {
        match s {
            "bt601" => Ok(Matrix::Bt601),
            "bt709" => Ok(Matrix::Bt709),
            "bt2020" => Ok(Matrix::Bt2020),
            _ => Err(format!("Unknown colour matrix \"{s}\".")),
        }
    }
    /// (Kr, Kb) de cada norma.
    fn k(self) -> (f32, f32) {
        match self {
            Matrix::Bt601 => (0.299, 0.114),
            Matrix::Bt709 => (0.2126, 0.0722),
            Matrix::Bt2020 => (0.2627, 0.0593),
        }
    }
}

/// Dónde empieza cada plano en el buffer y cuántos BYTES ocupa cada fila.
#[derive(Clone, Copy, Debug)]
pub struct Plane {
    pub offset: usize,
    pub stride: usize,
}

pub struct Frame<'a> {
    pub data: &'a [u8],
    pub format: &'a str,
    pub w: usize,
    pub h: usize,
    pub planes: &'a [Plane],
    pub matrix: Matrix,
    pub full_range: bool,
    /// Grados en el sentido de las agujas del reloj: 0, 90, 180 o 270.
    pub rotation: u32,
}

/// (submuestreo horizontal, vertical, bits, planos) de un formato de WebCodecs.
fn planar(format: &str) -> Option<(usize, usize, u32, usize)> {
    let sub = match format.get(..4)? {
        "I420" => (2, 2),
        "I422" => (2, 1),
        "I444" => (1, 1),
        _ => return None,
    };
    let rest = &format[4..];
    let (alpha, rest) = match rest.strip_prefix('A') {
        Some(r) => (true, r),
        None => (false, rest),
    };
    let bits = match rest {
        "P10" => 10,
        "P12" => 12,
        _ => return None,
    };
    Some((sub.0, sub.1, bits, if alpha { 4 } else { 3 }))
}

/// ¿Lo convierte este módulo? (Los de 8 bits los dibuja el navegador.)
pub fn is_deep_format(format: &str) -> bool {
    format == "RGB48LE" || planar(format).is_some()
}

#[inline]
fn rd(data: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([data[at], data[at + 1]])
}

/// Comprueba que el plano `p` de `rows` filas de `row_bytes` cabe en `len`.
fn check_plane(p: &Plane, rows: usize, row_bytes: usize, len: usize) -> Result<(), String> {
    if p.stride < row_bytes {
        return Err(format!(
            "Plane stride {} is shorter than its row ({row_bytes} bytes).",
            p.stride
        ));
    }
    let end = (rows as u64 - 1) * p.stride as u64 + row_bytes as u64 + p.offset as u64;
    if end > len as u64 {
        return Err(format!(
            "The frame buffer is {len} bytes, but its planes need {end}."
        ));
    }
    Ok(())
}

pub fn to_rgb16(f: &Frame) -> Result<Rgb16, String> {
    let (w, h) = (f.w, f.h);
    if w == 0 || h == 0 {
        return Err("Empty video frame.".into());
    }
    let area = w
        .checked_mul(h)
        .filter(|&a| a <= MAX_IMAGE_PIXELS)
        .ok_or_else(|| format!("Video frame too large ({w}×{h})."))?;
    let mut out = vec![0u16; area.checked_mul(3).ok_or("Video frame too large.")?];

    if f.format == "RGB48LE" {
        let p = f.planes.first().ok_or("RGB48LE needs one plane.")?;
        check_plane(p, h, w * 6, f.data.len())?;
        for y in 0..h {
            let row = p.offset + y * p.stride;
            for x in 0..w * 3 {
                out[y * w * 3 + x] = rd(f.data, row + x * 2);
            }
        }
    } else {
        let (sx, sy, bits, nplanes) = planar(f.format)
            .ok_or_else(|| format!("Unsupported video pixel format {}.", f.format))?;
        if f.planes.len() < nplanes {
            return Err(format!(
                "{} has {nplanes} planes, {} were given.",
                f.format,
                f.planes.len()
            ));
        }
        let (cw, ch) = (w.div_ceil(sx), h.div_ceil(sy));
        check_plane(&f.planes[0], h, w * 2, f.data.len())?;
        check_plane(&f.planes[1], ch, cw * 2, f.data.len())?;
        check_plane(&f.planes[2], ch, cw * 2, f.data.len())?;

        // a [0, 1] para la luma y [-0.5, 0.5] para la croma
        let max = ((1u32 << bits) - 1) as f32;
        let unit = (1u32 << (bits - 8)) as f32;
        let (y_off, y_scale, c_off, c_scale) = if f.full_range {
            (0.0, 1.0 / max, (1u32 << (bits - 1)) as f32, 1.0 / max)
        } else {
            (
                16.0 * unit,
                1.0 / (219.0 * unit),
                128.0 * unit,
                1.0 / (224.0 * unit),
            )
        };
        let code_max = max as u16;
        let (kr, kb) = f.matrix.k();
        let kg = 1.0 - kr - kb;
        let (cr_r, cb_b) = (2.0 * (1.0 - kr), 2.0 * (1.0 - kb));
        let (cb_g, cr_g) = (-cb_b * kb / kg, -cr_r * kr / kg);

        let (py, pu, pv) = (f.planes[0], f.planes[1], f.planes[2]);
        let sample = |p: &Plane, x: usize, y: usize| -> f32 {
            rd(f.data, p.offset + y * p.stride + x * 2).min(code_max) as f32
        };
        // croma bilineal: co-situada en horizontal (MPEG-2, H.264, HEVC, VP9 y
        // AV1 por defecto) y centrada entre dos filas en vertical (4:2:0)
        let chroma = |p: &Plane, x: usize, y: usize| -> f32 {
            let fx = x as f32 / sx as f32;
            let fy = if sy == 2 {
                ((y as f32 + 0.5) / 2.0 - 0.5).max(0.0)
            } else {
                y as f32
            };
            let (x0, y0) = (fx as usize, fy as usize);
            let (x1, y1) = ((x0 + 1).min(cw - 1), (y0 + 1).min(ch - 1));
            let (ax, ay) = (fx - x0 as f32, fy - y0 as f32);
            let top = sample(p, x0, y0) * (1.0 - ax) + sample(p, x1, y0) * ax;
            let bot = sample(p, x0, y1) * (1.0 - ax) + sample(p, x1, y1) * ax;
            top * (1.0 - ay) + bot * ay
        };
        let q = |v: f32| -> u16 { (v.clamp(0.0, 1.0) * 65535.0 + 0.5) as u16 };
        for y in 0..h {
            for x in 0..w {
                let yy = (sample(&py, x, y) - y_off) * y_scale;
                let cb = (chroma(&pu, x, y) - c_off) * c_scale;
                let cr = (chroma(&pv, x, y) - c_off) * c_scale;
                let i = (y * w + x) * 3;
                out[i] = q(yy + cr_r * cr);
                out[i + 1] = q(yy + cb_g * cb + cr_g * cr);
                out[i + 2] = q(yy + cb_b * cb);
            }
        }
    }
    rotate(Rgb16 { w, h, data: out }, f.rotation)
}

/// Gira en el sentido de las agujas del reloj (lo que dicen los metadatos).
pub fn rotate(img: Rgb16, deg: u32) -> Result<Rgb16, String> {
    let (w, h) = (img.w, img.h);
    let at = |x: usize, y: usize| (y * w + x) * 3;
    let (nw, nh) = match deg {
        0 => return Ok(img),
        90 | 270 => (h, w),
        180 => (w, h),
        _ => return Err(format!("Unsupported rotation {deg}°.")),
    };
    let mut out = vec![0u16; img.data.len()];
    for ny in 0..nh {
        for nx in 0..nw {
            let (x, y) = match deg {
                90 => (ny, h - 1 - nx),
                180 => (w - 1 - nx, h - 1 - ny),
                _ => (w - 1 - ny, nx),
            };
            let (s, d) = (at(x, y), (ny * nw + nx) * 3);
            out[d..d + 3].copy_from_slice(&img.data[s..s + 3]);
        }
    }
    Ok(Rgb16 {
        w: nw,
        h: nh,
        data: out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Un fotograma I420P10 / I444P10 compacto con Y, U y V constantes.
    fn planar_frame(format: &str, w: usize, h: usize, yuv: [u16; 3]) -> (Vec<u8>, Vec<Plane>) {
        let (sx, sy, _, n) = planar(format).unwrap();
        let (cw, ch) = (w.div_ceil(sx), h.div_ceil(sy));
        let sizes = [(w, h), (cw, ch), (cw, ch), (w, h)];
        let mut data = Vec::new();
        let mut planes = Vec::new();
        for (k, &(pw, ph)) in sizes.iter().take(n).enumerate() {
            planes.push(Plane {
                offset: data.len(),
                stride: pw * 2,
            });
            let v = if k < 3 { yuv[k] } else { 1023 };
            for _ in 0..pw * ph {
                data.extend_from_slice(&v.to_le_bytes());
            }
        }
        (data, planes)
    }

    fn convert(format: &str, w: usize, h: usize, yuv: [u16; 3], m: Matrix, full: bool) -> Rgb16 {
        let (data, planes) = planar_frame(format, w, h, yuv);
        to_rgb16(&Frame {
            data: &data,
            format,
            w,
            h,
            planes: &planes,
            matrix: m,
            full_range: full,
            rotation: 0,
        })
        .unwrap()
    }

    #[test]
    fn short_buffer_and_short_stride_are_errors() {
        // 1 y 2
        let (data, mut planes) = planar_frame("I420P10", 8, 8, [512, 512, 512]);
        let f = |d: &[u8], p: &[Plane]| {
            to_rgb16(&Frame {
                data: d,
                format: "I420P10",
                w: 8,
                h: 8,
                planes: p,
                matrix: Matrix::Bt709,
                full_range: false,
                rotation: 0,
            })
        };
        assert!(f(&data[..data.len() - 1], &planes).is_err());
        planes[0].stride = 14;
        assert!(f(&data, &planes).is_err());
    }

    #[test]
    fn odd_sizes_read_inside_the_chroma_planes() {
        // 3: 7×5 en 4:2:0 → croma 4×3; sin pánico y todo el fotograma gris
        let img = convert("I420P10", 7, 5, [502, 512, 512], Matrix::Bt709, false);
        assert_eq!((img.w, img.h), (7, 5));
        assert!(img.data.iter().all(|&v| (v as i32 - 32768).abs() < 200));
    }

    #[test]
    fn oversized_or_unknown_frames_are_errors() {
        // 4 y 5
        let p = [Plane {
            offset: 0,
            stride: 2,
        }; 3];
        let base = |format: &'static str, w: usize, h: usize| Frame {
            data: &[],
            format,
            w,
            h,
            planes: &p,
            matrix: Matrix::Bt709,
            full_range: false,
            rotation: 0,
        };
        assert!(to_rgb16(&base("I420P10", usize::MAX / 2, 3)).is_err());
        let e = to_rgb16(&base("NV12", 2, 2)).err().unwrap();
        assert!(e.contains("NV12"), "{e}");
    }

    #[test]
    fn levels_map_to_the_ends_and_out_of_range_codes_clip() {
        // 6 y 8: rango limitado de 10 bits, negro 64 y blanco 940
        let black = convert("I444P10", 2, 2, [64, 512, 512], Matrix::Bt709, false);
        let white = convert("I444P10", 2, 2, [940, 512, 512], Matrix::Bt709, false);
        assert!(black.data.iter().all(|&v| v == 0));
        assert!(white.data.iter().all(|&v| v == 65535));
        // pie y techo: por debajo de 64 y por encima de 940 se recortan
        let under = convert("I444P10", 2, 2, [4, 512, 512], Matrix::Bt709, false);
        let over = convert("I444P10", 2, 2, [1020, 512, 512], Matrix::Bt709, false);
        assert!(under.data.iter().all(|&v| v == 0));
        assert!(over.data.iter().all(|&v| v == 65535));
        // un valor de 12 bits en un campo de 10 no da la vuelta
        let junk = convert("I444P10", 2, 2, [4000, 512, 512], Matrix::Bt709, false);
        assert!(junk.data.iter().all(|&v| v == 65535));
        // rango completo: 1023 es el blanco
        let full = convert("I444P10", 2, 2, [1023, 512, 512], Matrix::Bt709, true);
        assert!(full.data.iter().all(|&v| v == 65535));
        // y un gris de 10 bits cae entre los dos de 8 que lo rodean: los dos
        // bits de más llegan a la salida
        let g = convert(
            "I444P10",
            2,
            2,
            [64 + 438 + 1, 512, 512],
            Matrix::Bt709,
            false,
        );
        let v8 = g.data[0] as f64 / 257.0;
        assert!(v8.fract() > 0.05 && v8.fract() < 0.95, "{v8}");
    }

    #[test]
    fn each_matrix_gives_its_own_red() {
        // 7: el rojo puro de BT.709 en rango limitado de 10 bits
        let red709 = [250, 409, 960];
        let a = convert("I444P10", 2, 2, red709, Matrix::Bt709, false);
        assert!(
            a.data[0] > 64000 && a.data[1] < 1200 && a.data[2] < 1200,
            "{:?}",
            &a.data[..3]
        );
        let b = convert("I444P10", 2, 2, red709, Matrix::Bt601, false);
        // leído con BT.601 el mismo código pierde un 9 % de rojo
        assert!(
            b.data[0] < 61000,
            "BT.601 must read this red differently: {:?}",
            &b.data[..3]
        );
    }

    #[test]
    fn rotation_moves_the_corner() {
        // 9: 3×2, el píxel (0,0) marcado
        let mut data = vec![0u16; 3 * 2 * 3];
        data[0] = 65535;
        let img = Rgb16 { w: 3, h: 2, data };
        let r90 = rotate(img.clone(), 90).unwrap();
        assert_eq!((r90.w, r90.h), (2, 3));
        assert_eq!(r90.data[3], 65535); // fila 0, columna 1: arriba a la derecha
        let r270 = rotate(img.clone(), 270).unwrap();
        assert_eq!(r270.data[2 * 2 * 3], 65535); // abajo a la izquierda
        let r180 = rotate(img, 180).unwrap();
        assert_eq!(r180.data[5 * 3], 65535);
    }

    #[test]
    fn alpha_plane_is_accepted_and_ignored() {
        // 10
        let img = convert("I420AP10", 4, 4, [940, 512, 512], Matrix::Bt709, false);
        assert!(img.data.iter().all(|&v| v == 65535));
    }

    #[test]
    fn rgb48_passes_through() {
        // 11 y 12
        let vals: [u16; 6] = [1, 2, 3, 65535, 256, 4096];
        let data: Vec<u8> = vals.iter().flat_map(|v| v.to_le_bytes()).collect();
        let p = [Plane {
            offset: 0,
            stride: 12,
        }];
        let img = to_rgb16(&Frame {
            data: &data,
            format: "RGB48LE",
            w: 2,
            h: 1,
            planes: &p,
            matrix: Matrix::Bt709,
            full_range: false,
            rotation: 0,
        })
        .unwrap();
        assert_eq!(img.data, vals);
    }
}
