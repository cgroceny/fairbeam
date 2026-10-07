#!/usr/bin/env node
// Release download totals and weekly install counts from Redis. See docs/TELEMETRY.md.
import { pathToFileURL } from "node:url";
export const RELEASES_REPO = "ismailakdag/fairbeam-releases";
export function assetKind(name) {
  if (name === "latest.json") return "update metadata";
  if (name.endsWith(".sig") || /SHA256SUMS/i.test(name)) return "signature / checksum";
  if (/\.dmg$|\.app\.tar\.gz$|(?:^|[-_])macos[-_]/i.test(name)) return "macOS";
  if (/-setup\.exe$|\.msi$|\.nsis\.zip$|\.msi\.zip$|(?:^|[-_])windows[-_]/i.test(name)) return "Windows";
  if (/\.AppImage$|\.deb$|\.rpm$|(?:^|[-_])linux[-_]/i.test(name)) return "Linux";
  return "other";
}
export function summarizeReleases(releases) {
  return releases.flatMap((r) => {
    const totals = new Map();
    for (const a of r.assets ?? []) {
      const kind = assetKind(a.name);
      totals.set(kind, (totals.get(kind) ?? 0) + a.download_count);
    }
    return [...totals].map(([platform, downloads]) => ({ version: r.tag_name ?? r.tag, platform, downloads }));
  });
}
// Public REST requests: no token or gh login is needed. Fetch every page, including older releases.
export async function fetchReleases(fetchImpl = globalThis.fetch) {
  const releases = [];
  for (let page = 1; ; page++) {
    const r = await fetchImpl(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=100&page=${page}`, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    if (!r.ok) throw new Error(`GitHub releases HTTP ${r.status}`);
    const batch = await r.json();
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
}
// The Redis hash fairbeam:{counts}:aggregates: "week--version--os--arch" -> distinct installs of that
// week, plus one cumulative sum of the weekly distinct installs.
const FIELD_RE = /^(\d{4}-W\d{2})--([0-9a-z.-]+)--([a-z]+)--([a-z0-9_]+)$/;
export function parseRedisAggregates(hash) {
  let cumulative = 0;
  const rows = [];
  for (const [field, value] of Object.entries(hash)) {
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid usage aggregate");
    if (field === "cumulative_weekly_distinct") { cumulative = count; continue; }
    const m = FIELD_RE.exec(field);
    if (!m) throw new Error("invalid usage aggregate");
    rows.push({ week: m[1], app_version: m[2], os: m[3], arch: m[4], count });
  }
  rows.sort((x, y) => x.week.localeCompare(y.week) || x.app_version.localeCompare(y.app_version) || x.os.localeCompare(y.os) || x.arch.localeCompare(y.arch));
  return { rows, cumulative };
}
// REST HGETALL: the result is a flat list [field, value, ...]. The environment comes from
// `vercel env pull` (KV_REST_API_URL and KV_REST_API_TOKEN, or the read-only token).
export async function fetchRedisAggregates(env = process.env, fetchImpl = globalThis.fetch) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_READ_ONLY_TOKEN || env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("--redis needs KV_REST_API_URL and KV_REST_API_TOKEN in the environment (vercel env pull)");
  const r = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(["HGETALL", "fairbeam:{counts}:aggregates"]) });
  if (!r.ok) throw new Error(`Redis HTTP ${r.status}`);
  const { result } = await r.json();
  if (!Array.isArray(result) || result.length % 2) throw new Error("unexpected Redis answer");
  const hash = {};
  for (let i = 0; i < result.length; i += 2) hash[result[i]] = result[i + 1];
  return parseRedisAggregates(hash);
}
const table = (rows) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join("  ")).join("\n");
};
async function main(argv) {
  let redis = false, releases = true, only = false;
  for (const arg of argv) {
    if (arg === "--redis") redis = true;
    else if (arg === "--releases-only") only = true;
    else if (arg === "--no-releases") releases = false;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (releases || only) {
    const rows = summarizeReleases(await fetchReleases());
    console.log(table([["version", "platform / asset category", "downloads"], ...rows.map((r) => [r.version, r.platform, r.downloads])]));
    console.log("Downloads are requests for assets, not unique people or installs. Update metadata and signatures are separate.");
  }
  if (only || !redis) return;
  const { rows, cumulative } = await fetchRedisAggregates();
  console.log(table([["week", "version", "OS", "architecture", "distinct installs"], ...rows.map((r) => [r.week, r.app_version, r.os, r.arch, r.count])]));
  console.log(`Weekly distinct installs; the sum over all weeks is ${cumulative}. A returning install counts again each week, so the sum is an estimate, not an all-time distinct count.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
