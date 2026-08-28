//! Tipos de imagen internos y remuestreo de alta calidad.
//!
//! Filosofía heredada de la app original: los fotogramas se reescalan con
//! Lanczos (alta calidad), los proxies de detección con promedio de área, y
//! los escaneos de 16 bits se conservan de punta a punta.

#[derive(Clone)]
pub struct Gray {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u8>,
}

#[derive(Clone)]
pub struct Rgb {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u8>, // 3 bytes por píxel
}

#[derive(Clone)]
pub struct Rgb16 {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u16>, // 3 valores por píxel
}

/// Escaneo en su profundidad nativa (8 o 16 bits por canal).
#[derive(Clone)]
pub enum DynImg {
    U8(Rgb),
    U16(Rgb16),
}

impl DynImg {
    /// Recorte convertido a RGB de 8 bits (solo la zona pedida: los escaneos
    /// de 16 bits nunca se convierten enteros, por memoria).
    pub fn crop_rgb8(&self, x1: usize, y1: usize, x2: usize, y2: usize) -> Rgb {
        let (w, h) = self.size();
        let (x2, y2) = (x2.min(w), y2.min(h));
        let (x1, y1) = (x1.min(x2), y1.min(y2));
        let (cw, ch) = (x2 - x1, y2 - y1);
        let mut data = Vec::with_capacity(cw * ch * 3);
        match self {
            DynImg::U8(i) => {
                for y in y1..y2 {
                    let o = (y * w + x1) * 3;
                    data.extend_from_slice(&i.data[o..o + cw * 3]);
                }
            }
            DynImg::U16(i) => {
                for y in y1..y2 {
                    let o = (y * w + x1) * 3;
                    data.extend(i.data[o..o + cw * 3].iter().map(|&v| (v >> 8) as u8));
                }
            }
        }
        Rgb { w: cw, h: ch, data }
    }

    /// Recorte en profundidad nativa.
    pub fn crop(&self, x1: usize, y1: usize, x2: usize, y2: usize) -> DynImg {
        let (w, _h) = self.size();
        match self {
            DynImg::U8(i) => {
                let (x2, y2) = (x2.min(i.w), y2.min(i.h));
                let (cw, ch) = (x2.saturating_sub(x1), y2.saturating_sub(y1));
                let mut data = Vec::with_capacity(cw * ch * 3);
                for y in y1..y2 {
                    let o = (y * w + x1) * 3;
                    data.extend_from_slice(&i.data[o..o + cw * 3]);
                }
                DynImg::U8(Rgb { w: cw, h: ch, data })
            }
            DynImg::U16(i) => {
                let (x2, y2) = (x2.min(i.w), y2.min(i.h));
                let (cw, ch) = (x2.saturating_sub(x1), y2.saturating_sub(y1));
                let mut data = Vec::with_capacity(cw * ch * 3);
                for y in y1..y2 {
                    let o = (y * w + x1) * 3;
                    data.extend_from_slice(&i.data[o..o + cw * 3]);
                }
                DynImg::U16(Rgb16 { w: cw, h: ch, data })
            }
        }
    }

    /// Proxy RGB8 con lado máximo `max_side` por PROMEDIO DE ÁREA (binning:
    /// ahoga el grano químico). Devuelve (proxy, factor proxy→full).
    pub fn proxy_rgb8(&self, max_side: usize) -> (Rgb, f64) {
        let (w, h) = self.size();
        let f = ((w.max(h)) as f64 / max_side as f64).max(1.0);
        if f <= 1.0 {
            return (self.to_rgb8(), 1.0);
        }
        let dw = ((w as f64 / f) as usize).max(1);
        let dh = ((h as f64 / f) as usize).max(1);
        let mut data = Vec::with_capacity(dw * dh * 3);
        let sample = |x1: usize, y1: usize, x2: usize, y2: usize| -> [u8; 3] {
            let mut acc = [0.0f64; 3];
            let mut n = 0.0f64;
            match self {
                DynImg::U8(i) => {
                    for y in y1..y2.min(h) {
                        for x in x1..x2.min(w) {
                            let o = (y * w + x) * 3;
                            for c in 0..3 {
                                acc[c] += i.data[o + c] as f64;
                            }
                            n += 1.0;
                        }
                    }
                }
                DynImg::U16(i) => {
                    for y in y1..y2.min(h) {
                        for x in x1..x2.min(w) {
                            let o = (y * w + x) * 3;
                            for c in 0..3 {
                                acc[c] += (i.data[o + c] >> 8) as f64;
                            }
                            n += 1.0;
                        }
                    }
                }
            }
            let n = n.max(1.0);
            [
                (acc[0] / n).round() as u8,
                (acc[1] / n).round() as u8,
                (acc[2] / n).round() as u8,
            ]
        };
        for dy in 0..dh {
            let y1 = (dy as f64 * f) as usize;
            let y2 = (((dy + 1) as f64 * f).ceil() as usize).max(y1 + 1);
            for dx in 0..dw {
                let x1 = (dx as f64 * f) as usize;
                let x2 = (((dx + 1) as f64 * f).ceil() as usize).max(x1 + 1);
                let p = sample(x1, y1, x2, y2);
                data.extend_from_slice(&p);
            }
        }
        (Rgb { w: dw, h: dh, data }, f)
    }

    pub fn size(&self) -> (usize, usize) {
        match self {
            DynImg::U8(i) => (i.w, i.h),
            DynImg::U16(i) => (i.w, i.h),
        }
    }
    /// Vista de 8 bits (para detección). En u16 se toma el byte alto.
    pub fn to_rgb8(&self) -> Rgb {
        match self {
            DynImg::U8(i) => i.clone(),
            DynImg::U16(i) => {
                let data = i.data.iter().map(|&v| (v >> 8) as u8).collect();
                Rgb { w: i.w, h: i.h, data }
            }
        }
    }
    pub fn flip_horizontal(&mut self) {
        match self {
            DynImg::U8(i) => flip_h(&mut i.data, i.w, i.h, 3),
            DynImg::U16(i) => flip_h(&mut i.data, i.w, i.h, 3),
        }
    }
}

fn flip_h<T: Copy>(data: &mut [T], w: usize, h: usize, ch: usize) {
    for y in 0..h {
        let row = &mut data[y * w * ch..(y + 1) * w * ch];
        for x in 0..w / 2 {
            for c in 0..ch {
                row.swap(x * ch + c, (w - 1 - x) * ch + c);
            }
        }
    }
}

impl Gray {
    pub fn new(w: usize, h: usize, fill: u8) -> Self {
        Gray { w, h, data: vec![fill; w * h] }
    }
    #[inline]
    pub fn at(&self, x: usize, y: usize) -> u8 {
        self.data[y * self.w + x]
    }
    pub fn invert(&self) -> Gray {
        Gray { w: self.w, h: self.h, data: self.data.iter().map(|&v| 255 - v).collect() }
    }
    pub fn flip_horizontal(&self) -> Gray {
        let mut d = self.data.clone();
        flip_h(&mut d, self.w, self.h, 1);
        Gray { w: self.w, h: self.h, data: d }
    }
}

impl Rgb {
    pub fn new(w: usize, h: usize, color: [u8; 3]) -> Self {
        let mut data = Vec::with_capacity(w * h * 3);
        for _ in 0..w * h {
            data.extend_from_slice(&color);
        }
        Rgb { w, h, data }
    }
    #[inline]
    pub fn px(&self, x: usize, y: usize) -> [u8; 3] {
        let i = (y * self.w + x) * 3;
        [self.data[i], self.data[i + 1], self.data[i + 2]]
    }
    #[inline]
    pub fn set_px(&mut self, x: usize, y: usize, c: [u8; 3]) {
        let i = (y * self.w + x) * 3;
        self.data[i..i + 3].copy_from_slice(&c);
    }
    pub fn to_gray(&self) -> Gray {
        // Luminancia entera estándar (igual que OpenCV/PIL "L").
        let mut data = Vec::with_capacity(self.w * self.h);
        for p in self.data.chunks_exact(3) {
            let v = (299 * p[0] as u32 + 587 * p[1] as u32 + 114 * p[2] as u32 + 500) / 1000;
            data.push(v as u8);
        }
        Gray { w: self.w, h: self.h, data }
    }
    /// Canal rojo (clave en cianotipia: el azul de Prusia es casi negro ahí).
    pub fn red_channel(&self) -> Gray {
        let data = self.data.chunks_exact(3).map(|p| p[0]).collect();
        Gray { w: self.w, h: self.h, data }
    }
    pub fn flip_horizontal(&self) -> Rgb {
        let mut d = self.data.clone();
        flip_h(&mut d, self.w, self.h, 3);
        Rgb { w: self.w, h: self.h, data: d }
    }
    /// Pega `src` con su esquina superior-izquierda en (x, y), recortando al lienzo.
    pub fn paste(&mut self, src: &Rgb, x: i64, y: i64) {
        for sy in 0..src.h {
            let dy = y + sy as i64;
            if dy < 0 || dy >= self.h as i64 {
                continue;
            }
            for sx in 0..src.w {
                let dx = x + sx as i64;
                if dx < 0 || dx >= self.w as i64 {
                    continue;
                }
                self.set_px(dx as usize, dy as usize, src.px(sx, sy));
            }
        }
    }
    /// Rellena un rectángulo [x1, y1, x2, y2) recortado al lienzo.
    pub fn fill_rect(&mut self, x1: i64, y1: i64, x2: i64, y2: i64, c: [u8; 3]) {
        let (x1, y1) = (x1.max(0) as usize, y1.max(0) as usize);
        let (x2, y2) = ((x2.max(0) as usize).min(self.w), (y2.max(0) as usize).min(self.h));
        for y in y1..y2 {
            for x in x1..x2 {
                self.set_px(x, y, c);
            }
        }
    }
    /// Marco (outline) de grosor `t` POR DENTRO del rectángulo [x1,y1,x2,y2).
    pub fn stroke_rect(&mut self, x1: i64, y1: i64, x2: i64, y2: i64, t: i64, c: [u8; 3]) {
        self.fill_rect(x1, y1, x2, y1 + t, c);
        self.fill_rect(x1, y2 - t, x2, y2, c);
        self.fill_rect(x1, y1, x1 + t, y2, c);
        self.fill_rect(x2 - t, y1, x2, y2, c);
    }
    pub fn crop(&self, x1: usize, y1: usize, x2: usize, y2: usize) -> Rgb {
        let (x2, y2) = (x2.min(self.w), y2.min(self.h));
        let (w, h) = (x2.saturating_sub(x1), y2.saturating_sub(y1));
        let mut data = Vec::with_capacity(w * h * 3);
        for y in y1..y2 {
            let i = (y * self.w + x1) * 3;
            data.extend_from_slice(&self.data[i..i + w * 3]);
        }
        Rgb { w, h, data }
    }
}

// ────────────────────────────────────────────────────────────────
// Remuestreo separable (área / bilineal / Lanczos3)
// ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
pub enum Filter {
    /// Promedio de área: proxies de detección (equivale a INTER_AREA).
    Area,
    Triangle,
    /// Lanczos con a=3: fotogramas de las hojas (alta calidad).
    Lanczos3,
}

fn sinc(x: f32) -> f32 {
    if x.abs() < 1e-8 {
        1.0
    } else {
        let px = std::f32::consts::PI * x;
        px.sin() / px
    }
}

fn kernel(f: Filter, x: f32) -> f32 {
    match f {
        Filter::Area | Filter::Triangle => {
            let x = x.abs();
            if x < 1.0 { 1.0 - x } else { 0.0 }
        }
        Filter::Lanczos3 => {
            let x = x.abs();
            if x < 3.0 { sinc(x) * sinc(x / 3.0) } else { 0.0 }
        }
    }
}

fn support(f: Filter) -> f32 {
    match f {
        Filter::Area | Filter::Triangle => 1.0,
        Filter::Lanczos3 => 3.0,
    }
}

struct Weights {
    // por píxel destino: (inicio_src, pesos)
    entries: Vec<(usize, Vec<f32>)>,
}

fn build_weights(src_n: usize, dst_n: usize, f: Filter) -> Weights {
    let scale = src_n as f32 / dst_n as f32;
    // Al reducir, el kernel se ensancha (antialias); Area siempre lo hace.
    let fscale = if scale > 1.0 || f == Filter::Area { scale.max(1.0) } else { 1.0 };
    let sup = support(f) * fscale;
    let mut entries = Vec::with_capacity(dst_n);
    for d in 0..dst_n {
        let center = (d as f32 + 0.5) * scale;
        let lo = ((center - sup).floor().max(0.0)) as usize;
        let hi = ((center + sup).ceil() as usize).min(src_n);
        let mut ws = Vec::with_capacity(hi - lo);
        let mut sum = 0.0f32;
        for s in lo..hi {
            let w = kernel(f, (s as f32 + 0.5 - center) / fscale);
            ws.push(w);
            sum += w;
        }
        if sum.abs() < 1e-8 {
            ws = vec![1.0];
            entries.push((lo.min(src_n - 1), ws));
            continue;
        }
        for w in ws.iter_mut() {
            *w /= sum;
        }
        entries.push((lo, ws));
    }
    Weights { entries }
}

fn resize_channels(src: &[u8], sw: usize, sh: usize, ch: usize, dw: usize, dh: usize, f: Filter) -> Vec<u8> {
    // Horizontal y luego vertical, acumulando en f32.
    let wx = build_weights(sw, dw, f);
    let wy = build_weights(sh, dh, f);
    let mut tmp = vec![0.0f32; dw * sh * ch];
    for y in 0..sh {
        let row = &src[y * sw * ch..(y + 1) * sw * ch];
        for (d, (lo, ws)) in wx.entries.iter().enumerate() {
            let mut acc = [0.0f32; 4];
            for (k, &w) in ws.iter().enumerate() {
                let i = (lo + k) * ch;
                for c in 0..ch {
                    acc[c] += w * row[i + c] as f32;
                }
            }
            let o = (y * dw + d) * ch;
            for c in 0..ch {
                tmp[o + c] = acc[c];
            }
        }
    }
    let mut out = vec![0u8; dw * dh * ch];
    for (d, (lo, ws)) in wy.entries.iter().enumerate() {
        for x in 0..dw {
            let mut acc = [0.0f32; 4];
            for (k, &w) in ws.iter().enumerate() {
                let i = ((lo + k) * dw + x) * ch;
                for c in 0..ch {
                    acc[c] += w * tmp[i + c];
                }
            }
            let o = (d * dw + x) * ch;
            for c in 0..ch {
                out[o + c] = acc[c].round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

/// RGBA plano (canvas del navegador) con Lanczos3. Solo para imágenes
/// opacas: el alfa se remuestrea sin premultiplicar.
pub fn resize_rgba_bytes(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    resize_channels(src, sw, sh, 4, dw.max(1), dh.max(1), Filter::Lanczos3)
}

pub fn resize_rgb(src: &Rgb, dw: usize, dh: usize, f: Filter) -> Rgb {
    let (dw, dh) = (dw.max(1), dh.max(1));
    Rgb { w: dw, h: dh, data: resize_channels(&src.data, src.w, src.h, 3, dw, dh, f) }
}

pub fn resize_gray(src: &Gray, dw: usize, dh: usize, f: Filter) -> Gray {
    let (dw, dh) = (dw.max(1), dh.max(1));
    Gray { w: dw, h: dh, data: resize_channels(&src.data, src.w, src.h, 1, dw, dh, f) }
}

fn resize_channels_u16(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize, f: Filter) -> Vec<u16> {
    let ch = 3usize;
    let wx = build_weights(sw, dw, f);
    let wy = build_weights(sh, dh, f);
    let mut tmp = vec![0.0f32; dw * sh * ch];
    for y in 0..sh {
        let row = &src[y * sw * ch..(y + 1) * sw * ch];
        for (d, (lo, ws)) in wx.entries.iter().enumerate() {
            let mut acc = [0.0f32; 3];
            for (k, &w) in ws.iter().enumerate() {
                let i = (lo + k) * ch;
                for c in 0..3 {
                    acc[c] += w * row[i + c] as f32;
                }
            }
            let o = (y * dw + d) * ch;
            tmp[o..o + 3].copy_from_slice(&acc);
        }
    }
    let mut out = vec![0u16; dw * dh * ch];
    for (d, (lo, ws)) in wy.entries.iter().enumerate() {
        for x in 0..dw {
            let mut acc = [0.0f32; 3];
            for (k, &w) in ws.iter().enumerate() {
                let i = ((lo + k) * dw + x) * ch;
                for c in 0..3 {
                    acc[c] += w * tmp[i + c];
                }
            }
            let o = (d * dw + x) * ch;
            for c in 0..3 {
                out[o + c] = acc[c].round().clamp(0.0, 65535.0) as u16;
            }
        }
    }
    out
}

/// Reescala conservando la profundidad (para "reescalar al tamaño original").
pub fn resize_dyn(src: &DynImg, dw: usize, dh: usize, f: Filter) -> DynImg {
    let (dw, dh) = (dw.max(1), dh.max(1));
    match src {
        DynImg::U8(i) => DynImg::U8(resize_rgb(i, dw, dh, f)),
        DynImg::U16(i) => DynImg::U16(Rgb16 {
            w: dw,
            h: dh,
            data: resize_channels_u16(&i.data, i.w, i.h, dw, dh, f),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_preserves_flat() {
        let img = Rgb::new(100, 60, [123, 45, 200]);
        let out = resize_rgb(&img, 33, 21, Filter::Lanczos3);
        assert_eq!(out.px(16, 10), [123, 45, 200]);
        let out = resize_rgb(&img, 13, 7, Filter::Area);
        assert_eq!(out.px(6, 3), [123, 45, 200]);
    }

    #[test]
    fn resize_rgba_flat_and_opaque() {
        let src: Vec<u8> = std::iter::repeat([9u8, 120, 240, 255]).take(40 * 30).flatten().collect();
        for (dw, dh) in [(80usize, 60usize), (13, 9)] {
            let out = resize_rgba_bytes(&src, 40, 30, dw, dh);
            assert_eq!(out.len(), dw * dh * 4);
            assert_eq!(&out[..4], &[9, 120, 240, 255]);
            assert!(out.chunks_exact(4).all(|p| p == [9, 120, 240, 255]));
        }
    }

    #[test]
    fn gray_flip() {
        let mut g = Gray::new(3, 1, 0);
        g.data = vec![1, 2, 3];
        assert_eq!(g.flip_horizontal().data, vec![3, 2, 1]);
    }
}
