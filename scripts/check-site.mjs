// Check website translations and bundled-example links. Optional browser checks use a built site.
// FAIRBEAM_SITE_URL=http://127.0.0.1:5342 node --experimental-strip-types scripts/check-site.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { renderDocsSite } from "./docs-render.mjs";
import { isExternalSiteLink, externalLinksInHtml } from "./site-links.mjs";
import { renderRoadmap } from "./roadmap-render.mjs";
import { linkedExample } from "../src/runner/examples.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const language = read("landing/language.js");
const context = {};
runInNewContext(`${language.slice(0, language.indexOf("  const TEXT ="))}\n globalThis.tables = [...pairs, ...roadmapPairs];\n})();`, context);
runInNewContext(`${language.slice(language.indexOf("  const ATTRIBUTE_TEXT ="), language.indexOf("  function normalize("))}
  globalThis.tables.push(...ATTRIBUTE_TEXT, ...META_TEXT);`, context);
const normalize = (text) => text.replace(/\s+/gu, " ").trim();
const translations = new Map();
for (const [en, tr] of context.tables) {
  assert.ok(en && tr, "both languages have text");
  assert.ok(!/noter onay|macOS'ta|Smith grafiği|yığılmış/.test(tr), `Turkish terminology: ${en}`);
  // Turkish running text uses the decimal comma; licence names (GPL-3.0) and versions (0.7.0) keep their points.
  assert.ok(!/\d\.\d/.test(tr.replace(/[A-Z]+-\d+\.\d+(?:-or-later)?|\d+\.\d+\.\d+/g, "")), `Turkish decimal comma: ${en}`);
  const key = normalize(en);
  if (translations.has(key)) assert.equal(tr, translations.get(key), `consistent translation for ${en}`);
  translations.set(key, tr);
}
assert.equal(translations.get("The macOS app is signed with a Developer ID and notarized by Apple."),
  "macOS uygulaması Developer ID ile imzalanmış ve Apple tarafından doğrulanmıştır.");
const index = JSON.parse(read("public/projects/index.json")).projects;
const home = read("landing/index.html");
// Public claims must retain release status, data flows and numerical scope in both languages.
const privacy = read("landing/privacy.html");
assert.match(privacy, /src="language\.js"/);
assert.match(privacy, /data-site-language="tr"/);
assert.match(privacy, /Fairbeam 0\.7\.2 asks once/);
for (const required of ["GitHub (fairbeam-releases)", "upstream hosts", "Vercel", "IP address", "hosting provider", "controller", "retention", "rights", "transfer", "ismail@fairbeam.org", "random install ID", "weekly", "salt", "Reset ID", "GDPR", "seven days", "No raw event log"]) {
  assert.ok(privacy.toLowerCase().includes(required.toLowerCase()), `privacy disclosure: ${required}`);
}
for (const match of privacy.matchAll(/<(?:p|h1|h2|td|th)\b[^>]*>([^<]+)<\//g)) {
  const text = normalize(match[1].replaceAll("&amp;", "&"));
  assert.ok(translations.has(text), `privacy translation: ${text}`);
}
const features = read("landing/features.html");
assert.match(features, /above −30 dB agree within 0\.1 dB/);
assert.match(features, /same-timestep Windows CPU \/ macOS Metal/);
assert.ok([...translations.values()].some((tr) => tr.includes("−30 dB") && tr.includes("0,004 dB")));
const meshClaim = features.match(/<p>(Auto mode picks.*?)<\/p>/)[1];
assert.match(translations.get(meshClaim), /dipol ve yama.*rezonans.*%0,1/);
// the counts on the pages follow the shipped examples
assert.ok(home.includes(`opens ${index.length} simulated example projects`), `home page says ${index.length} examples`);
for (const page of [home, features]) {
  assert.ok(page.includes(`Open all ${index.length} examples in the demo`), `demo link says ${index.length} examples`);
  assert.ok(page.includes(`${index.length} simulated projects come with the app`), `example description says ${index.length} projects`);
}
for (const suffix of ["", " Six of them:"]) {
  const description = `${index.length} simulated projects come with the app and are listed in the browser demo.${suffix}`;
  assert.ok(translations.get(description)?.includes(`simülasyonu yapılmış ${index.length} proje`), `Turkish example description says ${index.length} projects`);
}
const roadmap = read("landing/roadmap.json");
assert.doesNotMatch(roadmap, /interrupted downloads resume|No lost work|same results|half the time|4 to 64 times/);
assert.match(roadmap, /partial downloads restart/);
const renderedRoadmap = renderRoadmap(JSON.parse(roadmap));
assert.match(renderedRoadmap, /Availability refers to the stated release; future plans may change/);
assert.doesNotMatch(renderedRoadmap, /class="rm-refs"/);
assert.match(roadmap, /unless you select Delete the application data; workspaces remain/);
const cards = [...home.matchAll(/<a class="example-card" href="(app\/\?example=([^"]+))">([\s\S]*?)<\/a>/g)];
assert.equal(cards.length, 3);
const ids = ["pyramidal-horn", "helix-axial", "wilkinson-divider"];
assert.deepEqual(cards.map((card) => card[2]), ids);
for (const [, href, id, html] of cards) {
  assert.ok(html.includes(`<img src="media/ex-${id}.jpg"`), "card retains its image");
  assert.equal(linkedExample(index, new URL(href, "https://fairbeam.org/").search)?.file, `${id}.json`);
}
for (const id of ids) assert.equal(linkedExample(index, `?example=${id}&other=1`)?.file, `${id}.json`);
for (const search of ["", "?example=", "?example=unknown", "?example=../dipole", "?example=dipole.json", "?project=dipole"]) {
  assert.equal(linkedExample(index, search), undefined, `ignore invalid link ${search}`);
}
assert.equal(linkedExample([...index, { file: "private.json" }], "?example=private"), undefined);
assert.equal(linkedExample([], "?example=dipole"), undefined);
// Distinguish runs of the same model by their bundled filename.
assert.equal(linkedExample(index, "?example=sierpinski-monopole--iterations-3")?.file, "sierpinski-monopole--iterations-3.json");
assert.match(read("src/App.tsx"), /DEMO \? linkedExample\(list, window.location.search\) : undefined/);
assert.match(read("scripts/build-site.mjs"), /"import.meta.env.VITE_FAIRBEAM_DEMO": JSON.stringify\("1"\)/);
const featureLinks = [...read("landing/features.html").matchAll(/href="app\/\?example=([^"]+)"/g)];
assert.equal(featureLinks.length, 6);
for (const [, id] of featureLinks) assert.equal(linkedExample(index, `?example=${id}`)?.file, `${id}.json`);
// Check source pages and every generated documentation and roadmap link before building.
function checkExternalLinks(html, where, language = "en") {
  let count = 0;
  for (const [, attributes, text] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attributes.match(/\bhref=["']([^"']*)["']/i)?.[1];
    if (!href || !isExternalSiteLink(href)) continue;
    count++;
    assert.match(attributes, /\btarget="_blank"/, `${where}: target for ${href}`);
    const rel = attributes.match(/\brel="([^"]*)"/)?.[1].split(/\s+/) ?? [];
    for (const token of ["noopener", "noreferrer"]) assert.ok(rel.includes(token), `${where}: ${token} for ${href}`);
    assert.ok(text.includes(language === "tr" ? "(yeni sekmede açılır)" : "(opens in a new tab)"), `${where}: accessible hint for ${href}`);
  }
  return count;
}
for (const href of ["https://github.com/example", "http://openems.de", "//example.org/page", "https://fairbeam.org.example.org", "https://example.org/file.dmg", "https://github.com/repo/blob/main/NOTICE.md"]) {
  assert.equal(isExternalSiteLink(href), true, href);
}
for (const href of ["https://fairbeam.org/docs/", "https://www.fairbeam.org/app/", "//fairbeam.org/docs/", "#anchor", "/docs/", "app/", "../guide.html", "mailto:ismail@fairbeam.org"]) {
  assert.equal(isExternalSiteLink(href), false, href);
  const link = `<a href="${href}">Local</a>`;
  assert.equal(externalLinksInHtml(link), link, "same-site and email links stay unchanged");
}
const authorLink = externalLinksInHtml('<a href="https://example.org" rel="author">Author</a>');
assert.match(authorLink, /rel="author noopener noreferrer"/);
assert.equal(externalLinksInHtml(authorLink), authorLink, "processing does not duplicate hints");
// Exercise rewriting and hint placement through the actual Markdown renderer.
const fixture = mkdtempSync(join(tmpdir(), "fairbeam-site-links-"));
try {
  mkdirSync(join(fixture, "landing"));
  mkdirSync(join(fixture, "landing-src"));
  writeFileSync(join(fixture, "landing/docs.json"), JSON.stringify({
    site: "https://fairbeam.org", repo: "https://github.com/example/project", branch: "main",
    groups: [{ title: "Reference", pages: [{ source: "sample.md", slug: "sample", title: "Sample", description: "Sample" }] }],
  }));
  writeFileSync(join(fixture, "landing-src/docs-page.html"), read("landing-src/docs-page.html"));
  writeFileSync(join(fixture, "landing/language.js"), language);
  writeFileSync(join(fixture, "NOTICE.md"), "Notice");
  writeFileSync(join(fixture, "sample.md"), `# Sample

## [External heading](https://example.org)

## Second heading

## Third heading

[Published](sample.md#external-heading) [Repository notice](NOTICE.md)
[Local](https://fairbeam.org/app/) [Email](mailto:example@example.org)
[Formatted **label**](https://example.org/page?a=1&b=2 "Title")
<https://example.org/auto>
<a href="//example.org/raw" rel="author">Raw HTML</a>
`);
  const rendered = renderDocsSite(fixture);
  assert.deepEqual(rendered.problems, []);
  for (const file of rendered.files.filter((file) => file.path.endsWith("sample.html"))) {
    checkExternalLinks(file.html, file.path, file.path.startsWith("docs/tr/") ? "tr" : "en");
    assert.match(file.html, /id="external-heading"/, "hints do not change heading IDs");
    assert.match(file.html, /href="sample.html#external-heading">Published<\/a>/);
    assert.match(file.html, /href="https:\/\/fairbeam.org\/app\/">Local<\/a>/);
    assert.match(file.html, /href="mailto:example@example.org">Email<\/a>/);
    assert.match(file.html, /title="Title"[^>]*>Formatted <strong>label<\/strong>/);
    assert.match(file.html, /rel="author noopener noreferrer"/);
    const toc = file.html.match(/<ol class="doc-toc-list"[^>]*>([\s\S]*?)<\/ol>/)[1];
    assert.ok(!toc.includes("opens in a new tab") && !toc.includes("yeni sekmede açılır"), "internal contents links have no new-tab hint");
  }
} finally { rmSync(fixture, { recursive: true, force: true }); }
let externalCount = 0;
for (const name of readdirSync(new URL("../landing/", import.meta.url)).filter((name) => name.endsWith(".html"))) {
  externalCount += checkExternalLinks(read(`landing/${name}`), `landing/${name}`);
}
externalCount += checkExternalLinks(read("landing-src/docs-page.html"), "docs template");
externalCount += checkExternalLinks(renderedRoadmap, "roadmap board");
const docs = renderDocsSite(fileURLToPath(new URL("../", import.meta.url)));
assert.deepEqual(docs.problems, [], "docs render successfully");
for (const file of docs.files) externalCount += checkExternalLinks(file.html, file.path, file.path.startsWith("docs/tr/") ? "tr" : "en");
assert.ok(externalCount > 0, "checked external links");
console.log(`site external-link checks passed: ${externalCount} links across sources and generated pages`);

console.log(`site checks passed: ${translations.size} translation keys, 3 cards, 6 feature links, valid and unknown demo links`);

if (process.env.FAIRBEAM_SITE_URL) {
  const { default: puppeteer } = await import("puppeteer-core");
  const base = process.env.FAIRBEAM_SITE_URL;
  const output = process.env.FAIRBEAM_SITE_SCREENSHOTS ?? "/tmp/fairbeam-site-screenshots";
  mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true, userDataDir: `${output}/chrome-profile`, args: ["--no-first-run", "--no-default-browser-check"] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Start with another preference and verify language switching preserves the whole record.
    await page.evaluateOnNewDocument(() => {
      if (!localStorage.getItem("fairbeam.generalSettings")) localStorage.setItem("fairbeam.generalSettings", JSON.stringify({ language: "en", decimals: "point" }));
    });
    for (const [size, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]]) {
      await page.setViewport({ width, height, isMobile: size === "mobile", deviceScaleFactor: 1 });
      for (const lang of ["en", "tr"]) {
        for (const [name, path] of [["home", ""], ["features", "features.html"], ["roadmap", "roadmap.html"], ["docs", "docs/"], ["guide", "docs/getting-started.html"]]) {
          await page.goto(new URL(path, base).href, { waitUntil: "networkidle0" });
          const settings = await page.evaluate(() => JSON.parse(localStorage.getItem("fairbeam.generalSettings")));
          await page.evaluate((lang) => window.fairbeamSiteLanguage.setLanguage(lang), lang);
          await page.evaluate(() => document.fonts.ready);
          await page.waitForFunction((lang) => document.documentElement.lang === lang, {}, lang);
          await page.evaluate(() => document.querySelectorAll("img").forEach((img) => { img.loading = "eager"; }));
          await page.waitForFunction(() => [...document.images].every((img) => img.complete && img.naturalWidth > 0));
          assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("fairbeam.generalSettings"))), { ...settings, language: lang });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} ${lang} ${size} fits viewport`);
          await page.screenshot({ path: `${output}/${name}-${lang}-${size}.png`, fullPage: true });
          console.log(`captured ${lang} ${size}: ${name}`);
          if (name === "home") {
            await page.$eval("#examples", (element) => element.scrollIntoView({ behavior: "instant" }));
            await page.waitForFunction(() => [...document.querySelectorAll(".example-card img")].every((img) => img.complete && img.naturalWidth > 0));
            await page.screenshot({ path: `${output}/examples-${lang}-${size}.png` });
            const text = await page.$eval("#download", (element) => element.textContent);
            assert.ok(text.includes(lang === "tr" ? "Apple tarafından doğrulanmıştır" : "notarized by Apple"));
          }
        }
        // Click each actual card; a prior loaded example must not override the URL request.
        for (const id of ids) {
          await page.goto(base, { waitUntil: "networkidle0" });
          await page.evaluate((lang) => window.fairbeamSiteLanguage.setLanguage(lang), lang);
          await page.$eval(`.example-card[href="app/?example=${id}"]`, (element) => element.scrollIntoView({ behavior: "instant" }));
          await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click(`.example-card[href="app/?example=${id}"]`)]);
          const entry = index.find((entry) => entry.file === `${id}.json`);
          await page.waitForFunction((name) => document.title === `${name} — Fairbeam`, { timeout: 60000 }, entry.name);
          assert.equal(new URL(page.url()).searchParams.get("example"), id);
          await page.waitForFunction(() => !!document.querySelector("canvas"));
          assert.equal(await page.$(".mode-switch"), null, "read-only demo has no designer navigation");
          assert.equal(await page.$eval(".meta-id", (element) => element.textContent), id, "loaded bundle has the requested model");
          await page.screenshot({ path: `${output}/demo-${id}-${lang}-${size}.png` });
          console.log(`clicked ${lang} ${size}: ${id} → ${await page.title()}`);
        }
      }
    }
    // Unknown IDs leave the normal remembered-example fallback in place.
    await page.goto(new URL("app/?example=unknown", base).href, { waitUntil: "networkidle0" });
    await page.waitForFunction((name) => document.title === `${name} — Fairbeam`, {}, index.find((entry) => entry.file === "wilkinson-divider.json").name);
    assert.deepEqual(errors, [], "no browser runtime errors");
    console.log(`browser site checks passed; screenshots: ${output}`);
  } finally { await browser.close(); }
}
