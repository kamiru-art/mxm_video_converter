//! Integración de punta a punta: generar hoja → simular escaneo → procesar.
//! Es el equivalente del test_pipeline.py de la app original, en Rust puro.

use mxm_core::cyanotype;
use mxm_core::geometry::{apply_h, invert_h, Rng, H3};
use mxm_core::img::{DynImg, Rgb};
use mxm_core::scanproc::{process_scan, ScanOptions};
use mxm_core::sheet::{self, build_layout, build_layout_json, render_page, FrameInput, Settings};
use serde_json::json;
use std::collections::HashMap;

/// Fotograma sintético reconocible: color base + franja diagonal.
fn synth_frame(w: usize, h: usize, base: [u8; 3]) -> (FrameInput, [u8; 3]) {
    let mut rgba = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let on_stripe = (x + y) % 40 < 8;
            let c = if on_stripe { [255, 255, 255] } else { base };
            rgba.extend_from_slice(&[c[0], c[1], c[2], 255]);
        }
    }
    (
        FrameInput { w, h, rgba: Some(rgba), has_alpha: false, orig_name: "f.png".into(), orig_file: None },
        base,
    )
}

fn base_settings() -> Settings {
    let mut s = Settings::default();
    s.registration_on = true;
    s.dpi = 150;
    s.cols = 2;
    s.rows = 2;
    s.marker_count = 8;
    s.project_name = "demo".into();
    s.out_name = "demo".into();
    (s.marker_size_mm, s.qr_size_mm) = (10.0, 14.0);
    s
}

/// Simula el escaneo: pega la hoja sobre un fondo mayor, aplica una
/// homografía suave (rotación + perspectiva + escala) y añade ruido leve.
fn simulate_scan(sheet_img: &Rgb, scale: f64, seed: u64) -> Rgb {
    let (w, h) = (sheet_img.w as f64, sheet_img.h as f64);
    let out_w = (w * scale * 1.15) as usize;
    let out_h = (h * scale * 1.15) as usize;
    // rotación de ~2° + un toque de perspectiva + traslación
    let ang: f64 = 0.035;
    let (c, sn) = (ang.cos() * scale, ang.sin() * scale);
    let m: H3 = [
        c, -sn, 40.0,
        sn, c, 30.0,
        0.000004, 0.000002, 1.0,
    ];
    let minv = invert_h(&m).unwrap();
    let mut rng = Rng::new(seed);
    let mut out = Rgb::new(out_w, out_h, [180, 180, 175]);
    for y in 0..out_h {
        for x in 0..out_w {
            let p = apply_h(&minv, (x as f64, y as f64));
            if p.0 >= 0.0 && p.1 >= 0.0 && p.0 < w - 1.0 && p.1 < h - 1.0 {
                // bilineal
                let x0 = p.0.floor() as usize;
                let y0 = p.1.floor() as usize;
                let fx = p.0 - x0 as f64;
                let fy = p.1 - y0 as f64;
                let mut px = [0u8; 3];
                for ch in 0..3 {
                    let p00 = sheet_img.px(x0, y0)[ch] as f64;
                    let p01 = sheet_img.px(x0 + 1, y0)[ch] as f64;
                    let p10 = sheet_img.px(x0, y0 + 1)[ch] as f64;
                    let p11 = sheet_img.px(x0 + 1, y0 + 1)[ch] as f64;
                    let v = p00 * (1.0 - fx) * (1.0 - fy)
                        + p01 * fx * (1.0 - fy)
                        + p10 * (1.0 - fx) * fy
                        + p11 * fx * fy;
                    let noise = rng.jitter() * 6.0;
                    px[ch] = (v + noise).round().clamp(0.0, 255.0) as u8;
                }
                out.set_px(x, y, px);
            }
        }
    }
    out
}

fn mean_rgb(img: &Rgb) -> [f64; 3] {
    let mut acc = [0.0f64; 3];
    for p in img.data.chunks_exact(3) {
        for c in 0..3 {
            acc[c] += p[c] as f64;
        }
    }
    let n = (img.data.len() / 3) as f64;
    [acc[0] / n, acc[1] / n, acc[2] / n]
}

#[test]
fn normal_mode_full_roundtrip() {
    let s = base_settings();
    let l = build_layout(&s, (16.0, 9.0)).unwrap();
    let mut frames = Vec::new();
    let mut colors = Vec::new();
    for base in [[200u8, 60, 60], [60, 180, 60], [60, 60, 200], [180, 160, 40]] {
        let (f, c) = synth_frame(320, 180, base);
        frames.push(f);
        colors.push(c);
    }
    let labels: Vec<String> = (1..=4).map(|i| format!("demo_{:03}", i)).collect();
    let page = render_page(&s, &l, &frames, &labels, 1, true);
    let img = page.image.unwrap();
    let mut record = page.record.unwrap();
    record["archivo_hoja"] = json!("demo_p1.png");
    let layout = build_layout_json(&s, &l, &[record], json!([]), json!({}), None);

    // escaneo simulado a 1.4× con rotación y perspectiva
    let scan = simulate_scan(&img, 1.4, 99);
    let out = process_scan(DynImg::U8(scan), "scan1.png", &layout, &ScanOptions::default(), &HashMap::new());
    assert_eq!(out.result["ok"], json!(true), "resultado: {}", out.result);
    assert_eq!(out.result["hoja_numero"], json!(1));
    assert!(out.result["marcadores"].as_i64().unwrap() >= 6, "{}", out.result);
    assert_eq!(out.frames.len(), 4, "faltan frames: {}", out.result);
    // la escala medida debe rondar 1.4
    let esc = out.result["escala"].as_f64().unwrap();
    assert!((esc - 1.4).abs() < 0.05, "escala {esc}");
    // el color medio de cada recorte debe parecerse al original
    for (label, crop) in &out.frames {
        let idx: usize = label[5..8].parse::<usize>().unwrap() - 1;
        let rgb = crop.to_rgb8();
        let m = mean_rgb(&rgb);
        // color base con franjas blancas ~20 %: media esperada = 0.8·base + 0.2·blanco
        let expect: Vec<f64> = colors[idx].iter().map(|&c| 0.8 * c as f64 + 0.2 * 255.0).collect();
        for ch in 0..3 {
            assert!(
                (m[ch] - expect[ch]).abs() < 28.0,
                "{label} canal {ch}: {} vs {}",
                m[ch],
                expect[ch]
            );
        }
    }
}

#[test]
fn scan_mirrored_is_auto_corrected() {
    let s = base_settings();
    let l = build_layout(&s, (16.0, 9.0)).unwrap();
    let (f1, _) = synth_frame(320, 180, [120, 40, 160]);
    let labels = vec!["demo_001".to_string()];
    let page = render_page(&s, &l, &[f1], &labels, 1, true);
    let img = page.image.unwrap();
    let mut record = page.record.unwrap();
    record["archivo_hoja"] = json!("demo_p1.png");
    let layout = build_layout_json(&s, &l, &[record], json!([]), json!({}), None);

    let scan = simulate_scan(&img, 1.2, 7).flip_horizontal();
    let out = process_scan(DynImg::U8(scan), "esp.png", &layout, &ScanOptions::default(), &HashMap::new());
    assert_eq!(out.result["ok"], json!(true), "{}", out.result);
    assert_eq!(out.result["espejado"], json!(true));
    assert_eq!(out.frames.len(), 1);
}

#[test]
fn markers_identify_sheet_without_qr() {
    // Modo sin QR: la identidad de cada hoja viaja en los IDs de los
    // marcadores ArUco. Un layout de 2 hojas debe identificar la hoja 2.
    let mut s = base_settings();
    s.qr_on = false;
    s.marker_dict = "DICT_5X5_100".into();
    let l = build_layout(&s, (16.0, 9.0)).unwrap();

    let mut records = Vec::new();
    let mut page2_img = None;
    for sheet_num in 1..=2i64 {
        let mut frames = Vec::new();
        for base in [[200u8, 60, 60], [60, 60, 200]] {
            let (f, _) = synth_frame(320, 180, base);
            frames.push(f);
        }
        let labels: Vec<String> = (1..=2)
            .map(|i| format!("demo_{:03}", (sheet_num - 1) * 2 + i))
            .collect();
        let page = render_page(&s, &l, &frames, &labels, sheet_num, true);
        let mut record = page.record.unwrap();
        record["archivo_hoja"] = json!(format!("demo_p{sheet_num}.png"));
        records.push(record);
        if sheet_num == 2 {
            page2_img = page.image;
        }
    }
    let layout = build_layout_json(&s, &l, &records, json!([]), json!({}), None);
    let iph = &layout["marcadores"]["ids_por_hoja"];
    assert!(iph.is_object(), "el layout sin QR debe llevar ids_por_hoja: {iph}");
    assert_ne!(iph["1"], iph["2"], "cada hoja debe tener IDs distintos");

    let scan = simulate_scan(&page2_img.unwrap(), 1.3, 21);
    let out = process_scan(DynImg::U8(scan), "s2.png", &layout, &ScanOptions::default(), &HashMap::new());
    assert_eq!(out.result["ok"], json!(true), "resultado: {}", out.result);
    assert_eq!(out.result["hoja_numero"], json!(2), "{}", out.result);
    let via = out.result["via"].as_str().unwrap();
    assert!(via.starts_with("marker IDs"), "via = {via}");
    assert_eq!(out.frames.len(), 2, "{}", out.result);
    // el total debe ser los marcadores DE LA HOJA, no la unión de todas
    assert_eq!(out.result["marcadores_total"], json!(8), "{}", out.result);
    // un escaneo limpio no debe descartar marcadores por residuo (los
    // descartes venían de releer marcadores propios como IDs de otras hojas)
    let adv = out.result["advertencias"].as_array().unwrap();
    assert!(
        adv.iter().all(|a| !a.as_str().unwrap_or("").contains("discarded")),
        "descartes inesperados: {adv:?}"
    );
    let mut labs: Vec<&str> = out.frames.iter().map(|(l2, _)| l2.as_str()).collect();
    labs.sort();
    assert_eq!(labs, vec!["demo_003", "demo_004"]);
}

#[test]
fn cyanotype_full_roundtrip() {
    // Hoja en modo cianotipia (negativo espejado) → copia azul simulada →
    // escaneo → procesado en modo cianotipia.
    let mut s = base_settings();
    s.mode = "cianotipia".into();
    s.cyan_mirror = true;
    s.cyan_bg = "ahorro".into();
    s.qr_size_mm = 16.0; // como recomienda la app para química real
    s.marker_size_mm = 12.0;
    let l = build_layout(&s, (16.0, 9.0)).unwrap();
    let mut frames = Vec::new();
    for base in [[200u8, 60, 60], [40, 40, 40]] {
        let (f, _) = synth_frame(320, 180, base);
        frames.push(f);
    }
    let labels: Vec<String> = (1..=2).map(|i| format!("cy_{:03}", i)).collect();
    let page = render_page(&s, &l, &frames, &labels, 1, true);
    let mut record = page.record.unwrap();
    record["archivo_hoja"] = json!("cy_p1.png");
    let layout = build_layout_json(&s, &l, &[record], json!([]), json!({}), None);

    // negativo final impreso (espejado)
    let negativo = sheet::finish_page(&s, page.image.unwrap());
    // exposición de contacto: la copia azul queda al derecho otra vez
    let copia_derecha = negativo.flip_horizontal();
    let azul = cyanotype::simulate_print(&copia_derecha, None, Some(&s.cyan_ink), None);

    let scan = simulate_scan(&azul, 1.3, 42);
    let mut opts = ScanOptions::default();
    opts.mode = "auto".into(); // el layout dice "cianotipia"
    let out = process_scan(DynImg::U8(scan), "cyan1.png", &layout, &opts, &HashMap::new());
    assert_eq!(out.result["ok"], json!(true), "resultado: {}", out.result);
    assert_eq!(out.frames.len(), 2, "{}", out.result);
    // el frame oscuro y el rojizo deben distinguirse en la copia azul:
    // más brillo original ⇒ más densidad ⇒ menos exposición ⇒ MÁS CLARO
    let f1 = out.frames.iter().find(|(l2, _)| l2 == "cy_001").unwrap();
    let f2 = out.frames.iter().find(|(l2, _)| l2 == "cy_002").unwrap();
    let m1 = mean_rgb(&f1.1.to_rgb8());
    let m2 = mean_rgb(&f2.1.to_rgb8());
    assert!(m1[0] > m2[0] + 10.0, "rojo claro {} vs oscuro {}", m1[0], m2[0]);
}

#[test]
fn sixteen_bit_scan_keeps_depth() {
    let s = base_settings();
    let l = build_layout(&s, (16.0, 9.0)).unwrap();
    let (f1, _) = synth_frame(320, 180, [90, 150, 210]);
    let labels = vec!["demo_001".to_string()];
    let page = render_page(&s, &l, &[f1], &labels, 1, true);
    let mut record = page.record.unwrap();
    record["archivo_hoja"] = json!("demo_p1.png");
    let layout = build_layout_json(&s, &l, &[record], json!([]), json!({}), None);

    let scan8 = simulate_scan(&page.image.unwrap(), 1.1, 3);
    // subir a 16 bits
    let data16: Vec<u16> = scan8.data.iter().map(|&v| (v as u16) << 8 | v as u16).collect();
    let scan16 = DynImg::U16(mxm_core::img::Rgb16 { w: scan8.w, h: scan8.h, data: data16 });
    let out = process_scan(scan16, "s16.tif", &layout, &ScanOptions::default(), &HashMap::new());
    assert_eq!(out.result["ok"], json!(true), "{}", out.result);
    match &out.frames[0].1 {
        DynImg::U16(_) => {}
        _ => panic!("el recorte debería seguir siendo de 16 bits"),
    }
}

#[test]
fn manual_sheet_assignment_when_the_qr_is_unreadable() {
    // Caso real: los marcadores se leen bien (la hoja se endereza), pero el
    // QR quedó tapado por la pintura, así que nada identifica la hoja. El
    // usuario dice a mano cuál es y los recortes salen con sus etiquetas.
    let mut s = base_settings();
    s.qr_on = true; // con QR NO hay ids_por_hoja: la identidad es solo el QR
    let l = build_layout(&s, (16.0, 9.0)).unwrap();

    let mut records = Vec::new();
    let mut page2_img = None;
    for sheet_num in 1..=2i64 {
        let frames: Vec<_> = [[200u8, 60, 60], [60, 60, 200]]
            .iter()
            .map(|base| synth_frame(320, 180, *base).0)
            .collect();
        let labels: Vec<String> = (1..=2)
            .map(|i| format!("demo_{:03}", (sheet_num - 1) * 2 + i))
            .collect();
        let page = render_page(&s, &l, &frames, &labels, sheet_num, true);
        let mut record = page.record.unwrap();
        record["archivo_hoja"] = json!(format!("demo_p{sheet_num}.png"));
        records.push(record);
        if sheet_num == 2 {
            page2_img = page.image;
        }
    }
    let mut layout = build_layout_json(&s, &l, &records, json!([]), json!({}), None);
    assert!(layout["marcadores"]["ids_por_hoja"].is_null(), "con QR no debe haber ids_por_hoja");
    // simular que ningún QR se puede leer: se quitan del layout
    for hoja in layout["hojas"].as_array_mut().unwrap() {
        hoja["qrs"] = json!({});
    }

    let scan = simulate_scan(&page2_img.unwrap(), 1.3, 33);

    // 1. Sin asignación manual: la hoja no se identifica.
    let auto = process_scan(
        DynImg::U8(scan.clone()),
        "s2.png",
        &layout,
        &ScanOptions::default(),
        &HashMap::new(),
    );
    assert_eq!(auto.result["ok"], json!(false), "{}", auto.result);
    assert!(auto.frames.is_empty());
    assert!(!auto.unidentified.is_empty(), "debe dejar los recortes sin identificar");

    // 2. Con asignación manual a la hoja 2: recortes con sus etiquetas.
    let opts = ScanOptions { forced_sheet: Some(2), ..ScanOptions::default() };
    let out = process_scan(DynImg::U8(scan), "s2.png", &layout, &opts, &HashMap::new());
    assert_eq!(out.result["ok"], json!(true), "{}", out.result);
    assert_eq!(out.result["hoja_numero"], json!(2), "{}", out.result);
    let via = out.result["via"].as_str().unwrap();
    assert!(via.starts_with("assigned by hand"), "via = {via}");
    let mut labs: Vec<&str> = out.frames.iter().map(|(lab, _)| lab.as_str()).collect();
    labs.sort();
    assert_eq!(labs, vec!["demo_003", "demo_004"]);

    // 3. Un número de hoja inexistente no rompe: vuelve a lo automático.
    let opts = ScanOptions { forced_sheet: Some(99), ..ScanOptions::default() };
    let bad = process_scan(
        DynImg::U8(simulate_scan(&render_page(&s, &l, &[], &[], 1, true).image.unwrap(), 1.3, 34)),
        "s1.png",
        &layout,
        &opts,
        &HashMap::new(),
    );
    let adv = bad.result["advertencias"].as_array().unwrap();
    assert!(
        adv.iter().any(|a| a.as_str().unwrap_or("").contains("does not exist")),
        "debe avisar del número inválido: {adv:?}"
    );
}
