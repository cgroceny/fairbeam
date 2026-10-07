// The open design's draft must never be replaced without a decision, and its save status must
// follow the draft (#86). Exercises the real Solid stores (designer/store.ts) with a mocked run
// server, localStorage and window, without a DOM; the dialog itself (CloseProject.tsx) is checked in
// the browser.
//
//   node scripts/check-draft-lifecycle.mjs
//
// 1. Creating a design while the draft is dirty asks first: Cancel creates no file and keeps the
//    draft, selection and undo history; Don't save replaces only after the decision and drops the
//    old draft's local backup.
// 2. Save before a replacement: a conflicting save, a failed save or an edit during the save keeps
//    the old draft and the question open; only a clean, successful save lets the replacement go on.
// 3. Opening another design (enterDesign) asks the same way; a clean draft does not ask.
// 4. Without localStorage (blocked, private window) nothing changes: the question still comes.
// 5. The local backup follows every edit, not only the first one that made the draft dirty.
// 6. A later edit, undo or redo retires a "Saved…" status; a conflict warning stays.
import assert from "node:assert/strict";
import { build } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
const built = await build({
  root, configFile: false, logLevel: "silent", resolve: { conditions: ["browser"] },
  plugins: [{
    name: "draft-lifecycle-entry",
    resolveId(id) { if (id.endsWith("draft-lifecycle-entry")) return "\0draft-lifecycle-entry"; },
    load(id) {
      if (id !== "\0draft-lifecycle-entry") return;
      return ["designer/store", "workspace"].map((path, i) =>
        `export * as m${i} from ${JSON.stringify(`${root}src/${path}.ts`)};`).join("\n");
    },
  }],
  build: { write: false, minify: false, lib: { entry: "draft-lifecycle-entry", formats: ["es"] } },
});

// ------------------------------------------------------------------ browser stand-ins

let storageBlocked = false;
const storage = new Map();
const localStorageMock = {
  getItem: (k) => storage.has(k) ? storage.get(k) : null,
  setItem: (k, v) => { storage.set(k, String(v)); },
  removeItem: (k) => { storage.delete(k); },
};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  get() { if (storageBlocked) throw new DOMException("blocked", "SecurityError"); return localStorageMock; },
});
let confirms = 0;
globalThis.window = { confirm: () => { confirms++; return true; }, dispatchEvent: () => true, addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const design = (id) => ({
  schema: "fairbeam.design/1", model: { id, name: id.toUpperCase() }, params: [],
  materials: [{ name: "copper", kind: "metal" }],
  parts: [{ name: "patch", material: "copper", primitives: [{ kind: "box", start: [0, 0, 0], stop: [10, 20, 0] }] }],
  ports: [], resistors: [], simulation: { f_min: 1, f_max: 2, boundaries: "MUR" }, mesh: {}, far_field: { enabled: false },
});
let scope = 'models-v1:' + 'a'.repeat(64);
const backupKey = () => `fairbeam:draft:v2:${scope}:a:${encodeURIComponent(hashes.a)}`;
const files = { a: design("a"), c: design("c") };
const hashes = { a: "a1", c: "c1" };
const calls = [];
/** the next PUT's answer: "ok", "conflict", "offline", or a promise for a delayed "ok" */
let nextSave = "ok";
let saveChecks = [];
let createdMesh;
const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? "GET";
  const path = String(url).replace(/^\/api/, "");
  calls.push(`${method} ${path}`);
  if (method === "GET" && path === "/models") return json(200, { models: Object.keys(files).map((key) => ({ key, kind: "design", file: `${key}.design.json`, model: { name: key.toUpperCase() } })) });
  let m;
  if (method === "GET" && (m = /^\/designs\/(\w+)$/.exec(path))) {
    const id = m[1];
    return json(200, { id, file: `${id}.design.json`, design: files[id], hash: hashes[id], readonly: false, backup_scope: scope });
  }
  if (method === "PUT" && (m = /^\/designs\/(\w+)$/.exec(path))) {
    if (JSON.parse(init.body).backup_scope !== scope) return json(409, { error: "workspace changed", workspace_error: "scope_mismatch" });
    const how = nextSave;
    nextSave = "ok";
    if (how === "offline") throw new TypeError("fetch failed");
    if (how === "conflict") return json(409, { error: "changed on disk", current_hash: "disk" });
    if (how instanceof Promise) await how;
    const body = JSON.parse(init.body);
    files[m[1]] = body.design;
    hashes[m[1]] = `${m[1]}${Math.random()}`;
    return json(200, { id: m[1], hash: hashes[m[1]], backup: null, validation: { valid: true, checks: saveChecks } });
  }
  if (method === "POST" && path === "/designs") {
    const body = JSON.parse(init.body);
    files[body.id] = design(body.id);
    if (createdMesh) files[body.id].mesh = { mode: createdMesh };
    hashes[body.id] = `${body.id}1`;
    return json(200, { id: body.id, file: `${body.id}.design.json`, design: files[body.id], hash: hashes[body.id], readonly: false, backup_scope: scope, validation: { valid: true, checks: [] } });
  }
  return json(404, { error: `not mocked: ${method} ${path}` });
};

const code = (Array.isArray(built) ? built[0] : built).output[0].code;
const { m0: store, m1: workspace } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const posts = () => calls.filter((c) => c === "POST /designs").length;
const addPart = (name) => store.edit((d) => { d.parts.push({ name, material: "copper", primitives: [{ kind: "box", start: [0, 0, 0], stop: [1, 1, 1] }] }); });
const partNames = () => store.draft.parts.map((p) => p.name);
/** Start a replacement and return it with the question it raised. */
const pending = (start) => {
  const promise = start();
  const request = store.replaceRequest();
  return { promise, request };
};
async function openA() {
  await store.openDesign("a");
  assert.equal(store.file()?.id, "a");
  assert.equal(store.dirty(), false);
}
let n = 0;
const uniqueId = () => `new_${++n}`;

// ------------------------------------------------------------------ 1. Create: Cancel and Don't save

await openA();
addPart("extra");
store.setSelection({ type: "part", i: 1 });
assert.equal(store.dirty(), true);
{
  const before = posts();
  const { promise, request } = pending(() => store.createDesign({ id: uniqueId(), name: "New one", template: "patch" }));
  assert.ok(request, "a dirty draft must raise the question before creating");
  assert.equal(request.action, "create");
  assert.equal(request.target, "New one");
  await sleep(0);
  assert.equal(posts(), before, "nothing is created while the question is open");
  request.decide(false);
  assert.equal(await promise, null, "Cancel resolves without a result");
  assert.equal(posts(), before, "Cancel creates no file");
  assert.equal(store.replaceRequest(), null);
  assert.equal(store.file().id, "a");
  assert.deepEqual(partNames(), ["patch", "extra"], "Cancel keeps the draft");
  assert.deepEqual(store.selection(), { type: "part", i: 1 }, "Cancel keeps the selection");
  assert.equal(store.canUndo(), true, "Cancel keeps the undo history");
  assert.equal(store.dirty(), true);
}
{
  // wait past the backup delay: the old draft has a local backup (#83)
  await sleep(1150);
  assert.ok(storage.has(backupKey()), "the unsaved draft is backed up after a second");
  const before = posts();
  const id = uniqueId();
  const { promise, request } = pending(() => store.createDesign({ id, name: "Replacement", template: "empty" }));
  assert.ok(request);
  store.releaseDraft();
  request.decide(true);
  const res = await promise;
  assert.equal(res?.id, id);
  assert.equal(posts(), before + 1, "Don't save creates after the decision");
  assert.equal(store.file().id, id);
  assert.equal(storage.has(backupKey()), false, "Don't save drops the old draft's backup once the replacement is open");
  assert.equal(confirms, 0, "no window.confirm: the app's own dialog decides");
}
{
  // Don't save, then an edit before the replacement starts: the release no longer applies
  await openA();
  addPart("x1");
  store.releaseDraft();
  addPart("x2");
  const { promise, request } = pending(() => store.createDesign({ id: uniqueId(), name: "Later" }));
  assert.ok(request, "an edit after Don't save takes the release back: ask again");
  request.decide(false);
  await promise;
  assert.deepEqual(partNames(), ["patch", "x1", "x2"]);
}

// ------------------------------------------------------------------ 2. Save before a replacement

await store.openDesign("a");
{
  // the previous test left a dirty draft of a; openDesign directly (as the store's own paths do)
  // loads the saved file again, which is clean
  assert.equal(store.dirty(), false);
  addPart("to_save");
  const { promise, request } = pending(() => store.createDesign({ id: uniqueId(), name: "After save" }));
  assert.ok(request);
  nextSave = "conflict";
  assert.equal(await store.saveBeforeLeaving(), false, "a conflicting save does not let the replacement go on");
  assert.equal(store.replaceRequest(), request, "the question stays open after a conflict");
  assert.ok(store.conflict());
  assert.deepEqual(partNames(), ["patch", "to_save"]);
  nextSave = "offline";
  assert.equal(await store.saveBeforeLeaving(), false, "a failed save does not let the replacement go on");
  assert.match(store.message().text, /not reachable/);
  assert.deepEqual(partNames(), ["patch", "to_save"]);
  let release;
  nextSave = new Promise((r) => { release = r; });
  const saving = store.saveBeforeLeaving();
  await sleep(0);
  addPart("during_save");
  release();
  assert.equal(await saving, false, "an edit during the save keeps the old draft");
  assert.equal(store.dirty(), true);
  assert.deepEqual(partNames(), ["patch", "to_save", "during_save"]);
  assert.match(store.message().text, /Newer edits remain unsaved/);
  const before = posts();
  assert.equal(await store.saveBeforeLeaving(), true, "a clean, successful save lets it go on");
  assert.equal(files.a.parts.length, 3, "the saved file holds the draft");
  request.decide(true);
  await promise;
  assert.equal(posts(), before + 1);
}

// ------------------------------------------------------------------ 3. Opening another design

await openA();
{
  addPart("open_other");
  const draftBefore = partNames();
  const { promise, request } = pending(() => store.enterDesign("c"));
  assert.ok(request, "opening another design asks too");
  assert.equal(request.action, "open");
  assert.equal(request.target, "C");
  request.decide(false);
  await promise;
  assert.equal(store.file().id, "a", "Cancel keeps the open design");
  assert.deepEqual(partNames(), draftBefore);
  assert.equal(partNames().at(-1), "open_other");
  const again = pending(() => store.enterDesign("c"));
  store.releaseDraft();
  again.request.decide(true);
  await again.promise;
  assert.equal(store.file().id, "c");
  assert.equal(workspace.appMode(), "design");
  // a clean draft switches at once
  const clean = pending(() => store.enterDesign("a"));
  assert.equal(clean.request, null, "a clean draft does not ask");
  await clean.promise;
  assert.equal(store.file().id, "a");
}

// ------------------------------------------------------------------ 4. localStorage unavailable

storageBlocked = true;
await openA();
{
  addPart("no_storage");
  await sleep(1150);   // the backup would have been written now; it cannot be
  const before = posts();
  const { promise, request } = pending(() => store.createDesign({ id: uniqueId(), name: "Blocked" }));
  assert.ok(request, "without localStorage the question still comes");
  request.decide(false);
  await promise;
  assert.equal(posts(), before);
  assert.deepEqual(partNames(), [...files.a.parts.map((p) => p.name), "no_storage"], "the draft stays in memory");
  const r2 = pending(() => store.createDesign({ id: uniqueId(), name: "Blocked 2" }));
  store.releaseDraft();
  r2.request.decide(true);
  await r2.promise;
  assert.equal(posts(), before + 1, "Don't save works without localStorage");
}
storageBlocked = false;

// ------------------------------------------------------------------ 5. the backup follows every edit

await openA();
{
  addPart("first");
  await sleep(1150);
  assert.deepEqual(JSON.parse(storage.get(backupKey())).design.parts.map((p) => p.name).slice(-1), ["first"]);
  addPart("second");
  await sleep(1150);
  assert.deepEqual(JSON.parse(storage.get(backupKey())).design.parts.map((p) => p.name).slice(-2), ["first", "second"],
    "a later edit is backed up too");
  store.undo();
  store.undo();
  assert.equal(store.dirty(), false);
  await sleep(0);
  assert.equal(storage.has(backupKey()), false, "a clean draft removes its backup");
}

// ------------------------------------------------------------------ 6. the save status follows the draft

await openA();
{
  addPart("s1");
  assert.equal(await store.save(), true);
  assert.equal(store.message().text, "Saved.");
  addPart("s2");
  assert.equal(store.message(), null, "an edit retires Saved.");
  saveChecks = [{ code: "w", severity: "warning", path: "parts", message: "w" }];
  assert.equal(await store.save(), true);
  assert.match(store.message().text, /^Saved with 1 warning/);
  store.undo();
  assert.equal(store.message(), null, "undo retires the saved status");
  store.redo();
  assert.equal(await store.save(), true);
  store.redo();   // nothing to redo: the status stays
  assert.match(store.message().text, /^Saved/);
  store.undo();
  assert.equal(store.message(), null, "undo after a save retires it");
  store.redo();
  assert.equal(await store.save(), true);
  addPart("s3");
  store.undo();
  assert.equal(store.message(), null);
  store.redo();
  assert.equal(store.message(), null, "redo cannot bring back a Saved status");
  saveChecks = [];
  nextSave = "conflict";
  assert.equal(await store.save(), false);
  const warning = store.message();
  assert.match(warning.text, /changed on disk/);
  addPart("s4");
  assert.equal(store.message(), warning, "a conflict warning stays after an edit");
}

// ------------------------------------------------------------------ 7. Another document keeps its key order

// A lumped port and a waveguide port write their keys in different orders (as the Start screen's
// starters do). Opening one after the other must not take the previous document's key order, or
// the unchanged design reads as unsaved.
{
  const port = (extra) => ({ type: extra.mode ? "waveguide" : "lumped", number: 1, ...extra });
  files.lp = { ...design("lp"), ports: [{ ...port({ R: "50" }), start: [0, 0, 0], stop: [0, 0, 1], direction: "z" }] };
  files.wg = { ...design("wg"), ports: [port({ mode: "TE10", a: "22.86", b: "10.16", start: [0, 0, 0], stop: [1, 1, 1], direction: "z" })] };
  hashes.lp = "lp1";
  hashes.wg = "wg1";
  for (const [first, second] of [["lp", "wg"], ["wg", "lp"]]) {
    store.releaseDraft();
    await store.openDesign(first);
    assert.equal(store.dirty(), false, `${first} opens clean`);
    await store.openDesign(second);
    assert.equal(store.file()?.id, second);
    assert.equal(store.dirty(), false, `${second} opened after ${first} is clean`);
    assert.equal(JSON.stringify(store.draft.ports), JSON.stringify(files[second].ports));
  }
}

// ------------------------------------------------------------------ 8. The Parameter sweep dialog does not touch the draft

// Opening the dialog (or leaving it, or re-entering the design) must not mark the design unsaved or
// add an undo step; only a sweep that differs from the draft's is an edit, and Save clears it.
{
  store.releaseDraft();
  await store.openDesign("a");
  const steps = () => store.historySteps().length;
  const at = steps();
  assert.equal(store.dirty(), false);
  // what the dialog does on its own: nothing, and an "edit" back to the sweep the draft has
  store.editParameterSweep(undefined);
  assert.equal(store.dirty(), false, "no sweep to no sweep is not an edit");
  assert.equal(store.canUndo(), false);
  assert.equal(steps(), at);
  const sweep = () => ({ schema: "fairbeam.parameter-sweep/1", sequences: [{ name: "Sequence 1", axes: [{ key: "W", kind: "range", start: "28.8", stop: "35.2", steps: "5" }] }] });
  store.editParameterSweep(sweep());
  assert.equal(store.dirty(), true, "a new sweep is an edit");
  assert.equal(steps(), at + 1);
  assert.equal(await store.save(), true);
  assert.equal(store.dirty(), false, "saved");
  // the same sweep again (a name typed and retyped, an import of the same file): no edit
  store.editParameterSweep(sweep());
  assert.equal(store.dirty(), false, "the same sweep is not an edit");
  assert.equal(steps(), at + 1, "and adds no history entry");
  // the design entered again (Start list, Run panel): still clean, with the sweep kept
  store.releaseDraft();
  await store.openDesign("a");
  assert.equal(store.dirty(), false, "re-entering a design with a saved sweep is clean");
  assert.deepEqual(JSON.parse(JSON.stringify(store.draft.parameter_sweep)), sweep());
  store.editParameterSweep({ ...sweep(), sequences: [{ name: "Renamed", axes: sweep().sequences[0].axes }] });
  assert.equal(store.dirty(), true, "a changed sweep is an edit");
  store.undo();
  assert.equal(store.dirty(), false, "and Undo returns to the saved sweep");

  // the dialog's mount path holds no edit: writes happen in event handlers only
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/designer/SweepDialog.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const opener = src.slice(src.indexOf("export async function openDesignerSweep"), src.indexOf("export default function SweepDialog"));
  assert.ok(opener.length > 100 && !/editParameterSweep|\bput\(|\bmutate\(/.test(opener), "opening the dialog writes nothing to the design");
  const content = src.slice(src.indexOf("function Content()"));
  assert.equal((content.match(/createEffect\(/g) ?? []).length, 1, "the dialog has one effect (the run poll)");
  assert.ok(!/onMount\(/.test(content), "no mount hook edits the sweep");
}

// Creating a starter awaits its preferred-mesh save. Opening another document during that
// save must not apply the old starter's validation/status or reopen Design after it finishes.
{
  store.releaseDraft();
  await store.openDesign("a");
  // the server creates a Classic mesh; the default setting (the recommended automatic mesh) changes it
  createdMesh = "auto";
  let finishSave;
  nextSave = new Promise(resolve => { finishSave = resolve; });
  const before = calls.filter(x => x.startsWith("PUT ")).length;
  const creating = store.createDesign({ id: uniqueId(), template: "empty" });
  for (let i = 0; i < 50 && calls.filter(x => x.startsWith("PUT ")).length === before; i++) await sleep(0);
  assert.equal(calls.filter(x => x.startsWith("PUT ")).length, before + 1, "preferred mesh enters the awaited save");
  await store.openDesign("c");
  workspace.setAppMode("home");
  const mark = store.historyMark();
  finishSave();
  await creating;
  assert.equal(store.file().id, "c");
  assert.deepEqual(store.historyMark(), mark);
  assert.equal(store.message(), null, "old create cannot replace the new document status");
  assert.equal(workspace.appMode(), "home", "old create cannot reopen Design after switching away");
  createdMesh = undefined;
}

// Real default adapters keep same-id/same-hash workspaces and older saved bases separate.
{
  const aScope = 'models-v1:' + 'a'.repeat(64), bScope = 'models-v1:' + 'b'.repeat(64);
  const saved = design('a'); files.a = saved; hashes.a = 'shared-base'; scope = aScope;
  await store.openDesign('a'); addPart('only-A'); await sleep(1150);
  const aKey = backupKey(), beforeA = storage.get(aKey), markA = store.historyMark();
  scope = bScope;
  assert.equal(await store.save(), false, 'captured A scope cannot save to B even with same id and hash');
  assert.deepEqual(store.historyMark(), markA); assert.equal(store.dirty(), true);
  await store.openDesign('a', aScope);
  assert.equal(store.file().backup_scope, aScope, 'startup identity mismatch leaves previous draft untouched');
  await store.openDesign('a');
  assert.equal(store.file().backup_scope, bScope); assert.equal(store.dirty(), false);
  assert.equal(storage.get(aKey), beforeA, 'opening B does not erase A');
  addPart('only-B'); await sleep(1150); const bKey = backupKey();
  scope = aScope; await store.openDesign('a');
  assert.ok(partNames().includes('only-A')); assert.equal(partNames().includes('only-B'), false);
  store.undo(); assert.equal(store.dirty(), false); assert.ok(storage.has(bKey));
  // A newer saved base must not erase or overwrite the earlier recovery draft on open/edit/close.
  storage.set(aKey, beforeA); hashes.a = 'external-new-base';
  await store.openDesign('a'); assert.equal(store.dirty(), false); assert.equal(storage.get(aKey), beforeA);
  addPart('new-base-edit'); await sleep(1150); assert.equal(storage.get(aKey), beforeA);
  store.closeDesign(); assert.equal(storage.get(aKey), beforeA); assert.ok(storage.has(bKey));
}

console.log("check-draft-lifecycle: ok");
