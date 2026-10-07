import assert from "node:assert/strict";
import { downloadMessage, saveDownload, saveDownloadUrl, trackDownload } from "../src/lib/download.ts";

globalThis.window = new EventTarget();
window.__TAURI_INTERNALS__ = {};
const results = [];
const finish = (url, path, success = true) => window.dispatchEvent(new CustomEvent("fairbeam:download", { detail: { url, path, success } }));
const stop = trackDownload("blob:first", result => results.push(result));
trackDownload("blob:second", result => results.push(result));
finish("blob:unrelated", "wrong.csv");
assert.equal(results.length, 0);
finish("blob:second", "second.csv");
assert.deepEqual(results, [{ path: "second.csv", success: true }]);
stop();
finish("blob:first", "first.csv");
assert.equal(results.length, 1);
trackDownload("blob:cancelled", result => results.push(result));
finish("blob:cancelled", null, false);
assert.deepEqual(results.at(-1), { path: "", success: false });
finish("blob:second", "duplicate.csv");
assert.equal(results.length, 2);
console.log("Native download completion: URL correlation, cancellation, cleanup and single delivery passed");

const calls = [];
window.__TAURI__ = { core: { invoke: async (command, args) => {
  calls.push({ command, args });
  return calls.length === 1 ? { status: "saved", path: "C:/exports/report.csv" } : { status: "cancelled" };
} } };
const nativeSaved = await saveDownload("report.csv", "hello", "text/csv");
assert.deepEqual(nativeSaved, { name: "report.csv", status: "saved", path: "C:/exports/report.csv" });
assert.deepEqual(calls[0], { command: "save_download", args: { name: "report.csv", bytes: [104, 101, 108, 108, 111], extension: "csv" } });
assert.equal(downloadMessage(nativeSaved), "Saved to C:/exports/report.csv");
const nativeCancelled = await saveDownloadUrl("cancel.txt", "data:text/plain;base64,eA==");
assert.deepEqual(nativeCancelled, { name: "cancel.txt", status: "cancelled" });
assert.equal(downloadMessage(nativeCancelled), "Save cancelled");

delete window.__TAURI_INTERNALS__;
const anchors = [];
globalThis.document = { body: { appendChild(a) { anchors.push(a); }, }, createElement() {
  return { style: {}, click() { this.clicked = true; }, remove() { this.removed = true; } };
} };
globalThis.setTimeout = callback => { callback(); return 0; };
globalThis.URL.createObjectURL = () => "blob:browser-test";
globalThis.URL.revokeObjectURL = () => {};
const browserResult = await saveDownload("browser.bin", new Uint8Array([1]));
assert.equal(browserResult.status, "requested");
assert.equal(anchors[0].href, "blob:browser-test");
assert.equal(anchors[0].download, "browser.bin");
assert.equal(anchors[0].clicked, true);
const browserUrlResult = await saveDownloadUrl("browser.csv", "data:text/csv,x");
assert.equal(browserUrlResult.status, "requested");
assert.equal(anchors[1].href, "data:text/csv,x");
assert.equal(anchors[1].clicked, true);
console.log("Shared save API: native saved/cancelled and browser anchor paths passed");

// ---- feedback is one toast over the app (src/lib/toast.ts), never a bar in the page layout
{
  const { readFileSync } = await import("node:fs");
  const { dismissToast, downloadToast, showToast, toastLifetime, toasts, TOAST_ACTION_MS, TOAST_LIMIT, TOAST_MS } = await import("../src/lib/toast.ts");
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  showToast("Download requested: a.csv");
  showToast("Download requested: a.csv");
  assert.equal(toasts().length, 1, "the same message twice replaces, it does not stack");
  for (const name of ["b", "c", "d"]) showToast(`Download requested: ${name}.csv`);
  assert.equal(toasts().length, TOAST_LIMIT, "at most a few toasts are shown");
  assert.equal(toasts()[0].text, "Download requested: b.csv", "the oldest goes first");
  for (const x of toasts()) dismissToast(x.id);
  assert.equal(toasts().length, 0);
  assert.equal(showToast("   "), 0, "an empty message shows nothing");

  let closed = 0;
  showToast("Could not open a.json: bad", { tone: "error", key: "load-error", onClose: () => closed++ });
  showToast("Could not open b.json: bad", { tone: "error", key: "load-error", onClose: () => closed++ });
  assert.deepEqual(toasts().map((x) => x.text), ["Could not open b.json: bad"], "a keyed toast replaces the one with its key");
  dismissToast("load-error");
  assert.equal(closed, 0, "hiding by key (the next open started) does not count as the user closing it");
  showToast("Could not open c.json: bad", { tone: "error", key: "load-error", onClose: () => closed++ });
  dismissToast(toasts()[0].id, true);
  assert.equal(closed, 1, "closing it by hand runs onClose (clears the load error)");

  assert.equal(toastLifetime({ tone: "info" }), TOAST_MS, "information hides by itself");
  assert.equal(toastLifetime({ tone: "info", action: { label: "x", run() {} } }), TOAST_ACTION_MS, "a toast with a button stays longer");
  assert.equal(toastLifetime({ tone: "error" }), null, "an error stays until it is closed");

  downloadToast({ name: "r.csv", status: "requested" });
  assert.deepEqual([toasts().at(-1).tone, toasts().at(-1).action], ["info", undefined], "browser: Download requested, no button");
  downloadToast({ name: "r.csv", status: "saved", path: "C:/out/r.csv" });
  assert.equal(toasts().at(-1).text, "Saved to C:/out/r.csv");
  assert.equal(toasts().at(-1).action?.label, "Show in folder", "desktop: Saved to … with Show in folder");
  downloadToast({ name: "r.csv", status: "failed" });
  assert.equal(toasts().at(-1).tone, "error", "a failed download is an error toast");
  for (const x of toasts()) dismissToast(x.id);

  // the host is fixed over the app; the old in-flow banner and the inline copies are gone
  const app = read("src/App.tsx");
  assert.match(app, /<ToastHost \/>/, "App renders the toast host");
  assert.doesNotMatch(app, /menuNotice/, "no in-flow menu notice banner");
  assert.doesNotMatch(app, /<div class="banner banner-critical" role="alert">/, "a load error is a toast, not a bar that pushes the workspace down");
  const css = read("src/styles/app.css");
  assert.match(css, /\.toast-region \{[^}]*position: fixed;/, "toasts are position: fixed (outside the layout)");
  for (const [file, inline] of [["src/components/Dock.tsx", /dataAction|savedPath/], ["src/designer/ResultViews.tsx", /rdk-action-feedback|setDataAction/],
    ["src/components/DrawingView.tsx", /saveNote/], ["src/scene/Viewport.tsx", /vp-notice/]]) {
    assert.doesNotMatch(read(file), inline, `${file}: no inline copy of a message the toast already shows`);
  }
  assert.match(read("src/components/exportContext.ts"), /export function exportNotice\(text:string, options\?:ToastOptions\) \{ showToast\(text, options\); \}/, "export feedback goes to the toast");
  console.log("Toasts: one message per action, keyed replacement, lifetimes, download outcomes, fixed host and no inline duplicates passed");
}
