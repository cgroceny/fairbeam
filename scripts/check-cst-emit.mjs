// Assertions on the text of the CST macro for the shapes and elements added to src/export/cst.ts:
// affine transforms (rotation / mirror / scale / shear), waveguide ports, series and parallel RLC
// lumped elements, wires, circle recognition and general solids of revolution.
//
//   node --experimental-strip-types scripts/check-cst-emit.mjs
//
// The rotation checks do not trust the exporter's own decomposition: they parse the emitted
// `With Transform` blocks back out of the macro and apply them, in order, to the corners of the
// emitted local brick, then compare with matrix * corner. the CST sign convention (right-handed,
// positive angle about +axis) is an assumption; the documentation does not state it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cstMacro, decomposeAffine, DEFAULT_CST_OPTIONS, regularCircle } from "../src/export/cst.ts";
import { Symbols, cstNames } from "../src/export/cstParams.ts";

const base = JSON.parse(readFileSync(new URL("../public/projects/patch-antenna.json", import.meta.url), "utf8"));
const bb = (lo, hi) => [lo, hi];
const mk = (parts, extra = {}) => ({ ...base, parts, ports: [], lumped_elements: [], units: { ...base.units, length_m: 1e-3 }, ...extra });
const metal = (name, primitives) => ({ name, type: "Metal", bbox: bb([0, 0, 0], [1, 1, 1]), primitives });
const prim = (o) => ({ priority: 1, exact: true, bbox: bb([0, 0, 0], [1, 1, 1]), ...o });
let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { checks++; assert.equal(a, b, msg); };
const near = (a, b, tol, msg) => { checks++; assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} != ${b}`); };

/** history blocks of a macro as arrays of VBA statements */
function blocks(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split("\r\n")) {
    const l = raw.trim().replace('" + sStlDir + "', "<STLDIR>");
    if (l === 'sCommand = ""') cur = [];
    else if (cur && l.startsWith("sCommand = sCommand + ")) cur.push(l.slice('sCommand = sCommand + "'.length, -' + vbLf"'.length).replace(/""/g, '"'));
    else if (cur && l.startsWith("AddToHistory")) { out.push(cur); cur = null; }
  }
  return out;
}
const lits = (s) => [...s.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
const mul = (R, p) => [0, 1, 2].map((i) => R[i][0] * p[0] + R[i][1] * p[1] + R[i][2] * p[2]);

/** apply the emitted Transform blocks (x/y/z rotations, mirror, scale, translate, matrix) to points, in order */
function applyTransforms(text, pts, unitScale = 1) {
  let cur = pts.map((p) => [...p]);
  for (const b of blocks(text)) {
    if (b[0] !== "With Transform") continue;
    const get = (k) => { const l = b.find((s) => s.trim().startsWith(`.${k} `)); return l ? lits(l) : null; };
    const how = lits(b.find((s) => s.includes(".Transform ")))[1];
    const v = (a) => a.map(Number);
    if (how === "Rotate") {
      const ang = v(get("Angle")).map((d) => (d * Math.PI) / 180);
      const k = ang.findIndex((a) => a !== 0);
      const [c, s] = [Math.cos(ang[k]), Math.sin(ang[k])];
      const R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      const [i, j] = [(k + 1) % 3, (k + 2) % 3];
      R[i][i] = c; R[i][j] = -s; R[j][i] = s; R[j][j] = c;
      assert.deepEqual(v(get("Center")), [0, 0, 0]);
      cur = cur.map((p) => mul(R, p));
    } else if (how === "Mirror") {
      const nrm = v(get("PlaneNormal"));
      cur = cur.map((p) => { const d = p[0] * nrm[0] + p[1] * nrm[1] + p[2] * nrm[2]; return p.map((x, i) => x - 2 * d * nrm[i]); });
    } else if (how === "Scale") {
      const f = v(get("ScaleFactor"));
      cur = cur.map((p) => p.map((x, i) => x * f[i]));
    } else if (how === "Translate") {
      const t = v(get("Vector"));
      cur = cur.map((p) => p.map((x, i) => x + t[i] * unitScale));
    } else if (how === "Matrix") {
      const m = v(get("Matrix")); // column by column
      const t = v(get("Vector"));
      cur = cur.map((p) => [0, 1, 2].map((i) => m[i] * p[0] + m[3 + i] * p[1] + m[6 + i] * p[2] + t[i]));
    } else assert.fail(`unexpected transform ${how}`);
  }
  return cur;
}
function brickCorners(text) {
  const bl = blocks(text).find((b) => b[0] === "With Brick");
  assert.ok(bl, "a Brick block");
  const r = ["Xrange", "Yrange", "Zrange"].map((k) => lits(bl.find((s) => s.includes(`.${k} `))).map(Number));
  return Array.from({ length: 8 }, (_, k) => [0, 1, 2].map((a) => r[a][(k >> a) & 1]));
}

const rotMat = (ax, ay, az) => {
  const [a, b, c] = [ax, ay, az].map((d) => (d * Math.PI) / 180);
  const Rx = [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const Ry = [[Math.cos(b), 0, Math.sin(b)], [0, 1, 0], [-Math.sin(b), 0, Math.cos(b)]];
  const Rz = [[Math.cos(c), -Math.sin(c), 0], [Math.sin(c), Math.cos(c), 0], [0, 0, 1]];
  const m = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  return m(Rz, m(Ry, Rx));
};
const hom = (A, t) => [[...A[0], t[0]], [...A[1], t[1]], [...A[2], t[2]], [0, 0, 0, 1]];
const brickPart = (matrix, extraPrim = {}) => metal("rb", [prim({ kind: "transformed", matrix, primitive: prim({ kind: "box", start: [1, 2, 3], stop: [4, 5, 9] }), ...extraPrim })]);

// ---- 1. numeric decomposition: emitted angles reproduce the matrix (many random + special rotations)
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const angleSets = [[0, 0, 30], [10, 20, 30], [70, -25, 40], [0, 90, 0], [30, 90, 20], [0, -90, 45], [180, 0, 0], [0, 0, 180], [-120, 60, 170]];
for (let i = 0; i < 200; i++) angleSets.push([rnd() * 360 - 180, rnd() * 180 - 90, rnd() * 360 - 180]);
for (const [ax, ay, az] of angleSets) {
  for (const s of [1, 2.5]) {
    const R = rotMat(ax, ay, az);
    const M = hom(R.map((r) => r.map((x) => x * s)), [3, -4, 5]);
    const st = decomposeAffine(M);
    ok(st && !st.shear && !st.mirrorX, "pure rotation");
    const a = st.angles ?? [0, 0, 0];
    const R2 = rotMat(...a);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) near(R2[i][j] * s, M[i][j], 1e-9, `R[${i}][${j}] for ${[ax, ay, az]}`);
  }
}
{
  const st = decomposeAffine(hom(rotMat(0, 0, 30), [0, 0, 0]));
  near(st.angles[2], 30, 1e-9, "z angle");
  eq(st.angles[0], 0, "x angle 0");
  eq(st.angles[1], 0, "y angle 0");
  eq(st.scale, null, "no scale");
  eq(st.translate, null, "no translate");
}
eq(decomposeAffine(hom([[1, 0, 0], [0, 1, 0], [0, 0, 0]], [0, 0, 0])), null, "singular matrix rejected");

// ---- 2. rotated brick, 30 deg about z (+ translation): macro text and replayed geometry
{
  const M = hom(rotMat(0, 0, 30), [10, 20, 0]);
  const { text, warnings } = cstMacro(mk([brickPart(M)]));
  ok(text.includes('.Angle ""0"", ""0"", ""30""'), "z angle in macro");
  ok(text.includes('.Transform ""Shape"", ""Rotate""'), "Transform Rotate");
  ok(text.includes('.Transform ""Shape"", ""Translate""'), "Transform Translate");
  ok(text.includes('.Name ""fairbeam:rb""'), "global name of the solid");
  ok(!text.includes('"Shape", "Scale"') && !text.includes('"Shape", "Mirror"'), "no scale or mirror");
  eq(warnings.filter((w) => /transformed|reflection|shear/.test(w)).length, 0, "no transform warning");
  const got = applyTransforms(text, brickCorners(text));
  got.forEach((g, k) => {
    const w = mul(M, brickCorners(text)[k]).map((x, i) => x + M[i][3]);
    for (let i = 0; i < 3; i++) near(g[i], w[i], 1e-6, `corner ${k} axis ${i}`);
  });
  ok(text.includes('.Vector ""10"", ""20"", ""0""'), "translate vector");
}

// ---- 3. combined x/y/z rotation with uniform scale
{
  const R = rotMat(70, -25, 40);
  const M = hom(R.map((r) => r.map((x) => x * 2)), [-3, 1.5, 7]);
  const { text, warnings } = cstMacro(mk([brickPart(M)]));
  eq((text.match(/\.Transform ""Shape"", ""Rotate""/g) ?? []).length, 3, "three single-axis rotations");
  const order = [...text.matchAll(/\.Angle ""([^"]+)"", ""([^"]+)"", ""([^"]+)""/g)].map((m) => m.slice(1).map(Number).findIndex((a) => a !== 0));
  assert.deepEqual(order, [0, 1, 2]); checks++;
  ok(text.includes('.ScaleFactor ""2"", ""2"", ""2""'), "uniform scale");
  eq(warnings.filter((w) => /transformed|reflection|shear/.test(w)).length, 0, "no warning");
  const corners = brickCorners(text);
  applyTransforms(text, corners).forEach((g, k) => {
    const w = mul(M, corners[k]).map((x, i) => x + M[i][3]);
    for (let i = 0; i < 3; i++) near(g[i], w[i], 1e-6, `corner ${k} axis ${i}`);
  });
  // gimbal lock (y = 90)
  const G = hom(rotMat(30, 90, 20), [0, 0, 0]);
  const t2 = cstMacro(mk([brickPart(G)])).text;
  const c2 = brickCorners(t2);
  applyTransforms(t2, c2).forEach((g, k) => { const w = mul(G, c2[k]); for (let i = 0; i < 3; i++) near(g[i], w[i], 1e-6, `gimbal corner ${k}`); });
}

// ---- 4. mirror (reflection in the matrix), non-uniform scale and shear
{
  const R = rotMat(0, 0, 20);
  const Sx = [[-1, 0, 0], [0, 2, 0], [0, 0, 3]];
  const A = R.map((r) => [0, 1, 2].map((j) => r[0] * Sx[0][j] + r[1] * Sx[1][j] + r[2] * Sx[2][j]));
  const M = hom(A, [1, 2, 3]);
  const { text, warnings } = cstMacro(mk([brickPart(M)]));
  ok(text.includes('.Transform ""Shape"", ""Mirror""'), "Mirror emitted");
  ok(text.includes('.PlaneNormal ""1"", ""0"", ""0""'), "mirror normal x");
  ok(text.includes('.ScaleFactor ""1"", ""2"", ""3""'), "non-uniform scale magnitudes");
  ok(warnings.some((w) => w.includes("contains a reflection")), "reflection warning");
  const corners = brickCorners(text);
  applyTransforms(text, corners).forEach((g, k) => {
    const w = mul(M, corners[k]).map((x, i) => x + M[i][3]);
    for (let i = 0; i < 3; i++) near(g[i], w[i], 1e-6, `mirror corner ${k} axis ${i}`);
  });
  const sh = hom([[1, 0.5, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0]);
  const t3 = cstMacro(mk([brickPart(sh)]));
  ok(t3.text.includes('.Transform ""Shape"", ""Matrix""'), "Matrix transform for a shear");
  ok(t3.warnings.some((w) => w.includes("shear")), "shear warning");
  const c3 = brickCorners(t3.text);
  applyTransforms(t3.text, c3).forEach((g, k) => { const w = mul(sh, c3[k]); for (let i = 0; i < 3; i++) near(g[i], w[i], 1e-6, "shear corner"); });
  const sing = cstMacro(mk([brickPart(hom([[1, 0, 0], [0, 1, 0], [0, 0, 0]], [0, 0, 0]))]));
  ok(sing.warnings.some((w) => w.includes("singular")), "singular warning");
  ok(!sing.text.includes("With Brick"), "singular matrix emits nothing");
}

// ---- 5. waveguide port
{
  const wr = (extra) => ({ number: 1, type: "waveguide", R: 500, direction: "z", start: [-11.43, -5.08, 0], stop: [11.43, 5.08, 8], excite: true, mode: "TE10", a: 22.86, b: 10.16, ...extra });
  const { text, warnings } = cstMacro(mk([metal("p", [prim({ kind: "box", start: [0, 0, 0], stop: [1, 1, 1] })])], { ports: [wr({}), wr({ number: 2, direction: "x", start: [20, -11.43, -5.08], stop: [12, 11.43, 5.08], mode: "TE20" })] }));
  ok(text.includes("With Port"), "With Port");
  ok(text.includes('.PortNumber ""1""') && text.includes('.Orientation ""zmin""') && text.includes('.Coordinates ""Free""'), "port 1 header");
  ok(text.includes('.Xrange ""-11.43"", ""11.43""') && text.includes('.Yrange ""-5.08"", ""5.08""') && text.includes('.Zrange ""0"", ""0""'), "port 1 plane");
  ok(text.includes('.Orientation ""xmax""') && text.includes('.Xrange ""20"", ""20""'), "port 2 on x, fed toward -x");
  ok(text.includes('.NumberOfModes ""1""'), "one mode");
  ok(!warnings.some((w) => w.includes("port 1")), "port 1 no warning");
  ok(warnings.some((w) => w.includes("port 2") && w.includes("TE20")), "TE20 mode warning");
  ok(text.includes("fairbeam-data:") && text.includes('"type":"waveguide"'), "fairbeam-data record kept");
}

// ---- 6. lumped RLC
{
  const el = (o) => ({ name: "e", label: "e", direction: "x", start: [0, 0, 0], stop: [2, 1, 0], ...o });
  const run = (e) => cstMacro(mk([metal("p", [prim({ kind: "box", start: [0, 0, 0], stop: [1, 1, 1] })])], { lumped_elements: [e] }));
  const ser = run(el({ type: "rlc", R: 10, L: 1e-9, C: 2e-12, topology: "series" }));
  ok(ser.text.includes('.SetType ""RLCSerial""') && ser.text.includes('.SetR ""10""') && ser.text.includes('.SetL ""1""') && ser.text.includes('.SetC ""2""'), "series RLC (L in nH, C in pF)");
  ok(ser.text.includes('.SetUnit ""Inductance"", ""nH""') && ser.text.includes('.SetUnit ""Capacitance"", ""pF""'), "the macro states the nH and pF units the RLC values use");
  const par = run(el({ type: "rlc", L: 5e-9, C: 1e-12, topology: "parallel", name: "p" }));
  ok(par.text.includes('.SetType ""RLCParallel""') && par.text.includes('.SetR ""0""') && par.text.includes('.SetL ""5""'), "parallel LC (R absent)");
  const res = run(el({ type: "resistor", R: 100 }));
  ok(res.text.includes('.SetType ""RLCSerial""') && res.text.includes('.SetR ""100""') && res.text.includes('.SetL ""0""'), "resistor stays a series R");
  ok(res.text.includes('"resistor":"e"'), "resistor data record unchanged");
  ok(ser.text.includes('"rlc":"e"') && ser.text.includes('"topology":"series"'), "rlc data record");
  ok(run(el({ type: "rlc", topology: "series" })).warnings.some((w) => w.includes("skipped")), "empty element skipped");
  ok(run(el({ type: "rlc", R: -1, topology: "series" })).warnings.some((w) => w.includes("skipped")), "negative value skipped");
}

// ---- 7. wires
{
  const pts = [[0, 0, 0], [0, 0, 10], [5, 0, 10]];
  const { text, warnings } = cstMacro(mk([metal("w", [prim({ kind: "wire", points: pts, radius: 0.25, bbox: bb([-0.25, -0.25, -0.25], [5.25, 0.25, 10.25]) })]),
    metal("c", [prim({ kind: "curve", points: pts })])]));
  ok(text.includes("With Polygon3D") && text.includes('.Point ""5"", ""0"", ""10""'), "Polygon3D curve");
  ok(text.includes('.Type ""Curvewire""') && text.includes('.Radius ""0.25""') && text.includes('.SolidWireModel ""True""'), "radius wire");
  ok(text.includes(".ConvertToSolidShape") && text.includes('.SolidName ""fairbeam:w""'), "wire converted to a solid");
  ok(text.includes('.Radius ""0.0""') && text.includes('.Material ""PEC""'), "zero-radius curve wire");
  ok(!warnings.some((w) => w.includes("thin")), "no thin-wire skip warning");
}

// ---- 8. circles
{
  const ngon = (N, r, cu, cv, phase = 0) => Array.from({ length: N }, (_, i) => [cu + r * Math.cos(phase + (2 * Math.PI * i) / N), cv + r * Math.sin(phase + (2 * Math.PI * i) / N)].map((x) => Math.round(x * 1e6) / 1e6));
  const poly = (kind, normal, pts, extra = {}) => prim({ kind, normal, elevation: 1.5, points: pts, ...extra });
  const circ = cstMacro(mk([metal("disc", [poly("polygon", 2, ngon(64, 2.5, 1, 2))])]));
  ok(circ.text.includes("With Circle"), "circle");
  ok(circ.text.includes('.Radius ""2.5""') && circ.text.includes('.Xcenter ""1""') && circ.text.includes('.Ycenter ""2""') && circ.text.includes('.Segments ""0""'), "circle numbers");
  ok(circ.text.includes("With CoverCurve") && !circ.text.includes("With Polygon"), "covered circle, no polygon");
  ok(circ.text.includes('WCS.SetOrigin ""0"", ""0"", ""1.5""'), "plane elevation through the WCS");
  const cx = cstMacro(mk([metal("discx", [poly("polygon", 0, ngon(100, 0.8, -1, 3))])]));
  ok(cx.text.includes("With Circle") && cx.text.includes('WCS.SetNormal ""1"", ""0"", ""0""') && cx.text.includes('.Xcenter ""-1""') && cx.text.includes('.Ycenter ""3""'), "circle on an x-normal plane uses the same WCS handling");
  const ext = cstMacro(mk([metal("cyl", [poly("linpoly", 2, ngon(64, 2, 0, 0), { length: 3 })])]));
  ok(ext.text.includes("With Circle") && ext.text.includes("With ExtrudeCurve"), "circle extrusion");
  const bad = ngon(64, 2.5, 1, 2);
  bad[10] = [bad[10][0] * 1.01, bad[10][1] * 1.01];
  const irr = cstMacro(mk([metal("irr", [poly("polygon", 2, bad)])]));
  ok(irr.text.includes("With Polygon") && !irr.text.includes("With Circle"), "perturbed 64-gon stays a polygon");
  const odd = cstMacro(mk([metal("n32", [poly("polygon", 2, ngon(32, 2, 0, 0))])]));
  ok(odd.text.includes("With Polygon") && !odd.text.includes("With Circle"), "32-gon stays a polygon");
  const stretched = ngon(64, 2, 0, 0).map(([u, v]) => [u * 1.2, v]);
  ok(cstMacro(mk([metal("ell", [poly("polygon", 2, stretched)])])).text.includes("With Polygon"), "ellipse stays a polygon");
  const uneven = ngon(64, 2, 0, 0).map(([u, v], i) => (i === 5 ? [2 * Math.cos(0.5), 2 * Math.sin(0.5)] : [u, v]));
  eq(regularCircle(uneven), null, "unevenly spaced points on the circle are not a regular N-gon");
  const rc = regularCircle(ngon(66, 4, 1, -1, 0.3));
  ok(rc && Math.abs(rc.r - 4) < 1e-5 && Math.abs(rc.cu - 1) < 1e-5 && Math.abs(rc.cv + 1) < 1e-5, "phase-shifted 66-gon recognised");
  // two half rings (zero-length tube) are not N-gon circles
  const half = Array.from({ length: 33 }, (_, i) => [2 * Math.cos((Math.PI * i) / 32), 2 * Math.sin((Math.PI * i) / 32)]);
  eq(regularCircle(half), null, "half ring is not a circle");
}

// ---- 9. general solid of revolution (neither cone nor torus)
{
  const prof = [[0, 0], [3, 0], [3, 2], [1, 3], [0, 3]];
  const { text, warnings } = cstMacro(mk([metal("rev", [prim({ kind: "rotpoly", axis: 2, origin: [1, 2, 0], points: prof, bbox: bb([-2, -1, 0], [4, 5, 3]) })])]));
  ok(text.includes("With Rotate") && text.includes('.Angle ""360.0""') && text.includes('.Origin ""1"", ""2"", ""0""'), "Rotate block");
  ok(text.includes('.Rvector ""1"", ""0"", ""0""') && text.includes('.Zvector ""0"", ""0"", ""1""'), "profile plane vectors");
  ok(text.includes('.Point ""0"", ""0""') && text.includes('.LineTo ""3"", ""0""') && text.includes('.LineTo ""1"", ""3""'), "profile points");
  ok(!warnings.some((w) => w.includes("solid of revolution")), "no revolution warning");
}

// ---- 10. polyhedra: an STL file next to the macro, imported with the STL object (CST help: VBA > Import/Export > STL Object)
{
  const cube = (lo, hi) => {
    const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
    return prim({ kind: "polyhedron", vertices: [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
      faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]], bbox: bb(lo, hi) });
  };
  const stlVerts = (data) => [...data.matchAll(/vertex (\S+) (\S+) (\S+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  const volume = (v) => { let s = 0; for (let i = 0; i < v.length; i += 3) { const [a, b, c] = [v[i], v[i + 1], v[i + 2]]; s += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6; } return s; };
  const bounds = (v) => [0, 1, 2].map((i) => [Math.min(...v.map((p) => p[i])), Math.max(...v.map((p) => p[i]))]);

  // plain polyhedron, length unit mm: 12 triangles, bounds as drawn, positive volume
  const plain = cstMacro(mk([metal("blk", [cube([1, 2, 3], [3, 5, 8])])]), undefined, { macroBase: "my-model" });
  eq(plain.files.length, 1, "one STL file");
  eq(plain.files[0].name, "my-model_blk.stl", "STL file name");
  ok(!plain.warnings.some((w) => /polyhedron/.test(w)), "no polyhedron warning when the STL is written");
  const v = stlVerts(plain.files[0].data);
  eq(v.length, 36, "12 triangles (6 quad faces fanned)");
  ok(/^solid blk\n/.test(plain.files[0].data) && /endsolid blk\n$/.test(plain.files[0].data), "ASCII STL framing");
  ok(JSON.stringify(bounds(v)) === JSON.stringify([[1, 3], [2, 5], [3, 8]]), "STL bounds = polyhedron bounds");
  near(volume(v), 2 * 3 * 5, 1e-9, "outward winding (positive volume)");
  const stlBlock = blocks(plain.text).find((b) => b[0] === "With STL");
  ok(stlBlock, "With STL block");
  const t = plain.text;
  ok(t.includes('sCommand = sCommand + "     .FileName """ + sStlDir + "my-model_blk.stl""" + vbLf'), "FileName is STL folder + file");
  for (const line of ['     .Name "blk"', '     .Component "fairbeam"', '     .ScaleToUnit "True"', '     .ImportFileUnits "mm"', "     .Read"])
    ok(t.includes(line.replace(/"/g, '""')), `STL block has ${line.trim()}`);
  ok(t.includes('Solid.ChangeMaterial ""fairbeam:blk"", ""PEC""'), "material set after the STL import (the STL object has no material)");
  ok(t.includes("Const STL_FOLDER As String") && t.includes("Function FairbeamStlFolder") && t.includes('GetProjectPath("Root")'), "STL folder constant and finder");
  ok(!cstMacro(mk([metal("b", [prim({ kind: "box", start: [0, 0, 0], stop: [1, 1, 1] })])])).text.includes("STL"), "no STL machinery without polyhedra");

  // units: a cm bundle is a cm project (coordinates as drawn, ImportFileUnits "cm"); a mil bundle is rescaled to mm
  const cm = cstMacro(mk([metal("blk", [cube([1, 2, 3], [3, 5, 8])])], { units: { ...base.units, length_m: 1e-2 } }));
  ok(JSON.stringify(bounds(stlVerts(cm.files[0].data))) === JSON.stringify([[1, 3], [2, 5], [3, 8]]) && cm.text.includes('.ImportFileUnits ""cm""'), "cm bundle: STL in cm, imported as cm");
  const mil = cstMacro(mk([metal("blk", [cube([1000, 2000, 3000], [3000, 5000, 8000])])], { units: { ...base.units, length_m: 2.54e-5 } }));
  ok(JSON.stringify(bounds(stlVerts(mil.files[0].data))) === JSON.stringify([[25.4, 76.2], [50.8, 127], [76.2, 203.2]]) && mil.text.includes('.ImportFileUnits ""mm""'), "mil bundle: STL rescaled to mm");

  // transforms are applied to the vertices: rotate 90 deg about z, mirror, translate
  const M = [[0, -1, 0, 5], [1, 0, 0, -1], [0, 0, 1, 2], [0, 0, 0, 1]];
  const rot = cstMacro(mk([metal("blk", [prim({ kind: "transformed", primitive: cube([1, 2, 3], [3, 5, 8]), matrix: M, bbox: bb([0, 0, 0], [1, 1, 1]) })])]));
  const rv = stlVerts(rot.files[0].data);
  const want = stlVerts(plain.files[0].data).map((p) => [0, 1, 2].map((i) => M[i][0] * p[0] + M[i][1] * p[1] + M[i][2] * p[2] + M[i][3]));
  ok(rv.length === 36 && rv.every((p, i) => p.every((c, k) => Math.abs(c - want[i][k]) < 1e-9)), "rotated polyhedron: STL vertices = matrix * vertices");
  ok(!/With Transform/.test(rot.text), "the transform is baked into the STL, not repeated in CST");
  const MM = [[-1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const mir = cstMacro(mk([metal("blk", [prim({ kind: "transformed", primitive: cube([1, 2, 3], [3, 5, 8]), matrix: MM, bbox: bb([-3, 2, 3], [-1, 5, 8]) })])]));
  const mv = stlVerts(mir.files[0].data);
  ok(JSON.stringify(bounds(mv)) === JSON.stringify([[-3, -1], [2, 5], [3, 8]]), "mirrored polyhedron bounds");
  near(volume(mv), 30, 1e-9, "mirrored polyhedron is wound outward again");
  const sing = cstMacro(mk([metal("blk", [prim({ kind: "transformed", primitive: cube([1, 2, 3], [3, 5, 8]), matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]], bbox: bb([0, 0, 0], [1, 1, 1]) })])]));
  ok(sing.files.length === 0 && sing.warnings.some((w) => /transformed polyhedron skipped/.test(w)), "a singular matrix is a warning, no file");
  const bad = cstMacro(mk([metal("blk", [prim({ kind: "polyhedron", vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, NaN]], faces: [[0, 1, 2], [0, 1, 3], [1, 2, 3], [0, 2, 3]] })])]));
  ok(bad.files.length === 0 && bad.warnings.some((w) => /polyhedron skipped/.test(w)), "non-finite polyhedron: warning and no file");

  // a polyhedron as the second shape of a part is united into the first, after its material is set
  const two = cstMacro(mk([metal("blk", [prim({ kind: "box", start: [0, 0, 0], stop: [1, 1, 1] }), cube([4, 4, 4], [6, 6, 6])])]));
  const txt = two.text;
  ok(txt.indexOf("Solid.ChangeMaterial") < txt.indexOf('Solid.Add ""fairbeam:blk_1"", ""fairbeam:blk_2""'), "STL material set before the union");
  eq(two.files[0].name, "patch-antenna_blk_2.stl", "STL named after the solid (<model id>_<part>_<n>)");
}

// ---- 11. an anisotropic material warns only when the bundle says so
{
  const dielectric = (isotropic) => ({ name: "sub", type: "Material", bbox: bb([0, 0, 0], [1, 1, 1]), material: { eps_r: 4, kappa: 0, mu_r: 1, tan_d: null, tan_d_freq: null, ...(isotropic === undefined ? {} : { isotropic }) },
    primitives: [prim({ kind: "box", start: [0, 0, 0], stop: [1, 1, 1] })] });
  ok(cstMacro(mk([dielectric(false)])).warnings.some((w) => /anisotropic/.test(w)), "anisotropic material warns");
  ok(!cstMacro(mk([dielectric(true)])).warnings.some((w) => /anisotropic/.test(w)), "isotropic material: no warning");
  ok(!cstMacro(mk([dielectric(undefined)])).warnings.some((w) => /anisotropic/.test(w)), "bundle without the isotropic flag: no false warning");
}

// ---- 12. parametric export: design parameters become CST parameters, expressions become CST expressions
{
  // every translation below was resolved by the macro's host application (a project with a=2, b=3, W=30, f0=2.4, x_neg=-2.7) and gave
  // the value fairbeam's evaluator gives, to 1e-9; null: no CST equivalent, the number is written
  const S = new Symbols([{ key: "a", default: 2 }, { key: "b", default: 3 }, { key: "W", default: 30 }, { key: "f0", default: 2.4 }, { key: "x_neg", default: -2.7 }]);
  const table = [
    ["a+b", "a + b"],
    ["a-b-1", "a - b - 1"],
    ["a-(b-1)", "a - (b - 1)"],
    ["a*b+1", "a*b + 1"],
    ["a*(b+1)", "a*(b + 1)"],
    ["a/b/2", "a/b/2"],
    ["a/(b*2)", "a/(b*2)"],
    ["-a**2", "-a^2"],
    ["(-a)**2", "(-a)^2"],
    ["a**b**2", "a^(b^2)"],
    ["2**-1", "2^(-1)"],
    ["a**-b", "a^(-b)"],
    ["-(a+b)", "-(a + b)"],
    ["- -a", "-(-a)"],
    ["a*-b", "a*(-b)"],
    ["sqrt(a+b+11)", "Sqr(a + b + 11)"],
    ["sin(a)", "sin(a)"],
    ["cos(a)", "cos(a)"],
    ["tan(0.5*a)", "tan(0.5*a)"],
    ["asin(0.3)", "asin(0.3)"],
    ["acos(0.3)", "acos(0.3)"],
    ["atan(a)", "Atn(a)"],
    ["exp(a/3)", "exp(a/3)"],
    ["log(W)", "log(W)"],
    ["log(W, 2)", "(log(W)/log(2))"],
    ["log10(W)", "(log(W)/log(10))"],
    ["abs(-a*b)", "abs(-a*b)"],
    ["min(a,b)", "min(a, b)"],
    ["max(a,b)", "max(a, b)"],
    ["min(a,b,1.5)", "min(a, min(b, 1.5))"],
    ["max(a,b,7,2)", "max(a, max(b, max(7, 2)))"],
    ["round(2.5)", "round(2.5)"],
    ["round(3.5+a)", "round(3.5 + a)"],
    ["floor(x_neg)", "Int(x_neg)"],
    ["ceil(x_neg)", "(-Int(-x_neg))"],
    ["floor(a/b)", "Int(a/b)"],
    ["ceil(a/b)", "(-Int(-(a/b)))"],
    ["radians(180)", "(180*pi/180)"],
    ["degrees(1)", "(1*180/pi)"],
    ["wavelength(f0)", "(299.792458/f0)"],
    ["pi*a", "pi*a"],
    ["c0/1e9", "299792458/1000000000"],
    ["eps0*1e12", "8.8541878128e-12*1000000000000"],
    ["mu0*1e6", "1.25663706212e-6*1000000"],
    ["W//7", "Int(W/7)"],
    ["W%7", "(W - 7*Int(W/7))"],
    ["x_neg%2", "(x_neg - 2*Int(x_neg/2))"],
    ["x_neg//2", "Int(x_neg/2)"],
    ["7.5%a", "(7.5 - a*Int(7.5/a))"],
    ["1e-3*W", "0.001*W"],
    ["W/2+0.5", "W/2 + 0.5"],
    ["wavelength(f0)/4", "(299.792458/f0)/4"],
    ["sqrt(a)*sqrt(b)", "Sqr(a)*Sqr(b)"],
    ["-W/2", "-W/2"],
    ["(-W)/2", "-W/2"],
    ["2*-W", "2*(-W)"],
    ["a+-b", "a + (-b)"],
    ["min(a, -b)", "min(a, -b)"],
    ["round(a+0.5)", "round(a + 0.5)"],
    ["atan2(a,b)", null],
    ["round(a/3, 2)", null],
  ];
  for (const [expr, want] of table) {
    const t = S.text(expr);
    eq("s" in t ? t.s : null, want, `translation of ${expr}`);
  }
  // names: reserved, case-insensitive, odd characters
  const nm = cstNames(["W", "w", "sin", "Sqr", "Name", "pi_", "_x", "a b", "eps0", "mu0", "h"]);
  eq([...nm.values()].join(","), "W,w_2,sin_p,Sqr_p,Name_p,pi_,x,a_b,eps0_p,mu0_p,h", "CST parameter names");
  ok(new Set([...nm.values()].map((v) => v.toLowerCase())).size === nm.size, "names are unique without regard to case");

  // a parametric patch: the bundle holds the numbers, the design the expressions
  const params = [{ key: "W", default: 20 }, { key: "L", default: 10 }, { key: "h", default: 2 }, { key: "feed", default: 3 }, { key: "gx", expr: "W*2", label: "Ground x" }, { key: "f_hi", default: 3 }];
  const parts = [
    { name: "sub", type: "Material", bbox: bb([-20, -10, 0], [20, 10, 2]), material: { eps_r: 4, kappa: 0, mu_r: 1, tan_d: null, tan_d_freq: null, isotropic: true }, primitives: [prim({ kind: "box", start: [-20, -10, 0], stop: [20, 10, 2] })] },
    metal("patch", [prim({ kind: "box", start: [-10, -5, 2], stop: [10, 5, 2] })]),
    metal("pin", [prim({ kind: "cylinder", start: [-3, 0, 0], stop: [-3, 0, 2], radius: 0.5 })]),
    metal("tri", [prim({ kind: "linpoly", normal: 2, elevation: 5, length: 1, points: [[0, 0], [10, 0], [5, 5]] })]),
    metal("moved", [prim({ kind: "box", start: [30, 30, 0], stop: [32, 32, 1] })]),
  ];
  const design = {
    params,
    materials: [{ name: "fr4", eps_r: "4" }],
    parts: [
      { name: "sub", material: "fr4", primitives: [{ kind: "box", start: ["-gx/2", "-L", 0], stop: ["gx/2", "L", "h"] }] },
      { name: "patch", material: "cu", primitives: [{ kind: "box", start: ["-W/2", "-L/2", "h"], stop: ["W/2", "L/2", "h"] }] },
      { name: "pin", material: "cu", primitives: [{ kind: "cylinder", axis: "z", center: ["-feed", 0], radius: 0.5, range: [0, "h"] }] },
      { name: "tri", material: "cu", primitives: [{ kind: "linpoly", normal: "z", elevation: "h + 3", length: "L/10", points: [[0, 0], ["W/2", 0], ["W/4", "L/2"]] }] },
      // a part with a transform: the bundle holds its result, so it is written as numbers and listed
      { name: "moved", material: "cu", transforms: [{ type: "translate", copies: 1, step: ["W", 0, 0] }], primitives: [{ kind: "box", start: ["feed*10", 30, 0], stop: [32, 32, 1] }] },
    ],
  };
  // the simulation band is 1 to 3 GHz in the bundle: f_max is the parameter f_hi
  const withF = { ...mk(parts), solver: { ...base.solver, excitation: { ...base.solver.excitation, f_min: 1e9, f_max: 3e9 } } };
  const plain = cstMacro(withF);
  ok(!plain.text.includes("MakeSureParameterExists") && plain.parameters.length === 0 && plain.notes.length === 0, "without a design the export is numeric, as before");
  const par = cstMacro(withF, DEFAULT_CST_OPTIONS, { parametric: { ...design, simulation: { f_min: 1, f_max: "f_hi" } } });
  const hs = blocks(par.text);
  const item = (re) => hs.find((b) => b.some((l) => re.test(l)));
  const has = (b, text) => !!b && b.some((l) => l.includes(text));
  const lines = item(/MakeSureParameterExists/);
  ok(has(lines, 'MakeSureParameterExists "W", "20"') && has(lines, 'MakeSureParameterExists "gx", "W*2"'), "parameters: independent ones by value, derived ones by expression");
  ok(has(lines, 'SetParameterDescription "gx", "Ground x"'), "a label is the description");
  eq(par.parameters.map((p) => p.name).join(","), "W,L,h,feed,gx,f_hi", "parameter list returned");
  const sub = hs.find((b) => b[0] === "With Brick" && has(b, '.Name "sub"'));
  ok(has(sub, '.Xrange "-gx/2", "gx/2"'), "brick bounds are expressions");
  ok(has(sub, '.Yrange "-L", "L"') && has(sub, '.Zrange "0", "h"'), "mixed number / expression bounds");
  ok(has(sub, "Brick") && has(item(/\.Epsilon "4"/), '.Epsilon "4"'), "eps_r written as its number when it is not a parameter expression");
  const patch = item(/Curve\.NewCurve "patch_curve"/);
  ok(has(patch, 'WCS.SetOrigin "0", "0", "h"'), "a sheet's elevation is an expression");
  ok(has(patch, '.Point "-W/2", "-L/2"') && has(patch, '.LineTo "W/2", "-L/2"'), "a sheet's corners are expressions");
  const cyl = item(/With Cylinder/);
  ok(has(cyl, '.Xcenter "-feed"') && has(cyl, '.Zrange "0", "h"'), "cylinder centre and range are expressions");
  ok(has(cyl, '.OuterRadius "0.5"'), "a numeric radius stays a number");
  const tri = item(/Curve\.NewCurve "tri_curve"/);
  ok(has(tri, 'WCS.SetOrigin "0", "0", "h + 3"') && has(tri, '.LineTo "W/2", "0"'), "linpoly points and elevation");
  ok(has(item(/With ExtrudeCurve/), '.Thickness "L/10"'), "extrusion thickness");
  ok(par.notes.some((x) => /moved/.test(x) && /transforms, cut-outs and Boolean/.test(x)), "a part with transforms is listed as numbers");
  ok(par.text.includes('Solver.FrequencyRange ""1"", ""f_hi""') || par.text.includes('Solver.FrequencyRange ""1.0"", ""f_hi""') || /FrequencyRange ""[0-9.]+"", ""f_hi""/.test(par.text), "the band follows a parameter");
  ok(par.text.includes("' Written as numbers ("), "the macro lists what stayed a number");

  // an expression whose value is not what the bundle holds is not trusted
  const lying = { ...design, parts: design.parts.map((p) => (p.name === "patch" ? { ...p, primitives: [{ kind: "box", start: ["-W", "-L/2", "h"], stop: ["W/2", "L/2", "h"] }] } : p)) };
  const lie = cstMacro(withF, DEFAULT_CST_OPTIONS, { parametric: lying });
  ok(lie.notes.some((x) => /patch/.test(x) && /not that expression/.test(x)), "a field whose expression disagrees with the geometry is written as a number and listed");
  ok(!has(blocks(lie.text).find((b) => b.some((l) => l.includes("patch_curve"))), '"-W"'), "...and the disagreeing expression is not written");

  // lengths in another unit: numbers
  const cm = cstMacro({ ...withF, units: { ...withF.units, length_m: 1e-2 } }, DEFAULT_CST_OPTIONS, { parametric: design });
  ok(cm.parameters.length === 0 && cm.notes.some((x) => /exported in cm/.test(x)), "a non-mm export is numeric");
  // an untranslatable expression is stored as its number and listed
  const odd = cstMacro(withF, DEFAULT_CST_OPTIONS, { parametric: { ...design, params: [...params, { key: "ang", expr: "atan2(L, W)" }] } });
  ok(odd.notes.some((x) => /ang/.test(x) && /atan2/.test(x)), "atan2 has no CST equivalent: stored as its value, listed");
  ok(odd.parameters.some((p) => p.key === "ang" && !p.expression), "the parameter keeps its value");
}

// a dispersive dielectric (Python Simulation.dispersive): the band-centre constants, the loss as
// Sigma (the record's kappa), and a warning that the poles are not written
{
  const mat = { eps_r: 4.3, kappa: 0.0123, mu_r: 1, tan_d: 0.02, tan_d_freq: 5.5e9, isotropic: true };
  const slab = (name, material) => ({ name, type: "Material", bbox: bb([0, 0, 0], [1, 1, 1]), material,
    primitives: [prim({ kind: "box", start: [0, 0, 0], stop: [1, 1, 1] })] });
  const disp = cstMacro(mk([slab("lam", { ...mat, dispersion: { model: "lorentz", eps_inf: 4.1, kappa: 0, eps_poles: [] } })]));
  ok(disp.warnings.some((w) => w.includes("lam") && w.includes("frequency-dependent (lorentz)") && w.includes("5.5 GHz")),
    "a dispersive material warns that it is exported with its band-centre values");
  ok(disp.text.includes(".Sigma") && disp.text.includes("0.0123"), "the band-centre loss is exported as Sigma");
  const plain = cstMacro(mk([slab("sub", mat)]));
  ok(!plain.warnings.some((w) => w.includes("frequency-dependent")), "a constant material has no dispersion warning");
}

console.log(`CST emit checks passed (${checks} assertions): transforms, waveguide ports, RLC, wires, circles, revolution, polyhedra (STL), parametric export.`);
