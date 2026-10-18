//! Calibración de cianotipia de punta a punta: carta EDN → copia azul
//! simulada con un proceso físico → escaneo torcido → curva. Se mide la
//! linealidad que la curva consigue sobre ese mismo proceso.
//!
//! Lo que puede fallar, escrito antes que el código:
//!  1. la carta de la segunda pasada se imprime con la curva redondeada a
//!     densidades enteras y la composición usa la continua (½ nivel de error
//!     por parche, visible en las sombras empinadas);
//!  2. la respuesta de la segunda pasada queda indexada por número de parche
//!     y no por la densidad impresa, y el soft-proof simula mal;
//!  3. la curva final se compone al revés (C2∘C1 en vez de C1∘C2);
//!  4. se mide con una curva previa distinta de la de la impresión (error
//!     del usuario: la interfaz lo hace improbable, aquí no se detecta);
//!  5. la curva previa desplaza también los marcadores y la carta no alinea;
//!  6. una curva previa de largo distinto de 256 o decreciente rompe la
//!     composición en vez de rechazarse;
//!  7. copias de otro papel o dpi se promedian como si fueran la misma;
//!  8. una copia invertida (se escaneó la película) o plana contamina el
//!     promedio en vez de rechazarse diciendo cuál es;
//!  9. un parche que no se midió en una copia cuenta como cero;
//! 10. el orden de los archivos cambia la curva.

use mxm_core::calib::{analyze_cyanotype_chart, prior_curve, render_cyanotype_chart};
use mxm_core::geometry::{apply_h, invert_h, Rng, H3};
use mxm_core::img::{DynImg, Rgb};
use serde_json::{json, Value};

const PAPER: &str = "A4";
const DPI: u32 = 150;

fn s2l(v: f64) -> f64 {
    let v = v / 255.0;
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}
fn l2s(v: f64) -> f64 {
    let v = v.clamp(0.0, 1.0);
    255.0
        * if v <= 0.0031308 {
            12.92 * v
        } else {
            1.055 * v.powf(1.0 / 2.4) - 0.055
        }
}

/// Copia azul de un azul de Prusia sobre papel, de densidad relativa `dp`
/// (0 = papel, 1 = Dmax), en sRGB.
fn prussian(dp: f64) -> [f64; 3] {
    let (paper, blue) = ([245.0, 242.0, 230.0], [23.0, 49.0, 92.0]);
    let mut out = [0.0; 3];
    for c in 0..3 {
        let k = (s2l(paper[c]) / s2l(blue[c])).log10();
        out[c] = l2s(s2l(paper[c]) * 10f64.powf(-k * dp));
    }
    out
}

/// Un proceso de cianotipia duro: la tinta del negativo en log de exposición
/// y una sigmoide asimétrica, así que sólo un 40 % de las densidades da
/// tonos distintos y hay mesetas en ambos extremos.
fn print_density(d: f64) -> f64 {
    let dn = 2.2 * (d / 255.0).clamp(0.0, 1.0).powf(0.7);
    let z = (0.8 - dn) / 0.12;
    (1.0 / (1.0 + (-z).exp())).powf(1.8)
}

/// Expone la carta (ya leída al derecho) sobre papel recubierto. Cada copia
/// tiene su propia emulsión despareja (una ondulación de ±5 % con su propia
/// fase y celdas de ~3 mm de ±2 %): `seed` es la copia.
fn expose(neg: &Rgb, seed: u64) -> Rgb {
    let mut rng = Rng::new(seed);
    let (fx, fy) = (rng.jitter() * 6.0, rng.jitter() * 6.0);
    let cell = (DPI as f64 * 3.0 / 25.4) as usize;
    let mut out = Rgb::new(neg.w, neg.h, [255, 255, 255]);
    let (w, h) = (neg.w as f64, neg.h as f64);
    for y in 0..neg.h {
        for x in 0..neg.w {
            let p = neg.px(x, y);
            let d = 255.0 - (0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64);
            let hsh = (seed ^ ((x / cell) as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
                ^ ((y / cell) as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
            let cellv =
                (hsh.wrapping_mul(0x1656_67B1_9E37_79F9) >> 11) as f64 / (1u64 << 53) as f64 * 2.0
                    - 1.0;
            let coat = 1.0
                + 0.05 * ((x as f64 / w * 5.3 + fx).sin() * (y as f64 / h * 3.1 + fy).cos())
                + 0.02 * cellv;
            let c = prussian((print_density(d) * coat).clamp(0.0, 1.2));
            out.set_px(
                x,
                y,
                [c[0].round() as u8, c[1].round() as u8, c[2].round() as u8],
            );
        }
    }
    out
}

/// Escaneo torcido: rotación de ~1,5°, algo de perspectiva, fondo gris del
/// escáner y ruido de ±3 niveles.
fn scan(print: &Rgb, seed: u64) -> DynImg {
    let (w, h) = (print.w as f64, print.h as f64);
    let (out_w, out_h) = ((w * 1.08) as usize, (h * 1.08) as usize);
    let ang: f64 = 0.026;
    let m: H3 = [
        ang.cos(),
        -ang.sin(),
        60.0,
        ang.sin(),
        ang.cos(),
        25.0,
        0.000003,
        0.000002,
        1.0,
    ];
    let minv = invert_h(&m).unwrap();
    let mut rng = Rng::new(seed ^ 0xABCD);
    let mut out = Rgb::new(out_w, out_h, [200, 200, 196]);
    for y in 0..out_h {
        for x in 0..out_w {
            let p = apply_h(&minv, (x as f64, y as f64));
            if p.0 < 0.0 || p.1 < 0.0 || p.0 >= w - 1.0 || p.1 >= h - 1.0 {
                continue;
            }
            let (x0, y0) = (p.0.floor() as usize, p.1.floor() as usize);
            let (tx, ty) = (p.0 - x0 as f64, p.1 - y0 as f64);
            let mut px = [0u8; 3];
            for c in 0..3 {
                let v = print.px(x0, y0)[c] as f64 * (1.0 - tx) * (1.0 - ty)
                    + print.px(x0 + 1, y0)[c] as f64 * tx * (1.0 - ty)
                    + print.px(x0, y0 + 1)[c] as f64 * (1.0 - tx) * ty
                    + print.px(x0 + 1, y0 + 1)[c] as f64 * tx * ty;
                px[c] = (v + rng.jitter() * 6.0).round().clamp(0.0, 255.0) as u8;
            }
            out.set_px(x, y, px);
        }
    }
    DynImg::U8(out)
}

/// La carta tal como la ve el papel (contacto: espejada en la película, al
/// derecho sobre el papel), impresa con `prior` si es la segunda pasada.
fn chart_on_paper(prior: Option<&[f64]>) -> Rgb {
    render_cyanotype_chart(PAPER, DPI, "#000000", prior).flip_horizontal()
}

fn print_and_scan(prior: Option<&[f64]>, copy: u64) -> DynImg {
    scan(&expose(&chart_on_paper(prior), copy), copy)
}

fn lut_of(v: &Value) -> Vec<f64> {
    v["lut"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect()
}

/// Linealidad que la curva consigue sobre el proceso sin ruido: el tono de
/// la copia (luma) para cada gris del positivo, contra la recta entre sus
/// extremos. Devuelve (error máximo, RMS) en % del rango.
fn linearity(lut: &[f64]) -> (f64, f64) {
    let tone: Vec<f64> = lut
        .iter()
        .map(|&d| {
            let c = prussian(print_density(d));
            0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
        })
        .collect();
    let (t0, t1) = (tone[0], tone[255]);
    let range = (t1 - t0).abs();
    let errs: Vec<f64> = (0..256)
        .map(|g| (tone[g] - (t0 + (t1 - t0) * g as f64 / 255.0)) / range * 100.0)
        .collect();
    let max = errs.iter().fold(0.0f64, |a, e| a.max(e.abs()));
    let rms = (errs.iter().map(|e| e * e).sum::<f64>() / 256.0).sqrt();
    (max, rms)
}

fn analyze(scans: Vec<DynImg>, prior: Option<&[f64]>) -> Result<Value, String> {
    analyze_cyanotype_chart(
        scans.into_iter().map(Ok),
        PAPER,
        DPI,
        Some("#000000"),
        prior,
    )
}

fn write_artifact(name: &str, v: &Value) {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../artifacts/calibration");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(name),
        serde_json::to_string_pretty(v).unwrap() + "\n",
    )
    .unwrap();
}

#[test]
fn cyanotype_curve_averaging_and_second_pass() {
    let unc = linearity(&(0..256).map(|i| i as f64).collect::<Vec<_>>());

    // Primera pasada: una copia, y tres copias de emulsión distinta.
    let one = analyze(vec![print_and_scan(None, 11)], None).unwrap();
    let three_scans = vec![
        print_and_scan(None, 11),
        print_and_scan(None, 22),
        print_and_scan(None, 33),
    ];
    let three = analyze(three_scans, None).unwrap();
    assert_eq!(three["escaneos"], 3);
    assert_eq!(three["pasada"], 1);
    let (l_one, l_three) = (linearity(&lut_of(&one)), linearity(&lut_of(&three)));

    // 10. el orden de los archivos no cambia ni un bit
    let reversed = analyze(
        vec![
            print_and_scan(None, 33),
            print_and_scan(None, 22),
            print_and_scan(None, 11),
        ],
        None,
    )
    .unwrap();
    assert_eq!(
        lut_of(&reversed),
        lut_of(&three),
        "el orden cambió la curva"
    );

    // Segunda pasada: la carta impresa con la curva de las tres copias.
    let c1 = lut_of(&three);
    let second = analyze(
        vec![print_and_scan(Some(&c1), 44), print_and_scan(Some(&c1), 55)],
        Some(&c1),
    )
    .unwrap();
    assert_eq!(second["pasada"], 2);
    let l_second = linearity(&lut_of(&second));

    // 2. la respuesta va por la densidad impresa: la abscisa de cada uno de
    //    los 256 parches es c1 de ese parche, no su número
    let dens: Vec<f64> = second["respuesta"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p[0].as_f64().unwrap())
        .collect();
    assert_eq!(dens.len(), 256);
    for (i, d) in dens.iter().enumerate() {
        assert!(
            (d - c1[i]).abs() < 1e-9,
            "parche {i}: densidad {d}, curva previa {}",
            c1[i]
        );
    }

    // Sin curva este proceso se desvía un 62 %; la curva lo endereza.
    assert!(l_one.0 < 4.0, "una copia: {l_one:?}");
    // Promediar tres copias de emulsión distinta no lo empeora.
    assert!(
        l_three.0 <= l_one.0 + 0.1 && l_three.1 <= l_one.1 + 0.05,
        "{l_three:?} vs {l_one:?}"
    );
    // La segunda pasada concentra los parches donde la química responde, y
    // corrige lo que la primera curva dejó: al menos un 40 % menos de RMS.
    assert!(
        l_second.0 < l_three.0 && l_second.1 < 0.6 * l_three.1,
        "{l_second:?} vs {l_three:?}"
    );

    eprintln!(
        "linealidad (máx %, RMS %): sin curva {unc:.2?} · 1 copia {l_one:.2?} · 3 copias {l_three:.2?} · 2.ª pasada {l_second:.2?}"
    );
    write_artifact(
        "cyanotype-curve.json",
        &json!({
            "scenario": "EDN 256 chart, hard process (~40 % useful densities), uneven coating per print, scanned crooked; A4 at 150 dpi",
            "linearity_pct": {
                "no_curve": {"max": unc.0, "rms": unc.1},
                "one_print": {"max": l_one.0, "rms": l_one.1},
                "three_prints": {"max": l_three.0, "rms": l_three.1},
                "second_pass": {"max": l_second.0, "rms": l_second.1},
            },
            "lut_one_print": lut_of(&one),
            "lut_three_prints": lut_of(&three),
            "lut_second_pass": lut_of(&second),
            "notes_three_prints": three["notas"],
        }),
    );
}

#[test]
fn cyanotype_chart_rejects_bad_inputs_by_name() {
    // 8. la segunda de tres "copias" es la película escaneada
    let film = DynImg::U8(render_cyanotype_chart(PAPER, DPI, "#000000", None));
    let e = analyze(
        vec![print_and_scan(None, 11), film, print_and_scan(None, 33)],
        None,
    )
    .unwrap_err();
    assert!(
        e.starts_with("Scan 2 of 3: ") && e.contains("INVERTED"),
        "{e}"
    );

    // 6. curvas previas que no salieron del análisis
    assert!(prior_curve(&[0.0; 255]).unwrap_err().contains("256 points"));
    let falling: Vec<f64> = (0..256).map(|i| 255.0 - i as f64).collect();
    assert!(prior_curve(&falling)
        .unwrap_err()
        .contains("not increasing"));
    let mut nan: Vec<f64> = (0..256).map(|i| i as f64).collect();
    nan[7] = f64::NAN;
    assert!(prior_curve(&nan).is_err());

    // 5. con una curva previa los marcadores siguen siendo los de la carta
    let squash: Vec<f64> = (0..256).map(|i| 40.0 + i as f64 * 0.5).collect();
    let (plain, curved) = (chart_on_paper(None), chart_on_paper(Some(&squash)));
    let m = (DPI as f64 * 15.0 / 25.4) as usize; // la esquina, con su marcador
    for y in 0..m {
        for x in 0..m {
            assert_eq!(
                plain.px(x, y),
                curved.px(x, y),
                "marcador tocado en ({x},{y})"
            );
        }
    }
}
