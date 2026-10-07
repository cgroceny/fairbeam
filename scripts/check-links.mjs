#!/usr/bin/env node
// Check relative links in README.md, docs/*.md and the site pages in landing/ (index, features,
// roadmap, docs/, guide, privacy): the target file must exist and a #fragment must name a heading (GitHub slug rules) or an id in the
// target. External links (http, https, mailto) are not fetched. Links inside fenced or inline code
// are ignored. Also a cheap drift guard for the public guide: landing/guide.html is a hand-made copy
// of docs/GETTING-STARTED.md, so every heading of the Markdown guide must be a heading of the page.
// Usage: node scripts/check-links.mjs   (part of npm run check:exports)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const external = /^(https?:|mailto:|tel:|data:)/i;

/** GitHub heading anchors: lower case, punctuation dropped, spaces to hyphens, "-1" for repeats. */
function mdAnchors(text) {
  const seen = new Map();
  const out = new Set();
  let code = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) code = !code;
    if (code) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const plain = m[1].replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "");
    const base = plain.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  for (const m of text.matchAll(/\sid="([^"]+)"/g)) out.add(m[1]);
  return out;
}

const htmlAnchors = (text) => new Set([...text.matchAll(/\s(?:id|name)="([^"]+)"/g)].map((m) => m[1]));

function anchorsOf(file) {
  const text = readFileSync(file, "utf8");
  return file.endsWith(".md") ? mdAnchors(text) : htmlAnchors(text);
}

/** Markdown links outside code: [text](target) and <img src>. */
function mdLinks(text) {
  const links = [];
  let code = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { code = !code; return; }
    if (code) return;
    const bare = line.replace(/`[^`]*`/g, "");
    for (const m of bare.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) links.push([m[1], i + 1]);
    for (const m of bare.matchAll(/\s(?:href|src)="([^"]+)"/g)) links.push([m[1], i + 1]);
  });
  return links;
}

function htmlLinks(text) {
  const links = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\s(?:href|src)="([^"]+)"/g)) links.push([m[1], i + 1]);
  });
  return links;
}

// The landing page is served from site-dist/, which scripts/build-site.mjs assembles from these sources.
const SITE = [
  [/^(?:\.\/)?$/, () => join(root, "landing", "index.html")],
  [/^app\/?$/, () => join(root, "index.html")],
  [/^tokens\.css$/, () => join(root, "design-system", "tokens.css")],
  [/^favicon\.svg$/, () => join(root, "public", "favicon.svg")],
  [/^story\/story\.js$/, () => join(root, "landing-src", "story.js")],
  // landing/media (screenshots) is copied as is; the drawings come from examples/drawings
  [/^media\/(.+)$/, (m) => [join(root, "landing", "media", m[1]), join(root, "examples", "drawings", m[1])].find(existsSync) ?? m[0]],
  [/^fonts\/(.+)$/, (m) => fontTarget(m[1]) ?? m[0]],
];

// Fonts are copied from @fontsource by build-site.mjs (its FONTS list). With dependencies installed the
// source file must exist; in a fresh checkout without node_modules the copy step is what provides them,
// so a link to a font that is on the FONTS list is accepted, and any other font link is still broken.
const FONT_FILES = new Set([...readFileSync(join(root, "scripts", "build-site.mjs"), "utf8").matchAll(/\["ibm-plex-[a-z]+",\s*"([^"]+\.woff2)"\]/g)].map((m) => m[1]));
const PROVIDED = Symbol("provided by the site build");
function fontTarget(name) {
  const pkgs = ["ibm-plex-sans", "ibm-plex-mono"];
  const found = pkgs.map((p) => join(root, "node_modules", "@fontsource", p, "files", name)).find(existsSync);
  if (found) return found;
  const installed = existsSync(join(root, "node_modules", "@fontsource"));
  return !installed && FONT_FILES.has(name) ? PROVIDED : null;
}

function resolveTarget(from, path) {
  const landing = join(root, "landing");
  if (from.startsWith(landing)) {
    // the link as a path from the site root, so pages in subfolders (docs/) resolve like index.html
    const site = relative(landing, resolve(dirname(from), decodeURI(path))).split(sep).join("/");
    if (!site.startsWith("..")) {
      for (const [re, fn] of SITE) {
        const m = re.exec(site);
        if (m) return fn(m);
      }
    }
  }
  return resolve(dirname(from), decodeURI(path));
}

const files = [
  join(root, "README.md"),
  ...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => join(root, "docs", f)),
  ...["index.html", "features.html", "roadmap.html", "docs/index.html", "guide.html", "privacy.html"].map((p) => join(root, "landing", p)),
];

const errors = [];
let checked = 0;
const cache = new Map();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const links = file.endsWith(".md") ? mdLinks(text) : htmlLinks(text);
  for (const [link, line] of links) {
    if (external.test(link) || link.startsWith("/")) continue;
    checked++;
    const [path, frag] = link.split("#", 2);
    const where = `${relative(root, file)}:${line}`;
    const target = path ? resolveTarget(file, path) : file;
    if (target === PROVIDED) continue;
    if (!existsSync(target)) { errors.push(`${where}: missing ${link}`); continue; }
    if (!frag || statSync(target).isDirectory() || !/\.(md|html)$/.test(target)) continue;
    if (!cache.has(target)) cache.set(target, anchorsOf(target));
    if (!cache.get(target).has(decodeURIComponent(frag))) errors.push(`${where}: no anchor #${frag} in ${relative(root, target)}`);
  }
}

// the public guide keeps the Markdown guide's sections (h1-h3, compared as plain text)
{
  const md = readFileSync(join(root, "docs", "GETTING-STARTED.md"), "utf8");
  const html = readFileSync(join(root, "landing", "guide.html"), "utf8");
  const plain = (t) => t.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
  const pageHeadings = new Set([...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/g)].map((m) => plain(m[1])));
  let code = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) code = !code;
    const m = !code && /^#{1,3}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    checked++;
    if (!pageHeadings.has(plain(m[1]))) errors.push(`landing/guide.html: no heading "${plain(m[1])}" (docs/GETTING-STARTED.md has it; update both together)`);
  }
}

if (errors.length) {
  console.error(`check-links: ${errors.length} broken of ${checked} relative links\n  ${errors.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-links: ${checked} relative links in ${files.length} files OK`);
