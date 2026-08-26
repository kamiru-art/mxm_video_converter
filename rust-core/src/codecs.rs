//! Decodificación/codificación de imágenes (PNG/JPEG/TIFF/BMP/WebP).
//! El navegador no decodifica TIFF ni PNG de 16 bits de forma fiable: aquí
//! se hace en Rust, conservando la profundidad de los escaneos.

use crate::img::{DynImg, Gray, Rgb, Rgb16};
use image::{DynamicImage, ImageFormat};

pub const MAX_DECODE_PIXELS: u64 = 250_000_000;

/// Decodifica bytes de un archivo de imagen a DynImg (8 o 16 bits RGB).
/// Devuelve además si tenía canal alfa (se aplana sobre blanco).
pub fn decode(bytes: &[u8]) -> Result<(DynImg, bool), String> {
    let fmt = image::guess_format(bytes).map_err(|e| format!("Unrecognized format: {e}"))?;
    // tope de píxeles contra bombas de descompresión
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes));
    reader.set_format(fmt);
    reader.limits({
        let mut l = image::Limits::default();
        l.max_image_width = Some(65536);
        l.max_image_height = Some(65536);
        l.max_alloc = Some(MAX_DECODE_PIXELS * 8);
        l
    });
    let img = reader.decode().map_err(|e| format!("Could not decode the image: {e}"))?;
    let (w, h) = (img.width() as u64, img.height() as u64);
    if w * h > MAX_DECODE_PIXELS {
        return Err(format!("Image too large ({w}×{h})."));
    }
    let has_alpha = img.color().has_alpha();
    let sixteen = img.color().bits_per_pixel() / img.color().channel_count() as u16 > 8;
    if sixteen {
        let rgba = img.to_rgba16();
        let (w, h) = (rgba.width() as usize, rgba.height() as usize);
        let mut data = Vec::with_capacity(w * h * 3);
        for p in rgba.pixels() {
            let a = p[3] as u32;
            for c in 0..3 {
                data.push(((p[c] as u32 * a + 65535 * (65535 - a)) / 65535) as u16);
            }
        }
        Ok((DynImg::U16(Rgb16 { w, h, data }), has_alpha))
    } else {
        let rgba = img.to_rgba8();
        let (w, h) = (rgba.width() as usize, rgba.height() as usize);
        let mut data = Vec::with_capacity(w * h * 3);
        for p in rgba.pixels() {
            let a = p[3] as u32;
            for c in 0..3 {
                data.push(((p[c] as u32 * a + 255 * (255 - a)) / 255) as u8);
            }
        }
        Ok((DynImg::U8(Rgb { w, h, data }), has_alpha))
    }
}

/// Codifica una imagen RGB de 8 bits a PNG.
pub fn encode_png_rgb(img: &Rgb) -> Vec<u8> {
    let buf = image::RgbImage::from_raw(img.w as u32, img.h as u32, img.data.clone()).unwrap();
    let mut out = Vec::new();
    DynamicImage::ImageRgb8(buf)
        .write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)
        .expect("PNG en memoria");
    out
}

/// Codifica conservando la profundidad (PNG de 16 bits si aplica).
pub fn encode_png_dyn(img: &DynImg) -> Vec<u8> {
    match img {
        DynImg::U8(i) => encode_png_rgb(i),
        DynImg::U16(i) => {
            let buf =
                image::ImageBuffer::<image::Rgb<u16>, Vec<u16>>::from_raw(i.w as u32, i.h as u32, i.data.clone())
                    .unwrap();
            let mut out = Vec::new();
            DynamicImage::ImageRgb16(buf)
                .write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)
                .expect("PNG16 en memoria");
            out
        }
    }
}

/// JPEG para miniaturas e informes (calidad 82 como la app original).
pub fn encode_jpeg_rgb(img: &Rgb, quality: u8) -> Vec<u8> {
    let buf = image::RgbImage::from_raw(img.w as u32, img.h as u32, img.data.clone()).unwrap();
    let mut out = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut out);
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
        enc.encode_image(&DynamicImage::ImageRgb8(buf)).expect("JPEG en memoria");
    }
    out
}

/// Decodifica a Gray de 8 bits (conveniencia para pruebas).
pub fn decode_gray(bytes: &[u8]) -> Result<Gray, String> {
    let (d, _) = decode(bytes)?;
    Ok(d.to_rgb8().to_gray())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_roundtrip_8bit() {
        let img = Rgb::new(20, 10, [10, 200, 30]);
        let png = encode_png_rgb(&img);
        let (dec, alpha) = decode(&png).unwrap();
        assert!(!alpha);
        match dec {
            DynImg::U8(i) => assert_eq!(i.px(5, 5), [10, 200, 30]),
            _ => panic!("debería ser de 8 bits"),
        }
    }

    #[test]
    fn png_roundtrip_16bit() {
        let img = Rgb16 { w: 8, h: 8, data: vec![0x1234; 8 * 8 * 3] };
        let png = encode_png_dyn(&DynImg::U16(img));
        let (dec, _) = decode(&png).unwrap();
        match dec {
            DynImg::U16(i) => assert_eq!(i.data[0], 0x1234),
            _ => panic!("debería conservar 16 bits"),
        }
    }
}
