// Wording and polish: Turkish terms (one name per concept), numbers shown with one
// notation, parameter default labels, the Start screen, the Parameters dock, the work-plane label, the
// Translate copies label, the camera refit, the ribbon tab of a new design and the layout that must
// not jump (floating tool hints, the Post-processing group order and note). The behaviour that needs a
// browser is asserted as source contracts, as the other check scripts do.
//
//   node --experimental-strip-types scripts/check-wording-polish.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(`${root}${p}`, "utf8");
const tr = JSON.parse(read("src/i18n/tr.json"));
const en = JSON.parse(read("src/i18n/en.json"));
const flat = (v) => (typeof v === "string" ? [v] : Object.values(v));
const allTr = Object.entries(tr).flatMap(([k, v]) => flat(v).map((text) => [k, text]));
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };

// ---- Turkish: one term per concept
for (const [key, text] of allTr) {
  ok(!/(?<![\p{L}])koş(u|uda|udan|unun|uyu|uya|uyla|ular|uları|tur\p{L}*)(?![\p{L}])/iu.test(text), `${key}: a run is "çalıştırma" (Koşu is not used): ${text}`);
  ok(!/toplu port/i.test(text), `${key}: the lumped port is "ayrık port" everywhere: ${text}`);
  ok(!/Önizleme mesh/i.test(text), `${key}: "Mesh önizlemesi", not "Önizleme mesh'i": ${text}`);
}
eq(tr["props.run.title"], "Çalıştırma", "the run noun");
eq(tr["dock.tab.runs"], "Çalıştırmalar", "the run list");
eq(tr["dock.tab.run"], "Çalıştırma", "the run dock tab");
ok(!/başlangıç/i.test(tr["templates.patch.name"] + tr["home.newProject.startFrom"] + tr["sim.profile.choice"]), "a starter design or a preset is not 'başlangıç' (start)");
ok(tr["results.sparams.noBand"] !== "bantta yok", "-10 dB band: no 'bantta yok'");
// the template names and default labels are translated
for (const key of ["templates.empty.name", "params.defaultLabel.designFrequency", "params.defaultLabel.newParameter", "pcbImport.f0"]) ok(tr[key] && tr[key] !== en[key], `${key} is translated`);
// shortened or wrapped: the two strings that were cut off
ok(tr["run.threads.autoHint"].length <= 80, "the threads hint fits");
ok(tr["run.name.placeholder"].length <= 30, "the run name placeholder fits");
const runDialog = read("src/designer/RunDialog.tsx");
ok((runDialog.match(/class="dz-value dz-wrap"/g) ?? []).length >= 3, "the Run dialog's hints wrap instead of being cut");
ok(/\.dz-value\.dz-wrap \{[^}]*white-space: normal/.test(read("src/styles/designer.css")), "dz-wrap lets a hint wrap");

// ---- the Start screen names a new design in the interface language; its file name is ASCII
const home = read("src/home/Home.tsx");
ok(/const base = tpl \? t\(tpl\.name\)/.test(home), "the suggested name is translated");
const { suggestDesignId } = await import("../src/lib/designId.ts");
eq(suggestDesignId("Boş tasarım"), "bos_tasarim", "Turkish letters make an ASCII file name (ş, ı)");
eq(suggestDesignId("Çeyrek dalga monopol"), "ceyrek_dalga_monopol", "ç");
eq(suggestDesignId("İki portlu hat"), "iki_portlu_hat", "İ");
eq(suggestDesignId("Half-wave dipole 2"), "half_wave_dipole_2", "English names are unchanged");
// the favourite star keeps its distance from the name and from Delete
const ux = read("src/styles/designer-ux.css");
ok(/\.home-row > \.home-favorite \{ margin-inline: var\(--al-space-3\)/.test(ux), "the star is set apart from the name");
ok(/\.home-row > \.home-del \{[^}]*border-inline-start/.test(ux), "Delete is divided from the star");

// ---- default parameter labels
const { paramLabelText } = await import("../src/lib/paramLabel.ts");
const { setLanguage, setDecimalChoice, fmt } = await import("../src/i18n/index.ts");
eq(paramLabelText("Design frequency"), "Design frequency", "English: as it is");
eq(paramLabelText("Slot width"), "Slot width", "a typed label is never translated");
eq(paramLabelText(undefined), undefined, "no label");
setLanguage("tr");
eq(paramLabelText("Design frequency"), "Tasarım frekansı", "Turkish: the template's label is translated");
eq(paramLabelText("Slot width"), "Slot width", "a typed label stays as typed in Turkish too");
const store = read("src/designer/store.ts");
const addParam = store.slice(store.indexOf("export function addParam"), store.indexOf("export function addMaterial"));
ok(!/label:/.test(addParam), "the placeholder 'New parameter' is not stored as the parameter's label");

// ---- numbers shown as text
const { shown } = await import("../src/designer/displayNumber.ts");
setDecimalChoice("language");
eq(shown(2.45), "2,45", "Turkish decimal comma");
eq(shown(-4.5), "−4,5", "U+2212 in Turkish");
eq(fmt.int(9700), "9.700", "Turkish grouping");
setDecimalChoice("point");
eq(shown(-4.5), "−4.5", "U+2212 with a point chosen");
eq(fmt.int(9700), "9,700", "a point chosen: the grouping follows (one notation)");
setDecimalChoice("language");
setLanguage("en");
eq(shown(2.45), "2.45", "English decimal point");
eq(shown(-0.5), "−0.5", "U+2212 in English");
const cts = read("src/designer/checkText.ts");
ok(/if \(!decimalComma\(\) \|\| RAW\.has\(name\)\) return v;/.test(cts), "the Checks text follows the decimal setting, not the language alone");
for (const file of ["ParametersDock.tsx", "DesignPane.tsx", "RibbonField.tsx", "StatusBar.tsx", "draw.ts"]) {
  ok(/shown as fmt/.test(read(`src/designer/${file}`)), `${file} shows evaluated numbers through displayNumber`);
}
ok(/fmt\.num\(p\.value, 6\)/.test(read("src/components/ModelPanel.tsx")), "the Parameters list of a result shows numbers in the notation");
ok(/decimalNote/.test(read("src/designer/DesignPane.tsx")), "the Design panel says inputs keep the point");
ok(en["checks.msg.expr.unexpectedComma"] === "unexpected ','", "a comma typed in an expression is answered (Turkish hint)");

// ---- Properties facts (a run, a parameter, an optimization): label/value rows, one notation for Dmax
const propsExtras = read("src/designer/PropsExtras.tsx");
ok(/out\.push\(\["Dmax", `\$\{num\(x\.farfield\.dmaxDbi, 2\)\} dBi`\]\)/.test(propsExtras), "Properties shows Dmax with two decimals");
ok(/num\(m\(\)!\.farfield!\.dmaxDbi, 2\)/.test(read("src/designer/RunDock.tsx")), "the Runs table shows Dmax with the same two decimals");
const designerCss = read("src/styles/designer.css");
ok(/\.dz-facts \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(88px, 1fr\) minmax\(0, max-content\)/.test(designerCss), "facts are a two-column grid like the example panel's rows");
ok(/\.dz-facts dt \{[^}]*color: var\(--al-text-3\)/.test(designerCss) && /\.dz-facts dd \{[^}]*margin: 0;[^}]*text-align: right/.test(designerCss), "a muted label left, the value right (no browser indent on dd)");
ok((propsExtras.match(/<dl class="dz-facts">/g) ?? []).length >= 5, "the run, parameter and optimization facts use the styled list");

// ---- stale banners (behaviour: check-designer-feedback.mjs)
const core = read("src/designer/sessionCore.ts");
ok(/retireMessage\(\["good", "critical"\]\);\s*effects\.edited/.test(core), "an edit retires success and error banners");
ok(/retireMessage\(\["good", "critical"\]\);\s*effects\.restored/.test(core), "undo and redo retire them too");
ok(/createEffect\(on\(selection, \(\) => retireMessage\(\["good"\]\)/.test(core), "a selection change retires a success banner");

// ---- the Parameters dock
const dock = read("src/designer/ParametersDock.tsx");
ok(/keyCellChecks/.test(dock) && /\\\.\(expr\|default\)\$/.test(dock), "one bad expression is one error row (the expression cell shows its own message)");
ok(/e\.key === "Escape" && e\.target !== row/.test(dock) && /rowEdit\.cancel\(\)/.test(dock), "Escape reverts the typing of the row");

// ---- the WCS is named in u, v, w once it is local
const ws = read("src/designer/DesignWorkspace.tsx");
ok(/t\("wcs\.dialog\.about", \{ axis: a \}\)/.test(read("src/designer/dialogs/WcsDialog.tsx")), "the Transform WCS rotation fields name the axis they turn about");
ok(/\{axis\}/.test(en["wcs.dialog.about"]), "the label is a template with the axis");

// ---- empty tree sections: a short "none yet" that fits at 1280 px, the whole hint as tooltip and description
const navTree = read("src/designer/NavTree.tsx");
ok(/results\.length \? \{ title: t\("tree\.results\.title"\) \} : \{ sub: t\("tree\.section\.noneYet"\), hint: t\("tree\.results\.none"\) \}/.test(navTree), "Results without runs: 'none yet', the hint in the tooltip");
ok(/optimizations\.length \? \{ title: t\("tree\.optimizations\.title"\) \} : \{ sub: t\("tree\.section\.noneYet"\), hint: t\("optTree\.none"\) \}/.test(navTree), "Optimizations without records: 'none yet', the hint in the tooltip");
ok(/: r\.hint \?\? r\.title \?\?/.test(navTree) && /aria-description=\{r\.hint\}/.test(navTree), "the row's tooltip and accessible description carry the whole hint");
ok(/<Show when=\{r\.hint\}><Info size=\{12\} class="nt-hint-icon" aria-hidden="true" \/><\/Show>/.test(navTree), "an info icon marks that there is more to read");
for (const [lang, table] of [["en", en], ["tr", tr]]) ok(table["tree.section.noneYet"].length <= 12, `${lang}: the short form fits beside the section name`);

// ---- Translate copies
const nav = read("src/designer/NavTree.tsx");
ok(/t\("tree\.part\.copies", \{ count: n - 1, total: n \}\)/.test(nav) && !/`×\$\{n/.test(nav), "the tree says '2 copies (3 in total)', not ×3");
eq(en["tree.part.copies"].other.replace("{count}", "2").replace("{total}", "3"), "2 copies (3 in total)", "the English label");
const tf = read("src/designer/dialogs/TransformDialog.tsx");
const step = tf.slice(tf.indexOf('<Show when={operation() === "translate"}>'));
ok(step.indexOf('<div class="dz-vec-row">') < step.indexOf("transform.useLastTwo"), "the step fields come before the pick helpers (no scrolling to reach them)");

// ---- the camera fits again when the scene changes a lot
const vp = read("src/scene/Viewport.tsx");
ok(/refitWhenSceneChanged\(b\)/.test(vp) && /ratio > 3 \|\| ratio < 1 \/ 3/.test(vp), "a large change of the scene's size or place fits the view again");
ok(/framedByAddition/.test(vp), "an explicit addition's own framing is not overridden");

// ---- nothing in the designer jumps: tool hints float over the 3D view, the ribbon keeps its places
const app = read("src/App.tsx");
const stackStart = app.indexOf('<div class="rb-stack">');
ok(stackStart > 0 && !app.slice(stackStart, app.indexOf("</div>", stackStart)).includes("<DrawHint />"), "tool hints are not a row under the ribbon (that row resized the 3D view)");
ok(/<MainArea>[\s\S]*?<DrawHint \/>[\s\S]*?<\/MainArea>/.test(app), "tool hints are drawn inside the 3D view's stage");
ok(/export function DrawHint\(\) \{\s*return \(\s*<div class="dw-hints">/.test(ws), "every hint bar sits in the floating .dw-hints container");
const dCss = read("src/styles/designer.css");
ok(/\.dw-hints \{[^}]*position: absolute;/.test(dCss) && /\.stage \{[^}]*position: relative;/.test(read("src/styles/drawing.css")), "the hints are positioned over the stage, outside the layout");
ok(/\.dw-hints \{[^}]*top: calc\(var\(--al-pad-hud\) \+ var\(--al-control-h\) \+ var\(--al-space-2\)\)/.test(dCss), "the hints start below the camera-view row (the view buttons stay usable)");
const post = ws.slice(ws.indexOf('tab.key === "post"'));
ok(post.indexOf('t("ribbon.post.report")') > 0 && post.indexOf('t("ribbon.post.report")') < post.indexOf('t("ribbon.post.farfield")'), "Post-processing: the far-field quantity comes after PDF report, Package and Python (they keep their x)");
const ribbonCss = read("src/styles/ribbon.css");
ok(/\.rb-shell \.rb-result-note \{[^}]*min-width: 160px;[^}]*white-space: normal;[^}]*-webkit-line-clamp: 3;/.test(ribbonCss), "the Post-processing note wraps (up to three lines) instead of 'Sele…'");
ok(/<p class="rb-result-note" title=\{resultNote\(\)\}>\{resultNote\(\)\}<\/p>/.test(ws), "the note's tooltip carries the whole text");
ok(/:scope > :not\(\.rb-group\)[\s\S]{0,120}minWidth[\s\S]{0,80}const room = toolbar\.clientWidth - reserved;/.test(ws), "fitRibbon keeps the note's min-width free");

// ---- a new design opens on a usable ribbon tab
ok(/ribbonTab\(\) === "post"\) \{ setRibbonTab\("model"\)/.test(ws), "a design without results does not open on Post-processing");

console.log(`check-wording-polish: ${checks} checks passed.`);
