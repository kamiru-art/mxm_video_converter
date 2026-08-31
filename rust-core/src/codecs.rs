//! Decodificación/codificación de imágenes (PNG/JPEG/TIFF/BMP/WebP).
//! El navegador no decodifica TIFF ni PNG de 16 bits de forma fiable: aquí
//! se hace en Rust, conservando la profundidad de los escaneos.

use crate::img::{DynImg, Rgb, Rgb16};
use image::{DynamicImage, ImageFormat};

pub const MAX_DECODE_PIXELS: u64 = MAX_CORE_PIXELS;

/// Techo de memoria del núcleo, y el motivo de que exista: `wasm32` direcciona
/// 4 GiB COMO MÁXIMO, tenga la máquina la RAM que tenga, y el navegador falla
/// bastante antes de llegar al tope. Todo se mide contra esto y no contra un
/// número de píxeles, porque lo que agota la memoria es la profundidad de bits
/// tanto como el tamaño: el mismo escaneo en 16 bits pesa el doble.
pub const MAX_CORE_BYTES: u64 = 3 * 1024 * 1024 * 1024;

/// Tope de píxeles, derivado del de bytes: el caso más barato que el núcleo
/// procesa entero son 8 bits (3 B/px) y el enderezado necesita dos copias
/// vivas a la vez, así que 3 GiB / 6 B/px es el mayor lienzo que puede
/// recorrer el pipeline completo.
pub const MAX_CORE_PIXELS: u64 = MAX_CORE_BYTES / 6;

/// Tope del pico de decodificado. Es el mismo techo: decodificar es la primera
/// mitad, y la comprobación del enderezado (scanproc) cubre la segunda.
pub const MAX_DECODE_BYTES: u64 = MAX_CORE_BYTES;

/// Bytes vivos en el pico del decodificado. Depende del camino, y esa es toda
/// la diferencia entre aceptar un escaneo profesional y rechazarlo:
/// sin alfa y ya en RGB, `into_rgb*` se LLEVA el búfer y no se paga nada;
/// sin alfa pero con conversión (gris, paleta), origen y destino conviven;
/// con alfa hay que aplanar, y eso sí cuesta un RGBA intermedio más la salida
/// mientras el original sigue vivo.
fn decode_peak_bytes(
    w: u64,
    h: u64,
    src_bytes_per_px: u64,
    out_bytes_per_px: u64,
    has_alpha: bool,
    already_rgb: bool,
) -> u64 {
    let per_px = if has_alpha {
        let rgba = if out_bytes_per_px == 6 { 8 } else { 4 };
        src_bytes_per_px + rgba + out_bytes_per_px
    } else if already_rgb {
        src_bytes_per_px
    } else {
        src_bytes_per_px + out_bytes_per_px
    };
    w.saturating_mul(h).saturating_mul(per_px)
}

/// Decodifica y comprueba los topes, sin tocar todavía el alfa. Lo comparten
/// los dos caminos: el de escaneos, que quiere RGB opaco, y el de fotogramas,
/// que quiere conservar el alfa.
struct Decoded {
    img: DynamicImage,
    sixteen: bool,
    has_alpha: bool,
}

fn decode_checked(bytes: &[u8]) -> Result<Decoded, String> {
    let fmt = image::guess_format(bytes).map_err(|e| format!("Unrecognized format: {e}"))?;
    // tope de píxeles contra bombas de descompresión
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes));
    reader.set_format(fmt);
    reader.limits({
        let mut l = image::Limits::default();
        l.max_image_width = Some(65536);
        l.max_image_height = Some(65536);
        // max_alloc cubre el búfer de salida del decodificador (en los que lo
        // respetan), no lo que gasta el aplanado posterior: eso se comprueba
        // aparte, en cuanto se conoce la profundidad real.
        l.max_alloc = Some(MAX_DECODE_BYTES);
        l
    });
    let img = reader.decode().map_err(|e| format!("Could not decode the image: {e}"))?;
    let (w, h) = (img.width() as u64, img.height() as u64);
    if w * h > MAX_DECODE_PIXELS {
        return Err(format!("Image too large ({w}×{h})."));
    }
    let color = img.color();
    let has_alpha = color.has_alpha();
    let sixteen = color.bits_per_pixel() / color.channel_count() as u16 > 8;
    let already_rgb = matches!(color, image::ColorType::Rgb8 | image::ColorType::Rgb16);
    let peak =
        decode_peak_bytes(w, h, color.bytes_per_pixel() as u64, if sixteen { 6 } else { 3 }, has_alpha, already_rgb);
    if peak > MAX_DECODE_BYTES {
        return Err(format!(
            "Image too heavy to decode ({w}×{h} at {} bits per channel needs about {} MB, and the \
             browser can address at most {} MB). Scan it at a lower dpi, or at 8 bits per channel.",
            if sixteen { 16 } else { 8 },
            peak / (1024 * 1024),
            MAX_CORE_BYTES / (1024 * 1024)
        ));
    }
    Ok(Decoded { img, sixteen, has_alpha })
}

/// Decodifica bytes de un archivo de imagen a DynImg (8 o 16 bits RGB),
/// aplanando el alfa sobre blanco. Devuelve además si tenía canal alfa.
/// Es el camino de los ESCANEOS: un escaneo no tiene transparencia, y si la
/// trae es ruido del formato, así que blanco (el papel) es la respuesta.
pub fn decode(bytes: &[u8]) -> Result<(DynImg, bool), String> {
    let Decoded { img, sixteen, has_alpha } = decode_checked(bytes)?;

    // Camino rápido, y es el de TODOS los escaneos: sin alfa no hay nada que
    // aplanar, así que into_rgb16/into_rgb8 se LLEVA el búfer en vez de
    // copiarlo. Antes se construía un RGBA intermedio siempre: dos copias
    // enteras de más, y en 16 bits eso es la diferencia entre pedir 20 bytes
    // por píxel y pedir 6. Un A3 de 16 bits a 600 dpi necesitaba 1,39 GB para
    // entregar 0,42 GB, y por eso un escaneo profesional no cabía.
    if !has_alpha {
        return Ok((
            if sixteen {
                let b = img.into_rgb16();
                let (w, h) = (b.width() as usize, b.height() as usize);
                DynImg::U16(Rgb16 { w, h, data: b.into_raw() })
            } else {
                let b = img.into_rgb8();
                let (w, h) = (b.width() as usize, b.height() as usize);
                DynImg::U8(Rgb { w, h, data: b.into_raw() })
            },
            false,
        ));
    }

    let bg = [255u8, 255, 255];
    if sixteen {
        // el fondo llega en 8 bits: 0..255 → 0..65535
        let bg16 = [bg[0] as u32 * 257, bg[1] as u32 * 257, bg[2] as u32 * 257];
        let rgba = img.to_rgba16();
        let (w, h) = (rgba.width() as usize, rgba.height() as usize);
        let mut data = Vec::with_capacity(w * h * 3);
        for p in rgba.pixels() {
            let a = p[3] as u32;
            for c in 0..3 {
                data.push(((p[c] as u32 * a + bg16[c] * (65535 - a)) / 65535) as u16);
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
                data.push(((p[c] as u32 * a + bg[c] as u32 * (255 - a)) / 255) as u8);
            }
        }
        Ok((DynImg::U8(Rgb { w, h, data }), has_alpha))
    }
}

/// Decodifica a RGBA de 8 bits CONSERVANDO el alfa. Es el camino de los
/// FOTOGRAMAS, y el alfa tiene que llegar vivo hasta aquí: el color de fondo
/// lo elige el usuario ("alpha over colour") y se aplica al componer la hoja,
/// en sheet::flatten_rgba con alpha_base_color. Aplanarlo al decodificar
/// congelaba esa elección en el momento de cargar el archivo y, peor, hacía
/// que un TIFF se comportara distinto de un PNG, que el navegador decodifica
/// con su alfa intacto: el mismo ajuste funcionaba o no según el formato.
/// Devuelve (rgba, w, h, era_de_16_bits, tenía_alfa).
pub fn decode_rgba8(bytes: &[u8]) -> Result<(Vec<u8>, usize, usize, bool, bool), String> {
    let Decoded { img, sixteen, has_alpha } = decode_checked(bytes)?;
    // into_ y no to_: la imagen es nuestra, así que un RGBA8 de origen se
    // mueve en vez de duplicarse
    let rgba = img.into_rgba8();
    let (w, h) = (rgba.width() as usize, rgba.height() as usize);
    Ok((rgba.into_raw(), w, h, sixteen, has_alpha))
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

/// TIFF conservando la profundidad (para imprentas que piden TIFF).
pub fn encode_tiff_dyn(img: &DynImg) -> Vec<u8> {
    let mut out = Vec::new();
    match img {
        DynImg::U8(i) => {
            let buf = image::RgbImage::from_raw(i.w as u32, i.h as u32, i.data.clone()).unwrap();
            DynamicImage::ImageRgb8(buf)
                .write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Tiff)
                .expect("TIFF en memoria");
        }
        DynImg::U16(i) => {
            let buf = image::ImageBuffer::<image::Rgb<u16>, Vec<u16>>::from_raw(
                i.w as u32,
                i.h as u32,
                i.data.clone(),
            )
            .unwrap();
            DynamicImage::ImageRgb16(buf)
                .write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Tiff)
                .expect("TIFF16 en memoria");
        }
    }
    out
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
    fn tiff_roundtrip_8bit() {
        let img = Rgb::new(24, 12, [90, 40, 210]);
        let tif = encode_tiff_dyn(&DynImg::U8(img));
        let (dec, _) = decode(&tif).unwrap();
        match dec {
            DynImg::U8(i) => assert_eq!(i.px(3, 3), [90, 40, 210]),
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

    fn rgba8_png(px: [u8; 4]) -> Vec<u8> {
        let buf = image::RgbaImage::from_pixel(4, 4, image::Rgba(px));
        let mut out = Vec::new();
        DynamicImage::ImageRgba8(buf)
            .write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn frame_decoding_keeps_the_alpha_channel() {
        // El camino de fotogramas NO aplana: el usuario elige el color de
        // fondo y se aplica al componer la hoja. Antes salía blanco de aquí y
        // la elección no se notaba en TIFF ni en PNG de 16 bits.
        let png = rgba8_png([10, 20, 30, 0]);
        let (rgba, w, h, sixteen, alpha) = decode_rgba8(&png).unwrap();
        assert!(alpha && !sixteen && w == 4 && h == 4);
        assert_eq!(&rgba[0..4], &[10, 20, 30, 0], "el alfa tiene que llegar vivo");

        // y el camino de escaneos sigue aplanando sobre blanco
        match decode(&png).unwrap().0 {
            DynImg::U8(i) => assert_eq!(i.px(1, 1), [255, 255, 255]),
            _ => panic!("debería ser de 8 bits"),
        }
    }

    #[test]
    fn frame_decoding_keeps_the_alpha_channel_16bit() {
        let buf = image::ImageBuffer::<image::Rgba<u16>, Vec<u16>>::from_pixel(
            4,
            4,
            image::Rgba([1000, 2000, 3000, 0]),
        );
        let mut png = Vec::new();
        DynamicImage::ImageRgba16(buf)
            .write_to(&mut std::io::Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();
        // decode_rgba8 baja a 8 bits (es para mostrar y para fotogramas), pero
        // el alfa sigue siendo el del archivo y `sixteen` avisa del origen
        let (rgba, _, _, sixteen, alpha) = decode_rgba8(&png).unwrap();
        assert!(alpha && sixteen);
        assert_eq!(rgba[3], 0, "el alfa tiene que llegar vivo");

        match decode(&png).unwrap().0 {
            DynImg::U16(i) => assert_eq!(&i.data[0..3], &[65535, 65535, 65535]),
            _ => panic!("debería conservar 16 bits"),
        }
    }

    #[test]
    fn professional_scans_fit_and_the_budget_is_measured_in_bytes() {
        // El requisito: A4 a 1200 dpi en 16 bits, que es donde trabaja el
        // encargo profesional. Sin alfa y ya en RGB, into_rgb16 se lleva el
        // búfer, así que el pico es UNA copia y no tres.
        let (w, h) = (9921u64, 14031u64);
        let una_copia = w * h * 6;
        assert_eq!(decode_peak_bytes(w, h, 6, 6, false, true), una_copia);
        assert!(decode_peak_bytes(w, h, 6, 6, false, true) <= MAX_DECODE_BYTES, "A4@1200 16 bits tiene que entrar");
        // Y así es como se rechazaba antes: el cálculo viejo suponía un RGBA
        // intermedio SIEMPRE (20 B/px en 16 bits) contra un tope de 1 GiB.
        const TOPE_VIEJO: u64 = 1024 * 1024 * 1024;
        assert!(w * h * 20 > TOPE_VIEJO, "2,59 GiB pedidos contra 1 GiB de tope");
        assert!(una_copia <= TOPE_VIEJO, "y solo hacían falta 0,78 GiB");

        // A3 a 600 dpi en 16 bits, que también se rechazaba, ahora entra
        assert!(decode_peak_bytes(7016, 9921, 6, 6, false, true) <= MAX_DECODE_BYTES);

        // el alfa sí paga el aplanado: original + RGBA + salida
        assert_eq!(decode_peak_bytes(10, 10, 8, 6, true, false), 100 * (8 + 8 + 6));
        // y una conversión sin alfa paga origen + destino, no más
        assert_eq!(decode_peak_bytes(10, 10, 2, 6, false, false), 100 * (2 + 6));

        // lo que sigue sin caber, porque wasm32 no lo puede direccionar
        assert!(decode_peak_bytes(23386, 33071, 6, 6, false, true) > MAX_DECODE_BYTES, "A3@2000 16 bits no cabe");
    }
}
