//! Calibración de impresora y de proceso de cianotipia (port de la fase ③).

use crate::aruco::Dict;
use crate::cyanotype as cyan;
use crate::geometry::{find_homography_ransac, warp_rgb_fill, Pt};
use crate::img::{DynImg, Rgb};
use crate::qr;
use crate::scanproc::{bbox_corners, detect_oriented, estimate_scale, refine_corners_fullres};
use crate::sheet::{marker_bboxes, marker_layout, marker_patch_gray, mm_to_px, page_size_px};
use crate::text::draw_text;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

pub const CAL_MARKER_MM: f64 = 10.0;
pub const CAL_MARGIN_MM: f64 = 5.0;
pub const RAMP_STEPS: usize = 21;
pub const SIZE_TEST_MM: [f64; 6] = [4.0, 5.0, 6.0, 8.0, 10.0, 12.0];
pub const SIZE_TEST_IDS: [u32; 6] = [20, 21, 22, 23, 24, 25];
pub const QR_TEST_MM: [f64; 3] = [8.0, 10.0, 12.0];
pub const CYANO_STEPS: usize = 21;

fn mm(v: f64, dpi: u32) -> i64 {
    mm_to_px(v, dpi)
}

pub struct CalGeometry {
    pub page_w: i64,
    pub page_h: i64,
    pub marker_side: i64,
    pub marker_quiet: i64,
    pub marker_positions: BTreeMap<u32, (i64, i64)>,
    pub marker_bboxes: BTreeMap<u32, [i64; 4]>,
}

fn cal_frame(paper: &str, dpi: u32, landscape: bool) -> CalGeometry {
    let (page_w, page_h) = page_size_px(paper, dpi, landscape, 210.0, 297.0);
    let side = mm(CAL_MARKER_MM, dpi);
    let quiet = (side / 7).max(2);
    let margin = mm(CAL_MARGIN_MM, dpi);
    CalGeometry {
        page_w,
        page_h,
        marker_side: side,
        marker_quiet: quiet,
        marker_positions: marker_layout(page_w, page_h, 8, side, margin, quiet),
        marker_bboxes: marker_bboxes(page_w, page_h, 8, side, margin, quiet),
    }
}

// ────────────────────────────────────────────────────────────────
// Página de prueba de impresora
// ────────────────────────────────────────────────────────────────

pub struct PrinterTestGeometry {
    pub cal: CalGeometry,
    pub ramp: Vec<([i64; 4], u8)>,
    pub size_test: Vec<(u32, f64, (i64, i64), i64, i64)>, // id, mm, pos, lado, quiet
    pub qr_test: Vec<(f64, [i64; 4], String)>,
}

pub fn printer_test_geometry(paper: &str, dpi: u32) -> PrinterTestGeometry {
    let cal = cal_frame(paper, dpi, false);
    let band = mm(CAL_MARGIN_MM, dpi) + cal.marker_side + 2 * cal.marker_quiet + mm(6.0, dpi);
    let (content_x1, content_x2) = (band, cal.page_w - band);

    let mut ramp = Vec::new();
    let patch_w = (content_x2 - content_x1 - mm(2.0, dpi) * 10) / 11;
    let patch_h = mm(12.0, dpi);
    let y0 = band + mm(22.0, dpi);
    for i in 0..RAMP_STEPS {
        let (row, col) = (i / 11, i % 11);
        let x = content_x1 + col as i64 * (patch_w + mm(2.0, dpi));
        let y = y0 + row as i64 * (patch_h + mm(6.0, dpi));
        let nivel = (255.0 * (1.0 - i as f64 / (RAMP_STEPS - 1) as f64)).round() as u8;
        ramp.push(([x, y, x + patch_w, y + patch_h], nivel));
    }

    let mut size_test = Vec::new();
    let y_size = y0 + 2 * (patch_h + mm(6.0, dpi)) + mm(14.0, dpi);
    let mut x = content_x1;
    for (&mmv, &mid) in SIZE_TEST_MM.iter().zip(&SIZE_TEST_IDS) {
        let s_px = mm(mmv, dpi);
        let q_px = (s_px / 7).max(2);
        size_test.push((mid, mmv, (x, y_size), s_px, q_px));
        x += s_px + 2 * q_px + mm(8.0, dpi);
    }

    let mut qr_test = Vec::new();
    let max_size = SIZE_TEST_MM.iter().cloned().fold(0.0f64, f64::max);
    let y_qr = y_size + mm(max_size, dpi) + mm(16.0, dpi);
    let mut x = content_x1;
    for &mmv in &QR_TEST_MM {
        let s_px = mm(mmv, dpi);
        qr_test.push((mmv, [x, y_qr, x + s_px, y_qr + s_px], format!("KQR|{mmv}")));
        x += s_px + mm(10.0, dpi);
    }

    PrinterTestGeometry { cal, ramp, size_test, qr_test }
}

fn gray_to_rgb_img(g: &crate::img::Gray) -> Rgb {
    let mut data = Vec::with_capacity(g.w * g.h * 3);
    for &v in &g.data {
        data.extend_from_slice(&[v, v, v]);
    }
    Rgb { w: g.w, h: g.h, data }
}

pub fn render_printer_test(paper: &str, dpi: u32) -> Rgb {
    let g = printer_test_geometry(paper, dpi);
    let mut canvas = Rgb::new(g.cal.page_w as usize, g.cal.page_h as usize, [255, 255, 255]);
    let f_big = mm(4.0, dpi) as f32;
    let f_small = mm(2.6, dpi) as f32;

    for (&mid, &(px, py)) in &g.cal.marker_positions {
        let patch = marker_patch_gray(Dict::Dict4x4_50, mid, g.cal.marker_side, g.cal.marker_quiet);
        canvas.paste(&gray_to_rgb_img(&patch), px, py);
    }
    let band = g.ramp[0].0[0];
    draw_text(&mut canvas, "MXM Studio — Printer test", band, band, f_big, [0, 0, 0]);
    draw_text(
        &mut canvas,
        &format!("Print this page at 100 % (WITHOUT \"fit to page\") on {paper} at {dpi} DPI. Then scan it whole and analyze it in the app."),
        band,
        band + mm(6.0, dpi),
        f_small,
        [0, 0, 0],
    );
    for &(bbox, nivel) in &g.ramp {
        canvas.fill_rect(bbox[0], bbox[1], bbox[2], bbox[3], [nivel, nivel, nivel]);
        canvas.stroke_rect(bbox[0], bbox[1], bbox[2], bbox[3], 1, [120, 120, 120]);
    }
    draw_text(&mut canvas, "Tonal ramp (white → black)", g.ramp[0].0[0], g.ramp[0].0[1] - mm(5.0, dpi), f_small, [0, 0, 0]);
    for &(mid, mmv, (x, y), s_px, q_px) in &g.size_test {
        let patch = marker_patch_gray(Dict::Dict4x4_50, mid, s_px, q_px);
        canvas.paste(&gray_to_rgb_img(&patch), x, y);
        draw_text(&mut canvas, &format!("{mmv} mm"), x, y + s_px + 2 * q_px + mm(1.0, dpi), f_small, [0, 0, 0]);
    }
    draw_text(&mut canvas, "ArUco marker sizes", g.size_test[0].2 .0, g.size_test[0].2 .1 - mm(5.0, dpi), f_small, [0, 0, 0]);
    for (mmv, bbox, texto) in &g.qr_test {
        let q = qr::qr_image(texto, (bbox[2] - bbox[0]) as usize, false);
        canvas.paste(&gray_to_rgb_img(&q), bbox[0], bbox[1]);
        draw_text(&mut canvas, &format!("{mmv} mm"), bbox[0], bbox[3] + mm(1.0, dpi), f_small, [0, 0, 0]);
    }
    draw_text(&mut canvas, "QR sizes", g.qr_test[0].1[0], g.qr_test[0].1[1] - mm(5.0, dpi), f_small, [0, 0, 0]);
    canvas
}

/// Alinea el escaneo de una carta al lienzo canónico (con espejo automático).
/// Devuelve (warp RGB8, escala, esquinas refinadas por id).
fn align_to_canonical(
    mut img: DynImg,
    cal: &CalGeometry,
    mode: &str,
) -> Result<(Rgb, f64, HashMap<u32, [Pt; 4]>), String> {
    let expected: Vec<u32> = cal.marker_bboxes.keys().cloned().collect();
    let det = detect_oriented(&mut img, Dict::Dict4x4_50, &expected, mode);
    if det.found.len() < 3 {
        return Err(format!(
            "Only {} reference markers were detected; at least 3 are needed. Scan the whole page, right side up.",
            det.found.len()
        ));
    }
    let polaridad = if det.inverted { "invertida_primero" } else { "ambas" };
    let refined = refine_corners_fullres(&img, &det.found, Dict::Dict4x4_50, mode, polaridad);
    let bboxes_json = json!(cal
        .marker_bboxes
        .iter()
        .map(|(k, v)| (k.to_string(), json!(v)))
        .collect::<serde_json::Map<String, Value>>());
    let s = estimate_scale(&refined, &bboxes_json)
        .ok_or_else(|| "Could not estimate the scan scale.".to_string())?;
    let mut src = Vec::new();
    let mut dst = Vec::new();
    for (mid, corners) in &refined {
        if let Some(b) = cal.marker_bboxes.get(mid) {
            let bf = [b[0] as f64, b[1] as f64, b[2] as f64, b[3] as f64];
            let bc = bbox_corners(bf);
            for k in 0..4 {
                src.push(corners[k]);
                dst.push((bc[k].0 * s, bc[k].1 * s));
            }
        }
    }
    let (m, _) = find_homography_ransac(&src, &dst, 12.0)
        .ok_or_else(|| "Could not align the scan (degenerate homography).".to_string())?;
    let out_w = (cal.page_w as f64 * s).round() as usize;
    let out_h = (cal.page_h as f64 * s).round() as usize;
    let rgb8 = img.to_rgb8();
    let warp = warp_rgb_fill(&rgb8, &m, out_w, out_h, [255, 255, 255]);
    Ok((warp, s, refined))
}

fn patch_mean(warp: &Rgb, bbox: [i64; 4], s: f64, shrink: f64) -> Option<f64> {
    let x1 = (bbox[0] as f64 * s).round() as i64;
    let y1 = (bbox[1] as f64 * s).round() as i64;
    let x2 = (bbox[2] as f64 * s).round() as i64;
    let y2 = (bbox[3] as f64 * s).round() as i64;
    let dx = ((x2 - x1) as f64 * shrink) as i64;
    let dy = ((y2 - y1) as f64 * shrink) as i64;
    let (x1, y1) = ((x1 + dx).max(0) as usize, (y1 + dy).max(0) as usize);
    let (x2, y2) = (((x2 - dx).max(0) as usize).min(warp.w), ((y2 - dy).max(0) as usize).min(warp.h));
    if x2 <= x1 || y2 <= y1 {
        return None;
    }
    let mut acc = 0.0;
    let mut n = 0.0;
    for y in y1..y2 {
        for x in x1..x2 {
            let p = warp.px(x, y);
            acc += 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64;
            n += 1.0;
        }
    }
    Some(acc / n)
}

/// Analiza el escaneo de la página de prueba y devuelve un perfil de impresora.
pub fn analyze_printer_test(
    img: DynImg,
    paper: &str,
    dpi: u32,
    scan_dpi: Option<f64>,
) -> Result<Value, String> {
    let g = printer_test_geometry(paper, dpi);
    let (warp, s, refined) = align_to_canonical(img, &g.cal, "normal")?;
    let mut notas: Vec<String> = Vec::new();

    // Escala de impresión (necesita el DPI real del escaneo).
    let (mut scale_x, mut scale_y) = (None, None);
    if let Some(sdpi) = scan_dpi {
        let mut sx_list = Vec::new();
        let mut sy_list = Vec::new();
        let ids: Vec<u32> = refined.keys().cloned().filter(|id| g.cal.marker_bboxes.contains_key(id)).collect();
        let center_nominal = |mid: u32| {
            let b = g.cal.marker_bboxes[&mid];
            (
                (b[0] + b[2]) as f64 / 2.0 / dpi as f64 * 25.4,
                (b[1] + b[3]) as f64 / 2.0 / dpi as f64 * 25.4,
            )
        };
        let center_scan = |mid: u32| {
            let c = refined[&mid];
            let cx = (c[0].0 + c[1].0 + c[2].0 + c[3].0) / 4.0;
            let cy = (c[0].1 + c[1].1 + c[2].1 + c[3].1) / 4.0;
            (cx / sdpi * 25.4, cy / sdpi * 25.4)
        };
        for i in 0..ids.len() {
            for j in i + 1..ids.len() {
                let (nax, nay) = center_nominal(ids[i]);
                let (nbx, nby) = center_nominal(ids[j]);
                let (sax, say) = center_scan(ids[i]);
                let (sbx, sby) = center_scan(ids[j]);
                if (nbx - nax).abs() > 40.0 {
                    sx_list.push((sbx - sax).abs() / (nbx - nax).abs());
                }
                if (nby - nay).abs() > 40.0 {
                    sy_list.push((sby - say).abs() / (nby - nay).abs());
                }
            }
        }
        let med = |mut v: Vec<f64>| {
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            v[v.len() / 2]
        };
        if !sx_list.is_empty() && !sy_list.is_empty() {
            let sx = med(sx_list);
            let sy = med(sy_list);
            if (sx - 1.0).abs() > 0.03 || (sy - 1.0).abs() > 0.03 {
                notas.push("The printer scales by more than 3 %: the driver probably has \"fit to page\" enabled. Disable it and print at 100 %.".into());
            }
            scale_x = Some((sx * 10000.0).round() / 10000.0);
            scale_y = Some((sy * 10000.0).round() / 10000.0);
        } else {
            notas.push("Not enough distances could be measured for the scale.".into());
        }
    } else {
        notas.push("Scan DPI not provided: print scale could not be measured (only tonal response and minimum sizes).".into());
    }

    // Respuesta tonal
    let mut tono = Vec::new();
    for &(bbox, nivel) in &g.ramp {
        if let Some(m) = patch_mean(&warp, bbox, s, 0.25) {
            tono.push(json!([nivel, (m * 10.0).round() / 10.0]));
        }
    }
    if !tono.is_empty() {
        let vals: Vec<f64> = tono.iter().map(|t| t[1].as_f64().unwrap()).collect();
        let (mn, mx) = vals.iter().fold((f64::MAX, f64::MIN), |(a, b), &v| (a.min(v), b.max(v)));
        if mx - mn < 60.0 {
            notas.push("The tonal ramp has little contrast in the scan; check the scanner exposure.".into());
        }
    }

    // Tamaño mínimo de marcador: detector ESTRICTO sobre el warp
    let det = crate::scanproc::detect_markers_multi(&warp, Dict::Dict4x4_50, &SIZE_TEST_IDS, "normal", "normal", false);
    let mut detectados_mm: Vec<f64> = g
        .size_test
        .iter()
        .filter(|(id, ..)| det.found.contains_key(id))
        .map(|&(_, mmv, ..)| mmv)
        .collect();
    detectados_mm.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let marker_min = detectados_mm.first().cloned();
    let marker_rec = match marker_min {
        None => {
            notas.push("No marker in the size test was detected: use 10-12 mm markers and check print quality.".into());
            12.0
        }
        Some(m) => ((m * 1.25 * 2.0).round() / 2.0).max(5.0),
    };

    // Tamaño mínimo de QR
    let mut qr_ok = Vec::new();
    for (mmv, bbox, texto) in &g.qr_test {
        let x1 = (bbox[0] as f64 * s).round() as i64;
        let y1 = (bbox[1] as f64 * s).round() as i64;
        let x2 = (bbox[2] as f64 * s).round() as i64;
        let y2 = (bbox[3] as f64 * s).round() as i64;
        let pad = ((x2 - x1) as f64 * 0.3) as i64;
        let crop = warp.crop(
            (x1 - pad).max(0) as usize,
            (y1 - pad).max(0) as usize,
            (x2 + pad).max(0) as usize,
            (y2 + pad).max(0) as usize,
        );
        if qr::decode_qr_rgb(&crop).as_deref() == Some(texto.as_str()) {
            qr_ok.push(*mmv);
        }
    }
    qr_ok.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let qr_min = qr_ok.first().cloned();
    let qr_rec = match qr_min {
        None => {
            notas.push("No QR in the test could be read: use QRs of 12 mm or larger.".into());
            12.0
        }
        Some(m) => ((m * 1.2 * 2.0).round() / 2.0).max(8.0),
    };

    Ok(json!({
        "tipo": "impresora",
        "paper": paper,
        "dpi": dpi,
        "scan_dpi": scan_dpi,
        "scale_x": scale_x.unwrap_or(1.0),
        "scale_y": scale_y.unwrap_or(1.0),
        "tono": tono,
        "marker_min_mm": marker_min,
        "marker_recomendado_mm": marker_rec,
        "qr_min_mm": qr_min,
        "qr_recomendado_mm": qr_rec,
        "notas": notas,
    }))
}

// ────────────────────────────────────────────────────────────────
// Cartas de cianotipia (tira 21 / EDN 256)
// ────────────────────────────────────────────────────────────────

pub struct CyanoGeometry {
    pub cal: CalGeometry,
    pub patches: Vec<([i64; 4], u32)>, // bbox, densidad
    pub steps: usize,
    pub target: String,
}

pub fn cyanotype_strip_geometry(paper: &str, dpi: u32, steps: usize, target: &str) -> CyanoGeometry {
    let cal = cal_frame(paper, dpi, false);
    let band = mm(CAL_MARGIN_MM, dpi) + cal.marker_side + 2 * cal.marker_quiet + mm(6.0, dpi);
    let (content_x1, content_x2) = (band, cal.page_w - band);
    let mut patches = Vec::new();
    let mut steps_out = steps;
    if target == "edn256" {
        let cols = 16i64;
        let rows = 16i64;
        let gap = mm(1.2, dpi);
        let y0 = band + mm(20.0, dpi);
        let avail_w = content_x2 - content_x1;
        let avail_h = cal.page_h - band - y0;
        let pitch = (((avail_w - (cols - 1) * gap) / cols).min((avail_h - (rows - 1) * gap) / rows)).max(4);
        for i in 0..256i64 {
            let (row, col) = (i / cols, i % cols);
            let x = content_x1 + col * (pitch + gap);
            let y = y0 + row * (pitch + gap);
            patches.push(([x, y, x + pitch, y + pitch], i as u32));
        }
        steps_out = 256;
    } else {
        let cols = 3i64;
        let gap = mm(4.0, dpi);
        let patch_w = (content_x2 - content_x1 - (cols - 1) * gap) / cols;
        let patch_h = mm(16.0, dpi);
        let y0 = band + mm(24.0, dpi);
        for i in 0..steps as i64 {
            let (row, col) = (i / cols, i % cols);
            let x = content_x1 + col * (patch_w + gap);
            let y = y0 + row * (patch_h + gap + mm(5.0, dpi));
            let dens = (255.0 * i as f64 / (steps - 1) as f64).round() as u32;
            patches.push(([x, y, x + patch_w, y + patch_h], dens));
        }
    }
    CyanoGeometry { cal, patches, steps: steps_out, target: target.to_string() }
}

pub fn render_cyanotype_strip(
    paper: &str,
    dpi: u32,
    ink_color: &str,
    mirror: bool,
    steps: usize,
    target: &str,
    ink_stops: Option<&[cyan::InkStop]>,
    block_color: Option<&str>,
) -> Rgb {
    let g = cyanotype_strip_geometry(paper, dpi, steps, target);
    let ramp = cyan::ink_ramp(ink_color, ink_stops);
    let bg = match block_color {
        Some(c) if !c.is_empty() => cyan::hex_to_rgb(c),
        _ => ramp[255],
    };
    let mut canvas = Rgb::new(g.cal.page_w as usize, g.cal.page_h as usize, bg);
    let text_color: [u8; 3] = if (bg[0] as u32 + bg[1] as u32 + bg[2] as u32) < 420 {
        [255, 255, 255]
    } else {
        [0, 0, 0]
    };
    let f_big = mm(4.0, dpi) as f32;
    let f_small = mm(2.8, dpi) as f32;

    // Marcadores con la tinta del bloqueador (deben bloquear el UV como el fondo)
    let (marker_ink, marker_stops): (String, Option<Vec<cyan::InkStop>>) = match block_color {
        Some(c) if !c.is_empty() => (c.to_string(), None),
        _ => (ink_color.to_string(), ink_stops.map(|s| s.to_vec())),
    };
    for (&mid, &(px, py)) in &g.cal.marker_positions {
        let patch = marker_patch_gray(Dict::Dict4x4_50, mid, g.cal.marker_side, g.cal.marker_quiet);
        let rgb = cyan::colorize_gray_patch(&patch, &marker_ink, marker_stops.as_deref());
        canvas.paste(&rgb, px, py);
    }
    let band = g.patches[0].0[0];
    let titulo = if target == "edn256" {
        "MXM Studio — Cyanotype calibration (EDN 2.2 chart, 256 tones)"
    } else {
        "MXM Studio — Cyanotype calibration (21-patch strip)"
    };
    draw_text(&mut canvas, titulo, band, mm(CAL_MARGIN_MM, dpi) + mm(1.0, dpi) + g.cal.marker_side + 2 * g.cal.marker_quiet, f_big, text_color);
    draw_text(
        &mut canvas,
        "Print on transparency film at 100 %, expose your cyanotype as usual, develop, dry and scan the BLUE RESULT (not the film).",
        band,
        g.patches[0].0[1] - mm(6.0, dpi),
        f_small,
        text_color,
    );
    for (i, &(bbox, dens)) in g.patches.iter().enumerate() {
        let color = ramp[dens as usize];
        canvas.fill_rect(bbox[0], bbox[1], bbox[2], bbox[3], color);
        if g.target != "edn256" {
            draw_text(&mut canvas, &format!("{:02} · d={}", i + 1, dens), bbox[0], bbox[3] + mm(1.0, dpi), f_small, text_color);
        }
    }
    if mirror {
        canvas.flip_horizontal()
    } else {
        canvas
    }
}

// PAVA: regresión isotónica no-decreciente.
fn isotonic(y: &[f64]) -> Vec<f64> {
    let mut blocks: Vec<(f64, f64)> = Vec::new();
    for &v in y {
        blocks.push((v, 1.0));
        while blocks.len() > 1 {
            let n = blocks.len();
            if blocks[n - 2].0 > blocks[n - 1].0 {
                let (v2, n2) = blocks.pop().unwrap();
                let (v1, n1) = blocks.pop().unwrap();
                blocks.push(((v1 * n1 + v2 * n2) / (n1 + n2), n1 + n2));
            } else {
                break;
            }
        }
    }
    let mut out = Vec::with_capacity(y.len());
    for (v, n) in blocks {
        for _ in 0..n as usize {
            out.push(v);
        }
    }
    out
}

// Suavizado por media móvil con ventana adaptativa (bordes por reflexión,
// extremos anclados).
fn smooth_adaptive(y: &[f64]) -> Vec<f64> {
    let n = y.len();
    if n < 3 {
        return y.to_vec();
    }
    let ventana = ((n / 16) | 1).max(3);
    let medio = ventana / 2;
    let mut ext = Vec::with_capacity(n + 2 * medio);
    for i in (1..=medio).rev() {
        ext.push(y[i.min(n - 1)]);
    }
    ext.extend_from_slice(y);
    for i in 0..medio {
        ext.push(y[n.saturating_sub(2 + i).min(n - 1)]);
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let mut acc = 0.0;
        for k in 0..ventana {
            acc += ext[i + k];
        }
        out.push(acc / ventana as f64);
    }
    out[0] = y[0];
    out[n - 1] = y[n - 1];
    out
}

// PCHIP (Fritsch–Carlson): interpolación cúbica monótona.
fn pchip(x: &[f64], y: &[f64], xq: &[f64]) -> Vec<f64> {
    let n = x.len();
    if n < 2 {
        return xq.iter().map(|_| y[0]).collect();
    }
    let h: Vec<f64> = (0..n - 1).map(|i| x[i + 1] - x[i]).collect();
    let delta: Vec<f64> = (0..n - 1).map(|i| (y[i + 1] - y[i]) / h[i]).collect();
    let mut m = vec![0.0; n];
    m[0] = delta[0];
    m[n - 1] = delta[n - 2];
    for i in 1..n - 1 {
        if delta[i - 1] * delta[i] <= 0.0 {
            m[i] = 0.0;
        } else {
            let w1 = 2.0 * h[i] + h[i - 1];
            let w2 = h[i] + 2.0 * h[i - 1];
            m[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
        }
    }
    xq.iter()
        .map(|&q| {
            let mut idx = match x.binary_search_by(|v| v.partial_cmp(&q).unwrap()) {
                Ok(i) => i,
                Err(i) => i.saturating_sub(1),
            };
            idx = idx.min(n - 2);
            let t = (q - x[idx]) / h[idx];
            let t2 = t * t;
            let t3 = t2 * t;
            let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
            let h10 = t3 - 2.0 * t2 + t;
            let h01 = -2.0 * t3 + 3.0 * t2;
            let h11 = t3 - t2;
            h00 * y[idx] + h10 * h[idx] * m[idx] + h01 * y[idx + 1] + h11 * h[idx] * m[idx + 1]
        })
        .collect()
}

/// Analiza la CIANOTIPIA de la carta y construye la curva de compensación.
pub fn analyze_cyanotype_strip(
    img: DynImg,
    paper: &str,
    dpi: u32,
    steps: usize,
    target: &str,
    ink_color: Option<&str>,
    ink_stops: Option<&[cyan::InkStop]>,
    block_color: Option<&str>,
) -> Result<Value, String> {
    let g = cyanotype_strip_geometry(paper, dpi, steps, target);
    let (warp, s, _refined) = align_to_canonical(img, &g.cal, "cianotipia")?;

    let shrink = if g.target == "edn256" { 0.3 } else { 0.25 };
    let mut respuesta: Vec<(f64, f64)> = Vec::new();
    for &(bbox, dens) in &g.patches {
        if let Some(m) = patch_mean(&warp, bbox, s, shrink) {
            respuesta.push((dens as f64, (m * 10.0).round() / 10.0));
        }
    }
    if respuesta.len() < 5.max(g.patches.len() / 2) {
        return Err("Not enough patches could be measured; check that the scan is complete, flat and well lit.".into());
    }

    let (rango_d, invertida, plana) = cyan::response_summary(&respuesta);
    if invertida {
        return Err("The measured response is INVERTED: patches with more ink came out darker. Usually this means you scanned the FILM instead of the blue print; scan the dried cyanotype and analyze again.".into());
    }
    if plana {
        return Err(format!(
            "The chart patches are barely distinguishable (range {:.0} %). Usually the exposure was too short or too long, or the scan has minimum contrast.",
            rango_d * 100.0
        ));
    }

    // Curva suave sin escalones (promedio de duplicados → suavizado → PAVA →
    // PCHIP en malla fina → pulido → inversión numérica).
    let mut pares = respuesta.clone();
    pares.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut d_u: Vec<f64> = Vec::new();
    let mut y_u: Vec<f64> = Vec::new();
    let mut i = 0;
    while i < pares.len() {
        let d = pares[i].0;
        let mut acc = 0.0;
        let mut n = 0.0;
        while i < pares.len() && pares[i].0 == d {
            acc += pares[i].1;
            n += 1.0;
            i += 1;
        }
        d_u.push(d);
        y_u.push(acc / n);
    }
    let mut y_iso = isotonic(&smooth_adaptive(&y_u));
    let epsy = ((y_iso[y_iso.len() - 1] - y_iso[0]) * 1e-4).max(1e-6);
    for i in 1..y_iso.len() {
        if y_iso[i] <= y_iso[i - 1] {
            y_iso[i] = y_iso[i - 1] + epsy;
        }
    }
    let dd: Vec<f64> = (0..2048).map(|i| 255.0 * i as f64 / 2047.0).collect();
    let mut yy = pchip(&d_u, &y_iso, &dd);
    for i in 1..yy.len() {
        yy[i] = yy[i].max(yy[i - 1]);
    }
    // pulido: media móvil 31 con reflexión impar
    let vf = 31usize;
    let medio = vf / 2;
    let mut ext = Vec::with_capacity(yy.len() + 2 * medio);
    for i in (1..=medio).rev() {
        ext.push(2.0 * yy[0] - yy[i]);
    }
    ext.extend_from_slice(&yy);
    let n = yy.len();
    for i in 0..medio {
        ext.push(2.0 * yy[n - 1] - yy[n - 2 - i]);
    }
    let mut smoothed = Vec::with_capacity(n);
    for i in 0..n {
        let mut acc = 0.0;
        for k in 0..vf {
            acc += ext[i + k];
        }
        smoothed.push(acc / vf as f64);
    }
    for i in 1..n {
        smoothed[i] = smoothed[i].max(smoothed[i - 1]);
    }
    let yy = smoothed;

    let y_min = yy[0];
    let y_max = yy[n - 1];
    let rango = (y_max - y_min) / 255.0;
    let mut notas: Vec<String> = Vec::new();
    if rango < 0.35 {
        notas.push("Low dynamic range (<35 %). Suggestions: increase exposure, verify that full ink on the film actually blocks light (or use the ColorBlocker) and check the wash.".into());
    }
    if rango > 0.85 {
        notas.push("Excellent dynamic range. 💙".into());
    }

    // LUT: inversión numérica y→densidad sobre la malla fina.
    let mut lut = Vec::with_capacity(256);
    for gi in 0..256 {
        let y_target = y_min + (gi as f64 / 255.0) * (y_max - y_min);
        // interp inversa sobre (yy, dd)
        let v = if y_target <= yy[0] {
            dd[0]
        } else if y_target >= yy[n - 1] {
            dd[n - 1]
        } else {
            let mut lo = 0usize;
            let mut hi = n - 1;
            while hi - lo > 1 {
                let mid = (lo + hi) / 2;
                if yy[mid] <= y_target {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            dd[lo] + (dd[hi] - dd[lo]) * (y_target - yy[lo]) / (yy[hi] - yy[lo]).max(1e-12)
        };
        lut.push((v.clamp(0.0, 255.0) * 100.0).round() / 100.0);
    }

    Ok(json!({
        "tipo": "cianotipia",
        "paper": paper,
        "dpi": dpi,
        "steps": g.steps,
        "target": g.target,
        "lut": lut,
        "respuesta": respuesta.iter().map(|&(d, y)| json!([d, y])).collect::<Vec<_>>(),
        "rango_dinamico": (rango * 1000.0).round() / 1000.0,
        "ink": ink_color,
        "ink_stops": ink_stops.map(|ss| ss.iter().map(|(d, c)| json!([d, cyan::rgb_to_hex(*c)])).collect::<Vec<_>>()),
        "block_color": block_color,
        "notas": notas,
    }))
}

// ────────────────────────────────────────────────────────────────
// EDN ColorBlocker
// ────────────────────────────────────────────────────────────────

pub const CB_HUE_COLS: usize = 36;
pub const CB_COLS: usize = CB_HUE_COLS + 1;
pub const CB_ROWS: usize = 21;

fn hsv_to_rgb(h: f64, s: f64, v: f64) -> [u8; 3] {
    let i = (h * 6.0).floor();
    let f = h * 6.0 - i;
    let p = v * (1.0 - s);
    let q = v * (1.0 - f * s);
    let t = v * (1.0 - (1.0 - f) * s);
    let (r, g, b) = match (i as i64).rem_euclid(6) {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    };
    [
        (r * 255.0).round() as u8,
        (g * 255.0).round() as u8,
        (b * 255.0).round() as u8,
    ]
}

pub fn cb_patch_rgb(col: usize, row: usize) -> [u8; 3] {
    if col >= CB_HUE_COLS {
        let v = (255.0 * row as f64 / (CB_ROWS - 1) as f64).round() as u8;
        return [v, v, v];
    }
    let hue = (col * 10) as f64 / 360.0;
    let (s, b) = if row <= 10 {
        (1.0, row as f64 / 10.0)
    } else {
        ((10 - (row - 10)) as f64 / 10.0, 1.0)
    };
    hsv_to_rgb(hue, s, b)
}

pub struct CbGeometry {
    pub cal: CalGeometry,
    pub patches: Vec<([i64; 4], usize, usize)>, // bbox, col, fila
}

pub fn colorblocker_geometry(paper: &str, dpi: u32) -> CbGeometry {
    let cal = cal_frame(paper, dpi, true);
    let band = mm(CAL_MARGIN_MM, dpi) + cal.marker_side + 2 * cal.marker_quiet + mm(5.0, dpi);
    let (x1, x2) = (band, cal.page_w - band);
    let y1 = band + mm(14.0, dpi);
    let y2 = cal.page_h - band - mm(4.0, dpi);
    let gap = mm(0.8, dpi);
    let pitch_x = (x2 - x1 - (CB_COLS as i64 - 1) * gap) / CB_COLS as i64;
    let pitch_y = (y2 - y1 - (CB_ROWS as i64 - 1) * gap) / CB_ROWS as i64;
    let pitch = pitch_x.min((pitch_y as f64 * 1.4) as i64);
    let mut patches = Vec::new();
    for col in 0..CB_COLS {
        for row in 0..CB_ROWS {
            let x = x1 + col as i64 * (pitch + gap);
            let y = y1 + row as i64 * (pitch_y + gap);
            patches.push(([x, y, x + pitch, y + pitch_y], col, row));
        }
    }
    CbGeometry { cal, patches }
}

pub fn render_colorblocker(paper: &str, dpi: u32, mirror: bool, block_color: Option<&str>) -> Rgb {
    let g = colorblocker_geometry(paper, dpi);
    let bg = match block_color {
        Some(c) if !c.is_empty() => cyan::hex_to_rgb(c),
        _ => [0, 0, 0],
    };
    let mut canvas = Rgb::new(g.cal.page_w as usize, g.cal.page_h as usize, bg);
    let text_color: [u8; 3] = if (bg[0] as u32 + bg[1] as u32 + bg[2] as u32) < 420 {
        [255, 255, 255]
    } else {
        [0, 0, 0]
    };
    let marker_ink = block_color.filter(|c| !c.is_empty()).unwrap_or("#000000");
    for (&mid, &(px, py)) in &g.cal.marker_positions {
        let patch = marker_patch_gray(Dict::Dict4x4_50, mid, g.cal.marker_side, g.cal.marker_quiet);
        let rgb = cyan::colorize_gray_patch(&patch, marker_ink, None);
        canvas.paste(&rgb, px, py);
    }
    let x0 = g.patches[0].0[0];
    draw_text(
        &mut canvas,
        "MXM Studio — EDN ColorBlocker (pick the color that blocks UV best)",
        x0,
        g.patches[0].0[1] - mm(11.0, dpi),
        mm(3.6, dpi) as f32,
        text_color,
    );
    draw_text(
        &mut canvas,
        "Print on transparency film at 100 % at MAXIMUM quality, expose your cyanotype as usual, develop, dry and scan the blue result.",
        x0,
        g.patches[0].0[1] - mm(6.0, dpi),
        mm(2.2, dpi) as f32,
        text_color,
    );
    for &(bbox, col, row) in &g.patches {
        canvas.fill_rect(bbox[0], bbox[1], bbox[2], bbox[3], cb_patch_rgb(col, row));
    }
    if mirror {
        canvas.flip_horizontal()
    } else {
        canvas
    }
}

pub fn analyze_colorblocker(img: DynImg, paper: &str, dpi: u32) -> Result<Value, String> {
    let g = colorblocker_geometry(paper, dpi);
    let (warp, s, _refined) = align_to_canonical(img, &g.cal, "cianotipia")?;

    let mut v = vec![[f64::NAN; CB_ROWS]; CB_COLS];
    let mut missing = 0usize;
    for &(bbox, col, row) in &g.patches {
        match patch_mean(&warp, bbox, s, 0.3) {
            Some(m) => v[col][row] = m,
            None => missing += 1,
        }
    }
    if missing > g.patches.len() / 5 {
        return Err("Not enough ColorBlocker patches could be measured; check the scan.".into());
    }
    // reemplazar NaN por la media global
    let mut acc = 0.0f64;
    let mut n = 0.0f64;
    for col in &v {
        for &x in col {
            if !x.is_nan() {
                acc += x;
                n += 1.0;
            }
        }
    }
    let mean = acc / n.max(1.0);
    for col in v.iter_mut() {
        for x in col.iter_mut() {
            if x.is_nan() {
                *x = mean;
            }
        }
    }
    let (mut vmin, mut vmax) = (f64::MAX, f64::MIN);
    for col in &v {
        for &x in col {
            vmin = vmin.min(x);
            vmax = vmax.max(x);
        }
    }
    if vmax - vmin < 10.0 {
        return Err("The chart has almost no contrast: the exposure was far too short or too long.".into());
    }
    for col in v.iter_mut() {
        for x in col.iter_mut() {
            *x = (*x - vmin) / (vmax - vmin) * 255.0;
        }
    }

    // análisis por matiz
    let mut monotona = vec![true; CB_COLS];
    let mut escalones = vec![0usize; CB_COLS];
    let mut suavidad = vec![0.0f64; CB_COLS];
    for k in 0..CB_COLS {
        let colv = &v[k];
        for i in 1..CB_ROWS {
            let d = colv[i] - colv[i - 1];
            if d < -10.0 {
                monotona[k] = false;
            }
            if d.abs() >= 10.0 {
                escalones[k] += 1;
            }
        }
        let mut sorted = colv.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let ideal = (sorted[CB_ROWS - 1] - sorted[0]) / (CB_ROWS - 1) as f64;
        let mut acc = 0.0;
        for i in 1..CB_ROWS {
            acc += ((sorted[i] - sorted[i - 1]) - ideal).abs();
        }
        suavidad[k] = acc / (CB_ROWS - 1) as f64;
    }

    // 1) mejor bloqueador: el parche más claro
    let (mut best_col, mut best_row, mut best_v) = (0usize, 0usize, f64::MIN);
    for col in 0..CB_COLS {
        for row in 0..CB_ROWS {
            if v[col][row] > best_v {
                best_v = v[col][row];
                best_col = col;
                best_row = row;
            }
        }
    }
    let mejor_hex = cyan::rgb_to_hex(cb_patch_rgb(best_col, best_row));

    // 2) matiz con mejor separación tonal: top-3 por escalones, gana el más suave
    let mut orden: Vec<usize> = (0..CB_COLS).collect();
    orden.sort_by(|&a, &b| escalones[b].cmp(&escalones[a]));
    let top3 = &orden[..3.min(orden.len())];
    let mejor_hue = *top3.iter().min_by(|&&a, &&b| suavidad[a].partial_cmp(&suavidad[b]).unwrap()).unwrap();

    // 3) paradas del degradado (sombras / medios / luces)
    let mut stops = Vec::new();
    for (target_v, dens) in [(0.0f64, 0i64), (127.0, 127), (255.0, 255)] {
        let mut fila = 0usize;
        let mut best_d = f64::MAX;
        for row in 0..CB_ROWS {
            let d = (v[mejor_hue][row] - target_v).abs();
            if d < best_d {
                best_d = d;
                fila = row;
            }
        }
        stops.push(json!([dens, cyan::rgb_to_hex(cb_patch_rgb(mejor_hue, fila))]));
    }

    let mut notas: Vec<String> = Vec::new();
    let negro_v = v[CB_HUE_COLS].iter().cloned().fold(f64::MIN, f64::max);
    if best_col < CB_HUE_COLS && best_v > negro_v + 15.0 {
        notas.push(format!(
            "On your printer, the color {mejor_hex} blocks UV clearly better than black: use it as the negatives' ink."
        ));
    } else if best_col >= CB_HUE_COLS {
        notas.push("On your printer black/gray is the best blocker: you can keep using black ink.".into());
    }
    let malos = monotona.iter().filter(|&&m| !m).count();
    if malos > 0 {
        notas.push(format!(
            "{malos} hue(s) did not follow the chart's nominal order (normal for colors that barely block UV). They are not discarded."
        ));
    }

    Ok(json!({
        "tipo": "cianotipia_color",
        "paper": paper,
        "dpi": dpi,
        "mejor_color": mejor_hex,
        "mejor_matiz": if best_col >= CB_HUE_COLS { Value::Null } else { json!(best_col * 10) },
        "stops": stops,
        "matiz_degradado": if mejor_hue >= CB_HUE_COLS { Value::Null } else { json!(mejor_hue * 10) },
        "escalones_max": escalones[mejor_hue],
        "notas": notas,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_decode_after_canonical_warp() {
        let page = render_printer_test("A4", 150);
        let g = printer_test_geometry("A4", 150);
        let (warp, s, _r) = align_to_canonical(DynImg::U8(page), &g.cal, "normal").unwrap();
        println!("escala medida: {s}");
        for (mmv, bbox, texto) in &g.qr_test {
            let x1 = (bbox[0] as f64 * s).round() as i64;
            let y1 = (bbox[1] as f64 * s).round() as i64;
            let x2 = (bbox[2] as f64 * s).round() as i64;
            let y2 = (bbox[3] as f64 * s).round() as i64;
            let pad = ((x2 - x1) as f64 * 0.3) as i64;
            let crop = warp.crop((x1 - pad).max(0) as usize, (y1 - pad).max(0) as usize,
                                 (x2 + pad).max(0) as usize, (y2 + pad).max(0) as usize);
            println!("{mmv} mm -> {:?} (esperado {texto})", qr::decode_qr_rgb(&crop));
        }
        // diferencia media entre el warp y la página original
        let orig = render_printer_test("A4", 150);
        let mut acc = 0.0f64;
        let n = (orig.w * orig.h * 3).min(warp.data.len());
        for i in 0..n { acc += (orig.data[i] as f64 - warp.data[i] as f64).abs(); }
        println!("dif media = {:.2}, warp {}x{}, orig {}x{}", acc / n as f64, warp.w, warp.h, orig.w, orig.h);
    }

    #[test]
    fn printer_test_page_renders_and_selfanalyzes() {
        let page = render_printer_test("A4", 150);
        // el análisis del render perfecto debe detectar escala ≈ 1.0
        let out = analyze_printer_test(DynImg::U8(page), "A4", 150, Some(150.0)).unwrap();
        assert!((out["scale_x"].as_f64().unwrap() - 1.0).abs() < 0.01, "{out}");
        assert!((out["scale_y"].as_f64().unwrap() - 1.0).abs() < 0.01);
        // en un render perfecto, hasta el marcador de 4 mm debería detectarse
        assert!(out["marker_min_mm"].as_f64().unwrap() <= 6.0, "{out}");
        assert!(out["qr_min_mm"].as_f64().is_some(), "{out}");
    }

    #[test]
    fn cyanotype_strip_roundtrip_builds_sane_lut() {
        // Carta → copia azul simulada con una respuesta NO lineal conocida →
        // análisis: la LUT resultante debe compensar esa respuesta.
        let strip = render_cyanotype_strip("A4", 150, "#000000", true, CYANO_STEPS, "kamiru21", None, None);
        // exposición de contacto: la copia queda al derecho
        let derecha = strip.flip_horizontal();
        // respuesta no lineal: gamma sobre la exposición
        let g = cyanotype_strip_geometry("A4", 150, CYANO_STEPS, "kamiru21");
        let mut azul = Rgb::new(derecha.w, derecha.h, [245, 242, 230]);
        for y in 0..derecha.h {
            for x in 0..derecha.w {
                let p = derecha.px(x, y);
                let dens = 255.0 - (0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64);
                let expo = (1.0 - dens / 255.0).powf(2.2); // proceso "duro"
                let mut px = [0u8; 3];
                let paper = [245.0, 242.0, 230.0];
                let blue = [23.0, 49.0, 92.0];
                for c in 0..3 {
                    px[c] = (paper[c] + (blue[c] - paper[c]) * expo).round() as u8;
                }
                azul.set_px(x, y, px);
            }
        }
        let _ = g;
        let out = analyze_cyanotype_strip(DynImg::U8(azul), "A4", 150, CYANO_STEPS, "kamiru21", Some("#000000"), None, None).unwrap();
        let lut: Vec<f64> = out["lut"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        assert_eq!(lut.len(), 256);
        // monótona no-decreciente (con tolerancia numérica)
        for i in 1..256 {
            assert!(lut[i] >= lut[i - 1] - 0.5, "lut no monótona en {i}");
        }
        // con gamma 2.2 la curva debe empujar los medios hacia abajo
        // (densidad menor que la identidad en los medios)
        assert!(lut[128] < 120.0, "lut[128]={}", lut[128]);
        assert!(out["rango_dinamico"].as_f64().unwrap() > 0.5);
    }

    #[test]
    fn colorblocker_finds_best_blocker() {
        // Simulación: el magenta (matiz 300°) bloquea mejor que el negro.
        let cb = render_colorblocker("A4", 150, true, None);
        let derecha = cb.flip_horizontal();
        let g = colorblocker_geometry("A4", 150);
        let mut azul = Rgb::new(derecha.w, derecha.h, [245, 242, 230]);
        // modelo: bloqueo = densidad óptica sintética por color
        for y in 0..derecha.h {
            for x in 0..derecha.w {
                let p = derecha.px(x, y);
                let (r, gg, b) = (p[0] as f64 / 255.0, p[1] as f64 / 255.0, p[2] as f64 / 255.0);
                // el UV pasa según el verde (los magentas absorben mucho verde/UV
                // en este modelo de juguete); el negro bloquea bastante pero menos
                let block = (1.0 - gg) * 0.95 + (1.0 - (r + gg + b) / 3.0) * 0.05;
                let expo = (1.0 - block).clamp(0.0, 1.0);
                let paper = [245.0, 242.0, 230.0];
                let blue = [23.0, 49.0, 92.0];
                let mut px = [0u8; 3];
                for c in 0..3 {
                    px[c] = (paper[c] + (blue[c] - paper[c]) * expo).round() as u8;
                }
                azul.set_px(x, y, px);
            }
        }
        let _ = g;
        let out = analyze_colorblocker(DynImg::U8(azul), "A4", 150).unwrap();
        // el ganador debe ser un color con poco verde (magenta/rojo/azul puro)
        let hexc = out["mejor_color"].as_str().unwrap();
        let rgb = cyan::hex_to_rgb(hexc);
        assert!(rgb[1] < 60, "mejor color {hexc} debería tener poco verde: {out}");
        assert_eq!(out["stops"].as_array().unwrap().len(), 3);
    }
}
