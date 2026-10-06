import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const api = read("src/runner/api.ts");
const dialog = read("src/runner/ExampleCopyDialog.tsx");
const en = JSON.parse(read("src/i18n/en.json"));
for (const fragment of ['"/examples/copy"', '"/examples/conversion-preview"', 'from: string; id: string; name: string', 'kind: "design"']) assert.ok(api.includes(fragment), `copy API contract missing ${fragment}`);
assert.ok(dialog.includes("api.copyExample({ from: m.key, id: uniqueId(), name: name().trim(), project: copyExampleFile() ?? undefined })"));
assert.ok(dialog.includes("keys.has(candidate)"), "copy IDs increment on collision");
assert.ok(dialog.includes('setAppMode("design")') && dialog.includes("enterDesign(result.id)"), "copy enters the returned Design");
assert.ok(dialog.includes('t("exampleCopy.meshNote")') && en["exampleCopy.meshNote"].includes("converted mesh uses this example’s own lines") && en["exampleCopy.meshNote"].includes("preview compares cell counts"));
assert.ok(dialog.includes("api.previewExampleConversion") && dialog.includes("previewPending()"), "preview gates creation");
assert.ok(dialog.includes("source_cells") && dialog.includes("design_cells") && dialog.includes('t("exampleCopy.meshDiffers")') && en["exampleCopy.meshDiffers"].includes("more than 30%")
  && en["exampleCopy.cells"].includes("{source_cells}") && en["exampleCopy.cells"].includes("{design_cells}"), "mesh warning shows both counts");
const server = read("python/fairbeam/server.py");
assert.ok(server.includes('r"/api/examples/conversion-preview"') && server.includes("preview_example_conversion"));
assert.ok(server.includes('within_tolerance') && server.includes('from .example_design import ExampleConversionError, conversion_preview'));
console.log("example copy UI checks passed");
