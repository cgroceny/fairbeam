#!/usr/bin/env node
// The usage-statistics endpoint (api/ping.js, docs/TELEMETRY.md) with fake requests and a fake
// GitHub Contents API in memory: no network. Usage: npm run check:telemetry
import assert from "node:assert/strict";
import { ALLOWED_ORIGINS, MAX_FILE_BYTES, SCHEMA, handlePing, hashId, validatePing } from "../api/_ping-core.js";

const NOW = Date.parse("2026-09-28T09:00:00Z");
const ENV = { STATS_GITHUB_TOKEN: "test-token", STATS_SALT: "test-salt", STATS_REPO: "example/usage-stats" };
const ID = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b";
const good = (over = {}) => ({
  schema: "fairbeam.ping/1", install_id: ID, app_version: "0.4.4", os: "macos", arch: "aarch64",
  gpu_available: false, day: "2026-09-27", counters: { "app.start": 2, "sim.started.cpu.design": 3 }, ...over,
});

/** An in-memory repository behind the Contents API; `conflicts` PUTs answer 409 first. */
function fakeGitHub({ conflicts = 0, files = {} } = {}) {
  const store = new Map(Object.entries(files).map(([p, text]) => [p, { text, sha: `sha-${p}-0` }]));
  const calls = [];
  let left = conflicts;
  let version = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.origin, "https://api.github.com");
    assert.equal(init.headers.authorization, "Bearer test-token");
    const path = decodeURIComponent(u.pathname.replace(`/repos/${ENV.STATS_REPO}/contents/`, ""));
    calls.push(`${init.method ?? "GET"} ${path}`);
    if (!init.method) {
      const f = store.get(path);
      if (!f) return new Response("{}", { status: 404 });
      return Response.json({ sha: f.sha, size: Buffer.byteLength(f.text), content: Buffer.from(f.text).toString("base64") });
    }
    const body = JSON.parse(init.body);
    if (left > 0) { left--; return new Response("{}", { status: 409 }); }
    const f = store.get(path);
    if ((f?.sha ?? undefined) !== body.sha) return new Response("{}", { status: 409 });
    store.set(path, { text: Buffer.from(body.content, "base64").toString("utf8"), sha: `sha-${path}-${++version}` });
    return new Response("{}", { status: f ? 200 : 201 });
  };
  return { fetch, store, calls };
}

const noNetwork = async () => { throw new Error("no request may leave the function here"); };

function req(body, { method = "POST", type = "application/json", origin, raw, host = "fairbeam.org" } = {}) {
  const headers = {};
  if (type) headers["content-type"] = type;
  if (origin) headers.origin = origin;
  return new Request(`https://${host}/api/ping`, {
    method, headers, body: method === "POST" || method === "PUT" ? (raw ?? JSON.stringify(body)) : undefined,
  });
}

const call = (request, deps) => handlePing(request, { now: () => NOW, ...deps });

// 1. disabled without the environment variables: 503, and nothing is fetched
for (const env of [{}, { STATS_GITHUB_TOKEN: "t" }, { STATS_SALT: "s" }]) {
  const r = await call(req(good()), { env, fetch: noNetwork });
  assert.equal(r.status, 503);
}

// 2. method, origin, type and size
assert.equal((await call(req(null, { method: "GET" }), { env: ENV, fetch: noNetwork })).status, 405);
assert.equal((await call(req(good(), { origin: "https://evil.example" }), { env: ENV, fetch: noNetwork })).status, 403);
assert.equal((await call(req(good(), { origin: "http://127.0.0.1:5320" }), { env: ENV, fetch: noNetwork })).status, 403);
{
  const r = await call(req(null, { method: "OPTIONS", origin: ALLOWED_ORIGINS[0] }), { env: ENV, fetch: noNetwork });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), ALLOWED_ORIGINS[0]);
  const bad = await call(req(null, { method: "OPTIONS", origin: "https://evil.example" }), { env: ENV, fetch: noNetwork });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
}
assert.equal((await call(req(good(), { type: "text/plain" }), { env: ENV, fetch: noNetwork })).status, 415);
assert.equal((await call(req(null, { raw: `{"x":"${"a".repeat(SCHEMA.max_body_bytes)}"}` }), { env: ENV, fetch: noNetwork })).status, 413);
assert.equal((await call(req(null, { raw: "{not json" }), { env: ENV, fetch: noNetwork })).status, 400);

// 3. strict validation: every one of these is refused before anything is stored
const tooMany = Object.fromEntries(SCHEMA.keys.slice(0, 1).map((k) => [k, 1]));
for (let i = 0; i <= SCHEMA.max_keys; i++) tooMany[`app.update_from.0.0.${i}`] = 1;
const invalid = {
  "an extra field": good({ hostname: "alice-laptop" }),
  "a missing field": (({ gpu_available, ...rest }) => rest)(good()),
  "another schema": good({ schema: "fairbeam.ping/2" }),
  "a non-UUID id": good({ install_id: "alice@example.com" }),
  "a v1 UUID": good({ install_id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427" }),
  "a free-text version": good({ app_version: "0.4.4 on /Users/alice" }),
  "an unknown os": good({ os: "freebsd" }),
  "an unknown arch": good({ arch: "riscv64" }),
  "a string gpu flag": good({ gpu_available: "yes" }),
  "a future day": good({ day: "2026-09-30" }),
  "an old day": good({ day: "2026-07-01" }),
  "a malformed day": good({ day: "2026-02-30" }),
  "a path as a counter key": good({ counters: { "/Users/alice/patch.design.json": 1 } }),
  "a parameter as a counter key": good({ counters: { "param.W": 12 } }),
  "a model name": good({ counters: { "sim.started.cpu.my_patch": 1 } }),
  "a bad update version": good({ counters: { "app.update_from.0.4.3-evil": 1 } }),
  "a negative value": good({ counters: { "app.start": -1 } }),
  "a fraction": good({ counters: { "app.start": 1.5 } }),
  "a value over the cap": good({ counters: { "app.start": SCHEMA.max_value + 1 } }),
  "a string value": good({ counters: { "app.start": "1" } }),
  "no counters": good({ counters: {} }),
  "counters as a list": good({ counters: [1] }),
  "too many counters": good({ counters: tooMany }),
  "an array body": [good()],
};
for (const [what, body] of Object.entries(invalid)) {
  const r = await call(req(body), { env: ENV, fetch: noNetwork });
  assert.equal(r.status, what === "too many counters" && JSON.stringify(body).length > SCHEMA.max_body_bytes ? 413 : 400, `${what}: ${r.status}`);
}
assert.ok(validatePing(good({ day: "2026-09-29" }), NOW).ok, "one day of clock slack");
assert.ok(validatePing(good({ counters: { "app.update_from.0.4.3": 1, "app.update_from.unknown": 1 } }), NOW).ok);
assert.ok(validatePing(good({ app_version: "0.5.0-beta.1" }), NOW).ok);
// installed apps of the older name (0.4 to 0.6) send their own schema id and are still counted
assert.deepEqual(SCHEMA.legacy_schemas.length, 1);
assert.ok(validatePing(good({ schema: SCHEMA.legacy_schemas[0] }), NOW).ok, "the legacy id");
assert.ok(!validatePing(good({ schema: SCHEMA.legacy_schemas[0].replace("/1", "/2") }), NOW).ok);
for (const key of SCHEMA.keys) assert.ok(validatePing(good({ counters: { [key]: 1 } }), NOW).ok, key);

// 4. stored: one line in today's file, with the hashed id only
{
  const gh = fakeGitHub();
  const r = await call(req(good()), { env: ENV, fetch: gh.fetch });
  assert.equal(r.status, 202);
  const text = gh.store.get("data/2026-09-28.jsonl").text;
  assert.ok(text.endsWith("\n"));
  const line = JSON.parse(text);
  assert.deepEqual(line, { day: "2026-09-27", id: hashId("test-salt", ID), v: "0.4.4", os: "macos", arch: "aarch64", gpu: false, c: { "app.start": 2, "sim.started.cpu.design": 3 } });
  assert.ok(!text.includes(ID), "the plain install id is never stored");
  assert.match(line.id, /^[0-9a-f]{16}$/);
  assert.notEqual(hashId("other-salt", ID), line.id);

  // installed old apps still post to the old host: the function does not look at the host
  const old = await call(req(good(), { host: "antenlab.akdag.dev" }), { env: ENV, fetch: fakeGitHub().fetch });
  assert.equal(old.status, 202);

  // the same day again from the same id: not stored twice
  const dup = await call(req(good()), { env: ENV, fetch: gh.fetch });
  assert.equal(dup.status, 200);
  assert.equal(gh.store.get("data/2026-09-28.jsonl").text.split("\n").filter(Boolean).length, 1);

  // rate limit: two pings per hashed id per receiving day
  assert.equal((await call(req(good({ day: "2026-09-26" })), { env: ENV, fetch: gh.fetch })).status, 202);
  assert.equal((await call(req(good({ day: "2026-09-25" })), { env: ENV, fetch: gh.fetch })).status, 429);
  // another install is not limited by it
  assert.equal((await call(req(good({ install_id: "9b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b" })), { env: ENV, fetch: gh.fetch })).status, 202);
  assert.equal(gh.store.get("data/2026-09-28.jsonl").text.split("\n").filter(Boolean).length, 3);
}

// 5. SHA conflicts are retried; a full file continues in the next one
{
  const gh = fakeGitHub({ conflicts: 2 });
  assert.equal((await call(req(good()), { env: ENV, fetch: gh.fetch })).status, 202);
  assert.equal(gh.calls.filter((c) => c.startsWith("PUT")).length, 3);
  const always = fakeGitHub({ conflicts: 99 });
  const logged = [];
  const error = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    assert.equal((await call(req(good()), { env: ENV, fetch: always.fetch })).status, 503);
  } finally {
    console.error = error;
  }
  assert.deepEqual(logged, ["ping: storing failed: the file kept changing"]);
  assert.equal(always.store.size, 0);

  const one = `${JSON.stringify({ day: "2026-09-27", id: "0000000000000000", c: {} })}\n`;
  const big = one.repeat(Math.ceil(MAX_FILE_BYTES / one.length) + 1);
  const full = fakeGitHub({ files: { "data/2026-09-28.jsonl": big } });
  assert.equal((await call(req(good()), { env: ENV, fetch: full.fetch })).status, 202);
  assert.ok(full.store.get("data/2026-09-28.jsonl").text === big, "the full file is left as it is");
  assert.equal(full.store.get("data/2026-09-28-2.jsonl").text.split("\n").filter(Boolean).length, 1);
}

// 6. vercel.json bundles the schema with the function, and nothing rewrites /api
{
  const { readFileSync } = await import("node:fs");
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(vercel.functions?.["api/ping.js"]?.includeFiles, "api/_ping-schema.json");
  for (const r of [...(vercel.rewrites ?? []), ...(vercel.redirects ?? [])]) assert.ok(!r.source.startsWith("/api"), r.source);
  // the old host's pages go to the new domain, but never its /api (old apps keep pinging it)
  const oldHost = vercel.redirects.find((r) => r.has?.some((h) => h.type === "host" && h.value === "antenlab.akdag.dev"));
  assert.ok(oldHost?.permanent && oldHost.destination.startsWith("https://fairbeam.org/"), "old host redirect");
  const re = new RegExp(`^/${oldHost.source.match(/:path\((.*)\)$/)[1]}$`);
  assert.ok(re.test("/guide.html") && re.test("/") && re.test("/app/") && !re.test("/api/ping") && !re.test("/api"), "the old host redirect leaves /api alone");
  const ignore = readFileSync(new URL("../.vercelignore", import.meta.url), "utf8").split("\n").map((l) => l.trim());
  assert.ok(!ignore.some((l) => l === "api" || l === "api/" || l === "/api"), ".vercelignore must keep api/");
}

// 7. the summary script's arithmetic (scripts/stats-summary.mjs), on stored lines like the above
{
  const { parseLines, summarize, summarizeReleases, isoWeek } = await import("./stats-summary.mjs");
  const l = (day, id, c, extra = {}) => JSON.stringify({ day, id, v: "0.4.4", os: "macos", arch: "aarch64", gpu: false, c, ...extra });
  const texts = [
    [l("2026-09-26", "a", { "sim.started.cpu.design": 2, "sim.failed.cpu.solver": 1 }), l("2026-09-26", "b", { "sim.started.gpu.example": 1 }, { os: "windows", arch: "x86_64", gpu: true })].join("\n"),
    // a retried ping of the same (id, day) counts once
    [l("2026-09-26", "a", { "sim.started.cpu.design": 2, "sim.failed.cpu.solver": 1 }), l("2026-09-27", "a", { "app.start": 1, "feature.pdf_report": 1 }, { v: "0.4.5" }), "not json"].join("\n"),
  ];
  const lines = parseLines(texts);
  assert.equal(lines.length, 3);
  const s = summarize(lines, { days: 28, today: "2026-09-28" });
  assert.equal(s.installs, 2);
  assert.deepEqual(s.daily, [
    { day: "2026-09-26", installs: 2, sims: 3, cpu: 2, gpu: 1, finished: 0, failed: 1 },
    { day: "2026-09-27", installs: 1, sims: 0, cpu: 0, gpu: 0, finished: 0, failed: 0 },
  ]);
  assert.deepEqual(s.weekly, [{ week: "2026-W39", installs: 2 }]);
  assert.deepEqual(s.versions, [["0.4.5", 1], ["0.4.4", 1]]);
  assert.deepEqual(s.failures, [["solver", 1]]);
  assert.deepEqual(s.features, [["feature.pdf_report", 1]]);
  assert.equal(isoWeek("2027-01-01"), "2026-W53");
  const r = summarizeReleases([{ tag: "v0.4.4", published: "2026-09-28T10:00:00Z", assets: [{ name: "latest.json", download_count: 4 }, { name: "a.dmg", download_count: 2 }, { name: "a.dmg.sig", download_count: 9 }] }]);
  assert.deepEqual(r.rows, [{ tag: "v0.4.4", published: "2026-09-28", downloads: 6, latestJson: 4 }]);
}

console.log("telemetry api: validation, hashing, rate limit, conflicts, sharding and the summary passed (no network)");
