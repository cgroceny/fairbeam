#!/usr/bin/env node
// Check relative links in README.md, docs/*.md, the other Markdown files the site publishes
// (landing/docs.json), the site pages in landing/ (index, features, roadmap, guide, privacy) and the
// docs pages as scripts/docs-render.mjs renders them for site-dist/docs/: the target file must exist
// and a #fragment must name a heading (GitHub slug rules) or an id in the target. The renderer's own
// problems (a link to a missing file, or to a heading a published page does not have) count as
// broken links too. External links (http, https, mailto) are not fetched. Links inside fenced or
// inline code are ignored.
// Usage: node scripts/check-links.mjs   (part of npm run check:exports)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, renderDocsSite } from "./docs-render.mjs";

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

// The docs pages exist only as build output: render them here, as scripts/build-site.mjs does.
const docs = renderDocsSite(root);
const rendered = new Map(docs.files.map((f) => [f.path, f.html]));
const docImages = new Map(docs.images.map((i) => [i.to, join(root, i.from)]));
/** A link target that is a rendered docs page (it has no file of its own to check). */
const page = (path) => ({ page: path });

// The site is served from site-dist/, which scripts/build-site.mjs assembles from these sources.
const SITE = [
  [/^(?:\.\/)?$/, () => join(root, "landing", "index.html")],
  [/^app\/?$/, () => join(root, "index.html")],
  [/^tokens\.css$/, () => join(root, "design-system", "tokens.css")],
  [/^favicon\.svg$/, () => join(root, "public", "favicon.svg")],
  [/^story\/story\.js$/, () => join(root, "landing-src", "story.js")],
  [/^docs\/?$|^docs\/index\.html$/, () => page("docs/index.html")],
  [/^docs\/img\/(.+)$/, (m) => docImages.get(m[0]) ?? m[0]],
  [/^docs\/([^/]+\.html)$/, (m) => (rendered.has(m[0]) ? page(m[0]) : m[0])],
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

const { pages: published } = loadManifest(root);
const markdown = [
  join(root, "README.md"),
  ...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => join(root, "docs", f)),
  ...published.map((p) => join(root, p.source)),
];
const files = [
  ...new Set(markdown),
  ...["index.html", "features.html", "roadmap.html", "guide.html", "privacy.html"].map((p) => join(root, "landing", p)),
];
// the rendered docs pages, checked as if they were landing/docs/<page>.html
const sources = [
  ...files.map((file) => ({ file, text: readFileSync(file, "utf8") })),
  ...docs.files.map((f) => ({ file: join(root, "landing", ...f.path.split("/")), text: f.html, label: `site-dist/${f.path}`, self: page(f.path) })),
];

const errors = docs.problems.map((p) => `${p} (scripts/docs-render.mjs)`);
let checked = 0;
const cache = new Map();
for (const { file, text, label, self } of sources) {
  const links = file.endsWith(".md") ? mdLinks(text) : htmlLinks(text);
  for (const [link, line] of links) {
    if (external.test(link) || link.startsWith("/")) continue;
    checked++;
    const [pathWithQuery, frag] = link.split("#", 2);
    const path = pathWithQuery.split("?", 1)[0];
    const where = `${label ?? relative(root, file)}:${line}`;
    const target = path ? resolveTarget(file, path) : (self ?? file);
    if (target === PROVIDED) continue;
    if (typeof target === "object") {
      if (!rendered.has(target.page)) { errors.push(`${where}: missing ${link}`); continue; }
      if (!frag) continue;
      const key = `rendered:${target.page}`;
      if (!cache.has(key)) cache.set(key, htmlAnchors(rendered.get(target.page)));
      if (!cache.get(key).has(decodeURIComponent(frag))) errors.push(`${where}: no anchor #${frag} in site-dist/${target.page}`);
      continue;
    }
    if (!existsSync(target)) { errors.push(`${where}: missing ${link}`); continue; }
    if (!frag || statSync(target).isDirectory() || !/\.(md|html)$/.test(target)) continue;
    if (!cache.has(target)) cache.set(target, anchorsOf(target));
    if (!cache.get(target).has(decodeURIComponent(frag))) errors.push(`${where}: no anchor #${frag} in ${relative(root, target)}`);
  }
}

if (errors.length) {
  console.error(`check-links: ${errors.length} broken of ${checked} relative links\n  ${errors.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-links: ${checked} relative links in ${files.length} files and ${docs.files.length} rendered docs pages OK`);
