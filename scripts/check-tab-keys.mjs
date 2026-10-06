// Checks for #107: the tablist arrow keys (src/lib/tabKeys.ts) and how the Simulation settings
// dialog and the header use them / keep the run status readable. Pure and static: no DOM, no build.
//
//   node --experimental-strip-types scripts/check-tab-keys.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tabKeyTarget } from "../src/lib/tabKeys.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8").replaceAll("\r\n", "\n");
let checks = 0;
let failures = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) { failures++; console.error(`FAIL ${what}`); }
};
const eq = (got, want, what) => check(Object.is(got, want), `${what}: got ${got}, want ${want}`);

// ---- tabKeyTarget: move and wrap, Home/End, other keys untouched
const N = 5;
eq(tabKeyTarget("ArrowDown", 0, N), 1, "Down moves to the next tab");
eq(tabKeyTarget("ArrowDown", 4, N), 0, "Down wraps from the last tab to the first");
eq(tabKeyTarget("ArrowUp", 2, N), 1, "Up moves to the previous tab");
eq(tabKeyTarget("ArrowUp", 0, N), 4, "Up wraps from the first tab to the last");
eq(tabKeyTarget("ArrowRight", 1, N), 2, "Right (row layout on narrow screens) = Down");
eq(tabKeyTarget("ArrowLeft", 0, N), 4, "Left (row layout on narrow screens) = Up, wrapping");
eq(tabKeyTarget("Home", 3, N), 0, "Home goes to the first tab");
eq(tabKeyTarget("End", 1, N), 4, "End goes to the last tab");
eq(tabKeyTarget("ArrowDown", -1, N), 0, "Down with no focused tab goes to the first");
eq(tabKeyTarget("ArrowUp", -1, N), 4, "Up with no focused tab goes to the last");
eq(tabKeyTarget("ArrowDown", 0, 1), 0, "a single tab stays put");
eq(tabKeyTarget("ArrowDown", 0, 0), null, "no tabs: no target");
for (const key of ["Tab", "Enter", " ", "Escape", "a", "PageDown"]) eq(tabKeyTarget(key, 2, N), null, `${JSON.stringify(key)} is not a tablist key`);

// ---- Simulation settings dialog: roving tabindex, key handler, orientation, Tab into the section
const dlg = read("src/designer/SimSettingsDialog.tsx");
const nav = dlg.match(/<nav class="ss-nav"[^>]*>/)?.[0] ?? "";
check(/role="tablist"/.test(nav), "settings nav is a tablist");
check(/aria-orientation="vertical"/.test(nav), "settings tablist keeps aria-orientation vertical");
check(/onKeyDown=\{onTabKey\}/.test(nav), "settings tablist handles keys");
const tab = dlg.match(/<button role="tab"[\s\S]*?>/)?.[0] ?? "";
check(/tabindex=\{section\(\) === s\.id \? 0 : -1\}/.test(tab), "only the selected settings tab is in the Tab order (roving tabindex)");
check(/aria-selected=\{section\(\) === s\.id\}/.test(tab), "the selected settings tab is aria-selected");
check(/aria-controls=\{`ss-\$\{s\.id\}`\}/.test(tab) && /id=\{`ss-tab-\$\{s\.id\}`\}/.test(tab), "tabs have ids and point at their sections");
const handler = dlg.match(/const onTabKey = [\s\S]*?\n  };/)?.[0] ?? "";
check(/tabKeyTarget\(e\.key, i, SECTIONS\.length\)/.test(handler), "the handler uses tabKeyTarget over the sections");
check(/go\(SECTIONS\[next\]\.id\)/.test(handler) && /\.focus\(\)/.test(handler), "an arrow key selects (and scrolls to) the tab and focuses it");
check(/e\.key === "Tab" && !e\.shiftKey/.test(handler) && /#ss-\$\{section\(\)\}/.test(handler), "Tab from a tab enters the selected section");
check(/export const FOCUSABLE/.test(read("src/lib/dialog.ts")), "dialog.ts shares its focusable selector");

// ---- header: the status never clips; lower-priority metadata gives way first
const css = read("src/styles/app.css");
const meta = css.match(/\n\.header-meta \{[^}]*\}/)?.[0] ?? "";
check(meta !== "" && !/overflow:\s*hidden/.test(meta), "the header metadata row does not clip its content (the status)");
check(/min-width:\s*min-content/.test(meta), "the header metadata row does not shrink below its content's minimum (the project picker gives way first)");
check(/\.header-meta \.status \{ flex: none; \}/.test(css), "the status never shrinks");
check(/\.header-meta \.meta-id, \.header-meta \.meta-cells \{[^}]*text-overflow: ellipsis/.test(css), "model id and cell count ellipsize");
check(/\.header-meta \.meta-id \{ max-width: \d+ch; \}/.test(css), "a long model id is capped");
const at1800 = css.match(/@media \(max-width: 1800px\) \{[^}]*\}/)?.[0] ?? "";
check(/\.meta-id/.test(at1800) && /\.meta-cells/.test(at1800), "model id and cell count are hidden at 1800 px and below, so the example picker shows the full name (1280x720, 1352x878, Windows 125%/150%)");
const at960 = css.match(/@media \(max-width: 960px\) \{[\s\S]*?\n\}/)?.[0] ?? "";
check(/\.header-meta \.status-label \{[^}]*clip: rect\(0 0 0 0\)/.test(at960) && !/display:\s*none/.test(at960),
  "below 960 px the status goes icon-only but keeps its label for screen readers");
const header = read("src/components/Header.tsx");
check(/class="mono meta-id" title=/.test(header), "the model id keeps its full text as a tooltip");
const en = JSON.parse(read("src/i18n/en.json"));
check(/<span class="status-label">\{t\("header\.status\.converged"\)\}<\/span>/.test(header) && /<span class="status-label">\{t\("header\.status\.notConverged"\)\}<\/span>/.test(header)
  && en["header.status.converged"] === "Converged" && en["header.status.notConverged"] === "Not converged", "status labels stay full text");

console.log(`check-tab-keys: ${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
