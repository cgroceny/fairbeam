// Runs the open window did not start and the queue controls (#8). The run
// store is bundled like check-run-context.mjs and driven with a fake server:
//   - a change of /api/health's queue (running, queued, version, external) fetches the run list
//     again; an unchanged queue does not; a run that ended since the last list reloads the results
//     index; the window coming back (focus, visible) looks at once;
//   - serverActivity: a run another client started makes the server busy (Start becomes Queue), also
//     while the list has not heard of it; the followed run is not "another" run;
//   - cancelJob / clearQueue call the server and then show the new state, errors are reported.
// The components are checked as source contracts (Recent runs rows, the designer dock's Queue tab
// and Cancel, the status bar, the Run panel, the preflight note) and the EN/TR texts.
//
//   node scripts/check-run-queue.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
const built = await build({
  root, configFile: false, logLevel: "silent", resolve: { conditions: ["browser"] },
  plugins: [{
    name: "run-queue-entry",
    resolveId(id) { if (id.endsWith("run-queue-entry")) return "\0run-queue-entry"; },
    load(id) {
      if (id !== "\0run-queue-entry") return;
      return ["runner/store", "runner/api"].map((path, i) => `export * as m${i} from ${JSON.stringify(`${root}src/${path}.ts`)};`).join("\n");
    },
  }],
  build: { write: false, minify: false, lib: { entry: "run-queue-entry", formats: ["es"] } },
});
const code = (Array.isArray(built) ? built[0] : built).output[0].code;
const { m0: runner, m1: { api, ApiError } } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const src = (path) => readFileSync(`${root}${path}`, "utf8");
let checks = 0;
const ok = (fn) => { fn(); checks++; };
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

// ------------------------------------------------------------------ a fake server
let queue = { running: null, queued: 0, version: 1, external: 0 };
let runs = [];
const calls = { health: 0, runs: 0, index: 0, cancel: [], clear: 0 };
const job = (id, status, extra = {}) => ({
  id, status, model: "patch", model_id: "patch", label: null, sweep: null, params: {}, overrides: {}, threads: 2, name: null,
  phase: status, created: 1_700_000_000 + Number(id.replace(/\D/g, "") || 0), started: null, finished: null, created_iso: null,
  duration_s: null, exit_code: null, bundle: status === "done" ? `${id}.json` : null, error: null, end_criteria_db: null,
  engine: "cpu", last_progress: null, stats: {}, info: {}, ...extra,
});
api.health = async () => { calls.health++; return { ok: true, cpu_count: 8, default_threads: 4, engines: ["cpu"], queue: { ...queue } }; };
api.runs = async () => { calls.runs++; return structuredClone(runs); };
api.models = async () => [];
api.cancel = async (id) => {
  calls.cancel.push(id);
  const j = runs.find((r) => r.id === id);
  if (!j) throw new ApiError(`no job ${id}`, 404);
  const settle = () => {
    j.status = "cancelled";
    queue = { ...queue, version: queue.version + 1, queued: runs.filter((r) => r.status === "queued").length, running: runs.find((r) => r.status === "running")?.id ?? null };
  };
  // like jobs.py: a queued run is cancelled at once, a running one when its process has exited
  if (j.status === "running") { setTimeout(settle, 100); return structuredClone(j); }
  settle();
  return structuredClone(j);
};
api.clearQueue = async () => {
  calls.clear++;
  const waiting = runs.filter((r) => r.status === "queued");
  for (const j of waiting) j.status = "cancelled";
  queue = { ...queue, version: queue.version + 1, queued: 0 };
  return { cancelled: waiting.map((j) => j.id), runs: waiting };
};
globalThis.fetch = async (url) => {
  if (String(url).includes("projects/index.json")) { calls.index++; return new Response(JSON.stringify({ projects: [] }), { status: 200 }); }
  return new Response("not found", { status: 404 });
};

// ------------------------------------------------------------------ connect: the first list is not "news"
runs = [job("j1", "done")];
await runner.probeServer();
ok(() => assert.equal(runner.serverState(), "online"));
ok(() => assert.equal(calls.runs, 1, "the probe fetches the run list once"));
ok(() => assert.equal(calls.index, 0, "the first list does not reload the results index"));
ok(() => assert.equal(runner.serverActivity().busy, false, "nothing queued or running"));

// the 10 s poll with an unchanged queue: no run-list request
await runner.recheckServer();
ok(() => assert.equal(calls.runs, 1, "an unchanged queue fetches nothing more"));

// ------------------------------------------------------------------ a terminal submits two runs (POST /api/runs)
runs = [job("j3", "queued", { label: "from a terminal B" }), job("j2", "running", { label: "from a terminal A" }), ...runs];
queue = { running: "j2", queued: 1, version: 3, external: 0 };
await runner.recheckServer();
await settle();
ok(() => assert.equal(calls.runs, 2, "a changed queue fetches the run list"));
ok(() => assert.deepEqual(runner.jobs().map((j) => j.id), ["j3", "j2", "j1"], "both terminal runs are listed"));
ok(() => {
  const a = runner.serverActivity();
  assert.equal(a.busy, true);
  assert.equal(a.otherRunning, true, "the server runs a run this window does not follow");
  assert.equal(a.other?.id, "j2", "the running one, not the newest queued one");
  assert.equal(a.queued, 1);
});

// only the version moved (a run came and went between two polls): still a refresh
queue = { ...queue, version: 4 };
await runner.recheckServer();
await settle();
ok(() => assert.equal(calls.runs, 3, "the version counter alone triggers a refresh"));

// the health knows a running run the list has not heard of yet
queue = { running: "j9", queued: 1, version: 5, external: 0 };
const listBefore = calls.runs;
api.runs = async () => { calls.runs++; return structuredClone(runs); }; // j9 is not in the list
await runner.recheckServer();
await settle();
ok(() => assert.equal(calls.runs, listBefore + 1));
ok(() => {
  const a = runner.serverActivity();
  assert.equal(a.otherRunning, true, "j2 runs according to the list");
  assert.equal(a.other?.id, "j2");
});
runs = runs.map((j) => (j.id === "j2" ? { ...j, status: "done", bundle: "j2.json" } : j));
await runner.refreshRuns();
ok(() => assert.equal(calls.index, 1, "a run that ended since the last list reloads the results index"));
ok(() => {
  const a = runner.serverActivity();
  assert.equal(a.other, null, "the list has no running run");
  assert.equal(a.otherRunning, true, "the health's running run counts while the list does not know it");
  assert.equal(a.busy, true);
});
await runner.refreshRuns();
ok(() => assert.equal(calls.index, 1, "a run that was done already does not reload it again"));

// the followed run is not "another" run
runs = runs.map((j) => (j.id === "j3" ? { ...j, status: "running" } : j));
queue = { running: "j3", queued: 0, version: 7, external: 0 };
await runner.recheckServer();
await settle();
runner.setLive("job", runner.jobs().find((j) => j.id === "j3"));
ok(() => {
  const a = runner.serverActivity();
  assert.equal(a.otherRunning, false, "the window follows j3");
  assert.equal(a.other, null);
  assert.equal(a.busy, true, "the server is still busy");
});
runner.setLive("job", null);

// a run from a terminal outside the server (fairbeam run, its running marker)
queue = { ...queue, external: 1, version: 8 };
await runner.recheckServer();
ok(() => assert.equal(runner.serverActivity().external, 1));

// ------------------------------------------------------------------ the window comes back to the front
const host = () => {
  const listeners = new Map();
  return {
    hidden: false, listeners,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
  };
};
const win = host(), doc = host();
const stop = runner.watchServer(win, doc);
ok(() => assert.ok(win.listeners.has("focus") && doc.listeners.has("visibilitychange"), "focus and visibility are watched"));
let h0 = calls.health, r0 = calls.runs;
win.listeners.get("focus")();
await settle();
ok(() => assert.equal(calls.health, h0 + 1, "focus looks at the health at once"));
ok(() => assert.equal(calls.runs, r0 + 1, "and fetches the run list (a run may have come and gone meanwhile)"));
queue = { ...queue, version: 9 };
h0 = calls.health; r0 = calls.runs;
doc.listeners.get("visibilitychange")();
await settle();
ok(() => assert.equal(calls.runs, r0 + 1, "a changed queue on return: one list request, not two"));
doc.hidden = true;
h0 = calls.health;
doc.listeners.get("visibilitychange")();
await settle();
ok(() => assert.equal(calls.health, h0, "a hidden window does not poll"));
// a server that stopped answering for a moment (one health call timed out: a laptop back from sleep)
// is looked for again when the window comes back, on any view, not only after "check again"
doc.hidden = false;
const answering = api.health;
api.health = async () => { calls.health++; throw new Error("timed out"); };
await runner.recheckServer();
ok(() => assert.equal(runner.serverState(), "offline"));
api.health = answering;
r0 = calls.runs;
win.listeners.get("focus")();
for (let i = 0; i < 50 && runner.serverState() !== "online"; i++) await tick();
await settle();
ok(() => assert.equal(runner.serverState(), "online", "focus probes a lost server and finds it again"));
ok(() => assert.equal(calls.runs, r0 + 1, "the probe fetches the run list"));
ok(() => assert.equal(runner.SERVER_LOST_POLL_MS, 10_000, "and the timer looks for it every 10 s meanwhile"));
stop();
ok(() => assert.ok(!win.listeners.has("focus") && !doc.listeners.has("visibilitychange"), "the cleanup removes the listeners"));
ok(() => assert.equal(runner.SERVER_POLL_MS, 5_000, "a run another client started shows within about 5 s"));

// ------------------------------------------------------------------ Stop, Remove from queue, Clear queue (#8)
runs = [job("j6", "queued"), job("j5", "queued"), job("j4", "running"), ...runs.filter((j) => j.status !== "running" && j.status !== "queued")];
queue = { running: "j4", queued: 2, version: 10, external: 0 };
await runner.recheckServer();
await settle();
ok(() => assert.equal(runner.serverActivity().queued, 2));
r0 = calls.runs; h0 = calls.health;
assert.equal(await runner.cancelJob("j5"), true);
ok(() => assert.deepEqual(calls.cancel, ["j5"], "Remove from queue cancels that run on the server"));
ok(() => assert.ok(calls.runs > r0 && calls.health > h0, "then the list and the health are fetched again"));
ok(() => assert.equal(runner.jobs().find((j) => j.id === "j5").status, "cancelled"));
ok(() => assert.equal(runner.serverActivity().queued, 1));
assert.equal(await runner.clearQueue(), 1);
ok(() => assert.equal(calls.clear, 1, "Clear queue is one request"));
ok(() => assert.equal(runner.serverActivity().queued, 0));
ok(() => assert.equal(runner.jobs().find((j) => j.id === "j4").status, "running", "Clear queue leaves the running run alone"));
assert.equal(await runner.cancelJob("j4"), true);
ok(() => assert.ok(runner.stopping().has("j4"), "Stop: the running run is 'stopping' until its process has exited"));
ok(() => assert.equal(runner.jobs().find((j) => j.id === "j4").status, "running"));
await new Promise((r) => setTimeout(r, runner.STOP_FOLLOW_UP_MS + 300));
ok(() => assert.equal(runner.jobs().find((j) => j.id === "j4").status, "cancelled", "a look shortly after the stop shows it ended, before the next poll"));
ok(() => assert.equal(runner.stopping().size, 0, "and it is no longer 'stopping'"));
ok(() => assert.equal(runner.serverActivity().busy, false, "Stop: nothing runs any more"));
runner.setSubmitError(null);
assert.equal(await runner.cancelJob("nope"), false);
ok(() => assert.equal(runner.submitError(), "no job nope", "a refused cancel is reported"));
runner.setSubmitError(null);

// ------------------------------------------------------------------ the components (source contracts)
const history = src("src/runner/RunHistory.tsx");
ok(() => assert.match(history, /<QueueButton job=\{j\(\)\} compact \/>/, "every Recent runs row gets Stop / Remove from queue"));
ok(() => assert.match(history, /<ClearQueueButton \/>/, "Recent runs offers Clear queue"));
const rq = src("src/runner/RunQueue.tsx");
ok(() => assert.match(rq, /await cancelJob\(props\.job\.id\)/, "the row buttons call the server's cancel"));
ok(() => assert.match(rq, /t\(ending\(\) \? "runQueue\.stopping" : running\(\) \? "runQueue\.stop" : "runQueue\.remove"\)/,
  "Stop for the running run (Stopping… until it ended), Remove from queue for a waiting one"));
ok(() => assert.match(rq, /<Show when=\{!isTerminal\(props\.job\.status\)\}>/, "no queue button on a finished run"));
ok(() => assert.match(rq, /await clearQueue\(\)/));
ok(() => assert.match(rq, /disabled=\{busy\(\) \|\| ending\(\)\}/, "a run being stopped cannot be stopped twice"));
const dock = src("src/designer/RunDock.tsx");
ok(() => assert.doesNotMatch(dock, /(?<![.\w])cancelRun(?!["\w])/, "the dock no longer cancels only the run this session started"));
ok(() => assert.match(dock, /const stopTarget = dockCancelTarget;/));
ok(() => assert.match(dock, /onClick=\{\(\) => void cancelJob\(stopTarget\(\)!\.id\)\}/, "the dock's Cancel acts on the target run"));
ok(() => assert.match(dock, /id: "queue", label: \(\) => t\("dock\.tab\.queue", \{ count: activeRuns\(\)\.length \}\)/, "a Queue tab while the server has runs"));
ok(() => assert.match(dock, /<RunQueue followed=\{designJobId\(\)\} onFollow=\{\(j\) => followInDesigner\(j\)\} \/>/));
const dr = src("src/runner/designRun.ts");
ok(() => assert.match(dr, /if \(own && !isTerminal\(own\.status\)\) return own;\s+if \(live\.job && !isTerminal\(live\.job\.status\)\) return live\.job;\s+return serverActivity\(\)\.other;/,
  "Cancel target: the dock's run, else the followed run, else the server's running run"));
ok(() => assert.match(dr, /!j\.sweep && j\.kind !== "optimize"/, "the designer follows another client's plain run of the open design"));
ok(() => assert.match(dr, /if \(pick\) followInDesigner\(pick, false\);/, "without moving the dock's tab"));
ok(() => assert.match(dr, /if \(!file \|\| \(shown && \(!isTerminal\(shown\.status\) \|\| \(runOpen\(\) && shown\.id !== designJobId\(\)\)\)\)\) return;/,
  "a finished run the open Run panel shows is not replaced by another client's run"));
ok(() => assert.match(dock, /t\("dock\.stopOther", \{ name: jobName\(stopTarget\(\)!\) \}\)/, "the dock's Cancel names a run that is not the dock's"));
const dockState = src("src/designer/dockState.ts");
ok(() => assert.match(dockState, /"runs" \| "queue" \| "log"/));
const app = src("src/App.tsx");
ok(() => assert.match(app, /if \(!DEMO\) onCleanup\(watchServer\(\)\);/, "the app watches the server (not in the demo build)"));
const sb = src("src/designer/StatusBar.tsx");
ok(() => assert.match(sb, /if \(!document\.hidden && serverState\(\) !== "online"\) void recheckServer\(\);/, "the status bar polls only while the server is not online"));
ok(() => assert.match(sb, /onClick=\{\(\) => setDesignDockTab\("queue"\)\}/, "the status bar's queue item opens the Queue tab"));
const panel = src("src/components/RunPanel.tsx");
ok(() => assert.match(panel, /running\(\) \|\| otherBusy\(\) \? t\("runPanel\.queue"\) : t\("runPanel\.start"\)/, "Start says Queue while another client's run keeps the server busy"));
ok(() => assert.match(panel, /jobs\(\)\.find\(\(j\) => j\.status === "running"\) \?\? jobs\(\)\.find/, "the panel attaches the running run first"));
ok(() => { assert.match(panel, /runPanel\.otherRunning/); assert.match(panel, /runPanel\.externalRuns/); });
const pre = src("src/designer/PreflightNote.tsx");
ok(() => assert.match(pre, /q: queue\(\)/, "the preflight is asked again when the queue changes"));
const store = src("src/runner/store.ts");
ok(() => { assert.match(store, /noteHealth\(h, true\)/); assert.match(store, /noteHealth\(h, false\)/); });
ok(() => assert.match(store, /const lost = \(\) => !doc\.hidden && everOnline && serverState\(\) === "offline";/,
  "only a server the window had is looked for (not the examples without a server)"));

// ------------------------------------------------------------------ EN and TR
const en = JSON.parse(src("src/i18n/en.json"));
const tr = JSON.parse(src("src/i18n/tr.json"));
for (const key of ["dock.stopOther", "runQueue.stop", "runQueue.remove", "runQueue.clear", "runQueue.follow", "runQueue.note", "dock.tab.queue", "dock.stopRun.title",
  "runPanel.otherRunning", "runPanel.otherQueued", "runPanel.externalRuns", "status.queue", "status.queue.busy", "status.queue.busyQueued", "status.queue.title"]) {
  ok(() => assert.ok(en[key] && tr[key] && JSON.stringify(en[key]) !== JSON.stringify(tr[key]), `${key}: worded in English and Turkish`));
}
ok(() => assert.equal(en["runQueue.remove"], "Remove from queue"));
ok(() => assert.equal(tr["runQueue.remove"], "Sıradan çıkar"));
ok(() => assert.match(tr["runPanel.otherRunning"], /çalıştırma/, "a run is a çalıştırma in Turkish"));

console.log(`Run queue checks passed (${checks}): a changed health queue (or the window coming back) fetches the run list, an unchanged one does not, a run that ended reloads the index; another client's run makes Start a Queue; Stop, Remove from queue and Clear queue call the server and refresh; the rows, the dock's Queue tab and Cancel, the status bar and EN/TR texts are wired.`);
