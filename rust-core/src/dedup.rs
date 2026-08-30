//! Detección de fotogramas duplicados: huella de 256 bits.

use crate::img::{resize_rgb, Filter, Rgb};

fn set_bit(bits: &mut [u64; 4], idx: usize) {
    bits[idx / 64] |= 1u64 << (63 - (idx % 64));
}

/// Huella de 256 bits de una imagen RGB (ya aplanada sobre blanco si tenía
/// alfa), en tres bloques:
///
/// | bits      | qué mide                                   |
/// |-----------|--------------------------------------------|
/// | `[0..2]`  | 128: gradiente HORIZONTAL, miniatura 17×8  |
/// | `[2]`     |  64: gradiente VERTICAL, miniatura 8×9    |
/// | `[3]`     |  64: TONO absoluto, la media en termómetro |
///
/// El bloque de tono es el que arregla el fallo de la versión anterior, que
/// solo comparaba cada píxel con su vecino de la derecha. Ningún bit llevaba
/// tono absoluto, así que CUALQUIER imagen uniforme daba la huella cero:
/// negro, blanco y rojo eran indistinguibles entre sí y la distancia entre
/// negro y blanco era 0. Un plano de fundido a negro y otro de fundido a
/// blanco se fundían en el mismo fotograma, y el usuario solo veía el número
/// de repetidos.
///
/// La media se codifica en termómetro (nivel 0..63, un bit encendido por
/// nivel) y no en binario, para que la distancia de Hamming entre dos tonos
/// sea su diferencia real de nivel: con el umbral por defecto de 4, dos
/// planos separados por más de 16 valores de gris ya no se agrupan.
pub fn dhash(img: &Rgb) -> [u64; 4] {
    let mut bits = [0u64; 4];
    let mut idx = 0usize;

    // 1) gradiente horizontal: 8 filas × 16 comparaciones
    let h = resize_rgb(img, 17, 8, Filter::Lanczos3).to_gray();
    for row in 0..8 {
        for col in 0..16 {
            if h.data[row * 17 + col] > h.data[row * 17 + col + 1] {
                set_bit(&mut bits, idx);
            }
            idx += 1;
        }
    }

    // 2) gradiente vertical: 8 columnas × 8 comparaciones
    let v = resize_rgb(img, 8, 9, Filter::Lanczos3).to_gray();
    for col in 0..8 {
        for row in 0..8 {
            if v.data[row * 8 + col] > v.data[(row + 1) * 8 + col] {
                set_bit(&mut bits, idx);
            }
            idx += 1;
        }
    }

    // 3) tono absoluto
    let a = resize_rgb(img, 8, 8, Filter::Lanczos3).to_gray();
    let mean = a.data.iter().map(|&p| p as u32).sum::<u32>() / a.data.len() as u32;
    let level = (mean / 4).min(63) as usize;
    for n in 0..level {
        set_bit(&mut bits, idx + n);
    }

    bits
}

pub fn hamming(a: &[u64; 4], b: &[u64; 4]) -> u32 {
    a.iter().zip(b).map(|(&x, &y)| (x ^ y).count_ones()).sum()
}

/// Agrupa duplicados: devuelve (índices de representantes, rep_of paralelo).
/// Compara primero contra el último representante (los duplicados suelen ser
/// consecutivos), luego el resto.
pub fn find_duplicates(hashes: &[[u64; 4]], threshold: u32) -> (Vec<usize>, Vec<usize>) {
    let mut reps: Vec<([u64; 4], usize)> = Vec::new();
    let mut rep_indices = Vec::new();
    let mut rep_of = Vec::with_capacity(hashes.len());
    for (i, h) in hashes.iter().enumerate() {
        let mut m: Option<usize> = None;
        if let Some(&(last_h, last_i)) = reps.last() {
            if hamming(h, &last_h) <= threshold {
                m = Some(last_i);
            }
        }
        if m.is_none() {
            for &(rh, ridx) in reps.iter().rev().skip(1) {
                if hamming(h, &rh) <= threshold {
                    m = Some(ridx);
                    break;
                }
            }
        }
        match m {
            None => {
                reps.push((*h, i));
                rep_indices.push(i);
                rep_of.push(i);
            }
            Some(r) => rep_of.push(r),
        }
    }
    (rep_indices, rep_of)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_frames_group() {
        let a = Rgb::new(64, 48, [200, 100, 50]);
        let mut b = a.clone();
        b.data[0] = 201; // ruido mínimo
        let mut c = Rgb::new(64, 48, [10, 10, 10]);
        for y in 0..48 {
            for x in 0..32 {
                c.set_px(x, y, [240, 240, 240]);
            }
        }
        let hs = vec![dhash(&a), dhash(&b), dhash(&c), dhash(&a)];
        let (reps, rep_of) = find_duplicates(&hs, 4);
        assert_eq!(rep_of[1], 0);
        assert_eq!(rep_of[3], 0);
        assert!(reps.contains(&2));
    }

    #[test]
    fn flat_frames_of_different_tone_do_not_merge() {
        // El dHash solo horizontal daba [0,0,0,0] para cualquier imagen
        // uniforme, así que hamming(negro, blanco) era 0 y un fundido entero
        // colapsaba en un solo fotograma.
        let black = Rgb::new(64, 48, [0, 0, 0]);
        let white = Rgb::new(64, 48, [255, 255, 255]);
        let red = Rgb::new(64, 48, [255, 0, 0]);
        let (hb, hw, hr) = (dhash(&black), dhash(&white), dhash(&red));
        assert!(hamming(&hb, &hw) > 4, "negro vs blanco: {}", hamming(&hb, &hw));
        assert!(hamming(&hb, &hr) > 4, "negro vs rojo: {}", hamming(&hb, &hr));
        assert!(hamming(&hr, &hw) > 4, "rojo vs blanco: {}", hamming(&hr, &hw));

        let (reps, rep_of) = find_duplicates(&[hb, hw, hr], 4);
        assert_eq!(reps.len(), 3, "los tres planos son fotogramas distintos");
        assert_eq!(rep_of, vec![0, 1, 2]);
    }
}
