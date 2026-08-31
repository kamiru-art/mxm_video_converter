//! Texto sobre el lienzo: DejaVu Sans incrustada (rasterizado con fontdue).
//! Incrustada y no del sistema para que las etiquetas salgan iguales en
//! cualquier navegador, con acentos y ñ.

use crate::img::Rgb;
use fontdue::{Font, FontSettings};
use std::sync::OnceLock;

static FONT_DATA: &[u8] = include_bytes!("../assets/DejaVuSans.ttf");
static FONT: OnceLock<Font> = OnceLock::new();

fn font() -> &'static Font {
    FONT.get_or_init(|| {
        Font::from_bytes(FONT_DATA, FontSettings::default()).expect("fuente incrustada válida")
    })
}

/// (ancho, alto) del texto a un tamaño en píxeles (alto ≈ línea completa).
pub fn text_size(text: &str, px: f32) -> (usize, usize) {
    let f = font();
    let mut w = 0.0f32;
    for ch in text.chars() {
        let m = f.metrics(ch, px);
        w += m.advance_width;
    }
    let lm = f.horizontal_line_metrics(px);
    let h = lm.map(|m| (m.ascent - m.descent).ceil()).unwrap_or(px * 1.2);
    (w.ceil() as usize, h as usize)
}

/// Dibuja texto con su esquina superior-izquierda en (x, y).
pub fn draw_text(canvas: &mut Rgb, text: &str, x: i64, y: i64, px: f32, color: [u8; 3]) {
    let f = font();
    let lm = f.horizontal_line_metrics(px);
    let ascent = lm.map(|m| m.ascent).unwrap_or(px);
    let mut pen_x = x as f32;
    for ch in text.chars() {
        let (metrics, bitmap) = f.rasterize(ch, px);
        let gx = pen_x + metrics.xmin as f32;
        let gy = y as f32 + ascent - metrics.ymin as f32 - metrics.height as f32;
        for row in 0..metrics.height {
            let py = gy as i64 + row as i64;
            if py < 0 || py >= canvas.h as i64 {
                continue;
            }
            for col in 0..metrics.width {
                let pxx = gx as i64 + col as i64;
                if pxx < 0 || pxx >= canvas.w as i64 {
                    continue;
                }
                let a = bitmap[row * metrics.width + col] as u32;
                if a == 0 {
                    continue;
                }
                let old = canvas.px(pxx as usize, py as usize);
                let mut np = [0u8; 3];
                for c in 0..3 {
                    np[c] = (((color[c] as u32) * a + (old[c] as u32) * (255 - a)) / 255) as u8;
                }
                canvas.set_px(pxx as usize, py as usize, np);
            }
        }
        pen_x += metrics.advance_width;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_and_draws() {
        let (w, h) = text_size("abc_001", 24.0);
        assert!(w > 40 && h > 15, "w={w} h={h}");
        let mut c = Rgb::new(200, 40, [255, 255, 255]);
        draw_text(&mut c, "ñandú_01", 4, 4, 24.0, [0, 0, 0]);
        let dark = c.data.chunks_exact(3).filter(|p| p[0] < 100).count();
        assert!(dark > 50, "se dibujaron {dark} píxeles oscuros");
    }
}
