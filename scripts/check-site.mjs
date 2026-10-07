// Check website translations and bundled-example links. Optional browser checks use a built site.
// FAIRBEAM_SITE_URL=http://127.0.0.1:5342 node --experimental-strip-types scripts/check-site.mjs
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
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
assert.equal(index.length, 20);
assert.match(home, /20 simulated example projects/);
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
