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
// the counts line says what the numbers mean
assert.equal(en["exampleCopy.params"], "Parameters carried over: {carried} of {total} (the others are fixed numbers in the copy) · {expressions} values use them");
assert.ok(!/identical metals share one/.test(en["exampleCopy.carried.body"]) && /the solids' names and labels/.test(en["exampleCopy.carried.body"]) && /the description/.test(en["exampleCopy.carried.body"]),
  "the dialog lists what the copy keeps: names, labels, materials, description");
// a bundled example's id is never offered for the copy (the server refuses it)
assert.ok(dialog.includes("keys.has(candidate) || isReservedDesignId(candidate)") && dialog.includes("!DESIGN_ID_RE.test(base) || isReservedDesignId(base)"));
// the conversion notes: their own field (model.conversion), collapsed in Properties, translated by code
const converter = read("python/fairbeam/example_design.py");
assert.ok(converter.includes('model["conversion"] = {"source": source_name, "notes": notes}') && !converter.includes('"description": f"Converted from bundled example'),
  "the copy keeps the example's description; the notes go to model.conversion");
assert.ok(converter.includes('part["label"] = entry["label"]') && converter.includes('item = {"name": entry["name"], "kind": "metal"}'),
  "solids keep their labels, metals their names");
const pane = read("src/designer/DesignPane.tsx");
assert.ok(/<details class="dz-conversion">[\s\S]*t\("props\.conversionNotes", \{ count: draft\.model\.conversion!\.notes\.length \}\)/.test(pane)
  && pane.includes("hasKey(`exampleCopy.note.${n.code}`) ? t(`exampleCopy.note.${n.code}`, n.values) : n.text"),
  "Properties shows the notes collapsed, in the interface language, with the English text as the fallback");
const tr = JSON.parse(read("src/i18n/tr.json"));
for (const code of [...converter.matchAll(/_note\("(\w+)"/g)].map((m) => m[1])) {
  assert.ok(typeof en[`exampleCopy.note.${code}`] === "string" && typeof tr[`exampleCopy.note.${code}`] === "string", `note ${code} has its text in both languages`);
}
const types = read("src/designer/types.ts"), design = read("python/fairbeam/design.py");
assert.ok(types.includes("conversion?: DesignConversion") && design.includes('if "conversion" in m:'), "the design format holds model.conversion in Python and TS");
const server = read("python/fairbeam/server.py");
assert.ok(server.includes('r"/api/examples/conversion-preview"') && server.includes("preview_example_conversion"));
assert.ok(server.includes('within_tolerance') && server.includes('from .example_design import ExampleConversionError, conversion_preview'));
console.log("example copy UI checks passed");
