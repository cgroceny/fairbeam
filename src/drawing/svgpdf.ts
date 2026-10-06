// Minimal SVG -> jsPDF renderer for the SVG subset fairbeam itself generates (lines, rects,
// circles, polygons, polylines, paths with M/L/Q/T/C/Z, text with anchors and rotation, groups with
// translate/scale/rotate transforms, dash patterns, opacity). No DOM needed, so PDFs can be made in
// Node (scripts/check-exports.mjs) and in the browser alike. Units: SVG user units = mm.

import type { jsPDF } from "jspdf";
import { toBase64, woffToTtf } from "./font.ts";

export const PDF_FAMILY = "IBM Plex Sans";

interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  text: string;
}

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");

/** Parse a well-formed SVG/XML string into a small element tree. */
export function parseXml(xml: string): Node {
  const root: Node = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack: Node[] = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[5] !== undefined) {
      stack[stack.length - 1].text += decode(m[5]);
      continue;
    }
    if (!m[2]) continue;
    if (m[1]) {
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = ar.exec(m[3]))) attrs[a[1]] = decode(a[2] ?? a[3]);
    const node: Node = { tag: m[2], attrs, children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root.children.find((c) => c.tag === "svg") ?? root;
}

type M = [number, number, number, number, number, number]; // a b c d e f
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (p: M, q: M): M => [
  p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function parseTransform(t: string | undefined): M {
  let m: M = I;
  if (!t) return m;
  const re = /(translate|scale|rotate|matrix)\s*\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(t))) {
    const v = r[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let q: M = I;
    if (r[1] === "translate") q = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
    else if (r[1] === "scale") q = [v[0], 0, 0, v[1] ?? v[0], 0, 0];
    else if (r[1] === "matrix") q = v as M;
    else {
      const a = ((v[0] ?? 0) * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const [cx, cy] = [v[1] ?? 0, v[2] ?? 0];
      q = mul(mul([1, 0, 0, 1, cx, cy], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    }
    m = mul(m, q);
  }
  return m;
}

interface Style {
  fill: string;
  stroke: string;
  sw: number;
  dash: string;
  fs: number;
  weight: string;
  anchor: string;
  fillOpacity: number;
  strokeOpacity: number;
  join: string;
}

const INHERIT: Record<string, keyof Style> = {
  fill: "fill", stroke: "stroke", "stroke-width": "sw", "stroke-dasharray": "dash", "font-size": "fs",
  "font-weight": "weight", "text-anchor": "anchor", "fill-opacity": "fillOpacity", "stroke-opacity": "strokeOpacity",
  "stroke-linejoin": "join",
};

const hex = (c: string) => {
  if (c.startsWith("#") && c.length === 4) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  if (c === "white") return "#ffffff";
  if (c === "black") return "#000000";
  return c;
};

/** Register IBM Plex Sans (regular + semibold) with a jsPDF document. */
export async function registerPlex(doc: jsPDF, regularWoff: Uint8Array, semiboldWoff: Uint8Array) {
  doc.addFileToVFS("IBMPlexSans-Regular.ttf", toBase64(await woffToTtf(regularWoff)));
  doc.addFileToVFS("IBMPlexSans-SemiBold.ttf", toBase64(await woffToTtf(semiboldWoff)));
  doc.addFont("IBMPlexSans-Regular.ttf", PDF_FAMILY, "normal");
  doc.addFont("IBMPlexSans-SemiBold.ttf", PDF_FAMILY, "bold");
}

const PT_PER_MM = 72 / 25.4;

/**
 * Draw an SVG (string or parsed tree) onto the current page of `doc` (unit mm) with the given
 * placement transform (default: SVG user units = page mm).
 */
export function drawSvg(doc: jsPDF, svg: string | Node, place: M = I) {
  const root = typeof svg === "string" ? parseXml(svg) : svg;
  const base: Style = { fill: "#000", stroke: "none", sw: 1, dash: "none", fs: 3, weight: "400", anchor: "start", fillOpacity: 1, strokeOpacity: 1, join: "miter" };
  walk(doc, root, place, base, true);
}

function walk(doc: jsPDF, n: Node, m: M, parent: Style, isRoot = false) {
  if (["title", "desc", "style", "defs", "clipPath", "metadata"].includes(n.tag)) return;
  const st: Style = { ...parent };
  for (const [k, key] of Object.entries(INHERIT)) {
    const v = n.attrs[k];
    if (v === undefined) continue;
    if (key === "sw" || key === "fs" || key === "fillOpacity" || key === "strokeOpacity") (st[key] as number) = Number(v);
    else (st[key] as string) = v;
  }
  const mm = isRoot ? m : mul(m, parseTransform(n.attrs.transform));
  const a = (k: string, d = 0) => (n.attrs[k] !== undefined ? Number(n.attrs[k]) : d);
  switch (n.tag) {
    case "svg":
    case "g":
    case "#root":
      for (const c of n.children) walk(doc, c, mm, st);
      return;
    case "line":
      return shape(doc, mm, st, [[["M", a("x1"), a("y1")], ["L", a("x2"), a("y2")]]], false);
    case "rect": {
      const x = a("x");
      const y = a("y");
      const w = a("width");
      const h = a("height");
      return shape(doc, mm, st, [[["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["Z"]]], true);
    }
    case "circle": {
      const cx = a("cx");
      const cy = a("cy");
      const r = a("r");
      const k = 0.5522847498 * r;
      return shape(doc, mm, st, [[
        ["M", cx + r, cy],
        ["C", cx + r, cy + k, cx + k, cy + r, cx, cy + r],
        ["C", cx - k, cy + r, cx - r, cy + k, cx - r, cy],
        ["C", cx - r, cy - k, cx - k, cy - r, cx, cy - r],
        ["C", cx + k, cy - r, cx + r, cy - k, cx + r, cy],
        ["Z"],
      ]], true);
    }
    case "polygon":
    case "polyline": {
      const v = (n.attrs.points ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
      const seg: Seg[] = [];
      for (let i = 0; i + 1 < v.length; i += 2) seg.push([i ? "L" : "M", v[i], v[i + 1]]);
      if (n.tag === "polygon") seg.push(["Z"]);
      return shape(doc, mm, st, [seg], n.tag === "polygon");
    }
    case "path":
      return shape(doc, mm, st, parsePath(n.attrs.d ?? ""), true);
    case "text":
      return drawText(doc, mm, st, a("x"), a("y"), n.text);
    default:
      for (const c of n.children) walk(doc, c, mm, st);
  }
}

type Seg = [string, ...number[]];

/** Path data (absolute M L H V C Q T Z) -> subpaths of absolute segments. */
function parsePath(d: string): Seg[][] {
  const out: Seg[][] = [];
  let cur: Seg[] = [];
  const tok = d.match(/[MLHVCQTZmlhvcqtz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let qx = 0;
  let qy = 0;
  const num = () => Number(tok[i++]);
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
    switch (cmd) {
      case "M":
        if (cur.length) out.push(cur);
        x = num();
        y = num();
        cur = [["M", x, y]];
        cmd = "L";
        break;
      case "L":
        x = num();
        y = num();
        cur.push(["L", x, y]);
        break;
      case "H":
        x = num();
        cur.push(["L", x, y]);
        break;
      case "V":
        y = num();
        cur.push(["L", x, y]);
        break;
      case "C": {
        const s: Seg = ["C", num(), num(), num(), num(), num(), num()];
        x = s[5] as number;
        y = s[6] as number;
        cur.push(s);
        break;
      }
      case "Q":
      case "T": {
        let cx: number;
        let cy: number;
        if (cmd === "Q") {
          cx = num();
          cy = num();
        } else {
          cx = 2 * x - qx;
          cy = 2 * y - qy;
        }
        const ex = num();
        const ey = num();
        cur.push(["C", x + (2 / 3) * (cx - x), y + (2 / 3) * (cy - y), ex + (2 / 3) * (cx - ex), ey + (2 / 3) * (cy - ey), ex, ey]);
        qx = cx;
        qy = cy;
        x = ex;
        y = ey;
        break;
      }
      case "Z":
      case "z":
        cur.push(["Z"]);
        break;
      default:
        i++; // unsupported command (relative forms are never generated by fairbeam)
    }
    if (cmd !== "Q" && cmd !== "T") {
      qx = x;
      qy = y;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

const scaleOf = (m: M) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

function withOpacity(doc: jsPDF, fillO: number, strokeO: number, fn: () => void) {
  if (fillO >= 1 && strokeO >= 1) return fn();
  doc.saveGraphicsState();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc.setGState(new (doc as any).GState({ opacity: fillO, "stroke-opacity": strokeO }));
  fn();
  doc.restoreGraphicsState();
}

function shape(doc: jsPDF, m: M, st: Style, paths: Seg[][], closable: boolean) {
  const fill = closable && st.fill !== "none" ? hex(st.fill) : null;
  const stroke = st.stroke !== "none" ? hex(st.stroke) : null;
  if (!fill && !stroke) return;
  withOpacity(doc, st.fillOpacity, st.strokeOpacity, () => {
    const k = scaleOf(m);
    if (stroke) {
      doc.setDrawColor(stroke);
      doc.setLineWidth(st.sw * k);
      const dash = st.dash && st.dash !== "none" ? st.dash.split(/[\s,]+/).map((v) => Number(v) * k) : [];
      doc.setLineDashPattern(dash, 0);
      doc.setLineJoin(st.join === "round" ? "round" : "miter");
    }
    if (fill) doc.setFillColor(fill);
    for (const p of paths) {
      for (const s of p) {
        if (s[0] === "M") doc.moveTo(...apply(m, s[1] as number, s[2] as number));
        else if (s[0] === "L") doc.lineTo(...apply(m, s[1] as number, s[2] as number));
        else if (s[0] === "C") {
          const [x1, y1] = apply(m, s[1] as number, s[2] as number);
          const [x2, y2] = apply(m, s[3] as number, s[4] as number);
          const [x3, y3] = apply(m, s[5] as number, s[6] as number);
          doc.curveTo(x1, y1, x2, y2, x3, y3);
        } else if (s[0] === "Z") doc.close();
      }
    }
    if (fill && stroke) doc.fillStroke();
    else if (fill) doc.fill();
    else doc.stroke();
  });
}

function drawText(doc: jsPDF, m: M, st: Style, x: number, y: number, s: string) {
  if (!s || st.fill === "none") return;
  const k = scaleOf(m);
  doc.setFont(PDF_FAMILY, Number(st.weight) >= 600 || st.weight === "bold" ? "bold" : "normal");
  doc.setFontSize(st.fs * k * PT_PER_MM);
  doc.setTextColor(hex(st.fill));
  const w = doc.getTextWidth(s) / k; // in SVG units
  const dx = st.anchor === "middle" ? -w / 2 : st.anchor === "end" ? -w : 0;
  const [px, py] = apply(m, x + dx, y);
  // rotation of the x axis (SVG y points down: a positive SVG angle is clockwise)
  const ang = (-Math.atan2(m[1], m[0]) * 180) / Math.PI;
  withOpacity(doc, st.fillOpacity, 1, () => doc.text(s, px, py, Math.abs(ang) > 1e-6 ? { angle: ang } : {}));
}

/** Size of an SVG in mm from its width/height attributes. */
export function svgSize(svg: string): [number, number] {
  const r = parseXml(svg).attrs;
  return [parseFloat(r.width ?? "210"), parseFloat(r.height ?? "297")];
}
