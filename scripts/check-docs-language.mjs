#!/usr/bin/env node
// Run against a locally served build: FAIRBEAM_DOCS_URL=http://127.0.0.1:5345 npm run check:docs-language
// Optional screenshots: FAIRBEAM_SCREENSHOT_DIR=/tmp/fairbeam-docs-tr
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const base = process.env.FAIRBEAM_DOCS_URL ?? "http://127.0.0.1:5345";
const screenshots = process.env.FAIRBEAM_SCREENSHOT_DIR;
if (screenshots) mkdirSync(screenshots, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "fairbeam-docs-browser-"));
const browser = await puppeteer.launch({ userDataDir: profile, executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.status() >= 400 && response.url().startsWith(base)) errors.push(`${response.status()} ${response.url()}`); });
  for (const width of [1440, 390]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1 });
    for (const theme of ["light", "dark"]) {
      await page.goto(`${base}/docs/tr/`, { waitUntil: "networkidle0" });
      await page.evaluate((value) => localStorage.setItem("fairbeam.theme", value), theme);
      for (const slug of ["getting-started", "designer", "cli"]) {
        await page.goto(`${base}/docs/tr/${slug}.html`, { waitUntil: "networkidle0" });
        const state = await page.evaluate(() => ({
          lang: document.documentElement.lang,
          bodyLang: document.querySelector(".doc-body").lang,
          theme: document.documentElement.dataset.theme,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          current: document.querySelector('.docs-nav [aria-current="page"]').textContent,
          title: document.querySelector("h1").textContent,
          links: [...document.querySelectorAll(".docs-nav a, .doc-pager a")].map((a) => new URL(a.href).pathname),
        }));
        assert.equal(state.lang, "tr");
        assert.equal(state.bodyLang, "tr");
        assert.equal(state.theme, theme);
        assert.equal(state.overflow, false, `${slug}: horizontal overflow at ${width}`);
        assert.ok(state.links.every((path) => path.startsWith("/docs/tr/")));
        assert.ok(state.current && state.title);
        if (screenshots) await page.screenshot({ path: join(screenshots, `${slug}-${width}-${theme}.png`) });
      }
    }
  }
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(`${base}/docs/designer.html?lang=en#files`, { waitUntil: "networkidle0" });
  await page.evaluate(() => localStorage.setItem("fairbeam.generalSettings", JSON.stringify({ language: "en", preserved: "keep" })));
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click('[data-site-language="tr"]')]);
  assert.equal(new URL(page.url()).pathname, "/docs/tr/designer.html");
  assert.equal(new URL(page.url()).hash, "#files");
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("fairbeam.generalSettings"))), { language: "tr", preserved: "keep" });
  await page.goto(`${base}/docs/cli.html`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => location.pathname === "/docs/tr/cli.html" && document.documentElement.lang === "tr");
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click('[data-site-language="en"]')]);
  assert.equal(new URL(page.url()).pathname, "/docs/cli.html");
  assert.equal(await page.$eval(".doc-body", (node) => node.lang), "en");
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("fairbeam.generalSettings"))), { language: "en", preserved: "keep" });

  await page.goto(`${base}/docs/#get-started`, { waitUntil: "networkidle0" });
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click('[data-site-language="tr"]')]);
  assert.equal(new URL(page.url()).hash, "#get-started");
  assert.ok(await page.$("#get-started"));

  // Direct Turkish links and the static page remain readable with JavaScript disabled.
  await page.setJavaScriptEnabled(false);
  await page.goto(`${base}/docs/tr/getting-started.html`, { waitUntil: "networkidle0" });
  assert.equal(await page.$eval("html", (node) => node.lang), "tr");
  assert.match(await page.$eval(".docs-nav", (node) => node.textContent), /Belgeler|Genel bakış/);
  assert.equal(await page.$eval(".doc-body", (node) => node.lang), "tr");
  assert.deepEqual(errors, []);

  // The switch must still work when browser storage is unavailable.
  const blocked = await browser.newPage();
  await blocked.evaluateOnNewDocument(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("Storage unavailable"); } });
    Object.defineProperty(navigator, "languages", { get() { return ["tr-TR"]; } });
  });
  await blocked.goto(`${base}/docs/tr/cli.html`, { waitUntil: "networkidle0" });
  await Promise.all([blocked.waitForNavigation({ waitUntil: "networkidle0" }), blocked.click('[data-site-language="en"]')]);
  assert.equal(new URL(blocked.url()).pathname, "/docs/cli.html");
  assert.equal(await blocked.$eval("html", (node) => node.lang), "en");
  console.log("check-docs-language: 3 pages × 2 widths × 2 themes; language switch, anchors, saved settings, no-JS and unavailable storage OK");
} finally { await browser.close(); rmSync(profile, { recursive: true, force: true }); }
