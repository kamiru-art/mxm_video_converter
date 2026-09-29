//! Fotogramas del video final: todos al mismo tamaño y a la misma
//! profundidad, SIN bajar nunca de la que traen.
//!
//! El video sin pérdida es una secuencia de PNG, y cada PNG tiene que
//! describir el mismo lienzo. Lo que llega es de todo: recortes de 8 o de 16
//! bits, con o sin alfa, TIFF y PNG sueltos que el usuario añade, y a veces
//! tamaños que no coinciden. Antes esto lo hacía el navegador: decodificaba
//! con `createImageBitmap` (siempre a 8 bits, y con la gestión de color del
//! navegador de por medio), remuestreaba cualquier diferencia de tamaño, y
//! un TIFF de 16 bits salía convertido en un PNG de 8. Aquí:
//!
//! - la profundidad se decide para la secuencia entera (`sixteen`), y sólo
//!   se ensancha: 8 → 16 bits es exacto (v · 257), nunca al revés;
//! - una diferencia de tamaño pequeña (hasta el 1 %, o 4 px) se resuelve
//!   centrando el fotograma en el lienzo, píxel a píxel, sin remuestrear;
//! - sólo un fotograma de otro tamaño de verdad se encaja con Lanczos3,
//!   en su profundidad.

use crate::codecs::{decode_checked, encode_png};
use image::imageops::{self, FilterType};
use image::{DynamicImage, ImageBuffer, ImageDecoder, ImageFormat, Pixel, Rgb, Rgba};

/// Lo que dice la cabecera de una imagen, sin decodificar los píxeles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageInfo {
    pub w: u32,
    pub h: u32,
    /// Más de 8 bits por canal.
    pub sixteen: bool,
    pub alpha: bool,
    pub png: bool,
}

/// Cabecera de una imagen: tamaño, profundidad y alfa, sin tocar los píxeles
/// (para un TIFF de 16 bits de 4K son 50 MB que no hace falta mover).
pub fn probe(bytes: &[u8]) -> Result<ImageInfo, String> {
    let fmt = image::guess_format(bytes).map_err(|e| format!("Unrecognized format: {e}"))?;
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes));
    reader.set_format(fmt);
    let dec = reader
        .into_decoder()
        .map_err(|e| format!("Could not read the image header: {e}"))?;
    let (w, h) = dec.dimensions();
    let color = dec.color_type();
    Ok(ImageInfo {
        w,
        h,
        sixteen: color.bits_per_pixel() / color.channel_count() as u16 > 8,
        alpha: color.has_alpha(),
        png: fmt == ImageFormat::Png,
    })
}

/// ¿Basta con centrar? Hasta el 1 % del lado, o 4 px, no merece un
/// remuestreo (que desplaza toda la imagen una fracción de píxel y la
/// ablanda): se pierde, como mucho, una franja de borde de 2 px.
fn near(a: u32, b: u32) -> bool {
    a.abs_diff(b) <= (b / 100).max(4)
}

/// `src` en un lienzo `ow`×`oh` de color `bg`: tal cual si mide lo mismo,
/// centrado si casi, encajado con Lanczos3 (conservando el aspecto) si no.
fn place<P>(
    src: ImageBuffer<P, Vec<P::Subpixel>>,
    ow: u32,
    oh: u32,
    bg: P,
) -> ImageBuffer<P, Vec<P::Subpixel>>
where
    P: Pixel + 'static,
{
    let (w, h) = src.dimensions();
    if (w, h) == (ow, oh) {
        return src;
    }
    let placed = if near(w, ow) && near(h, oh) {
        src
    } else {
        let s = (ow as f64 / w as f64).min(oh as f64 / h as f64);
        let nw = ((w as f64 * s).round() as u32).clamp(1, ow);
        let nh = ((h as f64 * s).round() as u32).clamp(1, oh);
        imageops::resize(&src, nw, nh, FilterType::Lanczos3)
    };
    let mut canvas = ImageBuffer::from_pixel(ow, oh, bg);
    let dx = (ow as i64 - placed.width() as i64) / 2;
    let dy = (oh as i64 - placed.height() as i64) / 2;
    imageops::replace(&mut canvas, &placed, dx, dy);
    canvas
}

/// Aplana el alfa sobre blanco (el papel), en la profundidad de `P`.
fn flatten<T>(src: ImageBuffer<Rgba<T>, Vec<T>>, max: u32) -> ImageBuffer<Rgb<T>, Vec<T>>
where
    T: image::Primitive + Into<u32> + TryFrom<u32> + 'static,
    Rgba<T>: Pixel<Subpixel = T>,
    Rgb<T>: Pixel<Subpixel = T>,
{
    let (w, h) = src.dimensions();
    let mut out = ImageBuffer::<Rgb<T>, Vec<T>>::new(w, h);
    for (d, s) in out.pixels_mut().zip(src.pixels()) {
        let a: u32 = s[3].into();
        for c in 0..3 {
            let v: u32 = s[c].into();
            let mixed = (v * a + max * (max - a) + max / 2) / max;
            d[c] = T::try_from(mixed).ok().unwrap_or(T::DEFAULT_MAX_VALUE);
        }
    }
    out
}

/// Decodifica `bytes` (PNG, TIFF, JPEG, WebP, BMP) y lo devuelve como PNG de
/// `ow`×`oh`, de 16 bits por canal si `sixteen`, con alfa si `alpha` (el
/// relleno es transparente) o aplanado sobre blanco si no.
pub fn conform_png(
    bytes: &[u8],
    ow: u32,
    oh: u32,
    sixteen: bool,
    alpha: bool,
) -> Result<Vec<u8>, String> {
    if ow == 0 || oh == 0 || !crate::scanproc::fits_image_budget(ow as u64, oh as u64) {
        return Err(format!("Impossible output size ({ow}×{oh})."));
    }
    let img = decode_checked(bytes)?.img;
    let out = match (sixteen, alpha) {
        (true, true) => {
            DynamicImage::ImageRgba16(place(img.into_rgba16(), ow, oh, Rgba([0, 0, 0, 0])))
        }
        (false, true) => {
            DynamicImage::ImageRgba8(place(img.into_rgba8(), ow, oh, Rgba([0, 0, 0, 0])))
        }
        (true, false) => {
            let rgb = if img.color().has_alpha() {
                flatten(img.into_rgba16(), 65535)
            } else {
                img.into_rgb16()
            };
            DynamicImage::ImageRgb16(place(rgb, ow, oh, Rgb([65535; 3])))
        }
        (false, false) => {
            let rgb = if img.color().has_alpha() {
                flatten(img.into_rgba8(), 255)
            } else {
                img.into_rgb8()
            };
            DynamicImage::ImageRgb8(place(rgb, ow, oh, Rgb([255; 3])))
        }
    };
    encode_png(out)
}

#[cfg(test)]
mod tests {
    // Lo que puede fallar, escrito antes que el código:
    // 1. un 16 bits sale en 8 (la pérdida que motivó el módulo);
    // 2. un 8 bits ensanchado a 16 no es exacto (v·257) y cambia el color;
    // 3. una diferencia de 1–2 px se remuestrea en vez de centrarse;
    // 4. el alfa se pierde cuando se pidió, o se deja cuando no;
    // 5. un TIFF de 16 bits pasa por aquí como 8 bits.
    use super::*;
    use crate::codecs::encode_tiff_dyn;
    use crate::img::{DynImg, Rgb16};

    fn png16(w: u32, h: u32, f: impl Fn(u32, u32) -> [u16; 3]) -> Vec<u8> {
        let img = ImageBuffer::<Rgb<u16>, Vec<u16>>::from_fn(w, h, |x, y| Rgb(f(x, y)));
        let mut out = Vec::new();
        DynamicImage::ImageRgb16(img)
            .write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    fn decode16(png: &[u8]) -> ImageBuffer<Rgb<u16>, Vec<u16>> {
        let img = image::load_from_memory(png).unwrap();
        assert!(
            matches!(img, DynamicImage::ImageRgb16(_)),
            "expected RGB16, got {:?}",
            img.color()
        );
        img.into_rgb16()
    }

    #[test]
    fn sixteen_bit_survives_and_small_size_difference_is_centred_not_resampled() {
        // valores que en 8 bits colapsarían (difieren en el byte bajo)
        let src = png16(98, 50, |x, y| {
            [x as u16 * 7 + 1, y as u16 * 13 + 2, 0x1234 + x as u16]
        });
        let out = decode16(&conform_png(&src, 100, 50, true, false).unwrap());
        assert_eq!(out.dimensions(), (100, 50));
        // centrado: columna 0 blanca, la 1 es la 0 del original, sin mezcla
        assert_eq!(out.get_pixel(0, 10).0, [65535; 3]);
        assert_eq!(out.get_pixel(1, 10).0, [1, 10 * 13 + 2, 0x1234]);
        assert_eq!(
            out.get_pixel(50, 7).0,
            [49 * 7 + 1, 7 * 13 + 2, 0x1234 + 49]
        );
    }

    #[test]
    fn eight_bit_widens_exactly_when_the_sequence_is_sixteen() {
        let img = ImageBuffer::<Rgb<u8>, Vec<u8>>::from_fn(4, 4, |x, y| {
            Rgb([x as u8 * 60, y as u8 * 3, 255])
        });
        let mut png = Vec::new();
        DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();
        let out = decode16(&conform_png(&png, 4, 4, true, false).unwrap());
        assert_eq!(out.get_pixel(3, 2).0, [180 * 257, 6 * 257, 65535]);
    }

    #[test]
    fn tiff_sixteen_keeps_its_depth() {
        let tif = encode_tiff_dyn(&DynImg::U16(Rgb16 {
            w: 3,
            h: 2,
            data: vec![
                0x0102, 0x0304, 0x0506, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
            ],
        }));
        let info = probe(&tif).unwrap();
        assert_eq!(
            info,
            ImageInfo {
                w: 3,
                h: 2,
                sixteen: true,
                alpha: false,
                png: false
            }
        );
        let out = decode16(&conform_png(&tif, 3, 2, true, false).unwrap());
        assert_eq!(out.get_pixel(0, 0).0, [0x0102, 0x0304, 0x0506]);
        assert_eq!(out.get_pixel(2, 1).0, [19, 20, 21]);
    }

    #[test]
    fn alpha_is_kept_when_asked_and_flattened_on_white_when_not() {
        let img = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_fn(2, 1, |x, _| {
            if x == 0 {
                Rgba([10, 20, 30, 0])
            } else {
                Rgba([200, 100, 50, 255])
            }
        });
        let mut png = Vec::new();
        DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();
        let kept = image::load_from_memory(&conform_png(&png, 2, 1, false, true).unwrap()).unwrap();
        assert_eq!(kept.to_rgba8().get_pixel(0, 0).0, [10, 20, 30, 0]);
        let flat =
            image::load_from_memory(&conform_png(&png, 2, 1, false, false).unwrap()).unwrap();
        assert!(matches!(flat, DynamicImage::ImageRgb8(_)));
        assert_eq!(flat.to_rgb8().get_pixel(0, 0).0, [255, 255, 255]);
        assert_eq!(flat.to_rgb8().get_pixel(1, 0).0, [200, 100, 50]);
    }

    #[test]
    fn a_really_different_size_is_fitted_keeping_the_aspect() {
        let src = png16(50, 25, |_, _| [30000, 20000, 10000]);
        let out = decode16(&conform_png(&src, 100, 100, true, false).unwrap());
        // 50×25 → 100×50 centrado en vertical: bandas blancas arriba y abajo
        assert_eq!(out.get_pixel(50, 10).0, [65535; 3]);
        let mid = out.get_pixel(50, 50).0;
        for (c, want) in mid.iter().zip([30000u16, 20000, 10000]) {
            assert!(c.abs_diff(want) <= 2, "{mid:?}");
        }
    }
}
