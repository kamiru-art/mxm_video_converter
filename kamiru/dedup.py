"""Detección de fotogramas duplicados (hash perceptual).

En animación es común que un mismo dibujo se sostenga varios fotogramas
("held frames") o se repita en ciclos. Pintar dos veces el mismo dibujo es
tiempo y papel perdidos: este módulo agrupa los fotogramas visualmente
idénticos para imprimir/pintar SOLO uno por grupo, y el layout.json guarda la
correspondencia para que, al reconstruir el video, el fotograma pintado se
reutilice en todas sus apariciones.

Se usa un dHash (hash de diferencias) de 16×16 = 256 bits calculado con
Pillow: sin dependencias extra, rápido y robusto frente al ruido de
compresión del video.
"""

from __future__ import annotations

from PIL import Image

HASH_SIZE = 16  # 16x16 → 256 bits


def dhash(path, hash_size: int = HASH_SIZE) -> int:
    """dHash de una imagen: gradiente horizontal binarizado."""
    with Image.open(path) as im:
        img = im.convert("L").resize((hash_size + 1, hash_size), Image.LANCZOS)
    px = list(img.getdata())
    bits = 0
    w = hash_size + 1
    for row in range(hash_size):
        for col in range(hash_size):
            left = px[row * w + col]
            right = px[row * w + col + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return bits


def hamming(a: int, b: int) -> int:
    """Distancia de Hamming entre dos hashes."""
    return bin(a ^ b).count("1")


def find_duplicates(paths, threshold: int = 4, progress_cb=None,
                    cancel_check=None):
    """Agrupa fotogramas duplicados.

    Args:
        paths: lista de rutas de fotogramas EN ORDEN.
        threshold: distancia máxima de Hamming para considerar dos fotogramas
            "el mismo dibujo" (0 = solo idénticos; 4 ≈ tolera ruido de códec).
        progress_cb: callback(pos, total) opcional.
        cancel_check: callable que devuelve True para abortar.

    Returns:
        (rep_indices, rep_of) donde:
          rep_indices: índices (0-based) de los REPRESENTANTES, en orden.
          rep_of: lista paralela a paths; rep_of[i] = índice del representante
                  del fotograma i (i mismo si es único/representante).
    """
    reps: list[tuple[int, int]] = []  # (hash, índice del representante)
    rep_indices: list[int] = []
    rep_of: list[int] = []
    total = len(paths)

    for i, p in enumerate(paths):
        if cancel_check and cancel_check():
            raise _Cancelled()
        try:
            h = dhash(p)
        except Exception:
            # Imagen ilegible: se trata como única para no perderla.
            rep_indices.append(i)
            rep_of.append(i)
            continue

        match = None
        # Primero el representante anterior (los duplicados suelen ser
        # consecutivos), luego el resto.
        candidates = ([reps[-1]] + reps[:-1]) if reps else []
        for rh, ridx in candidates:
            if hamming(h, rh) <= threshold:
                match = ridx
                break

        if match is None:
            reps.append((h, i))
            rep_indices.append(i)
            rep_of.append(i)
        else:
            rep_of.append(match)

        if progress_cb:
            progress_cb(i + 1, total)

    return rep_indices, rep_of


class _Cancelled(Exception):
    pass
