//! Superficie WebAssembly (wasm-bindgen): lo que ve el JavaScript del sitio.
//! Convención: parámetros estructurados como JSON string; píxeles como
//! Uint8Array (RGBA concatenado con un meta JSON paralelo).

#![cfg(target_arch = "wasm32")]

use crate::calib;
use crate::codecs;
use crate::cyanotype as cyan;
use crate::dedup;
use crate::img::{DynImg, Rgb};
use crate::layoutfile;
use crate::pdf::PdfBuilder;
use crate::scanproc::{
    base_report, detect_scan, finish_scan, process_scan, resolve_markers, FinishInput,
    LocalShift, ScanOptions, MAX_IMAGE_PIXELS,
};
use crate::sheet::{self, FrameInput, Settings};
use js_sys::{Array, Object, Reflect, Uint8Array};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn parse_settings(settings_json: &str) -> Result<Settings, JsValue> {
    serde_json::from_str(settings_json).map_err(|e| err(format!("Invalid settings: {e}")))
}

#[derive(serde::Deserialize)]
struct FrameMeta {
    w: usize,
    h: usize,
    has_alpha: bool,
    orig_name: String,
    #[serde(default)]
    orig_file: Option<String>,
    /// offset en bytes dentro del buffer concatenado; -1 = sin píxeles
    offset: i64,
}

fn parse_frames(meta_json: &str, pixels: &[u8]) -> Result<Vec<FrameInput>, JsValue> {
    let metas: Vec<FrameMeta> =
        serde_json::from_str(meta_json).map_err(|e| err(format!("Invalid frame metadata: {e}")))?;
    let mut out = Vec::with_capacity(metas.len());
    for m in metas {
        let rgba = if m.offset >= 0 {
            let start = m.offset as usize;
            // aritmética comprobada: en wasm32 (usize de 32 bits) un meta
            // hostil puede enrollar w*h*4 y saltarse el bounds check
            let len = m
                .w
                .checked_mul(m.h)
                .and_then(|p| p.checked_mul(4))
                .ok_or_else(|| err("Frame dimensions overflow"))?;
            let end = start.checked_add(len).ok_or_else(|| err("Frame offset overflows"))?;
            if end > pixels.len() {
                return Err(err("Pixel buffer shorter than the metadata"));
            }
            Some(pixels[start..end].to_vec())
        } else {
            None
        };
        out.push(FrameInput {
            w: m.w,
            h: m.h,
            rgba,
            has_alpha: m.has_alpha,
            orig_name: m.orig_name,
            orig_file: m.orig_file,
        });
    }
    Ok(out)
}

/// Información de layout para la interfaz (páginas, celdas, avisos).
#[wasm_bindgen]
pub fn compute_layout(settings_json: &str, first_w: f64, first_h: f64) -> Result<String, JsValue> {
    let s = parse_settings(settings_json)?;
    let l = sheet::build_layout(&s, (first_w, first_h)).map_err(err)?;
    Ok(json!({
        "page_w": l.page_w,
        "page_h": l.page_h,
        "landscape": l.landscape,
        "cols": l.cols,
        "rows": l.rows,
        "per_page": (l.cols * l.rows).max(1),
        "cell_w": l.cell_w,
        "cell_h": l.cell_h,
        "img_area_h": l.img_area_h,
        "grid_swapped": (l.cols, l.rows) != (s.cols, s.rows),
        "avisos": sheet::cyanotype_size_warnings(&s),
        "marker_capacity": sheet::marker_capacity(&s),
    })
    .to_string())
}

/// Renderiza (o solo mide) UNA hoja. Devuelve {png?, record, page_w, page_h}.
/// `finish`: "none" (lienzo crudo), "final" (escala de impresora + espejo),
/// "simulate" (simulación de la copia azul, para vista previa).
#[wasm_bindgen]
pub fn render_sheet(
    settings_json: &str,
    first_w: f64,
    first_h: f64,
    meta_json: &str,
    pixels: &[u8],
    labels_json: &str,
    sheet_num: f64,
    render: bool,
    finish: &str,
    response_json: &str,
) -> Result<JsValue, JsValue> {
    let s = parse_settings(settings_json)?;
    let l = sheet::build_layout(&s, (first_w, first_h)).map_err(err)?;
    let frames = parse_frames(meta_json, pixels)?;
    let labels: Vec<String> =
        serde_json::from_str(labels_json).map_err(|e| err(format!("Invalid labels: {e}")))?;
    let res = sheet::render_page(&s, &l, &frames, &labels, sheet_num as i64, render);
    let out = Object::new();
    if let Some(mut img) = res.image {
        match finish {
            "final" => img = sheet::finish_page(&s, img),
            "simulate" => {
                img = sheet::finish_page(&s, img);
                if s.is_cyanotype() {
                    if s.cyan_mirror {
                        img = img.flip_horizontal(); // la copia de contacto queda al derecho
                    }
                    let response: Option<Vec<(f64, f64)>> = serde_json::from_str(response_json).ok();
                    let stops = s.ink_stops();
                    img = cyan::simulate_print(&img, response.as_deref(), Some(&s.cyan_ink), stops.as_deref());
                }
            }
            _ => {}
        }
        let png = codecs::encode_png_rgb(&img);
        Reflect::set(&out, &"png".into(), &Uint8Array::from(png.as_slice())).ok();
        Reflect::set(&out, &"w".into(), &JsValue::from_f64(img.w as f64)).ok();
        Reflect::set(&out, &"h".into(), &JsValue::from_f64(img.h as f64)).ok();
    }
    let mut record = res.record.unwrap_or(Value::Null);
    if !record.is_null() {
        sheet::scale_record_bboxes(&s, &l, &mut record);
    }
    Reflect::set(&out, &"record".into(), &JsValue::from_str(&record.to_string())).ok();
    Ok(out.into())
}

/// Ensambla el layout.json v2 completo.
#[wasm_bindgen]
pub fn assemble_layout(
    settings_json: &str,
    first_w: f64,
    first_h: f64,
    records_json: &str,
    timeline_json: &str,
    video_json: &str,
    originales_dir: &str,
) -> Result<String, JsValue> {
    let s = parse_settings(settings_json)?;
    let l = sheet::build_layout(&s, (first_w, first_h)).map_err(err)?;
    let records: Vec<Value> = serde_json::from_str(records_json).map_err(err)?;
    let timeline: Value = serde_json::from_str(timeline_json).unwrap_or(json!([]));
    let video: Value = serde_json::from_str(video_json).unwrap_or(json!({}));
    let dir = if originales_dir.is_empty() { None } else { Some(originales_dir) };
    Ok(sheet::build_layout_json(&s, &l, &records, timeline, video, dir).to_string())
}

/// dHash de una tanda de fotogramas (RGBA concatenado). Devuelve JSON
/// [[u64;4], ...] como strings hexadecimales.
#[wasm_bindgen]
pub fn dedup_hashes(meta_json: &str, pixels: &[u8]) -> Result<String, JsValue> {
    let frames = parse_frames(meta_json, pixels)?;
    let mut out = Vec::new();
    for f in frames {
        let rgba = f.rgba.ok_or_else(|| err("Frame without pixels"))?;
        // aplanar sobre blanco (lo que ve la impresión)
        let mut rgb = Vec::with_capacity(f.w * f.h * 3);
        for p in rgba.chunks_exact(4) {
            let a = p[3] as u32;
            for c in 0..3 {
                rgb.push(((p[c] as u32 * a + 255 * (255 - a)) / 255) as u8);
            }
        }
        let h = dedup::dhash(&Rgb { w: f.w, h: f.h, data: rgb });
        out.push(h.map(|x| format!("{x:016x}")));
    }
    Ok(serde_json::to_string(&out).unwrap())
}

/// Agrupa duplicados a partir de los hashes. Devuelve {reps, rep_of}.
#[wasm_bindgen]
pub fn group_duplicates(hashes_json: &str, threshold: u32) -> Result<String, JsValue> {
    let hex: Vec<[String; 4]> = serde_json::from_str(hashes_json).map_err(err)?;
    let hashes: Vec<[u64; 4]> = hex
        .iter()
        .map(|h| {
            let mut out = [0u64; 4];
            for i in 0..4 {
                out[i] = u64::from_str_radix(&h[i], 16).unwrap_or(0);
            }
            out
        })
        .collect();
    let (reps, rep_of) = dedup::find_duplicates(&hashes, threshold);
    Ok(json!({ "reps": reps, "rep_of": rep_of }).to_string())
}

/// Histograma de contenido (para la adaptación de la curva de cianotipia).
#[wasm_bindgen]
pub fn content_histogram(meta_json: &str, pixels: &[u8]) -> Result<String, JsValue> {
    let frames = parse_frames(meta_json, pixels)?;
    let mut hist = [0.0f64; 256];
    for f in frames {
        if let Some(rgba) = f.rgba {
            let mut rgb = Vec::with_capacity(f.w * f.h * 3);
            for p in rgba.chunks_exact(4) {
                let a = p[3] as u32;
                for c in 0..3 {
                    rgb.push(((p[c] as u32 * a + 255 * (255 - a)) / 255) as u8);
                }
            }
            cyan::accumulate_histogram(&mut hist, &Rgb { w: f.w, h: f.h, data: rgb });
        }
    }
    Ok(serde_json::to_string(&hist.to_vec()).unwrap())
}

/// Resuelve la curva efectiva (calibrada × fuerza ∘ adaptación) una sola vez
/// por generación. Devuelve la LUT o null si es la identidad.
#[wasm_bindgen]
pub fn effective_curve(lut_json: &str, strength: f64, adapt: f64, hist_json: &str) -> String {
    let lut: Option<Vec<f64>> = serde_json::from_str(lut_json).ok();
    let hist: Option<Vec<f64>> = serde_json::from_str(hist_json).ok();
    let hist_arr: Option<[f64; 256]> = hist.and_then(|h| h.try_into().ok());
    match cyan::effective_lut(lut.as_deref(), strength, adapt, hist_arr.as_ref()) {
        Some(l) => serde_json::to_string(&l).unwrap(),
        None => "null".into(),
    }
}

/// Decodifica una imagen (PNG/JPG/TIFF/BMP/WebP, 8/16 bits) a RGBA de 8 bits
/// para mostrarla o usarla como fotograma. Devuelve {w, h, rgba, sixteen}.
#[wasm_bindgen]
pub fn decode_image(bytes: &[u8]) -> Result<JsValue, JsValue> {
    let (dimg, has_alpha) = codecs::decode(bytes).map_err(err)?;
    let sixteen = matches!(dimg, DynImg::U16(_));
    let rgb = dimg.to_rgb8();
    let mut rgba = Vec::with_capacity(rgb.w * rgb.h * 4);
    for p in rgb.data.chunks_exact(3) {
        rgba.extend_from_slice(&[p[0], p[1], p[2], 255]);
    }
    let out = Object::new();
    Reflect::set(&out, &"w".into(), &JsValue::from_f64(rgb.w as f64)).ok();
    Reflect::set(&out, &"h".into(), &JsValue::from_f64(rgb.h as f64)).ok();
    Reflect::set(&out, &"rgba".into(), &Uint8Array::from(rgba.as_slice())).ok();
    Reflect::set(&out, &"sixteen".into(), &JsValue::from_bool(sixteen)).ok();
    Reflect::set(&out, &"had_alpha".into(), &JsValue::from_bool(has_alpha)).ok();
    Ok(out.into())
}

fn parse_scan_options(opts_json: &str) -> ScanOptions {
    let opts_v: Value = serde_json::from_str(opts_json).unwrap_or(json!({}));
    let mut opts = ScanOptions::default();
    if let Some(b) = opts_v.get("bleed").and_then(|v| v.as_f64()) {
        opts.bleed = b;
    }
    if let Some(m) = opts_v.get("min_markers").and_then(|v| v.as_u64()) {
        opts.min_markers = m as usize;
    }
    if let Some(m) = opts_v.get("mode").and_then(|v| v.as_str()) {
        opts.mode = m.to_string();
    }
    if let Some(b) = opts_v.get("resize_to_original").and_then(|v| v.as_bool()) {
        opts.resize_to_original = b;
    }
    if let Some(b) = opts_v.get("normalize_patches").and_then(|v| v.as_bool()) {
        opts.normalize_patches = b;
    }
    if let Some(b) = opts_v.get("fine_align").and_then(|v| v.as_bool()) {
        opts.fine_align = b;
    }
    opts
}

fn scan_output_to_js(out: crate::scanproc::ScanOutput) -> JsValue {
    let obj = Object::new();
    Reflect::set(&obj, &"result".into(), &JsValue::from_str(&out.result.to_string())).ok();
    let frames = Array::new();
    for (label, crop) in &out.frames {
        let f = Object::new();
        Reflect::set(&f, &"label".into(), &JsValue::from_str(label)).ok();
        let png = codecs::encode_png_dyn(crop);
        Reflect::set(&f, &"png".into(), &Uint8Array::from(png.as_slice())).ok();
        frames.push(&f);
    }
    Reflect::set(&obj, &"frames".into(), &frames).ok();
    let unid = Array::new();
    for (name, crop) in &out.unidentified {
        let f = Object::new();
        Reflect::set(&f, &"label".into(), &JsValue::from_str(name)).ok();
        let png = codecs::encode_png_dyn(crop);
        Reflect::set(&f, &"png".into(), &Uint8Array::from(png.as_slice())).ok();
        unid.push(&f);
    }
    Reflect::set(&obj, &"sin_identificar".into(), &unid).ok();
    if let Some(ov) = &out.overlay {
        let jpg = codecs::encode_jpeg_rgb(ov, 82);
        Reflect::set(&obj, &"overlay".into(), &Uint8Array::from(jpg.as_slice())).ok();
    }
    obj.into()
}

/// RGBA (del canvas del navegador) → Rgb de 8 bits.
fn rgba_to_rgb(rgba: &[u8], w: usize, h: usize) -> Result<Rgb, JsValue> {
    // el tope va primero: descarta dimensiones que enrollarían w*h*4 en wasm32
    let area = w.checked_mul(h).ok_or_else(|| err("Image dimensions overflow"))?;
    if area > MAX_IMAGE_PIXELS {
        return Err(err(format!("Image too large ({w}×{h}).")));
    }
    if w == 0 || h == 0 || rgba.len() < area * 4 {
        return Err(err("RGBA buffer does not match the given dimensions"));
    }
    let mut data = Vec::with_capacity(w * h * 3);
    for p in rgba.chunks_exact(4).take(w * h) {
        data.extend_from_slice(&p[..3]);
    }
    Ok(Rgb { w, h, data })
}

/// Procesa UN escaneo (decodificación + detección + warp + recortes, todo en
/// WASM). Devuelve {result, frames: [{label, png}], sin_identificar, overlay}.
#[wasm_bindgen]
pub fn scan_process(
    scan_bytes: &[u8],
    scan_name: &str,
    layout_json: &str,
    opts_json: &str,
    claims_json: &str,
) -> Result<JsValue, JsValue> {
    let layout_raw: Value = serde_json::from_str(layout_json).map_err(err)?;
    let layout = layoutfile::normalize(layout_raw);
    let opts = parse_scan_options(opts_json);
    let claims_map: std::collections::HashMap<i64, String> =
        serde_json::from_str(claims_json).unwrap_or_default();

    let (img, _alpha) = codecs::decode(scan_bytes).map_err(err)?;
    let out = process_scan(img, scan_name, &layout, &opts, &claims_map);
    Ok(scan_output_to_js(out))
}

/// Fase de detección para el camino con warp por WebGPU: recibe el RGBA de
/// 8 bits ya decodificado por el navegador y devuelve un JSON con la
/// homografía, escala, espejado y el estado necesario para `scan_finish`.
#[wasm_bindgen]
pub fn scan_detect(
    rgba: &[u8],
    w: usize,
    h: usize,
    scan_name: &str,
    layout_json: &str,
    opts_json: &str,
) -> Result<String, JsValue> {
    let layout_raw: Value = serde_json::from_str(layout_json).map_err(err)?;
    let layout = layoutfile::normalize(layout_raw);
    let opts = parse_scan_options(opts_json);
    let markers = resolve_markers(&layout);
    let mut img = DynImg::U8(rgba_to_rgb(rgba, w, h)?);
    let mut res = base_report(scan_name);
    match detect_scan(&mut img, &layout, &opts, &markers, &mut res) {
        Ok(d) => {
            let ids: Vec<u32> = d.refined.keys().cloned().collect();
            Ok(json!({
                "ok": true,
                "res": res,
                "m": d.m.to_vec(),
                "s": d.s,
                "flipped": d.flipped,
                "out_w": d.out_w,
                "out_h": d.out_h,
                "refined_ids": ids,
                "local": d.local,
            })
            .to_string())
        }
        Err(()) => Ok(json!({ "ok": false, "res": res }).to_string()),
    }
}

/// Fase final para el camino WebGPU: recibe la hoja YA enderezada (RGBA) y el
/// estado que devolvió `scan_detect`. Mismo formato de salida que scan_process.
#[wasm_bindgen]
pub fn scan_finish(
    warped_rgba: &[u8],
    w: usize,
    h: usize,
    scan_name: &str,
    layout_json: &str,
    opts_json: &str,
    claims_json: &str,
    state_json: &str,
) -> Result<JsValue, JsValue> {
    let layout_raw: Value = serde_json::from_str(layout_json).map_err(err)?;
    let layout = layoutfile::normalize(layout_raw);
    let opts = parse_scan_options(opts_json);
    let claims_map: std::collections::HashMap<i64, String> =
        serde_json::from_str(claims_json).unwrap_or_default();
    let markers = resolve_markers(&layout);
    let state: Value = serde_json::from_str(state_json).map_err(err)?;
    // el informe debe ser un objeto con "advertencias" (array): un estado
    // malformado no debe poder hacer panic aguas abajo
    let res = match state.get("res") {
        Some(r) if r.is_object() && r.get("advertencias").map_or(false, |a| a.is_array()) => r.clone(),
        _ => base_report(scan_name),
    };
    let s = state.get("s").and_then(|v| v.as_f64()).ok_or_else(|| err("state without scale"))?;
    let refined_ids: std::collections::HashSet<u32> = state
        .get("refined_ids")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_u64().map(|u| u as u32)).collect())
        .unwrap_or_default();
    let local: Option<LocalShift> = state
        .get("local")
        .filter(|v| !v.is_null())
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let warp = DynImg::U8(rgba_to_rgb(warped_rgba, w, h)?);
    let fin = FinishInput { s, refined_ids, local };
    let out = finish_scan(warp, scan_name, &layout, &opts, &claims_map, &markers, fin, res);
    Ok(scan_output_to_js(out))
}

/// Remuestrea un buffer RGBA opaco con Lanczos3 (mismo filtro que las hojas).
/// La fase de video escala aquí en vez de con el drawImage del navegador.
#[wasm_bindgen]
pub fn resize_rgba(rgba: &[u8], w: usize, h: usize, out_w: usize, out_h: usize) -> Result<Vec<u8>, JsValue> {
    let area = w.checked_mul(h).ok_or_else(|| err("Image dimensions overflow"))?;
    let out_area = out_w.checked_mul(out_h).ok_or_else(|| err("Image dimensions overflow"))?;
    if area > MAX_IMAGE_PIXELS || out_area > MAX_IMAGE_PIXELS {
        return Err(err(format!("Image too large ({w}×{h} → {out_w}×{out_h}).")));
    }
    if w == 0 || h == 0 || out_w == 0 || out_h == 0 || rgba.len() < area * 4 {
        return Err(err("RGBA buffer does not match the given dimensions"));
    }
    Ok(crate::img::resize_rgba_bytes(&rgba[..area * 4], w, h, out_w, out_h))
}

/// Re-codifica un PNG (el que devuelve render_sheet) como TIFF, conservando
/// la profundidad de bits.
#[wasm_bindgen]
pub fn encode_tiff(png_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    let (img, _) = codecs::decode(png_bytes).map_err(err)?;
    Ok(codecs::encode_tiff_dyn(&img))
}

// ── Calibración ─────────────────────────────────────────────────

#[wasm_bindgen]
pub fn printer_test_png(paper: &str, dpi: u32) -> Vec<u8> {
    codecs::encode_png_rgb(&calib::render_printer_test(paper, dpi))
}

#[wasm_bindgen]
pub fn analyze_printer_test(scan_bytes: &[u8], paper: &str, dpi: u32, scan_dpi: f64) -> Result<String, JsValue> {
    let (img, _) = codecs::decode(scan_bytes).map_err(err)?;
    let sd = if scan_dpi > 0.0 { Some(scan_dpi) } else { None };
    calib::analyze_printer_test(img, paper, dpi, sd).map(|v| v.to_string()).map_err(err)
}

fn parse_stops(stops_json: &str) -> Option<Vec<cyan::InkStop>> {
    let raw: Option<Vec<(f64, String)>> = serde_json::from_str(stops_json).ok();
    raw.map(|ss| ss.iter().map(|(d, c)| (*d, cyan::hex_to_rgb(c))).collect())
}

#[wasm_bindgen]
pub fn cyan_strip_png(
    paper: &str,
    dpi: u32,
    ink_color: &str,
    mirror: bool,
    target: &str,
    stops_json: &str,
    block_color: &str,
) -> Vec<u8> {
    let stops = parse_stops(stops_json);
    let bc = if block_color.is_empty() { None } else { Some(block_color) };
    codecs::encode_png_rgb(&calib::render_cyanotype_strip(
        paper,
        dpi,
        ink_color,
        mirror,
        calib::CYANO_STEPS,
        target,
        stops.as_deref(),
        bc,
    ))
}

#[wasm_bindgen]
pub fn analyze_cyan_strip(
    scan_bytes: &[u8],
    paper: &str,
    dpi: u32,
    target: &str,
    ink_color: &str,
    stops_json: &str,
    block_color: &str,
) -> Result<String, JsValue> {
    let (img, _) = codecs::decode(scan_bytes).map_err(err)?;
    let stops = parse_stops(stops_json);
    let bc = if block_color.is_empty() { None } else { Some(block_color) };
    calib::analyze_cyanotype_strip(
        img,
        paper,
        dpi,
        calib::CYANO_STEPS,
        target,
        if ink_color.is_empty() { None } else { Some(ink_color) },
        stops.as_deref(),
        bc,
    )
    .map(|v| v.to_string())
    .map_err(err)
}

#[wasm_bindgen]
pub fn colorblocker_png(paper: &str, dpi: u32, mirror: bool, block_color: &str) -> Vec<u8> {
    let bc = if block_color.is_empty() { None } else { Some(block_color) };
    codecs::encode_png_rgb(&calib::render_colorblocker(paper, dpi, mirror, bc))
}

#[wasm_bindgen]
pub fn analyze_colorblocker(scan_bytes: &[u8], paper: &str, dpi: u32) -> Result<String, JsValue> {
    let (img, _) = codecs::decode(scan_bytes).map_err(err)?;
    calib::analyze_colorblocker(img, paper, dpi).map(|v| v.to_string()).map_err(err)
}

// ── PDF combinado ───────────────────────────────────────────────

#[wasm_bindgen]
pub struct Pdf {
    inner: Option<PdfBuilder>,
}

#[wasm_bindgen]
impl Pdf {
    #[wasm_bindgen(constructor)]
    pub fn new(dpi: u32) -> Pdf {
        Pdf { inner: Some(PdfBuilder::new(dpi)) }
    }

    /// Añade una página desde un PNG (el mismo que devuelve render_sheet).
    pub fn add_page_png(&mut self, png: &[u8]) -> Result<(), JsValue> {
        let (img, _) = codecs::decode(png).map_err(err)?;
        if let Some(b) = self.inner.as_mut() {
            b.add_page(&img.to_rgb8());
        }
        Ok(())
    }

    pub fn page_count(&self) -> usize {
        self.inner.as_ref().map_or(0, |b| b.page_count())
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsValue> {
        self.inner.take().map(|b| b.finish()).ok_or_else(|| err("PDF already finalized"))
    }
}
