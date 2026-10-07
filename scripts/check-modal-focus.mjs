// Browser regression for the shared modal focus lifecycle. It starts the normal temporary app
// stack, but never creates or runs a simulation and never writes to the checkout's project files.
//   node scripts/check-modal-focus.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chromePath, startStack } from "./scenarios/stack.mjs";

const require = createRequire(import.meta.url);
const puppeteerModule = process.env.FAIRBEAM_PUPPETEER
  ? await import(pathToFileURL(process.env.FAIRBEAM_PUPPETEER).href)
  : await import(pathToFileURL(require.resolve("puppeteer-core")).href);
const puppeteer = puppeteerModule.default ?? puppeteerModule;
let stack;
let browser;

// Source contracts first (no browser): a resource read inside a dialog must not suspend the region
// that hosts the dialog. The Run, Sweep and Optimize dialogs live in the ribbon; PreflightNote's
// pending check swapped the whole ribbon for its loading placeholder, which detached the opener.
{
  const { readFileSync } = await import("node:fs");
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const note = read("src/designer/PreflightNote.tsx");
  assert.match(note, /createResource/, "PreflightNote asks the server with a resource");
  assert.match(note, /return \(\s*<Suspense>[\s\S]*pre\(\)[\s\S]*<\/Suspense>\s*\);/, "PreflightNote has its own Suspense boundary around the resource read");
  assert.match(read("src/designer/DesignWorkspace.tsx"), /<Show when=\{sweepDialogOpen\(\)\}><Suspense><SweepDialog \/><\/Suspense><\/Show>/, "the lazily loaded Sweep dialog has its own boundary");
}

const isFocused = (page, selector) => page.$eval(selector, (el) => document.activeElement === el);
const inDialog = (page, selector) => page.$eval(selector, (el) => el.contains(document.activeElement));
const moveFocusOutside = (page, selector) => page.$eval(selector, (el) => {
  for (let node = el; node; node = node.parentElement) node.removeAttribute("inert");
  el.focus();
});

try {
  stack = await startStack({ log: (message) => console.log(message), niceSolver: false });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(), args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (error) => console.error("browser page error:", error.message));
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(30000);
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("fairbeam.generalSettings", JSON.stringify({ language: "en" }));
  });
  const threeRequests = [];
  const viewportRequests = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname.toLowerCase();
    if (path.includes("/three")) threeRequests.push(request.url());
    if (path.includes("/scene/viewport.tsx")) viewportRequests.push(request.url());
  });
  await page.goto(stack.url, { waitUntil: "domcontentloaded" });
  // the first load of a cold Vite server optimizes its dependencies: allow it longer than one step
  await page.waitForSelector(".app-header button[aria-label='General settings']", { timeout: 90000 });
  await page.waitForSelector("main.home");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(threeRequests.length, 0, "the Start screen does not request three.js before opening the 3D viewer");

  const aboutOpener = ".app-header button[aria-label='About Fairbeam']";
  const settingsOpener = ".app-header button[aria-label='General settings']";
  const about = ".dialog[aria-labelledby='about-title']";
  const settings = ".dialog[aria-labelledby='gs-title']";
  const preserved = await page.$eval(".app-header .brand", (el) => {
    el.setAttribute("inert", "preserved-value");
    return el.getAttribute("inert");
  });

  for (let cycle = 0; cycle < 2; cycle++) {
    await page.click(aboutOpener);
    await page.waitForSelector(about);
    assert.equal(await inDialog(page, about), true, "About takes focus every time it opens");
    await page.evaluate(() => {
      const brand = document.querySelector(".app-header .brand");
      const headerActions = document.querySelector(".app-header .header-actions");
      if (headerActions) headerActions.removeAttribute("inert");
      document.querySelector(".app-header button[aria-label='General settings']")?.focus();
      return brand?.getAttribute("inert");
    });
    assert.equal(await inDialog(page, about), true, "focus moved outside About is redirected back inside");

    const first = `${about} .dialog-head button`;
    const last = `${about} .gs-body p:last-of-type a[href]:last-of-type`;
    await page.$eval(first, (el) => el.focus());
    await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    await page.keyboard.up("Shift");
    assert.equal(await isFocused(page, last), true, "Shift+Tab wraps from the first About control");
    await page.keyboard.press("Tab");
    assert.equal(await isFocused(page, first), true, "Tab wraps from the last About control");
    await page.keyboard.press("Escape");
    await page.waitForSelector(about, { hidden: true });
    assert.equal(await isFocused(page, aboutOpener), true, "Escape returns focus to the About opener");
  }
  assert.equal(await page.$eval(".app-header .brand", (el) => el.getAttribute("inert")), preserved,
    "closing the modal restores the background's original inert attribute");

  await page.click(settingsOpener);
  await page.waitForSelector(settings);
  assert.equal(await inDialog(page, settings), true, "Settings takes focus when its always-mounted component opens");
  await page.keyboard.press("Escape");
  await page.waitForSelector(settings, { hidden: true });
  assert.equal(await isFocused(page, settingsOpener), true, "closing Settings returns focus to its opener");

  const fixtureRoot = await page.evaluate(() => {
    const root = document.createElement("div");
    root.id = "modal-focus-fixture-root";
    document.body.append(root);
    return root.id;
  });
  await page.evaluate(async (id) => {
    const root = document.getElementById(id);
    const { mountModalFocusFixture } = await import("/scripts/fixtures/modal-focus.tsx");
    (window).__disposeModalFocusFixture = mountModalFocusFixture(root);
  }, fixtureRoot);
  const launcher = "#modal-fixture-launcher";
  const outer = "#modal-fixture-outer";
  const inner = "#modal-fixture-inner";
  const innerOpener = "#modal-fixture-open-inner";

  await page.click(launcher);
  await page.waitForSelector(outer);
  assert.equal(await isFocused(page, "#modal-fixture-outer-first"), true, "outer modal uses its initial-focus target");
  assert.equal(await page.$eval("#root", (el) => el.hasAttribute("inert")), true, "the application background is inert");

  await page.click(innerOpener);
  await page.waitForSelector(inner);
  assert.equal(await isFocused(page, "#modal-fixture-inner-first"), true, "nested modal becomes the active focus layer");
  await page.click("#modal-fixture-inner-handle-escape");
  await page.keyboard.press("Escape");
  assert.equal(await page.$(inner) !== null, true, "a child widget can consume Escape before the modal handler");
  await page.keyboard.press("Escape");
  await page.waitForSelector(inner, { hidden: true });
  assert.equal(await page.$(outer) !== null, true, "Escape closes only the top nested modal");
  assert.equal(await isFocused(page, innerOpener), true, "nested modal restores focus to its opener");

  await page.click(innerOpener);
  await page.waitForSelector(inner);
  await moveFocusOutside(page, launcher);
  assert.equal(await isFocused(page, "#modal-fixture-inner-first"), true, "a programmatic outside focus move cannot escape the top modal");
  await page.$eval("#modal-fixture-inner-last", (el) => el.focus());
  await page.keyboard.press("Tab");
  assert.equal(await isFocused(page, "#modal-fixture-inner-first"), true, "the nested modal wraps forward focus");
  await page.keyboard.press("Escape");
  await page.waitForSelector(inner, { hidden: true });
  assert.equal(await isFocused(page, innerOpener), true, "nested focus returns after an outside focus attempt");
  await page.keyboard.press("Escape");
  await page.waitForSelector(outer, { hidden: true });
  assert.equal(await isFocused(page, launcher), true, "outer modal returns focus to its launcher");

  await moveFocusOutside(page, launcher);
  assert.equal(await isFocused(page, launcher), true, "modal listeners are removed after the last modal closes");

  // a scrolling body without controls is a keyboard stop in Chromium: Tab continues after it
  await page.click("#modal-fixture-scroll-launcher");
  await page.waitForSelector("#modal-fixture-scroll");
  const activeId = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  await page.$eval("#modal-fixture-scroll-body", (el) => { el.tabIndex = -1; el.focus(); el.removeAttribute("tabindex"); });
  await page.keyboard.press("Tab");
  assert.equal(await activeId(), "modal-fixture-scroll-done", "Tab from the scrolling body goes on to the next control (Done), not back to the first");
  await page.$eval("#modal-fixture-scroll-body", (el) => { el.tabIndex = -1; el.focus(); el.removeAttribute("tabindex"); });
  await page.keyboard.down("Shift"); await page.keyboard.press("Tab"); await page.keyboard.up("Shift");
  assert.equal(await activeId(), "modal-fixture-scroll-close", "Shift+Tab from the scrolling body goes to the control before it");
  await page.keyboard.press("Tab");
  if (await activeId() === "modal-fixture-scroll-body") await page.keyboard.press("Tab");
  assert.equal(await activeId(), "modal-fixture-scroll-done", "Close, (list), Done");
  await page.keyboard.press("Tab");
  assert.equal(await activeId(), "modal-fixture-scroll-close", "Done wraps to Close");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#modal-fixture-scroll", { hidden: true });
  assert.equal(await isFocused(page, "#modal-fixture-scroll-launcher"), true, "the scroll fixture returns focus to its launcher");

  // the opener's region re-renders while its dialog opens: focus returns to the same command, found again
  await page.click("#modal-fixture-region button");
  await page.waitForSelector("#modal-fixture-rerendered");
  assert.equal(await isFocused(page, "#modal-fixture-rerendered-first"), true, "the dialog takes focus although its opener was replaced");
  assert.equal(await page.$eval("#modal-fixture-region button", (el) => el.dataset.version), "2", "the opener node was re-created");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#modal-fixture-rerendered", { hidden: true });
  assert.equal(await isFocused(page, "#modal-fixture-region button[aria-label='Re-rendered opener']"), true, "focus returns to the re-created opener, not to <body>");

  // the opener loses focus (disabled while it prepares) before its dialog comes: it is still the opener
  await page.click("#modal-fixture-busy");
  await page.waitForSelector("#modal-fixture-prepared");
  assert.equal(await isFocused(page, "#modal-fixture-prepared-first"), true, "the prepared dialog takes focus");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#modal-fixture-prepared", { hidden: true });
  assert.equal(await isFocused(page, "#modal-fixture-busy"), true, "focus returns to the command that dropped focus while preparing");
  await page.evaluate(() => {
    const dispose = (window).__disposeModalFocusFixture;
    dispose?.();
    document.getElementById("modal-focus-fixture-root")?.remove();
  });
  await page.click('.home-examples button.home-item[title="patch-antenna.json"]');
  const examplesMode = await page.waitForFunction(() => document.querySelector('.mode-switch [aria-current="page"]')?.textContent.includes("Examples"), { timeout: 10000 }).then(() => true, () => false);
  if (!examplesMode) {
    const state = await page.evaluate(async () => {
      const [app, workspace] = await Promise.all([import("/src/state.ts"), import("/src/workspace.ts")]);
      return { mode: workspace.appMode(), bundle: !!app.bundle(), source: app.source(), homeVisible: !!document.querySelector("main.home") };
    });
    throw new Error(`Opening the bundled example did not switch to Examples: ${JSON.stringify(state)}`);
  }
  const viewerMounted = await page.waitForSelector(".workspace .viewport", { timeout: 10000 }).then(() => true, () => false);
  if (!viewerMounted) {
    const state = await page.evaluate(() => ({
      mode: [...document.querySelectorAll(".mode-switch button")].map((el) => [el.textContent.trim(), el.getAttribute("aria-current")]),
      hasWorkspace: !!document.querySelector(".workspace"), hasBundleHeader: !!document.querySelector(".header-meta"),
      center: document.querySelector(".center")?.textContent.trim().slice(0, 240),
    }));
    throw new Error(`The opened example did not mount its 3D viewport: ${JSON.stringify(state)}`);
  }
  assert.ok(viewportRequests.length > 0, "the 3D viewport module loads only when the example is opened");
  console.log("Modal and startup browser checks passed: repeated open, focus entry and containment, inert restoration, nested Escape and return focus, listener cleanup, Tab past a scrolling body, return focus to a re-rendered or briefly unfocused opener, and deferred viewport load.");
} finally {
  await browser?.close();
  await stack?.stop();
}
