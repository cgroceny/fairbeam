#!/usr/bin/env node
// Keep published translations complete and code examples identical to their English sources.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";
import { loadManifest, renderDocsSite, translationSource } from "./docs-render.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function structure(text) {
  const headings = [], code = [], tables = [];
  const marked = new Marked({ walkTokens(token) {
    if (token.type === "heading") headings.push(token.depth);
    if (token.type === "table") tables.push({ columns: token.header.length, rows: token.rows.length });
    if (token.type === "code") code.push({ lang: token.lang ?? "", text: token.text });
  } });
  marked.parse(text);
  return { headings, code, tables };
}
const { pages, manifest, problems } = loadManifest(root);
assert.deepEqual(problems, []);
for (const group of manifest.groups) assert.ok(group.titleTr, `${group.title}: missing Turkish title`);
for (const page of pages) {
  assert.ok(page.titleTr, `${page.source}: missing Turkish title`);
  const source = translationSource(page.source);
  assert.ok(existsSync(join(root, source)), `${source}: missing translation`);
  assert.deepEqual(structure(readFileSync(join(root, source), "utf8")),
    structure(readFileSync(join(root, page.source), "utf8")), `${source}: headings, tables or code examples differ`);
}
// Confirm the guard detects a changed command even if the heading count still matches.
assert.notDeepEqual(structure('# Heading\n\n```sh\ncommand --one\n```'), structure('# Başlık\n\n```sh\ncommand --two\n```'));

const fixture = mkdtempSync(join(tmpdir(), "fairbeam-docs-tr-"));
try {
  for (const dir of ["landing", "landing-src", "docs/tr"]) mkdirSync(join(fixture, dir), { recursive: true });
  for (const path of ["landing/language.js", "landing-src/docs-page.html"]) writeFileSync(join(fixture, path), readFileSync(join(root, path)));
  writeFileSync(join(fixture, "landing/docs.json"), JSON.stringify({ site: "https://example.org", repo: "https://example.org/repo", branch: "main", groups: [{ title: "Reference", titleTr: "Başvuru", pages: [
    { source: "docs/ONE.md", slug: "one", title: "One", titleTr: "Bir", description: "One" },
    { source: "docs/TWO.md", slug: "two", title: "Two", titleTr: "İki", description: "Two" },
  ] }] }));
  writeFileSync(join(fixture, "docs/ONE.md"), '# One\n\n## First section\n\n[Next](TWO.md#second-section)\n\n[Self](#first-section)\n');
  writeFileSync(join(fixture, "docs/tr/ONE.md"), '# Bir\n\n## İlk bölüm\n\n[Sonraki](TWO.md#second-section)\n\n[Kendisi](#first-section)\n');
  writeFileSync(join(fixture, "docs/TWO.md"), '# Two\n\n## Second section\n\nEnglish fallback.\n');
  const result = renderDocsSite(fixture);
  assert.deepEqual(result.problems, []);
  assert.equal(result.files.length, 6);
  const html = result.files.find((f) => f.path === "docs/tr/one.html").html;
  assert.match(html, /<html lang="tr" data-doc-language="tr">/);
  assert.match(html, /localStorage.getItem\("fairbeam.theme"\)/);
  assert.doesNotMatch(html, /<script>[^<]*&quot;/);
  assert.match(html, /data-site-language="tr"[^>]*aria-pressed="true"/);
  assert.match(html, /id="first-section">İlk bölüm/);
  assert.match(html, /href="two.html#second-section"/);
  assert.match(html, /href="..\/..\/language.js"|src="..\/..\/language.js"/);
  assert.match(html, /hreflang="en" href="https:\/\/example.org\/docs\/one.html"/);
  assert.match(html, /hreflang="tr" href="https:\/\/example.org\/docs\/tr\/one.html"/);
  assert.match(html, /edit\/main\/docs\/tr\/ONE.md/);
  const fallback = result.files.find((f) => f.path === "docs/tr/two.html").html;
  assert.match(fallback, /Bu sayfanın Türkçe çevirisi henüz yok/);
  assert.match(fallback, /<article class="doc-body" lang="en"/);
  assert.match(fallback, /English fallback/);
  const overview = result.files.find((f) => f.path === "docs/tr/index.html").html;
  assert.match(overview, />Başvuru</);
  assert.match(overview, /id="reference"/);
  assert.match(overview, /href="two.html"/);
  writeFileSync(join(fixture, "docs/tr/ONE.md"), '# Bir\n\n## İlk bölüm\n\n```sh\nchanged-command\n```\n');
  assert.ok(renderDocsSite(fixture).problems.some((problem) => problem.includes("code examples differ")));
  writeFileSync(join(fixture, "docs/tr/ONE.md"), '# Bir\n\n### İlk bölüm\n');
  assert.ok(renderDocsSite(fixture).problems.some((problem) => problem.includes("heading structure differs")));
} finally { rmSync(fixture, { recursive: true, force: true }); }
console.log(`check-docs-translations: ${pages.length} translations preserve headings and code; localized routes, metadata and fallback OK`);
