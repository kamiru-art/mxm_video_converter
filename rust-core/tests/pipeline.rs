//! Integración de punta a punta: generar hoja → simular escaneo → procesar.
//! Es el equivalente del test_pipeline.py de la app original, en Rust puro.

use mxm_core::cyanotype;
use mxm_core::geometry::{apply_h, invert_h, Rng, H3};
use mxm_core::img::{DynImg, Rgb};
use mxm_core::photo::FramePixels;
use mxm_core::scanproc::{self, process_scan, ScanOptions};
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
        FrameInput {
            w,
            h,
            rgba: Some(FramePixels::Rgba8(rgba)),
            has_alpha: false,
            orig_name: "f.png".into(),
            orig_file: None,
        },
        base,
    )
}

fn base_settings() -> Settings {
    Settings {
        registration_on: true,
        dpi: 150,
        cols: 2,
        rows: 2,
        marker_count: 8,
        project_name: "demo".into(),
        out_name: "demo".into(),
        marker_size_mm: 10.0,
        qr_size_mm: 14.0,
        ..Default::default()
    }
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
    let m: H3 = [c, -sn, 40.0, sn, c, 30.0, 0.000004, 0.000002, 1.0];
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
    for p in img.data.as_chunks::<3>().0 {
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
    for base in [
        [200u8, 60, 60],
        [60, 180, 60],
        [60, 60, 200],
        [180, 160, 40],
    ] {
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
    let out = process_scan(
        DynImg::U8(scan),
        "scan1.png",
        &layout,
        &ScanOptions::default(),
        &HashMap::new(),
    );
    assert_eq!(out.result["ok"], json!(true), "resultado: {}", out.result);
    assert_eq!(out.result["hoja_numero"], json!(1));
    assert!(
        out.result["marcadores"].as_i64().unwrap() >= 6,
        "{}",
        out.result
    );
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
        let expect: Vec<f64> = colors[idx]
            .iter()
            .map(|&c| 0.8 * c as f64 + 0.2 * 255.0)
            .collect();
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
    let out = process_scan(
        DynImg::U8(scan),
        "esp.png",
        &layout,
        &ScanOptions::default(),
        &HashMap::new(),
    );
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
    assert!(
        iph.is_object(),
        "el layout sin QR debe llevar ids_por_hoja: {iph}"
    );
    assert_ne!(iph["1"], iph["2"], "cada hoja debe tener IDs distintos");

    let scan = simulate_scan(&page2_img.unwrap(), 1.3, 21);
    let out = process_scan(
        DynImg::U8(scan),
        "s2.png",
        &layout,
        &ScanOptions::default(),
        &HashMap::new(),
    );
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
        adv.iter()
            .all(|a| !a.as_str().unwrap_or("").contains("discarded")),
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
    let opts = ScanOptions {
        mode: "auto".into(),
        ..Default::default()
    }; // el layout dice "cianotipia"
    let out = process_scan(
        DynImg::U8(scan),
        "cyan1.png",
        &layout,
        &opts,
        &HashMap::new(),
    );
    assert_eq!(out.result["ok"], json!(true), "resultado: {}", out.result);
    assert_eq!(out.frames.len(), 2, "{}", out.result);
    // el frame oscuro y el rojizo deben distinguirse en la copia azul:
    // más brillo original ⇒ más densidad ⇒ menos exposición ⇒ MÁS CLARO
    let f1 = out.frames.iter().find(|(l2, _)| l2 == "cy_001").unwrap();
    let f2 = out.frames.iter().find(|(l2, _)| l2 == "cy_002").unwrap();
    let m1 = mean_rgb(&f1.1.to_rgb8());
    let m2 = mean_rgb(&f2.1.to_rgb8());
    assert!(
        m1[0] > m2[0] + 10.0,
        "rojo claro {} vs oscuro {}",
        m1[0],
        m2[0]
    );
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
    let data16: Vec<u16> = scan8
        .data
        .iter()
        .map(|&v| (v as u16) << 8 | v as u16)
        .collect();
    let scan16 = DynImg::U16(mxm_core::img::Rgb16 {
        w: scan8.w,
        h: scan8.h,
        data: data16,
    });
    let out = process_scan(
        scan16,
        "s16.tif",
        &layout,
        &ScanOptions::default(),
        &HashMap::new(),
    );
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
    assert!(
        layout["marcadores"]["ids_por_hoja"].is_null(),
        "con QR no debe haber ids_por_hoja"
    );
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
    assert!(
        !auto.unidentified.is_empty(),
        "debe dejar los recortes sin identificar"
    );

    // 2. Con asignación manual a la hoja 2: recortes con sus etiquetas.
    let opts = ScanOptions {
        forced_sheet: Some(2),
        ..ScanOptions::default()
    };
    let out = process_scan(DynImg::U8(scan), "s2.png", &layout, &opts, &HashMap::new());
    assert_eq!(out.result["ok"], json!(true), "{}", out.result);
    assert_eq!(out.result["hoja_numero"], json!(2), "{}", out.result);
    let via = out.result["via"].as_str().unwrap();
    assert!(via.starts_with("assigned by hand"), "via = {via}");
    let mut labs: Vec<&str> = out.frames.iter().map(|(lab, _)| lab.as_str()).collect();
    labs.sort();
    assert_eq!(labs, vec!["demo_003", "demo_004"]);

    // 3. Un número de hoja inexistente no rompe: vuelve a lo automático.
    let opts = ScanOptions {
        forced_sheet: Some(99),
        ..ScanOptions::default()
    };
    let bad = process_scan(
        DynImg::U8(simulate_scan(
            &render_page(&s, &l, &[], &[], 1, true).image.unwrap(),
            1.3,
            34,
        )),
        "s1.png",
        &layout,
        &opts,
        &HashMap::new(),
    );
    let adv = bad.result["advertencias"].as_array().unwrap();
    assert!(
        adv.iter()
            .any(|a| a.as_str().unwrap_or("").contains("does not exist")),
        "debe avisar del número inválido: {adv:?}"
    );
}

/// La costura del alfa, que ningún test cubría. El núcleo decodifica los TIFF
/// y los PNG de 16 bits CONSERVANDO el canal alfa (codecs::decode_rgba8), y es
/// la composición de la hoja la que lo aplana con el color que eligió el
/// usuario. Antes se aplanaba sobre blanco al decodificar, así que el ajuste
/// "alpha over colour" no hacía nada justo para los formatos que decodifica el
/// núcleo, mientras que el mismo dibujo en PNG normal sí lo respetaba.
#[test]
fn transparent_frames_take_the_chosen_alpha_colour() {
    // RGBA a cero: del todo transparente, que es lo que decode_rgba8 entrega
    // ahora para una zona sin pintar de un TIFF
    let transparent = |w: usize, h: usize| FrameInput {
        w,
        h,
        rgba: Some(FramePixels::Rgba8(vec![0u8; w * h * 4])),
        has_alpha: true,
        orig_name: "f.tif".into(),
        orig_file: None,
    };
    let count = |img: &Rgb, c: [u8; 3]| {
        img.data
            .as_chunks::<3>()
            .0
            .iter()
            .filter(|p| p[0] == c[0] && p[1] == c[1] && p[2] == c[2])
            .count()
    };
    let labels: Vec<String> = (1..=4).map(|i| format!("demo_{i:03}")).collect();
    let sheet_with = |mode: &str| {
        let mut s = base_settings();
        s.alpha_mode = mode.into();
        s.alpha_bg_color = "#0000FF".into();
        let l = build_layout(&s, (16.0, 9.0)).unwrap();
        let frames: Vec<FrameInput> = (0..4).map(|_| transparent(320, 180)).collect();
        render_page(&s, &l, &frames, &labels, 1, true)
            .image
            .unwrap()
    };

    let blue = count(&sheet_with("color"), [0, 0, 255]);
    assert!(
        blue > 10_000,
        "el color elegido tiene que llegar a la hoja (azules: {blue})"
    );

    // y con el ajuste por defecto lo transparente sigue siendo papel
    let white = sheet_with("none");
    assert_eq!(
        count(&white, [0, 0, 255]),
        0,
        "sin el ajuste no debe aparecer azul"
    );
    assert!(
        count(&white, [255, 255, 255]) > 10_000,
        "lo transparente debe quedar blanco"
    );
}

/// Otra copia del mismo negativo: otra exposición (gamma sobre la cantidad de
/// azul), otro azul y otro papel. Parte de la copia estándar de la app.
fn reprint(std: &Rgb, gamma: f64, paper: [f64; 3], blue: [f64; 3]) -> Rgb {
    let (p0, b0) = (245.0, 23.0); // canal rojo del papel y el azul de simulate_print
    let mut out = std.clone();
    for p in out.data.as_chunks_mut::<3>().0 {
        let b = ((p0 - p[0] as f64) / (p0 - b0)).clamp(0.0, 1.0).powf(gamma);
        for c in 0..3 {
            p[c] = (paper[c] * (1.0 - b) + blue[c] * b).round() as u8;
        }
    }
    out
}

/// Ganancia y desplazamiento por canal de un escáner.
type Scanner = ([f64; 3], [f64; 3]);

fn scanner(img: &Rgb, g: [f64; 3], o: [f64; 3]) -> Rgb {
    let mut out = img.clone();
    for p in out.data.as_chunks_mut::<3>().0 {
        for c in 0..3 {
            p[c] = (p[c] as f64 * g[c] + o[c]).round().clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// Procesa el escaneo y devuelve el color medio de cada recorte; con
/// `matched`, lo normaliza antes con la tira (`Some(None)`: modo normal;
/// `Some(Some(r))`: cianotipia, hacia la tira `r` de la copia de referencia).
fn run_patch(
    scan: Rgb,
    layout: &serde_json::Value,
    matched: Option<Option<&[[f64; 3]]>>,
) -> (Vec<[f64; 3]>, serde_json::Value) {
    let out = process_scan(
        DynImg::U8(scan),
        "s.png",
        layout,
        &ScanOptions::default(),
        &HashMap::new(),
    );
    assert_eq!(out.result["ok"], json!(true), "{}", out.result);
    let curves = matched.map(|reference| {
        let m: Vec<[f64; 3]> =
            serde_json::from_value(out.result["parche_medido"].clone()).expect("tira sin medir");
        let n: Vec<i64> = serde_json::from_value(out.result["parche_niveles"].clone()).unwrap();
        scanproc::patch_curves(&m, &n, reference.is_some(), reference).expect("tira ilegible")
    });
    let mut v: Vec<_> = out
        .frames
        .into_iter()
        .map(|(l, mut f)| {
            if let Some(c) = &curves {
                scanproc::apply_level_curves(&mut f, c);
            }
            (l, mean_rgb(&f.to_rgb8()))
        })
        .collect();
    v.sort_by(|a, b| a.0.cmp(&b.0));
    (v.into_iter().map(|x| x.1).collect(), out.result)
}

fn dist(a: &[[f64; 3]], b: &[[f64; 3]]) -> f64 {
    let mut m: f64 = 0.0;
    for (x, y) in a.iter().zip(b) {
        for c in 0..3 {
            m = m.max((x[c] - y[c]).abs());
        }
    }
    m
}

/// Cianotipia con tira de grises: cada copia sale distinta (exposición,
/// azul, papel, viraje, escáner) y la tira la lleva a los colores de la copia
/// de referencia del lote, sin volverla gris.
#[test]
fn gray_strip_matches_prints_to_the_chosen_reference() {
    let mut s = base_settings();
    s.gray_patch_on = true;
    s.mode = "cianotipia".into();
    s.cyan_mirror = true;
    s.marker_size_mm = 12.0;
    s.qr_size_mm = 16.0;
    let l = build_layout(&s, (16.0, 9.0)).unwrap();
    let mut frames = Vec::new();
    for base in [[200u8, 60, 60], [60, 180, 60], [60, 60, 200], [40, 40, 40]] {
        frames.push(synth_frame(320, 180, base).0);
    }
    let labels: Vec<String> = (1..=4).map(|i| format!("d_{:03}", i)).collect();
    let page = render_page(&s, &l, &frames, &labels, 1, true);
    let mut rec = page.record.unwrap();
    rec["archivo_hoja"] = json!("d_p1.png");
    let layout = build_layout_json(&s, &l, &[rec], json!([]), json!({}), None);
    let neg = sheet::finish_page(&s, page.image.unwrap());
    let std = cyanotype::simulate_print(&neg.flip_horizontal(), None, Some(&s.cyan_ink), None);

    let paper = [245.0, 242.0, 230.0];
    let blue = [23.0, 49.0, 92.0];
    let ref_print = reprint(&std, 1.0, paper, blue);
    let flat = ([1.0, 1.0, 1.0], [0.0, 0.0, 0.0]);
    let cast = ([0.82, 0.78, 0.70], [28.0, 30.0, 22.0]);
    let cases: Vec<(&str, Rgb, Scanner)> = vec![
        (
            "misma copia, escáner con dominante",
            ref_print.clone(),
            cast,
        ),
        (
            "subexpuesta (gamma 1.6)",
            reprint(&std, 1.6, paper, blue),
            flat,
        ),
        (
            "sobreexpuesta (gamma 0.6), azul más oscuro",
            reprint(&std, 0.6, paper, [15.0, 35.0, 75.0]),
            flat,
        ),
        (
            "papel más cálido + subexpuesta + dominante",
            reprint(&std, 1.4, [240.0, 230.0, 205.0], blue),
            cast,
        ),
        (
            "virada con té",
            reprint(&std, 1.0, [235.0, 225.0, 200.0], [60.0, 55.0, 70.0]),
            flat,
        ),
    ];

    // la referencia: la copia que el usuario elige; normalizada contra sí
    // misma queda igual, y sigue azul (antes la tira forzaba el parche
    // oscuro a negro neutro)
    let (truth, rref) = run_patch(simulate_scan(&ref_print, 1.3, 7), &layout, None);
    let reference: Vec<[f64; 3]> = serde_json::from_value(rref["parche_medido"].clone()).unwrap();
    let (self_matched, _) = run_patch(
        simulate_scan(&ref_print, 1.3, 7),
        &layout,
        Some(Some(&reference)),
    );
    assert!(dist(&truth, &self_matched) < 0.5, "la referencia cambió");
    for p in &self_matched {
        assert!(p[2] > p[0] + 15.0, "la copia perdió el azul: {p:?}");
    }
    let mut under = None;
    for (name, img, (g, o)) in cases {
        let scan = || simulate_scan(&scanner(&img, g, o), 1.3, 7);
        let (raw, r) = run_patch(scan(), &layout, None);
        let (fixed, _) = run_patch(scan(), &layout, Some(Some(&reference)));
        let (d0, d1) = (dist(&raw, &truth), dist(&fixed, &truth));
        eprintln!("{name}: sin tira {d0:.1}, con tira {d1:.1}");
        assert!(
            d0 > 20.0,
            "{name}: el caso no difiere de la referencia ({d0:.1})"
        );
        assert!(
            d1 < 3.0,
            "{name}: tras la tira sigue a {d1:.1} niveles de la referencia"
        );
        if name.starts_with("subexpuesta") {
            under = Some((raw, r));
        }
    }
    // el usuario cambia de referencia a la copia subexpuesta: la primera
    // copia se recalcula hacia ella
    let (under_raw, ur) = under.unwrap();
    let new_ref: Vec<[f64; 3]> = serde_json::from_value(ur["parche_medido"].clone()).unwrap();
    let (moved, _) = run_patch(
        simulate_scan(&ref_print, 1.3, 7),
        &layout,
        Some(Some(&new_ref)),
    );
    let d = dist(&moved, &under_raw);
    eprintln!("referencia cambiada a la subexpuesta: {d:.1}");
    assert!(d < 3.0, "con la nueva referencia queda a {d:.1} niveles");

    // modo normal: lo impreso es conocido y el escáner con dominante vuelve
    // a los colores digitales
    let mut s = base_settings();
    s.gray_patch_on = true;
    let l = build_layout(&s, (16.0, 9.0)).unwrap();
    let page = render_page(&s, &l, &frames, &labels, 1, true);
    let mut rec = page.record.unwrap();
    rec["archivo_hoja"] = json!("d_p1.png");
    let layout = build_layout_json(&s, &l, &[rec], json!([]), json!({}), None);
    let img = page.image.unwrap();
    let (digital, _) = run_patch(simulate_scan(&img, 1.3, 7), &layout, None);
    let (raw, _) = run_patch(
        simulate_scan(&scanner(&img, cast.0, cast.1), 1.3, 7),
        &layout,
        None,
    );
    let (fixed, _) = run_patch(
        simulate_scan(&scanner(&img, cast.0, cast.1), 1.3, 7),
        &layout,
        Some(None),
    );
    let (d0, d1) = (dist(&raw, &digital), dist(&fixed, &digital));
    eprintln!("modo normal, escáner con dominante: sin tira {d0:.1}, con tira {d1:.1}");
    assert!(d0 > 20.0 && d1 < 3.0, "modo normal: {d0:.1} → {d1:.1}");
}

/// Bleed negativo (recorte que sale del panel, una técnica artística): el
/// recorte crece por igual en cada lado, la hoja se sigue identificando con
/// el QR aunque los recortes se solapen con los QR vecinos, y el centro del
/// recorte sigue siendo el fotograma. Lo que cae fuera de la hoja enderezada
/// sale del color de relleno, sin hacer fallar el escaneo.
#[test]
fn negative_bleed_enlarges_the_crop_beyond_the_frame() {
    let s = base_settings();
    let l = build_layout(&s, (16.0, 9.0)).unwrap();
    let mut frames = Vec::new();
    let mut colors = Vec::new();
    for base in [
        [200u8, 60, 60],
        [60, 180, 60],
        [60, 60, 200],
        [180, 160, 40],
    ] {
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
    let scan = simulate_scan(&img, 1.4, 99);

    let run = |bleed: f64| {
        let opts = ScanOptions {
            bleed,
            ..ScanOptions::default()
        };
        process_scan(
            DynImg::U8(scan.clone()),
            "scan1.png",
            &layout,
            &opts,
            &HashMap::new(),
        )
    };
    let flat = run(0.0);
    assert_eq!(flat.frames.len(), 4, "{}", flat.result);
    let (fw, fh) = flat.frames[0].1.size();
    // -100 % por lado: el recorte triplica cada lado y sale de la hoja
    for bleed in [-0.3, -1.0] {
        let out = run(bleed);
        assert_eq!(
            out.result["ok"],
            json!(true),
            "bleed {bleed}: {}",
            out.result
        );
        assert_eq!(out.result["hoja_numero"], json!(1));
        assert_eq!(out.frames.len(), 4, "bleed {bleed}: {}", out.result);
        for (label, crop) in &out.frames {
            let (w, h) = crop.size();
            let (ew, eh) = (
                fw as f64 * (1.0 - 2.0 * bleed),
                fh as f64 * (1.0 - 2.0 * bleed),
            );
            assert!(
                (w as f64 - ew).abs() <= 2.0 && (h as f64 - eh).abs() <= 2.0,
                "{label} bleed {bleed}: {w}×{h}, expected ≈{ew}×{eh}"
            );
            // el centro (la mitad del fotograma original) conserva su color
            let rgb = crop.to_rgb8();
            let (cw, ch) = (fw / 2, fh / 2);
            let (x0, y0) = ((w - cw) / 2, (h - ch) / 2);
            let mut center = Rgb::new(cw, ch, [0, 0, 0]);
            for y in 0..ch {
                for x in 0..cw {
                    center.set_px(x, y, rgb.px(x0 + x, y0 + y));
                }
            }
            let idx: usize = label[5..8].parse::<usize>().unwrap() - 1;
            let m = mean_rgb(&center);
            for c in 0..3 {
                let expect = 0.8 * colors[idx][c] as f64 + 0.2 * 255.0;
                assert!(
                    (m[c] - expect).abs() < 30.0,
                    "{label} bleed {bleed} canal {c}: {} vs {expect}",
                    m[c]
                );
            }
        }
    }
}

/// El receptor de `process_scan_with` recibe los mismos recortes, en el mismo
/// orden, que `process_scan` guarda en su salida.
#[test]
fn streaming_sink_gets_the_same_crops() {
    let s = base_settings();
    let l = build_layout(&s, (16.0, 9.0)).unwrap();
    let frames: Vec<FrameInput> = (0..4)
        .map(|i| synth_frame(320, 180, [40 + 50 * i as u8, 90, 150]).0)
        .collect();
    let labels: Vec<String> = (1..=4).map(|i| format!("demo_{:03}", i)).collect();
    let page = render_page(&s, &l, &frames, &labels, 1, true);
    let img = page.image.unwrap();
    let mut record = page.record.unwrap();
    record["archivo_hoja"] = json!("demo_p1.png");
    let layout = build_layout_json(&s, &l, &[record], json!([]), json!({}), None);
    let scan = simulate_scan(&img, 1.2, 7);
    let opts = ScanOptions {
        bleed: -0.2,
        ..ScanOptions::default()
    };
    let whole = process_scan(
        DynImg::U8(scan.clone()),
        "s.png",
        &layout,
        &opts,
        &HashMap::new(),
    );
    let mut got: Vec<(String, (usize, usize))> = Vec::new();
    let streamed = scanproc::process_scan_with(
        DynImg::U8(scan),
        "s.png",
        &layout,
        &opts,
        &HashMap::new(),
        &mut |kind, label, crop| {
            assert_eq!(kind, scanproc::CropKind::Frame);
            got.push((label, crop.size()));
        },
    );
    assert!(streamed.frames.is_empty());
    assert_eq!(streamed.result["ok"], json!(true), "{}", streamed.result);
    let want: Vec<(String, (usize, usize))> = whole
        .frames
        .iter()
        .map(|(l, c)| (l.clone(), c.size()))
        .collect();
    assert_eq!(got, want);
}

/// Píxeles casi negros de un recorte (lo que el enderezado deja donde el
/// escáner no llegó, y los marcadores y el QR impresos).
fn dark_pixels(img: &DynImg) -> usize {
    img.to_rgb8()
        .data
        .as_chunks::<3>()
        .0
        .iter()
        .filter(|p| p.iter().all(|&c| c < 40))
        .count()
}

/// Bleed negativo con relleno: en un escaneo al que le falta una franja de
/// la hoja, el relleno quita el negro de lo no escaneado en los tres modos,
/// y borrar los marcadores quita además buena parte de lo oscuro impreso.
#[test]
fn negative_bleed_fill_modes_and_erased_markers() {
    use mxm_core::bleedfill::FillMode;
    let s = base_settings();
    let l = build_layout(&s, (16.0, 9.0)).unwrap();
    let frames: Vec<FrameInput> = [
        [200u8, 60, 60],
        [60, 180, 60],
        [60, 60, 200],
        [180, 160, 40],
    ]
    .iter()
    .map(|&b| synth_frame(320, 180, b).0)
    .collect();
    let labels: Vec<String> = (1..=4).map(|i| format!("demo_{:03}", i)).collect();
    let page = render_page(&s, &l, &frames, &labels, 1, true);
    let img = page.image.unwrap();
    let mut record = page.record.unwrap();
    record["archivo_hoja"] = json!("demo_p1.png");
    let layout = build_layout_json(&s, &l, &[record], json!([]), json!({}), None);
    let full = simulate_scan(&img, 1.4, 99);
    // el escáner no llegó al último 30 % de la derecha del escaneo
    let keep = full.w * 70 / 100;
    let scan = full.crop(0, 0, keep, full.h);

    let run = |scan: &Rgb, fill: FillMode, erase: bool| {
        let opts = ScanOptions {
            bleed: -1.0,
            fill,
            erase_markers: erase,
            ..ScanOptions::default()
        };
        let out = process_scan(
            DynImg::U8(scan.clone()),
            "cut.png",
            &layout,
            &opts,
            &HashMap::new(),
        );
        assert_eq!(out.frames.len(), 4, "{fill:?}: {}", out.result);
        let dark: usize = out.frames.iter().map(|(_, c)| dark_pixels(c)).sum();
        (out, dark)
    };
    let (legacy, dark_legacy) = run(&scan, FillMode::Legacy, false);
    let (_, dark_legacy_full) = run(&full, FillMode::Legacy, false);
    // sin relleno, la franja no escaneada sale negra en los recortes
    assert!(
        dark_legacy > dark_legacy_full + 100_000,
        "cut {dark_legacy} vs whole {dark_legacy_full}"
    );
    let sizes: Vec<_> = legacy.frames.iter().map(|(_, c)| c.size()).collect();
    for mode in [FillMode::Paper, FillMode::Mirror, FillMode::Tile] {
        let (out, dark) = run(&scan, mode, false);
        let (_, dark_full) = run(&full, mode, false);
        // el relleno no cambia el tamaño de los recortes
        let got: Vec<_> = out.frames.iter().map(|(_, c)| c.size()).collect();
        assert_eq!(got, sizes, "{mode:?}");
        // con relleno, lo oscuro es solo lo impreso (marcadores, QR, texto):
        // no más que en el escaneo entero con el mismo modo
        assert!(
            dark as f64 <= dark_full as f64 * 1.05 + 200.0,
            "{mode:?}: cut {dark} dark px vs whole {dark_full}"
        );
    }
    let (_, dark_paper) = run(&full, FillMode::Paper, false);
    let (_, dark_erased) = run(&full, FillMode::Paper, true);
    assert!(
        (dark_erased as f64) < dark_paper as f64 * 0.8,
        "erased markers: {dark_erased} dark px vs {dark_paper} with them"
    );
}

#[test]
fn custom_bold_otf_labels_still_scan_back() {
    // Etiquetas y número de hoja en un OTF CFF en negrita, grandes, con ñ y
    // con nombres largos que obligan a achicar y a recortar con «…» (que la
    // fuente tiene o toma de DejaVu). El layout se mide con la misma fuente,
    // y el escaneo tiene que devolver los cuatro fotogramas por su nombre.
    static OTF: &[u8] = include_bytes!("../assets/test/SourceSans3-Bold.otf");
    let mut s = base_settings();
    s.font_size_pt = 14.0;
    s.page_num_size_pt = 28.0;
    s.page_num_prefix = "Hoja ".into();
    s.label_font = "custom:SourceSans3-Bold.otf".into();
    let labels: Vec<String> = vec![
        "toma_ñandú_001".into(),
        "toma_ñandú_002".into(),
        "una_etiqueta_larguísima_para_esta_celda_003".into(),
        "toma_ñandú_004".into(),
    ];
    let frames: Vec<FrameInput> = [
        [200u8, 60, 60],
        [60, 180, 60],
        [60, 60, 200],
        [180, 160, 40],
    ]
    .into_iter()
    .map(|b| synth_frame(320, 180, b).0)
    .collect();

    let dimg = {
        let l = build_layout(&s, (16.0, 9.0)).unwrap();
        render_page(&s, &l, &frames, &labels, 7, true)
            .image
            .unwrap()
    };
    let (l, page) = mxm_core::text::with_font(OTF, || {
        let l = build_layout(&s, (16.0, 9.0)).unwrap();
        let page = render_page(&s, &l, &frames, &labels, 7, true);
        (l, page)
    })
    .expect("OTF válido");
    let img = page.image.unwrap();
    assert_eq!((img.w, img.h), (dimg.w, dimg.h));
    assert_ne!(img.data, dimg.data, "la hoja salió igual que en DejaVu");

    let mut record = page.record.unwrap();
    record["archivo_hoja"] = json!("demo_p7.png");
    let layout = build_layout_json(&s, &l, &[record], json!([]), json!({}), None);
    assert_eq!(
        layout["ajustes"]["label_font"],
        json!("custom:SourceSans3-Bold.otf"),
        "el snapshot debe recordar la fuente"
    );
    // el escaneo no necesita la fuente: todo va en el layout
    let scan = simulate_scan(&img, 1.25, 7);
    let out = process_scan(
        DynImg::U8(scan),
        "scan7.png",
        &layout,
        &ScanOptions::default(),
        &HashMap::new(),
    );
    assert_eq!(out.result["ok"], json!(true), "resultado: {}", out.result);
    assert_eq!(out.result["hoja_numero"], json!(7), "{}", out.result);
    let mut got: Vec<&str> = out.frames.iter().map(|(n, _)| n.as_str()).collect();
    got.sort();
    let mut want: Vec<&str> = labels.iter().map(|s| s.as_str()).collect();
    want.sort();
    assert_eq!(got, want);

    // un prefijo con signos que la fuente no tiene: la hoja sale (en DejaVu
    // esos dos) y el núcleo dice cuáles fueron, para el aviso
    use mxm_core::text::{missing_chars, take_fallbacks, with_font};
    s.page_num_prefix = "✂ Hoja ☂ ñ ".into();
    assert_eq!(
        missing_chars(OTF, &s.page_num_prefix).unwrap(),
        vec!['✂', '☂']
    );
    let fell = with_font(OTF, || {
        render_page(&s, &l, &frames, &labels, 7, true);
        take_fallbacks()
    })
    .unwrap();
    assert_eq!(fell, vec!['✂', '☂']);
}
