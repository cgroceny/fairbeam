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
const start = read("src/runner/startPython.ts");
assert.ok(home.includes("createMemo(runnablePythonModels)") && start.includes("[...python.filter((m) => !m.readonly), ...python.filter((m) => m.readonly)]"),
  "Start lists the user's Python models, then the bundled ones");
assert.ok(home.includes('<Show when={m.readonly}><span class="home-item-tag">{t("home.python.exampleTag")}</span></Show>'), "a bundled Python model is marked example, read-only");
assert.ok(home.includes("onClick={() => openExampleCopy(m.key)}"), "a bundled Python model opens as an editable copy, never as a design linked to a read-only file");
assert.ok(home.includes("models().filter((m) => !m.readonly && (m.error ?"), "the bundled example designs are sources only: not under Your designs");
assert.ok(app.includes("currentModel()?.key === startedPythonModel()") && start.includes("setStartedPythonModel(key);"),
  "a bundled Python model chosen on Start gets its Run panel in Examples");
assert.ok(/createEffect\(on\(appMode, \(mode, previous\) => \{\s*if \(previous !== "results" \|\| mode === "results"\) return;\s*setStartedPythonModel\(null\);\s*if \(runOpen\(\)\) setRunOpen\(false\);/.test(app),
  "leaving Examples closes the Run panel: Design gets its Properties back");
const toggle = read("src/runner/RunToggle.tsx");
assert.ok(toggle.includes('"rs-toggle-on": toggles() && runOpen()') && toggle.includes('const toggles = () => appMode() !== "home" && !designing();'),
  "the designer's Run (a dialog) is never drawn as a pressed toggle");
const panelRun = read("src/components/RunPanel.tsx");
assert.ok(panelRun.includes("<Show when={live.job && (!isTerminal(live.job.status) || live.job.model === modelKey())}>"),
  "a finished run is shown only under its own model");
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
