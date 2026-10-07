// Checks for the Examples project picker in the header (src/components/ExamplePicker.tsx, the
// custom combobox that replaced the native <select aria-label="Project">): its rows from the real
// project index, the search filter, the keyboard movement, the "Open as new project" refusal reason
// and the component's accessibility and behaviour contract. Pure and static by default:
//
//   node --experimental-strip-types scripts/check-example-picker.mjs
//
// With a running Vite server it also drives the picker in Chrome (every /api request is answered
// 503, so no run server is needed or touched):
//
//   FAIRBEAM_BROWSER_TESTS=1 FAIRBEAM_TEST_URL=http://127.0.0.1:5420/ \
//   node --experimental-strip-types scripts/check-example-picker.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXAMPLE_CATEGORIES, exampleCategory, exampleDetail, exampleGroups, filterGroups, flatItems, initialActive, matchesQuery, pickerKeyTarget } from "../src/lib/examplePicker.ts";
import { designFor, exampleConversionBlocker, exampleEntries, exampleSourceFor } from "../src/runner/examples.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8").replaceAll("\r\n", "\n");
let checks = 0;
let failures = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) { failures++; console.error(`FAIL ${what}`); }
};
const eq = (got, want, what) => check(JSON.stringify(got) === JSON.stringify(want), `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ---- rows from the shipped index, the way the component (and the Start screen) builds them
const index = JSON.parse(read("public/projects/index.json")).projects;
const examples = exampleEntries(index);
const groups = exampleGroups(examples);
const all = flatItems(groups);
eq(all.length, examples.length, "every example is a row");
eq(exampleGroups([...examples, { file: "geo.json", name: "Geometry only", model: "geo-patch", created: "", simulated: false, bands: [], cells: 0 }])
  .flatMap((g) => g.items).find((i) => i.file === "geo.json")?.results, false, "an example without results is listed too, marked as such");
const sierpinski = all.filter((i) => i.file.startsWith("sierpinski")).map((i) => i.label);
eq(sierpinski, ["Sierpinski gasket monopole · iterations=0", "Sierpinski gasket monopole · iterations=3"], "the two Sierpinski runs read apart, next to each other");
// one helper for the header picker and the Start screen's Examples card
const picker0 = read("src/components/ExamplePicker.tsx"), home0 = read("src/home/Home.tsx");
check(picker0.includes("exampleGroups(examples(), (c) => t(`examples.group.${c}`))") && home0.includes("exampleGroups(examples(), (c) => t(`examples.group.${c}`))"),
  "the picker and Start group the examples with the same helper");
check(home0.includes("<span class=\"home-item-sub\">{[p.detail, p.results ? \"\" : t(\"home.examples.geometryOnly\")].filter(Boolean).join(\" · \")}</span>"),
  "Start shows the picker's detail line (band, cells)");
check(/class="icon-btn icon-btn-sm home-copy"[^>]*aria-label=\{t\("home\.examples\.openAsNewAria", \{ name: p\.label \}\)\} title=\{copyReason\(\) \?\? t\("home\.examples\.copyTitle"\)\}/.test(home0),
  "Start's copy action is an icon button with a label and the reason it is off");
check(/fallback=\{\s*<p class="muted" role="status">\{t\(DEMO \|\| isDesktopShell\(\) \? "home\.examples\.empty" : "home\.examples\.emptyServer"\)\}<\/p>/.test(home0),
  "an empty workspace says what happened instead of an empty card");
const css0 = read("src/styles/designer.css");
check(/\.home-examples \.home-item-name \{ white-space: normal; overflow-wrap: anywhere; \}/.test(css0), "Start's example names wrap instead of being cut");
eq(groups.map((g) => g.label), ["uav", "printed", "horns", "arrays", "wire"], "groups follow the category order; the empty category (other) is hidden");
eq(exampleCategory("yagi_867"), "uav", "an 867 model is in the UAV group");
eq(exampleCategory("patch-array-2x1"), "arrays", "an array beats the patch rule");
eq(exampleCategory("something-new"), "other", "an unknown model falls into Other");
eq(groups.find((g) => g.label === "printed")?.items.filter((i) => i.file.startsWith("sierpinski")).length, 2, "the two Sierpinski runs share one group");
eq(all.length, flatItems(groups).length, "every example is in exactly one category");
for (const c of EXAMPLE_CATEGORIES) check(typeof JSON.parse(read("src/i18n/en.json"))[`examples.group.${c}`] === "string" && typeof JSON.parse(read("src/i18n/tr.json"))[`examples.group.${c}`] === "string", `heading ${c} in both languages`);
const ms = all.find((i) => i.file === "microstrip-line.json");
eq(ms?.label, "Microstrip line (50 ohm, two-port)", "the full example name is the row label");
eq(ms?.detail, "≥\u00a00.5–6 GHz · 49.6 k cells", "secondary line: the line is matched over the whole simulated range (at least 0.5–6 GHz), and the mesh size");
eq(exampleDetail({ bands: [3.303, 6.219, 7.297], cells: 1964256 }), "3.3, 6.22, 7.3 GHz · 1.96 M cells", "several bands are listed");
eq(exampleDetail({ bands: [], cells: 0 }), "", "no bands and no cells: an empty secondary line");
eq(exampleDetail({ bands: [2.4], cells: 1000, engine: "CUDA" }), "2.4 GHz · 1000 cells · CUDA", "the engine is named when the index has it");
check(all.every((i) => i.results), "the list holds examples with results (the badge reads \"with results\")");

// ---- the source of an 867 MHz example is its read-only example design, never "Open in designer"
const yagiSource = { key: "yagi_867", file: "yagi_867.design.json", kind: "design", readonly: true, model: { id: "yagi-867", name: "Yagi" } };
const myYagi = { key: "my_yagi", file: "my_yagi.design.json", kind: "design", readonly: false, model: { id: "yagi-867", name: "My Yagi" } };
eq(exampleSourceFor([yagiSource], "yagi-867")?.key, "yagi_867", "the example design is the copy's source");
eq(designFor([yagiSource], "yagi-867"), undefined, "a bundled example design does not open in the designer");
eq(designFor([yagiSource, myYagi], "yagi-867")?.key, "my_yagi", "the user's design of that model does");

// ---- filtering
const names = (q) => flatItems(filterGroups(groups, q)).map((i) => i.label);
eq(names(""), all.map((i) => i.label), "an empty query lists everything");
eq(names("   "), all.map((i) => i.label), "a blank query lists everything");
eq(names("patch"), ["Inset-fed patch (FR4, 2.4 GHz)", "Minkowski fractal patch", "Rectangular patch antenna", "Patch array 2 x 1", "Patch array 4 x 1"], "'patch' keeps the patch examples, in list order");
eq(names("PATCH array"), ["Patch array 2 x 1", "Patch array 4 x 1"], "terms are case-insensitive and all must match");
eq(names("array patch"), names("patch array"), "term order does not matter");
eq(names("wr-90"), ["Pyramidal horn (WR-90, 10 GHz)"], "the name's own text matches");
eq(names("8–12 ghz"), ["Pyramidal horn (WR-90, 10 GHz)"], "the secondary line (band) matches: the horn is matched over at least 8–12 GHz");
eq(names("11.16 ghz"), [], "not by its |S11| minimum: the band text is the band, not where it is deepest");
eq(names("lowpass"), ["Stepped-impedance low-pass filter"], "the group key / file name matches");
eq(names("iterations=3"), ["Sierpinski gasket monopole · iterations=3"], "a suffix matches");
eq(names("zzz"), [], "no match: no rows");
eq(filterGroups(groups, "zzz").length, 0, "no match: no empty groups either");
eq(filterGroups(groups, "sierpinski").map((g) => g.label), ["printed"], "only groups with a match remain");
check(matchesQuery({ file: "x.json", label: "Café patch", detail: "", results: true }, "g", "cafe"), "accents are folded");

// ---- the active row: where the list opens and how the keys move it
eq(initialActive(all, "microstrip-line.json"), all.findIndex((i) => i.file === "microstrip-line.json"), "the list opens on the open example");
eq(initialActive(all, "not-listed.json"), 0, "otherwise on the first row");
eq(initialActive([], "microstrip-line.json"), -1, "no rows: nothing is active");
const n = 5;
eq(pickerKeyTarget("ArrowDown", 0, n), 1, "Down moves one row");
eq(pickerKeyTarget("ArrowDown", 4, n), 4, "Down stops at the last row");
eq(pickerKeyTarget("ArrowUp", 3, n), 2, "Up moves one row");
eq(pickerKeyTarget("ArrowUp", 0, n), 0, "Up stops at the first row");
eq(pickerKeyTarget("ArrowDown", -1, n), 0, "Down with nothing active goes to the first row");
eq(pickerKeyTarget("Home", 3, n), 0, "Home: first row");
eq(pickerKeyTarget("End", 1, n), 4, "End: last row");
eq(pickerKeyTarget("ArrowDown", 0, 0), null, "no rows: the keys do nothing");
for (const key of ["a", "Enter", "Escape", "Tab", "ArrowLeft", " "]) eq(pickerKeyTarget(key, 1, n), null, `${JSON.stringify(key)} is left to the search field / component`);

// ---- "Open as new project": the reason, from the example's own geometry
const bundle = (file) => JSON.parse(read(`public/projects/${file}`));
eq(exampleConversionBlocker(bundle("pyramidal-horn.json")), null, "the pyramidal horn (polyhedra) can be converted");
check(/curve/.test(exampleConversionBlocker(bundle("helix-axial.json")) ?? ""), "the helix names its wire curve");
for (const f of ["dipole.json", "patch-antenna.json", "microstrip-line.json", "wilkinson-divider.json", "sierpinski-monopole--iterations-3.json", "minkowski-patch.json", "pyramidal-horn.json"]) {
  eq(exampleConversionBlocker(bundle(f)), null, `${f} can be converted`);
}
eq(exampleConversionBlocker({ parts: [{ name: "p", type: "Metal", bbox: [[0, 0, 0], [1, 1, 1]], primitives: [{ kind: "bbox", source_kind: "Polyhedron", exact: false, priority: 0, bbox: [[0, 0, 0], [1, 1, 1]] }] }] }),
  "p uses a Polyhedron primitive that is not exactly readable, a shape type designs do not support.", "an inexact primitive is refused too");

// ---- the component's contract (the browser part below checks it in action)
const picker = read("src/components/ExamplePicker.tsx");
const header = read("src/components/Header.tsx");
check(!/<select[^>]*aria-label="Project"/.test(header), "the header has no native Project <select> any more");
check(header.includes("<ExamplePicker />"), "the header renders the picker");
check(/aria-haspopup="listbox"/.test(picker) && /aria-expanded=\{open\(\)\}/.test(picker), "the button announces its listbox and state");
check(/role="combobox"/.test(picker) && /aria-autocomplete="list"/.test(picker) && /aria-controls=\{`\$\{id\}-list`\}/.test(picker), "the search field is a combobox that controls the list");
check(/aria-activedescendant=\{/.test(picker), "the active row is announced with aria-activedescendant (focus stays in the field)");
check(/role="listbox"/.test(picker) && /role="option"/.test(picker) && /role="group"/.test(picker), "listbox > group > option");
check(/aria-selected=\{active\(\) === i\(\)\}/.test(picker), "the active option is the selected one");
check(/e\.key === "Escape"[^\n]*close\(\)/.test(picker) && /if \(focus\) trigger\.focus\(\)/.test(picker), "Escape closes and returns focus to the button");
check(/e\.key === "Tab"\) \{ close\(false\)/.test(picker), "Tab closes and lets focus move on");
check(/window\[m\]\("blur", onBlur\)/.test(picker) && /"pointerdown", onAway/.test(picker), "a window blur and a click outside close it");
check(/pickerKeyTarget\(e\.key, active\(\), items\(\)\.length\)/.test(picker), "the search field moves the active row with the shared listbox keys");
check(/void openUserProject\(file\)\.finally\(\(\) => \{ if \(pending\(\) === file\) setPending\(null\); \}\)/.test(picker), "a pick opens through the guarded loader and falls back to source() afterwards");
const en = JSON.parse(read("src/i18n/en.json"));
check(/t\("examples\.select"\)/.test(picker) && en["examples.select"] === "Select an example", "the placeholder is kept");
check(/label: t\("examples\.openedProject"\), opened: true/.test(picker) && en["examples.openedProject"] === "Opened file" && /!examples\(\)\.some\(\(p\) => p\.file === s\)/.test(picker), "an opened non-example project is listed");
check(/document\.title = label \? `\$\{label\} — Fairbeam` : "Fairbeam"/.test(picker), "the window title names the open example");
check(/aria-disabled=\{c\(\)\.reason \? "true" : undefined\}/.test(picker) && /exampleConversionBlocker\(b\)/.test(picker), "Open as new project stays hoverable when refused and says why");
check(!/window\.(alert|confirm|prompt)\(/.test(picker), "no native dialogs");

// ---- in Chrome, against a running Vite server (opt-in)
if (process.env.FAIRBEAM_BROWSER_TESTS === "1") {
  const mod = await import(process.env.FAIRBEAM_PUPPETEER || "puppeteer-core");
  const puppeteer = mod.default ?? mod;
  const url = process.env.FAIRBEAM_TEST_URL || "http://127.0.0.1:5420/";
  const chrome = process.env.FAIRBEAM_CHROME || (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.setRequestInterception(true);
    page.on("request", (r) => (new URL(r.url()).pathname.startsWith("/api/") ? r.respond({ status: 503, body: "" }) : r.continue()));
    await page.setViewport({ width: 1352, height: 878 });
    await page.goto(url, { waitUntil: "networkidle0" });
    await page.evaluate(() => localStorage.setItem("fairbeam.last", "microstrip-line.json"));
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelector(".example-picker-trigger-label")?.textContent === "Microstrip line (50 ohm, two-port)");
    const state = () => page.evaluate(() => {
      const input = document.querySelector(".example-picker-pop input");
      const act = input && document.getElementById(input.getAttribute("aria-activedescendant") ?? "");
      const label = document.querySelector(".example-picker-trigger-label");
      return {
        open: !!document.querySelector(".example-picker-pop"),
        focus: document.activeElement === input ? "search" : document.activeElement?.classList.contains("example-picker-trigger") ? "trigger" : document.activeElement?.tagName,
        active: act?.querySelector(".example-picker-name")?.firstChild?.textContent ?? null,
        rows: [...document.querySelectorAll('[role="option"]')].length,
        label: label?.textContent, clipped: label ? label.scrollWidth > label.clientWidth : null, title: document.title,
      };
    });
    const s0 = await state();
    check(!s0.clipped, "at 1352 px the button shows the full example name");
    eq(s0.title, "Microstrip line (50 ohm, two-port) — Fairbeam", "window title");
    await page.focus(".example-picker-trigger");
    await page.keyboard.press("ArrowDown");
    let s = await state();
    check(s.open && s.focus === "search", "Down on the button opens the list with focus in the search field");
    eq(s.active, "Microstrip line (50 ohm, two-port)", "the open example is active");
    await page.keyboard.type("patch");
    s = await state();
    eq([s.rows, s.active], [5, "Inset-fed patch (FR4, 2.4 GHz)"], "typing filters and activates the first match");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    eq((await state()).active, "Rectangular patch antenna", "Down moves the active row");
    await page.keyboard.press("End");
    eq((await state()).active, "Patch array 4 x 1", "End");
    await page.keyboard.press("Home");
    eq((await state()).active, "Inset-fed patch (FR4, 2.4 GHz)", "Home");
    await page.keyboard.press("ArrowUp");
    eq((await state()).active, "Inset-fed patch (FR4, 2.4 GHz)", "Up stops at the first row");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.title.startsWith("Minkowski fractal patch"));
    s = await state();
    check(!s.open && s.focus === "trigger", "Enter opens the example, closes the list and returns focus to the button");
    eq(s.label, "Minkowski fractal patch", "the button shows the new example");
    eq(await page.evaluate(() => localStorage.getItem("fairbeam.last")), "minkowski-patch.json", "the last opened example is remembered");
    await page.keyboard.press("Enter");
    check((await state()).open, "Enter on the button opens the list");
    await page.keyboard.press("Escape");
    s = await state();
    check(!s.open && s.focus === "trigger", "Escape closes and returns focus to the button");
    await page.click(".example-picker-trigger");
    check((await state()).open, "a click opens it");
    await page.mouse.click(700, 500);
    check(!(await state()).open, "a click outside closes it");
    await page.click(".example-picker-trigger");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    check(!(await state()).open, "a window blur closes it");
    await page.click(".example-picker-trigger");
    const row = await page.$$('[role="option"]');
    await row[0].click();
    await page.waitForFunction(() => document.title.startsWith("Branch-line coupler"));
    check(!(await state()).open, "a click on a row opens that example");
    // a failed load: the button falls back to what is actually open
    await page.evaluate(() => { const orig = window.fetch; window.fetch = (u, o) => String(u).includes("dipole.json") ? Promise.resolve(new Response("nope", { status: 500 })) : orig(u, o); });
    await page.click(".example-picker-trigger");
    await page.keyboard.type("dipole");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector(".example-picker-pop"));
    await new Promise((r) => setTimeout(r, 300));
    eq((await state()).label, "Branch-line coupler (2.4 GHz)", "after a failed load the button shows the example that is still open");
    for (const [w, h] of [[1152, 704], [1440, 900], [1920, 1080]]) {
      await page.setViewport({ width: w, height: h });
      await new Promise((r) => setTimeout(r, 150));
      check(!(await state()).clipped, `the full name fits at ${w} px`);
    }
  } finally {
    await browser.close();
  }
} else {
  console.log("check-example-picker: browser part skipped (opt in with FAIRBEAM_BROWSER_TESTS=1 and a running Vite server)");
}

console.log(`check-example-picker: ${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
