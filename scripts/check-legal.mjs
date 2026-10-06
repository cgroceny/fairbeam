#!/usr/bin/env node
// Guard: Fairbeam names CST only as the target of a VBA macro export and import, and never compares
// itself with a commercial product. Scans the tracked files and fails with `path:line: snippet`.
//
// Rules:
//   forbidden  comparison wording and the vendor name, anywhere (the trademark note may name the
//              vendor: it is the one line that also says "trademark")
//   cst-bare   on the user-visible surfaces every uppercase CST must sit inside
//              "CST-compatible VBA macro" / "CST uyumlu VBA makro" (the trademark note is exempt)
//   path       paths and lines about the binary CST project format or the CST cross-check
//
// Code identifiers (cst.ts, cst_import.py) and plain "CST" in code comments about the VBA object
// model are fine: rule cst-bare covers only the surfaces listed in SURFACES.
//
// Usage: node scripts/check-legal.mjs            fail on any hit (exit 1; enforced since WS1)
//        node scripts/check-legal.mjs --report   exit 0; counts per rule and area
import { areaOf, globToRegExp, readText, trackedFiles } from "./lib/tracked-files.mjs";

const report = process.argv.includes("--report");
const showAll = process.argv.includes("--all");

const FORBIDDEN = /commercial (solver|alternative|tool)|Dassault|CST-style|like CST|CST['’]s|compared with CST|CST benzeri|CST tarzı/i;
const PATHRULE = /cst_project|\.cst(["'\s]|$)|cstproject|cst-crosscheck|commercial-/i;
const OK_CST = /CST-compatible VBA macro|CST uyumlu VBA makro/g;
const TRADEMARK_LINE = /trademark|ticari marka/i;

/** The user-visible surfaces for rule cst-bare. */
const SURFACES = [
  "src/i18n/*.json",
  "src-tauri/src/i18n.rs",
  "landing/**",
  "README.md",
  "docs/**",
  "NOTICE.md",
].map(globToRegExp);
/** The Python CLI: only its help and description strings count as a surface. */
const CLI = /^python\/[^/]+\/cli\.py$/;
const CLI_TEXT = /\b(help|description|epilog)\s*=|^\s*["'].*["']\s*$/;

/** Files the rules never read: this script, and the guard that names the old product. */
const SKIP = ["scripts/check-legal.mjs", "scripts/check-no-antenlab.mjs"];
/** Generated or third-party text that the surfaces glob would otherwise catch. */
const NOT_SURFACE = ["landing/vendor/**", "landing/**/*.svg", "landing/**/*.map"].map(globToRegExp);

const hits = [];
const add = (rule, path, line, text) => hits.push({ rule, path, line, text });

for (const path of trackedFiles()) {
  if (SKIP.includes(path)) continue;
  if (PATHRULE.test(path)) add("path", path, 0, path);
  const text = readText(path);
  if (text === null) continue;
  const surface = (SURFACES.some((r) => r.test(path)) && !NOT_SURFACE.some((r) => r.test(path))) || CLI.test(path);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const n = i + 1;
    const trademark = TRADEMARK_LINE.test(l);
    if (FORBIDDEN.test(l)) {
      // the vendor's name is allowed on the trademark note only
      const rest = l.replace(/Dassault Syst[eè]mes/gi, "");
      if (!trademark || FORBIDDEN.test(rest)) add("forbidden", path, n, l);
    }
    if (PATHRULE.test(l)) add("path", path, n, l);
    if (surface && !trademark && /\bCST\b/.test(l) && (!CLI.test(path) || CLI_TEXT.test(l))) {
      if (/\bCST\b/.test(l.replace(OK_CST, ""))) add("cst-bare", path, n, l);
    }
  }
}

if (report) {
  const key = (h) => `${h.rule}\t${areaOf(h.path)}`;
  const counts = new Map();
  for (const h of hits) counts.set(key(h), (counts.get(key(h)) ?? 0) + 1);
  console.log("rule".padEnd(11), "area".padEnd(28), "hits".padStart(6));
  for (const [k, n] of [...counts].sort((a, b) => a[0].localeCompare(b[0]) || b[1] - a[1])) {
    const [rule, area] = k.split("\t");
    console.log(rule.padEnd(11), area.padEnd(28), String(n).padStart(6));
  }
  console.log("total".padEnd(40), String(hits.length).padStart(6));
  process.exit(0);
}

const LIMIT = showAll ? Infinity : 200;
for (const h of hits.slice(0, LIMIT)) console.error(`${h.path}:${h.line}: [${h.rule}] ${h.text.trim().slice(0, 160)}`);
if (hits.length > LIMIT) console.error(`... and ${hits.length - LIMIT} more (use --all)`);
if (hits.length) {
  console.error(`check:legal: ${hits.length} hit(s)`);
  process.exit(1);
}
console.log("check:legal: ok");
