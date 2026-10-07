// Minimal API and release statistics checks, with fake storage and no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { handlePing, validatePing, isoWeek, weekStart, SCHEMA, COUNT_INSTALL_LUA, WEEK_SALT_LUA, hashInstall, storageEnv } from "../api/_ping-core.js";
import { assetKind, summarizeReleases, fetchReleases, parseRedisAggregates } from "./stats-summary.mjs";
const ENV = { KV_REST_API_URL: "https://redis.example", KV_REST_API_TOKEN: "test-redis" };
const NOW = Date.parse("2026-10-07T12:00:00Z");
const EXPIRES = "1791763200"; // Monday 2026-10-12 00:00 UTC
const ID = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b";
const good = (extra = {}) => ({ schema: SCHEMA.schema, install_id: ID, app_version: "0.7.0", os: "macos", arch: "aarch64", ...extra });
const request = (body = good(), headers = {}, method = "POST") => new Request("https://fairbeam.org/api/ping", {
  method, headers: { "content-type": "application/json", ...headers }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
});
// A fake Redis REST endpoint that records every command it receives.
function storage({ fail = false } = {}) {
  let salt, calls = 0;
  const commands = [], sets = new Map(), aggregates = {};
  const fetch = async (url, opts) => {
    calls++;
    if (fail) return new Response(null, { status: 500 });
    assert.equal(url, ENV.KV_REST_API_URL);
    assert.equal(opts.headers.authorization, "Bearer test-redis");
    const command = JSON.parse(opts.body);
    commands.push(command);
    assert.equal(command[0], "EVAL");
    if (command[1] === WEEK_SALT_LUA) {
      assert.equal(command[2], "1"); assert.equal(command[3], "fairbeam:{counts}:salt:2026-W41"); assert.equal(command[5], EXPIRES);
      salt ??= command[4];
      return Response.json({ result: salt });
    }
    assert.equal(command[1], COUNT_INSTALL_LUA); assert.equal(command[2], "3");
    const [week, tuple, agg] = command.slice(3, 6), [hash, expires, name] = command.slice(6);
    assert.equal(agg, "fairbeam:{counts}:aggregates"); assert.equal(expires, EXPIRES);
    assert.equal(name, "2026-W41--0.7.0--macos--aarch64");
    for (const k of [week, tuple]) if (!sets.has(k)) sets.set(k, new Set());
    sets.get(week).add(hash); aggregates.cumulative_weekly_distinct = sets.get(week).size;
    sets.get(tuple).add(hash); aggregates[name] = sets.get(tuple).size;
    return Response.json({ result: aggregates[name] });
  };
  return { fetch, commands, get salt() { return salt; }, get calls() { return calls; }, aggregates };
}
const call = (req, store, env = ENV) => handlePing(req, { env, fetch: store.fetch, now: () => NOW });
for (const env of [{}, { KV_REST_API_URL: ENV.KV_REST_API_URL }, { KV_REST_API_TOKEN: "x" }, { ...ENV, KV_REST_API_URL: "http://redis.example" }, { ...ENV, KV_REST_API_URL: "https://x/../y" }]) {
  const s = storage(); assert.equal((await call(request(), s, env)).status, 503); assert.equal(s.calls, 0);
}
// the other names of the Vercel Upstash integration work as well
assert.deepEqual(storageEnv({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" }), { url: "https://x.upstash.io", token: "t" });
for (const body of [null, [], good({ schema: "fairbeam.ping/99" }), good({ install_id: "unexpected" }), good({ os: "unknown" }), good({ arch: "other" }), good({ app_version: "../private" }), good({ counters: {} }), good({ app_version: 7 })]) {
  const s = storage(); assert.equal((await call(request(body), s)).status, 400); assert.equal(s.calls, 0);
}
const distinct = storage();
assert.equal((await call(request(good(), { "x-forwarded-for": "192.0.2.1", "user-agent": "private-agent" }), distinct)).status, 202);
assert.equal(distinct.aggregates["2026-W41--0.7.0--macos--aarch64"], 1);
assert.equal((await call(request(), distinct)).status, 202);
assert.equal(distinct.aggregates["2026-W41--0.7.0--macos--aarch64"], 1);
const OTHER = "2b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b";
assert.equal((await call(request(good({ install_id: OTHER })), distinct)).status, 202);
assert.equal(distinct.aggregates["2026-W41--0.7.0--macos--aarch64"], 2);
assert.equal(distinct.aggregates.cumulative_weekly_distinct, 2);
// the install ID, the request headers and the address never reach Redis; only a keyed hash does
assert.match(distinct.salt, /^[0-9a-f]{64}$/);
const sent = JSON.stringify(distinct.commands);
for (const secret of [ID, OTHER, "192.0.2.1", "private-agent"]) assert.ok(!sent.includes(secret), "nothing identifying is sent to Redis");
assert.ok(sent.includes(hashInstall(distinct.salt, ID)));
assert.equal(hashInstall("a".repeat(64), ID), createHmac("sha256", "a".repeat(64)).update(ID).digest("hex"));
assert.notEqual(hashInstall("a".repeat(64), ID), hashInstall("b".repeat(64), ID), "a new weekly salt gives a different hash");
for (const schema of SCHEMA.legacy_schemas) {
  const body = { schema, app_version: "0.6.8", os: "windows", arch: "x86_64", install_id: ID, gpu_available: true, day: "2026-10-06", counters: { "app.start": 1, "feature.pdf_report": 7 } };
  assert.deepEqual(validatePing(body, NOW).ping, { schema: "fairbeam.ping/2", app_version: "0.6.8", os: "windows", arch: "x86_64" });
  const store = storage(); assert.equal((await call(request(body), store)).status, 202);
  assert.equal(store.calls, 0, "legacy reports are acknowledged, not stored");
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
assert.equal(isoWeek("2021-01-01"), "2020-W53");
assert.equal(isoWeek("2024-12-30"), "2025-W01");
assert.equal(weekStart("2026-W41"), "2026-10-05T00:00:00Z");
assert.equal(weekStart("2020-W53"), "2020-12-28T00:00:00Z");
assert.equal(weekStart("2025-W01"), "2024-12-30T00:00:00Z");
assert.deepEqual(parseRedisAggregates({ "2026-W41--0.7.0--macos--aarch64": "2", cumulative_weekly_distinct: "5", "2026-W40--0.7.0--windows--x86_64": "1" }),
  { rows: [{ week: "2026-W40", app_version: "0.7.0", os: "windows", arch: "x86_64", count: 1 }, { week: "2026-W41", app_version: "0.7.0", os: "macos", arch: "aarch64", count: 2 }], cumulative: 5 });
assert.throws(() => parseRedisAggregates({ "private": "1" }));
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
assert.ok(rust.includes('cfg!(feature = "telemetry") && !cfg!(debug_assertions)'), "debug builds neither ask nor send");
assert.match(readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"), /default = \["telemetry"\]/);
assert.ok(!readFileSync(new URL("../src/lib/telemetry.ts", import.meta.url), "utf8").includes("telemetry_count"));
console.log("telemetry: install and legacy validation, Redis commands without identifiers, gates, release totals and pagination passed (no network)");

assert.match(COUNT_INSTALL_LUA, /cumulative_weekly_distinct/);
assert.match(WEEK_SALT_LUA, /EXAT/);
assert.equal((COUNT_INSTALL_LUA.match(/EXPIREAT/g) || []).length, 2);
assert.ok(!/sha1hex|salt/.test(COUNT_INSTALL_LUA), "the install script never sees an ID or a salt");
