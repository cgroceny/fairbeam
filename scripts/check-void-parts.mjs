// Void carver primitives: quickBundle emits a "(cut)" vacuum part, exporters skip it, the CST macro
// subtracts it from its host, the scene classifies it as a ghost.
//
//   node --experimental-strip-types scripts/check-void-parts.mjs
import assert from "node:assert/strict";
import { quickBundle } from "../src/designer/geometry.ts";
import { cstMacro, cstInsertPairs, DEFAULT_CST_OPTIONS } from "../src/export/cst.ts";
import { binaryStl } from "../src/export/mesh.ts";
import { withoutVoids } from "../src/lib/voidParts.ts";
import { technicalDrawing } from "../src/drawing/drawing.ts";
import { isoModel } from "../src/drawing/iso.ts";
import { fabModel } from "../src/fab/layers.ts";
import { ghostHostName, isGhostPart, partKind } from "../src/scene/partKind.ts";

let n = 0;
const ok = (cond, what) => { n++; assert.ok(cond, what); };

const hostBox = { kind: "box", start: [0, 0, 0], stop: [20, 20, 10], priority: 5 };
const hole = { kind: "cylinder", axis: "z", center: [10, 10], radius: 3, range: [-1, 11], void: true };
const design = (primitives, extra = {}) => ({
  model: { id: "void-test", name: "Void test" }, params: [],
  materials: [{ name: "Cu", kind: "metal", color: "#b87333" }],
  parts: [{ name: "Block", material: "Cu", primitives, ...extra }],
  ports: [], simulation: { f_min: 1, f_max: 2, boundaries: "MUR" },
});

// (a) quickBundle
{
  const b = quickBundle(design([hostBox, hole]), {}, null);
  ok(b, "bundle builds");
  ok(b.parts.length === 2, "host plus cut part");
  const [host, cut] = b.parts;
  ok(host.name === "Block" && host.primitives.length === 1 && host.primitives[0].kind === "box", "host keeps only its own shapes");
  ok(!host.void, "host is not void");
  ok(cut.name === "Block (cut)" && cut.void === true && cut.type === "Material", "cut part is a void Material");
  ok(cut.material.eps_r === 1 && cut.material.mu_r === 1, "cut is vacuum");
  ok(cut.primitives.length === 1 && cut.primitives[0].kind === "cylinder", "cut holds the cylinder");
  ok(cut.primitives[0].priority === 5.5, "fractional priority passes through (host max 5 + 0.5)");
  ok(cut.bbox[0][2] === -1 && cut.bbox[1][2] === 11, "cut bbox");
  const explicit = quickBundle(design([hostBox, { ...hole, priority: 42 }]), {}, null);
  ok(explicit.parts[1].primitives[0].priority === 42, "explicit void priority kept");
  const dflt = quickBundle(design([{ kind: "box", start: [0, 0, 0], stop: [1, 1, 1] }, hole]), {}, null);
  ok(dflt.parts[1].primitives[0].priority === 10.5, "metal default priority 10 + 0.5");
  // cached second call returns the same result
  const again = quickBundle(design([hostBox, hole]), {}, null);
  ok(JSON.stringify(again.parts) === JSON.stringify(b.parts), "repeat build is stable");
  ok(quickBundle(design([hostBox]), {}, null).parts.length === 1, "no void, no cut part");
}

// (b) exporters skip voids
const bundle = quickBundle(design([hostBox, hole]), {}, null);
bundle.units = { length: "mm", length_m: 1e-3 };
bundle.generator = { name: "fairbeam", version: "test" };
bundle.created = "2026-01-01T00:00:00Z";
bundle.domain = { min: [-20, -20, -20], max: [40, 40, 30] };
bundle.mesh = { x: [], y: [], z: [], total_cells: 0 };
{
  ok(withoutVoids(bundle).parts.length === 1 && withoutVoids(bundle).parts[0].name === "Block", "withoutVoids drops the cut part");
  const noVoid = { ...bundle, parts: [bundle.parts[0]] };
  ok(withoutVoids(noVoid) === noVoid, "withoutVoids returns the same bundle when there is none");
  const stl = binaryStl(bundle), stlHost = binaryStl(noVoid);
  ok(stl.length === stlHost.length && stl.length > 84, `STL has the host's triangles only (${stl.length} bytes)`);
  ok(isoModel(bundle).lines.length === isoModel(noVoid).lines.length, "iso drawing skips the void");
  ok(technicalDrawing(bundle, { sheet: "figure" }).svg === technicalDrawing(noVoid, { sheet: "figure" }).svg, "technical drawing skips the void");
  ok(JSON.stringify(fabModel(bundle)) === JSON.stringify(fabModel(noVoid)), "fab model skips the void");
}

// (c) CST macro
{
  const { text, warnings } = cstMacro(bundle);
  const lines = text.split("\r\n");
  const sub = lines.filter((l) => l.includes(".Subtract"));
  ok(sub.length === 1, "one Subtract");
  ok(/\.Subtract ""fairbeam:Block"", ""fairbeam:Block_cut_1""/.test(sub[0]), `Subtract names: ${sub[0]}`);
  ok(text.includes('.Material "Vacuum"') || text.includes('"Material", "Vacuum"') || /Vacuum/.test(text), "tool solid is vacuum");
  ok(text.indexOf("Block_cut_1") > text.indexOf('define brick'), "tool is created after the host");
  ok(!/define material: Block \(cut\)/.test(text), "no extra material for the cut");
  ok(!warnings.some((w) => /skipped/.test(w)), "no warnings: " + warnings.join("; "));
  // a void away from the host creates nothing
  const away = quickBundle(design([hostBox, { ...hole, center: [100, 100] }]), {}, null);
  Object.assign(away, { units: bundle.units, generator: bundle.generator, created: bundle.created, domain: bundle.domain, mesh: bundle.mesh });
  ok(!cstMacro(away).text.includes(".Subtract"), "non-overlapping void is not subtracted");
  // two host shapes: the void subtracts from each overlapped one
  const two = quickBundle(design([hostBox, { kind: "box", start: [5, 5, 10], stop: [15, 15, 12], priority: 5 }, hole]), {}, null);
  Object.assign(two, { units: bundle.units, generator: bundle.generator, created: bundle.created, domain: bundle.domain, mesh: bundle.mesh });
  ok(cstMacro(two, { ...DEFAULT_CST_OPTIONS, mergeParts: false }).text.split("\r\n").filter((l) => l.includes(".Subtract")).length === 2, "void subtracts from both overlapping host shapes");
  // Insert
  const ins = { parts: [
    { name: "Ring", booleanHistory: { operation: "insert", A: { primitives: [{ kind: "cylinder" }] }, B: { name: "Core", primitives: [{ kind: "box" }] } } },
    { name: "Core" },
  ] };
  const pairs = cstInsertPairs(ins);
  ok(pairs.length === 1 && pairs[0].host === "Ring" && pairs[0].tool === "Core", "insert pair for a curved insert");
  ok(cstInsertPairs({ parts: [{ name: "R", booleanHistory: { operation: "insert", A: { primitives: [{ kind: "box" }] }, B: { name: "C", primitives: [{ kind: "box" }] } } }, { name: "C" }] }).length === 0, "box-only insert needs no Solid.Insert");
  ok(cstInsertPairs({ parts: [ins.parts[0]] }).length === 0, "missing B part skipped");
  const two2 = { ...bundle, parts: [bundle.parts[0], { ...bundle.parts[0], name: "Core", void: undefined }] };
  const insText = cstMacro(two2, undefined, { inserts: pairs.map((p) => ({ host: "Block", tool: "Core" })) }).text;
  ok(/\.Insert ""fairbeam:Block"", ""fairbeam:Core""/.test(insText), "Solid.Insert emitted");
  console.log(sub[0].trim());
  console.log(insText.split("\r\n").filter((l) => /\.Insert/.test(l)).join("\n"));
}

// (d) scene classification
{
  const [host, cut] = bundle.parts;
  ok(!isGhostPart(host) && isGhostPart(cut), "isGhostPart");
  ok(ghostHostName(cut) === "Block" && ghostHostName(host) === "Block", "ghostHostName");
  ok(partKind(cut) === "other", "a void is not in the material legend");
}

console.log(`void part checks passed (${n})`);
