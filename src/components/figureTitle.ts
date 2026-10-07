// A chart figure with its title above it, for the PNG of a chart (slides and reports want the title on
// the picture; the SVG and PDF figures keep theirs in the document's title). Pure string work on the
// figure's SVG, so scripts/check-figure-export.mjs runs it without a browser.

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The size of an SVG in millimetres from its root's width and height ("88mm"), or null. */
export function svgSizeMm(svg: string): [number, number] | null {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
  const w = /\swidth="([\d.]+)mm"/.exec(root), h = /\sheight="([\d.]+)mm"/.exec(root);
  return w && h ? [Number(w[1]), Number(h[1])] : null;
}

/** The SVG with a band above it holding `title` (black on white, centred): the outer document is as
 * wide as the figure and the band taller; the figure keeps its own viewBox. Unchanged when the figure
 * has no size in millimetres or the title is empty. */
export function titledSvg(svg: string, title: string): string {
  const size = svgSizeMm(svg);
  if (!size || !title.trim()) return svg;
  const [w, h] = size;
  const font = Math.min(5, Math.max(3, w * 0.034));
  const band = font * 2.2;
  const inner = svg.replace(/^<\?xml[^>]*\?>\s*/, "").replace(/<svg\b([^>]*)>/, (_m, attrs: string) =>
    `<svg${attrs.replace(/\s(?:x|y|width|height)="[^"]*"/g, "")} x="0" y="${band.toFixed(2)}" width="${w}" height="${h}">`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${w}mm" height="${(h + band).toFixed(2)}mm" viewBox="0 0 ${w} ${(h + band).toFixed(2)}">` +
    `<title>${escapeXml(title)}</title>` +
    `<rect x="0" y="0" width="${w}" height="${(h + band).toFixed(2)}" fill="#fff"/>` +
    `<text x="${(w / 2).toFixed(2)}" y="${(band * 0.68).toFixed(2)}" text-anchor="middle" font-family="IBM Plex Sans, Arial, sans-serif" font-weight="600" font-size="${font.toFixed(2)}" fill="#000">${escapeXml(title)}</text>` +
    inner + `</svg>\n`;
}
