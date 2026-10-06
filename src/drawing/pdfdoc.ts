// Multi-page vector PDF from fairbeam SVG pages (jsPDF loaded on demand; works in Node and browsers).

import { drawSvg, registerPlex, svgSize } from "./svgpdf.ts";

export interface PdfFonts {
  regular: Uint8Array;
  semibold: Uint8Array;
}

export async function svgPagesToPdf(pages: string[], fonts: PdfFonts, meta: { title: string; subject?: string; date?: Date }): Promise<Uint8Array> {
  const { jsPDF } = await import("jspdf");
  const sizes = pages.map(svgSize);
  const orient = ([w, h]: [number, number]) => (w > h ? "landscape" : "portrait");
  const doc = new jsPDF({ unit: "mm", format: sizes[0], orientation: orient(sizes[0]), compress: true });
  await registerPlex(doc, fonts.regular, fonts.semibold);
  pages.forEach((svg, i) => {
    if (i) doc.addPage(sizes[i], orient(sizes[i]));
    drawSvg(doc, svg);
  });
  doc.setProperties({ title: meta.title, subject: meta.subject ?? "", creator: "Fairbeam" });
  if (meta.date) {
    // reproducible output (examples committed to the repository)
    doc.setCreationDate(meta.date);
    let h = 0;
    for (const ch of meta.title + meta.date.toISOString()) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
    doc.setFileId(h.toString(16).padStart(8, "0").repeat(4));
  }
  return new Uint8Array(doc.output("arraybuffer"));
}
