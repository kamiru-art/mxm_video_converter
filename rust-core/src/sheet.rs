//! Composición de contact sheets: port fiel de la fase ① de la app original.
//! Los nombres de los campos de ajustes y del layout.json se conservan para
//! que los proyectos existentes (v1/v2) sigan siendo compatibles.

use crate::aruco::{generate_marker, Dict};
use crate::cyanotype as cyan;
use crate::geometry::{warp_rgb_fill, H3};
use crate::img::{resize_rgb, Filter, Gray, Rgb};
use crate::qr;
use crate::text;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

pub const MM_PER_INCH: f64 = 25.4;
pub const PATCH_LEVELS: [u8; 5] = [0, 64, 128, 192, 255];
pub const MIN_LABEL_PT: f64 = 6.0;

pub fn mm_to_px(mm: f64, dpi: u32) -> i64 {
    (mm / MM_PER_INCH * dpi as f64).round() as i64
}

pub fn pt_to_px(pt: f64, dpi: u32) -> i64 {
    ((pt / 72.0 * dpi as f64).round() as i64).max(1)
}

/// Dimensiones en mm (vertical) por nombre de papel.
pub fn paper_mm(name: &str) -> Option<(f64, f64)> {
    match name {
        "A3" => Some((297.0, 420.0)),
        "A4" => Some((210.0, 297.0)),
        "A5" => Some((148.0, 210.0)),
        "A6" => Some((105.0, 148.0)),
        "B4" => Some((250.0, 353.0)),
        "B5" => Some((176.0, 250.0)),
        "Carta (Letter)" | "Letter" => Some((215.9, 279.4)),
        "Oficio (Legal)" | "Legal" => Some((215.9, 355.6)),
        "Tabloide (Tabloid)" | "Tabloid" => Some((279.4, 431.8)),
        _ => None, // Personalizado
    }
}

pub fn page_size_px(paper: &str, dpi: u32, landscape: bool, cw: f64, ch: f64) -> (i64, i64) {
    let (mut w, mut h) = paper_mm(paper).unwrap_or((cw, ch));
    if landscape {
        std::mem::swap(&mut w, &mut h);
    }
    (mm_to_px(w, dpi), mm_to_px(h, dpi))
}

fn default_true() -> bool { true }
fn d_paper() -> String { "A4".into() }
fn d_orientation() -> String { "Vertical".into() }
fn d_dpi() -> u32 { 300 }
fn d_custom_w() -> f64 { 210.0 }
fn d_custom_h() -> f64 { 297.0 }
fn d_margin() -> f64 { 10.0 }
fn d_gutter() -> f64 { 5.0 }
fn d_white() -> String { "#FFFFFF".into() }
fn d_black() -> String { "#000000".into() }
fn d_alpha_mode() -> String { "ninguno".into() }
fn d_alpha_border_mm() -> f64 { 0.5 }
fn d_cols() -> u32 { 4 }
fn d_rows() -> u32 { 5 }
fn d_base_name() -> String { "abc".into() }
fn d_sep() -> String { "_".into() }
fn d_one() -> i64 { 1 }
fn d_font_pt() -> f64 { 9.0 }
fn d_label_gap() -> f64 { 1.5 }
fn d_corner() -> String { "Inferior derecha".into() }
fn d_page_pt() -> f64 { 11.0 }
fn d_marker_count() -> u32 { 8 }
fn d_marker_mm() -> f64 { 8.0 }
fn d_marker_margin() -> f64 { 4.0 }
fn d_dict() -> String { "DICT_4X4_50".into() }
fn d_qr_mm() -> f64 { 10.0 }
fn d_mode() -> String { "normal".into() }
fn d_100() -> f64 { 100.0 }
fn d_cyan_bg() -> String { "ahorro".into() }
fn d_halo() -> f64 { 5.0 }
fn d_frame_border() -> f64 { 0.8 }
fn d_scale() -> f64 { 1.0 }
fn d_out_name() -> String { "contact_sheet".into() }

/// Ajustes de generación. Mismos nombres que el snapshot del layout.json
/// original, para compatibilidad bidireccional (hojas de rescate incluidas).
#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "d_paper")] pub paper: String,
    #[serde(default = "d_orientation")] pub orientation: String,
    #[serde(default = "d_dpi")] pub dpi: u32,
    #[serde(default = "d_custom_w")] pub custom_w_mm: f64,
    #[serde(default = "d_custom_h")] pub custom_h_mm: f64,
    #[serde(default = "d_margin")] pub margin_mm: f64,
    #[serde(default = "d_gutter")] pub gutter_mm: f64,
    #[serde(default = "d_white")] pub bg_color: String,
    #[serde(default = "d_alpha_mode")] pub alpha_mode: String,
    #[serde(default = "d_black")] pub alpha_bg_color: String,
    #[serde(default = "d_black")] pub alpha_border_color: String,
    #[serde(default = "d_alpha_border_mm")] pub alpha_border_mm: f64,
    #[serde(default = "d_cols")] pub cols: u32,
    #[serde(default = "d_rows")] pub rows: u32,
    #[serde(default = "default_true")] pub labels_on: bool,
    #[serde(default = "d_base_name")] pub base_name: String,
    #[serde(default = "d_sep")] pub separator: String,
    #[serde(default = "d_one")] pub leading_zeros: i64,
    #[serde(default = "d_one")] pub start_index: i64,
    #[serde(default)] pub font_path: Option<String>, // ignorado (fuente incrustada)
    #[serde(default = "d_font_pt")] pub font_size_pt: f64,
    #[serde(default = "d_label_gap")] pub label_gap_mm: f64,
    #[serde(default = "d_black")] pub label_color: String,
    #[serde(default = "default_true")] pub page_num_on: bool,
    #[serde(default = "d_corner")] pub page_num_corner: String,
    #[serde(default)] pub page_num_prefix: String,
    #[serde(default = "d_one")] pub page_num_start: i64,
    #[serde(default = "d_one")] pub page_num_zeros: i64,
    #[serde(default = "d_page_pt")] pub page_num_size_pt: f64,
    #[serde(default = "d_black")] pub page_num_color: String,
    #[serde(default)] pub registration_on: bool,
    #[serde(default = "d_marker_count")] pub marker_count: u32,
    #[serde(default = "d_marker_mm")] pub marker_size_mm: f64,
    #[serde(default = "d_marker_margin")] pub marker_margin_mm: f64,
    #[serde(default = "d_dict")] pub marker_dict: String,
    #[serde(default = "default_true")] pub qr_on: bool,
    #[serde(default = "d_qr_mm")] pub qr_size_mm: f64,
    #[serde(default)] pub gray_patch_on: bool,
    #[serde(default)] pub project_name: String,
    #[serde(default = "d_mode")] pub mode: String,
    #[serde(default = "default_true")] pub cyan_mirror: bool,
    #[serde(default = "d_black")] pub cyan_ink: String,
    #[serde(default)] pub cyan_curve: Option<Vec<f64>>,
    #[serde(default = "d_100")] pub cyan_curve_strength: f64,
    #[serde(default)] pub cyan_adaptive: f64,
    #[serde(default)] pub cyan_clarity: f64,
    #[serde(default = "d_cyan_bg")] pub cyan_bg: String,
    #[serde(default = "d_halo")] pub cyan_halo_mm: f64,
    #[serde(default = "d_frame_border")] pub cyan_frame_border_mm: f64,
    #[serde(default)] pub cyan_block_color: Option<String>,
    #[serde(default)] pub cyan_ink_stops: Option<Vec<(f64, String)>>,
    #[serde(default = "d_scale")] pub print_scale_x: f64,
    #[serde(default = "d_scale")] pub print_scale_y: f64,
    #[serde(default = "d_out_name")] pub out_name: String,
    #[serde(default = "default_true")] pub fmt_png: bool,
    #[serde(default = "default_true")] pub fmt_pdf: bool,
    #[serde(default)] pub fmt_tiff: bool,
}

impl Default for Settings {
    fn default() -> Self {
        serde_json::from_value(json!({})).unwrap()
    }
}

impl Settings {
    pub fn per_page(&self) -> usize {
        ((self.cols * self.rows) as usize).max(1)
    }
    pub fn is_cyanotype(&self) -> bool {
        self.mode.to_lowercase().starts_with("cian")
    }
    pub fn ink_stops(&self) -> Option<Vec<cyan::InkStop>> {
        self.cyan_ink_stops.as_ref().map(|ss| {
            ss.iter().map(|(d, c)| (*d, cyan::hex_to_rgb(c))).collect()
        })
    }
    pub fn format_page_label(&self, num: i64) -> String {
        let mut s = num.to_string();
        if self.page_num_zeros > 1 {
            while (s.len() as i64) < self.page_num_zeros {
                s.insert(0, '0');
            }
        }
        format!("{}{}", self.page_num_prefix, s)
    }
    pub fn format_label(&self, num: i64) -> String {
        let mut s = num.to_string();
        if self.leading_zeros > 1 {
            while (s.len() as i64) < self.leading_zeros {
                s.insert(0, '0');
            }
        }
        if self.base_name.is_empty() {
            s
        } else {
            format!("{}{}{}", self.base_name, self.separator, s)
        }
    }
}

// ────────────────────────────────────────────────────────────────
// Posiciones de los marcadores (port de markers.py)
// ────────────────────────────────────────────────────────────────

pub fn marker_layout(
    page_w: i64,
    page_h: i64,
    count: u32,
    side: i64,
    margin: i64,
    quiet: i64,
) -> BTreeMap<u32, (i64, i64)> {
    let count = if [4u32, 8, 12].contains(&count) {
        count
    } else {
        *[4u32, 8, 12].iter().min_by_key(|&&c| (c as i64 - count as i64).abs()).unwrap()
    };
    let patch = side + 2 * quiet;
    let m = margin;
    let (x_left, x_right) = (m, page_w - m - patch);
    let (y_top, y_bot) = (m, page_h - m - patch);
    let x_mid = (page_w - patch) / 2;
    let y_mid = (page_h - patch) / 2;
    let mut pos = BTreeMap::new();
    pos.insert(0, (x_left, y_top));
    pos.insert(1, (x_right, y_top));
    pos.insert(2, (x_right, y_bot));
    pos.insert(3, (x_left, y_bot));
    if count >= 8 {
        pos.insert(4, (x_mid, y_top));
        pos.insert(5, (x_right, y_mid));
        pos.insert(6, (x_mid, y_bot));
        pos.insert(7, (x_left, y_mid));
    }
    if count >= 12 {
        let x13 = x_left + (x_right - x_left) / 3;
        let x23 = x_left + (x_right - x_left) * 2 / 3;
        pos.insert(8, (x13, y_top));
        pos.insert(9, (x23, y_top));
        pos.insert(10, (x13, y_bot));
        pos.insert(11, (x23, y_bot));
    }
    pos
}

pub fn marker_bboxes(
    page_w: i64,
    page_h: i64,
    count: u32,
    side: i64,
    margin: i64,
    quiet: i64,
) -> BTreeMap<u32, [i64; 4]> {
    marker_layout(page_w, page_h, count, side, margin, quiet)
        .into_iter()
        .map(|(id, (px, py))| {
            let (x1, y1) = (px + quiet, py + quiet);
            (id, [x1, y1, x1 + side, y1 + side])
        })
        .collect()
}

// ────────────────────────────────────────────────────────────────
// Layout calculado
// ────────────────────────────────────────────────────────────────

pub struct Layout {
    pub dpi: u32,
    pub margin: i64,
    pub gutter: i64,
    pub label_gap: i64,
    pub label_px: f32,   // tamaño de fuente de etiquetas en px
    pub label_h: i64,
    pub page_px: f32,    // tamaño de fuente del numerador en px
    pub landscape: bool,
    pub page_w: i64,
    pub page_h: i64,
    pub cols: u32,
    pub rows: u32,
    pub cell_w: f64,
    pub cell_h: f64,
    pub label_area: i64,
    pub img_area_h: f64,
    pub meta_h: i64,
    pub qr_px: i64,
    pub halo_px: i64,
    pub marker_side: i64,
    pub marker_quiet: i64,
    pub marker_patch: i64,
    pub marker_margin: i64,
    pub marker_positions: Option<BTreeMap<u32, (i64, i64)>>,
    pub marker_bboxes: Option<BTreeMap<u32, [i64; 4]>>,
    pub patch_strip: Option<Vec<([i64; 4], u8)>>,
}

fn marker_dims(s: &Settings, dpi: u32) -> (i64, i64, i64) {
    let side = mm_to_px(s.marker_size_mm, dpi).max(8);
    let quiet = (side / if s.is_cyanotype() { 4 } else { 7 }).max(2);
    (side, quiet, side + 2 * quiet)
}

fn effective_margin(s: &Settings, dpi: u32) -> i64 {
    let mut margin = mm_to_px(s.margin_mm, dpi);
    if s.registration_on {
        let (_, _, patch) = marker_dims(s, dpi);
        let band = mm_to_px(s.marker_margin_mm, dpi) + patch + mm_to_px(2.0, dpi);
        margin = margin.max(band);
    }
    margin
}

pub fn cyan_saving(s: &Settings) -> bool {
    s.is_cyanotype() && s.cyan_bg.to_lowercase().starts_with("ahorro")
}

fn meta_content_height(s: &Settings, label_h: i64, dpi: u32) -> i64 {
    let mut h = if s.labels_on { label_h } else { 0 };
    if s.registration_on && s.qr_on {
        h = h.max(mm_to_px(s.qr_size_mm, dpi));
    }
    h
}

fn frame_fit_area(
    s: &Settings,
    landscape: bool,
    src_w: f64,
    src_h: f64,
    meta_h: i64,
    label_gap: i64,
    cols: u32,
    rows: u32,
) -> f64 {
    let dpi = s.dpi;
    let (page_w, page_h) = page_size_px(&s.paper, dpi, landscape, s.custom_w_mm, s.custom_h_mm);
    let margin = effective_margin(s, dpi);
    let gutter = mm_to_px(s.gutter_mm, dpi);
    let content_w = (page_w - 2 * margin) as f64;
    let content_h = (page_h - 2 * margin) as f64;
    if content_w <= 0.0 || content_h <= 0.0 {
        return -1.0;
    }
    let cell_w = (content_w - ((cols - 1) as i64 * gutter) as f64) / cols as f64;
    let cell_h = (content_h - ((rows - 1) as i64 * gutter) as f64) / rows as f64;
    let meta_area = if meta_h > 0 { (meta_h + label_gap) as f64 } else { 0.0 };
    let img_area_h = cell_h - meta_area;
    if cell_w <= 1.0 || img_area_h <= 1.0 || src_w <= 0.0 || src_h <= 0.0 {
        return -1.0;
    }
    let scale = (cell_w / src_w).min(img_area_h / src_h);
    (src_w * scale) * (src_h * scale)
}

/// Decide orientación y cuadrícula ("mejor ajuste" prueba las 4 combinaciones).
pub fn resolve_page_layout(
    s: &Settings,
    first_frame: (f64, f64),
    meta_h: i64,
    label_gap: i64,
) -> (bool, u32, u32) {
    let o = s.orientation.trim().to_lowercase();
    if o.starts_with("horizontal") {
        return (true, s.cols, s.rows);
    }
    if o.starts_with("vertical") {
        return (false, s.cols, s.rows);
    }
    let (sw, sh) = first_frame;
    let mut candidates = vec![(false, s.cols, s.rows), (true, s.cols, s.rows)];
    if s.cols != s.rows {
        candidates.push((false, s.rows, s.cols));
        candidates.push((true, s.rows, s.cols));
    }
    let mut best = candidates[0];
    let mut best_area = -1.0;
    for &(l, c, r) in &candidates {
        let a = frame_fit_area(s, l, sw, sh, meta_h, label_gap, c, r);
        if a > best_area + 1e-9 {
            best = (l, c, r);
            best_area = a;
        }
    }
    best
}

fn patch_strip_geometry(s: &Settings, l: &Layout) -> Option<Vec<([i64; 4], u8)>> {
    let side = l.marker_side;
    let gap = (side / 8).max(2);
    let n = PATCH_LEVELS.len() as i64;
    let total_h = n * side + (n - 1) * gap;
    let y_free_top = l.marker_margin + l.marker_patch + gap * 2;
    let y_free_bot = if s.marker_count >= 8 {
        (l.page_h - side) / 2 - gap * 2
    } else {
        l.page_h - l.marker_margin - l.marker_patch - gap * 2
    };
    if y_free_bot - y_free_top < total_h {
        return None;
    }
    let x = l.marker_margin + l.marker_quiet;
    let y0 = y_free_top + ((y_free_bot - y_free_top) - total_h) / 2;
    let mut strip = Vec::new();
    for (i, &nivel) in PATCH_LEVELS.iter().enumerate() {
        let y = y0 + i as i64 * (side + gap);
        strip.push(([x, y, x + side, y + side], nivel));
    }
    Some(strip)
}

/// Calcula la geometría completa de una hoja.
pub fn build_layout(s: &Settings, first_frame: (f64, f64)) -> Result<Layout, String> {
    let dpi = s.dpi;
    let margin = effective_margin(s, dpi);
    let gutter = mm_to_px(s.gutter_mm, dpi);

    let label_px = pt_to_px(s.font_size_pt, dpi) as f32;
    let label_h = if s.labels_on {
        text::text_size("Ay1", label_px).1 as i64
    } else {
        0
    };
    let page_px = pt_to_px(s.page_num_size_pt, dpi) as f32;

    let meta_h = meta_content_height(s, label_h, dpi);
    let mut label_gap = if meta_h > 0 { mm_to_px(s.label_gap_mm, dpi) } else { 0 };
    let halo_px = mm_to_px(s.cyan_halo_mm.max(0.0), dpi);
    let meta_halo = if cyan_saving(s) && meta_h > 0 { halo_px } else { 0 };
    if meta_halo > 0 {
        label_gap = label_gap.max(meta_halo + mm_to_px(0.5, dpi));
    }

    let (landscape, cols, rows) = resolve_page_layout(s, first_frame, meta_h + meta_halo, label_gap);
    let (page_w, page_h) = page_size_px(&s.paper, dpi, landscape, s.custom_w_mm, s.custom_h_mm);
    let content_w = (page_w - 2 * margin) as f64;
    let content_h = (page_h - 2 * margin) as f64;
    if content_w <= 0.0 || content_h <= 0.0 {
        return Err("The margins are too large for the sheet size.".into());
    }
    let cell_w = (content_w - ((cols - 1) as i64 * gutter) as f64) / cols as f64;
    let cell_h = (content_h - ((rows - 1) as i64 * gutter) as f64) / rows as f64;
    let label_area = if meta_h > 0 { meta_h + meta_halo + label_gap } else { 0 };
    let img_area_h = cell_h - label_area as f64;
    if cell_w <= 1.0 || img_area_h <= 1.0 {
        return Err(
            "Not enough room for the cells. Reduce columns/rows, margins, \
             gutter or halo, or increase the sheet size/DPI."
                .into(),
        );
    }

    let mut l = Layout {
        dpi,
        margin,
        gutter,
        label_gap,
        label_px,
        label_h,
        page_px,
        landscape,
        page_w,
        page_h,
        cols,
        rows,
        cell_w,
        cell_h,
        label_area,
        img_area_h,
        meta_h,
        qr_px: if s.registration_on && s.qr_on { mm_to_px(s.qr_size_mm, dpi) } else { 0 },
        halo_px,
        marker_side: 0,
        marker_quiet: 0,
        marker_patch: 0,
        marker_margin: 0,
        marker_positions: None,
        marker_bboxes: None,
        patch_strip: None,
    };
    if s.registration_on {
        let (side, quiet, patch) = marker_dims(s, dpi);
        let mmargin = mm_to_px(s.marker_margin_mm, dpi);
        l.marker_side = side;
        l.marker_quiet = quiet;
        l.marker_patch = patch;
        l.marker_margin = mmargin;
        l.marker_positions = Some(marker_layout(page_w, page_h, s.marker_count, side, mmargin, quiet));
        l.marker_bboxes = Some(marker_bboxes(page_w, page_h, s.marker_count, side, mmargin, quiet));
        if s.gray_patch_on {
            l.patch_strip = patch_strip_geometry(s, &l);
        }
    }
    Ok(l)
}

// ────────────────────────────────────────────────────────────────
// Colores derivados y utilidades de dibujo
// ────────────────────────────────────────────────────────────────

fn ink_full_color(s: &Settings) -> [u8; 3] {
    if let Some(bc) = &s.cyan_block_color {
        if !bc.is_empty() {
            return cyan::hex_to_rgb(bc);
        }
    }
    cyan::solid_density_color(255.0, &s.cyan_ink, s.ink_stops().as_deref())
}

fn page_bg_color(s: &Settings) -> [u8; 3] {
    if s.is_cyanotype() {
        if cyan_saving(s) {
            return [255, 255, 255];
        }
        return ink_full_color(s);
    }
    cyan::hex_to_rgb(&s.bg_color)
}

fn alpha_base_color(s: &Settings) -> [u8; 3] {
    if s.alpha_mode.to_lowercase().starts_with("color") {
        return cyan::hex_to_rgb(&s.alpha_bg_color);
    }
    if s.is_cyanotype() {
        return [255, 255, 255];
    }
    cyan::hex_to_rgb(&s.bg_color)
}

fn label_text_color(s: &Settings) -> [u8; 3] {
    if s.is_cyanotype() {
        [255, 255, 255]
    } else {
        cyan::hex_to_rgb(&s.label_color)
    }
}

fn halo_rect(canvas: &mut Rgb, s: &Settings, bbox: [i64; 4], halo: i64) {
    let c = ink_full_color(s);
    canvas.fill_rect(bbox[0] - halo, bbox[1] - halo, bbox[2] + halo, bbox[3] + halo, c);
}

/// Relleno de un triángulo por prueba de semi-planos (áreas pequeñas).
fn fill_triangle(canvas: &mut Rgb, pts: [(i64, i64); 3], color: [u8; 3]) {
    let min_x = pts.iter().map(|p| p.0).min().unwrap().max(0);
    let max_x = pts.iter().map(|p| p.0).max().unwrap().min(canvas.w as i64 - 1);
    let min_y = pts.iter().map(|p| p.1).min().unwrap().max(0);
    let max_y = pts.iter().map(|p| p.1).max().unwrap().min(canvas.h as i64 - 1);
    let edge = |a: (i64, i64), b: (i64, i64), p: (i64, i64)| {
        (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0)
    };
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let p = (x, y);
            let e0 = edge(pts[0], pts[1], p);
            let e1 = edge(pts[1], pts[2], p);
            let e2 = edge(pts[2], pts[0], p);
            if (e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0) {
                canvas.set_px(x as usize, y as usize, color);
            }
        }
    }
}

/// Parche de marcador (marcador + zona de silencio), como markers.marker_patch.
pub fn marker_patch_gray(dict: Dict, id: u32, side: i64, quiet: i64) -> Gray {
    let m = generate_marker(dict, id as usize, side as usize);
    let total = (side + 2 * quiet) as usize;
    let mut patch = Gray::new(total, total, 255);
    for y in 0..m.h {
        for x in 0..m.w {
            patch.data[(y + quiet as usize) * total + (x + quiet as usize)] = m.data[y * m.w + x];
        }
    }
    patch
}

fn gray_to_rgb(g: &Gray) -> Rgb {
    let mut data = Vec::with_capacity(g.w * g.h * 3);
    for &v in &g.data {
        data.extend_from_slice(&[v, v, v]);
    }
    Rgb { w: g.w, h: g.h, data }
}

fn draw_registration_frame(s: &Settings, l: &Layout, canvas: &mut Rgb) {
    let saving = cyan_saving(s);
    let dict = Dict::from_name(&s.marker_dict);
    let stops = s.ink_stops();
    if let Some(positions) = &l.marker_positions {
        for (&mid, &(px, py)) in positions {
            let patch = marker_patch_gray(dict, mid, l.marker_side, l.marker_quiet);
            let rgb = if s.is_cyanotype() {
                if saving {
                    halo_rect(canvas, s, [px, py, px + patch.w as i64, py + patch.h as i64], l.halo_px);
                }
                cyan::colorize_gray_patch(&patch, &s.cyan_ink, stops.as_deref())
            } else {
                gray_to_rgb(&patch)
            };
            canvas.paste(&rgb, px, py);
        }
        if s.is_cyanotype() {
            // Triángulo testigo de orientación junto al marcador TL.
            let (tlx, tly) = positions[&0];
            let tri_h = (l.marker_side / 2).max(8);
            let x0 = tlx + l.marker_patch + 2 * l.halo_px + l.marker_quiet.max(6);
            let y0 = tly + (l.marker_patch - tri_h) / 2;
            if saving {
                halo_rect(canvas, s, [x0, y0, x0 + tri_h, y0 + tri_h], l.halo_px);
            }
            let tri = if s.cyan_mirror {
                [(x0, y0), (x0 + tri_h, y0 + tri_h / 2), (x0, y0 + tri_h)]
            } else {
                [(x0 + tri_h, y0), (x0, y0 + tri_h / 2), (x0 + tri_h, y0 + tri_h)]
            };
            fill_triangle(canvas, tri, [255, 255, 255]);
        }
    }
    if let Some(strip) = &l.patch_strip {
        if saving {
            let x1 = strip.iter().map(|(b, _)| b[0]).min().unwrap();
            let y1 = strip.iter().map(|(b, _)| b[1]).min().unwrap();
            let x2 = strip.iter().map(|(b, _)| b[2]).max().unwrap();
            let y2 = strip.iter().map(|(b, _)| b[3]).max().unwrap();
            halo_rect(canvas, s, [x1, y1, x2, y2], l.halo_px);
        }
        for &(bbox, nivel) in strip {
            let color = if s.is_cyanotype() {
                cyan::solid_density_color(nivel as f64, &s.cyan_ink, s.ink_stops().as_deref())
            } else {
                [nivel, nivel, nivel]
            };
            canvas.fill_rect(bbox[0], bbox[1], bbox[2], bbox[3], color);
        }
    }
}

// ────────────────────────────────────────────────────────────────
// Ajuste de etiquetas (fuente que se achica, elipsis)
// ────────────────────────────────────────────────────────────────

/// (texto_visible, px_fuente, tw, th, reducido)
fn fit_meta_text(s: &Settings, dpi: u32, text_str: &str, avail_w: i64) -> (String, f32, i64, i64, bool) {
    if avail_w <= 0 {
        return (String::new(), 0.0, 0, 0, true);
    }
    let base_px = pt_to_px(s.font_size_pt, dpi) as f32;
    let (tw, th) = text::text_size(text_str, base_px);
    if (tw as i64) <= avail_w {
        return (text_str.to_string(), base_px, tw as i64, th as i64, false);
    }
    let mut pt = s.font_size_pt;
    while pt > MIN_LABEL_PT {
        pt = (pt - 1.0).max(MIN_LABEL_PT);
        let px = pt_to_px(pt, dpi) as f32;
        let (tw, th) = text::text_size(text_str, px);
        if (tw as i64) <= avail_w {
            return (text_str.to_string(), px, tw as i64, th as i64, true);
        }
    }
    let px = pt_to_px(MIN_LABEL_PT, dpi) as f32;
    let mut base: String = text_str.to_string();
    while !base.is_empty() {
        base.pop();
        let cand = format!("{base}…");
        let (tw, th) = text::text_size(&cand, px);
        if (tw as i64) <= avail_w {
            return (cand, px, tw as i64, th as i64, true);
        }
    }
    (String::new(), px, 0, 0, true)
}

struct MetaRow {
    qr_px: i64,
    qx: i64,
    qy: i64,
    texto: String,
    font_px: f32,
    tw: i64,
    th: i64,
    tx: i64,
    ty: i64,
    total_w: i64,
}

fn meta_row_geometry(s: &Settings, l: &Layout, text_str: &str, cell_x: f64, meta_top: f64) -> MetaRow {
    let margen = if cyan_saving(s) { l.halo_px } else { 0 };
    let avail = ((l.cell_w as i64) - 2 * margen).max(8);
    let qr_px = l.qr_px.min(avail);
    let (mut texto, mut font_px, mut tw, mut th) = (String::new(), l.label_px, 0i64, 0i64);
    if s.labels_on {
        let gap = (qr_px / 8).max(6);
        let (t, fpx, w, h, _r) = fit_meta_text(s, l.dpi, text_str, avail - qr_px - gap);
        texto = t;
        font_px = fpx;
        tw = w;
        th = h;
    }
    let gap = if tw > 0 { (qr_px / 8).max(6) } else { 0 };
    let total_w = qr_px + gap + tw;
    let qx = (cell_x + (l.cell_w - total_w as f64) / 2.0).round() as i64;
    let qy = (meta_top + ((l.meta_h - qr_px) as f64) / 2.0).round() as i64;
    MetaRow {
        qr_px,
        qx,
        qy,
        texto,
        font_px,
        tw,
        th,
        tx: qx + qr_px + gap,
        ty: (meta_top + ((l.meta_h - th) as f64) / 2.0).round() as i64,
        total_w,
    }
}

// ────────────────────────────────────────────────────────────────
// Render de una hoja
// ────────────────────────────────────────────────────────────────

/// Fotograma de entrada (RGBA de 8 bits decodificado por el navegador).
pub struct FrameInput {
    pub w: usize,
    pub h: usize,
    /// RGBA; None = solo geometría (no se renderiza).
    pub rgba: Option<Vec<u8>>,
    pub has_alpha: bool,
    /// Nombre del archivo original (para el layout.json).
    pub orig_name: String,
    /// Ruta relativa de la copia original, si se guardó (originales_dir/...).
    pub orig_file: Option<String>,
}

fn flatten_rgba(rgba: &[u8], w: usize, h: usize, base: [u8; 3]) -> Rgb {
    let mut data = Vec::with_capacity(w * h * 3);
    for p in rgba.chunks_exact(4) {
        let a = p[3] as u32;
        for c in 0..3 {
            data.push((((p[c] as u32) * a + (base[c] as u32) * (255 - a)) / 255) as u8);
        }
    }
    Rgb { w, h, data }
}

fn unique_key(usadas: &mut HashSet<String>, base: &str) -> String {
    if !usadas.contains(base) {
        usadas.insert(base.to_string());
        return base.to_string();
    }
    let mut n = 1;
    loop {
        n += 1;
        let cand = format!("{base}_{n}");
        if !usadas.contains(&cand) {
            usadas.insert(cand.clone());
            return cand;
        }
    }
}

pub struct PageResult {
    pub image: Option<Rgb>,
    pub record: Option<Value>,
}

/// Dibuja (o solo mide) UNA hoja. `frames` y `labels` son los de esta hoja.
pub fn render_page(
    s: &Settings,
    l: &Layout,
    frames: &[FrameInput],
    labels: &[String],
    sheet_num: i64,
    render: bool,
) -> PageResult {
    let mut canvas = if render {
        let mut c = Rgb::new(l.page_w as usize, l.page_h as usize, page_bg_color(s));
        if s.registration_on {
            draw_registration_frame(s, l, &mut c);
        }
        Some(c)
    } else {
        None
    };

    let mut record = if s.registration_on {
        Some(json!({ "numero": sheet_num, "frames": {}, "qrs": {} }))
    } else {
        None
    };
    let saving = cyan_saving(s);
    let label_color = label_text_color(s);
    let stops = s.ink_stops();
    let mut claves: HashSet<String> = HashSet::new();

    for (cell_idx, frame) in frames.iter().enumerate() {
        let row = cell_idx as u32 / l.cols;
        let col = cell_idx as u32 % l.cols;
        let cell_x = l.margin as f64 + col as f64 * (l.cell_w + l.gutter as f64);
        let cell_y = l.margin as f64 + row as f64 * (l.cell_h + l.gutter as f64);

        let (src_w, src_h) = (frame.w as f64, frame.h as f64);
        if src_w <= 0.0 || src_h <= 0.0 {
            continue;
        }
        let scale = (l.cell_w / src_w).min(l.img_area_h / src_h);
        let new_w = ((src_w * scale).round() as i64).max(1);
        let new_h = ((src_h * scale).round() as i64).max(1);
        let block_h = new_h + l.label_area;
        let block_top = cell_y + (l.cell_h - block_h as f64) / 2.0;
        let px = (cell_x + (l.cell_w - new_w as f64) / 2.0).round() as i64;
        let py = block_top.round() as i64;

        if let (Some(canvas), Some(rgba)) = (canvas.as_mut(), frame.rgba.as_ref()) {
            let flat = flatten_rgba(rgba, frame.w, frame.h, alpha_base_color(s));
            let mut resized = resize_rgb(&flat, new_w as usize, new_h as usize, Filter::Lanczos3);
            if s.is_cyanotype() {
                resized = cyan::make_negative(
                    &resized,
                    s.cyan_curve.as_deref(),
                    &s.cyan_ink,
                    stops.as_deref(),
                    s.cyan_clarity,
                );
            }
            canvas.paste(&resized, px, py);

            if s.is_cyanotype() && s.cyan_frame_border_mm > 0.0 {
                let bw = mm_to_px(s.cyan_frame_border_mm, l.dpi).max(1);
                canvas.stroke_rect(px - bw, py - bw, px + new_w + bw, py + new_h + bw, bw, ink_full_color(s));
            } else if frame.has_alpha
                && !s.is_cyanotype()
                && s.alpha_mode.to_lowercase().starts_with("borde")
                && s.alpha_border_mm > 0.0
            {
                let bw = mm_to_px(s.alpha_border_mm, l.dpi).max(1);
                canvas.stroke_rect(
                    px - bw,
                    py - bw,
                    px + new_w + bw,
                    py + new_h + bw,
                    bw,
                    cyan::hex_to_rgb(&s.alpha_border_color),
                );
            }
        }

        let text_str = labels.get(cell_idx).cloned().unwrap_or_else(|| format!("frame_{cell_idx}"));
        let clave = if record.is_some() {
            unique_key(&mut claves, &text_str)
        } else {
            text_str.clone()
        };

        let meta_top = (py + new_h + l.label_gap) as f64;
        if l.qr_px > 0 && record.is_some() {
            let project = if s.project_name.is_empty() { &s.out_name } else { &s.project_name };
            let payload = qr::qr_payload(project, sheet_num, cell_idx as i64, &text_str);
            let fila = meta_row_geometry(s, l, &text_str, cell_x, meta_top);
            if let Some(canvas) = canvas.as_mut() {
                if saving {
                    halo_rect(
                        canvas,
                        s,
                        [fila.qx, meta_top as i64, fila.qx + fila.total_w, meta_top as i64 + l.meta_h],
                        l.halo_px,
                    );
                }
                let qr_gray = qr::qr_image(&payload, fila.qr_px as usize, false);
                let qr_rgb = if s.is_cyanotype() {
                    cyan::colorize_gray_patch(&qr_gray, &s.cyan_ink, stops.as_deref())
                } else {
                    gray_to_rgb(&qr_gray)
                };
                canvas.paste(&qr_rgb, fila.qx, fila.qy);
                if fila.tw > 0 {
                    text::draw_text(canvas, &fila.texto, fila.tx, fila.ty, fila.font_px, label_color);
                }
            }
            if let Some(rec) = record.as_mut() {
                rec["qrs"][&clave] = json!({
                    "bbox": [fila.qx, fila.qy, fila.qx + fila.qr_px, fila.qy + fila.qr_px],
                    "celda": cell_idx,
                    "texto": payload,
                    "etiqueta": text_str,
                });
            }
        } else if s.labels_on {
            if let Some(canvas) = canvas.as_mut() {
                let margen = if saving { l.halo_px } else { 0 };
                let avail = ((l.cell_w as i64) - 2 * margen).max(8);
                let (texto, fpx, tw, th, _r) = fit_meta_text(s, l.dpi, &text_str, avail);
                if tw > 0 {
                    let tx = (cell_x + (l.cell_w - tw as f64) / 2.0).round() as i64;
                    let ty = (meta_top + ((l.meta_h - th) as f64) / 2.0).round() as i64;
                    if saving {
                        halo_rect(canvas, s, [tx, ty, tx + tw, ty + th], l.halo_px);
                    }
                    text::draw_text(canvas, &texto, tx, ty, fpx, label_color);
                }
            }
        }

        if let Some(rec) = record.as_mut() {
            let orig = frame.orig_file.clone().unwrap_or_else(|| frame.orig_name.clone());
            rec["frames"][&clave] = json!({
                "bbox": [px, py, px + new_w, py + new_h],
                "celda": cell_idx,
                "archivo_original": orig,
                "orig_px": [frame.w, frame.h],
                "etiqueta": text_str,
            });
        }
    }

    // Numerador de hoja
    if s.page_num_on {
        if let Some(canvas) = canvas.as_mut() {
            let pno = s.format_page_label(sheet_num);
            let (tw, th) = text::text_size(&pno, l.page_px);
            let (tw, th) = (tw as i64, th as i64);
            let corner = s.page_num_corner.as_str();
            let pos: (i64, i64) = if s.registration_on {
                let sep = l.halo_px + (l.halo_px / 2).max(4) + l.marker_quiet.max(8);
                let mut clear = l.marker_margin + l.marker_patch + sep;
                if s.is_cyanotype() && (corner == "Superior izquierda" || corner == "Top left") {
                    let tri_h = (l.marker_side / 2).max(8);
                    clear = l.marker_margin + l.marker_patch + 2 * l.halo_px + l.marker_quiet.max(6)
                        + tri_h + l.halo_px + (l.halo_px / 2).max(4) + l.marker_quiet.max(8);
                }
                let y_top = l.marker_margin + (l.marker_patch - th) / 2;
                let y_bot = l.page_h - l.marker_margin - l.marker_patch + (l.marker_patch - th) / 2;
                match corner {
                    "Inferior derecha" | "Bottom right" => (l.page_w - clear - tw, y_bot),
                    "Inferior izquierda" | "Bottom left" => (clear, y_bot),
                    "Superior derecha" | "Top right" => (l.page_w - clear - tw, y_top),
                    _ => (clear, y_top),
                }
            } else {
                let pad = (l.margin / 3).max(mm_to_px(3.0, l.dpi));
                match corner {
                    "Inferior derecha" | "Bottom right" => (l.page_w - pad - tw, l.page_h - pad - th),
                    "Inferior izquierda" | "Bottom left" => (pad, l.page_h - pad - th),
                    "Superior derecha" | "Top right" => (l.page_w - pad - tw, pad),
                    _ => (pad, pad),
                }
            };
            if saving {
                halo_rect(canvas, s, [pos.0, pos.1, pos.0 + tw, pos.1 + th], (l.halo_px / 2).max(4));
            }
            let color = if s.is_cyanotype() { [255, 255, 255] } else { cyan::hex_to_rgb(&s.page_num_color) };
            text::draw_text(canvas, &pno, pos.0, pos.1, l.page_px, color);
        }
    }

    PageResult { image: canvas, record }
}

// ────────────────────────────────────────────────────────────────
// Compensación de impresora, espejado y layout.json
// ────────────────────────────────────────────────────────────────

pub fn needs_print_scale(s: &Settings) -> bool {
    (s.print_scale_x - 1.0).abs() > 1e-4 || (s.print_scale_y - 1.0).abs() > 1e-4
}

/// Pre-escala el contenido alrededor del centro (compensación de impresora)
/// y espeja si toca. Se aplica a la hoja ya renderizada.
pub fn finish_page(s: &Settings, img: Rgb) -> Rgb {
    let mut out = img;
    if needs_print_scale(s) {
        let (w, h) = (out.w as f64, out.h as f64);
        let (cx, cy) = (w / 2.0, h / 2.0);
        // src→dst: escala 1/sx alrededor del centro
        let (fx, fy) = (1.0 / s.print_scale_x, 1.0 / s.print_scale_y);
        let m: H3 = [fx, 0.0, cx * (1.0 - fx), 0.0, fy, cy * (1.0 - fy), 0.0, 0.0, 1.0];
        let (ow, oh) = (out.w, out.h);
        out = warp_rgb_fill(&out, &m, ow, oh, page_bg_color(s));
    }
    if s.is_cyanotype() && s.cyan_mirror {
        out = out.flip_horizontal();
    }
    out
}

pub fn scale_bbox(bbox: [i64; 4], s: &Settings, page_w: i64, page_h: i64) -> [i64; 4] {
    if !needs_print_scale(s) {
        return bbox;
    }
    let (cx, cy) = (page_w as f64 / 2.0, page_h as f64 / 2.0);
    let sp = |x: f64, y: f64| {
        (cx + (x - cx) / s.print_scale_x, cy + (y - cy) / s.print_scale_y)
    };
    let (x1, y1) = sp(bbox[0] as f64, bbox[1] as f64);
    let (x2, y2) = sp(bbox[2] as f64, bbox[3] as f64);
    [x1.round() as i64, y1.round() as i64, x2.round() as i64, y2.round() as i64]
}

/// Ensambla el layout.json v2 (idéntico al de la app original).
pub fn build_layout_json(
    s: &Settings,
    l: &Layout,
    sheet_records: &[Value],
    timeline: Value,
    video_meta: Value,
    originales_dir: Option<&str>,
) -> Value {
    let mut marker_bb = serde_json::Map::new();
    if let Some(bb) = &l.marker_bboxes {
        for (id, bbox) in bb {
            let sb = scale_bbox(*bbox, s, l.page_w, l.page_h);
            marker_bb.insert(id.to_string(), json!(sb));
        }
    }
    let patch_info = l.patch_strip.as_ref().map(|strip| {
        json!({
            "bboxes": strip.iter().map(|(b, _)| json!(scale_bbox(*b, s, l.page_w, l.page_h))).collect::<Vec<_>>(),
            "niveles": strip.iter().map(|(_, n)| *n).collect::<Vec<_>>(),
        })
    });
    let snapshot = serde_json::to_value(s).unwrap_or(Value::Null);
    json!({
        "version": 2,
        "app": "mxm-studio",
        "proyecto": if s.project_name.is_empty() { s.out_name.clone() } else { s.project_name.clone() },
        "modo": if s.is_cyanotype() { "cianotipia" } else { "normal" },
        "fondo_cianotipia": if s.is_cyanotype() { Value::from(s.cyan_bg.clone()) } else { Value::Null },
        "espejado": s.is_cyanotype() && s.cyan_mirror,
        "lienzo": {
            "ancho_px": l.page_w,
            "alto_px": l.page_h,
            "dpi": l.dpi,
            "orientacion": if l.landscape { "landscape" } else { "portrait" },
        },
        "marcadores": {
            "dict": s.marker_dict,
            "cantidad": s.marker_count,
            "lado_px": l.marker_side,
            "bboxes": marker_bb,
        },
        "parche_grises": patch_info,
        "hojas": sheet_records,
        "timeline": timeline,
        "video": video_meta,
        "originales_dir": originales_dir,
        "ajustes": snapshot,
    })
}

/// Ajusta las coordenadas de frames/QRs de un registro de hoja por la
/// compensación de impresora (el layout describe los píxeles REALES).
pub fn scale_record_bboxes(s: &Settings, l: &Layout, record: &mut Value) {
    if !needs_print_scale(s) {
        return;
    }
    for key in ["frames", "qrs"] {
        if let Some(map) = record[key].as_object_mut() {
            for (_, v) in map.iter_mut() {
                if let Some(bb) = v["bbox"].as_array() {
                    let b: Vec<i64> = bb.iter().map(|x| x.as_i64().unwrap_or(0)).collect();
                    if b.len() == 4 {
                        v["bbox"] = json!(scale_bbox([b[0], b[1], b[2], b[3]], s, l.page_w, l.page_h));
                    }
                }
            }
        }
    }
}

/// Avisos de tamaños arriesgados para cianotipia (port 1:1).
pub fn cyanotype_size_warnings(s: &Settings) -> Vec<String> {
    let mut avisos = Vec::new();
    if !(s.is_cyanotype() && s.registration_on) {
        return avisos;
    }
    if s.marker_size_mm < 10.0 {
        avisos.push(format!(
            "{} mm markers: for cyanotype, ≥ 10 mm is recommended (small ones degrade with the chemistry).",
            s.marker_size_mm
        ));
    }
    if s.qr_on && s.qr_size_mm < 12.0 {
        avisos.push(format!(
            "{} mm QRs: for cyanotype, ≥ 12 mm is recommended so they stay readable after exposing and washing.",
            s.qr_size_mm
        ));
    }
    if s.marker_margin_mm < 6.0 {
        avisos.push(format!(
            "{} mm marker margin: for cyanotype, ≥ 6 mm is advised because paper edges collect brush stains and tears.",
            s.marker_margin_mm
        ));
    }
    if cyan_saving(s) && s.cyan_halo_mm < 4.0 {
        avisos.push(format!(
            "{} mm inked halo: in ink-saving mode, ≥ 4 mm is advised so markers and QRs sit on guaranteed white.",
            s.cyan_halo_mm
        ));
    }
    if let Some(bc) = &s.cyan_block_color {
        if !bc.is_empty() {
            let c = cyan::hex_to_rgb(bc);
            if (c[0] as u32 + c[1] as u32 + c[2] as u32) / 3 > 160 {
                avisos.push(format!(
                    "The blocker color ({bc}) is very light: it may let UV through and fog the print's backgrounds/halos."
                ));
            }
        }
    }
    avisos
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_frame(w: usize, h: usize, color: [u8; 3]) -> FrameInput {
        let mut rgba = Vec::with_capacity(w * h * 4);
        for _ in 0..w * h {
            rgba.extend_from_slice(&[color[0], color[1], color[2], 255]);
        }
        FrameInput { w, h, rgba: Some(rgba), has_alpha: false, orig_name: "f.png".into(), orig_file: None }
    }

    fn base_settings() -> Settings {
        let mut s = Settings::default();
        s.registration_on = true;
        s.dpi = 150;
        s.cols = 3;
        s.rows = 3;
        s.project_name = "test".into();
        s
    }

    #[test]
    fn layout_and_render_normal() {
        let s = base_settings();
        let l = build_layout(&s, (16.0, 9.0)).unwrap();
        assert_eq!((l.page_w, l.page_h), (mm_to_px(210.0, 150), mm_to_px(297.0, 150)));
        let frames: Vec<FrameInput> = (0..5).map(|i| test_frame(160, 90, [(i * 40) as u8, 100, 200])).collect();
        let labels: Vec<String> = (0..5).map(|i| format!("abc_{:03}", i + 1)).collect();
        let res = render_page(&s, &l, &frames, &labels, 1, true);
        let img = res.image.unwrap();
        assert_eq!(img.w as i64, l.page_w);
        let rec = res.record.unwrap();
        assert_eq!(rec["frames"].as_object().unwrap().len(), 5);
        assert_eq!(rec["qrs"].as_object().unwrap().len(), 5);
        // el QR de la celda 0 debe decodificarse desde la propia hoja
        let q = &rec["qrs"]["abc_001"];
        let bb: Vec<i64> = q["bbox"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
        let crop = img.crop(
            (bb[0] - 6).max(0) as usize,
            (bb[1] - 6).max(0) as usize,
            (bb[2] + 6) as usize,
            (bb[3] + 6) as usize,
        );
        let decoded = qr::decode_qr(&crop.to_gray()).expect("QR de la hoja legible");
        assert_eq!(decoded, q["texto"].as_str().unwrap());
    }

    #[test]
    fn geometry_only_matches_render() {
        let s = base_settings();
        let l = build_layout(&s, (16.0, 9.0)).unwrap();
        let frames: Vec<FrameInput> = (0..4).map(|_| test_frame(160, 90, [50, 50, 50])).collect();
        let mut geo_frames: Vec<FrameInput> = frames
            .iter()
            .map(|f| FrameInput { w: f.w, h: f.h, rgba: None, has_alpha: false, orig_name: f.orig_name.clone(), orig_file: None })
            .collect();
        geo_frames[0].orig_name = "f.png".into();
        let labels: Vec<String> = (0..4).map(|i| format!("x_{i}")).collect();
        let a = render_page(&s, &l, &frames, &labels, 2, true);
        let b = render_page(&s, &l, &geo_frames, &labels, 2, false);
        assert_eq!(a.record.unwrap()["frames"], b.record.unwrap()["frames"]);
        assert!(b.image.is_none());
    }

    #[test]
    fn cyanotype_page_renders_and_mirrors() {
        let mut s = base_settings();
        s.mode = "cianotipia".into();
        s.cyan_bg = "ahorro".into();
        let l = build_layout(&s, (4.0, 3.0)).unwrap();
        let frames = vec![test_frame(120, 90, [255, 255, 255])];
        let labels = vec!["cy_001".to_string()];
        let res = render_page(&s, &l, &frames, &labels, 1, true);
        let img = res.image.unwrap();
        // un frame blanco en negativo → tinta plena (negro) en el centro del frame
        let rec = res.record.unwrap();
        let bb: Vec<i64> = rec["frames"]["cy_001"]["bbox"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
        let cxp = ((bb[0] + bb[2]) / 2) as usize;
        let cyp = ((bb[1] + bb[3]) / 2) as usize;
        assert_eq!(img.px(cxp, cyp), [0, 0, 0]);
        // fondo en modo ahorro = blanco (transparente); punto libre de halos:
        // centro horizontal, a 3/4 de la altura (celdas vacías de la fila 2)
        assert_eq!(img.px((l.page_w / 2) as usize, (l.page_h * 3 / 4) as usize), [255, 255, 255]);
        let fin = finish_page(&s, img);
        assert_eq!(fin.w as i64, l.page_w); // espejada, mismo tamaño
    }

    #[test]
    fn best_fit_prefers_bigger_frames() {
        let mut s = base_settings();
        s.orientation = "Mejor ajuste (automático)".into();
        s.cols = 4;
        s.rows = 2;
        // frames muy anchos → mejor ajuste debería elegir algo distinto a 4×2 vertical
        let l = build_layout(&s, (32.0, 9.0)).unwrap();
        let manual: Vec<(bool, u32, u32)> = vec![(false, 4, 2), (true, 4, 2), (false, 2, 4), (true, 2, 4)];
        let mut best_area = -1.0;
        for (land, c, r) in manual {
            let a = frame_fit_area(&s, land, 32.0, 9.0, l.meta_h, l.label_gap, c, r);
            best_area = f64::max(best_area, a);
        }
        let got = frame_fit_area(&s, l.landscape, 32.0, 9.0, l.meta_h, l.label_gap, l.cols, l.rows);
        assert!((got - best_area).abs() < 1.0, "got={got} best={best_area}");
    }
}
