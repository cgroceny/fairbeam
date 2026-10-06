#!/usr/bin/env node
// Refresh landing/roadmap.json from GitHub. For every item it reads the state of the linked issues
// and pull requests with gh, and rewrites the item's status and release, and the file's updated date:
//   available    every link is done (a merged PR, or an issue closed as completed); the release is
//                the first vX.Y.Z tag that contains the merge commits, else "next";
//   development  an open PR, an open issue with an open PR that closes it, part of the links done,
//                or started: true (work begun before its first PR);
//   planned      open issues only.
// Closed-unmerged PRs and issues closed as not planned are ignored. Items without links keep the
// status and release written by hand. Titles, descriptions, links and order are never touched, and
// a second run with nothing new on GitHub leaves the file as it is (apart from the date).
// Needs gh (authenticated) and git with the repository's tags.
// Usage: npm run roadmap            write landing/roadmap.json and print what changed
//        npm run roadmap -- --dry-run   print only
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "landing", "roadmap.json");
const dryRun = process.argv.includes("--dry-run");
const STATUSES = ["available", "development", "planned"];
const LABEL = { available: "available", development: "in development", planned: "planned" };

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const gh = (args) => JSON.parse(run("gh", args));
const warnings = [];
const warn = (msg) => warnings.push(msg);

/** The JSON layout of the hand-written file: two-space indent, number arrays on one line. */
const formatRoadmap = (data) =>
  `${JSON.stringify(data, null, 2).replace(/\[\s*(\d+(?:,\s*\d+)*)\s*\]/g, (_, nums) => `[${nums.split(/,\s*/).join(", ")}]`)}\n`;

const text = readFileSync(file, "utf8");
const data = JSON.parse(text);
const repo = data.repo;
if (!repo) throw new Error("roadmap.json: no repo");

// ---------------------------------------------------------------- GitHub state, in two calls
const prs = new Map();
const issues = new Map();
const closers = new Map(); // issue number -> PRs whose closing keywords name it
for (const pr of gh(["pr", "list", "-R", repo, "--state", "all", "--limit", "1000", "--json", "number,state,mergeCommit,closingIssuesReferences"])) {
  prs.set(pr.number, pr);
  for (const ref of pr.closingIssuesReferences ?? []) closers.set(ref.number, [...(closers.get(ref.number) ?? []), pr]);
}
for (const issue of gh(["issue", "list", "-R", repo, "--state", "all", "--limit", "1000", "--json", "number,state,stateReason"])) issues.set(issue.number, issue);

// ---------------------------------------------------------------- releases: the first tag with the commit
try {
  run("git", ["fetch", "--quiet", "--tags", "origin"]);
} catch {
  console.warn("roadmap: git fetch --tags failed; using the local tags");
}
const version = (tag) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.slice(1).map(Number);
const newer = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
const releaseCache = new Map();
/** "0.3.0" for the lowest vX.Y.Z tag containing the commit, "next" for none, null if unknown here. */
function releaseOf(sha) {
  if (!releaseCache.has(sha)) {
    let rel = null;
    try {
      const tags = run("git", ["tag", "--contains", sha]).split(/\s+/).map(version).filter(Boolean).sort(newer);
      rel = tags.length ? tags[0].join(".") : "next";
    } catch {
      warn(`commit ${sha.slice(0, 7)} is not in the local clone; its release is unknown`);
    }
    releaseCache.set(sha, rel);
  }
  return releaseCache.get(sha);
}
const compareRelease = (a, b) => (a === b ? 0 : a === "next" ? 1 : b === "next" ? -1 : newer(a.split(".").map(Number), b.split(".").map(Number)));

// ---------------------------------------------------------------- one link, one item
/** done (with merge commits), active, open, or ignored */
function linkState(n, where) {
  const pr = prs.get(n);
  if (pr) {
    if (pr.state === "MERGED") return { state: "done", commits: [pr.mergeCommit?.oid].filter(Boolean) };
    if (pr.state === "OPEN") return { state: "active" };
    return { state: "ignored" };
  }
  const issue = issues.get(n);
  if (!issue) {
    warn(`${where}: #${n} is neither an issue nor a PR of ${repo}`);
    return { state: "ignored" };
  }
  const by = closers.get(n) ?? [];
  if (issue.state === "CLOSED") {
    if (issue.stateReason && issue.stateReason !== "COMPLETED") return { state: "ignored" };
    return { state: "done", commits: by.filter((p) => p.state === "MERGED").map((p) => p.mergeCommit?.oid).filter(Boolean) };
  }
  return { state: by.some((p) => p.state === "OPEN") ? "active" : "open" };
}

function refresh(item, where) {
  const links = item.links ?? [];
  if (!links.length) return;
  const states = links.map((n) => linkState(n, where)).filter((s) => s.state !== "ignored");
  if (!states.length) {
    warn(`${where}: none of ${links.map((n) => `#${n}`).join(", ")} counts (closed without merge or as not planned); status kept`);
    return;
  }
  const done = states.filter((s) => s.state === "done");
  if (done.length === states.length) {
    const releases = done.flatMap((s) => s.commits).map(releaseOf);
    item.status = "available";
    // the item is out once its last part is out; unknown commits keep the hand-written release
    if (releases.includes(null) || !releases.length) item.release ??= "next";
    else item.release = releases.sort(compareRelease).at(-1);
    return;
  }
  item.status = done.length || item.started || states.some((s) => s.state === "active") ? "development" : "planned";
  delete item.release;
}

// ---------------------------------------------------------------- update, summarise, write
const describe = (it) => `${LABEL[it.status] ?? it.status}${it.status === "available" && it.release ? ` (${it.release === "next" ? "next release" : it.release})` : ""}`;
const changes = [];
const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
let total = 0;
for (const area of data.areas) {
  for (const item of area.items) {
    const where = `${area.name} › ${item.title}`;
    const before = describe(item);
    refresh(item, where);
    if (!STATUSES.includes(item.status)) warn(`${where}: unknown status "${item.status}"`);
    else counts[item.status]++;
    total++;
    const after = describe(item);
    if (after !== before) changes.push(`  ${where}: ${before} → ${after}`);
  }
}
const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD, local
const oldDate = data.updated;
data.updated = today;

const out = formatRoadmap(data);
console.log(`roadmap: ${total} items, ${counts.available} available, ${counts.development} in development, ${counts.planned} planned`);
console.log(changes.length ? `${changes.length} changed:\n${changes.join("\n")}` : "no status changes");
if (oldDate !== today) console.log(`updated: ${oldDate} → ${today}`);
if (warnings.length) console.warn(`warnings:\n${warnings.map((w) => `  ${w}`).join("\n")}`);
if (out === text) console.log("landing/roadmap.json is up to date");
else if (dryRun) console.log("dry run: landing/roadmap.json not written");
else {
  writeFileSync(file, out);
  console.log("wrote landing/roadmap.json");
}
