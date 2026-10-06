// The geometry export dialog mounts outside the Design tab. In Examples and Results
// (app mode "results") the bundle is there at once and the format starts as CST, so the CST macro memo runs
// while the dialog mounts; it called the file-stem helper declared below it and the dialog crashed with
// "Cannot access 'O' before initialization". This mounts the real dialog (Solid's server renderer, real
// stores, an example bundle) in results mode with the CST format, and in design mode, and checks that a
// dialog's error panel can be closed and is dismissed by navigation. No DOM, no server, no solver.
//
//   node scripts/check-export-dialog.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import solid from "vite-plugin-solid";

const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
const read = (p) => readFileSync(`${root}${p}`, "utf8").replace(/\r\n/g, "\n");
const built = await build({
  root, configFile: false, logLevel: "silent", css: { postcss: {} },
  plugins: [solid({ ssr: true }), {
    name: "export-dialog-entry",
    resolveId(id) { if (id.endsWith("export-dialog-entry")) return "\0export-dialog-entry"; },
    load(id) {
      if (id !== "\0export-dialog-entry") return;
      const src = (path) => JSON.stringify(`${root}src/${path}`);
      return [
        `export { default as ExportDialog } from ${src("components/ExportDialog.tsx")};`,
        `export { default as PanelBoundary } from ${src("components/PanelBoundary.tsx")};`,
        `export * as state from ${src("state.ts")};`,
        `export * as workspace from ${src("workspace.ts")};`,
        `export * as designer from ${src("designer/store.ts")};`,
        // the renderer from the same bundle, so the component and the stores share one reactive runtime
        `export { renderToString } from "solid-js/web";`,
        `export { createComponent } from "solid-js";`,
      ].join("\n");
    },
  }],
  ssr: { noExternal: true },
  build: {
    ssr: "export-dialog-entry", write: false, minify: false,
    rollupOptions: { output: { format: "es", inlineDynamicImports: true } },
  },
});
const chunk = (Array.isArray(built) ? built[0] : built).output.find((o) => o.type === "chunk");
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { ExportDialog, PanelBoundary, state, workspace, designer, renderToString, createComponent } =
  await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`);
const en = JSON.parse(read("src/i18n/en.json"));
const text = (html) => html.replace(/<!--[^>]*-->/g, "").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const mount = () => renderToString(() => createComponent(ExportDialog, {}));

// ---- results mode (Examples, Results): the bundle is there at once and the format starts as CST
const coupler = JSON.parse(read("public/projects/branchline-coupler.json"));
state.openBundle(coupler, "branchline-coupler.json");
workspace.setAppMode("results");
assert.equal(workspace.appMode(), "results");
let html;
assert.doesNotThrow(() => { html = mount(); }, "the export dialog mounts in results mode with the CST format");
const shown = text(html);
const stem = coupler.model.id.replace(/[^a-z0-9_-]+/gi, "_");
assert.match(html, /<select[^>]*value="cst"/, "outside the Design tab the dialog opens on CST (.bas)");
assert.ok(shown.includes(`${stem}.bas`), `the macro is named after the model (${stem}.bas)`);
assert.ok(shown.includes("Sub Main"), "the macro preview is rendered on open");
assert.ok(shown.includes(en["export.download"]), "the CST download button is offered");
assert.ok(!shown.includes(en["export.sourcePreparing"]), "a results bundle needs no design preview");

// a model id with characters CST does not take in a file name
state.openBundle({ ...coupler, model: { ...coupler.model, id: "branch line/coupler v2" } }, "renamed.json");
assert.ok(text(mount()).includes("branch_line_coupler_v2.bas"), "the file stem keeps letters, digits, _ and - only");
state.openBundle(coupler, "branchline-coupler.json");

// ---- design mode: the preview arrives later (onMount, not run here) and the format starts as Blender
const design = JSON.parse(read("examples/designs/ux_inset_patch_24.design.json"));
designer.setDraft(structuredClone(design));
designer.setFile({ file: "ux_inset_patch_24.design.json", hash: "1", design });
workspace.setAppMode("design");
assert.doesNotThrow(() => { html = mount(); }, "the export dialog mounts in design mode");
assert.match(html, /<select[^>]*value="blender"/, "in the Design tab the dialog opens on Blender");
assert.ok(text(html).includes(en["export.sourcePreparing"]), "the design's geometry is being prepared");
workspace.setAppMode("results");

// ---- a dialog that fails to render: its error panel can be closed (button, Escape via the shared modal)
const Broken = () => { throw new Error("broken on purpose"); };
let closed = 0;
const logged = [];
const boundary = (props) => {
  const error = console.error;
  console.error = (message, cause) => logged.push(`${message}: ${cause?.message}`); // the panel logs the error for bug reports
  try { return renderToString(() => createComponent(PanelBoundary, { name: "Geometry export", ...props, get children() { return createComponent(Broken, {}); } })); }
  finally { console.error = error; }
};
const dialogPanel = boundary({ onClose: () => closed++ });
const panelText = text(dialogPanel);
assert.ok(panelText.includes("Geometry export failed to render: broken on purpose"), "the error is shown");
assert.match(dialogPanel, /role="alertdialog"/, "a dialog's error panel is a modal alert in the dialog's place");
assert.match(dialogPanel, new RegExp(`<button[^>]*aria-label="${en["common.close"]}"`), "a dialog's error panel has a close button");
assert.ok(panelText.includes(en["panel.reload"]), "it can still be reloaded");
const inlinePanel = boundary({});
assert.ok(!/role="alertdialog"/.test(inlinePanel) && !new RegExp(`aria-label="${en["common.close"]}"`).test(inlinePanel), "a workspace panel's error stays inline, without a close button");
assert.equal(closed, 0, "rendering does not close anything");
assert.deepEqual(logged, Array(2).fill("[fairbeam] Geometry export failed to render: broken on purpose"), "the error is logged (once per panel), for bug reports");

// the dialogs are wired to close from their error panel, and navigation closes them
const app = read("src/App.tsx");
for (const [name, setter] of [["Geometry export", "setExportOpen"], ["Render image", "setRenderDialogOpen"], ["Package export", "setPackageOpen"]]) {
  assert.match(app, new RegExp(`<PanelBoundary name="${name}".*onClose=\\{\\(\\) => ${setter}\\(false\\)\\}`), `${name}: its error panel closes the dialog`);
}
assert.match(app, /createEffect\(on\(appMode, \(\) => \{ setExportOpen\(false\); if \(!renderBusy\(\)\) setRenderDialogOpen\(false\); setPackageOpen\(false\); \}, \{ defer: true \}\)\)/,
  "going to another screen (Start, Design, Examples) closes the export dialogs and their error panels");

console.log("check-export-dialog: ok (results mode opens on CST with the macro, design mode on Blender; a dialog's error panel closes)");
