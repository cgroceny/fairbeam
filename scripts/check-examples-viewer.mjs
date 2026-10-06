import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const examples = read("src/runner/examples.ts");
const header = read("src/components/Header.tsx");
const picker = read("src/components/ExamplePicker.tsx");
const home = read("src/home/Home.tsx");
const panel = read("src/components/ModelPanel.tsx");
const app = read("src/App.tsx");
assert.ok(examples.includes("BUNDLED_EXAMPLE_FILES") && examples.includes("bundledExamples.has(entry.file)"));
assert.ok(!examples.includes("designs.has(entry.model)"), "user model runs must not be treated as examples");
assert.ok(header.includes("<ExamplePicker />") && picker.includes("exampleEntries(index())") && home.includes("exampleEntries(index())"));
assert.ok(home.includes("openExampleCopy(sourceModel()!.key, p.file)"), "Start passes the selected example file");
assert.ok(home.includes('m.kind !== "design" && !m.error && !m.readonly'), "bundled examples stay out of the user's Python models list");
assert.ok(picker.includes("openExampleCopy(m.key, source())") && panel.includes("openExampleCopy(sourceModel()!.key, source())"), "viewer passes the loaded example file");
assert.ok(picker.includes("const currentFile = () => pending() ?? source()"), "picker shows the loaded source (or the pick still loading)");
assert.ok(!panel.includes("Run again") && !panel.includes("openRunPanelFrom"));
assert.ok(header.includes('appMode() !== "results"'), "Run toggle is hidden in Examples");
assert.ok(app.includes("!currentModel()?.readonly") && app.includes("when={resultsRunOpen()}"),
  "an already open Run panel is hidden for a bundled example, not for a user's Python model");
assert.ok(!app.includes("when={runOpen() && !DEMO && appMode() !== \"results\"}"),
  "the Run panel of a user's Python model (Start > Python models) stays reachable");
assert.ok(app.includes("exampleEntries(await loadIndex())"), "startup selects from bundled examples only");
console.log("examples viewer checks passed");
