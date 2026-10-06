#!/usr/bin/env node
// Publishes installers to the public release repository (ismailakdag/fairbeam-releases) and merges
// the updater manifest latest.json. Only release files are public. See docs/RELEASES.md.
// Adapted from the fastannotate release script.
//
//   node scripts/publish-release.mjs --version 0.2.0 [--notes-file notes.md] [--summary "text"]
//     [--asset windows-x86_64=<setup.exe>]        signed updater artifact (<file>.sig beside it)
//     [--file <path>[=<published name>]]          plain download without an updater entry
//     [--repo ismailakdag/fairbeam-releases] [--latest=false] [--dry-run]
//
// Published files are named fairbeam_<version>_<platform>; the
// release title is "Fairbeam <version>". The default repository is the Fairbeam release channel.
// --latest=false creates a NEW release without the "latest" mark, so the update feed
// (releases/latest/download/latest.json) does not serve it yet: check the real files, then run
// `gh release edit v<version> -R <repo> --latest`. An existing release keeps its mark either way.
//
// Each platform may be published from its own machine; entries already in latest.json are kept.
// The release page gets the full notes; latest.json gets a short plain-text summary (--summary, else
// the notes' first paragraph without Markdown), because the app shows it in its update dialog.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const PLATFORM_NAMES = {
  "windows-x86_64": "windows-x64-setup.exe",
  "darwin-aarch64": "macos-arm64.app.tar.gz",
};

function parseArguments(argv) {
  const options = { repo: "ismailakdag/fairbeam-releases", assets: [], files: [], dryRun: false, latest: true };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${name} needs a value`);
      return next;
    };
    if (name === "--version") options.version = value();
    else if (name === "--notes-file") options.notesFile = value();
    else if (name === "--summary") options.summary = value();
    else if (name === "--repo") options.repo = value();
    else if (name === "--asset") options.assets.push(value());
    else if (name === "--file") options.files.push(value());
    else if (name === "--dry-run") options.dryRun = true;
    else if (name === "--latest" || name === "--latest=true") options.latest = true;
    else if (name === "--latest=false") options.latest = false;
    else throw new Error(`Unknown argument ${name}`);
  }
  // The old product's release feed must never receive a Fairbeam build (its apps would offer it as an update).
  if (/antenlab-releases/i.test(options.repo)) throw new Error(`--repo ${options.repo} is the previous product's release channel; Fairbeam publishes to ismailakdag/fairbeam-releases`);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(options.version ?? "")) throw new Error("--version must be semantic, e.g. 0.2.1");
  if (!options.assets.length && !options.files.length && !options.notesFile) throw new Error("Nothing to publish");
  return options;
}

function gh(args, { allowFailure = false } = {}) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`gh ${args.join(" ")} failed:\n${result.stderr}`);
  return result;
}

/** The update dialog's text: plain, short, and pointing at the full notes on the release page. */
function updateSummary(notes, releaseUrl, max = 400) {
  const plain = (text) => text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")        // [text](url) -> text
    .replace(/\*\*|__|`/g, "")                        // bold, code
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "") // headings, quotes, list markers
    .replace(/\s+/g, " ").trim();
  const first = plain((notes ?? "").split(/\n\s*\n/).find((p) => plain(p)) ?? "");
  const cut = first.length > max ? `${first.slice(0, first.lastIndexOf(" ", max - 1) > 0 ? first.lastIndexOf(" ", max - 1) : max - 1)}…` : first;
  return [cut, `Full release notes: ${releaseUrl}`].filter(Boolean).join("\n\n");
}

const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex");

const options = parseArguments(process.argv.slice(2));
const tag = `v${options.version}`;
const downloadBase = `https://github.com/${options.repo}/releases/download/${tag}`;
const stage = mkdtempSync(join(tmpdir(), "fairbeam-release-"));
try {
  const notes = options.notesFile ? readFileSync(options.notesFile, "utf8").trim() : undefined;
  const exists = gh(["release", "view", tag, "-R", options.repo, "--json", "tagName"], { allowFailure: true }).status === 0;

  const releaseUrl = `https://github.com/${options.repo}/releases/tag/${tag}`;
  const summary = options.summary ?? (notes !== undefined ? updateSummary(notes, releaseUrl) : undefined);
  let manifest = { version: options.version, notes: summary ?? "", pub_date: new Date().toISOString(), platforms: {} };
  let checksums = new Map();
  if (exists) {
    const fetched = gh(["release", "download", tag, "-R", options.repo, "-p", "latest.json", "-p", "SHA256SUMS.txt", "-D", stage], { allowFailure: true });
    if (fetched.status !== 0 && !/no assets match/i.test(fetched.stderr)) throw new Error(fetched.stderr);
    if (existsSync(join(stage, "latest.json"))) {
      const previous = JSON.parse(readFileSync(join(stage, "latest.json"), "utf8"));
      if (previous.version !== options.version) throw new Error(`Release ${tag} carries manifest version ${previous.version}`);
      manifest = { ...previous, notes: summary ?? previous.notes, pub_date: new Date().toISOString() };
    }
    if (existsSync(join(stage, "SHA256SUMS.txt"))) {
      for (const line of readFileSync(join(stage, "SHA256SUMS.txt"), "utf8").split(/\r?\n/)) {
        const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line.trim());
        if (match) checksums.set(match[2], match[1]);
      }
    }
  }

  const uploads = [];
  for (const entry of options.assets) {
    const split = entry.indexOf("=");
    const platform = entry.slice(0, split), source = entry.slice(split + 1);
    if (split < 1 || !PLATFORM_NAMES[platform]) throw new Error(`Unknown updater platform in ${entry}; expected one of ${Object.keys(PLATFORM_NAMES).join(", ")}`);
    if (!existsSync(`${source}.sig`)) throw new Error(`Missing signature ${source}.sig; build with the updater key (docs/RELEASES.md)`);
    const published = `fairbeam_${options.version}_${PLATFORM_NAMES[platform]}`;
    copyFileSync(source, join(stage, published));
    copyFileSync(`${source}.sig`, join(stage, `${published}.sig`));
    manifest.platforms[platform] = { signature: readFileSync(`${source}.sig`, "utf8").trim(), url: `${downloadBase}/${published}` };
    uploads.push(join(stage, published), join(stage, `${published}.sig`));
    checksums.set(published, sha256(source));
  }
  for (const entry of options.files) {
    const split = entry.lastIndexOf("=");
    const source = split > 1 ? entry.slice(0, split) : entry;
    const published = split > 1 ? entry.slice(split + 1) : basename(entry);
    if (!statSync(source).isFile()) throw new Error(`Not a file: ${source}`);
    copyFileSync(source, join(stage, published));
    uploads.push(join(stage, published));
    checksums.set(published, sha256(source));
  }

  writeFileSync(join(stage, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const sums = [...checksums].sort(([a], [b]) => a.localeCompare(b)).map(([name, hash]) => `${hash}  ${name}`).join("\n");
  writeFileSync(join(stage, "SHA256SUMS.txt"), `${sums}\n`);
  uploads.push(join(stage, "latest.json"), join(stage, "SHA256SUMS.txt"));

  console.log(JSON.stringify({ repo: options.repo, tag, exists, latest: exists ? "unchanged" : options.latest, platforms: Object.keys(manifest.platforms), update_notes: manifest.notes, uploads: uploads.map(path => basename(path)) }, null, 2));
  if (options.dryRun) process.exit(0);

  if (!exists) {
    const notesPath = join(stage, "notes.md");
    writeFileSync(notesPath, notes ?? `Fairbeam ${options.version}`);
    gh(["release", "create", tag, "-R", options.repo, "--title", `Fairbeam ${options.version}`, "--notes-file", notesPath, options.latest ? "--latest" : "--latest=false"]);
  } else if (notes !== undefined) {
    gh(["release", "edit", tag, "-R", options.repo, "--notes-file", options.notesFile]);
  }
  gh(["release", "upload", tag, "-R", options.repo, "--clobber", ...uploads]);
  console.log(`Published ${downloadBase.replace("/download/", "/tag/")}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
