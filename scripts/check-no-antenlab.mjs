#!/usr/bin/env node
// Guard: the old product name must not appear in the repository except in the files that read or
// explain old formats. Scans the tracked files (their paths and their text lines) for /antenlab/i
// and prints `path:line: snippet` for every hit that the allowlist below does not cover.
//
// Usage: node scripts/check-no-antenlab.mjs            fail on any hit (exit 1)
//        node scripts/check-no-antenlab.mjs --report   exit 0; counts per area, nothing else
//        node scripts/check-no-antenlab.mjs --all      list every hit, not only the first 200
//
// Every allowlist entry needs a reason, and an entry that no longer covers anything fails the check,
// so the list stays as short as it can be. Do not add an entry to make a check pass: rename or
// remove the text instead.
import { areaOf, globToRegExp, readText, trackedFiles } from "./lib/tracked-files.mjs";

const report = process.argv.includes("--report");
const showAll = process.argv.includes("--all");
const OLD = /antenlab/i;

/** { glob, line?: RegExp, reason }. Without `line` the whole file (and its path) is allowed. */
const ALLOW = [
  { glob: "scripts/check-no-antenlab.mjs", reason: "this guard names the old product" },
  { glob: "src-tauri/src/antenlab_import/**", reason: "the importer, its tests and its en/tr texts (the Help item to remove the old app included)" },
  { glob: "src-tauri/src/main.rs", line: /antenlab_import|Remove antenlab/, reason: "the importer's module, its start hook and its Help menu item" },
  { glob: "python/fairbeam/legacy.py", reason: "the old schema ids, CST marker spellings, reserved prefix, attribute and generator name that files from the old app carry" },
  { glob: "src/lib/legacy.ts", reason: "the same old names for the viewer, and the web storage carry-over" },
  { glob: "api/_ping-schema.json", line: /antenlab\.ping\/1/, reason: "installed old apps keep sending their ping id" },
  { glob: "python/tests/fixtures/legacy/**", reason: "files the old app wrote: proof that they still open" },
  { glob: "python/tests/test_legacy_formats.py", reason: "proof that files of the old app still open" },
  { glob: "scripts/check-legacy-formats.mjs", reason: "proof that files of the old app still open" },
  { glob: "docs/MIGRATING-FROM-ANTENLAB.md", reason: "the migration page for users of the old app" },
  { glob: "**", line: /MIGRATING-FROM-ANTENLAB\.md|Migrating from antenlab/, reason: "links to the migration page" },
  { glob: "docs/DESKTOP.md", line: /Coming from antenlab/, reason: "the heading of the section that links to the migration page" },
  { glob: "README.md", line: /formerly antenlab|eskiden antenlab/i, reason: "the one-line former-name note" },
  { glob: "NOTICE.md", line: /formerly antenlab|eskiden antenlab/i, reason: "the one-line former-name note" },
  { glob: "docs/RELEASES.md", line: /formerly antenlab|eskiden antenlab/i, reason: "the one-line former-name note (the first changelog entry)" },
  { glob: "landing/index.html", line: /formerly antenlab|eskiden antenlab/i, reason: "the one-line former-name note" },
  { glob: "landing/language.js", line: /formerly antenlab|eskiden antenlab/i, reason: "the one-line former-name note (its Turkish pair)" },
  { glob: "package.json", line: /check[:-]no-antenlab/, reason: "the name of this guard" },
  { glob: "AGENTS.md", line: /check[:-]no-antenlab/, reason: "the name of this guard" },
  { glob: ".github/workflows/ci.yml", line: /check[:-]no-antenlab/, reason: "the name of this guard" },
  { glob: "scripts/check-legal.mjs", line: /check[:-]no-antenlab/, reason: "the name of this guard" },
  { glob: "scripts/publish-release.mjs", line: /\/antenlab-releases\//, reason: "the refusal to publish to the old release channel" },
  { glob: "vercel.json", line: /"value": "antenlab\.akdag\.dev"/, reason: "the host the redirect to fairbeam.org matches (pages only; old apps keep pinging its /api)" },
  { glob: "scripts/check-telemetry-api.mjs", line: /antenlab\.akdag\.dev/, reason: "proof that pings and the redirect rule for the old host still work" },
  { glob: "docs/DEPLOY.md", line: /antenlab\.akdag\.dev/, reason: "documents the old domain that is kept for installed old apps" },
  { glob: "docs/TELEMETRY.md", line: /antenlab\.akdag\.dev/, reason: "says that installed old apps keep pinging the old host" },
].map((e) => ({ ...e, re: globToRegExp(e.glob), used: false }));

/** The allowlist entries that cover `path`: whole-file ones and per-line ones. */
function entriesFor(path) {
  const own = ALLOW.filter((e) => e.re.test(path));
  return { own, whole: own.some((e) => !e.line), lines: own.filter((e) => e.line).map((e) => new RegExp(e.line.source, "gi")) };
}

/** A text is allowed when nothing of the old name is left after blanking the allowed patterns. */
function lineAllowed(text, patterns) {
  let rest = text;
  for (const p of patterns) rest = rest.replace(p, "");
  return !OLD.test(rest);
}

const hits = [];
for (const path of trackedFiles()) {
  const { own, whole, lines: patterns } = entriesFor(path);
  const text = readText(path);
  const lines = text !== null && OLD.test(text) ? text.split(/\r?\n/) : [];
  // an entry is used when it covers an occurrence of the old name in this file
  for (const e of own) {
    if (!e.line) e.used ||= OLD.test(path) || lines.length > 0;
    else e.used ||= OLD.test(path) ? e.line.test(path) : lines.some((l) => OLD.test(l) && e.line.test(l));
  }
  if (whole) continue;
  if (OLD.test(path) && !lineAllowed(path, patterns)) hits.push({ path, line: 0, text: path });
  for (let i = 0; i < lines.length; i++) {
    if (OLD.test(lines[i]) && !lineAllowed(lines[i], patterns)) hits.push({ path, line: i + 1, text: lines[i] });
  }
}
const unused = ALLOW.filter((e) => !e.used);

if (report) {
  const byArea = new Map();
  for (const h of hits) {
    const a = byArea.get(areaOf(h.path)) ?? { lines: 0, files: new Set() };
    a.lines++;
    a.files.add(h.path);
    byArea.set(areaOf(h.path), a);
  }
  const rows = [...byArea].sort((x, y) => y[1].lines - x[1].lines);
  console.log("area".padEnd(28), "lines".padStart(8), "files".padStart(7));
  for (const [area, a] of rows) console.log(area.padEnd(28), String(a.lines).padStart(8), String(a.files.size).padStart(7));
  const files = new Set(hits.map((h) => h.path));
  console.log("total".padEnd(28), String(hits.length).padStart(8), String(files.size).padStart(7));
  process.exit(0);
}

const LIMIT = showAll ? Infinity : 200;
for (const h of hits.slice(0, LIMIT)) console.error(`${h.path}:${h.line}: ${h.text.trim().slice(0, 160)}`);
if (hits.length > LIMIT) console.error(`... and ${hits.length - LIMIT} more (use --all)`);
for (const e of unused) console.error(`allowlist entry covers nothing, remove it: ${e.glob}${e.line ? ` ${e.line}` : ""}`);
if (hits.length || unused.length) {
  if (hits.length) console.error(`check:no-antenlab: ${hits.length} hit(s) of the old name outside the allowlist`);
  if (unused.length) console.error(`check:no-antenlab: ${unused.length} unused allowlist entr${unused.length === 1 ? "y" : "ies"}`);
  process.exit(1);
}
console.log("check:no-antenlab: ok");
