// Deterministic checks for the viewport's queued work and preview glyph bounds.
// Run with: node --experimental-strip-types scripts/check-viewport-lifecycle.mjs
import assert from "node:assert/strict";
import { clearOwnedDebugReference, frameTask, portMarkerRadius, watchPixelRatio } from "../src/scene/viewportLifecycle.ts";

let nextHandle = 1;
const frames = new Map();
const schedule = (callback) => {
  const handle = nextHandle++;
  frames.set(handle, callback);
  return handle;
};
const cancel = (handle) => frames.delete(handle);
const flush = () => {
  const queued = [...frames.values()];
  frames.clear();
  queued.forEach((callback) => callback(0));
};

let renders = 0;
const render = frameTask(() => renders++, schedule, cancel);
render.request();
render.request();
assert.equal(frames.size, 1, "repeated render requests share one frame");
flush();
assert.equal(renders, 1);
render.request();
render.runNow();
assert.equal(renders, 2, "capture renders immediately");
assert.equal(frames.size, 0, "capture cancels the queued render");
flush();
assert.equal(renders, 2, "cancelled work does not render twice");
render.dispose();
render.request();
assert.equal(frames.size, 0, "unmounted viewport cannot schedule a render");

let picked = null;
let pointer = "first";
const pick = frameTask(() => { picked = pointer; }, schedule, cancel);
pick.request();
pointer = "latest";
pick.request();
assert.equal(frames.size, 1, "pointer moves share one pick frame");
flush();
assert.equal(picked, "latest", "pick uses the latest pointer position");
pick.request();
pick.dispose();
flush();
assert.equal(picked, "latest", "a queued pick cannot update state after unmount");

assert.equal(portMarkerRadius(10, [0, 100]), 0.2, "coarse preview mesh is capped at 2% of scene radius");
assert.equal(portMarkerRadius(10, [0, 0.1, 1]), 0.06, "fine mesh retains a visible minimum");
assert.equal(portMarkerRadius(10, [0, 0.5, 1]), 0.15, "ordinary mesh spacing still controls glyph size");
assert.equal(portMarkerRadius(10, [0]), 0.2, "missing spacing stays bounded");

const debugWindow = {};
const firstViewport = { scene: {} };
const remountedViewport = { scene: {} };
debugWindow.__fairbeam = firstViewport;
clearOwnedDebugReference(debugWindow, firstViewport);
assert.equal("__fairbeam" in debugWindow, false, "teardown releases its development debug reference");
debugWindow.__fairbeam = remountedViewport;
clearOwnedDebugReference(debugWindow, firstViewport);
assert.equal(debugWindow.__fairbeam, remountedViewport, "old teardown preserves a remounted viewport reference");

const queries = [];
const display = {
  devicePixelRatio: 1.25,
  matchMedia(media) {
    const listeners = new Set();
    const query = {
      media, listeners,
      addEventListener: (_event, callback) => listeners.add(callback),
      removeEventListener: (_event, callback) => listeners.delete(callback),
    };
    queries.push(query);
    return query;
  },
};
const ratios = [];
const stopPixelRatio = watchPixelRatio(() => ratios.push(display.devicePixelRatio), display);
for (const ratio of [1.5, 2, 1.25]) {
  const previous = queries.at(-1);
  display.devicePixelRatio = ratio;
  [...previous.listeners].forEach((callback) => callback());
  assert.equal(previous.listeners.size, 0, "old monitor query is detached");
  assert.equal(queries.at(-1).media, `(resolution: ${ratio}dppx)`);
}
assert.deepEqual(ratios, [1.25, 1.5, 2, 1.25], "fractional monitor changes update without a resize");
stopPixelRatio();
assert.ok(queries.every((query) => query.listeners.size === 0), "unmount removes all resolution listeners");

console.log("viewport lifecycle: frame cleanup, marker bounds and fractional DPR transitions pass");
