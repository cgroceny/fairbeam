// Boolean parity cases shared by check:boolean (src/designer/booleanParts.ts) and
// python/tests/test_boolean_live.py (python/fairbeam/design.py): the operands, the parameter values
// and, in python/tests/fixtures/boolean_parity.json, the result boxes the TypeScript side computes.
//   node --experimental-strip-types scripts/boolean-parity-cases.mjs --write   (regenerate the fixture)
import { writeFileSync } from "node:fs";
import { booleanResult, materialiseBoolean } from "../src/designer/booleanParts.ts";
import { evaluate } from "../src/designer/expr.ts";

const box = (start, stop, extra = {}) => ({ kind: "box", start, stop, ...extra });
const part = (name, primitives, extra = {}) => ({ name, material: "copper", primitives, ...extra });
const cyl = (axis, center, radius, range) => ({ kind: "cylinder", axis, center, radius, range });
const poly = (points, elevation, length) => ({ kind: "linpoly", normal: "z", elevation, length, points });

const turned = part("A", [box([0, 0, 0], ["W", 2, "H"])], { transforms: [{ type: "move", offset: [1, 0, 0] }, { type: "rotate", axis: "z", center: [0, 0, 0], angle: 90 }] });
const slab = part("B", [box([-1, 0, 0], [0, 5, 1])]);
const inner = booleanResult({ parts: [turned, slab] }, { W: 4, H: 3 }, 0, 1, "subtract").parts[0];

export const cases = [
  { name: "moved and quarter-turned brick minus a brick", history: { operation: "subtract", A: turned, B: slab }, values: [{ W: 4, H: 3 }, { W: 6, H: 2 }] },
  {
    name: "sheet copies united with a strip",
    history: { operation: "add", A: part("S", [box([0, 0, 1], [2, 1, 1])], { transforms: [{ type: "translate", copies: 2, step: ["s", 0, 0] }] }), B: part("T", [box([0, 0, 1], [8, 0.5, 1])]) },
    values: [{ s: 3 }, { s: 2.5 }],
  },
  {
    name: "cut and mirrored sheet intersected",
    history: { operation: "intersect", A: part("P", [box([-5, -5, 0], [5, 5, 0])], { cuts: [{ start: ["-c", "-c", 0], stop: ["c", "c", 0] }], transforms: [{ type: "mirror", plane: "x", keep: false }] }), B: part("Q", [box([0, 0, 0], [10, 10, 0])]) },
    values: [{ c: 1 }, { c: 2 }],
  },
  {
    name: "nested live result with a priority, inserted",
    history: { operation: "insert", A: { ...inner, primitives: inner.primitives.map((p) => ({ ...p, priority: 7 })), booleanHistory: { ...inner.booleanHistory, A: { ...turned, primitives: [box([0, 0, 0], ["W", 2, "H"], { priority: 7 })] }, B: { ...slab, primitives: [box([-1, 0, 0], [0, 5, 1], { priority: 7 })] } } }, B: part("C", [box([-3, 1, 1], [-1, 3, 2])]) },
    values: [{ W: 4, H: 3 }, { W: 5, H: 1.5 }],
  },
  // bricks, extruded polygons and polygon sheets (the slab-and-clip path, python/fairbeam/polyclip.py)
  { name: "brick minus brick: A less exactly the common volume", history: { operation: "subtract", A: part("A", [box([0, 0, 0], ["W", 10, 4])]), B: part("B", [box([5, 5, -2], [15, 15, 6])]) }, values: [{ W: 10 }, { W: 7.5 }] },
  {
    name: "extruded polygon minus a brick through part of its height",
    history: { operation: "subtract", A: part("P", [poly([[0, 0], ["W", 0], ["W", 6], [4, 9], [0, 6]], 0, "h")]), B: part("B", [box([3, -1, 1], [5, 3, 2.5])]) },
    values: [{ W: 8, h: 4 }, { W: 6.5, h: 3 }],
  },
  {
    name: "extruded polygon minus a polygon through it (a hole)",
    history: { operation: "subtract", A: part("P", [poly([[0, 0], [10, 0], [10, 10], [0, 10]], 0, 2)]), B: part("Q", [poly([["c", "c"], [6, 3.5], [5, 7], [3.2, "6-c/4"]], -1, 4)]) },
    values: [{ c: 3 }, { c: 4.1 }],
  },
  {
    name: "polygon sheet minus a rectangular sheet, united and intersected",
    history: { operation: "intersect", A: { ...part("S", [{ kind: "polygon", normal: "z", elevation: "t", points: [[0, 0], [8, 0], [4, 7]] }]), booleanHistory: { operation: "subtract", live: true, A: part("S", [{ kind: "polygon", normal: "z", elevation: "t", points: [[0, 0], [8, 0], [4, 7]] }]), B: part("R", [box([3, -1, "t"], [5, 2, "t"])]) }, primitives: [] }, B: part("C", [box([1, 0.5, "t"], [7, 5, "t"])]) },
    values: [{ t: 1.6 }, { t: 0.8 }],
  },
  {
    name: "quarter-turned extruded polygons along x united",
    history: { operation: "add", A: part("X", [{ kind: "linpoly", normal: "x", elevation: 0, length: "L", points: [[0, 0], [3, 0], [3, 2], [0, 2]] }]), B: part("Y", [{ kind: "linpoly", normal: "y", elevation: 0, length: 2, points: [[1, 1], [4, 1], [2.5, 3]] }], { transforms: [{ type: "rotate", axis: "z", center: [0, 0, 0], angle: 90 }] }) },
    values: [{ L: 5 }, { L: 1.5 }],
  },
  // ---- curved shapes (python/fairbeam/boolean_curved.py): add and insert keep every shape, subtract adds cut-outs
  { name: "brick plus cylinder and polygon: bricks and polygons united, the cylinder kept", history: { operation: "add", A: part("A", [box([0, 0, 0], ["W", 4, 2]), cyl("z", [1, 1], 0.5, [2, "H"])]), B: part("B", [poly([[3, 0], [6, 0], [6, 4], [3, 4]], 0, 2)]) }, values: [{ W: 4, H: 5 }, { W: 5, H: 3 }] },
  { name: "sphere, cone and torus added to a brick, transformed", history: { operation: "add", A: part("A", [box([0, 0, 0], [2, 2, 2]), { kind: "sphere", center: [1, 1, "H"], radius: 0.8 }], { transforms: [{ type: "mirror", plane: "x", keep: true }] }), B: part("B", [{ kind: "cone", axis: "y", center: [1, 1], bottom_radius: 1, top_radius: 0.2, range: [3, 6] }, { kind: "torus", axis: "z", center: [0, 0, 5], major_radius: 3, minor_radius: 0.5 }]) }, values: [{ H: 3 }, { H: 3.5 }] },
  { name: "wire and polyhedron inserted into a brick", history: { operation: "insert", A: part("A", [box([0, 0, 0], [4, 4, 4])]), B: part("B", [{ kind: "wire", points: [[0, 0, 0], [2, 2, "H"]], radius: 0.2 }, { kind: "polyhedron", vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], faces: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]] }]) }, values: [{ H: 4 }, { H: 6 }] },
  { name: "brick minus cylinder: the cylinder becomes a cut-out", history: { operation: "subtract", A: part("A", [box([0, 0, 0], ["W", 10, 4])]), B: part("B", [cyl("z", [5, 5], "r", [-1, 5])]) }, values: [{ W: 10, r: 2 }, { W: 12, r: 1.5 }] },
  { name: "sheet minus a cylinder standing on it (off by rounding, made exact), one crossing it and a cone", history: { operation: "subtract", A: part("G", [box([0, 0, 1.6], [20, 20, 1.6])]), B: part("V", [cyl("z", [5, 5], 1, ["1.6+e", 5]), cyl("z", ["x0", 12], 1, [0, 3]), { kind: "cone", axis: "z", center: [15, 5], bottom_radius: 1, top_radius: 0.5, range: [0, 1.6] }]) }, values: [{ x0: 10, e: 1e-12 }, { x0: 12, e: 0 }] },
  { name: "polygon sheet minus a moved sphere", history: { operation: "subtract", A: part("S", [{ kind: "polygon", normal: "z", elevation: 1, points: [[0, 0], [8, 0], [4, 7]] }]), B: part("B", [{ kind: "sphere", center: [4, 2, 1], radius: 1 }], { transforms: [{ type: "move", offset: ["m", 0, 0] }] }) }, values: [{ m: 0 }, { m: 1 }] },
  { name: "cylinder minus a coaxial through-cylinder is a tube", history: { operation: "subtract", A: part("A", [cyl("z", [1, 2], 5, [0, "h"])]), B: part("B", [cyl("z", [1, 2], 2, [-1, 20])]) }, values: [{ h: 10 }, { h: 6 }] },
  { name: "cylinder minus a coaxial blind cylinder and a tube: counterbore cells", history: { operation: "subtract", A: part("A", [cyl("x", [1, 2], 5, [0, 10])]), B: part("B", [cyl("x", [1, 2], 2, [-1, "d"]), { kind: "cylinder", axis: "x", center: [1, 2], radius: 4, inner_radius: 3, range: [4, 11] }]) }, values: [{ d: 6 }, { d: 3 }] },
  { name: "two subtractions in a row: the cut-outs add up", history: { operation: "subtract", A: part("A", [box([0, 0, 0], [10, 10, 4]), { ...cyl("z", [3, 3], 1, [-1, 5]), void: true }], { booleanHistory: { operation: "subtract", live: true, A: part("A", [box([0, 0, 0], [10, 10, 4])]), B: part("B1", [cyl("z", [3, 3], 1, [-1, 5])]) } }), B: part("B2", [cyl("z", ["c", 7], 1.5, [-1, 5])], { transforms: [{ type: "mirror", plane: "x", point: [5, 0, 0], keep: true }] }) }, values: [{ c: 3 }, { c: 6 }] },
  { name: "brick minus a tube, torus, wire and polyhedron", history: { operation: "subtract", A: part("A", [box([0, 0, 0], [10, 10, 4])]), B: part("B", [{ kind: "cylinder", axis: "z", center: [2, 2], radius: 1, inner_radius: "ri", range: [-1, 5] }, { kind: "torus", axis: "z", center: [6, 6, 2], major_radius: 2, minor_radius: 0.5 }, { kind: "wire", points: [[1, 8, -1], [3, 8, "h"]], radius: 0.3 }, { kind: "polyhedron", vertices: [[7, 1, 0], [9, 1, 0], [7, 3, 0], [7, 1, "h"]], faces: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]] }]) }, values: [{ ri: 0.5, h: 5 }, { ri: 0.7, h: 6 }] },
  { name: "cut-outs through a quarter-turned, mirrored and copied part (cone, torus, cylinder from two points)", history: { operation: "subtract", A: part("A", [box([0, 0, 0], [10, 6, 4])], { transforms: [{ type: "rotate", axis: "x", center: [0, 0, 0], angle: 90 }, { type: "move", offset: [0, 0, "dz"] }] }), B: part("B", [{ kind: "cone", axis: "z", center: [3, 3], bottom_radius: 1, top_radius: 0.3, range: [-1, 3] }, { kind: "torus", axis: "y", center: [6, 2, 2], major_radius: 1.5, minor_radius: 0.4 }, { kind: "cylinder", start: [8, 1, 0], stop: [8, 4, 0], radius: 0.5 }], { transforms: [{ type: "rotate", axis: "z", center: [5, 3, 0], angle: 90 }, { type: "mirror", plane: "y", point: [0, 2, 0], keep: true }] }) }, values: [{ dz: 0 }, { dz: 1.5 }] },
  { name: "tube, wire and polyhedron added to a brick and a polygon", history: { operation: "add", A: part("A", [box([0, 0, 0], [3, 3, 3]), { kind: "cylinder", axis: "x", center: [1, 1], radius: 1, inner_radius: 0.4, range: [3, "L"] }]), B: part("B", [{ kind: "wire", points: [[0, 0, 3], [0, 0, 6]], radius: 0.2 }, { kind: "polyhedron", vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], faces: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]] }, poly([[2, 2], [5, 2], [5, 4]], 0, 1)]) }, values: [{ L: 6 }, { L: 8.5 }] },
  // ---- compact Subtract (the testers' cases): the fewest shapes that stay exact
  { name: "L-notch cut in a sheet: one polygon", history: { operation: "subtract", A: part("A", [box([0, 0, 1], ["W", 6, 1])]), B: part("B", [box([6, 3, 1], [12, 8, 1])]) }, values: [{ W: 10 }, { W: 8 }] },
  { name: "centred hole in a sheet plate: two polygons", history: { operation: "subtract", A: part("A", [box([0, 0, 1], [10, 10, 1])]), B: part("B", [box(["h", "h", 1], [6, 6, 1])]) }, values: [{ h: 4 }, { h: 3 }] },
  { name: "centred hole through a thick plate: two extruded polygons", history: { operation: "subtract", A: part("A", [box([0, 0, 0], [10, 10, "t"])]), B: part("B", [box([4, 4, -1], [6, 6, 5])]) }, values: [{ t: 2 }, { t: 3 }] },
  { name: "pocket in a thick brick: the brick whole and a cut-out", history: { operation: "subtract", A: part("A", [box([0, 0, 0], [10, 10, 4])]), B: part("B", [box([3, 3, "d"], [7, 7, 5])]) }, values: [{ d: 2 }, { d: 1 }] },
  { name: "slit cutting a brick in two", history: { operation: "subtract", A: part("A", [box([0, 0, 0], [10, 6, 2])]), B: part("B", [box(["x0", -1, -1], [5, 7, 3])]) }, values: [{ x0: 4 }, { x0: 3 }] },
  { name: "a brick that B does not touch stays whole", history: { operation: "subtract", A: part("A", [box([0, 0, 0], [4, 4, 2])]), B: part("B", [box(["x0", 0, 0], [12, 4, 2])]) }, values: [{ x0: 6 }, { x0: 3 }] },
  { name: "add a filler back into a pocketed brick: one shape", history: { operation: "add", A: part("A", [box([0, 0, 0], ["W", 10, 4]), { ...box([3, 3, 2], [7, 7, 5]), void: true }]), B: part("B", [box([3, 3, 2], [7, 7, 4])]) }, values: [{ W: 10 }, { W: 12 }] },
  { name: "a sheet minus a thick brick: cut with the brick's cross-section", history: { operation: "subtract", A: part("A", [box([0, 0, "z0"], [10, 10, "z0"])]), B: part("B", [box([3, 3, 0], [6, 6, 2])]) }, values: [{ z0: 1 }, { z0: 1.5 }] },
  { name: "a sheet and a thick brick that does not reach it", history: { operation: "subtract", A: part("A", [box([0, 0, 1], [10, 10, 1])]), B: part("B", [box([3, 3, "z1"], [6, 6, 3])]) }, values: [{ z1: 2 }, { z1: 1 }] },
  { name: "a polygon sheet minus an extruded polygon crossing it", history: { operation: "subtract", A: part("A", [{ kind: "polygon", normal: "z", elevation: 1, points: [[0, 0], [8, 0], [4, 7]] }]), B: part("B", [poly([[3, -1], [5, -1], [5, 2], [3, 2]], 0, "h")]) }, values: [{ h: 2 }, { h: 0.5 }] },
  { name: "add a sheet with a round cut: the cut is folded in", history: { operation: "add", A: part("A", [box([0, 0, 0], [4, 4, 0])], { cuts: [{ kind: "circle", normal: "z", elevation: 0, center: ["c", 2], radius: 1 }] }), B: part("B", [box([3, 0, 0], [7, 4, 0])]) }, values: [{ c: 2 }, { c: 1.5 }] },
  { name: "subtract from a sheet with a polygon cut", history: { operation: "subtract", A: part("A", [box([0, 0, 0], [8, 4, 0])], { cuts: [{ kind: "polygon", normal: "z", elevation: 0, points: [[1, 1], [3, 1], [2, 3]] }] }), B: part("B", [box([5, 0, 0], [6, 4, 0])]) }, values: [{}] },
  // ---- intersect with curved shapes
  { name: "coaxial cylinders and tubes intersected", history: { operation: "intersect", A: part("A", [cyl("y", [0, 0], 5, [0, 10]), { kind: "cylinder", axis: "y", center: [0, 0], radius: 8, inner_radius: 6, range: [0, 10] }]), B: part("B", [{ kind: "cylinder", axis: "y", center: [0, 0], radius: "R", inner_radius: 2, range: [3, 20] }]) }, values: [{ R: 7 }, { R: 4 }] },
  { name: "tube trimmed by a brick across its axis", history: { operation: "intersect", A: part("A", [{ kind: "cylinder", axis: "z", center: [2, 3], radius: 4, inner_radius: 1, range: [0, 10] }]), B: part("B", [box([-5, -5, "z0"], [10, 10, 7])]) }, values: [{ z0: 2 }, { z0: 4.5 }] },
  { name: "cone trimmed by a brick", history: { operation: "intersect", A: part("A", [{ kind: "cone", axis: "x", center: [0, 0], bottom_radius: 4, top_radius: 1, range: [0, 12] }]), B: part("B", [box([3, -9, -9], ["x1", 9, 9])]) }, values: [{ x1: 8 }, { x1: 10 }] },
  { name: "cylinder clipped by a brick over its ring stays a cylinder", history: { operation: "intersect", A: part("A", [cyl("z", [5, 5], 3, [0, 4])]), B: part("B", [box([-9, -9, 1], [19, 19, "t"])]) }, values: [{ t: 3 }, { t: 5 }] },
  { name: "cylinder clipped by a polygon: a 64-gon prism", history: { operation: "intersect", A: part("A", [cyl("z", [5, 5], 3, [0, 4])]), B: part("B", [poly([[4, 0], [10, 0], [10, "y1"], [4, "y1"]], 1, 2)]) }, values: [{ y1: 6 }, { y1: 4 }], tol: 1e-9 },
  { name: "sphere inside a brick stays a sphere", history: { operation: "intersect", A: part("A", [{ kind: "sphere", center: [5, 5, 5], radius: "r" }]), B: part("B", [box([0, 0, 0], [10, 10, 10])]) }, values: [{ r: 2 }, { r: 4 }] },
];

// Refusals: the same message in both implementations
export const refusals = [
  { name: "sphere with cylinder", history: { operation: "intersect", A: part("A", [{ kind: "sphere", center: [0, 0, 0], radius: 2 }]), B: part("B", [cyl("z", [0, 0], 1, [-3, 3])]) }, values: {} },
  { name: "crossing cylinders", history: { operation: "intersect", A: part("A", [cyl("z", [0, 0], 2, [-3, 3])]), B: part("B", [cyl("x", [0, 0], 1, [-3, 3])]) }, values: {} },
  { name: "sphere partly in a brick", history: { operation: "intersect", A: part("A", [{ kind: "sphere", center: [0, 0, 0], radius: 2 }]), B: part("B", [box([0, -5, -5], [5, 5, 5])]) }, values: {} },
  { name: "polyhedron with a cone", history: { operation: "intersect", A: part("A", [{ kind: "polyhedron", vertices: [[0, 0, 0], [3, 0, 0], [0, 3, 0], [0, 0, 3]], faces: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]] }]), B: part("B", [{ kind: "cone", axis: "z", center: [0, 0], bottom_radius: 2, top_radius: 0.5, range: [0, 5] }]) }, values: {} },
  { name: "add of a part with a cut-out", history: { operation: "add", A: part("A", [box([0, 0, 0], [4, 4, 4]), { ...cyl("z", [1, 1], 0.5, [-1, 5]), void: true }]), B: part("B", [cyl("z", [3, 3], 0.5, [0, 3])]) }, values: {} },
  { name: "subtracting a part with a cut-out", history: { operation: "subtract", A: part("A", [box([0, 0, 0], [4, 4, 4])]), B: part("B", [box([0, 0, 0], [1, 1, 1]), { ...cyl("z", [1, 1], 0.5, [-1, 5]), void: true }]) }, values: {} },
  { name: "add of a sheet and a volume", history: { operation: "add", A: part("A", [box([0, 0, 1], [4, 4, 1])]), B: part("B", [box([1, 1, 0], [3, 3, 2])]) }, values: {} },
  { name: "intersect of a volume and a sheet", history: { operation: "intersect", A: part("A", [box([0, 0, 0], [4, 4, 4])]), B: part("B", [box([1, 1, 1], [3, 3, 1])]) }, values: {} },
  { name: "a flat sheet subtracted from a brick", history: { operation: "subtract", A: part("A", [box([0, 0, 0], [4, 4, 4])]), B: part("B", [box([1, 1, 1], [3, 3, 1])]) }, values: {} },
  { name: "a flat shape from a solid", history: { operation: "subtract", A: part("A", [cyl("z", [0, 0], 3, [0, 3])]), B: part("B", [box([-1, -1, 1], [1, 1, 1])]) }, values: {} },
  { name: "a solid and a sheet mixed", history: { operation: "subtract", A: part("A", [box([0, 0, 0], [4, 4, 0]), cyl("z", [0, 0], 1, [0, 3])]), B: part("B", [cyl("z", [2, 2], 0.5, [-1, 1])]) }, values: {} },
];

// A cut-out that came through untouched keeps B's own expressions (keepSource in booleanParts.ts); the build
// (python) has numbers: the fixture compares the shapes at the values, so expressions are evaluated here.
const WORDS = new Set(["kind", "axis", "normal", "label", "name", "material"]);
const numeric = (x, values, key = "") => Array.isArray(x) ? x.map((e) => numeric(e, values, key)) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, e]) => [k, numeric(e, values, k)])) : typeof x === "string" && !WORDS.has(key) ? evaluate(x, values) : x;
export const computed = cases.map((c) => ({ ...c, expected: c.values.map((v) => numeric(materialiseBoolean(c.history, v), v)) }));
export const refused = refusals.map((c) => {
  let message = null;
  try { materialiseBoolean(c.history, c.values); } catch (e) { message = e.message; }
  return { ...c, message };
});

if (process.argv.includes("--write")) {
  writeFileSync(new URL("../python/tests/fixtures/boolean_parity.json", import.meta.url), JSON.stringify(computed, null, 1) + "\n");
  writeFileSync(new URL("../python/tests/fixtures/boolean_refusals.json", import.meta.url), JSON.stringify(refused, null, 1) + "\n");
  console.log("wrote python/tests/fixtures/boolean_parity.json");
}
