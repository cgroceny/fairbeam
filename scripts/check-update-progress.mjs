// The desktop app's update progress in the viewer (src/lib/updateProgress.ts): the shell's payloads
// become states, the numbers read with a decimal point in both languages, a stopped server is not
// reported as lost while the update installs, and the wiring (event name, App, store) stays in step
// with the shell (src-tauri/src/update_progress.rs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fraction, formatMb, parseUpdateEvent, setUpdateState, updateAnnouncement, updateInstalling, updateState, updateText, watchUpdate,
} from "../src/lib/updateProgress.ts";
import { setLanguage } from "../src/i18n/index.ts";

const dl = (downloaded, total) => ({ phase: "downloading", version: "0.7.0", downloaded, total });

// payloads
assert.deepEqual(parseUpdateEvent(dl(5, 10)), dl(5, 10));
assert.equal(parseUpdateEvent(dl(5, null)).total, null);
assert.equal(parseUpdateEvent(dl(5, 0)).total, null, "a content length of 0 is unknown");
assert.deepEqual(parseUpdateEvent({ phase: "installing", version: "0.7.0" }), { phase: "installing", version: "0.7.0" });
assert.deepEqual(parseUpdateEvent({ phase: "restarting", version: "0.7.0" }), { phase: "restarting", version: "0.7.0" });
for (const bad of [null, undefined, 5, "x", {}, { phase: "failed" }, { phase: "other", version: "1" }, { phase: "installing" }, { phase: "downloading", version: "1", downloaded: -1 }, { phase: "downloading", version: "1", downloaded: "5" }])
  assert.equal(parseUpdateEvent(bad), null, JSON.stringify(bad));

// numbers
assert.equal(formatMb(12_345_678), "12.3");
assert.equal(formatMb(0), "0.0");
assert.equal(formatMb(-5), "0.0");
assert.equal(fraction(dl(25, 100)), 0.25);
assert.equal(fraction(dl(150, 100)), 1);
assert.equal(fraction(dl(5, null)), null);
assert.equal(fraction({ phase: "installing", version: "1" }), null);

// texts, both languages, always a decimal point
for (const lang of ["en", "tr"]) {
  setLanguage(lang);
  const t = updateText(dl(12_345_678, 48_000_000));
  assert.match(t, /0\.7\.0/); assert.match(t, /12\.3/); assert.match(t, /48\.0/);
  assert.doesNotMatch(t, /12,3/);
  const u = updateText(dl(12_345_678, null));
  assert.match(u, /12\.3/); assert.doesNotMatch(u, /48/);
  assert.match(updateText({ phase: "installing", version: "0.7.0" }), /0\.7\.0/);
  assert.ok(updateText({ phase: "restarting", version: "0.7.0" }).length > 3);
  // screen readers do not hear the changing numbers
  assert.doesNotMatch(updateAnnouncement(dl(12_345_678, 48_000_000)), /12\.3/);
  assert.equal(updateAnnouncement(dl(1_000_000, 48_000_000)), updateAnnouncement(dl(40_000_000, 48_000_000)));
}
setLanguage("en");
assert.equal(updateText(dl(12_345_678, 48_000_000)), "Downloading Fairbeam 0.7.0… 12.3 of 48.0 MB");
assert.equal(updateText(dl(12_345_678, null)), "Downloading Fairbeam 0.7.0… 12.3 MB");
assert.equal(updateText({ phase: "installing", version: "0.7.0" }), "Installing Fairbeam 0.7.0…");
assert.equal(updateText({ phase: "restarting", version: "0.7.0" }), "Restarting…");

// the watcher: events, a page that loads late, the end of an update
const listeners = new Map();
const host = {
  addEventListener: (type, fn) => listeners.set(type, fn),
  removeEventListener: (type) => listeners.delete(type),
  __fairbeamUpdate: { phase: "installing", version: "0.7.0" },
};
let failed = 0;
const stop = watchUpdate(host, () => failed++);
assert.equal(updateState()?.phase, "installing", "the payload kept by the shell is read at start");
assert.equal(updateInstalling(), true);
const send = (detail) => listeners.get("fairbeam:update")({ detail });
send(dl(1, 2));
assert.equal(updateState()?.phase, "downloading");
assert.equal(updateInstalling(), false, "the server still runs while downloading");
send({ phase: "installing", version: "0.7.0" });
assert.equal(updateInstalling(), true);
send({ phase: "failed" });
assert.equal(updateState(), null);
assert.equal(failed, 1, "a failed install tells the page to look for the server again");
send({ phase: "failed" });
assert.equal(failed, 1);
stop();
assert.equal(listeners.size, 0);
setUpdateState(null);

// wiring
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const store = read("../src/runner/store.ts");
assert.ok(!/setServerState\("offline"\)/.test(store.replace(/function markServerLost\(\) \{[^}]*\}/, "")), "the store marks the server lost through markServerLost only");
assert.match(read("../src/App.tsx"), /<UpdateProgress \/>/);
assert.match(read("../src/App.tsx"), /watchUpdate\(/);
const shell = read("../src-tauri/src/update_progress.rs");
assert.ok(shell.includes("'fairbeam:update'") && shell.includes("window.__fairbeamUpdate"), "event and global names match the viewer");
for (const phase of ["downloading", "installing", "restarting", "failed"]) assert.ok(shell.includes(`"${phase}"`), phase);
console.log("update progress: ok");
