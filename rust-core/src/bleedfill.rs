//! Relleno de lo que un recorte con bleed negativo saca de la hoja, y borrado
//! de los marcadores de registro.
//!
//! Con un bleed negativo el recorte sale del panel (una técnica artística) y
//! puede pasar el borde de la hoja enderezada, o caer en zonas que el escáner
//! no captó (el enderezado las deja negras). Sin opción, lo de fuera de la
//! hoja sale blanco y lo no captado negro, como siempre. Con una opción:
//!
//! - `Paper`: el color del papel, medido en el borde de la hoja.
//! - `Mirror`: la hoja reflejada en su borde, que se ve continua.
//! - `Tile`: la misma hoja repetida en mosaico, como si hubiera otras hojas
//!   arriba, abajo y a los lados.
//!
//! En `Mirror` y `Tile`, lo que cae en una zona no captada sale del color del
//! papel. Borrar los marcadores pinta cada uno con el papel que lo rodea.

use crate::geometry::{apply_h, H3};
use crate::img::DynImg;

/// Cómo rellenar lo que el recorte saca de la hoja.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum FillMode {
    /// Lo de siempre: blanco fuera de la hoja, negro donde el escáner no llegó.
    #[default]
    Legacy,
    Paper,
    Mirror,
    Tile,
}

impl FillMode {
    pub fn parse(s: &str) -> FillMode {
        match s {
            "paper" => FillMode::Paper,
            "mirror" => FillMode::Mirror,
            "tile" => FillMode::Tile,
            _ => FillMode::Legacy,
        }
    }
}

/// Qué parte de la hoja enderezada salió del escaneo: el enderezado deja en
/// negro los píxeles cuyo origen cae fuera del escaneo original.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SourceBounds {
    /// Hoja enderezada → escaneo (la inversa de la homografía del enderezado).
    pub minv: H3,
    pub w: f64,
    pub h: f64,
}

impl SourceBounds {
    /// ¿El píxel (x, y) de la hoja enderezada tiene datos del escaneo?
    pub fn covers(&self, x: f64, y: f64) -> bool {
        let (sx, sy) = apply_h(&self.minv, (x, y));
        sx.is_finite()
            && sy.is_finite()
            && sx >= 0.0
            && sy >= 0.0
            && sx <= self.w - 1.0
            && sy <= self.h - 1.0
    }
}

/// Todo lo que el relleno necesita saber de una hoja.
pub struct FillCtx {
    pub mode: FillMode,
    /// Color del papel en la escala nativa (0–255 o 0–65535).
    pub paper: [f64; 3],
    pub source: Option<SourceBounds>,
}

impl FillCtx {
    fn valid(&self, x: usize, y: usize) -> bool {
        self.source
            .as_ref()
            .is_none_or(|s| s.covers(x as f64, y as f64))
    }
}

trait Px: Copy {
    fn to_f(self) -> f64;
    fn from_f(v: f64) -> Self;
}
impl Px for u8 {
    fn to_f(self) -> f64 {
        self as f64
    }
    fn from_f(v: f64) -> Self {
        v.round().clamp(0.0, 255.0) as u8
    }
}
impl Px for u16 {
    fn to_f(self) -> f64 {
        self as f64
    }
    fn from_f(v: f64) -> Self {
        v.round().clamp(0.0, 65535.0) as u16
    }
}

fn median(v: &mut [f64]) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    let mid = v.len() / 2;
    let (_, m, _) = v.select_nth_unstable_by(mid, |a, b| a.total_cmp(b));
    Some(*m)
}

/// Mediana por canal de los píxeles válidos de `data` que `pick` acepta,
/// tomando uno de cada `step` en cada eje.
fn median_where<T: Px>(
    data: &[T],
    iw: usize,
    ih: usize,
    step: usize,
    ctx_src: Option<&SourceBounds>,
    pick: impl Fn(usize, usize) -> bool,
) -> Option<[f64; 3]> {
    let mut ch: [Vec<f64>; 3] = Default::default();
    let step = step.max(1);
    for y in (0..ih).step_by(step) {
        for x in (0..iw).step_by(step) {
            if !pick(x, y) {
                continue;
            }
            if let Some(s) = ctx_src {
                if !s.covers(x as f64, y as f64) {
                    continue;
                }
            }
            let o = (y * iw + x) * 3;
            for c in 0..3 {
                ch[c].push(data[o + c].to_f());
            }
        }
    }
    let r = median(&mut ch[0])?;
    let g = median(&mut ch[1])?;
    let b = median(&mut ch[2])?;
    Some([r, g, b])
}

/// Color del papel: la mediana de una franja junto al borde de la hoja (el
/// margen, que casi siempre queda sin pintar). La mediana no se deja
/// arrastrar por los marcadores ni por alguna pincelada que llegue al borde.
/// Se salta el primer 0,5 % del borde, donde el papel suele tener sombra.
pub fn paper_colour(warp: &DynImg, source: Option<&SourceBounds>) -> [f64; 3] {
    let (iw, ih) = warp.size();
    let short = iw.min(ih).max(1);
    let skip = (short as f64 * 0.005) as usize;
    let band = ((short as f64 * 0.03) as usize).max(skip + 4);
    let step = (short / 400).max(1);
    let pick = |x: usize, y: usize| {
        let d = x.min(y).min(iw - 1 - x).min(ih - 1 - y);
        d >= skip && d < band
    };
    let white = match warp {
        DynImg::U8(_) => 255.0,
        DynImg::U16(_) => 65535.0,
    };
    let m = match warp {
        DynImg::U8(i) => median_where(&i.data, iw, ih, step, source, pick),
        DynImg::U16(i) => median_where(&i.data, iw, ih, step, source, pick),
    };
    m.unwrap_or([white; 3])
}

/// Índice reflejado en [0, n): …2 1 0 | 0 1 2 … n-1 | n-1 n-2 …
fn reflect(i: i64, n: usize) -> usize {
    let n = n as i64;
    let p = i.rem_euclid(2 * n);
    (if p < n { p } else { 2 * n - 1 - p }) as usize
}

fn crop_generic<T: Px>(
    data: &[T],
    iw: usize,
    ih: usize,
    ox: i64,
    oy: i64,
    cw: usize,
    ch: usize,
    ctx: &FillCtx,
) -> Vec<T> {
    let paper = [
        T::from_f(ctx.paper[0]),
        T::from_f(ctx.paper[1]),
        T::from_f(ctx.paper[2]),
    ];
    let mut out: Vec<T> = Vec::with_capacity(cw * ch * 3);
    for dy in 0..ch {
        let y = oy + dy as i64;
        for dx in 0..cw {
            let x = ox + dx as i64;
            let inside = x >= 0 && y >= 0 && (x as usize) < iw && (y as usize) < ih;
            let src = if inside {
                Some((x as usize, y as usize))
            } else {
                match ctx.mode {
                    FillMode::Mirror => Some((reflect(x, iw), reflect(y, ih))),
                    FillMode::Tile => Some((
                        x.rem_euclid(iw as i64) as usize,
                        y.rem_euclid(ih as i64) as usize,
                    )),
                    FillMode::Paper | FillMode::Legacy => None,
                }
            };
            match src {
                Some((sx, sy)) if ctx.valid(sx, sy) => {
                    let o = (sy * iw + sx) * 3;
                    out.extend_from_slice(&data[o..o + 3]);
                }
                _ => out.extend_from_slice(&paper),
            }
        }
    }
    out
}

/// Recorte de tamaño fijo `cw`×`ch` con esquina en (`ox`, `oy`), que puede
/// salir de la hoja: lo que sale, y lo que el escáner no captó, se rellena
/// según `ctx.mode`. Con `Legacy`, igual que `DynImg::crop_fixed`.
pub fn crop_filled(warp: &DynImg, ox: i64, oy: i64, cw: usize, ch: usize, ctx: &FillCtx) -> DynImg {
    if ctx.mode == FillMode::Legacy {
        return warp.crop_fixed(ox, oy, cw, ch);
    }
    let (iw, ih) = warp.size();
    match warp {
        DynImg::U8(i) => DynImg::U8(crate::img::Rgb {
            w: cw,
            h: ch,
            data: crop_generic(&i.data, iw, ih, ox, oy, cw, ch, ctx),
        }),
        DynImg::U16(i) => DynImg::U16(crate::img::Rgb16 {
            w: cw,
            h: ch,
            data: crop_generic(&i.data, iw, ih, ox, oy, cw, ch, ctx),
        }),
    }
}

fn erase_generic<T: Px>(
    data: &mut [T],
    iw: usize,
    ih: usize,
    rects: &[[f64; 4]],
    source: Option<&SourceBounds>,
    paper: [f64; 3],
) {
    for r in rects {
        let side = (r[2] - r[0]).min(r[3] - r[1]).max(1.0);
        // margen: el papel se mueve un poco al imprimir y al mojarse, y el
        // borde del marcador sale algo borroso en el escaneo
        let pad = side * 0.15 + 2.0;
        let ring = (side * 0.25).max(3.0);
        let clampx = |v: f64| v.round().clamp(0.0, iw as f64) as usize;
        let clampy = |v: f64| v.round().clamp(0.0, ih as f64) as usize;
        let (x1, y1, x2, y2) = (
            clampx(r[0] - pad),
            clampy(r[1] - pad),
            clampx(r[2] + pad),
            clampy(r[3] + pad),
        );
        if x2 <= x1 || y2 <= y1 {
            continue;
        }
        // color local: la mediana de un anillo de papel alrededor
        let (ox1, oy1, ox2, oy2) = (
            clampx(r[0] - pad - ring),
            clampy(r[1] - pad - ring),
            clampx(r[2] + pad + ring),
            clampy(r[3] + pad + ring),
        );
        let mut ch: [Vec<f64>; 3] = Default::default();
        for y in oy1..oy2 {
            for x in ox1..ox2 {
                if x >= x1 && x < x2 && y >= y1 && y < y2 {
                    continue;
                }
                if source.is_some_and(|s| !s.covers(x as f64, y as f64)) {
                    continue;
                }
                let o = (y * iw + x) * 3;
                for c in 0..3 {
                    ch[c].push(data[o + c].to_f());
                }
            }
        }
        let colour = match (median(&mut ch[0]), median(&mut ch[1]), median(&mut ch[2])) {
            (Some(r), Some(g), Some(b)) => [r, g, b],
            _ => paper,
        };
        let px = [
            T::from_f(colour[0]),
            T::from_f(colour[1]),
            T::from_f(colour[2]),
        ];
        for y in y1..y2 {
            for x in x1..x2 {
                let o = (y * iw + x) * 3;
                data[o..o + 3].copy_from_slice(&px);
            }
        }
    }
}

/// Pinta cada rectángulo `rects` (en píxeles de la hoja enderezada: x1, y1,
/// x2, y2) con el color del papel que lo rodea, con un margen de seguridad.
pub fn erase_rects(
    warp: &mut DynImg,
    rects: &[[f64; 4]],
    source: Option<&SourceBounds>,
    paper: [f64; 3],
) {
    let (iw, ih) = warp.size();
    match warp {
        DynImg::U8(i) => erase_generic(&mut i.data, iw, ih, rects, source, paper),
        DynImg::U16(i) => erase_generic(&mut i.data, iw, ih, rects, source, paper),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::img::Rgb;

    /// Hoja de 10×6: cada píxel guarda su posición (x en rojo, y en verde).
    fn grid() -> DynImg {
        let mut img = Rgb::new(10, 6, [0, 0, 0]);
        for y in 0..6 {
            for x in 0..10 {
                img.set_px(x, y, [x as u8, y as u8, 200]);
            }
        }
        DynImg::U8(img)
    }

    fn ctx(mode: FillMode) -> FillCtx {
        FillCtx {
            mode,
            paper: [250.0, 240.0, 230.0],
            source: None,
        }
    }

    fn px(img: &DynImg, x: usize, y: usize) -> [u8; 3] {
        img.to_rgb8().px(x, y)
    }

    #[test]
    fn reflect_wraps_back_and_forth() {
        let got: Vec<usize> = (-4..8).map(|i| reflect(i, 3)).collect();
        assert_eq!(got, vec![2, 2, 1, 0, 0, 1, 2, 2, 1, 0, 0, 1]);
    }

    #[test]
    fn paper_mode_fills_outside_with_the_paper() {
        let c = crop_filled(&grid(), -2, -1, 14, 8, &ctx(FillMode::Paper));
        assert_eq!(c.size(), (14, 8));
        assert_eq!(px(&c, 0, 0), [250, 240, 230]);
        assert_eq!(px(&c, 13, 7), [250, 240, 230]);
        // dentro, la hoja tal cual
        assert_eq!(px(&c, 2, 1), [0, 0, 200]);
        assert_eq!(px(&c, 11, 6), [9, 5, 200]);
    }

    #[test]
    fn mirror_mode_reflects_the_sheet_at_its_edge() {
        let c = crop_filled(&grid(), -2, -1, 14, 8, &ctx(FillMode::Mirror));
        // x = -2 → 1, x = -1 → 0; y = -1 → 0
        assert_eq!(px(&c, 0, 0), [1, 0, 200]);
        assert_eq!(px(&c, 1, 0), [0, 0, 200]);
        // x = 10 → 9, x = 11 → 8; y = 6 → 5
        assert_eq!(px(&c, 12, 7), [9, 5, 200]);
        assert_eq!(px(&c, 13, 7), [8, 5, 200]);
    }

    #[test]
    fn tile_mode_repeats_the_sheet() {
        let c = crop_filled(&grid(), -2, -1, 14, 8, &ctx(FillMode::Tile));
        // x = -2 → 8, y = -1 → 5
        assert_eq!(px(&c, 0, 0), [8, 5, 200]);
        // x = 10 → 0, y = 6 → 0
        assert_eq!(px(&c, 12, 7), [0, 0, 200]);
    }

    #[test]
    fn unscanned_pixels_take_the_paper_in_every_mode() {
        // el escaneo solo cubre x ≤ 4 de la hoja (identidad, 5 px de ancho)
        let src = SourceBounds {
            minv: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            w: 5.0,
            h: 6.0,
        };
        for mode in [FillMode::Paper, FillMode::Mirror, FillMode::Tile] {
            let cx = FillCtx {
                source: Some(src.clone()),
                ..ctx(mode)
            };
            let c = crop_filled(&grid(), 0, 0, 10, 6, &cx);
            assert_eq!(px(&c, 4, 2), [4, 2, 200], "{mode:?}");
            assert_eq!(px(&c, 7, 2), [250, 240, 230], "{mode:?}");
        }
    }

    #[test]
    fn paper_colour_is_the_median_of_the_margin() {
        // papel crema con un "marcador" negro en una esquina y pintura al centro
        let mut img = Rgb::new(400, 300, [240, 230, 210]);
        img.fill_rect(5, 5, 30, 30, [0, 0, 0]);
        img.fill_rect(60, 60, 340, 240, [200, 20, 40]);
        let p = paper_colour(&DynImg::U8(img), None);
        assert_eq!(p, [240.0, 230.0, 210.0]);
    }

    #[test]
    fn erase_paints_the_marker_with_the_paper_around_it() {
        let mut img = Rgb::new(100, 100, [235, 225, 205]);
        img.fill_rect(40, 40, 60, 60, [0, 0, 0]);
        let mut d = DynImg::U8(img);
        erase_rects(&mut d, &[[40.0, 40.0, 60.0, 60.0]], None, [255.0; 3]);
        let rgb = d.to_rgb8();
        for (x, y) in [(40, 40), (50, 50), (59, 59)] {
            assert_eq!(rgb.px(x, y), [235, 225, 205]);
        }
    }
}
