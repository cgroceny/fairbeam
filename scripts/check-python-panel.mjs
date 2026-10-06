import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panel = readFileSync(new URL("../src/designer/PythonPanel.tsx", import.meta.url), "utf8");
const store = readFileSync(new URL("../src/designer/store.ts", import.meta.url), "utf8");
const core = readFileSync(new URL("../src/designer/sessionCore.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles/python-panel.css", import.meta.url), "utf8");
const exportArea = store.slice(store.indexOf("export async function exportPython()"), store.indexOf("// ------------------------------------------------------------------ structure operations"));

assert.match(exportArea, /if \(dirty\(\)\)[\s\S]*?await save\(\)/, "Python export saves a dirty design first");
assert.match(exportArea, /isDocumentCurrent\(document\)[\s\S]*?dirty\(\)\s*\|\|\s*saving\(\)\s*\|\|\s*conflict\(\)/, "export stops after navigation, edit, save, or conflict races");
assert.match(exportArea, /isDocumentCurrent\(ticket\)[\s\S]*?if \(dirty\(\)\)/, "export checks navigation and edits again after fetching source");
assert.match(panel, /selection\(\)/, "panel observes designer selection");
assert.match(panel, /s\.type === "part" \|\| s\.type === "primitive"/, "part selection closes the panel");
assert.match(panel, /focusInspector\(selectionFocus\)/, "close restores focus after the panel transition");
assert.match(panel, /const design = draft;/, "a pending Design edit can detach a Python source link before save");
assert.match(panel, /design\?\.python_source_model/, "Python opens the source linked to the current draft");
assert.match(store, /defaultDesignerSession = createDesignerSession\(/, "the existing editor uses the session core");
assert.match(core, /delete copy\.model;/, "Design name and description edits preserve the Python source link");
// the texts are translated keys (src/i18n/en.json has the English)
const en = JSON.parse(readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8"));
assert.match(panel, /t\("python\.stale"\)[\s\S]*?t\("python\.refresh"\)/, "stale source stays visible with warning and refresh action");
assert.match(en["python.stale"], /out of date after design edits/, "the stale warning says the source is out of date");
assert.equal(en["python.refresh"], "Refresh source", "the refresh action reads Refresh source");
assert.match(css, /var\(--al-font-mono\)/, "Python source uses the design system mono font");
assert.match(css, /var\(--al-text-xs\)|var\(--al-text-sm\)/, "panel typography uses design system size tokens");
assert.doesNotMatch(css, /ui-monospace|SFMono-Regular|Consolas|font-size:\s*\d+px/, "panel CSS does not hard-code font stacks or text sizes");

console.log("Python panel checks passed: save-first export, race guards, stale source, selection and focus lifecycle, token typography.");
