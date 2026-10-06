// Rotated geometry must retain its footprint in downstream exports and field overlays.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fabModel } from "../src/fab/layers.ts";
import { area } from "../src/fab/polygon.ts";
import { cstMacro } from "../src/export/cst.ts";
import { planeOutline } from "../src/scene/fieldPlaneModel.ts";

const base = JSON.parse(readFileSync(new URL("../public/projects/patch-antenna.json", import.meta.url), "utf8"));
const h = Math.SQRT1_2;
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 3e-6, `${message}: ${actual} != ${expected}`);
const primitives = [
  { kind: "box", start: [-8, -8, 0], stop: [8, 8, 1] },
  { kind: "box", start: [2, 1, 1], stop: [6, 3, 1] },
  { kind: "cylinder", start: [1, 2, 0], stop: [1, 2, 1], radius: 0.2 },
];
function fixture(matrix) {
  const parts = primitives.map((primitive, i) => {
    const low = primitive.start.map((n, a) => Math.min(n, primitive.stop[a]) - (i === 2 && a < 2 ? 0.2 : 0));
    const high = primitive.start.map((n, a) => Math.max(n, primitive.stop[a]) + (i === 2 && a < 2 ? 0.2 : 0));
    const corners = Array.from({ length: 8 }, (_, k) => [0, 1, 2].map(a => k & (1 << a) ? high[a] : low[a]));
    const world = corners.map(p => matrix.slice(0, 3).map(r => r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + r[3]));
    const bbox = [0, 1].map(side => [0, 1, 2].map(a => Math[side ? "max" : "min"](...world.map(p => p[a]))));
    return { name: ["board", "patch", "via"][i], type: i ? "Metal" : "Material", material: i ? undefined : { eps_r: 4.3, tan_d: 0.02 }, primitives: [{ kind: "transformed", primitive: { ...primitive, priority: 1, exact: true, bbox: [low, high] }, matrix, bbox, priority: 1, exact: true }] };
  });
  return { ...base, parts, ports: [], lumped_elements: [], units: { ...base.units, length_m: 1e-3 } };
}
for (const scale of [1, 2]) {
  const matrix = [[h * scale, -h * scale, 0, 10], [h * scale, h * scale, 0, 0], [0, 0, scale, 0], [0, 0, 0, 1]];
  const b = fixture(matrix);
  const fab = fabModel(b);
  assert.equal(fab.available, true, fab.reason ?? "rotated board exports");
  near(area(fab.layers[0].regions[0].outer), 8 * scale * scale, "copper area, not bounding-box area");
  assert.equal(fab.drills.length, 1);
  near(fab.drills[0].x, 10 - h * scale, "rotated via x");
  near(fab.drills[0].y, 3 * h * scale, "rotated via y");
  near(fab.drills[0].d, 0.4 * scale, "scaled via diameter");
  const outline = planeOutline([b.parts[1]], { axis: 2, u_axis: 0, v_axis: 1 });
  assert.equal(outline.length, 1);
  near(Math.abs(area(outline[0].points)), 8 * scale * scale, "field-plane outline area");
  const macro = cstMacro(b);
  assert.equal(macro.warnings.filter(w => w.includes("transformed")).length, 0, "rotated solids now export with CST Transform");
  assert.equal((macro.text.match(/With Brick/g) ?? []).length, 1, "the thick box exports as a local brick");
  assert.equal((macro.text.match(/\.Transform ""Shape"", ""Rotate""/g) ?? []).length, 3, "each rotated solid gets a z rotation");
  assert.ok(macro.text.includes('.Angle ""0"", ""0"", ""45""'), "45 degree rotation about z");
  assert.equal((macro.text.match(/\.Transform ""Shape"", ""Scale""/g) ?? []).length, scale === 2 ? 3 : 0);
}
const tilted = fixture([[1, 0, 0, 0], [0, h, -h, 0], [0, h, h, 0], [0, 0, 0, 1]]);
assert.equal(fabModel(tilted).available, false, "tilted board must not be silently flattened");
console.log("Affine consumer checks passed: planar fabrication, transformed drills, field outlines and honest CST limits.");
