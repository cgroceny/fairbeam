#!/usr/bin/env node
// Focused browser check against a locally served site build.
// FAIRBEAM_SITE_URL=http://127.0.0.1:5355 node scripts/check-site-links-browser.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const base = process.env.FAIRBEAM_SITE_URL ?? "http://127.0.0.1:5355";
const output = process.env.FAIRBEAM_SITE_SCREENSHOTS ?? "/tmp/fairbeam-site-links";
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "fairbeam-site-links-browser-"));
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true, userDataDir: profile, args: ["--no-first-run", "--no-default-browser-check"] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [1440, 390]) {
    await page.setViewport({ width, height: 900 });
    for (const language of ["en", "tr"]) {
      for (const path of ["", "features.html", "privacy.html", "roadmap.html", "docs/", "docs/getting-started.html", "docs/from-source.html", "docs/designer.html", "docs/cli.html"]) {
        await page.goto(new URL(`${path}?lang=${language}`, base).href, { waitUntil: "load" });
        await page.waitForFunction((language) => document.documentElement.lang === language, {}, language);
        const problems = await page.evaluate((language) => {
          const problems = [];
          for (const link of document.querySelectorAll("a[href]")) {
            const raw = link.getAttribute("href");
            const external = /^(?:https?:)?\/\//i.test(raw) && !["fairbeam.org", "www.fairbeam.org"].includes(new URL(raw, location.href).hostname);
            const hint = link.querySelector('.visually-hidden[data-i18n="on"]');
            if (external) {
              if (link.target !== "_blank" || !link.relList.contains("noopener") || !link.relList.contains("noreferrer")) problems.push(raw);
              if (hint?.textContent.trim() !== (language === "tr" ? "(yeni sekmede açılır)" : "(opens in a new tab)")) problems.push(`hint: ${raw}`);
              if (hint && (hint.getBoundingClientRect().width > 1 || getComputedStyle(hint).position !== "absolute")) problems.push(`visible hint: ${raw}`);
            } else if (link.target === "_blank" || hint) problems.push(`internal link: ${raw}`);
          }
          if (document.documentElement.scrollWidth > innerWidth + 1) problems.push("horizontal overflow");
          return problems;
        }, language);
        assert.deepEqual(problems, [], `${path || "home"} ${language} ${width}`);
        if (path === "" || path === "docs/getting-started.html") {
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({ path: join(output, `${path ? "docs" : "home"}-${language}-${width}.png`) });
        }
      }
    }
  }
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(base, { waitUntil: "load" });
  const original = page.url();
  // Use a local destination for the click probe to avoid depending on an external service.
  // The source link's target and relationship attributes remain unchanged.
  await page.$eval(".nav-github", (link) => { link.href = "features.html?new-tab-probe"; });
  const popupTarget = browser.waitForTarget((target) => target.url().includes("new-tab-probe"));
  await page.click(".nav-github");
  const popup = await (await popupTarget).page();
  await popup.waitForFunction(() => document.readyState === "complete");
  assert.equal(await popup.evaluate(() => window.opener), null, "new tab has no opener");
  assert.equal(page.url(), original, "current page stays available");
  await popup.close();
  await Promise.all([page.waitForNavigation(), page.click('a[href="features.html"]')]);
  assert.equal(new URL(page.url()).pathname, "/features.html", "same-site link navigates in the current tab");
  assert.deepEqual(errors, [], "no browser errors");
  console.log(`site links browser checks passed: EN/TR, desktop/mobile, hidden hints, new tab without opener, same-tab navigation; screenshots: ${output}`);
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
