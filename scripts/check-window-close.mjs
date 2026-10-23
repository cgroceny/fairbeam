// Closing the desktop window or quitting must never drop an unsaved design without a decision (#99).
// The native shell (src-tauri/src/main.rs) holds the close request and asks the page with
// window.fairbeamWindowClose(kind, id) until it answers "close" or "cancel". This check plays the
// shell's side against the real Solid stores (designer/windowClose.ts, designer/store.ts) with a
// mocked run server and localStorage, without a DOM. The dialog's handlers are the same few calls
// (CloseProject.tsx: saveBeforeLeaving / closeDesign, then decideWindowClose); the native window is
// checked in the built app.
//
//   node scripts/check-window-close.mjs
//
// 1. No design open, or a clean one: "close" at once, every time (no loop through the question).
// 2. An edit, then close within the one-second backup delay: the question opens ("pending" while
//    it is open). Cancel keeps the window, the draft and the undo history, exactly once.
// 3. Save: a conflicting save, a failed save or an edit during the save keeps the question open;
//    only a clean save closes. An edit after the decision asks again.
// 4. Don't save: closes the design, drops its local backup, then "close".
// 5. A save still running (draft clean) is at stake too; without localStorage the question still
//    comes; an open "Save before creating…?" question answers "cancel"; Quit while "close the
//    window?" is open turns it into the quit question; a decision made for an older request is
//    not handed to a newer one.
import assert from "node:assert/strict";
import { build } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
const built = await build({
  root, configFile: false, logLevel: "silent", resolve: { conditions: ["browser"] },
  plugins: [{
    name: "window-close-entry",
    resolveId(id) { if (id.endsWith("window-close-entry")) return "\0window-close-entry"; },
    load(id) {
      if (id !== "\0window-close-entry") return;
      return ["designer/store", "designer/windowClose", "lib/unsavedWork", "editor/store", "designer/closeActivity", "runner/api"].map((path, i) =>
        `export * as m${i} from ${JSON.stringify(`${root}src/${path}.ts`)};`).join("\n");
    },
  }],
  build: { write: false, minify: false, lib: { entry: "window-close-entry", formats: ["es"] } },
});

// ------------------------------------------------------------------ browser stand-ins

let storageBlocked = false;
const storage = new Map();
const localStorageMock = {
  get length() { return storage.size; },
  key: i => [...storage.keys()][i] ?? null,
  getItem: (k) => storage.has(k) ? storage.get(k) : null,
  setItem: (k, v) => { storage.set(k, String(v)); },
  removeItem: (k) => { storage.delete(k); },
};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  get() { if (storageBlocked) throw new DOMException("blocked", "SecurityError"); return localStorageMock; },
});
globalThis.window = { confirm: () => true, dispatchEvent: () => true, addEventListener() {}, removeEventListener() {} };
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
const backupKey = () => [...storage.keys()].find(k => k.startsWith(`fairbeam:draft:v3:${scope}:a:${encodeURIComponent(hashes.a)}:`));
const files = { a: design("a") };
const hashes = { a: "a1" };
/** the next PUT's answer: "ok", "conflict", "offline", or a promise for a delayed "ok" */
let nextSave = "ok";
const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? "GET";
  const path = String(url).replace(/^\/api/, "");
  if (method === "GET" && path === "/models") return json(200, { models: [{ key: "a", kind: "design", file: "a.design.json", model: { name: "A" } }] });
  let m;
  if (method === "GET" && (m = /^\/designs\/(\w+)$/.exec(path))) {
    return json(200, { id: m[1], file: `${m[1]}.design.json`, design: files[m[1]], hash: hashes[m[1]], readonly: false, backup_scope: scope });
  }
  if (method === "PUT" && (m = /^\/designs\/(\w+)$/.exec(path))) {
    const how = nextSave;
    nextSave = "ok";
    if (how === "offline") throw new TypeError("fetch failed");
    if (how === "conflict") return json(409, { error: "changed on disk", current_hash: "disk" });
    if (how instanceof Promise) await how;
    files[m[1]] = JSON.parse(init.body).design;
    hashes[m[1]] = `${m[1]}${Math.random()}`;
    return json(200, { id: m[1], hash: hashes[m[1]], backup: null, validation: { valid: true, checks: [] } });
  }
  return json(404, { error: `not mocked: ${method} ${path}` });
};

const code = (Array.isArray(built) ? built[0] : built).output[0].code;
const { m0: store, m1: wc, m2: work, m3: editor, m4: activity, m5: api } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

// ------------------------------------------------------------------ the shell's side

let requestId = 0;
/** A close request as main.rs makes it: one id, asked again while "pending". */
const shellRequest = (kind = "window") => {
  const id = ++requestId;
  return { id, ask: (k = kind) => wc.answerWindowClose(k, id) };
};
const addPart = (name) => store.edit((d) => { d.parts.push({ name, material: "copper", primitives: [{ kind: "box", start: [0, 0, 0], stop: [1, 1, 1] }] }); });
const partNames = () => store.draft.parts.map((p) => p.name);
/** the dialog's Save button (CloseProject.tsx WindowCloseDialog) */
const dialogSave = () => store.saveBeforeLeaving(() => wc.decideWindowClose("close"));
/** the dialog's Don't save button */
const dialogDiscard = () => wc.approveWindowDiscard();
async function openA() {
  await store.openDesign("a");
  assert.equal(store.file()?.id, "a");
  assert.equal(store.dirty(), false);
}

// ------------------------------------------------------------------ 1. nothing at stake

{
  const r = shellRequest();
  assert.equal(r.ask(), "close", "no design open: the window closes at once");
  assert.equal(wc.windowClose(), null);
  await openA();
  const clean = shellRequest("quit");
  assert.equal(clean.ask(), "close", "a clean design: Quit goes at once");
  assert.equal(clean.ask(), "close", "asking again does not open the question");
  assert.equal(wc.windowClose(), null);
}

// ------------------------------------------------------------------ 2. Cancel, within the backup delay

await openA();
{
  addPart("quick");
  store.setSelection({ type: "part", i: 1 });
  assert.equal(storage.has(backupKey()), false, "closed within a second: no backup yet");
  const r = shellRequest();
  assert.equal(r.ask(), "pending", "an unsaved edit raises the question");
  assert.deepEqual(wc.windowClose(), { kind: "window", id: r.id });
  assert.equal(r.ask(), "pending", "still open while the dialog is up");
  wc.decideWindowClose("cancel");
  assert.equal(r.ask(), "cancel", "Cancel keeps the window");
  assert.equal(wc.windowClose(), null);
  assert.deepEqual(partNames(), ["patch", "quick"], "Cancel keeps the draft");
  assert.deepEqual(store.selection(), { type: "part", i: 1 }, "Cancel keeps the selection");
  assert.equal(store.canUndo(), true, "Cancel keeps the undo history");
  // the Cancel was for that request only: the next close asks again
  const next = shellRequest();
  assert.equal(next.ask(), "pending", "a later close asks again");
  wc.decideWindowClose("cancel");
  assert.equal(next.ask(), "cancel");
  await sleep(1150);
  assert.ok(storage.has(backupKey()), "after the delay the draft is backed up (#83), and still asked for");
  const late = shellRequest();
  assert.equal(late.ask(), "pending");
  wc.decideWindowClose("cancel");
  assert.equal(late.ask(), "cancel");
}

// ------------------------------------------------------------------ 3. Save

{
  const r = shellRequest();
  assert.equal(r.ask(), "pending");
  nextSave = "conflict";
  assert.equal(await dialogSave(), false, "a conflicting save does not close");
  assert.equal(r.ask(), "pending", "the question stays open after a conflict");
  nextSave = "offline";
  assert.equal(await dialogSave(), false, "a failed save does not close");
  assert.equal(r.ask(), "pending");
  let release;
  nextSave = new Promise((resolve) => { release = resolve; });
  const saving = dialogSave();
  await sleep(0);
  assert.equal(r.ask(), "pending", "a save in progress: still pending");
  addPart("during_save");
  release();
  assert.equal(await saving, false, "an edit during the save keeps the window");
  assert.equal(r.ask(), "pending");
  assert.equal(await dialogSave(), true, "a clean save");
  assert.equal(files.a.parts.at(-1).name, "during_save", "the saved file holds the draft");
  assert.equal(r.ask(), "close", "a clean save closes");
  assert.equal(r.ask(), "close", "and nothing asks again");
}
await openA();
{
  addPart("again");
  const r = shellRequest();
  assert.equal(r.ask(), "pending");
  assert.equal(await dialogSave(), true);
  addPart("after_decision");   // before the shell's next question (up to 150 ms)
  assert.equal(r.ask(), "pending", "an edit after Save asks again instead of closing");
  wc.decideWindowClose("cancel");
  assert.equal(r.ask(), "cancel");
}

// ------------------------------------------------------------------ 4. Don't save

{
  await sleep(1150);
  assert.ok(storage.has(backupKey()));
  const r = shellRequest("quit");
  assert.equal(r.ask(), "pending");
  dialogDiscard();
  assert.equal(r.ask(), "close", "Don't save quits");
  assert.equal(store.file(), null, "the design is closed");
  assert.equal(storage.has(backupKey()), false, "Don't save drops the draft's local backup");
  assert.equal(shellRequest().ask(), "close", "nothing left to ask about");
}

// ------------------------------------------------------------------ 5. edge cases

await openA();
{
  // a save still running on a clean draft: the server must not stop under it
  addPart("saving");
  let release;
  nextSave = new Promise((resolve) => { release = resolve; });
  const saving = store.save();
  await sleep(0);
  assert.equal(store.saving(), true);
  const r = shellRequest();
  assert.equal(r.ask(), "pending", "a running save is at stake");
  release();
  assert.equal(await saving, true);
  assert.equal(wc.unsavedAtStake(), false);
  // the dialog's effect decides "close" once the save finished cleanly
  wc.decideWindowClose("close");
  assert.equal(r.ask(), "close");
}
storageBlocked = true;
await openA();
{
  addPart("no_storage");
  await sleep(1150);
  const r = shellRequest();
  assert.equal(r.ask(), "pending", "without localStorage the question still comes");
  wc.decideWindowClose("cancel");
  assert.equal(r.ask(), "cancel");
  assert.equal(partNames().at(-1), "no_storage", "the draft stays in memory");
}
storageBlocked = false;
{
  // an open "Save changes before creating…?" question is answered first
  const created = store.createDesign({ id: "b", name: "B" });
  assert.ok(store.replaceRequest());
  const r = shellRequest();
  assert.equal(r.ask(), "cancel", "no second question over the open one");
  assert.equal(wc.windowClose(), null);
  store.replaceRequest().decide(false);
  assert.equal(await created, null);
}
{
  // Quit while "close the window?" is open
  const r = shellRequest("window");
  assert.equal(r.ask(), "pending");
  assert.equal(r.ask("quit"), "pending");
  assert.equal(wc.windowClose().kind, "quit", "the question becomes the quit question");
  wc.decideWindowClose("cancel");
  assert.equal(r.ask(), "cancel");
}
{
  // a decision the shell never collected (an older request) is not handed to a newer one
  const old = shellRequest();
  assert.equal(old.ask(), "pending");
  wc.decideWindowClose("cancel");
  const fresh = shellRequest();
  assert.equal(fresh.ask(), "pending", "a stale Cancel does not answer a new request");
  wc.decideWindowClose("cancel");
  assert.equal(fresh.ask(), "cancel");
}

// Update installation asks after download, keeps its continuation separate from Quit,
// and cannot discard a draft merely because a later native confirmation might be canceled.
store.closeDesign();
await openA();
{
  addPart('during_download');
  const r = shellRequest('update');
  assert.equal(r.ask(), 'pending', 'edits made during download require update consent');
  assert.equal(wc.windowClose().kind, 'update');
  wc.decideWindowClose('cancel');
  assert.equal(r.ask(), 'cancel');
  assert.equal(partNames().at(-1), 'during_download');
  assert.equal(wc.updateApproved(), null);
}
{
  const r = shellRequest('update');
  assert.equal(r.ask(), 'pending');
  wc.approveUpdateDiscard();
  addPart('after_update_choice');
  assert.equal(r.ask(), 'pending', 'new edits invalidate the update discard snapshot');
  wc.approveUpdateDiscard();
  assert.equal(r.ask(), 'close');
  assert.equal(wc.updateApproved(), r.id, 'approval freezes editing before native continuation');
  assert.ok(store.dirty());
  assert.equal(partNames().at(-1), 'after_update_choice', 'update consent retains the live draft');
  assert.equal(shellRequest('quit').ask(), 'cancel', 'an install reservation cannot be stolen');
  wc.finishUpdate(r.id); // Later or installer failure
  assert.equal(wc.updateApproved(), null);
  assert.ok(store.dirty(), 'postponed update keeps unsaved work');
}
{
  const r = shellRequest('update');
  assert.equal(r.ask(), 'pending');
  assert.equal(r.ask('quit'), 'pending');
  assert.equal(wc.windowClose().kind, 'quit', 'native Quit replaces pending install, not vice versa');
  wc.finishUpdate(r.id);
  assert.equal(wc.windowClose().kind, 'quit', 'canceling the install must not dismiss native Quit');
  wc.decideWindowClose('cancel');
  assert.equal(r.ask('quit'), 'cancel');
}
{
  let release;
  nextSave = new Promise(resolve => { release = resolve; });
  const save = store.save();
  await sleep(0);
  const r = shellRequest('update');
  assert.equal(r.ask(), 'pending');
  wc.approveUpdateDiscard();
  assert.equal(wc.updateApproved(), null, 'an in-flight save cannot be discarded for install');
  release();
  assert.equal(await save, true);
  wc.decideWindowClose('close');
  assert.equal(r.ask(), 'close');
  wc.finishUpdate(r.id);
}

// Python source edits participate even with no designer open. Approval keeps text
// intact until the shell actually exits, and never authorizes newer edits.
store.closeDesign();
editor.setFile({id:'source',file:'source.py',source:'old',hash:'h'});
editor.setDraft('unsaved');
assert.equal(shellRequest().ask(), 'pending', 'real editor provider blocks native exit');
// Replace only the confirmation UI; retain the real editor state in the provider.
let resolveChoice;
work.registerUnsavedWork('python-code', {
  snapshot: () => editor.dirty() ? editor.draft() : null,
  busy: editor.saving,
  confirm: () => new Promise(resolve => { resolveChoice = resolve; }),
});
work.resetUnsavedWorkApproval();
let r = shellRequest();
assert.equal(r.ask(), 'pending'); await sleep(0);
resolveChoice(false); await sleep(0);
assert.equal(r.ask(), 'cancel');
assert.equal(editor.draft(), 'unsaved');
r = shellRequest('quit');
assert.equal(r.ask(), 'pending'); await sleep(0);
resolveChoice(true); await sleep(0);
assert.equal(r.ask(), 'close');
assert.equal(editor.draft(), 'unsaved', 'approval must not discard before other dialogs settle');
editor.setDraft('newer');
assert.equal(r.ask(), 'pending', 'new edits require new approval'); await sleep(0);
resolveChoice(true); await sleep(0);
editor.setSaving(true);
assert.equal(r.ask(), 'pending', 'do not stop a source save');
editor.setSaving(false);
assert.equal(r.ask(), 'close');
{
  const update = shellRequest('update');
  assert.equal(update.ask(), 'pending', 'update consent is independent of a previous Quit');
  await sleep(0); resolveChoice(true); await sleep(0);
  editor.setSaving(true);
  assert.equal(update.ask(), 'pending', 'update waits for Python save as well');
  editor.setSaving(false);
  assert.equal(update.ask(), 'close');
  assert.equal(editor.draft(), 'newer');
  wc.finishUpdate(update.id);
  assert.equal(editor.draft(), 'newer', 'deferring install preserves Python text');
}
// Closing the actual app must query server-wide activity, including runs absent from local history.
editor.setDraft(editor.file().source);
const simulation = (id, status = "running") => ({ kind: "simulation", id, status });
const render = (id, status = "running") => ({ kind: "render", id, status });
let active = [simulation("other-workspace-running"), simulation("queued-sweep", "queued")];
assert.deepEqual(api.parseCloseActivity({ activity: [simulation("same"), render("same", "queued")] }),
  [simulation("same"), render("same", "queued")], "activity identity includes its manager kind");
for (const invalid of [null, {}, { activity: null }, { activity: [null] },
  { activity: [{ kind: "other", id: "x", status: "running" }] },
  { activity: [{ kind: "render", id: "x", status: "new-unknown-state" }] },
  { activity: [{ kind: "render", id: "", status: "running" }] },
  { activity: [render("duplicate"), render("duplicate")] }]) {
  assert.throws(() => api.parseCloseActivity(invalid), "unavailable or ambiguous status cannot clear exit");
}
let readError = false;
let readDeferred = null;
let reads = 0;
const unregister = activity.registerCloseActivity(async () => {
  reads++;
  if (readDeferred) return await readDeferred;
  if (readError) throw new Error("server unavailable");
  return [...active];
});
{
  const r = shellRequest("quit");
  assert.equal(r.ask(), "pending", "clean app waits for a fresh server-wide run query");
  await sleep(0);
  assert.deepEqual(activity.closeActivity()?.counts, { simulations: 2, renders: 0 });
  assert.equal(r.ask(), "pending", "runs question blocks quit");
  activity.decideCloseActivity(false);
  assert.equal(r.ask(), "cancel", "Cancel preserves active/queued runs");
}
{
  const r = shellRequest();
  assert.equal(r.ask(), "pending"); await sleep(0);
  activity.decideCloseActivity(true);
  assert.equal(r.ask(), "pending", "final exit checks activity again"); await sleep(0);
  assert.equal(r.ask(), "close", "same runs do not ask twice");
}
{
  await openA(); addPart("keep-until-all-consent");
  const r = shellRequest("quit");
  assert.equal(r.ask(), "pending"); await sleep(0);
  activity.decideCloseActivity(true);
  assert.equal(r.ask(), "pending", "designer consent follows run consent");
  wc.approveWindowDiscard();
  active.push(render("new-render-during-draft-question", "queued"));
  assert.equal(r.ask(), "pending"); await sleep(0);
  assert.deepEqual(activity.closeActivity()?.counts, { simulations: 2, renders: 1 }, "a new render needs consent");
  activity.decideCloseActivity(false);
  assert.equal(r.ask(), "cancel");
  assert.ok(store.dirty(), "Cancel after Don't save retains the draft");
  assert.equal(partNames().at(-1), "keep-until-all-consent");
  await sleep(1150);
  assert.ok(storage.has(backupKey()), "Cancel retains the local backup");
  store.closeDesign();
}
{
  active = []; readError = true;
  const r = shellRequest();
  assert.equal(r.ask(), "pending"); await sleep(0);
  assert.equal(activity.closeActivity()?.counts, null, "unavailable status needs explicit consent");
  activity.decideCloseActivity(false);
  assert.equal(r.ask(), "cancel");
  readError = false;
}
{
  let release;
  readDeferred = new Promise(resolve => { release = resolve; });
  const old = shellRequest(); assert.equal(old.ask(), "pending");
  readDeferred = null;
  const next = shellRequest(); assert.equal(next.ask(), "pending");
  await sleep(0);
  release([render("stale")]); await sleep(0);
  assert.equal(activity.closeActivity(), null, "stale response cannot open a new request's question");
  assert.equal(next.ask(), "pending"); await sleep(0);
  assert.equal(next.ask(), "close");
}
{
  await openA(); addPart("replace-during-status");
  let release;
  readDeferred = new Promise(resolve => { release = resolve; });
  const r = shellRequest(); assert.equal(r.ask(), "pending");
  const created = store.createDesign({ id: "b", name: "B" });
  assert.ok(store.replaceRequest());
  assert.equal(r.ask(), "cancel", "replacement question cancels the pending exit");
  release([render("late-running")]); await sleep(0);
  assert.equal(activity.closeActivity(), null, "a canceled exit's late status cannot open a run question");
  store.replaceRequest().decide(false);
  assert.equal(await created, null);
  readDeferred = null;
  store.closeDesign();
}
{
  const before = reads;
  const r = shellRequest("update");
  assert.equal(r.ask(), "close", "updates retain their existing native runs warning");
  assert.equal(reads, before);
  wc.finishUpdate(r.id);
}
{
  active = [simulation("same")];
  const r = shellRequest("quit");
  assert.equal(r.ask(), "pending"); await sleep(0);
  activity.decideCloseActivity(true);
  // The approved simulation finishes and a render gets the same raw ID.
  active = [render("same", "queued")];
  assert.equal(r.ask(), "pending"); await sleep(0);
  assert.deepEqual(activity.closeActivity()?.counts, { simulations: 0, renders: 1 }, "render cannot inherit simulation consent");
  activity.decideCloseActivity(true);
  active.push(render("arrived-during-final-question"));
  assert.equal(r.ask(), "pending"); await sleep(0);
  assert.deepEqual(activity.closeActivity()?.counts, { simulations: 0, renders: 2 }, "work added during final activity consent asks again");
  activity.decideCloseActivity(true);
  assert.equal(r.ask(), "pending"); await sleep(0);
  assert.equal(r.ask(), "close", "approved identities need no repeated consent");
}
{
  active = [render("finishes")];
  const r = shellRequest();
  assert.equal(r.ask(), "pending"); await sleep(0);
  activity.decideCloseActivity(true);
  active = [];
  assert.equal(r.ask(), "pending"); await sleep(0);
  assert.equal(r.ask(), "close", "completed renders do not demand a second question");
}
{
  readError = true;
  const r = shellRequest("quit");
  assert.equal(r.ask(), "pending"); await sleep(0);
  activity.decideCloseActivity(true);
  readError = false; active = [render("appeared-after-unknown")];
  assert.equal(r.ask(), "pending"); await sleep(0);
  assert.deepEqual(activity.closeActivity()?.counts, { simulations: 0, renders: 1 }, "unknown consent does not approve subsequently known work");
  activity.decideCloseActivity(false);
  assert.equal(r.ask(), "cancel");
  active = [];
}
unregister();
console.log("check-window-close: designer/Python consent, typed simulation/render activity, unknown status, final recheck and stale replies pass");
