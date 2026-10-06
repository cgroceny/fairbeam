// Minimal SVG string builder. Output uses presentation attributes only (no CSS), so it renders
// the same in browsers, in the PDF renderer (svgpdf.ts) and in vector editors (Inkscape, Illustrator, LaTeX via PDF).

export const FONT = "'IBM Plex Sans', Helvetica, Arial, sans-serif";

/** Number formatting for coordinates: at most 3 decimals, no trailing zeros. Non-finite values
 * are written as "NaN" on purpose so scripts/check-exports.mjs catches them. */
export function n(v: number): string {
  if (!Number.isFinite(v)) return "NaN";
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type Attrs = Record<string, string | number | undefined | null | false>;

export function attrs(a: Attrs = {}): string {
  let s = "";
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined || v === null || v === false) continue;
    s += ` ${k}="${typeof v === "number" ? n(v) : esc(v)}"`;
  }
  return s;
}

export const el = (tag: string, a: Attrs = {}, children?: string) =>
  children === undefined ? `<${tag}${attrs(a)}/>` : `<${tag}${attrs(a)}>${children}</${tag}>`;

export const line = (x1: number, y1: number, x2: number, y2: number, a: Attrs = {}) =>
  el("line", { x1, y1, x2, y2, ...a });

export const rect = (x: number, y: number, w: number, h: number, a: Attrs = {}) =>
  el("rect", { x: Math.min(x, x + w), y: Math.min(y, y + h), width: Math.abs(w), height: Math.abs(h), ...a });

export const circle = (cx: number, cy: number, r: number, a: Attrs = {}) => el("circle", { cx, cy, r, ...a });

export type Pt = [number, number];

export const pointsAttr = (pts: Pt[]) => pts.map(([x, y]) => `${n(x)},${n(y)}`).join(" ");
export const polygon = (pts: Pt[], a: Attrs = {}) => el("polygon", { points: pointsAttr(pts), ...a });
export const polyline = (pts: Pt[], a: Attrs = {}) => el("polyline", { points: pointsAttr(pts), fill: "none", ...a });

export function pathD(pts: Pt[], close = false): string {
  if (!pts.length) return "";
  return pts.map(([x, y], i) => `${i ? "L" : "M"}${n(x)} ${n(y)}`).join("") + (close ? "Z" : "");
}

export const text = (x: number, y: number, s: string, a: Attrs = {}) => el("text", { x, y, ...a }, esc(s));

export const group = (children: string | string[], a: Attrs = {}) =>
  el("g", a, Array.isArray(children) ? children.join("") : children);

/** Filled arrowhead with its tip at (x, y) pointing along (dx, dy); length:width = 3:1. */
export function arrowHead(x: number, y: number, dx: number, dy: number, len: number): string {
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l;
  const uy = dy / l;
  const w = len / 6; // half width -> full width = len / 3
  const bx = x - ux * len;
  const by = y - uy * len;
  return polygon(
    [
      [x, y],
      [bx - uy * w, by + ux * w],
      [bx + uy * w, by - ux * w],
    ],
    { fill: "#000", stroke: "none" },
  );
}

/** Root element of a standalone SVG sized in millimetres (viewBox units = mm). */
export function svgDoc(widthMm: number, heightMm: number, body: string, title: string, desc?: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${n(widthMm)}mm" height="${n(heightMm)}mm" ` +
    `viewBox="0 0 ${n(widthMm)} ${n(heightMm)}" font-family="${esc(FONT)}">` +
    `<title>${esc(title)}</title>` +
    (desc ? `<desc>${esc(desc)}</desc>` : "") +
    rect(0, 0, widthMm, heightMm, { fill: "#fff", stroke: "none" }) +
    body +
    `</svg>\n`
  );
}

/** Dimension/label number formatting: up to 3 decimals below 10, 2 below 100, 1 above; no trailing zeros. */
export function dimText(v: number): string {
  const a = Math.abs(v);
  const d = a < 10 ? 3 : a < 100 ? 2 : 1;
  const s = String(Number(a.toFixed(d)));
  return s;
}
