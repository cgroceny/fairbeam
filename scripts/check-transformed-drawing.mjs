// Exact transformed wrapper drawing checks: node --experimental-strip-types scripts/check-transformed-drawing.mjs
import assert from "node:assert/strict";
import { affinePoint, viewDefs, viewShapes } from "../src/drawing/geometry.ts";
import { isoModel } from "../src/drawing/iso.ts";

const close = (a, b, eps = 1e-8) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const c = Math.SQRT1_2;
const z45 = [[c, -c, 0, 3], [c, c, 0, -2], [0, 0, 1, 0], [0, 0, 0, 1]];
const transformed = (primitive, matrix = identity, bbox = [[-100, -100, -100], [100, 100, 100]]) => ({
  kind: "transformed", primitive: { ...primitive, priority: 0, exact: true }, matrix, priority: 0, bbox, exact: true,
});
const part = (primitive, type = "Metal", name = "part") => ({
  name, type, primitives: [primitive], bbox: primitive.bbox, conductor: type === "Metal" ? { conductivity: 5.8e7, thickness: null } : undefined,
});
const bundle = (...parts) => ({ parts, half_space: null });

// The exported affine helper is row-major and maps local points to world coordinates.
const mapped = affinePoint(z45, [2, 1, 4]);
close(mapped[0], 3 + c); close(mapped[1], -2 + 3 * c); close(mapped[2], 4);

// A general-angle transformed solid is projected from its exact vertices, not its world AABB.
const box = transformed({ kind: "box", start: [0, 0, 0], stop: [2, 1, 1] }, z45, [[2.29, -2, 0], [4.42, 0.13, 1]]);
const top = viewShapes({ parts: [part(box)] }, viewDefs("third").top);
assert.equal(top.length, 1);
assert.equal(top[0].role, "metal");
assert.equal(top[0].kind, "poly");
close(top[0].bbox[0], 3 - c);
close(top[0].bbox[1], -2);
close(top[0].bbox[2], 3 + 2 * c);
close(top[0].bbox[3], -2 + 3 * c);

// Reflection combined with an arbitrary rotation still exposes the real top face.
const mirrorZ45 = [[-c, -c, 0, 3], [-c, c, 0, -2], [0, 0, 1, 0], [0, 0, 0, 1]];
const mirroredBox = transformed({ kind: "box", start: [0, 0, 0], stop: [2, 1, 1] }, mirrorZ45, [[3 - 3 * c, -2 - 2 * c, 0], [3, -2 + c, 1]]);
const mirroredTop = viewShapes({ parts: [part(mirroredBox)] }, viewDefs("third").top);
assert.equal(mirroredTop.length, 1, "mirrored transformed box keeps a visible exact outline");
close(mirroredTop[0].bbox[0], 3 - 3 * c);
close(mirroredTop[0].bbox[1], -2 - 2 * c);
close(mirroredTop[0].bbox[2], 3);
close(mirroredTop[0].bbox[3], -2 + c);
const mirroredIso = isoModel(bundle(part(mirroredBox)));
assert.ok(mirroredIso.faces.some((face) => face.pts.length === 4 && face.pts.every((p) => Math.abs(p[2] - 1) < 1e-8)), "mirrored solid retains its outward-facing cap in ISO");

// Concave sheets keep their source vertices in order instead of becoming a convex hull.
const lPoints = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];
const concaveSheet = transformed({ kind: "polygon", normal: 2, elevation: 0, points: lPoints }, identity, [[0, 0, 0], [3, 3, 0]]);
const sheetShape = viewShapes({ parts: [part(concaveSheet, "ConductingSheet")] }, viewDefs("third").top)[0];
assert.equal(sheetShape.kind, "poly");
assert.equal(sheetShape.pts.length, 6);
assert.equal(sheetShape.bbox[2] * sheetShape.bbox[3], 9);
const projectedArea = Math.abs(sheetShape.pts.reduce((sum, p, i) => {
  const q = sheetShape.pts[(i + 1) % sheetShape.pts.length];
  return sum + p[0] * q[1] - p[1] * q[0];
}, 0) / 2);
assert.equal(projectedArea, 5);

// Extruded concave caps remain one exact six-vertex face in the iso model; no fan fills the notch.
const concaveSolid = transformed({ kind: "linpoly", normal: 2, elevation: 0, points: lPoints, length: 2 }, identity, [[0, 0, 0], [3, 3, 2]]);
const isoL = isoModel(bundle(part(concaveSolid, "Material")));
const topCap = isoL.faces.find((face) => face.pts.length === 6 && face.pts.every((p) => Math.abs(p[2] - 2) < 1e-8));
assert.ok(topCap, "concave extrusion should retain its top cap ring as one polygon");

// A transformed hollow cylindrical shell uses its actual mesh surfaces. Its annular end triangles
// must leave the center empty instead of drawing a solid bounding cylinder or convex hull.
const shell = transformed({ kind: "cylindricalshell", start: [0, 0, 0], stop: [0, 0, 3], radius: 1, shell_width: 0.2 }, identity, [[-1.1, -1.1, 0], [1.1, 1.1, 3]]);
const isoShell = isoModel(bundle(part(shell, "Material")));
const topAnnulus = isoShell.faces.filter((face) => face.pts.length === 3 && face.pts.every((p) => Math.abs(p[2] - 3) < 1e-7));
assert.ok(topAnnulus.length > 20, "shell cap is represented by actual surface triangles");
const pointInTriangle = (p, a, b, d) => {
  const sign = (q, r, s) => (q[0] - s[0]) * (r[1] - s[1]) - (r[0] - s[0]) * (q[1] - s[1]);
  const d1 = sign(p, a, b), d2 = sign(p, b, d), d3 = sign(p, d, a);
  return !(d1 < -1e-8 || d2 < -1e-8 || d3 < -1e-8) || !(d1 > 1e-8 || d2 > 1e-8 || d3 > 1e-8);
};
assert.equal(topAnnulus.some((f) => pointInTriangle([0, 0], ...f.pts.map((p) => [p[0], p[1]]))), false, "tube bore remains open through the end cap");

// Rotating a curved primitive also rotates the projected world-space mesh, not just its AABB.
const ry90 = [[0, 0, 1, 5], [0, 1, 0, 2], [-1, 0, 0, 0], [0, 0, 0, 1]];
const cylinder = transformed({ kind: "cylinder", start: [0, 0, 0], stop: [0, 0, 3], radius: 1 }, ry90, [[5, 1, -1], [8, 3, 1]]);
const isoCylinder = isoModel(bundle(part(cylinder)));
const worldPoints = [...isoCylinder.faces.flatMap((face) => face.pts), ...isoCylinder.lines.flatMap((line) => [line.a, line.b])];
assert.ok(worldPoints.length > 50, "transformed cylinder uses its curved world mesh");
const extrema = [0, 1, 2].map((axis) => [Math.min(...worldPoints.map((p) => p[axis])), Math.max(...worldPoints.map((p) => p[axis]))]);
close(extrema[0][0], 5); close(extrema[0][1], 8);
close(extrema[1][0], 1); close(extrema[1][1], 3);
close(extrema[2][0], -1); close(extrema[2][1], 1);

console.log("transformed drawing checks passed");
