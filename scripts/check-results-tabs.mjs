// The Design workspace's main-area document tabs (src/designer/resultTabs.ts): opening,
// focusing and closing result tabs, the 3D tab that never closes, Ctrl+Tab cycling, the short run
// labels (A, B, C, ...) and the run table's differing-parameter columns run for real; how the tree,
// the dock, the ribbon and DesignKeys use them is checked in their sources. No DOM, no build.
//
//   node --experimental-strip-types scripts/check-results-tabs.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activateTab, closeTab, cycleTab, differingParams, differs, isMainResultView, MAIN_RESULT_VIEWS, MAIN_TAB_LABELS, madeLabels, mainTabIds, ONLY_3D, openResultTab, runLetter, runLetters,
} from "../src/designer/resultTabs.ts";
import { matchesShortcut, shortcutTable } from "../src/designer/shortcuts.ts";
import { createResultFocusState } from "../src/designer/resultSessionState.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8").replaceAll("\r\n", "\n");
// UI texts live in the locale files (src/i18n): the sources call t("key"), en.json has the English
const en = JSON.parse(read("src/i18n/en.json"));
let checks = 0;
let failures = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) { failures++; console.error(`FAIL ${what}`); }
};
const eq = (got, want, what) => check(JSON.stringify(got) === JSON.stringify(want), `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ---- the tab model: 3D first and shown by default
eq(ONLY_3D, { open: [], active: "3d" }, "a design starts with the 3D tab only");
eq(mainTabIds(ONLY_3D), ["3d"], "the 3D tab is always in the strip");
eq(MAIN_TAB_LABELS["3d"], "3D", "the first tab reads 3D");
for (const v of ["sparams", "impedance", "vswr", "smith", "efficiency", "pattern", "table", "summary", "fieldmap"]) check(isMainResultView(v), `${v} opens as a main-area tab`);
for (const v of ["currents", "pattern3d", "log", "3d", "checks"]) check(!isMainResultView(v), `${v} does not open as a result tab`);
eq(MAIN_RESULT_VIEWS.map((v) => MAIN_TAB_LABELS[v]), ["S-parameters", "Impedance", "VSWR", "Smith", "Efficiency", "Pattern", "Table", "Summary", "Field map"], "result tab labels");

// ---- open and focus
let s = openResultTab(ONLY_3D, "sparams");
eq(s, { open: ["sparams"], active: "sparams" }, "opening a result adds its tab and shows it");
s = openResultTab(s, "smith");
eq(s, { open: ["sparams", "smith"], active: "smith" }, "a second result opens beside the first");
s = openResultTab(s, "sparams");
eq(s, { open: ["sparams", "smith"], active: "sparams" }, "opening an open result focuses its tab, no duplicate");
eq(mainTabIds(s), ["3d", "sparams", "smith"], "strip order: 3D, then results in opening order");
eq(activateTab(s, "3d").active, "3d", "the 3D tab can be shown");
check(activateTab(s, "vswr") === s, "showing a tab that is not open changes nothing");
check(activateTab(s, "sparams") === s, "showing the shown tab changes nothing");

// ---- close: 3D never; the shown tab passes to its right, else left neighbour
check(closeTab(s, "3d") === s, "the 3D tab never closes");
check(closeTab(ONLY_3D, "3d") === ONLY_3D, "the 3D tab never closes, even alone");
check(closeTab(s, "vswr") === s, "closing a tab that is not open changes nothing");
let t = { open: ["sparams", "smith", "vswr"], active: "smith" };
eq(closeTab(t, "smith"), { open: ["sparams", "vswr"], active: "vswr" }, "closing the shown tab shows its right neighbour");
eq(closeTab(t, "vswr"), { open: ["sparams", "smith"], active: "smith" }, "closing a hidden tab keeps the shown one");
t = { open: ["sparams", "smith"], active: "smith" };
eq(closeTab(t, "smith"), { open: ["sparams"], active: "sparams" }, "closing the last shown tab shows its left neighbour");
eq(closeTab({ open: ["table"], active: "table" }, "table"), ONLY_3D, "closing the only result tab goes back to 3D");
eq(closeTab(closeTab(t, "smith"), "sparams"), ONLY_3D, "closing every result leaves the 3D tab");

// ---- Ctrl+Tab / Ctrl+Shift+Tab cycle, wrapping
t = { open: ["sparams", "smith"], active: "3d" };
eq(cycleTab(t, 1).active, "sparams", "next tab after 3D");
eq(cycleTab(cycleTab(cycleTab(t, 1), 1), 1).active, "3d", "next wraps from the last tab to 3D");
eq(cycleTab(t, -1).active, "smith", "previous wraps from 3D to the last tab");
eq(cycleTab(ONLY_3D, 1).active, "3d", "with only 3D, cycling stays on 3D");
const key = (k, mods = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
for (const mac of [true, false]) {
  const p = mac ? "macOS" : "Windows/Linux";
  eq(matchesShortcut("mainTabs", key("Tab", { ctrlKey: true }), mac), true, `${p}: Ctrl+Tab cycles the main-area tabs`);
  eq(matchesShortcut("mainTabs", key("Tab", { ctrlKey: true, shiftKey: true }), mac), true, `${p}: Ctrl+Shift+Tab cycles back`);
  eq(matchesShortcut("mainTabs", key("Tab"), mac), false, `${p}: plain Tab keeps moving the focus`);
  eq(matchesShortcut("mainTabs", key("Tab", { metaKey: true }), mac), false, `${p}: ⌘/Win+Tab is left to the system`);
  eq(matchesShortcut("mainTabs", key("Tab", { ctrlKey: true, altKey: true }), mac), false, `${p}: Ctrl+Alt+Tab is not the tab switch`);
}
// no other designer shortcut claims Ctrl+Tab
for (const [id] of Object.entries(shortcutTable(false))) {
  if (id !== "mainTabs") eq(matchesShortcut(id, key("Tab", { ctrlKey: true }), false), false, `Ctrl+Tab is not ${id}`);
}
eq(shortcutTable(false).mainTabs.key, "Ctrl+Tab / Ctrl+Shift+Tab", "the shortcut sheet names Ctrl+Tab");
eq(shortcutTable(true).mainTabs.key, "⌃Tab / ⌃⇧Tab", "macOS labels read ⌃Tab");

// ---- short run labels: the oldest run is A and keeps its letter as runs are added
eq([0, 1, 2, 25, 26, 27, 51, 52, 701, 702].map(runLetter), ["A", "B", "C", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"], "run letters count like spreadsheet columns");
let letters = runLetters(["c.json", "b.json", "a.json"]);
eq([...letters], [["a.json", "A"], ["b.json", "B"], ["c.json", "C"]], "newest-first run list: the oldest run is A");
letters = runLetters(["d.json", "c.json", "b.json", "a.json"]);
eq([letters.get("a.json"), letters.get("c.json"), letters.get("d.json")], ["A", "C", "D"], "a new run gets the next letter, the others keep theirs");
eq(runLetters([]).size, 0, "no runs, no labels");

// ---- run-table columns: only the parameters that differ, in first-seen order, with units
const run = (params) => ({ params: Object.entries(params).map(([key, value]) => ({ key, value, unit: key === "eps" ? "" : "mm" })) });
eq(differingParams([run({ L: 30, W: 20, h: 1.6 }), run({ L: 31, W: 20, h: 1.6 }), run({ L: 32, W: 21, h: 1.6 })]),
  [{ key: "L", unit: "mm" }, { key: "W", unit: "mm" }], "one column per differing parameter; equal ones left out");
eq(differingParams([run({ L: 30, eps: 4.4 }), run({ L: 30, eps: 3.5 })]), [{ key: "eps", unit: "" }], "a unitless parameter has no unit");
eq(differingParams([run({ L: 30 }), run({ L: 30, g: 1 })]), [{ key: "g", unit: "mm" }], "a parameter missing from a run differs");
eq(differingParams([run({ L: 30, W: 20 }), run({ L: 30, W: 20 })]), [], "re-runs with the same parameters: no parameter column");
eq(differingParams([run({ L: 30 })]), [], "a single run has nothing to compare");
eq(differingParams([run({ L: 30 }), run({ L: "30" })]), [], "the same value written as text or number is the same");
check(differs(["cpu", "gpu"]) && !differs(["cpu", "cpu"]) && !differs(["cpu"]), "the engine column shows only when engines differ");

// ---- when each run was made (the Runs tab's Made column)
eq(madeLabels(["2026-09-26T12:36:29+0300", "2026-09-26T13:10:02+0300"]), ["12:36", "13:10"], "runs of one day: the time of day");
eq(madeLabels(["2026-09-25T09:00:00+0300", "2026-09-26T13:10:02+0300"]), ["09-25 09:00", "09-26 13:10"], "runs on several days: with the date");
eq(madeLabels(["2026-09-26T12:36:29+0300", "2026-09-26T12:36:51+0300", "2026-09-26T12:40:00+0300"]), ["12:36:29", "12:36:51", "12:40"], "two runs in one minute: with seconds");
eq(madeLabels([undefined, "bad"]), ["—", "—"], "no timestamp: a dash");

// ---- wiring: tree, dock, ribbon, keys, markers and the shortcut sheet
const tree = read("src/designer/NavTree.tsx");
check(/case "result":[^\n]*focusResult\(\{[^\n]*\}, "main"\)/.test(tree), "a tree result node opens its main-area tab");
check(/case "select": focusResult\(null\); activateMainTab\("3d"\)/.test(tree), "a geometry node brings the 3D tab to the front");
const focus = read("src/designer/resultFocus.ts");
const routed = [];
const focused = createResultFocusState({ openMainResult: view => routed.push(view), showRunsTab: () => routed.push("runs"), activateMainTab: tab => routed.push(tab) });
focused.focusResult({ file: "run.json", view: "smith" }, "main");
eq(routed, ["smith", "runs"], "a main-area focus opens a tab; the dock follows with its Runs tab without opening");
routed.length = 0;
focused.focusResult({ file: "run.json", view: "pattern3d" }, "main");
eq(routed, ["3d", "runs"], "the 3D pattern and the surface currents bring the 3D view to the front");
focused.dispose();
check(/createResultFocusState\(\{/.test(focus) && /openMainResult,/.test(focus) && /activateMainTab,/.test(focus) && /showDesignDockTab\("runs"\)/.test(focus), "the public focus wrapper uses the tested factory with real tab/dock adapters");
const dock = read("src/designer/RunDock.tsx");
const dockTabs = dock.slice(dock.indexOf("const tabs = createMemo"), dock.indexOf("return list;", dock.indexOf("const tabs = createMemo")));
check(/id: "runs", label: \(\) => t\("dock\.tab\.runs"\)/.test(dockTabs) && en["dock.tab.runs"] === "Runs", "the dock has a Runs tab");
for (const id of ["sparams", "impedance", "vswr", "smith", "efficiency", "pattern", "currents", "table"]) check(!dockTabs.includes(`id: "${id}"`), `the dock has no ${id} result tab any more`);
check(!/Open in main area/.test(dock) && !/Copy data|Touchstone|Compare runs/.test(dock), "the dock keeps no result toolbar (it moved to the result tab)");
check(/differingParams\(/.test(dock) && /madeLabels\(/.test(dock) && /aria-pressed=\{on\(\)\}/.test(dock) && /choose\(row\.file\)/.test(dock), "the Runs tab: label toggles the comparison, a row shows the run, differing parameters and when made");
const views = read("src/designer/ResultViews.tsx");
check(/export function ResultBody/.test(views) && /<ResultBody view=\{view\(\)\}/.test(read("src/designer/MainArea.tsx")), "a result tab draws the shared result views");
check(/<ResultToolbar view=\{view\(\)\} \/>/.test(read("src/designer/MainArea.tsx")) && /t\("results\.toolbar\.copyData"\)/.test(views) && /CSV/.test(views) && /Touchstone/.test(views) && /t\("results\.toolbar\.compareRuns"\)/.test(views) && /aria-label=\{t\("results\.toolbar\.formatAria"\)\}/.test(views)
  && en["results.toolbar.copyData"] === "Copy data" && en["results.toolbar.compareRuns"] === "Compare runs" && en["results.toolbar.formatAria"] === "Result data format",
  "the result toolbar (run, Compare, format, Copy data, CSV, Touchstone) sits in the result tab");
check(/label: runShortLabel\(file\)/.test(views), "compared traces are labelled A, B, C in the legend");
check(!/CompareKey|rdk-effect/.test(views + dock), "no run table under or beside the plot");
check(/"pattern3d", t\("tree\.result\.pattern3d", \{ f: ghz\(f\) \}\)/.test(read("src/designer/navModel.ts")) && en["tree.result.pattern3d"] === "3D pattern (f = {f})", "each far field has a 3D pattern entry in the tree");
const runs = read("src/designer/runResults.ts");
check(/setLayers\(\{ pattern: f\.view === "pattern3d"/.test(runs), "the 3D pattern layer is on only for the 3D pattern (never under a result tab)");
check(/if \(IN_3D\.has\(a\.view\)\) focusResult\(null\)/.test(tree) && /closeMainTab\(a\.view\)/.test(tree), "a shown result closes from the tree: its tab, or the 3D pattern / currents");
check(/e\.key === "Delete" && isShown\(r\)/.test(tree) && /nt-shown-btn/.test(tree), "the tree marks shown results and closes them with × or Delete");
check(/focusResult\(\{ \.\.\.result, view: action \}, "main"\)/.test(read("src/designer/ribbonResults.ts")), "the ribbon's result buttons open main-area tabs");
const main = read("src/designer/MainArea.tsx");
check(/role="tablist"/.test(main) && /role="tab"/.test(main) && /role="tabpanel"/.test(main), "tabs are a tablist with tabs and tab panels");
check(/aria-selected=\{active\(\) === id\}/.test(main) && /tabindex=\{active\(\) === id \? 0 : -1\}/.test(main), "one tab in the tab order (roving tabindex)");
check(/tabKeyTarget\(e\.key/.test(main), "arrow keys, Home and End move between tabs");
check(/e\.key === "Delete"/.test(main) && /e\.button === 1/.test(main), "Delete and middle-click close a result tab");
check(/inert=\{active\(\) !== "3d"\}/.test(main), "the covered 3D view stays mounted but out of the tab order");
const keys = read("src/designer/DesignWorkspace.tsx");
check(/matchesShortcut\("mainTabs", e\)[\s\S]{0,400}cycleMainTabs\(e\.shiftKey \? -1 : 1\)/.test(keys), "DesignKeys cycles the main-area tabs");
// the result panel (and the focused element in it) goes away when the switch leaves it: whether the
// focus was in the main area is asked before the switch, else the focus falls to the page body
check(/const inMain = !!t\?\.closest\?\.\("\.dw-main"\);\s*cycleMainTabs\(e\.shiftKey \? -1 : 1\);\s*if \(inMain\) focusActiveMainTab\(\);/.test(keys), "Ctrl+Tab from inside a result tab keeps the focus on the tab strip");
check(/<MainArea>[\s\S]*<Viewport \/>[\s\S]*<\/MainArea>/.test(read("src/App.tsx")), "the 3D view lives in the main area's first tab");
check(/\.dock, \.rdk, \.dw-result/.test(read("src/charts/LineChart.tsx")), "M toggles markers in an active result tab too");

// ---- the Efficiency view and the far-field quantity (#farfield-quantities)
check(/props\.view === "efficiency"\}><ResultEfficiency b=\{props\.b\} \/>/.test(views), "the Efficiency tab draws its view");
check(/points=\{plot\(\)\.points\}/.test(views) && /t\("efficiency\.noteFarfieldOnly"/.test(views) && /Simulation › Monitors › Far field/.test(en["efficiency.noteFarfieldOnly"])
  && /t\("efficiency\.noteBand"/.test(views) && /Efficiency over the band/.test(en["efficiency.noteBand"].other),
  "the Efficiency view marks the far-field points and says where more radiation efficiency comes from");
check(en["ribbon.sim.efficiency"] === "Efficiency" && /label=\{t\("ribbon\.sim\.efficiency"\)\}[^\n]*openRibbonResult\("efficiency"\)/.test(keys), "Post-processing opens the Efficiency tab");
check(en["ribbon.post.farfield"] === "Far field" && /<Show when=\{ribbonFarfield\(\)\}>[\s\S]{0,200}<RGroup label=\{t\("ribbon\.post\.farfield"\)\}[\s\S]{0,300}<PatternQuantitySelect/.test(keys), "Post-processing shows the quantity picker while a pattern is shown");
check(/quantityGrid\(props\.b, f, q\)/.test(views) && /PatternQuantitySelect bundle=\{props\.b\}/.test(views), "the Pattern tab's cuts follow the quantity, with its picker beside them");
const viewport = read("src/scene/Viewport.tsx");
check(/quantityGrid\(b, f, q\), max: quantityMax\(b, f, q\)/.test(viewport) && /patternQuantity\], buildPattern/.test(viewport), "the 3D pattern redraws with the quantity");
check(/<FarfieldCard bundle=\{bundle\(\)!\}/.test(viewport) && /showPattern3dEntry\(i\)/.test(viewport), "the 3D view's far-field card, its chips focusing the entry in Design");
const card = read("src/components/FarfieldCard.tsx");
check(/aria-expanded=\{!collapsed\(\)\}/.test(card) && /role="radiogroup" aria-label=\{t\("farfield\.frequency"\)\} onKeyDown=\{radioGroupKeys\}/.test(card) && en["farfield.frequency"] === "Far-field frequency", "the card collapses (aria-expanded) and its chips are a radio group");
check(/t\("farfield\.total"\)/.test(card) && /t\("farfield\.mainLobe"\)/.test(card) && /t\("farfield\.drivenPort"\)/.test(card)
  && en["farfield.total"] === "Total efficiency" && en["farfield.mainLobe"] === "Main lobe" && en["farfield.drivenPort"] === "Driven port", "the card lists total efficiency, main lobe and the driven port");

// ---- room for the result views at 1366 × 768: the dock leaves the view above it a usable height (its
// default and a remembered height alike), a result tab keeps its plot about 260 px tall and scrolls
// when the window is shorter, and the splitter shows that it can be dragged
{
  const handle = read("src/components/DockResizeHandle.tsx");
  check(/export const MIN_VIEW_ABOVE = 320;/.test(handle) && /Math\.floor\(room - MIN_VIEW_ABOVE\)/.test(handle), "the dock's maximum leaves MIN_VIEW_ABOVE for the view above it");
  check(/if \(natural > maximum\(\) \+ 1\) \{ center\.style\.setProperty\("--al-dock-user-h", `\$\{maximum\(\)\}px`\); capped = true;/.test(handle), "the CSS default is capped on a short window, and follows the window back");
  check(/<span class="dock-grip" aria-hidden="true" \/>/.test(handle) && /title=\{t\("resize\.dock\.title"\)\}/.test(handle), "the splitter has a grip and a tooltip");
  const css = read("src/styles/result-views.css");
  check(/\.dw-result \{ overflow-y: auto;/.test(css) && /\.dw-result > \.dw-result-plot \{ flex: 1 0 auto; min-height: 260px; height: 0; \}/.test(css), "a result tab keeps a 260 px plot and scrolls");
  check(/\.dock-tools > select\.btn\.result-format, \.dw-result-bar > select\.btn\.result-format/.test(css) && /width: auto; min-width: 7rem; max-width: 16rem/.test(css), "the data format select is as wide as 'Linear magnitude + phase'");
  check(/class="btn btn-ghost btn-sm result-format"/.test(views) && /class="btn btn-ghost btn-sm result-format"/.test(read("src/components/Dock.tsx")), "both toolbars use the wide select");
  check(/\.dw-result-bar\.is-narrow > button\.btn:has\(> \.btn-short\)/.test(css), "CSV and Touchstone keep their short labels in a narrow bar");
  check(/\.rdk-runs \.rdk-run-btn \{ font-family: var\(--al-font-sans\)/.test(css), "the run letter sits on the row's baseline");
  const fieldMap = read("src/styles/field-map.css");
  check(/\.fm-side \{[^}]*overflow: hidden auto;/.test(fieldMap), "the field map's side card scrolls down only (one scrollbar)");
  const ffCss = read("src/styles/farfield-card.css");
  check(/@media \(max-height: 820px\)/.test(ffCss) && /\.ff-card \.ff-scale-unit \{ display: none; \}/.test(ffCss) && /\.ff-card \.colorbar-body \{ flex: none; \}/.test(ffCss), "a short 3D view folds the far-field card's scale so its efficiency rows show");
}

// ---- the result views' readouts: a compared trace reads "|S11| · E", values keep their units
{
  check(/label: pairLabel\(p\), suffix: t\.label/.test(read("src/compare/series.ts")) && /label: "S11", suffix: t\.label/.test(views), "compared traces: the bars around S11 only");
  check(/export const totalEffText = /.test(card) && /totalEffText\(summary\(\)!\.totalEff!\)/.test(views) && /totalEffText\(ffSummary\(\)!\.totalEff!\)/.test(read("src/components/Dock.tsx")), "the total efficiency keeps '−1.22 dB' whole everywhere");
  check(en["format.percent"] === "{value} %", "a percentage keeps its sign on its line");
}

console.log(`check-results-tabs: ${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
