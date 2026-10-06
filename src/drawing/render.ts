// Browser-only helpers around the generated SVGs: vector PDF (jsPDF loaded on demand, IBM Plex Sans
// embedded so Greek letters, Ω and − survive), PNG (canvas, fonts inlined), downloads and 3D capture.

import regularUrl from "../assets/fonts/IBMPlexSans-Regular.woff?url";
import semiboldUrl from "../assets/fonts/IBMPlexSans-SemiBold.woff?url";
import { toBase64 } from "./font.ts";
import { svgPagesToPdf, type PdfFonts } from "./pdfdoc.ts";
import type { Bundle } from "../types";
import type { Weight } from "../lib/array";
import type { RefBundle } from "../import/reference";
import { saveDownload } from "../lib/download.ts";

let fontCache: Promise<{ regular: Uint8Array; semibold: Uint8Array }> | null = null;
function fonts() {
  fontCache ??= Promise.all([regularUrl, semiboldUrl].map(async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer()))).then(
    ([regular, semibold]) => ({ regular, semibold }),
  );
  return fontCache;
}

const FAMILY = "IBM Plex Sans";

/** Size of a generated SVG in mm (from its width/height attributes). */
export function svgSizeMm(svg: string): [number, number] {
  const w = /<svg[^>]*\swidth="([\d.]+)mm"/.exec(svg);
  const h = /<svg[^>]*\sheight="([\d.]+)mm"/.exec(svg);
  return [Number(w?.[1] ?? 210), Number(h?.[1] ?? 297)];
}

/** IBM Plex Sans regular + semibold (WOFF) for PDF embedding. */
export function pdfFonts(): Promise<PdfFonts> {
  return fonts();
}

/** Vector PDF of an SVG, page size = SVG size (fairbeam's own SVG -> jsPDF renderer). */
export async function svgToPdf(svg: string, title: string): Promise<Uint8Array> {
  return svgPagesToPdf([svg], await fonts(), { title });
}

/** The one-file A4 PDF report for a bundle (src/export/reportPdf.ts). */
export async function reportPdfFor(b: Bundle, now: Date = new Date(), arrayWeights?: Map<number, Weight> | null, reference?: RefBundle | null): Promise<Uint8Array> {
  const { reportPdf } = await import("../export/reportPdf.ts");
  const p = (x: number) => String(x).padStart(2, "0");
  const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  return reportPdf(b, await fonts(), { generated: `${date} ${p(now.getHours())}:${p(now.getMinutes())}`, date, arrayWeights, reference });
}

/** PNG of an SVG at `dpi` (capped to ~24 Mpx), white background. */
export async function svgToPng(svg: string, dpi = 300): Promise<Blob> {
  const f = await fonts();
  const face = (b: Uint8Array, wt: number) =>
    `@font-face{font-family:'${FAMILY}';font-weight:${wt};src:url(data:font/woff;base64,${toBase64(b)}) format('woff')}`;
  const styled = svg.replace(/(<svg[^>]*>)/, `$1<style>${face(f.regular, 400)}${face(f.semibold, 600)}</style>`);
  const [w, h] = svgSizeMm(svg);
  let px = dpi / 25.4;
  if (w * h * px * px > 24e6) px = Math.sqrt(24e6 / (w * h));
  const url = URL.createObjectURL(new Blob([styled], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * px);
    canvas.height = Math.round(h * px);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("PNG encoding failed"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Save through the desktop dialog or request a browser download, with an explicit outcome. */
export function saveBlob(name: string, data: Blob | Uint8Array | string, type = "application/octet-stream") {
  return saveDownload(name, data, type);
}

/** Ask the 3D viewport for a PNG of the current view (see the fairbeam:capture listener in Viewport.tsx). */
export function capture3d(timeoutMs = 3000): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    window.dispatchEvent(
      new CustomEvent("fairbeam:capture", {
        detail: {
          resolve: (dataUrl: string | null) => {
            clearTimeout(t);
            if (!dataUrl) return resolve(null);
            const b64 = dataUrl.split(",")[1] ?? "";
            const bin = atob(b64);
            const out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            resolve(out);
          },
        },
      }),
    );
  });
}
