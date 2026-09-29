/**
 * Builds small, valid PDFs for tests (portable: runs in Node and in the
 * browser). Content streams are left uncompressed and the optional image is
 * raw RGB, so qpdf has something to recompress; a signature field and PDF/A-1
 * metadata can be added to exercise the skip and preserve paths.
 */
export interface PdfCraftOptions {
  /** Number of pages (default 1). */
  readonly pages?: number;
  /** Adds a raw (uncompressed) RGB image of this size to the first page. */
  readonly image?: { readonly width: number; readonly height: number };
  /** Adds an AcroForm with a signature field. */
  readonly signatureField?: boolean;
  /** Adds XMP metadata declaring PDF/A-1b. */
  readonly pdfA1?: boolean;
  /** Repetitions of the text line in each page's content stream (default 40). */
  readonly textLines?: number;
}

const enc = new TextEncoder();

/** A smooth RGB gradient (compresses well as JPEG, badly as raw bytes). */
function gradient(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      out[i] = Math.round((x / Math.max(1, width - 1)) * 255);
      out[i + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      out[i + 2] = 128;
    }
  }
  return out;
}

export function craftPdf(options: PdfCraftOptions = {}): Uint8Array {
  const pages = options.pages ?? 1;
  const lines = options.textLines ?? 40;
  // Object numbers: 1 catalog, 2 pages, 3 font, then per page (page, content), then optional objects.
  const objects: (string | Uint8Array[])[] = [];
  const add = (o: string | Uint8Array[]): number => objects.push(o);
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const image = options.image
    ? add([
        enc.encode(
          `<< /Type /XObject /Subtype /Image /Width ${options.image.width} /Height ${options.image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${options.image.width * options.image.height * 3} >>\nstream\n`,
        ),
        gradient(options.image.width, options.image.height),
        enc.encode('\nendstream'),
      ])
    : 0;
  // A form field is listed by qpdf only when a page's /Annots points to its widget.
  const field = options.signatureField ? add('') : 0;
  const kids: number[] = [];
  for (let p = 0; p < pages; p++) {
    let text = '';
    for (let l = 0; l < lines; l++) text += `BT /F1 10 Tf 20 ${780 - l * 18} Td (Page ${p + 1}, line ${l + 1}: sample text for recompression) Tj ET\n`;
    if (p === 0 && image) text += `q 200 0 0 150 300 20 cm /Im1 Do Q\n`;
    const content = add(`<< /Length ${enc.encode(text).length} >>\nstream\n${text}endstream`);
    const xobjects = p === 0 && image ? ` /XObject << /Im1 ${image} 0 R >>` : '';
    const annots = p === 0 && field ? ` /Annots [${field} 0 R]` : '';
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >>${xobjects} >> /Contents ${content} 0 R${annots} >>`,
      ),
    );
  }
  let extra = '';
  if (field) {
    objects[field - 1] = `<< /FT /Sig /T (Signature1) /Type /Annot /Subtype /Widget /Rect [0 0 0 0] /P ${kids[0]} 0 R /F 132 >>`;
    extra += ` /AcroForm << /Fields [${field} 0 R] /SigFlags 3 >>`;
  }
  if (options.pdfA1) {
    const xmp =
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="1" pdfaid:conformance="B"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    const meta = add(`<< /Type /Metadata /Subtype /XML /Length ${enc.encode(xmp).length} >>\nstream\n${xmp}\nendstream`);
    extra += ` /Metadata ${meta} 0 R`;
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R${extra} >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${pages} >>`;

  const parts: Uint8Array[] = [enc.encode('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  let length = parts[0]!.length;
  const push = (b: Uint8Array): void => {
    parts.push(b);
    length += b.length;
  };
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(length);
    push(enc.encode(`${i + 1} 0 obj\n`));
    for (const b of typeof o === 'string' ? [enc.encode(o)] : o) push(b);
    push(enc.encode('\nendobj\n'));
  });
  const xref = length;
  push(enc.encode(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`));
  push(enc.encode(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  const out = new Uint8Array(length);
  let at = 0;
  for (const b of parts) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
