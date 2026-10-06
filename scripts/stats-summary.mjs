#!/usr/bin/env node
// Summary of the desktop app's usage (docs/TELEMETRY.md).
//
//   1. Numbers that exist without any telemetry: the download counts of every release asset of
//      ismailakdag/fairbeam-releases (gh api). The updater fetches latest.json from the latest
//      release on every update check, so its count is a rough proxy for launches.
//   2. The usage pings (once usage statistics are turned on): the jsonl lines of the stats
//      repository (the STATS_REPO of api/_ping-core.js), from a local clone (--dir) or through
//      gh api (--gh, with --repo or STATS_REPO). They give the daily
//      and weekly active installs, the OS/GPU/version shares, simulations per day with the engine
//      split, failures by category and the feature usage.
//
// Usage:
//   node scripts/stats-summary.mjs --releases-only
//   node scripts/stats-summary.mjs --dir <stats-clone>/data [--days 28]
//   node scripts/stats-summary.mjs --gh --repo <owner>/<stats-repo> [--days 28] [--no-releases]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const RELEASES_REPO = "ismailakdag/fairbeam-releases";
const FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:-\d+)?\.jsonl$/;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- pure parts (tested)

/** The ping lines as objects, one per (id, day): a retried ping counts once. */
export function parseLines(texts) {
  const byKey = new Map();
  for (const text of texts) {
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      let l;
      try { l = JSON.parse(raw); } catch { continue; }
      if (!l || typeof l.id !== "string" || typeof l.day !== "string" || !l.c || typeof l.c !== "object") continue;
      byKey.set(`${l.id}|${l.day}`, l);
    }
  }
  return [...byKey.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** ISO week of a YYYY-MM-DD day, as "2026-W39". */
export function isoWeek(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3); // the Thursday of this week
  const year = d.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d - first) / DAY_MS - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const add = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);
const sumPrefix = (c, prefix) => Object.entries(c).reduce((n, [k, v]) => (k.startsWith(prefix) ? n + v : n), 0);

export function summarize(lines, { days = 28, today = new Date().toISOString().slice(0, 10) } = {}) {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
  const recent = lines.filter((l) => l.day >= from && l.day < today);
  const daily = new Map(); // day -> {installs:Set, cpu, gpu, finished, failed}
  const weekly = new Map(); // week -> Set of ids
  const latest = new Map(); // id -> the newest line of that install
  const failures = new Map();
  const features = new Map();
  for (const l of recent) {
    const d = daily.get(l.day) ?? { installs: new Set(), cpu: 0, gpu: 0, finished: 0, failed: 0 };
    d.installs.add(l.id);
    d.cpu += sumPrefix(l.c, "sim.started.cpu.");
    d.gpu += sumPrefix(l.c, "sim.started.gpu.");
    d.finished += sumPrefix(l.c, "sim.finished.");
    d.failed += sumPrefix(l.c, "sim.failed.");
    daily.set(l.day, d);
    const w = weekly.get(isoWeek(l.day)) ?? new Set();
    w.add(l.id);
    weekly.set(isoWeek(l.day), w);
    latest.set(l.id, l);
    for (const [k, v] of Object.entries(l.c)) {
      if (k.startsWith("sim.failed.")) add(failures, k.split(".").pop(), v);
      else if (/^(monitor|sweep|optimize|feature)\./.test(k) || k === "app.install" || k.startsWith("app.update_from.") || k.startsWith("sim.refused.")) add(features, k, v);
    }
  }
  const share = (pick) => {
    const m = new Map();
    for (const l of latest.values()) add(m, pick(l));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  return {
    from, to: today, installs: latest.size,
    daily: [...daily.entries()].map(([day, d]) => ({ day, installs: d.installs.size, sims: d.cpu + d.gpu, cpu: d.cpu, gpu: d.gpu, finished: d.finished, failed: d.failed })),
    weekly: [...weekly.entries()].sort().map(([week, ids]) => ({ week, installs: ids.size })),
    os: share((l) => `${l.os}/${l.arch}`),
    gpu: share((l) => (l.gpu ? "GPU build present" : "no GPU build")),
    versions: share((l) => l.v),
    failures: [...failures.entries()].sort((a, b) => b[1] - a[1]),
    features: [...features.entries()].sort((a, b) => b[1] - a[1]),
  };
}

/** Release assets by kind; the kinds a download count can tell something about. */
export function assetKind(name) {
  if (name === "latest.json") return "update check (latest.json)";
  if (name.endsWith(".sig") || /SHA256SUMS/i.test(name)) return "signature / checksum";
  if (name.endsWith(".dmg")) return "macOS installer (.dmg)";
  if (name.endsWith(".app.tar.gz")) return "macOS update (.app.tar.gz)";
  if (/-setup\.exe$|\.msi$/.test(name)) return "Windows installer (also its updates)";
  if (name.endsWith(".nsis.zip") || name.endsWith(".msi.zip")) return "Windows update";
  return "other";
}

export function summarizeReleases(releases) {
  const kinds = new Map();
  const rows = releases.map((r) => {
    let total = 0;
    for (const a of r.assets) {
      add(kinds, assetKind(a.name), a.download_count);
      if (assetKind(a.name) !== "signature / checksum") total += a.download_count;
    }
    const latestJson = r.assets.find((a) => a.name === "latest.json")?.download_count ?? 0;
    return { tag: r.tag, published: (r.published ?? "").slice(0, 10), downloads: total, latestJson };
  });
  return { rows, kinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]) };
}

// ---------------------------------------------------------------- I/O

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
}

function fetchReleases() {
  const out = gh(["api", `repos/${RELEASES_REPO}/releases`, "--paginate", "--jq",
    ".[] | {tag: .tag_name, published: .published_at, assets: [.assets[] | {name, download_count}]}"]);
  return out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function inWindow(name, days) {
  const m = FILE_RE.exec(name);
  if (!m) return false;
  // a ping arrives on the day after its usage day, or later: read a few extra days
  return Date.parse(`${m[1]}T00:00:00Z`) >= Date.now() - (days + 7) * DAY_MS;
}

function readDir(dir, days) {
  if (!existsSync(dir)) throw new Error(`no folder ${dir}`);
  return readdirSync(dir).filter((f) => inWindow(f, days)).map((f) => readFileSync(join(dir, f), "utf8"));
}

function readGh(repo, days) {
  let names;
  try {
    names = gh(["api", `repos/${repo}/contents/data`, "--jq", ".[] | .name"]).split("\n").filter(Boolean);
  } catch (e) {
    if (/404|Not Found/.test(String(e.stderr ?? e.message))) return [];
    throw e;
  }
  return names.filter((f) => inWindow(f, days))
    .map((f) => gh(["api", `repos/${repo}/contents/data/${f}`, "-H", "Accept: application/vnd.github.raw"]));
}

const pct = (n, total) => (total ? `${Math.round((100 * n) / total)} %` : "–");
const table = (rows) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join("  ")).join("\n");
};

function printReleases(s) {
  console.log(`Release downloads (${RELEASES_REPO}, no telemetry needed)\n`);
  console.log(table([["release", "published", "downloads", "latest.json"], ...s.rows.map((r) => [r.tag, r.published, r.downloads, r.latestJson])]));
  console.log("\nBy kind, all releases:");
  console.log(table(s.kinds.map(([k, n]) => [`  ${k}`, n])));
  console.log("\nlatest.json is fetched by every update check (on start unless turned off, and Help › Check for updates): a rough launch count.");
}

function printUsage(s) {
  console.log(`\nUsage pings ${s.from} … ${s.to} (exclusive): ${s.installs} installs\n`);
  if (!s.installs) { console.log("No pings in this window (usage statistics are not active yet)."); return; }
  console.log("Daily active installs and simulations started");
  console.log(table([["day", "installs", "sims", "cpu", "gpu", "finished", "failed"], ...s.daily.map((d) => [d.day, d.installs, d.sims, d.cpu, d.gpu, d.finished, d.failed])]));
  console.log("\nWeekly active installs");
  console.log(table([["week", "installs"], ...s.weekly.map((w) => [w.week, w.installs])]));
  for (const [title, rows] of [["OS", s.os], ["GPU", s.gpu], ["Version", s.versions]]) {
    console.log(`\n${title} (share of installs)`);
    console.log(table(rows.map(([k, n]) => [`  ${k}`, n, pct(n, s.installs)])));
  }
  if (s.failures.length) { console.log("\nFailures by category"); console.log(table(s.failures.map(([k, n]) => [`  ${k}`, n]))); }
  if (s.features.length) { console.log("\nFeatures"); console.log(table(s.features.map(([k, n]) => [`  ${k}`, n]))); }
}

function main(argv) {
  const opt = { days: 28, repo: process.env.STATS_REPO ?? null, releases: true, only: false, dir: null, gh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") opt.dir = argv[++i];
    else if (a === "--gh") opt.gh = true;
    else if (a === "--repo") opt.repo = argv[++i];
    else if (a === "--days") opt.days = Math.max(1, Number(argv[++i]) || 28);
    else if (a === "--no-releases") opt.releases = false;
    else if (a === "--releases-only") opt.only = true;
    else { console.error(`unknown option ${a}\nusage: stats-summary.mjs [--releases-only] [--dir <data folder> | --gh --repo owner/name] [--days N] [--no-releases]`); process.exit(2); }
  }
  if (opt.gh && !opt.dir && !opt.repo) { console.error("--gh needs --repo <owner>/<stats-repo> (or the STATS_REPO environment variable)"); process.exit(2); }
  if (opt.releases || opt.only) {
    try { printReleases(summarizeReleases(fetchReleases())); }
    catch (e) { console.error(`release downloads: ${e.message.split("\n")[0]} (is gh installed and logged in?)`); }
  }
  if (opt.only) return;
  if (!opt.dir && !opt.gh) { console.log("\n(no --dir or --gh: the usage pings were not read)"); return; }
  const texts = opt.dir ? readDir(opt.dir, opt.days) : readGh(opt.repo, opt.days);
  printUsage(summarize(parseLines(texts), { days: opt.days }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
