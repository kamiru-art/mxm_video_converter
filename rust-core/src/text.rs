//! Texto sobre el lienzo: DejaVu Sans incrustada (rasterizado con fontdue).
//! Incrustada y no del sistema para que las etiquetas salgan iguales en
//! cualquier navegador, con acentos y ñ.
//!
//! Las etiquetas y el número de hoja pueden ir en otra fuente (una de las
//! que trae la web o una que sube el usuario: TTF, OTF, WOFF o WOFF2). El núcleo no guarda
//! fuentes: quien llama manda los bytes con cada llamada y `with_font` la
//! deja activa sólo mientras dura esa llamada. La última fuente leída se
//! reutiliza (caché por hash), porque la vista previa manda la misma en cada
//! cambio.
//!
//! Formas en que esto puede fallar, escritas antes que el código:
//!  1. Los bytes no son una fuente (un PNG, un TTF cortado): hay que
//!     rechazarlos con un mensaje, nunca con un panic que tumbe el worker.
//!  2. Un WOFF o WOFF2 (lo que suele dar una web de fuentes): fontdue no los
//!     lee, así que se descomprimen antes (wuff). Puede fallar así:
//!     (a) el WOFF2 guarda `glyf`/`loca` transformadas; mal reconstruidas,
//!     las letras salen deformes o en blanco: tiene que dibujar píxel a
//!     píxel lo mismo que el TTF del que salió. (b) El WOFF (zlib) de un OTF
//!     CFF: lo mismo frente a su OTF. (c) Un WOFF cortado o con basura: error
//!     con mensaje, sin panic. (d) Una «bomba»: la cabecera declara cientos
//!     de MB descomprimidos; se rechaza antes de descomprimir.
//!  3. Un OTF con contornos CFF (como vienen muchas fuentes comerciales) se
//!     lee mal o sale en blanco.
//!  4. A la fuente le faltan caracteres (una etiqueta con ñ, o la elipsis
//!     «…» que se pone al recortar): esos salen en DejaVu, no como hueco.
//!  5. Una fuente sin glifos para letras ni cifras (una de símbolos): no
//!     sirve para etiquetas; se rechaza en vez de dibujar todo en DejaVu sin
//!     decirlo.
//!  6. La fuente activa se escapa de su llamada: tras `with_font`, aunque
//!     haya hecho panic por dentro, la siguiente llamada sin fuente (o la
//!     página de calibración) tiene que salir en DejaVu.
//!  7. La caché devuelve la fuente equivocada: dos fuentes distintas del
//!     mismo tamaño no pueden compartir entrada.
//!  8. El layout medido con una fuente y la hoja dibujada con otra: lo evita
//!     quien llama (manda los mismos bytes a `compute_layout`, `render_sheet`
//!     y `assemble_layout`), no este módulo.
//!  9. Lo que sale en DejaVu por faltar en la fuente pasa sin que nadie lo
//!     note: la hoja impresa mezcla dos tipografías. Cada carácter que cae a
//!     DejaVu se anota (`take_fallbacks`) para que la interfaz lo avise y
//!     diga cuáles; y `missing_chars` lo dice de un texto antes de dibujar.

use crate::img::Rgb;
use fontdue::{Font, FontSettings};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::OnceLock;

static FONT_DATA: &[u8] = include_bytes!("../assets/DejaVuSans.ttf");
static FONT: OnceLock<Font> = OnceLock::new();

fn default_font() -> &'static Font {
    FONT.get_or_init(|| {
        Font::from_bytes(FONT_DATA, FontSettings::default()).expect("fuente incrustada válida")
    })
}

thread_local! {
    /// La fuente de la llamada en curso (None = DejaVu).
    static ACTIVE: RefCell<Option<Rc<Font>>> = const { RefCell::new(None) };
    /// Caracteres que se dibujaron en DejaVu por faltar en la fuente activa.
    static FALLBACKS: RefCell<Vec<char>> = const { RefCell::new(Vec::new()) };
    /// La última fuente leída, por (hash, tamaño) de sus bytes.
    static CACHE: RefCell<Option<(u64, usize, Rc<Font>)>> = const { RefCell::new(None) };
}

/// FNV-1a de 64 bits: basta para distinguir archivos, no es criptográfico.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Lo más que puede declarar un WOFF descomprimido: una fuente CJK completa
/// ronda los 20 MB; más es un archivo raro o una «bomba».
const MAX_SFNT: usize = 64 * 1024 * 1024;

/// Un WOFF o WOFF2 pasado a TTF/OTF; cualquier otra cosa, tal cual.
fn unwrap_web_font(bytes: &[u8]) -> Result<std::borrow::Cow<'_, [u8]>, String> {
    let woff1 = bytes.starts_with(b"wOFF");
    if !woff1 && !bytes.starts_with(b"wOF2") {
        return Ok(bytes.into());
    }
    let damaged = || "This web font (WOFF) is damaged and cannot be read.".to_string();
    // las dos cabeceras guardan en el byte 16 el tamaño descomprimido
    let declared = bytes
        .get(16..20)
        .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize)
        .ok_or_else(damaged)?;
    if declared > MAX_SFNT {
        return Err(format!(
            "This web font says it holds {} MB once unpacked; fonts for labels must be under {} MB.",
            declared / (1024 * 1024),
            MAX_SFNT / (1024 * 1024)
        ));
    }
    let out = if woff1 {
        wuff::decompress_woff1(bytes)
    } else {
        wuff::decompress_woff2(bytes)
    };
    out.map(Into::into).map_err(|_| damaged())
}

/// Lee una fuente (TTF, OTF, WOFF o WOFF2) y comprueba que sirva para
/// etiquetas.
pub fn parse_font(bytes: &[u8]) -> Result<Font, String> {
    let sfnt = unwrap_web_font(bytes)?;
    let font = Font::from_bytes(&*sfnt, FontSettings::default())
        .map_err(|e| format!("This file is not a font that can be read: {e}"))?;
    // una de símbolos no tiene ni cifras ni letras, y un archivo cortado
    // las tiene en la tabla pero sin contorno: en ambos casos no dibujan
    let covered = "0123456789Aa"
        .chars()
        .filter(|&c| {
            font.lookup_glyph_index(c) != 0 && font.rasterize(c, 32.0).1.iter().any(|&a| a > 0)
        })
        .count();
    if covered < 10 {
        return Err("This font has no letters or digits, so it cannot write labels.".into());
    }
    Ok(font)
}

fn cached_font(bytes: &[u8]) -> Result<Rc<Font>, String> {
    let key = (fnv1a(bytes), bytes.len());
    let hit = CACHE.with(|c| {
        c.borrow()
            .as_ref()
            .filter(|(h, n, _)| (*h, *n) == key)
            .map(|(_, _, f)| f.clone())
    });
    if let Some(f) = hit {
        return Ok(f);
    }
    let f = Rc::new(parse_font(bytes)?);
    CACHE.with(|c| *c.borrow_mut() = Some((key.0, key.1, f.clone())));
    Ok(f)
}

/// Restaura la fuente anterior al salir, también si `f` hace panic.
struct Restore(Option<Rc<Font>>);
impl Drop for Restore {
    fn drop(&mut self) {
        let prev = self.0.take();
        ACTIVE.with(|a| *a.borrow_mut() = prev);
    }
}

/// Ejecuta `f` con `bytes` como fuente de etiquetas y número de hoja. Sin
/// bytes, en DejaVu. Error si los bytes no son una fuente utilizable.
pub fn with_font<R>(bytes: &[u8], f: impl FnOnce() -> R) -> Result<R, String> {
    let font = if bytes.is_empty() {
        None
    } else {
        Some(cached_font(bytes)?)
    };
    take_fallbacks();
    let prev = ACTIVE.with(|a| std::mem::replace(&mut *a.borrow_mut(), font));
    let _restore = Restore(prev);
    Ok(f())
}

fn has_glyph(f: &Font, ch: char) -> bool {
    ch.is_whitespace() || ch.is_control() || f.lookup_glyph_index(ch) != 0
}

/// Los caracteres de `text` que la fuente `bytes` no tiene (sin repetir, en
/// orden de aparición). Vacío con `bytes` vacío: DejaVu es la de respaldo.
pub fn missing_chars(bytes: &[u8], text: &str) -> Result<Vec<char>, String> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let f = cached_font(bytes)?;
    let mut out = Vec::new();
    for ch in text.chars() {
        if !has_glyph(&f, ch) && !out.contains(&ch) {
            out.push(ch);
        }
    }
    Ok(out)
}

/// Lo que cayó a DejaVu desde la última llamada (y lo olvida).
pub fn take_fallbacks() -> Vec<char> {
    FALLBACKS.with(|m| std::mem::take(&mut *m.borrow_mut()))
}

/// Qué fuente dibuja `ch`: la activa si lo tiene, si no DejaVu.
fn glyph_font(active: Option<&Font>, ch: char) -> &Font {
    match active {
        Some(f) if has_glyph(f, ch) => f,
        _ => default_font(),
    }
}

fn with_active<R>(f: impl FnOnce(Option<&Font>) -> R) -> R {
    let active = ACTIVE.with(|a| a.borrow().clone());
    f(active.as_deref())
}

/// (ascenso, descenso) de la línea: los de la fuente activa, o DejaVu.
fn line_metrics(active: Option<&Font>, px: f32) -> (f32, f32) {
    active
        .unwrap_or_else(|| default_font())
        .horizontal_line_metrics(px)
        .map(|m| (m.ascent, m.descent))
        .unwrap_or((px, -px * 0.2))
}

/// (ancho, alto) del texto a un tamaño en píxeles (alto ≈ línea completa).
pub fn text_size(text: &str, px: f32) -> (usize, usize) {
    with_active(|active| {
        let mut w = 0.0f32;
        for ch in text.chars() {
            w += glyph_font(active, ch).metrics(ch, px).advance_width;
        }
        let (ascent, descent) = line_metrics(active, px);
        (w.ceil() as usize, (ascent - descent).ceil() as usize)
    })
}

/// Dibuja texto con su esquina superior-izquierda en (x, y).
pub fn draw_text(canvas: &mut Rgb, text: &str, x: i64, y: i64, px: f32, color: [u8; 3]) {
    with_active(|active| {
        let (ascent, _) = line_metrics(active, px);
        let mut pen_x = x as f32;
        for ch in text.chars() {
            if let Some(f) = active {
                if !has_glyph(f, ch) {
                    FALLBACKS.with(|m| {
                        let mut m = m.borrow_mut();
                        if !m.contains(&ch) {
                            m.push(ch);
                        }
                    });
                }
            }
            let (metrics, bitmap) = glyph_font(active, ch).rasterize(ch, px);
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Courier Prime (OFL, TTF): monoespaciada, así que mide distinto que
    // DejaVu. Source Sans 3 Bold (OFL, OTF con contornos CFF).
    static MONO: &[u8] = include_bytes!("../../web/public/fonts/CourierPrime-Regular.ttf");
    static PLEX: &[u8] = include_bytes!("../../web/public/fonts/IBMPlexMono-Regular.ttf");
    static CFF: &[u8] = include_bytes!("../assets/test/SourceSans3-Bold.otf");
    static SERIF: &[u8] = include_bytes!("../../web/public/fonts/PTSerif-Regular.ttf");
    static SERIF_WOFF2: &[u8] = include_bytes!("../assets/test/PTSerif-Regular.woff2");
    static CFF_WOFF: &[u8] = include_bytes!("../assets/test/SourceSans3-Bold.woff");

    fn dark_pixels(c: &Rgb) -> usize {
        c.data
            .as_chunks::<3>()
            .0
            .iter()
            .filter(|p| p[0] < 100)
            .count()
    }

    fn render(text: &str) -> Rgb {
        let mut c = Rgb::new(260, 40, [255, 255, 255]);
        draw_text(&mut c, text, 4, 4, 24.0, [0, 0, 0]);
        c
    }

    #[test]
    fn measures_and_draws() {
        let (w, h) = text_size("abc_001", 24.0);
        assert!(w > 40 && h > 15, "w={w} h={h}");
        let c = render("ñandú_01");
        assert!(dark_pixels(&c) > 50, "{} píxeles oscuros", dark_pixels(&c));
    }

    #[test]
    fn non_fonts_are_refused_without_panic() {
        // 1 y 2
        for (bytes, needle) in [
            (&b"\x89PNG\r\n\x1a\n0000"[..], "not a font"),
            (&MONO[..MONO.len() / 3], ""),
            (&b"wOFF\x00\x01\x00\x00rest"[..], "web font"),
            (&b"wOF2\x00\x01\x00\x00rest"[..], "web font"),
        ] {
            let e = with_font(bytes, || ()).expect_err("debía rechazarse");
            assert!(e.contains(needle), "{e}");
        }
    }

    /// Lo que dibuja `font` de un texto con mayúsculas, ñ, cifras y signos.
    fn drawn_with(font: &[u8]) -> Vec<u8> {
        let mut c = Rgb::new(520, 60, [255, 255, 255]);
        with_font(font, || {
            draw_text(&mut c, "Hoja 12 ñandú QRgy&@", 4, 4, 36.0, [0, 0, 0])
        })
        .expect("fuente válida");
        c.data
    }

    #[test]
    fn web_fonts_draw_exactly_like_their_source() {
        // 2a: WOFF2 con glyf/loca transformadas, frente al TTF del que salió
        assert_eq!(&SERIF_WOFF2[..4], b"wOF2");
        let ttf = drawn_with(SERIF);
        assert!(
            ttf.iter().filter(|&&v| v < 128).count() > 500,
            "el TTF dibuja"
        );
        assert!(
            ttf == drawn_with(SERIF_WOFF2),
            "el WOFF2 dibuja distinto que su TTF"
        );
        // 2b: WOFF (zlib) de un OTF CFF
        assert_eq!(&CFF_WOFF[..4], b"wOFF");
        assert!(
            drawn_with(CFF) == drawn_with(CFF_WOFF),
            "el WOFF dibuja distinto que su OTF"
        );
        // y no se confunden en la caché: las dos dibujan distinto entre sí
        assert!(drawn_with(SERIF_WOFF2) != drawn_with(CFF_WOFF));
    }

    #[test]
    fn broken_web_fonts_are_refused_without_panic() {
        // 2c: cortado, y con la mitad de los datos cambiados
        let mut garbled = SERIF_WOFF2.to_vec();
        let n = garbled.len();
        for b in &mut garbled[n / 4..n / 2] {
            *b ^= 0x5a;
        }
        for bytes in [
            &SERIF_WOFF2[..SERIF_WOFF2.len() / 2],
            &CFF_WOFF[..900],
            &garbled[..],
        ] {
            let e = with_font(bytes, || ()).expect_err("debía rechazarse");
            assert!(e.contains("web font") || e.contains("letters"), "{e}");
        }
        // 2d: una cabecera que declara 500 MB descomprimidos
        for magic in [b"wOFF", b"wOF2"] {
            let mut bomb = if magic == b"wOFF" {
                CFF_WOFF.to_vec()
            } else {
                SERIF_WOFF2.to_vec()
            };
            bomb[16..20].copy_from_slice(&500_000_000u32.to_be_bytes());
            let e = with_font(&bomb, || ()).expect_err("debía rechazarse");
            assert!(e.contains("MB"), "{e}");
        }
    }

    #[test]
    fn cff_otf_draws_bold_ink() {
        // 3: un OTF CFF se lee y dibuja; en negrita, más tinta que DejaVu
        let text = "Sheet 12";
        let base = dark_pixels(&render(text));
        let bold = with_font(CFF, || dark_pixels(&render(text))).expect("OTF CFF válido");
        assert!(bold > base, "negrita {bold} vs regular {base}");
    }

    #[test]
    fn a_font_changes_width_and_pixels_and_does_not_leak() {
        // 6: dentro cambia, fuera vuelve a DejaVu
        let text = "iiiWWW_001";
        let base_w = text_size(text, 24.0).0;
        let base_px = render(text).data;
        let (mono_w, mono_px) =
            with_font(MONO, || (text_size(text, 24.0).0, render(text).data)).unwrap();
        assert_ne!(base_w, mono_w);
        assert_ne!(base_px, mono_px);
        assert_eq!(text_size(text, 24.0).0, base_w);
        assert_eq!(render(text).data, base_px);
        // también si la llamada hace panic por dentro
        let r = std::panic::catch_unwind(|| {
            let _ = with_font(MONO, || panic!("dentro"));
        });
        assert!(r.is_err());
        assert_eq!(text_size(text, 24.0).0, base_w);
        assert_eq!(render(text).data, base_px);
    }

    #[test]
    fn missing_glyphs_fall_back_to_dejavu() {
        // 4: un carácter que la fuente no tiene se dibuja, y con la forma de
        // DejaVu (misma tinta; la línea es la de la otra fuente)
        let mono = parse_font(MONO).unwrap();
        let missing = ['…', '→', 'Ж', '✓', '∞']
            .into_iter()
            .find(|&c| mono.lookup_glyph_index(c) == 0)
            .expect("Courier Prime no tiene alguno de estos");
        let s = missing.to_string();
        let dejavu = dark_pixels(&render(&s)) as i64;
        let got = with_font(MONO, || dark_pixels(&render(&s))).unwrap() as i64;
        assert!(got > 10, "'{missing}' quedó en blanco");
        // 9: y queda anotado, para el aviso, sólo lo que faltó
        let fell = with_font(MONO, || {
            render(&format!("ab{missing}c{missing}"));
            take_fallbacks()
        })
        .unwrap();
        assert_eq!(fell, vec![missing]);
        assert_eq!(
            missing_chars(MONO, &format!("x {missing}1")).unwrap(),
            vec![missing]
        );
        assert!(missing_chars(&[], "→…").unwrap().is_empty());
        // en DejaVu no se anota nada
        render(&s);
        assert!(take_fallbacks().is_empty());
        assert!((got - dejavu).abs() <= dejavu / 5 + 2, "{got} vs {dejavu}");
    }

    #[test]
    fn the_cache_tells_fonts_apart() {
        // 7: dos fuentes seguidas, y de vuelta a la primera
        let text = "Sheet 12";
        let m1 = with_font(MONO, || text_size(text, 30.0)).unwrap();
        let p = with_font(PLEX, || text_size(text, 30.0)).unwrap();
        assert_ne!(m1, p);
        // mismo tamaño, otro contenido: no puede servir la entrada anterior
        let mut tweaked = MONO.to_vec();
        let n = tweaked.len();
        tweaked[n - 1] ^= 0xff;
        let _ = with_font(&tweaked, || ());
        assert_eq!(with_font(MONO, || text_size(text, 30.0)).unwrap(), m1);
        let cff = with_font(CFF, || text_size(text, 30.0)).unwrap();
        assert_ne!(cff, m1);
    }

    #[test]
    fn symbol_fonts_are_refused() {
        // 5: una fuente sin cifras ni letras. Se fabrica quitando a DejaVu
        // su tabla de caracteres: sin cmap, ningún carácter tiene glifo.
        let mut f = FONT_DATA.to_vec();
        let ntables = u16::from_be_bytes([f[4], f[5]]) as usize;
        for i in 0..ntables {
            let rec = 12 + 16 * i;
            if &f[rec..rec + 4] == b"cmap" {
                f[rec..rec + 4].copy_from_slice(b"xmap");
            }
        }
        assert!(with_font(&f, || ()).is_err(), "sin cmap no puede aceptarse");
    }
}
