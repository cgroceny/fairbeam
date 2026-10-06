// Browser coverage for Settings workflows using an isolated native-command bridge.
// No OS settings, runtimes or folders are changed and no solver is submitted.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { readFile } from "node:fs/promises";
import { chromePath, root, startStack } from "./scenarios/stack.mjs";
import { join } from "node:path";

let stack, browser;
try {
  stack = await startStack({ log: console.log, niceSolver: false });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(), args: ["--no-sandbox"] });
  for (const lang of ["en", "tr"]) {
    const strings = JSON.parse(await readFile(join(root, "src/i18n", `${lang}.json`), "utf8"));
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(45000);
    await page.setViewport({ width: 1024, height: 768 });
    await page.evaluateOnNewDocument(language => localStorage.setItem("fairbeam.generalSettings", JSON.stringify({ language })), lang);
    await page.goto(stack.url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`.app-header button[aria-label='${strings["settings.title"]}']`);
    await page.evaluate(() => {
      const state = window.settingsTest = {
        calls: [], picked: null, error: null, update: "up_to_date",
        data: { check_updates_on_start: false, current_workspace: "C:\\active", next_workspace: "C:\\active", workspace_pending: false,
          gpu_supported: true, gpu_adapter: "Test NVIDIA", gpu_driver: "591.74", gpu_choice_ready: true,
          gpu_choice_source: "external", gpu_choice_path: "E:\\existing-gpu", gpu_runtime_enabled: false, external_is_gpu: false },
      };
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        state.calls.push({ command, args });
        if (command === "get_general_settings") return structuredClone(state.data);
        if (command === "telemetry_status") return { build_enabled: false, consent: "unknown", active: false };
        if (command === "pick_workspace_folder") return state.picked;
        if (command === "set_workspace_folder") {
          if (state.error) throw state.error;
          state.data.next_workspace = args.path; state.data.workspace_pending = true; return args.path;
        }
        if (command === "check_updates_now") return { status: state.update, version: "0.5.4" };
        if (command === "set_gpu_runtime_enabled") { state.data.gpu_runtime_enabled = args.value; return; }
        if (command === "install_gpu_runtime") {
          state.data.gpu_choice_ready = true; state.data.gpu_choice_source = "managed";
          state.data.gpu_choice_path = "C:\\managed-gpu"; return;
        }
      } };
    });
    const open = async () => {
      await page.click(`.app-header button[aria-label='${strings["settings.title"]}']`);
      await page.waitForSelector(".gs-workspace");
    };
    const clickText = async key => page.evaluate(text => {
      const button = [...document.querySelectorAll(".gs-body button")].find(el => el.textContent.trim() === text);
      if (!button) throw new Error(`Missing button: ${text}`);
      button.click();
    }, strings[key]);
    await open();
    assert.equal(await page.$(".gs-gpu-runtime button"), null, "an existing GPU build does not require a download");
    await page.click(".gs-gpu-runtime input[type=checkbox]");
    await page.waitForFunction(() => window.settingsTest.calls.some(c => c.command === "set_gpu_runtime_enabled" && c.args.value === true));
    await clickText("settings.changeWorkspace");
    await page.waitForFunction(() => window.settingsTest.calls.some(c => c.command === "pick_workspace_folder"));
    assert.equal(await page.evaluate(() => window.settingsTest.calls.some(c => c.command === "set_workspace_folder")), false, "cancel does not save a workspace");
    await page.evaluate(() => { window.settingsTest.picked = "D:\\new-workspace"; });
    await clickText("settings.changeWorkspace");
    await page.waitForFunction(() => document.querySelector(".gs-workspace").textContent.includes("D:\\new-workspace"));
    assert.ok(await page.$eval(".gs-workspace", el => el.textContent.includes("C:\\active")), "active workspace stays visible after a scheduled change");
    await clickText("settings.openFolder");
    await page.waitForFunction(() => window.settingsTest.calls.some(c => c.command === "open_workspace"));
    await page.evaluate(() => { window.settingsTest.error = "workspace_protected_path"; });
    await clickText("settings.changeWorkspace");
    await page.waitForFunction(text => document.querySelector(".gs-body [role=alert]")?.textContent === text, {}, strings["settings.error.workspaceProtected"]);
    for (const status of ["up_to_date", "unavailable", "in_progress"]) {
      await page.evaluate(value => { window.settingsTest.update = value; }, status);
      await clickText("settings.checkUpdatesNow");
      const key = { up_to_date: "upToDate", unavailable: "unavailable", in_progress: "inProgress" }[status];
      await page.waitForFunction(text => document.querySelector(".gs-update-status")?.textContent.includes(text), {}, strings[`settings.updateCheck.${key}`].replace("{version}", "0.5.4"));
    }
    await page.keyboard.press("Escape");
    await page.waitForSelector(".gs-workspace", { hidden: true });
    await page.evaluate(() => { window.settingsTest.data.gpu_choice_ready = false; });
    await open();
    await page.waitForSelector(".gs-gpu-runtime button");
    await clickText("settings.gpuManaged.install");
    await page.waitForFunction(() => window.settingsTest.calls.some(c => c.command === "install_gpu_runtime"));
    await page.waitForSelector(".gs-gpu-runtime input[type=checkbox]");
    assert.ok(await page.$eval(".gs-gpu-runtime", el => el.textContent.includes("C:\\managed-gpu")));
    assert.equal(await page.$eval(".gs-body", el => el.scrollWidth <= el.clientWidth + 1), true, "settings paths stay within the compact dialog");
    assert.equal(await page.evaluate(() => window.settingsTest.calls.some(c => /restart|retry|stop_server/.test(c.command))), false, "settings changes do not restart running work");
    await page.close();
    console.log(`Desktop Settings ${lang}: workspace cancel/save/error, current path, GPU reuse/preparation and update results passed.`);
  }
} finally {
  await browser?.close();
  await stack?.stop();
}
