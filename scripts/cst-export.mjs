// Write the CST macro of a project bundle (src/export/cst.ts with the default options) to stdout.
//
//   node --experimental-strip-types scripts/cst-export.mjs <bundle.json> [out-dir] [design.json]
//
// With an out-dir, the macro is also written there as <model-id>.bas together with the .stl files of
// its polyhedra (the macro imports them from the folder it runs in or STL_FOLDER).
//
// python/tests/test_cst_import.py uses it to round-trip designs through the real exporter:
// design -> bundle -> CST macro -> fairbeam.cst_import -> design.
//
// With a design file (the design the bundle was built from) the macro is parametric: the design's
// parameters are CST parameters and its geometry is written over them (<model-id>.notes.json in the
// out-dir lists the parameters and what stayed a number).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cstMacro, DEFAULT_CST_OPTIONS } from "../src/export/cst.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: node --experimental-strip-types scripts/cst-export.mjs <bundle.json> [out-dir] [design.json]");
  process.exit(2);
}
const bundle = JSON.parse(readFileSync(file, "utf8"));
const outDir = process.argv[3];
const base = String(bundle.model?.id ?? "fairbeam").replace(/[^A-Za-z0-9_-]+/g, "_") || "fairbeam";
const design = process.argv[4] ? JSON.parse(readFileSync(process.argv[4], "utf8")) : null;
const macro = cstMacro(bundle, DEFAULT_CST_OPTIONS, { macroBase: base, ...(design ? { parametric: design } : {}) });
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${base}.bas`), macro.text);
  for (const f of macro.files) writeFileSync(join(outDir, f.name), f.data);
  if (design) writeFileSync(join(outDir, `${base}.notes.json`), JSON.stringify({ parameters: macro.parameters, notes: macro.notes }, null, 1));
}
process.stdout.write(macro.text);
