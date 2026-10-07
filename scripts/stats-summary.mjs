#!/usr/bin/env node
// Release download totals and minimal weekly usage aggregates. See docs/TELEMETRY.md.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
export function parseAggregates(texts) {
  return texts.map((text) => JSON.parse(text)).map((row) => {
    const keys = Object.keys(row).sort().join(",");
    if (keys !== "app_version,arch,count,os,week" || !Number.isSafeInteger(row.count) || row.count < 0) throw new Error("invalid usage aggregate");
    return row;
  }).sort((a, b) => a.week.localeCompare(b.week) || a.app_version.localeCompare(b.app_version));
}
const FILE_RE = /^\d{4}-W\d{2}--[a-z0-9.-]+--[a-z]+--[a-z0-9_]+(?:--installs)?\.json$/;
function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
}
const table = (rows) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join("  ")).join("\n");
};
async function main(argv) {
  let dir, repo = process.env.STATS_REPO, remote = false, releases = true, only = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") dir = argv[++i];
    else if (argv[i] === "--repo") repo = argv[++i];
    else if (argv[i] === "--gh") remote = true;
    else if (argv[i] === "--releases-only") only = true;
    else if (argv[i] === "--no-releases") releases = false;
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  if (releases || only) {
    const rows = summarizeReleases(await fetchReleases());
    console.log(table([["version", "platform / asset category", "downloads"], ...rows.map((r) => [r.version, r.platform, r.downloads])]));
    console.log("Downloads are requests for assets, not unique people or installs. Update metadata and signatures are separate.");
  }
  if (only || (!dir && !remote)) return;
  let texts;
  if (dir) texts = readdirSync(dir).filter((n) => FILE_RE.test(n)).map((n) => readFileSync(join(dir, n), "utf8"));
  else {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) throw new Error("--gh needs --repo owner/name");
    const names = JSON.parse(gh(["api", `repos/${repo}/contents/data`]));
    texts = names.filter((f) => FILE_RE.test(f.name)).map((f) => gh(["api", `repos/${repo}/contents/data/${f.name}`, "-H", "Accept: application/vnd.github.raw"]));
  }
  const rows = parseAggregates(texts);
  console.log(table([["week", "version", "OS", "architecture", "count"], ...rows.map((r) => [r.week, r.app_version, r.os, r.arch, r.count])]));
  console.log("Files ending in --installs contain weekly distinct installations; other files contain legacy report totals. Summing weeks is an estimate, not an all-time distinct count.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
