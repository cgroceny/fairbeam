// Opt-in browser regression for the Start screen. Run against an already-running Vite root:
// FAIRBEAM_BROWSER_TESTS=1 FAIRBEAM_PUPPETEER=/path/to/puppeteer-core.js \
// FAIRBEAM_CHROME=/path/to/chrome FAIRBEAM_TEST_URL=http://127.0.0.1:5420/ \
// node scripts/check-home-accessibility.mjs
// Every API request is intercepted; the fixture never creates or deletes a real design.
import assert from "node:assert/strict";

if (process.env.FAIRBEAM_BROWSER_TESTS !== "1") {
  console.log("SKIP home accessibility browser checks: opt in with FAIRBEAM_BROWSER_TESTS=1 (running Vite required).");
  process.exit(0);
}

const module = await import(process.env.FAIRBEAM_PUPPETEER || "puppeteer-core");
const puppeteer = module.default ?? module;
const url = process.env.FAIRBEAM_TEST_URL || "http://127.0.0.1:5420/";
const chrome = process.env.FAIRBEAM_CHROME || (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const trScreenshot = process.env.FAIRBEAM_TR_SCREENSHOT;
const fixture = { key: "accessibility_fixture", kind: "design", file: "accessibility_fixture.design.json", modified: 200,
  model: { id: "accessibility_fixture", name: "Accessibility fixture" } };
const recentFixture = { key: "recent_fixture", kind: "design", file: "recent_fixture.design.json", modified: 300,
  model: { id: "recent_fixture", name: "Zeta design" } };
const olderFixture = { key: "older_fixture", kind: "design", file: "older_fixture.design.json", modified: 100,
  model: { id: "older_fixture", name: "Aerial design" } };
const undatedFixture = { key: "undated_fixture", kind: "design", file: "undated_fixture.design.json",
  model: { id: "undated_fixture", name: "Undated design" } };
let models = [fixture, recentFixture, olderFixture, undatedFixture];
let deleteFails = true;
let browser;

const focused = (page, selector) => page.$eval(selector, (el) => document.activeElement === el);
const selectAll = async (page) => {
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
};
async function assertCompactHeader(page, mode, language, capture = false) {
  await page.evaluate(async (nextLanguage) => {
    const { setLanguage } = await import("/src/i18n/index.ts");
    setLanguage(nextLanguage);
  }, language);
  if (mode === "results") {
    await page.click('.mode-switch [role="radio"]:nth-child(3)');
  } else {
    await page.evaluate(async (nextMode) => {
      const { setAppMode } = await import("/src/workspace.ts");
      setAppMode(nextMode);
    }, mode);
  }
  const modeIndex = { home: 1, design: 2, results: 3 }[mode];
  await page.waitForFunction((index) => document.querySelector(`.mode-switch [role="radio"]:nth-child(${index})`)?.getAttribute("aria-checked") === "true", {}, modeIndex);
  await page.waitForFunction((lang) => document.documentElement.lang === lang, {}, language);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(overflow, false, `${language.toUpperCase()} ${mode} at 390px has no horizontal overflow`);
  await page.click(".header-more-trigger");
  await page.waitForSelector("#header-more-menu", { visible: true });
  const menuLabels = await page.$$eval("#header-more-menu [role=menuitem]", (els) => els.map((el) => el.textContent.trim().toLocaleLowerCase()));
  const required = language === "tr"
    ? ["sonuç dosyası", "ekran görüntüsü", "geri bildirim", "ayar", "hakkında"]
    : ["open result file", "screenshot", "feedback", "settings", "about"];
  for (const label of required) assert.ok(menuLabels.some((actual) => actual.includes(label)), `${language.toUpperCase()} ${mode} menu exposes ${label}`);
  if (mode !== "home") {
    const packageLabel = language === "tr" ? "paketi dışa aktar" : "export package";
    assert.ok(menuLabels.some((actual) => actual.includes(packageLabel)), `${language.toUpperCase()} ${mode} menu exposes package export`);
  }
  const menuBounds = await page.$eval("#header-more-menu", (el) => {
    const { left, right, top, bottom } = el.getBoundingClientRect();
    return { left, right, top, bottom, width: innerWidth, height: innerHeight };
  });
  assert.ok(menuBounds.left >= 0 && menuBounds.right <= menuBounds.width && menuBounds.top >= 0 && menuBounds.bottom <= menuBounds.height,
    `${language.toUpperCase()} ${mode} menu remains inside the viewport`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true,
    `${language.toUpperCase()} ${mode} menu does not create horizontal overflow`);
  if (capture && trScreenshot) {
    await page.screenshot({ path: trScreenshot });
    console.log(`TR 390px Start/menu screenshot saved: ${trScreenshot}`);
  }
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#header-more-menu") === null);
}
const respond = (request, status, body) => request.respond({ status, contentType: "application/json", body: JSON.stringify(body) });

try {
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.setViewport({ width: 390, height: 844 });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return request.continue();
    if (path === "/api/health") return respond(request, 200, { ok: true, api: 1, cpu_count: 4, default_threads: 2, queue: { running: null, queued: 0 } });
    if (path === "/api/models" && request.method() === "GET") return respond(request, 200, { models });
    if (path === "/api/runs" && request.method() === "GET") return respond(request, 200, { runs: [] });
    if (path === "/api/designs" && request.method() === "POST") return respond(request, 409, { error: "Fixture create failed" });
    if (path === `/api/designs/${fixture.key}/delete` && request.method() === "POST") {
      if (deleteFails) return respond(request, 409, { error: "Fixture delete failed" });
      models = models.filter((model) => model.key !== fixture.key);
      return respond(request, 200, { id: fixture.key, file: fixture.file, moved_to: "history/accessibility_fixture.design.json" });
    }
    return respond(request, 404, { error: `Unexpected fixture request: ${path}` });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("main.home #home-name-hint");

  const input = "main.home input.field-text";
  await page.click(input);
  await selectAll(page);
  await page.keyboard.press("Backspace");
  await page.type(input, "x");
  assert.equal(await page.$eval(input, (el) => el.getAttribute("aria-invalid")), "true");
  assert.equal(await page.$eval(input, (el) => el.getAttribute("aria-describedby")), "home-name-hint");
  assert.match(await page.$eval("#home-name-hint", (el) => el.textContent), /at least two/);
  assert.equal(await page.$eval("#home-name-hint", (el) => el.getAttribute("aria-live")), "polite");

  await page.keyboard.press("Backspace");
  await page.type(input, "Valid name");
  await page.click('main.home button[type="submit"]');
  await page.waitForSelector("#home-create-error");
  await page.waitForFunction(() => document.activeElement?.id === "home-create-error");
  assert.equal(await page.$eval("#home-create-error", (el) => el.getAttribute("role")), "alert");
  assert.match(await page.$eval(input, (el) => el.getAttribute("aria-describedby")), /home-create-error/);
  await page.type(input, " again");
  assert.equal(await page.$("#home-create-error"), null, "editing clears stale server error");

  const designNames = () => page.$$eval("#home-design-list .home-item-name", (els) => els.map((el) => el.textContent.trim()));
  await page.waitForSelector("#home-design-list li");
  assert.deepEqual(await designNames(), ["Zeta design", "Accessibility fixture", "Aerial design", "Undated design"],
    "recent sort orders dated designs first and keeps undated designs at the end");
  assert.ok(await page.$(".home-modified-note[role=note]"), "undated projects are explained");
  const search = 'input[type="search"]';
  await page.type(search, "Aerial");
  assert.deepEqual(await designNames(), ["Aerial design"], "design search matches names");
  await page.click(search);
  await selectAll(page);
  await page.keyboard.press("Backspace");
  await page.select(".home-design-sort select", "name");
  assert.deepEqual(await designNames(), ["Accessibility fixture", "Aerial design", "Undated design", "Zeta design"], "name sort is alphabetical");
  await page.click('[data-home-favorite="recent_fixture"]');
  assert.equal(await page.$eval('[data-home-favorite="recent_fixture"]', (el) => el.getAttribute("aria-pressed")), "true");
  await page.click(".home-favorites-only");
  assert.deepEqual(await designNames(), ["Zeta design"], "favorites filter keeps only starred designs");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#home-design-list li");
  assert.equal(await page.$eval(".home-favorites-only", (el) => el.getAttribute("aria-pressed")), "true", "favorites-only preference persists");
  assert.equal(await page.$eval(".home-design-sort select", (el) => el.value), "name", "sort preference persists");
  assert.deepEqual(await designNames(), ["Zeta design"], "favorite persists across reload");
  await page.click(".home-favorites-only");
  assert.deepEqual(await designNames(), ["Accessibility fixture", "Aerial design", "Undated design", "Zeta design"], "turning off favorites restores all designs");
  await page.select(".home-design-sort select", "modified");

  const copyLabel = await page.$eval(".home-copy > span", (el) => el.textContent.trim()).catch(() => null);
  if (copyLabel) assert.match(copyLabel, /Open as new|Yeni tasarım olarak aç/, "editable example copy has a visible descriptive label");

  const more = ".header-more-trigger";
  assert.ok(await page.$(more), "compact header shows the More actions trigger");
  assert.equal(await page.$eval(".header-secondary", (el) => getComputedStyle(el).display), "none", "compact header moves secondary actions out of the row");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "390 px Start screen has no horizontal page overflow");
  await page.click(more);
  await page.waitForSelector("#header-more-menu");
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem");
  const menuLabels = await page.$$eval("#header-more-menu [role=menuitem]", (els) => els.map((el) => el.textContent.trim().toLowerCase()));
  for (const alternatives of [["open", "aç"], ["screenshot", "ekran"], ["feedback", "geri"], ["settings", "ayar"], ["about", "hakk"]]) {
    assert.ok(menuLabels.some((label) => alternatives.some((word) => label.includes(word))), `compact menu exposes ${alternatives[0]}`);
  }
  const enabledMenuCount = await page.$$eval("#header-more-menu [role=menuitem]:not(:disabled)", (els) => els.length);
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelectorAll("#header-more-menu [role=menuitem]:not(:disabled)")[document.querySelectorAll("#header-more-menu [role=menuitem]:not(:disabled)").length - 1]), true, "End moves to the last enabled menu action");
  await page.keyboard.press("Home");
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("#header-more-menu [role=menuitem]:not(:disabled)")), true, "Home moves to the first menu action");
  await page.keyboard.press("Escape");
  await page.waitForFunction((selector) => document.activeElement?.matches(selector), {}, more);
  await page.click(more);
  await page.waitForSelector("#header-more-menu");
  await page.keyboard.press("Tab");
  assert.equal(await page.$("#header-more-menu"), null, "Tab closes the menu");
  assert.ok(enabledMenuCount >= 5, "compact menu provides the secondary actions");

  for (const language of ["en", "tr"]) {
    for (const mode of ["home", "design", "results"]) {
      await assertCompactHeader(page, mode, language, language === "tr" && mode === "home");
    }
  }
  await assertCompactHeader(page, "home", "en");

  // Results panels open one at a time on compact screens. Resizing restores the desktop panel
  // choices exactly, and responsive changes do not move focus outside a panel.
  await page.click('.mode-switch [role="radio"]:nth-child(3)');
  await page.waitForSelector(".workspace:not(.design-mode) .panel-left");
  await page.waitForFunction(() => document.querySelector(".workspace:not(.design-mode)")?.classList.contains("left-closed") &&
    document.querySelector(".workspace:not(.design-mode)")?.classList.contains("right-closed"));
  await page.click('[data-panel-toggle="left"]');
  assert.equal(await page.$eval('[data-panel-toggle="left"]', (el) => el.getAttribute("aria-pressed")), "true");
  assert.equal(await page.$eval('[data-panel-toggle="right"]', (el) => el.getAttribute("aria-pressed")), "false");
  await page.click('[data-panel-toggle="right"]');
  assert.equal(await page.$eval('[data-panel-toggle="left"]', (el) => el.getAttribute("aria-pressed")), "false");
  assert.equal(await page.$eval('[data-panel-toggle="right"]', (el) => el.getAttribute("aria-pressed")), "true");
  await page.setViewport({ width: 1200, height: 900 });
  await page.waitForFunction(() => !document.querySelector(".workspace:not(.design-mode)")?.classList.contains("left-closed") &&
    !document.querySelector(".workspace:not(.design-mode)")?.classList.contains("right-closed"));
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-panel-toggle")), "right", "resize leaves focus on the panel toolbar control");
  await page.click('[data-panel-toggle="left"]');
  assert.equal(await page.$eval('[data-panel-toggle="left"]', (el) => el.getAttribute("aria-pressed")), "false");
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector(".workspace:not(.design-mode)")?.classList.contains("left-closed") &&
    !document.querySelector(".workspace:not(.design-mode)")?.classList.contains("right-closed"));
  await page.click('[data-panel-toggle="left"]');
  await page.setViewport({ width: 1200, height: 900 });
  await page.waitForFunction(() => document.querySelector(".workspace:not(.design-mode)")?.classList.contains("left-closed") &&
    !document.querySelector(".workspace:not(.design-mode)")?.classList.contains("right-closed"));

  // Designer layout adapts without replacing the remembered desktop choices or moving focus from
  // the header when width changes.
  await page.evaluate(async () => {
    const state = await import("/src/designer/layoutState.ts");
    state.setLeftTreeCollapsed(true);
    state.setSidePanelCollapsed(true);
    state.setSidePanelCollapsed(false);
    document.querySelector(".mode-switch button")?.focus();
  });
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(async () => {
    const state = await import("/src/designer/layoutState.ts");
    return state.leftTreeCollapsed() && !state.sidePanelCollapsed();
  });
  assert.equal(await page.evaluate(() => document.activeElement?.closest(".mode-switch") !== null), true, "compact adaptation does not steal focus from the header");
  await page.setViewport({ width: 1200, height: 900 });
  await page.waitForFunction(async () => {
    const state = await import("/src/designer/layoutState.ts");
    return state.leftTreeCollapsed() && !state.sidePanelCollapsed();
  });
  assert.equal(await page.evaluate(() => localStorage.getItem("fairbeam.leftTreeCollapsed")), "true");
  assert.equal(await page.evaluate(() => localStorage.getItem("fairbeam.sidePanelCollapsed")), "false");
  await page.setViewport({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("main.home #home-name-hint");
  await page.waitForFunction(async () => {
    const state = await import("/src/designer/layoutState.ts");
    return state.leftTreeCollapsed() && !state.sidePanelCollapsed();
  });
  assert.equal(await page.evaluate(() => localStorage.getItem("fairbeam.leftTreeCollapsed")), "true", "compact startup retains the desktop tree preference");
  await page.waitForSelector("#home-design-list li");

  const opener = `#home-delete-${fixture.key}`;
  const keep = `#home-keep-${fixture.key}`;
  await page.click(opener);
  await page.waitForFunction((id) => document.activeElement?.id === id, {}, `home-keep-${fixture.key}`);
  assert.equal(await page.$eval(".home-confirm", (el) => el.getAttribute("role")), "group");
  await page.click(keep);
  await page.waitForFunction((id) => document.activeElement?.id === id, {}, `home-delete-${fixture.key}`);
  await page.click(opener);
  await page.waitForFunction((id) => document.activeElement?.id === id, {}, `home-keep-${fixture.key}`);
  await page.keyboard.press("Escape");
  await page.waitForFunction((id) => document.activeElement?.id === id, {}, `home-delete-${fixture.key}`);

  await page.click(opener);
  await page.waitForFunction((id) => document.activeElement?.id === id, {}, `home-keep-${fixture.key}`);
  await page.click(".home-confirm .home-del-btn");
  await page.waitForFunction(() => document.activeElement?.id === "home-delete-note");
  assert.equal(await page.$eval("#home-delete-note", (el) => el.getAttribute("role")), "alert");
  assert.match(await page.$eval("#home-delete-note", (el) => el.textContent), /Fixture delete failed/);
  assert.ok(await page.$(opener), "failed delete leaves the design available");

  deleteFails = false;
  await page.click(opener);
  await page.waitForFunction((id) => document.activeElement?.id === id, {}, `home-keep-${fixture.key}`);
  await page.click(".home-confirm .home-del-btn");
  await page.waitForFunction(() => document.activeElement?.id === "home-delete-note");
  assert.equal(await page.$eval("#home-delete-note", (el) => el.getAttribute("role")), "status");
  assert.match(await page.$eval("#home-delete-note", (el) => el.textContent), /Deleted accessibility_fixture.design.json/);
  assert.equal(await page.$(opener), null, "successful delete removes the design row");
  assert.equal(await focused(page, "#home-delete-note"), true);
  console.log("Home/responsive browser checks passed: project search/sort/favorites, EN/TR 390px header menus on Start/Design/Examples, panel adaptation, stored desktop layout and delete confirmation focus.");
} finally {
  await browser?.close();
}
