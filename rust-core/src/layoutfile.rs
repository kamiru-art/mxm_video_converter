//! Lectura del layout.json (v2, con conversión desde v1 de la app antigua).
//! Los proyectos viejos se siguen pudiendo procesar sin convertirlos a mano.

use serde_json::{json, Value};

const V1_ARUCO_SIZE_PX: i64 = 100;
const V1_ARUCO_MARGIN_PX: i64 = 40;

/// Normaliza un layout (v1 o v2) al esquema v2.
pub fn normalize(data: Value) -> Value {
    if data.get("version").and_then(|v| v.as_i64()).unwrap_or(1) >= 2 {
        return data;
    }
    from_v1(data)
}

fn from_v1(data: Value) -> Value {
    let lienzo = data.get("lienzo").cloned().unwrap_or(json!({}));
    let w = lienzo.get("ancho_px").and_then(|v| v.as_i64()).unwrap_or(2480);
    let h = lienzo.get("alto_px").and_then(|v| v.as_i64()).unwrap_or(3508);
    let (m, s) = (V1_ARUCO_MARGIN_PX, V1_ARUCO_SIZE_PX);
    let bboxes = json!({
        "0": [m, m, m + s, m + s],
        "1": [w - m - s, m, w - m, m + s],
        "2": [w - m - s, h - m - s, w - m, h - m],
        "3": [m, h - m - s, m + s, h - m],
    });
    let mut hojas = Vec::new();
    if let Some(arr) = data.get("hojas").and_then(|v| v.as_array()) {
        for (i, hoja) in arr.iter().enumerate() {
            let mut frames = serde_json::Map::new();
            if let Some(fs) = hoja.get("frames").and_then(|v| v.as_object()) {
                for (nombre, info) in fs {
                    frames.insert(
                        nombre.clone(),
                        json!({
                            "bbox": info.get("bbox"),
                            "celda": Value::Null,
                            "archivo_original": info.get("archivo_original").cloned()
                                .unwrap_or(Value::String(nombre.clone())),
                            "orig_px": Value::Null,
                            "etiqueta": nombre,
                        }),
                    );
                }
            }
            let mut qrs = serde_json::Map::new();
            if let Some(qs) = hoja.get("qrs").and_then(|v| v.as_object()) {
                for (nombre, info) in qs {
                    qrs.insert(
                        nombre.clone(),
                        json!({
                            "bbox": info.get("bbox"),
                            "celda": Value::Null,
                            "texto": nombre, // v1 codificaba solo el nombre
                        }),
                    );
                }
            }
            hojas.push(json!({
                "numero": i + 1,
                "archivo_hoja": hoja.get("archivo_hoja").cloned()
                    .unwrap_or(Value::String(format!("hoja_{:03}.tif", i + 1))),
                "frames": frames,
                "qrs": qrs,
            }));
        }
    }
    json!({
        "version": 2,
        "app": "mxm-v1",
        "proyecto": "",
        "modo": "normal",
        "espejado": false,
        "lienzo": {
            "ancho_px": w,
            "alto_px": h,
            "dpi": lienzo.get("ppi").and_then(|v| v.as_i64()).unwrap_or(300),
            "orientacion": lienzo.get("orientacion").cloned()
                .unwrap_or(Value::String("portrait".into())),
        },
        "marcadores": {
            "dict": "DICT_4X4_50",
            "cantidad": 4,
            "lado_px": s,
            "bboxes": bboxes,
        },
        "parche_grises": Value::Null,
        "hojas": hojas,
        "timeline": [],
        "video": {},
        "originales_dir": Value::Null,
    })
}

pub fn sheet_by_number(layout: &Value, numero: i64) -> Option<&Value> {
    layout.get("hojas")?.as_array()?.iter().find(|h| {
        h.get("numero").and_then(|n| n.as_i64()) == Some(numero)
    })
}

pub fn bbox_of(v: &Value) -> Option<[f64; 4]> {
    let arr = v.as_array()?;
    if arr.len() != 4 {
        return None;
    }
    let mut out = [0.0; 4];
    for (i, x) in arr.iter().enumerate() {
        out[i] = x.as_f64()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_converts() {
        let v1 = json!({
            "lienzo": {"ancho_px": 2480, "alto_px": 3508, "ppi": 300},
            "hojas": [{"archivo_hoja": "h.tif",
                       "frames": {"a": {"bbox": [1, 2, 3, 4]}},
                       "qrs": {"a": {"bbox": [5, 6, 7, 8]}}}],
        });
        let v2 = normalize(v1);
        assert_eq!(v2["version"], 2);
        assert_eq!(v2["marcadores"]["cantidad"], 4);
        assert_eq!(v2["hojas"][0]["numero"], 1);
        assert_eq!(v2["hojas"][0]["frames"]["a"]["bbox"], json!([1, 2, 3, 4]));
        assert!(sheet_by_number(&v2, 1).is_some());
    }
}
