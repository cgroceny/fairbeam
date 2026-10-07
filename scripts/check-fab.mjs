// Check the fabrication export (Gerber X2, Excellon, DXF R12) against the bundle geometry, and
// write example outputs.
//
//   node --experimental-strip-types scripts/check-fab.mjs
//
// For every example bundle: printed boards must export; the Gerbers are parsed back with a small
// independent reader (FS/MO/AD/LP/G36/G37/D01/D02/D03) and compared with copper geometry taken
// straight from the bundle (union area by coordinate compression, bounding boxes, a cell-by-cell
// image comparison) within 1 µm; drill hits must sit on the probe ports; the DXF must be
// well-formed (group-code pairs, closed polylines) with the same copper area. Non-PCB designs must
// report why there is no fabrication export.
//
// Writes examples/fab/<bundle-stem>/ (all fab files + render.svg, a picture drawn from the parsed
// Gerbers and drill file) for the patch antenna and the Wilkinson divider.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fabFiles } from "../src/fab/index.ts";
import { packageFiles } from "../src/export/package.ts";
import { technicalDrawing } from "../src/drawing/drawing.ts";
import { APP_VERSION, bundleWriter, releasedVersion } from "../src/lib/appVersion.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projects = join(root, "public", "projects");
const outRoot = join(root, "examples", "fab");
const EXAMPLES = ["patch-antenna", "wilkinson-divider"];
const DATE = "2026-09-25T00:00:00+00:00";
const UM = 1e-3; // 1 µm in mm

let failures = 0;
let checks = 0;
const fail = (where, msg) => {
  failures++;
  console.error(`  FAIL ${where}: ${msg}`);
};
const check = (cond, where, msg) => {
  checks++;
  if (!cond) fail(where, msg);
};

// ---------------------------------------------------------------- geometry helpers (independent)

const shoelace = (pts) => {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
};
const perimeter = (pts) => pts.reduce((s, p, i) => s + Math.hypot(pts[(i + 1) % pts.length][0] - p[0], pts[(i + 1) % pts.length][1] - p[1]), 0);
function inRing(x, y, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const bbox = (rings) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) for (const [x, y] of r) {
    b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
  }
  return b;
};
const rectilinear = (pts) => pts.every((p, i) => {
  const q = pts[(i + 1) % pts.length];
  return Math.abs(p[0] - q[0]) < 1e-9 || Math.abs(p[1] - q[1]) < 1e-9;
});
const uniq = (vs) => [...new Set(vs.map((v) => Math.round(v * 1e7) / 1e7))].sort((a, b) => a - b);

/** Union area of rectilinear rings by coordinate compression + cell-centre point tests. */
function unionArea(rings) {
  const xs = uniq(rings.flatMap((r) => r.map((p) => p[0])));
  const ys = uniq(rings.flatMap((r) => r.map((p) => p[1])));
  let a = 0;
  for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++) {
    const cx = (xs[i] + xs[i + 1]) / 2;
    const cy = (ys[j] + ys[j + 1]) / 2;
    if (rings.some((r) => inRing(cx, cy, r))) a += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
  }
  return a;
}

/** Copper and substrate straight from the bundle (mm), keyed by face z. */
function bundleGeometry(b) {
  const s = (b.units?.length_m ?? 1e-3) / 1e-3;
  const lo = (p) => p.start.map((v, i) => Math.min(v, p.stop[i]) * s);
  const hi = (p) => p.start.map((v, i) => Math.max(v, p.stop[i]) * s);
  const flat = (q) => {
    if (q.kind === "box") {
      const a = lo(q), c = hi(q);
      if (c[0] - a[0] < 1e-9 || c[1] - a[1] < 1e-9) return null;
      return { ring: [[a[0], a[1]], [c[0], a[1]], [c[0], c[1]], [a[0], c[1]]], z0: a[2], z1: c[2] };
    }
    if ((q.kind === "polygon" || q.kind === "linpoly") && q.normal === 2) {
      const z = [q.elevation * s, (q.elevation + (q.length ?? 0)) * s];
      return { ring: q.points.map(([u, v]) => [u * s, v * s]), z0: Math.min(...z), z1: Math.max(...z) };
    }
    return null;
  };
  const slabs = [];
  for (const p of b.parts) if (p.type === "Material" && p.material) for (const q of p.primitives) {
    const f = flat(q);
    if (f && f.z1 - f.z0 > 1e-6) slabs.push(f);
  }
  const faces = uniq(slabs.flatMap((f) => [f.z0, f.z1]));
  const copper = new Map();
  for (const p of b.parts) if (p.type === "Metal" || p.type === "ConductingSheet") for (const q of p.primitives) {
    const f = flat(q);
    if (!f || f.z1 - f.z0 > 0.1) continue;
    const z = faces.find((z) => Math.abs(z - f.z0) < 1e-4 || Math.abs(z - f.z1) < 1e-4);
    if (z === undefined) continue;
    if (!copper.has(z)) copper.set(z, []);
    copper.get(z).push(f.ring);
  }
  const probes = b.ports.filter((p) => p.direction === "z" && Math.abs(p.start[0] - p.stop[0]) < 1e-12 && Math.abs(p.start[1] - p.stop[1]) < 1e-12)
    .map((p) => ({ number: p.number, x: p.start[0] * s, y: p.start[1] * s, z0: Math.min(p.start[2], p.stop[2]) * s }));
  return { slabs, faces, copper, probes };
}

// ---------------------------------------------------------------- Gerber reader

function readGerber(text, where) {
  const tokens = text.replace(/\r?\n/g, "").match(/%[^%]*%|[^*%]+\*/g) ?? [];
  const st = { dec: null, int: null, units: null, dark: true, ap: null, x: 0, y: 0, region: null, ended: false };
  const apertures = new Map();
  const attrs = {};
  const objects = [];
  const errors = [];
  const coord = (v) => Number(v) / 10 ** st.dec;
  for (const tok of tokens) {
    if (st.ended) { errors.push(`content after M02: ${tok}`); break; }
    if (tok.startsWith("%")) {
      for (const cmd of tok.slice(1, -1).split("*").filter(Boolean)) {
        let m;
        if ((m = /^FSLAX(\d)(\d)Y(\d)(\d)$/.exec(cmd))) { st.int = +m[1]; st.dec = +m[2]; }
        else if ((m = /^MO(MM|IN)$/.exec(cmd))) st.units = m[1];
        else if ((m = /^ADD(\d+)C,([\d.]+)$/.exec(cmd))) apertures.set(+m[1], +m[2]);
        else if ((m = /^LP([DC])$/.exec(cmd))) st.dark = m[1] === "D";
        else if ((m = /^TF\.?([^,]+),?(.*)$/.exec(cmd))) attrs[m[1].replace(/^\./, "")] = m[2];
        else if (/^T[AOD]/.test(cmd)) { /* aperture/object attributes */ }
        else errors.push(`unknown extended command ${cmd}`);
      }
      continue;
    }
    const w = tok.slice(0, -1);
    let m;
    if (w.startsWith("G04")) continue;
    if (w === "G01") continue;
    if (w === "G36") { st.region = []; continue; }
    if (w === "G37") {
      if (!st.region?.length) errors.push("G37 without a contour");
      else {
        const [f, l] = [st.region[0], st.region[st.region.length - 1]];
        if (f[0] !== l[0] || f[1] !== l[1]) errors.push("region contour not closed");
        objects.push({ type: "region", dark: st.dark, pts: st.region.slice(0, -1) });
      }
      st.region = null;
      continue;
    }
    if (w === "M02") { st.ended = true; continue; }
    if ((m = /^D(\d+)$/.exec(w)) && +m[1] >= 10) {
      if (!apertures.has(+m[1])) errors.push(`undefined aperture D${m[1]}`);
      st.ap = +m[1];
      continue;
    }
    if ((m = /^(?:X(-?\d+))?(?:Y(-?\d+))?D0([123])$/.exec(w))) {
      if (st.dec === null || !st.units) { errors.push("coordinates before FS/MO"); continue; }
      for (const v of [m[1], m[2]]) if (v !== undefined && v.replace("-", "").length > st.int + st.dec) errors.push(`coordinate ${v} exceeds format`);
      const x = m[1] !== undefined ? coord(m[1]) : st.x;
      const y = m[2] !== undefined ? coord(m[2]) : st.y;
      const d = +m[3];
      if (st.region) {
        if (d === 2) { if (st.region.length) errors.push("multiple contours in one region"); st.region = [[x, y]]; }
        else if (d === 1) st.region.push([x, y]);
        else errors.push("D03 inside a region");
      } else if (d === 3) objects.push({ type: "flash", dark: st.dark, x, y, d: apertures.get(st.ap) });
      else if (d === 1) objects.push({ type: "draw", dark: st.dark, x0: st.x, y0: st.y, x1: x, y1: y, d: apertures.get(st.ap) });
      st.x = x; st.y = y;
      continue;
    }
    errors.push(`unknown word ${w}`);
  }
  if (!st.ended) errors.push("missing M02");
  for (const e of errors) fail(where, e);
  return { format: [st.int, st.dec], units: st.units, attrs, apertures, objects };
}

/** Closed loops traced by D01 draws (profile). */
function drawLoops(objects) {
  const loops = [];
  let cur = null;
  for (const o of objects.filter((o) => o.type === "draw")) {
    if (!cur || cur[cur.length - 1][0] !== o.x0 || cur[cur.length - 1][1] !== o.y0) { cur = [[o.x0, o.y0]]; loops.push(cur); }
    cur.push([o.x1, o.y1]);
  }
  return loops.map((l) => ({ closed: l[0][0] === l[l.length - 1][0] && l[0][1] === l[l.length - 1][1], pts: l.slice(0, -1) }));
}

/** Compare parsed Gerber regions with bundle copper rings: bbox, net area, grid image. */
function compareCopper(rings, regions) {
  const eb = bbox(rings);
  const gb = bbox(regions.filter((o) => o.dark).map((o) => o.pts));
  const bboxErr = Math.max(...eb.map((v, k) => Math.abs(v - gb[k])));
  const expected = unionArea(rings);
  const net = regions.reduce((s, o) => s + (o.dark ? 1 : -1) * Math.abs(shoelace(o.pts)), 0);
  const tol = UM * rings.reduce((s, r) => s + perimeter(r), 0);
  const xs = uniq([...rings.flatMap((r) => r.map((p) => p[0])), ...regions.flatMap((o) => o.pts.map((p) => p[0]))]);
  const ys = uniq([...rings.flatMap((r) => r.map((p) => p[1])), ...regions.flatMap((o) => o.pts.map((p) => p[1]))]);
  let bad = 0;
  for (let a = 0; a + 1 < xs.length; a++) for (let c = 0; c + 1 < ys.length; c++) {
    const cx = (xs[a] + xs[a + 1]) / 2, cy = (ys[c] + ys[c + 1]) / 2;
    let img = false;
    for (const o of regions) if (inRing(cx, cy, o.pts)) img = o.dark;
    if (img !== rings.some((r) => inRing(cx, cy, r))) bad++;
  }
  return { bboxErr, eb, gb, expected, net, areaOk: Math.abs(net - expected) <= tol, bad, cells: `${xs.length - 1}×${ys.length - 1}` };
}

// ---------------------------------------------------------------- Excellon and DXF readers

function readExcellon(text, where) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const tools = new Map();
  const hits = [];
  let header = true, metric = false, tool = null, ended = false;
  if (lines[0] !== "M48") fail(where, "Excellon must start with M48");
  for (const l of lines.slice(1)) {
    let m;
    if (l.startsWith(";")) continue;
    if (header) {
      if (l === "%") header = false;
      else if (/^METRIC/.test(l)) metric = true;
      else if ((m = /^T(\d+)C([\d.]+)$/.exec(l))) tools.set(+m[1], +m[2]);
      else if (!/^(FMAT,2|INCH.*)$/.test(l)) fail(where, `unexpected header line ${l}`);
      continue;
    }
    if (l === "G90" || l === "G05") continue;
    if (l === "M30") { ended = true; continue; }
    if ((m = /^T(\d+)$/.exec(l))) { tool = +m[1]; if (tool && !tools.has(tool)) fail(where, `undefined tool T${tool}`); continue; }
    if ((m = /^X(-?[\d.]+)Y(-?[\d.]+)$/.exec(l))) { hits.push({ x: +m[1], y: +m[2], d: tools.get(tool) }); continue; }
    fail(where, `unexpected line ${l}`);
  }
  check(metric, where, "not METRIC");
  check(ended, where, "missing M30");
  return { tools, hits };
}

function readDxf(text, where) {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  check(lines.length % 2 === 0, where, "odd number of lines (group-code pairs)");
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    if (!/^-?\d+$/.test(code)) { fail(where, `line ${i + 1}: group code ${JSON.stringify(code)} is not an integer`); break; }
    pairs.push([+code, lines[i + 1]]);
  }
  check(pairs.length && pairs[pairs.length - 1][0] === 0 && pairs[pairs.length - 1][1] === "EOF", where, "missing EOF");
  const version = pairs.find((p, i) => p[0] === 9 && p[1] === "$ACADVER" && pairs[i + 1]?.[1] === "AC1009");
  check(!!version, where, "$ACADVER is not AC1009 (R12)");
  // the unit is stated (4 = mm): an importer need not assume it
  const insunits = pairs.findIndex((p) => p[0] === 9 && p[1] === "$INSUNITS");
  check(insunits >= 0 && pairs[insunits + 1]?.[0] === 70 && pairs[insunits + 1][1].trim() === "4", where, "$INSUNITS is not 4 (mm)");
  const layers = new Set();
  const polylines = [];
  const circles = [];
  let sections = 0, open = false;
  for (let i = 0; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c !== 0) continue;
    const body = [];
    for (let j = i + 1; j < pairs.length && pairs[j][0] !== 0; j++) body.push(pairs[j]);
    const get = (k) => body.find((p) => p[0] === k)?.[1];
    if (v === "SECTION") { if (open) fail(where, "nested SECTION"); open = true; sections++; }
    else if (v === "ENDSEC") { if (!open) fail(where, "ENDSEC without SECTION"); open = false; }
    else if (v === "LAYER") layers.add(get(2));
    else if (v === "POLYLINE") {
      const pl = { layer: get(8), closed: (+get(70) & 1) === 1, pts: [] };
      let j = i + 1 + body.length;
      while (j < pairs.length && pairs[j][1] === "VERTEX") {
        const vb = [];
        for (let k = j + 1; k < pairs.length && pairs[k][0] !== 0; k++) vb.push(pairs[k]);
        pl.pts.push([+vb.find((p) => p[0] === 10)[1], +vb.find((p) => p[0] === 20)[1]]);
        j += 1 + vb.length;
      }
      if (pairs[j]?.[1] !== "SEQEND") fail(where, "POLYLINE without SEQEND");
      polylines.push(pl);
    } else if (v === "CIRCLE") circles.push({ layer: get(8), x: +get(10), y: +get(20), r: +get(40) });
  }
  check(!open && sections === 3, where, `sections: expected HEADER, TABLES, ENTITIES (got ${sections})`);
  for (const e of [...polylines, ...circles]) check(layers.has(e.layer), where, `entity on undeclared layer ${e.layer}`);
  for (const p of polylines) {
    check(p.closed, where, `open polyline on ${p.layer}`);
    check(p.pts.length >= 3 && p.pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), where, `bad polyline on ${p.layer}`);
  }
  return { layers, polylines, circles };
}

// ---------------------------------------------------------------- render (from the parsed files)

function renderSvg(title, layers, profile, drills) {
  const all = [...profile.flatMap((l) => l.pts), ...layers.flatMap((l) => l.g.objects.filter((o) => o.type === "region").flatMap((o) => o.pts))];
  const [x0, y0, x1, y1] = bbox([all]);
  const pad = 4;
  const w = x1 - x0 + 2 * pad;
  const h = y1 - y0 + 2 * pad;
  const gap = 8;
  const W = Math.max(140, w * layers.length + gap * (layers.length - 1)); // room for the caption
  const head = 12;
  const f = (v) => Number(v.toFixed(4));
  const path = (pts) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z`;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(h + head)}mm" viewBox="0 0 ${f(W)} ${f(h + head)}" font-family="IBM Plex Sans, Helvetica, Arial, sans-serif">`,
    `<rect width="${f(W)}" height="${f(h + head)}" fill="#ffffff"/>`,
    `<text x="0" y="4.2" font-size="3.6" font-weight="600" fill="#000000">${title}</text>`,
    `<text x="0" y="8.4" font-size="2.4" fill="#444444">Drawn from the parsed Gerber and drill files, viewed from the top. Grey: copper; circles: holes; line: profile.</text>`,
  ];
  layers.forEach((l, i) => {
    const ox = i * (w + gap);
    const id = `m${i}`;
    out.push(`<g transform="translate(${f(ox + pad - x0)} ${f(head + pad + y1)}) scale(1 -1)">`);
    out.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="${f(x0 - pad)}" y="${f(y0 - pad)}" width="${f(w)}" height="${f(h)}"><rect x="${f(x0 - pad)}" y="${f(y0 - pad)}" width="${f(w)}" height="${f(h)}" fill="#000000"/>`);
    for (const o of l.g.objects) {
      const fill = o.dark ? "#ffffff" : "#000000";
      if (o.type === "region") out.push(`<path d="${path(o.pts)}" fill="${fill}"/>`);
      else if (o.type === "flash") out.push(`<circle cx="${f(o.x)}" cy="${f(o.y)}" r="${f(o.d / 2)}" fill="${fill}"/>`);
    }
    out.push(`</mask>`);
    out.push(`<rect x="${f(x0 - pad)}" y="${f(y0 - pad)}" width="${f(w)}" height="${f(h)}" fill="#8a8a8a" mask="url(#${id})"/>`);
    for (const p of profile) out.push(`<path d="${path(p.pts)}" fill="none" stroke="#000000" stroke-width="0.2"/>`);
    for (const d of drills) out.push(`<circle cx="${f(d.x)}" cy="${f(d.y)}" r="${f(d.d / 2)}" fill="#ffffff" stroke="#000000" stroke-width="0.12"/>`);
    out.push(`</g>`);
    out.push(`<text x="${f(ox + pad)}" y="${f(head + h - 0.8)}" font-size="2.8" fill="#000000">${l.name} (${l.side})</text>`);
  });
  out.push("</svg>");
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- per bundle

const bundles = [
  ...readdirSync(projects).filter((f) => f.endsWith(".json") && f !== "index.json").map((f) => join(projects, f)),
  join(root, "examples", "synthetic", "array2x1.json"),
];

for (const file of bundles) {
  const stem = basename(file).replace(/\.json$/, "");
  const b = JSON.parse(readFileSync(file, "utf8"));
  const geo = bundleGeometry(b);
  const { model: m, files } = fabFiles(b, {}, DATE);
  const isPcb = geo.slabs.length > 0 && geo.copper.size > 0;
  check(m.available === isPcb, stem, `available=${m.available}, expected ${isPcb} (${m.reason ?? ""})`);
  const pkg = packageFiles(b, { fab: true }, {}, new Date(DATE)).map((f) => f.path);
  if (!m.available) {
    check(!!m.reason && /printed circuit board|no substrate|no copper/i.test(m.reason), stem, `unclear reason: ${m.reason}`);
    if (b.half_space) check(/PEC ground/.test(m.reason ?? ""), stem, "reason should mention the PEC ground");
    check(files.length === 0 && !pkg.some((p) => p.startsWith("fab/")), stem, "unavailable design must not produce fab files");
    console.log(`  ${stem}: unavailable, ${m.reason}`);
    continue;
  }
  check(pkg.filter((p) => p.startsWith("fab/")).length === files.length, stem, "package fab/ folder differs from fabFiles");
  const byName = new Map(files.map((f) => [f.path, f.data]));
  const readme = byName.get("README.txt");
  check(!!readme && /35 µm/.test(readme) && /zero-thickness/.test(readme) && /GerbView/.test(readme) && /εr = /.test(readme), stem, "README.txt lacks stack-up/caveats");
  check(!/NaN|undefined|Infinity/.test(files.map((f) => f.data).join("")), stem, "NaN/undefined in fab files");
  // the files are generated now: stamped with the running app's version (package.json), never the version of the
  // build that wrote the bundle (the examples were written by builds before the first release)
  check(readme.includes(`by Fairbeam ${APP_VERSION}`), stem, `README.txt is not stamped with Fairbeam ${APP_VERSION}`);
  for (const f of files.filter((x) => x.path.endsWith(".gbr"))) check(f.data.includes(`%TF.GenerationSoftware,Fairbeam,Fairbeam,${APP_VERSION}*%`), `${stem} ${f.path}`, "GenerationSoftware is not the running version");
  for (const f of files.filter((x) => x.path.endsWith(".drl"))) check(f.data.includes(`{Fairbeam ${APP_VERSION}}`), `${stem} ${f.path}`, "drill header is not stamped with the running version");
  check(!/Fairbeam 0\.[1-6]\.\d/i.test(files.map((f) => f.data).join("")), stem, "an unreleased version in the fab files");

  // copper layers
  const faces = [...geo.copper.keys()].sort((a, c) => c - a);
  check(faces.length === m.layers.length, stem, `layer count ${m.layers.length}, bundle has ${faces.length} copper faces`);
  const parsedLayers = [];
  faces.forEach((z, i) => {
    const l = m.layers[i];
    const gname = [...byName.keys()].find((p) => p.endsWith(`-${l.name}.gbr`));
    const where = `${stem} ${gname}`;
    const g = readGerber(byName.get(gname), where);
    parsedLayers.push({ name: l.name, side: l.side, g });
    check(g.format[0] === 4 && g.format[1] === 6 && g.units === "MM", where, "format must be 4.6 mm");
    check(/^Fairbeam,Fairbeam,/.test(g.attrs.GenerationSoftware ?? ""), where, "missing .GenerationSoftware Fairbeam");
    check(g.attrs.FilePolarity === "Positive" && g.attrs.Part === "Single", where, "missing .FilePolarity/.Part");
    const side = m.layers.length === 1 ? "Top" : i === 0 ? "Top" : i === m.layers.length - 1 ? "Bot" : "Inr";
    check(g.attrs.FileFunction === `Copper,L${i + 1},${side}`, where, `FileFunction ${g.attrs.FileFunction}`);
    const rings = geo.copper.get(z);
    const regions = g.objects.filter((o) => o.type === "region");
    const flashes = g.objects.filter((o) => o.type === "flash");
    const exact = rings.every(rectilinear);
    const r = compareCopper(rings, regions);
    check(r.bboxErr <= UM, where, `bbox ${r.gb.map((v) => v.toFixed(4))} vs bundle ${r.eb.map((v) => v.toFixed(4))}`);
    if (exact) {
      // area (dark regions do not overlap; clear regions/flashes lie inside copper) and the image
      // on the compression grid (regions in draw order: dark sets, clear erases)
      check(r.areaOk, where, `copper area ${r.net.toFixed(6)} vs bundle ${r.expected.toFixed(6)} mm²`);
      check(r.bad === 0, where, `${r.bad} grid cells differ between the Gerber image and the bundle copper`);
      const flashNet = flashes.reduce((s, o) => s + (o.dark ? 1 : -1) * Math.PI * (o.d / 2) ** 2, 0);
      console.log(`  ${stem} ${l.name}: ${regions.length} region(s), copper ${(r.net + flashNet).toFixed(4)} mm² (sheets ${r.expected.toFixed(4)}, anti-pads ${(-flashNet).toFixed(4)}), bbox ok, ${r.cells} cells identical`);
      // negative control: moving one vertical edge by 2 µm must be caught
      if (i === 0) {
        const o = regions.find((q) => q.dark);
        const k = o.pts.findIndex((p, j) => p[0] === o.pts[(j + 1) % o.pts.length][0]);
        const moved = regions.map((q) => (q === o ? { ...q, pts: q.pts.map((p, j) => (j === k || j === (k + 1) % q.pts.length ? [p[0] + 2 * UM, p[1]] : p)) } : q));
        const rm = compareCopper(rings, moved);
        check(rm.bboxErr > UM || !rm.areaOk || rm.bad > 0, where, "negative control: a 2 µm edge shift went undetected");
      }
    } else console.log(`  ${stem} ${l.name}: non-rectilinear copper, bbox checked only`);
    // anti-pads: one clear flash per probe whose lower end is on this face
    const want = geo.probes.filter((p) => Math.abs(p.z0 - z) < 1e-4);
    check(flashes.length === want.length, where, `${flashes.length} anti-pads, expected ${want.length}`);
    for (const p of want) check(flashes.some((o) => !o.dark && Math.abs(o.x - p.x) <= UM && Math.abs(o.y - p.y) <= UM && Math.abs(o.d - m.options.antipadMm) <= UM), where, `no anti-pad at P${p.number} (${p.x}, ${p.y})`);
    // DXF of the same layer
    const dname = gname.replace(/\.gbr$/, ".dxf");
    const d = readDxf(byName.get(dname), `${stem} ${dname}`);
    if (exact) {
      const cu = d.polylines.filter((p) => p.layer === l.name);
      const net = cu.reduce((s, p) => s + shoelace(p.pts), 0);
      check(Math.abs(net - unionArea(rings)) <= UM * rings.reduce((s, r) => s + perimeter(r), 0), `${stem} ${dname}`, `DXF copper area ${net.toFixed(6)} vs ${unionArea(rings).toFixed(6)}`);
    }
    check(d.circles.filter((c) => c.layer === `${l.name}_Antipad`).length === want.length, `${stem} ${dname}`, "anti-pad circles");
  });

  // board profile
  const pname = [...byName.keys()].find((p) => p.endsWith("-Edge_Cuts.gbr"));
  const pg = readGerber(byName.get(pname), `${stem} ${pname}`);
  check(pg.attrs.FileFunction === "Profile,NP", `${stem} ${pname}`, `FileFunction ${pg.attrs.FileFunction}`);
  const loops = drawLoops(pg.objects);
  check(loops.length > 0 && loops.every((l) => l.closed), `${stem} ${pname}`, "profile must be closed loops");
  const slabRings = geo.slabs.map((s) => s.ring);
  const outlineArea = loops.reduce((s, l) => s + shoelace(l.pts), 0);
  if (slabRings.every(rectilinear)) check(Math.abs(outlineArea - unionArea(slabRings)) <= UM * slabRings.reduce((s, r) => s + perimeter(r), 0), `${stem} ${pname}`, `outline area ${outlineArea} vs ${unionArea(slabRings)}`);
  const ob = bbox(loops.map((l) => l.pts));
  const sb = bbox(slabRings);
  check(ob.every((v, k) => Math.abs(v - sb[k]) <= UM), `${stem} ${pname}`, `outline bbox ${ob} vs substrate ${sb}`);
  readDxf(byName.get(pname.replace(/\.gbr$/, ".dxf")), `${stem} ${pname.replace(/\.gbr$/, ".dxf")}`);

  // drills = probe ports
  const dname = [...byName.keys()].find((p) => p.endsWith("-PTH.drl"));
  const drills = dname ? readExcellon(byName.get(dname), `${stem} ${dname}`).hits : [];
  const vias = b.parts.filter((p) => p.type === "Metal").flatMap((p) => p.primitives.filter((q) => q.kind === "cylinder" && q.start[0] === q.stop[0] && q.start[1] === q.stop[1]));
  check(drills.length === geo.probes.length + vias.length, `${stem} drill`, `${drills.length} hits, expected ${geo.probes.length} probe(s) + ${vias.length} via(s)`);
  for (const p of geo.probes) check(drills.some((h) => Math.abs(h.x - p.x) <= UM && Math.abs(h.y - p.y) <= UM && Math.abs(h.d - m.options.probeDrillMm) <= UM), `${stem} drill`, `no ${m.options.probeDrillMm} mm hit at P${p.number} (${p.x}, ${p.y})`);
  if (drills.length) console.log(`  ${stem} drill: ${drills.map((h) => `Ø${h.d} @ (${h.x}, ${h.y})`).join(", ")} = probe port positions`);

  if (EXAMPLES.includes(stem)) {
    const dir = join(outRoot, stem);
    // written afresh: a file of an earlier export under another name does not stay behind
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f.path), f.data);
    writeFileSync(join(dir, "render.svg"), renderSvg(`${b.name.replace(/&/g, "&amp;").replace(/</g, "&lt;")}: fabrication preview`, parsedLayers, loops, drills));
    console.log(`  wrote examples/fab/${stem}/ (${files.length + 1} files)`);
  }
}

// ---------------------------------------------------------------- version stamps of the other generated files

{
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  check(APP_VERSION === pkg.version, "version", `APP_VERSION ${APP_VERSION} is not package.json's ${pkg.version}`);
  check(releasedVersion("0.7.0") && releasedVersion("0.7.1") && releasedVersion("1.0.0") && !releasedVersion("0.6.0") && !releasedVersion("0.1.0")
    && !releasedVersion("?") && !releasedVersion(undefined), "version", "releasedVersion: 0.7.0 is the first release");
  const example = JSON.parse(readFileSync(join(projects, "patch-antenna.json"), "utf8"));
  check(!releasedVersion(example.generator?.version), "version", `the bundled example says it was written by ${example.generator?.version}: update the check`);
  // the Examples panel footer names no Fairbeam version for a bundle written before the first release
  check(bundleWriter(example) === null, "version", `bundleWriter of an example: ${bundleWriter(example)}`);
  check(bundleWriter({ generator: { version: "0.7.2" } }) === "Fairbeam 0.7.2", "version", "bundleWriter of a released build");
  // an example's technical drawing is generated now: its title block's Generator is the running version
  const svg = technicalDrawing(example, { sheet: "A3", date: "2026-09-25" }).svg;
  check(svg.includes(`Fairbeam ${APP_VERSION}`) && !svg.includes(`Fairbeam ${example.generator.version}`), "version", "the drawing's Generator is not the running version");
  console.log(`  version stamps: Fairbeam ${APP_VERSION} in the fab files and drawings; examples written by ${example.generator.version} name no version`);
}

console.log(`\n${checks} fabrication checks, ${failures} failed. Examples in ${outRoot}`);
if (failures) process.exit(1);
