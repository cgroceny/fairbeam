// A failed designer preview (#103): the last successful geometry stays on screen, but its mesh
// numbers are marked as the last successful preview's (or unknown), the Checks list says that the
// server gave no verdict, and only a successful preview of the current draft makes them current
// again. Exercises the real Solid stores (designer/store.ts, runner/store.ts) with a mocked run
// server, without a DOM; the status bar and ribbon readouts are checked in the browser.
//
//   node scripts/check-preview-failure.mjs
//
// 1. A network failure keeps the shown bundle (and its #88 cell count) but marks it stale, installs
//    the "server checks unavailable" warning instead of an all-clear, and survives later edits while
//    the server stays unreachable.
// 2. An out-of-order success for an older edit cannot clear the failure of a newer one; a server
//    error without checks keeps it too; Retry with a working server makes everything current.
// 3. A design that does not build (the server answers with its checks): those checks are shown, the
//    mesh stays stale, no "unavailable" entry.
// 4. Undo and redo recover; a server that comes back (probe) rebuilds the preview without an edit.
// 5. Another document or an opened result forgets the failure; a failure without a preview of this
//    design on screen leaves the mesh unknown.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
const modules = ["designer/store", "runner/store", "state", "workspace", "designer/meshStats"];
const built = await build({
  root, configFile: false, logLevel: "silent", resolve: { conditions: ["browser"] },
  plugins: [{
    name: "preview-failure-entry",
    resolveId(id) { if (id.endsWith("preview-failure-entry")) return "\0preview-failure-entry"; },
    load(id) {
      if (id !== "\0preview-failure-entry") return;
      return modules.map((path, i) => `export * as m${i} from ${JSON.stringify(`${root}src/${path}.ts`)};`).join("\n");
    },
  }],
  build: { write: false, minify: false, lib: { entry: "preview-failure-entry", formats: ["es"] } },
});

// ------------------------------------------------------------------ browser stand-ins

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
globalThis.window = { confirm: () => true, dispatchEvent: () => true, addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame = () => 0;   // no browser-built quick preview: only server previews open bundles
globalThis.cancelAnimationFrame = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));
const design = (id) => ({
  schema: "fairbeam.design/1", model: { id, name: id.toUpperCase() }, params: [],
  materials: [{ name: "copper", kind: "metal" }],
  parts: [{ name: "patch", material: "copper", primitives: [{ kind: "box", start: [0, 0, 0], stop: [10, 20, 0] }] }],
  ports: [], resistors: [], simulation: { f_min: 1, f_max: 2, boundaries: "MUR" }, mesh: { cells_per_wavelength: 20 }, far_field: { enabled: false },
});
const files = { a: design("a"), c: design("c") };
// run-blocking errors of the current draft, by code
const runErrors = () => store.checks().filter((c) => c.severity === "error").map((c) => c.code);

// the server's preview: the patch fixture without results, its x lines refined with the cells per
// wavelength, so the 20 and 24 cells/λ previews have different, known cell counts
const fixture = JSON.parse(readFileSync(`${root}public/projects/patch-antenna.json`, "utf8"));
delete fixture.results; delete fixture.fields; delete fixture.run;
function previewBundle(d) {
  const b = clone(fixture);
  const cpw = d.mesh.cells_per_wavelength ?? 20;
  const x = b.mesh.x;
  const extra = Math.max(0, (cpw - 20) * 3);
  for (let i = 0; i < extra; i++) x.push(x[x.length - 1] + 1);
  b.domain.max[0] = x[x.length - 1];
  b.name = d.model.name;
  b.preview = true;
  return b;
}

const calls = [];
/** how the next /api/preview answers: "ok", "offline" (network failure), "error500" (no checks),
 * "unbuildable" (422 with the server's checks), or a promise resolving to one of these */
let nextPreview = "ok";
let healthUp = true;
const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? "GET";
  const path = String(url).replace(/^\/api/, "");
  calls.push(`${method} ${path}`);
  if (path === "/health") {
    if (!healthUp) throw new TypeError("fetch failed");
    return json(200, { fairbeam: "test", openems: "test", engines: ["cpu"], cpu_count: 4, default_threads: 2 });
  }
  if (method === "GET" && path === "/models") return json(200, { models: Object.keys(files).map((key) => ({ key, kind: "design", file: `${key}.design.json`, model: { name: key.toUpperCase() } })) });
  if (method === "GET" && path === "/runs") return json(200, { runs: [] });
  let m;
  if (method === "GET" && (m = /^\/designs\/(\w+)$/.exec(path))) {
    return json(200, { id: m[1], file: `${m[1]}.design.json`, design: files[m[1]], hash: `${m[1]}1`, readonly: false });
  }
  if (method === "POST" && path === "/preview") {
    let how = nextPreview;
    nextPreview = "ok";
    const body = JSON.parse(init.body);
    if (how instanceof Promise) how = await how;
    if (how === "offline") throw new TypeError("fetch failed");
    if (how === "error500") return json(500, { error: "the preview worker exited" });
    if (how === "unbuildable") return json(422, { error: "the design does not build", fields: { "parts[0].primitives[0].stop[0]": "zero width" },
      checks: [{ severity: "error", path: "parts[0].primitives[0].stop[0]", code: "zero_size", message: "The box has zero width" }] });
    return json(200, { bundle: previewBundle(body.design), checks: [{ severity: "info", path: "mesh", code: "server_note", message: "Server note" }] });
  }
  return json(404, { error: `not mocked: ${method} ${path}` });
};

const code = (Array.isArray(built) ? built[0] : built).output[0].code;
const { m0: store, m1: runner, m2: state, m3: workspace, m4: mesh } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const posts = () => calls.filter((c) => c === "POST /preview").length;
const cells = () => mesh.meshStats(state.bundle())?.cells ?? null;
const codes = () => store.checks().map((c) => c.code);
const unavailable = () => store.serverChecks().filter((c) => c.code === store.PREVIEW_UNAVAILABLE);
const setCpw = (v) => store.edit((d) => { d.mesh.cells_per_wavelength = v; }, `cpw-${v}`);
/** wait for the designer's debounced preview (250 ms) and its answer */
const settle = () => sleep(320);
const until = async (ok, what) => {
  for (let i = 0; i < 100 && !ok(); i++) await sleep(10);
  assert.ok(ok(), what);
};

runner.setServerState("online");
workspace.setAppMode("design");
await store.openDesign("a");
await until(() => runner.previewState() === "ready", "the first preview completes");
const cells20 = cells();
assert.ok(cells20 > 0, "the 20 cells/λ preview has a mesh");
assert.equal(runner.meshFreshness(), "current");
assert.equal(runner.previewFailure(), null);
assert.ok(codes().includes("server_note"), "server checks of the successful preview are listed");

// ------------------------------------------------------------------ 1. network failure

{
  const shown = state.bundle();
  const opens = state.openCount();
  nextPreview = "offline";
  setCpw(24);
  await settle();
  assert.equal(runner.previewState(), "error");
  assert.equal(runner.previewFailure(), "The run server stopped responding.");
  assert.equal(runner.serverState(), "offline");
  assert.equal(state.bundle(), shown, "the last successful geometry stays on screen");
  assert.equal(state.openCount(), opens);
  assert.equal(cells(), cells20, "its #88 cell count is unchanged, only its provenance changes");
  assert.equal(runner.meshFreshness(), "stale", "the mesh numbers are marked as the last successful preview's");
  assert.equal(unavailable().length, 1, "Checks name the missing server verdict");
  assert.equal(unavailable()[0].severity, "warning", "a warning, not a run-blocking error");
  assert.ok(!codes().includes("server_note"), "the old server checks are not presented for the new draft");
  assert.ok(store.checks().some((c) => c.severity !== "info"), "no unqualified all-clear after a network failure");
  // the fixture design has no port, which is itself an error (a portless run is refused)
  assert.deepEqual(runErrors(), ["no-port"], "run validation (errors) is not changed by the warning");

  // later edits while the server stays unreachable: probed, not previewed, still stale
  healthUp = false;
  const before = posts();
  store.edit((d) => { d.model.description = "offline edit"; });
  await settle();
  assert.equal(posts(), before, "no preview is sent while the server does not answer its probe");
  assert.equal(runner.previewFailure(), "The run server is not reachable.");
  assert.equal(runner.meshFreshness(), "stale");
  assert.equal(unavailable().length, 1, "the failure stays visible after later edits");
  assert.equal(state.bundle(), shown);
}

// ------------------------------------------------------------------ 2. out of order, server error, Retry

{
  healthUp = true;
  let release;
  nextPreview = new Promise((r) => { release = r; });
  store.edit((d) => { d.model.description = "older edit"; });
  await until(() => posts() > 0 && runner.previewState() === "loading", "the preview of the older edit is pending");
  const shown = state.bundle();
  nextPreview = "error500";
  store.edit((d) => { d.model.description = "newer edit"; });   // supersedes the pending one
  release("ok");                                                // the older one answers "ok" late
  await settle();
  assert.equal(state.bundle(), shown, "a late answer for an older edit is not shown");
  assert.equal(runner.previewFailure(), "the preview worker exited", "a late success cannot validate the newer edit");
  assert.equal(runner.meshFreshness(), "stale");
  assert.equal(unavailable().length, 1, "a server error without checks is no verdict either");
  assert.match(unavailable()[0].explain, /the preview worker exited/);

  store.retryPreview();
  await until(() => runner.previewState() === "ready", "Retry builds the preview again");
  assert.equal(runner.previewFailure(), null, "a successful preview of the current draft clears the failure");
  assert.equal(runner.meshFreshness(), "current");
  assert.ok(cells() > cells20, "the 24 cells/λ mesh is shown now");
  assert.deepEqual(unavailable(), []);
  assert.ok(codes().includes("server_note"));
}

// ------------------------------------------------------------------ 3. a design that does not build

{
  const shown = state.bundle();
  nextPreview = "unbuildable";
  store.edit((d) => { d.parts[0].primitives[0].stop[0] = 0; });
  await settle();
  assert.equal(runner.meshFreshness(), "stale", "no new mesh: the numbers are the last successful ones");
  assert.equal(state.bundle(), shown);
  assert.deepEqual(unavailable(), [], "the server gave its verdict: no 'unavailable' entry");
  assert.ok(codes().includes("zero_size"), "the server's checks of the failed build are listed");
  assert.ok(store.errorCount() >= 1, "the failed build blocks the run as before");
}

// ------------------------------------------------------------------ 4. undo / redo, restored connectivity

{
  store.undo();
  await until(() => runner.previewState() === "ready", "undo builds the preview of the restored draft");
  assert.equal(runner.meshFreshness(), "current");
  assert.deepEqual(runErrors(), ["no-port"]);

  nextPreview = "offline";
  store.redo();
  await settle();
  assert.equal(runner.meshFreshness(), "stale");
  store.undo();   // healthUp: the probe finds the server and the preview succeeds
  await until(() => runner.previewState() === "ready", "undo after a failure recovers");
  assert.equal(runner.meshFreshness(), "current");

  // the server drops out and comes back: probing it (status bar, Run dialog) rebuilds the preview
  nextPreview = "offline";
  setCpw(22);
  await settle();
  assert.equal(runner.serverState(), "offline");
  assert.equal(runner.meshFreshness(), "stale");
  const before = posts();
  assert.equal(await runner.probeServer(), true);
  await until(() => runner.previewState() === "ready", "a server that is back rebuilds the failed preview");
  await sleep(50);
  assert.equal(posts(), before + 1, "exactly one rebuild, without another edit");
  assert.equal(runner.meshFreshness(), "current");
  assert.deepEqual(unavailable(), []);
}

// ------------------------------------------------------------------ 5. other document, opened result, unknown mesh

{
  nextPreview = "offline";
  setCpw(26);
  await settle();
  assert.equal(runner.meshFreshness(), "stale");
  let release;
  nextPreview = new Promise((r) => { release = r; });
  const opening = store.openDesign("c");
  await opening;
  assert.equal(runner.previewFailure(), null, "another document forgets the failure of the previous one");
  await until(() => runner.previewState() === "loading", "the new document's preview is on its way");
  assert.equal(runner.meshFreshness(), "updating", "its mesh is not presented as current before its preview");
  release("ok");
  await until(() => runner.previewState() === "ready", "the new document's preview completes");
  assert.equal(runner.meshFreshness(), "current");

  nextPreview = "offline";
  setCpw(30);
  await settle();
  assert.equal(runner.meshFreshness(), "stale");
  state.openBundle(clone(fixture), "Run result");   // e.g. a run's results opened from the tree
  assert.equal(runner.previewActive(), false);
  assert.equal(runner.previewFailure(), null, "an opened result forgets the preview failure");
  assert.equal(runner.meshFreshness(), "current", "the result's own mesh is its own");

  // a failure while no preview of this design is shown: no numbers of another bundle
  nextPreview = "offline";
  runner.setServerState("online");
  setCpw(32);
  await settle();
  assert.equal(runner.previewActive(), false);
  assert.equal(runner.meshFreshness(), "unknown");
}

workspace.setAppMode("home");
runner.invalidatePreview();
console.log("Preview failure checks passed: stale mesh provenance, visible failure, ordered recovery.");
process.exit(0);
