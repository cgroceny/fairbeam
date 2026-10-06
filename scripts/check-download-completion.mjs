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
