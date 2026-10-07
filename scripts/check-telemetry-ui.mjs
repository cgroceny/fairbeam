// Optional browser check against an existing dev server; no real usage request or simulation.
// FAIRBEAM_USAGE_URL=http://127.0.0.1:5354 node scripts/check-telemetry-ui.mjs
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
const url = process.env.FAIRBEAM_USAGE_URL;
if (!url) throw new Error("Set FAIRBEAM_USAGE_URL to the running dev server");
const browser = await puppeteer.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--no-sandbox"] });
try {
  for (const lang of ["en", "tr"]) {
    const text = JSON.parse(readFileSync(new URL(`../src/i18n/${lang}.json`, import.meta.url), "utf8"));
    for (const enabled of [false, true]) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1024, height: 768 });
      await page.evaluateOnNewDocument((lang, enabled) => {
        localStorage.setItem("fairbeam.generalSettings", JSON.stringify({ language: lang }));
        window.usageTest = { calls: [], status: JSON.parse(sessionStorage.getItem("usage-choice") || "null") || {
          build_enabled: enabled, env_disabled: false, consent: null, active: false, ask: enabled, endpoint: "https://fairbeam.org/api/ping",
        } };
        window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
          window.usageTest.calls.push({ command, args });
          const state = window.usageTest.status;
          if (command === "telemetry_status") return { ...state };
          if (command === "telemetry_set_consent") {
            state.consent = args.granted ? "granted" : "denied";
            state.active = args.granted; state.ask = false;
            sessionStorage.setItem("usage-choice", JSON.stringify(state));
            return { ...state };
          }
          if (command === "telemetry_reset_id") { window.usageTest.resets = (window.usageTest.resets || 0) + 1; return { ...state }; }
          if (command === "get_general_settings") return { language: lang };
          if (command === "telemetry_preview") return { status: { ...state }, next: state.active ? {
            schema: "fairbeam.ping/3", install_id: "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b", app_version: "0.7.0", os: "linux", arch: "x86_64",
          } : null };
          return null;
        } };
      }, lang, enabled);
      await page.goto(url, { waitUntil: "networkidle0" });
      if (!enabled) {
        assert.equal(await page.$("#usp-title"), null);
        assert.equal(await page.evaluate(() => window.usageTest.calls.some(c => c.command === "telemetry_set_consent")), false);
      } else {
        await page.waitForSelector("#usp-title");
        assert.ok(await page.$eval("#usp-what", el => el.textContent.includes("seven") || el.textContent.includes("yedi")));
        assert.equal(await page.$eval("#usp-title", el => el.closest(".dialog").scrollWidth <= el.closest(".dialog").clientWidth + 1), true);
        await page.evaluate(label => [...document.querySelectorAll(".dialog button")].find(b => b.textContent === label).click(), text["usage.prompt.fullList"]);
        assert.ok(await page.evaluate(() => window.usageTest.calls.some(c => c.command === "open_external_link" && c.args.link === "privacy")));
        await page.screenshot({ path: `/tmp/fairbeam-consent-${lang}.png` });
        await page.keyboard.press("Escape");
        await page.waitForSelector("#usp-title", { hidden: true });
        assert.equal(await page.evaluate(() => window.usageTest.status.consent), "denied");
        await page.reload({ waitUntil: "networkidle0" });
        assert.equal(await page.$("#usp-title"), null, "the answered prompt does not appear again");
      }
      await page.click(`.app-header button[aria-label='${text["settings.title"]}']`);
      await page.waitForSelector(".us-section");
      assert.equal(await page.$eval(".us-choice label:nth-of-type(2) input", el => el.disabled), !enabled);
      if (enabled) {
        const radios = await page.$$(".us-choice input");
        await radios[1].click();
        await page.waitForFunction(() => window.usageTest.status.active);
        await page.evaluate(label => [...document.querySelectorAll(".us-actions button")].find(b => b.textContent === label).click(), text["usage.showPreview"]);
        await page.waitForSelector(".us-json");
        assert.deepEqual(JSON.parse(await page.$eval(".us-json", el => el.textContent)), {
          schema: "fairbeam.ping/3", install_id: "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b", app_version: "0.7.0", os: "linux", arch: "x86_64",
        });
        await page.evaluate(label => [...document.querySelectorAll(".us-choice button")].find(b => b.textContent === label).click(), text["usage.resetId"]);
        await page.waitForFunction(() => window.usageTest.resets === 1);
        await radios[0].click();
        await page.waitForFunction(() => !window.usageTest.status.active);
        assert.ok(!await page.evaluate(() => window.usageTest.calls.some(c => /telemetry_count/.test(c.command))));
        await page.$eval(".us-section", el => el.scrollIntoView({ block: "start" }));
        await page.screenshot({ path: `/tmp/fairbeam-usage-settings-${lang}.png` });
      }
      if (enabled) {
        await page.evaluate(() => sessionStorage.removeItem("usage-choice"));
        await page.reload({ waitUntil: "networkidle0" });
        await page.waitForSelector("#usp-title");
        await page.evaluate(label => [...document.querySelectorAll(".dialog button")].find(b => b.textContent === label).click(), text["usage.prompt.yes"]);
        await page.waitForSelector("#usp-title", { hidden: true });
        assert.equal(await page.evaluate(() => window.usageTest.status.consent), "granted");
        await page.reload({ waitUntil: "networkidle0" });
        assert.equal(await page.$("#usp-title"), null, "Allow is stored too");
      }
      await page.close();
    }
    console.log(`Usage UI ${lang}: disabled build, dismissal once, privacy link, consent, withdrawal, reset and five-field preview passed.`);
  }
} finally { await browser.close(); }
