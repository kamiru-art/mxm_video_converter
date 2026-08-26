//! PDF combinado (una hoja por página, listo para imprimir al 100 %).
//! Escritor mínimo: cada página incrusta su imagen RGB con FlateDecode y se
//! declara en puntos PDF según el DPI real, para que imprima a tamaño exacto.

use crate::img::Rgb;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use std::io::Write;

/// Construye un PDF con las páginas dadas. `dpi` define el tamaño físico.
pub struct PdfBuilder {
    dpi: f64,
    pages: Vec<(usize, usize, Vec<u8>)>, // w, h, rgb comprimido
}

impl PdfBuilder {
    pub fn new(dpi: u32) -> Self {
        PdfBuilder { dpi: dpi as f64, pages: Vec::new() }
    }

    pub fn add_page(&mut self, img: &Rgb) {
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::new(6));
        enc.write_all(&img.data).unwrap();
        let compressed = enc.finish().unwrap();
        self.pages.push((img.w, img.h, compressed));
    }

    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    pub fn finish(self) -> Vec<u8> {
        // Objetos: 1 catálogo, 2 pages, y por página: page, contenido, imagen.
        let n_pages = self.pages.len();
        let mut objects: Vec<Vec<u8>> = Vec::new();
        let kids: Vec<String> = (0..n_pages).map(|i| format!("{} 0 R", 3 + i * 3)).collect();
        objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
        objects.push(
            format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), n_pages).into_bytes(),
        );
        for (i, (w, h, data)) in self.pages.iter().enumerate() {
            let pw = *w as f64 * 72.0 / self.dpi;
            let ph = *h as f64 * 72.0 / self.dpi;
            let page_obj = 3 + i * 3;
            let content_obj = page_obj + 1;
            let image_obj = page_obj + 2;
            objects.push(
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw:.2} {ph:.2}] \
                     /Resources << /XObject << /Im{i} {image_obj} 0 R >> >> \
                     /Contents {content_obj} 0 R >>"
                )
                .into_bytes(),
            );
            let content = format!("q\n{pw:.2} 0 0 {ph:.2} 0 0 cm\n/Im{i} Do\nQ\n");
            let mut cobj = format!("<< /Length {} >>\nstream\n", content.len()).into_bytes();
            cobj.extend_from_slice(content.as_bytes());
            cobj.extend_from_slice(b"\nendstream");
            objects.push(cobj);
            let mut iobj = format!(
                "<< /Type /XObject /Subtype /Image /Width {w} /Height {h} \
                 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode \
                 /Length {} >>\nstream\n",
                data.len()
            )
            .into_bytes();
            iobj.extend_from_slice(data);
            iobj.extend_from_slice(b"\nendstream");
            objects.push(iobj);
        }

        let mut out: Vec<u8> = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec();
        let mut offsets = Vec::with_capacity(objects.len());
        for (i, obj) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
            out.extend_from_slice(obj);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref_pos = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        out.extend_from_slice(b"0000000000 65535 f \n");
        for off in &offsets {
            out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
                objects.len() + 1,
                xref_pos
            )
            .as_bytes(),
        );
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_valid_looking_pdf() {
        let mut b = PdfBuilder::new(150);
        b.add_page(&Rgb::new(100, 140, [255, 0, 0]));
        b.add_page(&Rgb::new(100, 140, [0, 255, 0]));
        let pdf = b.finish();
        assert!(pdf.starts_with(b"%PDF-1.4"));
        assert!(pdf.windows(8).any(|w| w == b"/Count 2"[..].as_ref()));
        assert!(pdf.ends_with(b"%%EOF\n"));
    }
}
