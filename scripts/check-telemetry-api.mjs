// Minimal API and release statistics checks, with fake storage and no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handlePing, validatePing, isoWeek, weekStart, SCHEMA, COUNT_INSTALL_LUA } from "../api/_ping-core.js";
import { assetKind, summarizeReleases, fetchReleases, parseAggregates } from "./stats-summary.mjs";
const ENV = { KV_REST_API_URL: "https://redis.example", KV_REST_API_TOKEN: "test-redis", STATS_GITHUB_TOKEN: "test-token", STATS_REPO: "example/stats" };
const NOW = Date.parse("2026-10-07T12:00:00Z");
const good = (extra = {}) => ({ schema: SCHEMA.schema, install_id: "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b", app_version: "0.7.0", os: "macos", arch: "aarch64", ...extra });
const request = (body = good(), headers = {}, method = "POST") => new Request("https://fairbeam.org/api/ping", {
  method, headers: { "content-type": "application/json", ...headers }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
});
function storage({ conflict = false, fail = false } = {}) {
  let record, sha = 0, calls = 0;
  const ids = new Set();
  const fetch = async (_url, opts) => {
    calls++;
    if (fail) return new Response(null, { status: 500 });
    if (_url === ENV.KV_REST_API_URL) {
      const command = JSON.parse(opts.body);
      assert.equal(command[0], "EVAL"); assert.equal(command[1], COUNT_INSTALL_LUA);
      assert.equal(command[2], 4);
      assert.equal(command[9], 1791763200);
      ids.add(command[8]);
      return Response.json({ result: ids.size });
    }
    if (opts.method !== "PUT") return record ? Response.json({ sha: String(sha), content: Buffer.from(JSON.stringify(record)).toString("base64") }) : new Response(null, { status: 404 });
    const body = JSON.parse(opts.body);
    assert.equal(body.committer.date, weekStart(JSON.parse(Buffer.from(body.content, "base64").toString()).week));
    assert.deepEqual(body.author, body.committer);
    const next = JSON.parse(Buffer.from(body.content, "base64").toString());
    if (conflict) { conflict = false; record = { ...next, count: 10 }; sha++; return new Response(null, { status: 409 }); }
    assert.equal(body.sha, sha ? String(sha) : undefined);
    record = next; sha++;
    return new Response(null, { status: 201 });
  };
  return { fetch, get record() { return record; }, get calls() { return calls; } };
}
const call = (req, store, env = ENV) => handlePing(req, { env, fetch: store.fetch, now: () => NOW });
for (const env of [{}, { STATS_REPO: "example/stats" }]) {
  const s = storage(); assert.equal((await call(request(), s, env)).status, 503); assert.equal(s.calls, 0);
}
for (const body of [null, [], good({ schema: "fairbeam.ping/99" }), good({ install_id: "unexpected" }), good({ os: "unknown" }), good({ arch: "other" }), good({ app_version: "../private" }), good({ counters: {} }), good({ app_version: 7 })]) {
  const s = storage(); assert.equal((await call(request(body), s)).status, 400); assert.equal(s.calls, 0);
}
const s = storage({ conflict: true });
assert.equal((await call(request(good(), { "x-forwarded-for": "192.0.2.1", "user-agent": "private-agent" }), s)).status, 202);
assert.equal(s.record.count, 10);
assert.equal((await call(request(), s)).status, 202);
assert.equal(s.record.count, 10);
const distinct = storage();
assert.equal((await call(request(), distinct)).status, 202);
assert.equal((await call(request(), distinct)).status, 202);
assert.equal(distinct.record.count, 1);
assert.equal((await call(request(good({ install_id: "2b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b" })), distinct)).status, 202);
assert.equal(distinct.record.count, 2);
assert.deepEqual(Object.keys(s.record).sort(), ["app_version", "arch", "count", "os", "week"]);
assert.equal(s.record.week, "2026-W41");
for (const schema of SCHEMA.legacy_schemas) {
  const body = { schema, app_version: "0.6.8", os: "windows", arch: "x86_64", install_id: "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b", gpu_available: true, day: "2026-10-06", counters: { "app.start": 1, "feature.pdf_report": 7 } };
  assert.deepEqual(validatePing(body, NOW).ping, { schema: "fairbeam.ping/2", app_version: "0.6.8", os: "windows", arch: "x86_64" });
  const store = storage(); assert.equal((await call(request(body), store)).status, 202);
  assert.equal(store.record.count, 1);
  assert.ok(!JSON.stringify(store.record).includes("install_id"));
  assert.equal(validatePing({ ...body, counters: { private: 1 } }, NOW).ok, false);
}
for (const [req, status] of [
  [request(good(), { origin: "https://invalid.example" }), 403],
  [request(good(), { origin: "tauri://localhost" }, "OPTIONS"), 204],
  [request(undefined, {}, "GET"), 405],
  [request(good(), { "content-type": "text/plain" }), 415],
  [request(good({ app_version: "x".repeat(9000) })), 413],
  [new Request("https://fairbeam.org/api/ping", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }), 400],
]) { const store = storage(); assert.equal((await call(req, store)).status, status); assert.equal(store.calls, 0); }
assert.equal((await call(request(), storage({ fail: true }))).status, 503);
assert.equal((await call(request(), storage(), { ...ENV, STATS_REPO: "../bad" })).status, 503);
assert.equal(isoWeek("2021-01-01"), "2020-W53");
assert.equal(isoWeek("2024-12-30"), "2025-W01");
assert.equal(weekStart("2026-W41"), "2026-10-05T00:00:00Z");
assert.equal(weekStart("2020-W53"), "2020-12-28T00:00:00Z");
assert.equal(weekStart("2025-W01"), "2024-12-30T00:00:00Z");
assert.deepEqual(parseAggregates([JSON.stringify(s.record)]), [s.record]);
assert.throws(() => parseAggregates(['{"id":"private","count":1}']));
assert.deepEqual(summarizeReleases([{ tag_name: "v1", assets: [
  { name: "app.dmg", download_count: 2 }, { name: "app.app.tar.gz", download_count: 3 },
  { name: "app-setup.exe", download_count: 4 }, { name: "app.AppImage", download_count: 5 },
  { name: "latest.json", download_count: 100 }, { name: "app.dmg.sig", download_count: 9 },
] }]), [
  { version: "v1", platform: "macOS", downloads: 5 }, { version: "v1", platform: "Windows", downloads: 4 },
  { version: "v1", platform: "Linux", downloads: 5 }, { version: "v1", platform: "update metadata", downloads: 100 },
  { version: "v1", platform: "signature / checksum", downloads: 9 },
]);
assert.equal(assetKind("openems-macos-arm64.tar.gz"), "macOS");
assert.equal(assetKind("openems-windows-x64.zip"), "Windows");
let pages = 0;
const releases = await fetchReleases(async (url, opts) => {
  assert.ok(!opts.headers.authorization);
  assert.ok(url.includes(`page=${++pages}`));
  return Response.json(pages === 1 ? Array.from({ length: 100 }, (_, n) => ({ tag_name: `v${n}` })) : [{ tag_name: "old" }]);
});
assert.equal(releases.length, 101); assert.equal(pages, 2);
await assert.rejects(fetchReleases(async () => new Response(null, { status: 403 })), /HTTP 403/);
const rust = readFileSync(new URL("../src-tauri/src/telemetry.rs", import.meta.url), "utf8");
const core = readFileSync(new URL("../src-tauri/src/telemetry_core.rs", import.meta.url), "utf8");
assert.ok(core.includes(`pub const SCHEMA_ID: &str = "${SCHEMA.schema}"`));
assert.deepEqual(SCHEMA.fields.sort(), Object.keys(good()).sort());
assert.ok(rust.includes('#[cfg(feature = "telemetry")]\nfn spawn_sender'));
assert.match(readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"), /default = \["telemetry"\]/);
assert.ok(!readFileSync(new URL("../src/lib/telemetry.ts", import.meta.url), "utf8").includes("telemetry_count"));
console.log("telemetry: install and legacy validation, aggregate storage, conflicts, gates, release totals and pagination passed (no network)");

for (const env of [{ ...ENV, KV_REST_API_TOKEN: undefined }, { ...ENV, KV_REST_API_URL: undefined }]) {
  const store = storage(); assert.equal((await call(request(), store, env)).status, 503); assert.equal(store.calls, 0);
}
assert.match(COUNT_INSTALL_LUA, /redis\.sha1hex\(salt \.\. ARGV\[2\]\)/);
assert.match(COUNT_INSTALL_LUA, /EXAT/);
assert.equal((COUNT_INSTALL_LUA.match(/EXPIREAT/g) || []).length, 2);
assert.match(COUNT_INSTALL_LUA, /cumulative_weekly_distinct/);
