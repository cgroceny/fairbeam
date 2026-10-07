// User-facing text that is worked out from data (no DOM, no build):
//
//   node --experimental-strip-types scripts/check-report-text.mjs
//
// 1. The CST import summary comes from the report's rows (src/lib/cstReport.ts): identical rows
//    merge with a count, and "everything imported" needs a report without gaps; a row about a CST
//    project shows its Turkish text in Turkish.
// 2. JSON paths become places in words (src/designer/pathText.ts), in English and in Turkish, and
//    paths inside free text too; the data keeps its paths.
// 3. Check titles are sentence-cased for display only (checkText.ts).
// 4. Source structure of the fixes that need a browser to run: ⌘Enter is taken before the field
//    guard, the status bar names check errors instead of "Preview failed", the empty design opens on
//    Modeling, the last design is reopened after a reload.
// 5. Negative numbers shown as text take U+2212 (fmt); the exporters never use fmt, so files and
//    the clipboard keep the ASCII minus.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fmt, setLanguage } from "../src/i18n/index.ts";
import { durationText } from "../src/designer/meshStats.ts";
import { gapCounts, lineRuns, mergeNotes, noteKind, noteText } from "../src/lib/cstReport.ts";
import { humanizePaths, pathText } from "../src/designer/pathText.ts";
import { checkTitle, sentenceCase } from "../src/designer/checkText.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8").replaceAll("\r\n", "\n");
let checks = 0, failures = 0;
const eq = (got, want, what) => {
  checks++;
  if (!Object.is(got, want) && JSON.stringify(got) !== JSON.stringify(want)) { failures++; console.error(`FAIL ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};
const ok = (cond, what) => eq(!!cond, true, what);

// ---- 1. CST import report
const note = (severity, where, message, extra = {}) => ({ severity, where, line: 0, message, ...extra });
const horn = [1, 2, 3, 4].map((line) => note("warning", "horn", "the horn flare is not in this macro", { kind: "missing", line }));
const info = note("info", "mesh", "restored");
eq(mergeNotes(horn).length, 1, "four identical rows are one");
eq(mergeNotes(horn)[0].count, 4, "with their count");
eq(mergeNotes(horn)[0].lines, [1, 2, 3, 4], "and every line");
eq(mergeNotes([{ ...horn[0], count: 4, lines: [1, 2, 3, 4] }])[0].count, 4, "a merged row from the server keeps its count");
eq(gapCounts([info]).total, 0, "notes alone are no gap");
eq(gapCounts([...horn, info]), { missing: 1, refused: 0, changed: 0, total: 1 }, "the horn is one missing solid, not four");
eq(gapCounts([note("refused", "a", "x"), note("warning", "b", "y"), note("warning", "c", "z", { kind: "exporter" })]), { missing: 0, refused: 1, changed: 2, total: 3 }, "not imported, changed");
eq(noteKind(horn[0]), "missing", "an exporter gap is labelled missing");
eq(noteKind(info), "info", "a note keeps its kind");
eq(lineRuns([199, 200, 201, 202]), [[199, 202]], "consecutive lines are a range");
eq(lineRuns([9, 4, 5, 4]), [[4, 5], [9, 9]], "separate runs, sorted, once each");
// a note the server words in both languages carries both
const older = note("info", "macro", "the macro sets no units; millimetres are used",
  { message_tr: "makro birim belirtmiyor; milimetre kullanılır" });
eq(noteText(older, "en"), older.message, "a bilingual note in English");
eq(noteText(older, "tr"), older.message_tr, "a bilingual note in Turkish");
eq(noteText(info, "tr"), info.message, "an English-only note stays English");
eq(noteText({ ...older, message_tr: "" }, "tr"), older.message, "an empty Turkish text falls back to English");
eq(mergeNotes([older])[0].message_tr, older.message_tr, "merging keeps the Turkish text");
eq(gapCounts([older]).total, 0, "an info note is no gap of the import");
ok(/noteText\(n, locale\(\)\)/.test(read("src/components/CstImportDialog.tsx")), "the import dialog shows a row in the page's language");

ok(read("src/components/CstImportDialog.tsx").includes('<Show when={gaps().refused || gaps().missing}>'),
  "partial imports show the prominent warning for refused or missing items");
ok(read("src/components/CstImportDialog.tsx").includes('role="alert">{t("cstImport.partialGeometry")}'),
  "the incomplete-geometry warning is localized and announced");

// ---- 2. paths in words
const design = {
  params: [{ key: "L", default: 10 }, { key: "W", expr: "2*L" }],
  materials: [{ name: "FR4" }],
  parts: [{ name: "patch", primitives: [{ kind: "box" }, { kind: "cylinder" }] }],
  ports: [{ number: 1 }],
  resistors: [{ name: "r_iso" }],
};
const shape = (p) => (p.kind === "box" ? "Brick" : "Cylinder");
setLanguage("en");
eq(pathText("params[1].expr", design, shape), "Parameter W (expression)", "a parameter expression");
eq(pathText("materials.FR4.tan_d_freq", design, shape), "Material FR4 (tan δ frequency)", "a material field");
eq(pathText("parts[0].primitives[0].stop[2]", design, shape), "patch › Brick 1 › stop z", "a coordinate of a shape");
eq(pathText("parts[0]", design, shape), "patch", "a part");
eq(pathText("ports[0].stop[2]", design, shape), "Port 1 › stop z", "a port coordinate");
eq(pathText("simulation.max_timesteps", design, shape), "Simulation (max timesteps)", "a simulation setting");
eq(pathText("mesh.cells_per_wavelength", design, shape), "Mesh (cells per wavelength)", "a mesh setting");
eq(pathText("far_field.frequencies[1]", design, shape), "Far field (frequency 2)", "a far-field frequency");
eq(pathText("", design, shape), "design", "the design itself");
eq(pathText("params[9].expr", design, shape), "Parameters (expression)", "an index the design does not have");
// a solid is named as the tree names it: its label, never only its internal name
{
  const labelled = { ...design, parts: [{ name: "patch2", label: "Patch copy", primitives: [{ kind: "box" }] }] };
  eq(pathText("parts[0].primitives[0].stop[2]", labelled, shape), "Patch copy › Brick 1 › stop z", "a shape of a labelled solid");
  eq(pathText("parts[0].booleanHistory.B.primitives[0].start[0]", labelled, shape), "Patch copy › booleanHistory › B › shape 1 › start x", "a field inside a Boolean history belongs to the result");
}
eq(humanizePaths("params[1].expr: unknown name 'wx' in '2*wx'", design, shape), "Parameter W (expression): unknown name 'wx' in '2*wx'", "a path inside a message");
ok(!/\[\d+\]|\bparams\b|\bparts\b/.test(humanizePaths("parts[0].primitives[1].radius must be > 0", design, shape)), "no bracket path is left in a message");
setLanguage("tr");
eq(pathText("params[1].expr", design, shape), "Parametre W (ifade)", "a parameter expression, in Turkish");
eq(pathText("ports[0].stop[2]", design, shape), "Port 1 › bitiş z", "a port coordinate, in Turkish");
eq(pathText("materials.FR4.eps_r", design, shape), "Malzeme FR4 (εr)", "a material field, in Turkish");
setLanguage("en");
eq(durationText(90), "1.5 min", "a duration, in English");
setLanguage("tr");
eq(durationText(90), "1,5 dk", "a duration follows the language (decimal comma, dk)");
eq(durationText(7200), "2,0 sa", "hours, in Turkish");
setLanguage("en");

// ---- 3. titles
eq(sentenceCase("the port has no length along its direction"), "The port has no length along its direction", "a plain first word");
eq(sentenceCase("'patch' touches no other metal"), "'patch' touches no other metal", "a name in quotes stays");
eq(sentenceCase("f min must be above zero"), "f min must be above zero", "a symbol stays");
eq(sentenceCase("εr must be at least 1"), "εr must be at least 1", "a Greek symbol stays");
eq(sentenceCase("round() takes 1 or 2 arguments"), "round() takes 1 or 2 arguments", "a function stays");
eq(sentenceCase("12 field planes"), "12 field planes", "a number stays");
eq(checkTitle({ code: "port-length", message: "the port has no length" }), "The port has no length", "the title of a check");
setLanguage("tr");
eq(sentenceCase("için bir ad girin"), "İçin bir ad girin", "Turkish capital dotted I");
setLanguage("en");

// ---- 4. source structure
const ws = read("src/designer/DesignWorkspace.tsx");
const guard = ws.indexOf("if (inField || inOverlay) return;");
const run = ws.indexOf('matchesShortcut("run", e) && !inOverlay');
ok(run > 0 && run < guard, "Run is taken before the field guard, so it works while a field has the focus");
ok(/matchesShortcut\("run", e\) && !inOverlay && !tool\(\)/.test(ws), "Run is not taken inside a dialog or while drawing");
ok(/setRibbonTab\("model"\)/.test(ws) && /draft\.parts\?\.length \?\? 0\) === 0/.test(ws), "an empty design opens on Modeling");
const sb = read("src/designer/StatusBar.tsx");
ok(/status\.preview\.paused"/.test(sb) && /serverState\(\) === "online" && errs\(\) > 0/.test(sb), "the status bar names check errors");
ok(/onClick=\{\(\) => void recheckServer\(\)\}/.test(sb), "a click on the server item looks at the server again, whatever it believes");
const app = read("src/App.tsx");
ok(/await reopenLastDesign\(\)/.test(app), "the last design is reopened after a reload");
const home = read("src/home/Home.tsx");
ok(/home\.newProject\.needName/.test(home) && /starterName\(template\(\)\)/.test(home), "Start: a tooltip on Create, the name follows the starter");

// the Run dialog's error list: a place in words for every row (also inside the message), no list marker
const rd = read("src/designer/RunDialog.tsx");
ok(/humanizePaths\(checkTitle\(c\), draft, kindLabel\)/.test(rd) && /checkPlace\(c\)/.test(rd), "Run dialog: each row's title and place are in words");
ok(!/\{c\.path\}|\{c\.path\(/.test(rd), "Run dialog: no row prints the raw check path");
const css = read("src/styles/designer-sim.css");
ok(/\.rd-errors \{[^}]*list-style: none/.test(css), "Run dialog: the error rows carry no list marker (a wrapped title left a bullet on its own)");

// ---- 5. the typographic minus is display-only
setLanguage("en");
eq([fmt.fixed(-1.5, 2), fmt.num(-0.25, 3), fmt.int(-1234), fmt.intl(-3.5, { maximumFractionDigits: 1 })], ["\u22121.50", "\u22120.25", "\u22121,234", "\u22123.5"], "en: negative numbers start with U+2212");
eq([fmt.fixed(1.5, 2), fmt.num(0.25, 3), fmt.int(1234)], ["1.50", "0.25", "1,234"], "en: positive numbers are unchanged");
setLanguage("tr");
eq([fmt.fixed(-1.5, 2), fmt.num(-0.25, 3), fmt.int(-1234)], ["\u22121,50", "\u22120,25", "\u22121.234"], "tr: the same with the decimal comma");
setLanguage("en");
for (const f of ["src/designer/resultData.ts", "src/designer/runSummary.ts", "src/designer/resultTouchstone.ts", "src/runner/sweep.ts", "src/runner/optimize.ts"]) {
  const src = read(f);
  ok(!/\bfmt\b[^\n]*from\s+["'][^"']*i18n/.test(src) && !/from\s+["'][^"']*\/lib\/format|from\s+["']\.\.?\/format/.test(src), `${f}: exported data is formatted without fmt (ASCII minus, decimal point)`);
}

if (failures) { console.error(`check-report-text: ${failures} of ${checks} checks failed`); process.exit(1); }
console.log(`check-report-text: ${checks} checks passed`);
