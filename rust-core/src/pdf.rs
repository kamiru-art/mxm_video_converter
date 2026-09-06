//! PDF combinado (una hoja por página, listo para imprimir al 100 %).
//! Escritor mínimo y EN STREAMING: cada página sale como un bloque de bytes
//! en cuanto se añade, y el constructor solo retiene los desplazamientos
//! para la tabla xref del final. Antes guardaba todas las páginas
//! comprimidas y las volvía a copiar dos veces al terminar: a 8,5 MB por
//! página A4 de 300 ppp, un proyecto de 424 hojas pedía más de 4 GB en la
//! memoria del worker y el núcleo abortaba ("unreachable") tras 25 minutos.
//!
//! La imagen de cada página es el PNG que produce render_sheet tal cual:
//! FlateDecode con predictor PNG (`/Predictor 15`) acepta el flujo IDAT de
//! un PNG RGB de 8 bits sin volver a comprimirlo, así que añadir una página
//! ya no decodifica ni recomprime nada (0,5 s por página que desaparecen).

use crate::img::Rgb;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use std::io::Write;

/// Construye un PDF página a página. `dpi` define el tamaño físico.
pub struct PdfBuilder {
    dpi: f64,
    /// Bytes emitidos hasta ahora (todos los bloques devueltos, en orden).
    written: usize,
    /// Desplazamiento de cada objeto, indexado por número de objeto − 1.
    /// Los objetos 1 (catálogo) y 2 (árbol de páginas) se escriben al final.
    offsets: Vec<Option<usize>>,
    /// Números de objeto de las páginas, en orden.
    page_objs: Vec<usize>,
}

/// Lo que hace falta de un PNG para incrustarlo sin recomprimir: RGB de
/// 8 bits, sin entrelazado, y su flujo zlib (los IDAT concatenados).
struct PngRgb8 {
    w: usize,
    h: usize,
    idat: Vec<u8>,
}

fn be32(b: &[u8]) -> usize {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize
}

/// None si el PNG no es RGB de 8 bits sin entrelazar (o está mal formado):
/// entonces se decodifica y se comprime como antes.
fn parse_png_rgb8(png: &[u8]) -> Option<PngRgb8> {
    const SIG: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if png.len() < 8 || &png[..8] != SIG {
        return None;
    }
    let mut pos = 8;
    let mut w = 0;
    let mut h = 0;
    let mut idat = Vec::new();
    let mut seen_ihdr = false;
    while pos + 8 <= png.len() {
        let len = be32(&png[pos..pos + 4]);
        let kind = &png[pos + 4..pos + 8];
        let start = pos + 8;
        let end = start.checked_add(len)?;
        if end + 4 > png.len() {
            return None;
        }
        let data = &png[start..end];
        match kind {
            b"IHDR" => {
                if len != 13 {
                    return None;
                }
                w = be32(&data[0..4]);
                h = be32(&data[4..8]);
                let (depth, color, interlace) = (data[8], data[9], data[12]);
                if depth != 8 || color != 2 || interlace != 0 {
                    return None;
                }
                seen_ihdr = true;
            }
            b"IDAT" => idat.extend_from_slice(data),
            b"IEND" => break,
            _ => {}
        }
        pos = end + 4; // + CRC
    }
    if !seen_ihdr || w == 0 || h == 0 || idat.is_empty() {
        return None;
    }
    Some(PngRgb8 { w, h, idat })
}

impl PdfBuilder {
    pub fn new(dpi: u32) -> Self {
        PdfBuilder {
            dpi: dpi as f64,
            written: 0,
            offsets: vec![None, None],
            page_objs: Vec::new(),
        }
    }

    /// Cabecera del archivo: la emite el primer bloque.
    fn header(&mut self, out: &mut Vec<u8>) {
        if self.written == 0 && out.is_empty() {
            out.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
        }
    }

    /// Escribe un objeto en `out` y apunta su desplazamiento.
    fn object(&mut self, out: &mut Vec<u8>, num: usize, body: &[u8]) {
        while self.offsets.len() < num {
            self.offsets.push(None);
        }
        self.offsets[num - 1] = Some(self.written + out.len());
        out.extend_from_slice(format!("{num} 0 obj\n").as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }

    /// Una página: imagen, contenido y objeto de página. `params` es el
    /// diccionario extra del flujo de imagen (los DecodeParms del PNG).
    fn page(&mut self, w: usize, h: usize, stream: &[u8], params: &str) -> Vec<u8> {
        let mut out = Vec::with_capacity(stream.len() + 512);
        self.header(&mut out);
        let i = self.page_objs.len();
        let image_obj = self.offsets.len() + 1;
        let content_obj = image_obj + 1;
        let page_obj = image_obj + 2;
        let pw = w as f64 * 72.0 / self.dpi;
        let ph = h as f64 * 72.0 / self.dpi;

        let mut iobj = format!(
            "<< /Type /XObject /Subtype /Image /Width {w} /Height {h} \
             /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode{params} \
             /Length {} >>\nstream\n",
            stream.len()
        )
        .into_bytes();
        iobj.extend_from_slice(stream);
        iobj.extend_from_slice(b"\nendstream");
        self.object(&mut out, image_obj, &iobj);

        let content = format!("q\n{pw:.2} 0 0 {ph:.2} 0 0 cm\n/Im{i} Do\nQ\n");
        let mut cobj = format!("<< /Length {} >>\nstream\n", content.len()).into_bytes();
        cobj.extend_from_slice(content.as_bytes());
        cobj.extend_from_slice(b"\nendstream");
        self.object(&mut out, content_obj, &cobj);

        let pobj = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw:.2} {ph:.2}] \
             /Resources << /XObject << /Im{i} {image_obj} 0 R >> >> \
             /Contents {content_obj} 0 R >>"
        );
        self.object(&mut out, page_obj, pobj.as_bytes());
        self.page_objs.push(page_obj);
        self.written += out.len();
        out
    }

    /// Añade una página desde píxeles RGB (comprime con zlib). Devuelve los
    /// bytes de esa página, que van al archivo detrás de los anteriores.
    pub fn add_page(&mut self, img: &Rgb) -> Vec<u8> {
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::new(6));
        enc.write_all(&img.data).unwrap();
        let compressed = enc.finish().unwrap();
        self.page(img.w, img.h, &compressed, "")
    }

    /// Añade una página desde un PNG RGB de 8 bits sin volver a comprimir:
    /// el flujo IDAT entra tal cual con el predictor PNG. Devuelve None si
    /// el PNG no es de ese tipo; quien llama lo decodifica y usa add_page.
    pub fn add_page_png(&mut self, png: &[u8]) -> Option<Vec<u8>> {
        let p = parse_png_rgb8(png)?;
        let params = format!(
            " /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns {} >>",
            p.w
        );
        Some(self.page(p.w, p.h, &p.idat, &params))
    }

    pub fn page_count(&self) -> usize {
        self.page_objs.len()
    }

    /// Cierra el archivo: árbol de páginas, catálogo, xref y trailer.
    pub fn finish(mut self) -> Vec<u8> {
        let mut out = Vec::new();
        self.header(&mut out);
        let kids: Vec<String> = self.page_objs.iter().map(|n| format!("{n} 0 R")).collect();
        let pages = format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kids.join(" "),
            self.page_objs.len()
        );
        self.object(&mut out, 2, pages.as_bytes());
        self.object(&mut out, 1, b"<< /Type /Catalog /Pages 2 0 R >>");
        let xref_pos = self.written + out.len();
        let n = self.offsets.len();
        out.extend_from_slice(format!("xref\n0 {}\n", n + 1).as_bytes());
        out.extend_from_slice(b"0000000000 65535 f \n");
        for off in &self.offsets {
            let off = off.expect("todos los objetos escritos");
            out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n",
                n + 1
            )
            .as_bytes(),
        );
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codecs;

    /// Recorre la xref y comprueba que cada desplazamiento apunta a
    /// "N 0 obj": es lo que un lector usa para encontrar los objetos, y lo
    /// que un escritor en streaming puede romper si cuenta mal los bytes.
    fn check_xref(pdf: &[u8]) -> usize {
        // por bytes, no por texto: la cabecera lleva bytes que no son UTF-8 y
        // una conversión con pérdida movería todos los desplazamientos
        let startxref = pdf
            .windows(10)
            .rposition(|w| w == b"startxref\n")
            .expect("startxref");
        let tail = std::str::from_utf8(&pdf[startxref + 10..]).unwrap();
        let xref_pos: usize = tail.lines().next().unwrap().trim().parse().unwrap();
        assert!(
            pdf[xref_pos..].starts_with(b"xref\n"),
            "xref no está donde dice startxref"
        );
        let table = std::str::from_utf8(&pdf[xref_pos..startxref]).unwrap();
        let mut lines = table.lines().skip(1);
        let count: usize = lines
            .next()
            .unwrap()
            .split(' ')
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        lines.next(); // objeto 0 (libre)
        for num in 1..count {
            let off: usize = lines.next().unwrap()[..10].parse().unwrap();
            let head = format!("{num} 0 obj\n");
            assert!(
                pdf[off..].starts_with(head.as_bytes()),
                "objeto {num}: offset {off} no apunta a su cabecera"
            );
        }
        count - 1
    }

    #[test]
    fn builds_valid_looking_pdf() {
        let mut b = PdfBuilder::new(150);
        let mut pdf = b.add_page(&Rgb::new(100, 140, [255, 0, 0]));
        pdf.extend(b.add_page(&Rgb::new(100, 140, [0, 255, 0])));
        pdf.extend(b.finish());
        assert!(pdf.starts_with(b"%PDF-1.4"));
        assert!(pdf.windows(8).any(|w| w == b"/Count 2"[..].as_ref()));
        assert!(pdf.ends_with(b"%%EOF\n"));
        assert_eq!(check_xref(&pdf), 2 + 2 * 3);
    }

    /// El PNG de una hoja entra sin recomprimir: el flujo de la imagen es el
    /// IDAT del PNG, con el predictor declarado, y la xref sigue cuadrando
    /// con los bloques emitidos por separado.
    #[test]
    fn png_pages_are_embedded_verbatim() {
        let img = Rgb::new(64, 48, [10, 200, 30]);
        let png = codecs::encode_png_rgb(&img);
        let mut b = PdfBuilder::new(300);
        let first = b.add_page_png(&png).expect("PNG RGB de 8 bits");
        let second = b.add_page_png(&png).expect("PNG RGB de 8 bits");
        let tail = b.finish();
        let text = String::from_utf8_lossy(&first);
        assert!(text.contains("/Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns 64"));
        assert!(text.contains("/Width 64 /Height 48"));
        let idat = parse_png_rgb8(&png).unwrap().idat;
        assert!(
            first.windows(idat.len()).any(|w| w == idat.as_slice()),
            "IDAT no está tal cual"
        );
        let mut pdf = first;
        pdf.extend(second);
        pdf.extend(tail);
        assert_eq!(check_xref(&pdf), 2 + 2 * 3);
        assert_eq!(b"%PDF-1.4"[..], pdf[..8]);
    }

    #[test]
    fn non_rgb8_png_is_refused() {
        // un PNG en escala de grises no vale para el atajo: None, sin pánico
        let gray = image::GrayImage::from_pixel(4, 4, image::Luma([7u8]));
        let mut out = Vec::new();
        image::DynamicImage::ImageLuma8(gray)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        assert!(PdfBuilder::new(72).add_page_png(&out).is_none());
        assert!(PdfBuilder::new(72).add_page_png(b"not a png").is_none());
    }

    #[test]
    fn empty_pdf_still_has_header_and_xref() {
        let pdf = PdfBuilder::new(72).finish();
        assert!(pdf.starts_with(b"%PDF-1.4"));
        assert_eq!(check_xref(&pdf), 2);
    }
}
