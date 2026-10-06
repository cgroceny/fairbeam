// Exact local-to-global drawing-frame checks. Run with:
//   node --experimental-strip-types scripts/check-local-frame.mjs
// The geometry cases pass through the same TS preview and Python design resolver used by the app.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { quickBundle } from "../src/designer/geometry.ts";
import { frameTransforms, isGlobalFrame, localPlaneAxes, localToWorldPoint, validateLocalFrame, worldToLocalPoint, GLOBAL_FRAME } from "../src/designer/localFrame.ts";
import { maps, pt } from "../src/designer/geometry.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const axes = ["x", "y", "z"];
const turns = [0, 90, 180, 270];
let checks = 0;
const check = (condition, message) => {
  checks++;
  if (!condition) throw new Error(message);
};
const near = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
const compare = (a, b, where = "value") => {
  if (typeof a === "number" && typeof b === "number") return near(a, b) || (() => { throw new Error(`${where}: ${a} != ${b}`); })();
  if (Array.isArray(a) && Array.isArray(b)) {
    check(a.length === b.length, `${where}: array lengths differ`);
    a.forEach((value, i) => compare(value, b[i], `${where}[${i}]`));
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
    check(JSON.stringify(ak) === JSON.stringify(bk), `${where}: object keys differ (${ak} vs ${bk})`);
    ak.forEach((key) => compare(a[key], b[key], `${where}.${key}`));
    return;
  }
  check(a === b, `${where}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};

const python = process.env.FAIRBEAM_PYTHON ?? (process.platform === "win32"
  ? (existsSync(join(root, ".venv", "Scripts", "python.exe")) ? join(root, ".venv", "Scripts", "python.exe") : "python")
  : (existsSync(join(root, ".venv", "bin", "python")) ? join(root, ".venv", "bin", "python") : "python3"));
const pythonGeometry = String.raw`
import json, sys, types
from pathlib import Path
pkg = types.ModuleType("fairbeam")
pkg.__path__ = [str(Path(sys.argv[1]) / "python" / "fairbeam")]
sys.modules.setdefault("fairbeam", pkg)
from fairbeam.design import resolve_names, resolve_parts
d = json.load(sys.stdin)
names = resolve_names(d, {})
fields = ("kind", "start", "stop", "radius", "normal", "elevation", "length", "points")
print(json.dumps([[{k: q[k] for k in fields if k in q} for q in p["prims"]] for p in resolve_parts(d, names)]))
`;

function pythonResolved(design) {
  const result = spawnSync(python, ["-c", pythonGeometry, root], {
    input: JSON.stringify(design), encoding: "utf8",
    env: { ...process.env, PYTHONPATH: [join(root, "python"), process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
  });
  if (result.status !== 0) throw new Error(`Python geometry resolver failed: ${result.stderr || result.error}`);
  return JSON.parse(result.stdout);
}

function localBox(normal, elevation, height) {
  const [u, v] = localPlaneAxes(normal).map((axis) => axes.indexOf(axis));
  const start = [0, 0, 0], stop = [0, 0, 0];
  start[u] = -2; stop[u] = 2;
  start[v] = -3; stop[v] = 3;
  start[axes.indexOf(normal)] = `${elevation} + ${height}`;
  stop[axes.indexOf(normal)] = elevation;
  return { kind: "box", start, stop };
}

function designFor(normal, angle, flip = false) {
  const [u, v] = localPlaneAxes(normal);
  const n = axes.indexOf(normal), ui = axes.indexOf(u), vi = axes.indexOf(v);
  const elevation = "E";
  const height = "H"; // H is negative: this exercises below-plane extrusion.
  const ring = [[0, 0], ["W/2", 0], ["W/2 + D", "T"], [0, 3]];
  return {
    schema: "fairbeam.design/1",
    model: { id: "local-frame", name: "Local frame parity" },
    params: [
      { key: "OX", default: 13.25 }, { key: "OY", default: -7.5 }, { key: "OZ", default: 4.125 },
      { key: "E", default: 2.5 }, { key: "H", default: -3.25 }, { key: "W", default: 4 },
      { key: "D", default: 2 }, { key: "T", default: 1.5 },
    ],
    simulation: { f_min: 1, f_max: 2, boundaries: "MUR", end_criteria_db: -40, max_timesteps: 100 },
    materials: [{ name: "PEC", kind: "metal" }],
    parts: [{
      name: "frame-shapes", material: "PEC",
      primitives: [
        localBox(normal, elevation, height),
        { kind: "cylinder", axis: normal, center: ["W/4", -2], radius: 0.75, inner_radius: 0, range: [`${elevation} + ${height}`, elevation] },
        { kind: "polygon", normal, elevation, points: ring },
        { kind: "linpoly", normal, elevation: `${elevation} + ${height}`, length: "-H", points: ring },
      ],
      transforms: frameTransforms({ origin: ["OX", "OY", "OZ"], angle, ...(flip ? { flip } : {}) }, normal),
    }],
    ports: [], resistors: [],
    mesh: { mode: "auto" }, far_field: { enabled: false },
  };
}

const names = { OX: 13.25, OY: -7.5, OZ: 4.125, E: 2.5, H: -3.25, W: 4, D: 2, T: 1.5 };
const expressedFrame = { origin: ["OX", "OY", "OZ"], angle: 90 };
check(validateLocalFrame(expressedFrame, names), "valid parameterized frame is accepted");
compare(frameTransforms(expressedFrame, "z").find((transform) => transform.type === "move").offset,
  expressedFrame.origin, "frame validation preserves parameter expressions");
check(!validateLocalFrame({ origin: ["MISSING_PARAMETER", 0, 0], angle: 0 }, names), "undefined frame parameter is rejected");
check(!validateLocalFrame({ origin: ["1e308 * 10", 0, 0], angle: 0 }, names), "overflowing frame expression is rejected");
check(!validateLocalFrame({ origin: [Infinity, 0, 0], angle: 0 }, names), "nonfinite numeric frame origin is rejected");
check(!validateLocalFrame({ origin: Array(3), angle: 0 }, names), "missing frame origin axes are rejected");
check(!validateLocalFrame({ origin: [0, 0, 0], angle: 45 }, names), "non-quarter-turn rotation is rejected");

for (const normal of axes) for (const angle of turns) for (const flip of [false, true]) {
  const [uAxis, vAxis] = localPlaneAxes(normal).map((axis) => axes.indexOf(axis));
  const normalAxis = axes.indexOf(normal);
  const frame = { origin: ["OX", "OY", "OZ"], angle, ...(flip ? { flip } : {}) };
  const local = [0, 0, 0];
  local[normalAxis] = -2.75;
  local[uAxis] = -5.5;
  local[vAxis] = 8.25;
  const world = localToWorldPoint(normal, local[normalAxis], local[uAxis], local[vAxis], frame, names);
  const back = worldToLocalPoint(normal, world, frame, names);
  local.forEach((value, i) => check(near(back[i], value), `${normal}/${angle}${flip ? "/flip" : ""}: local-world-local axis ${i}`));
  compare(pt(maps(frameTransforms(frame, normal), names)[0], local), world, `${normal}/${angle}${flip ? "/flip" : ""} transform map`);

  const design = designFor(normal, angle, flip);
  const ts = quickBundle(design, names, null);
  check(!!ts, `${normal}/${angle}${flip ? "/flip" : ""}: TypeScript preview exists`);
  const tsPrimitives = ts.parts[0].primitives.map(({ kind, start, stop, radius, normal, elevation, length, points }) =>
    Object.fromEntries(Object.entries({ kind, start, stop, radius, normal, elevation, length, points }).filter(([, value]) => value !== undefined)));
  const pyPrimitives = pythonResolved(design)[0];
  compare(tsPrimitives, pyPrimitives, `${normal}/${angle}${flip ? "/flip" : ""} TS/Python world geometry`);

  const part = design.parts[0];
  check(part.primitives[2].points[2][0] === "W/2 + D" && part.primitives[2].points[2][1] === "T",
    `${normal}/${angle}${flip ? "/flip" : ""}: relative point expressions remain on local primitive`);
  check(part.transforms?.some((transform) => transform.type === "move" && transform.offset[0] === "OX"),
    `${normal}/${angle}${flip ? "/flip" : ""}: parameterized frame translation remains an expression`);
  const frameOriginNormal = names[`O${normal.toUpperCase()}`];
  const worldHeightRange = (flip ? [frameOriginNormal - names.E - names.H, frameOriginNormal - names.E] : [frameOriginNormal + names.E + names.H, frameOriginNormal + names.E]).sort((a, b) => a - b);
  const box = ts.parts[0].primitives.find((primitive) => primitive.kind === "box");
  const [boxLow, boxHigh] = [box.start[normalAxis], box.stop[normalAxis]].sort((a, b) => a - b);
  check(near(boxLow, worldHeightRange[0]) && near(boxHigh, worldHeightRange[1]),
    `${normal}/${angle}${flip ? "/flip" : ""}: negative height stays below the frame plane`);
}

check(isGlobalFrame(GLOBAL_FRAME), "global identity frame is recognized");
check(!isGlobalFrame({ origin: ["OX - 13.25", 0, 0], angle: 0 }), "parameter expression that currently evaluates to zero is retained");
const frozenTransforms = frameTransforms({ origin: ["OX", "OY", "OZ"], angle: 90 }, "z");
const committed = { ...designFor("z", 90).parts[0], transforms: structuredClone(frozenTransforms) };
const beforeReset = quickBundle({ ...designFor("z", 90), parts: [committed] }, names, null).parts[0].primitives;
const reset = structuredClone(GLOBAL_FRAME);
check(frameTransforms(reset, "z").length === 0, "return-to-global clears only the active frame state");
const afterReset = quickBundle({ ...designFor("z", 90), parts: [committed] }, names, null).parts[0].primitives;
compare(beforeReset, afterReset, "reset leaves already-committed part geometry unchanged");

console.log(`local frame: ${checks} checks passed (24 TS/Python orientation parity cases, typed-relative expressions, negative height, reset)`);
