//! Detección de fotogramas duplicados (dHash 16×16 = 256 bits).
//! Port del módulo original: mismos umbrales, mismo orden de comparación.

use crate::img::{resize_rgb, Filter, Rgb};

pub const HASH_SIZE: usize = 16;

/// dHash de una imagen RGB (ya aplanada sobre blanco si tenía alfa):
/// gradiente horizontal binarizado sobre una miniatura 17×16 en grises.
pub fn dhash(img: &Rgb) -> [u64; 4] {
    let small = resize_rgb(img, HASH_SIZE + 1, HASH_SIZE, Filter::Lanczos3);
    let g = small.to_gray();
    let w = HASH_SIZE + 1;
    let mut bits = [0u64; 4];
    let mut idx = 0usize;
    for row in 0..HASH_SIZE {
        for col in 0..HASH_SIZE {
            let left = g.data[row * w + col];
            let right = g.data[row * w + col + 1];
            if left > right {
                bits[idx / 64] |= 1u64 << (63 - (idx % 64));
            }
            idx += 1;
        }
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
}
