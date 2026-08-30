//! Códigos QR: generación (corrección H) y decodificación robusta.
//! El payload compacto v2 se mantiene: "K2|proyecto|hoja|celda|etiqueta"
//! (el prefijo se conserva por compatibilidad con proyectos existentes).

use crate::img::{resize_gray, Filter, Gray};
use crate::imgproc::{adaptive_threshold_inv, otsu_threshold, threshold_binary};
use qrcode::{EcLevel, QrCode};

pub const QR_PREFIX: &str = "K2";

pub fn qr_payload(project: &str, sheet_num: i64, cell_idx: i64, label: &str) -> String {
    let proj = project.replace('|', "/");
    let lab = label.replace('|', "/");
    format!("{QR_PREFIX}|{proj}|{sheet_num}|{cell_idx}|{lab}")
}

#[derive(Debug, Clone, PartialEq)]
pub struct QrIdentity {
    pub proyecto: Option<String>,
    pub hoja: Option<i64>,
    pub celda: Option<i64>,
    pub etiqueta: String,
}

pub fn parse_qr_payload(text: &str) -> Option<QrIdentity> {
    if text.is_empty() {
        return None;
    }
    let parts: Vec<&str> = text.split('|').collect();
    if parts.len() == 5 && parts[0] == QR_PREFIX {
        if let (Ok(h), Ok(c)) = (parts[2].parse::<i64>(), parts[3].parse::<i64>()) {
            return Some(QrIdentity {
                proyecto: Some(parts[1].to_string()),
                hoja: Some(h),
                celda: Some(c),
                etiqueta: parts[4].to_string(),
            });
        }
        return None;
    }
    // QRs v1: solo el nombre del frame
    Some(QrIdentity { proyecto: None, hoja: None, celda: None, etiqueta: text.to_string() })
}

/// Genera un QR con corrección H y zona de silencio de 2 módulos, reescalado
/// NEAREST al tamaño pedido (como la app original).
pub fn qr_image(text: &str, size_px: usize, inverted: bool) -> Gray {
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::H)
        .unwrap_or_else(|_| QrCode::new(b"?").unwrap());
    let n = code.width();
    let border = 2usize;
    let total = n + 2 * border;
    let mut out = Gray::new(size_px, size_px, 255);
    for y in 0..size_px {
        let my = y * total / size_px;
        for x in 0..size_px {
            let mx = x * total / size_px;
            let dark = if my < border || mx < border || my >= border + n || mx >= border + n {
                false
            } else {
                code[(mx - border, my - border)] == qrcode::Color::Dark
            };
            let mut v = if dark { 0u8 } else { 255u8 };
            if inverted {
                v = 255 - v;
            }
            out.data[y * size_px + x] = v;
        }
    }
    out
}

fn try_decode(gray: &Gray) -> Option<String> {
    let mut img = rqrr::PreparedImage::prepare_from_greyscale(gray.w, gray.h, |x, y| gray.at(x, y));
    for grid in img.detect_grids() {
        if let Ok((_, content)) = grid.decode() {
            if !content.is_empty() {
                return Some(content);
            }
        }
    }
    None
}

/// Decodifica un QR probando varias mejoras de imagen (gris ampliado, Otsu,
/// umbral adaptativo, polaridad invertida) — port del pipeline original.
/// Tope de píxeles del recorte una vez ampliado (2 Mpx ~ 1414×1414, de sobra
/// para cualquier QR real: uno de 10 mm a 600 ppp ocupa unos 236 px).
const MAX_UPSCALE_PIXELS: usize = 2_000_000;

/// Cuántas veces ampliar un recorte de w×h antes de buscar el QR. Devuelve 1
/// cuando no hay que tocarlo.
fn upscale_factor(w: usize, h: usize) -> usize {
    let short = w.min(h);
    if short == 0 || short >= 360 {
        return 1;
    }
    let mut k = ((400.0 / short as f32).round() as usize).max(2);
    let area = w.saturating_mul(h);
    while k > 1 && area.saturating_mul(k * k) > MAX_UPSCALE_PIXELS {
        k -= 1;
    }
    k
}

pub fn decode_qr(gray: &Gray) -> Option<String> {
    if gray.w < 8 || gray.h < 8 {
        return None;
    }
    let mut variants: Vec<Gray> = Vec::new();
    let mut base = gray.clone();
    // El factor sale del lado CORTO y se aplica a los dos, así que el área
    // crece con su cuadrado: una bbox alargada de 4000×10 daba k=40, o sea
    // 64 Mpx — y de ahí salen siete variantes más un desenfoque en f32. Las
    // bboxes vienen del layout.json, que se comparte entre usuarios, así que
    // el tope no es una precaución teórica.
    let k = upscale_factor(base.w, base.h);
    if k > 1 {
        base = resize_gray(&base, base.w * k, base.h * k, Filter::Triangle);
    }
    variants.push(base.clone());
    let t = otsu_threshold(&base);
    variants.push(threshold_binary(&base, t));
    // Nitidez (unsharp): los módulos ablandados por remuestreo bicúbico
    // recuperan contraste — clave para QRs de ~2 px/módulo re-warpeados.
    let sharp = {
        let blur = crate::imgproc::gaussian_blur_gray(&base, 2.0);
        let mut d = base.clone();
        for i in 0..d.data.len() {
            let v = base.data[i] as f32 + 1.2 * (base.data[i] as f32 - blur.data[i] as f32);
            d.data[i] = v.round().clamp(0.0, 255.0) as u8;
        }
        d
    };
    variants.push(threshold_binary(&sharp, otsu_threshold(&sharp)));
    variants.push(sharp);
    let bs = ((base.w.min(base.h) / 6) | 1).max(31);
    let adap = adaptive_threshold_inv(&base, bs, 5.0);
    // adaptive_threshold_inv marca lo OSCURO como 255: invertir para binario normal
    variants.push(adap.invert());
    // polaridad invertida (QR claro sobre fondo oscuro)
    variants.push(base.invert());
    variants.push(threshold_binary(&base, t).invert());

    for v in &variants {
        if let Some(s) = try_decode(v) {
            return Some(s);
        }
    }
    None
}

/// Variante RGB: prueba luminancia y canal rojo (clave en cianotipia:
/// el azul de Prusia es casi negro en el canal rojo).
pub fn decode_qr_rgb(rgb: &crate::img::Rgb) -> Option<String> {
    if let Some(s) = decode_qr(&rgb.to_gray()) {
        return Some(s);
    }
    decode_qr(&rgb.red_channel())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_roundtrip() {
        let p = qr_payload("mi proyecto", 3, 7, "abc_012");
        let id = parse_qr_payload(&p).unwrap();
        assert_eq!(id.proyecto.as_deref(), Some("mi proyecto"));
        assert_eq!(id.hoja, Some(3));
        assert_eq!(id.celda, Some(7));
        assert_eq!(id.etiqueta, "abc_012");
        // v1
        let id = parse_qr_payload("nombre_suelto").unwrap();
        assert_eq!(id.hoja, None);
        assert_eq!(id.etiqueta, "nombre_suelto");
    }

    #[test]
    fn qr_encode_decode_roundtrip() {
        let text = qr_payload("proj", 1, 0, "abc_001");
        let img = qr_image(&text, 240, false);
        let got = decode_qr(&img).expect("QR debería decodificarse");
        assert_eq!(got, text);
    }

    #[test]
    fn qr_decode_inverted() {
        let text = qr_payload("proj", 2, 5, "xy_9");
        let img = qr_image(&text, 240, true); // invertido (negativo)
        let got = decode_qr(&img).expect("QR invertido debería decodificarse");
        assert_eq!(got, text);
    }
}

#[cfg(test)]
mod debug_tests {
    use super::*;
    use crate::img::{resize_gray, Filter};

    #[test]
    fn small_qr_sizes_decode() {
        for size in [40usize, 47, 59, 70, 100] {
            let text = format!("KQR|{size}");
            let img = qr_image(&text, size, false);
            let got = decode_qr(&img);
            println!("size={size} -> {:?}", got);
        }
        // y con padding blanco alrededor (como el crop del análisis)
        let img = qr_image("KQR|8", 47, false);
        let mut padded = Gray::new(75, 75, 255);
        for y in 0..47 { for x in 0..47 { padded.data[(y+14)*75 + (x+14)] = img.at(x, y); } }
        println!("padded 47 -> {:?}", decode_qr(&padded));
        let up = resize_gray(&padded, 300, 300, Filter::Triangle);
        println!("upscaled -> {:?}", decode_qr(&up));
    }

    #[test]
    fn qr_from_printer_test_page() {
        let page = crate::calib::render_printer_test("A4", 150);
        let g = crate::calib::printer_test_geometry("A4", 150);
        for (mmv, bbox, texto) in &g.qr_test {
            let pad = ((bbox[2] - bbox[0]) as f64 * 0.3) as i64;
            let crop = page.crop(
                (bbox[0] - pad).max(0) as usize,
                (bbox[1] - pad).max(0) as usize,
                (bbox[2] + pad) as usize,
                (bbox[3] + pad) as usize,
            );
            println!("{mmv} mm ({}x{}) -> {:?} (esperado {texto})", crop.w, crop.h, decode_qr_rgb(&crop));
        }
    }

    #[test]
    fn upscale_factor_is_capped_by_area() {
        // Recorte normal: se amplía como siempre.
        assert_eq!(upscale_factor(100, 100), 4);
        assert_eq!(upscale_factor(200, 200), 2);
        // Ya grande: no se toca.
        assert_eq!(upscale_factor(400, 400), 1);
        // Alargado y hostil: el factor del lado corto daba k=40 sobre 4000×10,
        // o sea 64 Mpx. Ahora el área manda.
        for (w, h) in [(4000usize, 10usize), (20000, 4), (10, 4000), (3000, 2)] {
            let k = upscale_factor(w, h);
            let area = (w * k) * (h * k);
            assert!(area <= MAX_UPSCALE_PIXELS, "{w}×{h}: k={k} da {area} px");
        }
        // Ningún caso puede devolver 0 (se usa como multiplicador).
        assert!(upscale_factor(1, 1) >= 1);
        assert!(upscale_factor(0, 0) >= 1);
    }
}
