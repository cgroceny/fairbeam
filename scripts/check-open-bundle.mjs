// openBundle (src/state.ts) must not make its caller depend on bundle(): an effect that opens a
// bundle (e.g. the History dialog's) re-ran on its own write and looped until "Maximum call stack
// size exceeded". Also checks that part visibility survives a reopen of the same
// model and resets for a different one. Real Solid stores, no DOM.
//
//   node scripts/check-open-bundle.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
const built = await build({
  root, configFile: false, logLevel: "silent", resolve: { conditions: ["browser"] },
  plugins: [{
    name: "open-bundle-entry",
    resolveId(id) { if (id.endsWith("open-bundle-entry")) return "\0open-bundle-entry"; },
    load(id) {
      if (id !== "\0open-bundle-entry") return;
      // solid-js from the same bundle, so the effect below shares the stores' reactive runtime
      return `export * as state from ${JSON.stringify(`${root}src/state.ts`)};\nexport * as solid from "solid-js";`;
    },
  }],
  build: { write: false, minify: false, lib: { entry: "open-bundle-entry", formats: ["es"] } },
});
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const code = (Array.isArray(built) ? built[0] : built).output[0].code;
const { state, solid } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const a = JSON.parse(readFileSync(`${root}public/projects/dipole.json`, "utf8"));
const b = JSON.parse(readFileSync(`${root}public/projects/patch-antenna.json`, "utf8"));
assert.notEqual(a.model.id, b.model.id, "the two fixtures must be different models");

let runs = 0;
const dispose = solid.createRoot((dispose) => {
  solid.createEffect(() => { runs++; if (runs > 5) throw new Error("effect loops"); state.openBundle(a, "dipole.json"); });
  return dispose;
});
assert.equal(runs, 1, "opening a bundle inside an effect runs it once");
assert.equal(state.bundle()?.model.id, a.model.id);
state.openBundle(b, "patch-antenna.json");
assert.equal(runs, 1, "a later openBundle must not re-run an effect that opened a bundle");
dispose();

state.openBundle(a, "dipole.json");
const name = state.bundle().model.id;
state.setHiddenParts("anything", true);
state.openBundle(a, "dipole.json");
assert.equal(state.hiddenParts.anything, true, `reopening ${name} keeps the hidden parts`);
state.openBundle(b, "patch-antenna.json");
assert.equal(state.hiddenParts.anything, undefined, "a different model starts with every part visible");
console.log("open-bundle: ok (no effect loop, visibility kept per model)");
