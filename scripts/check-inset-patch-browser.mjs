// Authored for remote CI. No local execution without explicit user permission.
// Exercises the real template API, Designer inputs/preview and save/reopen; no solver.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { startStack, chromePath } from './scenarios/stack.mjs';
import { Session, auditInPage } from './scenarios/harness.mjs';
import { safeDiagnosticText, withStartupDiagnostics } from './scenarios/startup-diagnostics.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' && process.env.FAIRBEAM_ALLOW_BROWSER_TEST !== '1') {
  throw new Error('Browser test requires remote CI or explicit user permission (FAIRBEAM_ALLOW_BROWSER_TEST=1).');
}
const out = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tmpdir(), `fairbeam-inset-patch-${Date.now()}`), 'inset-patch');
await mkdir(out, { recursive: true });
let stack, browser, page, session, activeLang;
const outcomes = [];
const forbidden = [];
try {
  stack = await startStack({ log: console.log });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(),
    args: ['--no-sandbox', '--mute-audio', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  for (const lang of ['en', 'tr']) {
    activeLang = lang;
    const context = await browser.createBrowserContext();
    page = await context.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(language => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ language })), lang);
    // server.py routes: ordinary runs, sweeps, mesh convergence, optimization and
    // research solver jobs. Also refuse Blender jobs and known native actions;
    // this test only creates, previews and saves a design in the browser.
    await page.setRequestInterception(true);
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      const startsJob = /^\/api\/(?:runs|sweeps|convergence|optimizations|research\/runs|render-jobs)(?:\/|$)/.test(path);
      const nativeAction = /^\/api\/(?:native-document(?:\/|$)|(?:research\/elmer\/install|blender\/open-download|open-feedback|renders\/[A-Za-z0-9_-]+\/open)\/?$)/.test(path);
      if (request.method() === 'POST' && (startsJob || nativeAction)) {
        forbidden.push(request.url()); void request.abort();
      } else void request.continue();
    });
    const s = session = new Session(page, { lang, scenario: 'inset-patch', url: stack.url, artifactDirectory: out });
    await withStartupDiagnostics(page, { directory: join(out, `startup-${lang}`), stack }, async () => {
      await page.goto(stack.url, { waitUntil: 'domcontentloaded' }); await s.wait('.home');
    });
    await s.wait('.home-templates .nm-option', await s.T('templates.insetPatch.name'));
    await s.wait('.home-templates .nm-option', await s.T('templates.insetPatch.sub'));
    assert.deepEqual(await page.evaluate(auditInPage, '.home-templates'), []);
    await page.locator('input[name="home-template"][value="inset-patch"]').click();
    await s.fill(await s.field(await s.T('home.newProject.name')), `Inset synthesis ${lang}`, { blur: false });
    await s.click('home.newProject.create'); await s.wait('.rb');
    await s.wait('[role=tree]');
    assert.deepEqual(s.consoleIssues, [], 'new template must render the design tree without exceptions');
    const before = await s.store((_, m) => ({ names: { ...m.s.names().names }, file: JSON.parse(JSON.stringify(m.s.file())), note: m.s.message()?.text }));
    assert.match(before.note || '', lang === 'en' ? /no full-wave validation/ : /tam dalga simülasyonuyla doğrulanmadı/);
    await s.wait('.dz-msg[role=status]', before.note);
    await s.ev(async () => (await import('/src/designer/dockState.ts')).openParametersTab());
    await s.wait('.param-dock');
    for (const [key, value] of [['f0', 1.8], ['eps_r', 3.38], ['h', 0.8]]) {
      const old = await s.store((_, m) => ({ ...m.s.names().names }));
      await s.fill(await s.field(await s.T('params.expression', { key })), String(value));
      await s.waitFor(async ({ key, value }) => (await import('/src/designer/store.ts')).names().names[key] === value, { key, value });
      const now = await s.store((_, m) => ({ ...m.s.names().names }));
      assert.notEqual(now.L, old.L, `${lang}: ${key} changes patch length`);
      assert.notEqual(now.inset, old.inset, `${lang}: ${key} changes inset`);
      assert.ok(now.feed_w + 2 * now.gap < now.W && now.inset > 0 && now.inset < now.L / 2);
    }
    // The displayed model must acquire the edited geometry; no synthetic fixture.
    await s.waitFor(async () => {
      const d = await import('/src/designer/store.ts'), st = await import('/src/state.ts');
      const n = d.names().names, p = st.bundle()?.parts.find(p => p.name === 'patch')?.primitives;
      return p?.length === 4 && Math.abs(p[0].start[0] - n.x_in) < 1e-8 && Math.abs(p[0].start[2] - n.h) < 1e-8;
    }, null, { what: 'edited inset geometry in displayed preview' });
    const wanted = await s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft)));
    await page.screenshot({ path: join(out, `edited-${lang}.png`) });
    assert.deepEqual(await page.evaluate(auditInPage, '.param-dock'), []);
    await s.click('ribbon.tab.home', { sel: '.rb-tab' });
    await s.click('common.save', { sel: '.rb-btn' });
    await s.waitFor(async () => {
      const d = await import('/src/designer/store.ts'); return !d.dirty() && !d.saving();
    }, null, { what: 'saved inset design' });
    await page.reload({ waitUntil: 'domcontentloaded' }); await s.wait('.rb');
    await s.waitFor(async id => (await import('/src/designer/store.ts')).file()?.id === id, before.file.id);
    assert.deepEqual(await s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft))), wanted);
    assert.deepEqual(forbidden, [], 'no solver or native-action endpoints requested');
    assert.deepEqual(s.consoleIssues, [], 'editing and reopening must keep the design tree renderable');
    outcomes.push({ lang, template: true, warning: true, inputs: ['f0', 'eps_r', 'h'], preview: true, saveReopen: true, solverRequests: 0 });
    await context.close();
  }
  await writeFile(join(out, 'result.json'), JSON.stringify(outcomes, null, 2));
  console.log(JSON.stringify({ out, outcomes }, null, 2));
} catch (error) {
  let screenshotError;
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(e => { screenshotError = String(e); });
  await writeFile(join(out, 'failure.json'), JSON.stringify({
    error: String(error?.stack || error), lang: activeLang, url: page?.url(), screenshotError,
    console: session?.consoleIssues, forbidden, completed: outcomes, children: stack?.diagnostics(),
  }, (_key, value) => typeof value === 'string' ? safeDiagnosticText(value) : value, 2))
    .catch(e => console.error('Could not save failure report:', safeDiagnosticText(e)));
  throw error;
} finally {
  try { await browser?.close(); } finally { await stack?.stop(); }
}
