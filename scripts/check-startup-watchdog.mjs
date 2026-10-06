// index.html's startup watchdog (#241): a blank root after the timeout gets a notice with the files that
// did not load and a Reload that refetches them, bypassing the cache; a started app gets no notice.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const src = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
assert.ok(src, "index.html has the inline watchdog");
assert.ok(html.indexOf(src) < html.indexOf('type="module"'), "the watchdog comes before the app script");

function el(tag) {
  return { tag, children: [], style: {}, attrs: {}, textContent: "", get childElementCount() { return this.children.length; },
    get firstChild() { return this.children[0]; }, appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); }, setAttribute(k, v) { this.attrs[k] = v; } };
}
function run({ lang = "en-US", children = 0, entries = [] } = {}) {
  const root = el("div");
  for (let i = 0; i < children; i++) root.appendChild(el("main"));
  const timers = [], fetched = [], reloads = [];
  const listeners = {};
  const win = {
    navigator: { language: lang }, __fairbeamWatchdogMs: 1,
    addEventListener: (n, f) => { listeners[n] = f; },
    performance: { getEntriesByType: () => entries },
    setTimeout: (f) => { timers.push(f); return timers.length; }, setInterval: () => 1, clearInterval: () => {},
    fetch: (u, o) => { fetched.push([u, o?.cache]); return Promise.resolve({}); },
    location: { pathname: "/", reload: () => reloads.push(1) },
    document: { getElementById: (id) => (id === "root" ? root : null), createElement: el,
      querySelectorAll: () => [{ src: "http://x/assets/index-abc12345.js" }, { href: "http://x/assets/index-abc12345.css" }] },
    Promise,
  };
  Object.assign(win, { window: win, navigator: win.navigator, document: win.document, performance: win.performance, location: win.location });
  vm.runInNewContext(src, win);
  return { root, timers, fetched, reloads, listeners, fire: () => timers[0]() };
}
const texts = (n) => [n.textContent, ...n.children.flatMap(texts)].filter(Boolean);

// blank root: notice with the pending script and a reload button
let r = run({ entries: [{ name: "http://x/assets/index-abc12345.js", initiatorType: "script", responseEnd: 0, transferSize: 0, decodedBodySize: 0 }] });
r.fire();
assert.equal(r.root.childElementCount, 1);
const box = r.root.children[0];
assert.equal(box.attrs.role, "alert");
assert.ok(texts(box).includes("Fairbeam could not load its interface"));
assert.ok(texts(box).includes("http://x/assets/index-abc12345.js"), "names the file that did not load");
const button = box.children.find((c) => c.tag === "button");
assert.ok(button, "a Reload button");
button.onclick();
await new Promise((res) => setTimeout(res, 10));
assert.deepEqual(r.fetched.map((f) => f[1]), ["reload", "reload", "reload"], "refetches the app files without the cache");
assert.equal(r.reloads.length, 1);
assert.equal(button.disabled, true);

// Turkish
r = run({ lang: "tr-TR" }); r.fire();
assert.ok(texts(r.root.children[0]).includes("Fairbeam arayüzü yüklenemedi"));
// failed resources reported through error events
r = run(); r.listeners.error({ target: { src: "http://x/assets/lazy-deadbeef.js" } }); r.fire();
assert.ok(texts(r.root.children[0]).includes("http://x/assets/lazy-deadbeef.js"));
// the app has started: nothing is added
r = run({ children: 1 }); r.fire();
assert.equal(r.root.childElementCount, 1);
assert.ok(!r.root.children[0].attrs.role);
console.log("startup watchdog passed");
