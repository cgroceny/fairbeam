// Isolated DOM regression for the actual ToastHost + toast store. Vite only:
// no Python/app server, model, user workspace, solver, native app or speech engine.
// Live-region structure is necessary, but this test does NOT establish AT speech.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import solid from 'vite-plugin-solid';
import puppeteer from 'puppeteer-core';
import { chromePath } from './scenarios/stack.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' && process.env.FAIRBEAM_ALLOW_BROWSER_TEST !== '1') {
  throw new Error('Requires CI or root-scheduled execution (FAIRBEAM_ALLOW_BROWSER_TEST=1).');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempParent = resolve(tmpdir());
const runtime = await mkdtemp(join(tempParent, 'fairbeam-toast-test-'));
const out = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tempParent, `fairbeam-toast-evidence-${Date.now()}`), 'toast-announcements');
await mkdir(out, { recursive: true });
// A stable TSX filename lets the real Solid plugin transform the in-memory module.
// It is never written into the checkout.
const entry = '/__toast_harness__.tsx', virtualId = join(root, '__toast_harness__.tsx').replaceAll('\\', '/');
const harness = `
import { render } from 'solid-js/web';
import ToastHost from '/src/components/ToastHost.tsx';
import { showToast, dismissToast, toasts, TOAST_MS, TOAST_ACTION_MS } from '/src/lib/toast.ts';
import { setLanguage, t } from '/src/i18n/index.ts';
import '/design-system/tokens.css';
import '/src/styles/app.css';
setLanguage(new URL(location.href).searchParams.get('lang') === 'tr' ? 'tr' : 'en');
render(() => <ToastHost />, document.getElementById('root'));
const region = document.querySelector('.toast-announcements');
let events = [], actions = 0, closes = 0;
const record = records => {
  if (records.length) events.push({ text: region.textContent, types: records.map(change => change.type), at: performance.now() });
};
const observer = new MutationObserver(record);
observer.observe(region, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
window.__toastTest = {
  TOAST_MS, TOAST_ACTION_MS,
  text: { first: t('results.data.copied'), second: t('results.data.copied') + ' (2)',
    error: t('results.data.copyFailed'), action: t('results.toolbar.showInFolder'), close: t('common.close') },
  show(text, key, tone = 'info', action = true) {
    return showToast(text, { key, tone, action: action ? { label: t('results.toolbar.showInFolder'), run: () => { actions++; } } : undefined,
      onClose: () => { closes++; } });
  },
  dismiss: key => dismissToast(key),
  clear: () => toasts().forEach(toast => dismissToast(toast.id)),
  drain() { record(observer.takeRecords()); const result = events; events = []; return result; },
  state: () => ({ sameRegion: region === document.querySelector('.toast-announcements'),
    announcement: region.textContent, children: region.childElementCount,
    toasts: toasts().map(({id,key,text,tone}) => ({id,key,text,tone})), actions, closes }),
};
`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Toast DOM regression</title><link rel="icon" href="data:,"></head>
<body><button id="outside" type="button">Focus outside notices</button><div id="root"></div><script type="module" src="${entry}"></script></body></html>`;
let vite, browser, page;
const results = [], forbidden = [], errors = [];
try {
  vite = await createServer({
    configFile: false, root, publicDir: false, clearScreen: false, cacheDir: join(runtime, 'vite-cache'),
    plugins: [solid(), {
      name: 'isolated-toast-harness',
      resolveId(id) { if (id === entry) return virtualId; },
      load(id) { if (id === virtualId) return harness; },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (new URL(req.url || '/', 'http://localhost').pathname !== '/__toast_test__') return next();
          res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
        });
      },
    }],
    optimizeDeps: { entries: [], include: ['solid-js', 'solid-js/web', 'lucide-solid'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, await realpath(join(root, 'node_modules'))] },
      watch: { ignored: ['**/.sim/**', '**/python/**', '**/src-tauri/target/**'] } },
  });
  await vite.listen();
  const address = vite.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(), userDataDir: join(runtime, 'browser-profile'),
    args: ['--no-sandbox'] });
  for (const lang of ['en', 'tr']) {
    const context = await browser.createBrowserContext();
    page = await context.newPage(); await page.setViewport({ width: 1000, height: 700 });
    page.on('pageerror', error => errors.push({ lang, kind: 'page', message: String(error) }));
    page.on('console', message => { if (message.type() === 'error') errors.push({ lang, kind: 'console', message: message.text() }); });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.protocol === 'data:' || (url.origin === origin && request.method() === 'GET' && !url.pathname.startsWith('/api/'))) void request.continue();
      else { forbidden.push({ lang, method: request.method(), url: request.url() }); void request.abort(); }
    });
    await page.goto(`${origin}/__toast_test__?lang=${lang}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__toastTest);
    await page.mouse.move(2, 2); // No accidental hover keeps a timer paused.
    const text = await page.evaluate(() => window.__toastTest.text);
    const state = () => page.evaluate(() => window.__toastTest.state());
    const drain = () => page.evaluate(() => window.__toastTest.drain());
    const show = (message, key, tone = 'info', action = true) => page.evaluate(args => window.__toastTest.show(...args), [message, key, tone, action]);
    const nonempty = events => events.map(event => event.text).filter(Boolean);
    const waitText = expected => page.waitForFunction(expected => document.querySelector('.toast-announcements')?.textContent === expected, { timeout: 5000 }, expected);
    const settle = () => new Promise(done => setTimeout(done, 250)); // observes cancellation beyond the product's 100 ms delay
    const status = await page.$eval('.toast-announcements', region => ({ role: region.getAttribute('role'), live: region.getAttribute('aria-live'),
      atomic: region.getAttribute('aria-atomic'), children: region.childElementCount, text: region.textContent,
      hidden: region.getAttribute('aria-hidden'), display: getComputedStyle(region).display, visibility: getComputedStyle(region).visibility }));
    assert.deepEqual(status, { role: 'status', live: 'polite', atomic: 'true', children: 0, text: '', hidden: null, display: 'block', visibility: 'visible' });
    await drain();
    await show(text.first, 'a'); await waitText(text.first);
    assert.deepEqual(nonempty(await drain()), [text.first], 'new info inserts only its own text in the persistent singleton');
    assert.deepEqual(await page.$eval('[data-toast-key="a"]', el => [el.getAttribute('role'), el.getAttribute('aria-live')]), [null, null]);
    await show(text.second, 'b'); await waitText(text.second);
    let mutations = await drain();
    assert.equal(mutations[0].text, '', 'an empty accessibility update precedes the next text');
    assert.deepEqual(nonempty(mutations), [text.second], 'stacking announces only newest text, never concatenated older notices');
    assert.equal((await state()).toasts.length, 2);
    await show(text.second, 'a'); await waitText(text.second); // same key, replacement text
    mutations = await drain();
    assert.equal(mutations[0].text, ''); assert.deepEqual(nonempty(mutations), [text.second]);
    let current = await state();
    const replaced = current.toasts.find(toast => toast.key === 'a').id;
    await show(text.second, 'a'); await waitText(text.second); // same key AND same text
    mutations = await drain();
    assert.equal(mutations[0].text, '', 'identical repeat still clears the status before reinsertion');
    assert.deepEqual(nonempty(mutations), [text.second]);
    current = await state();
    assert.equal(current.toasts.filter(toast => toast.key === 'a').length, 1);
    assert.notEqual(current.toasts.find(toast => toast.key === 'a').id, replaced);
    await page.evaluate(() => window.__toastTest.dismiss('a')); await settle();
    mutations = await drain();
    assert.deepEqual(nonempty(mutations), [], 'dismissing newest must not restore an older notice');
    current = await state(); assert.equal(current.announcement, ''); assert.equal(current.toasts[0].key, 'b');
    await show(text.first, 'c'); await waitText(text.first); await drain();
    await page.evaluate(() => window.__toastTest.dismiss('b')); await settle();
    assert.deepEqual(await drain(), [], 'removing an older toast does not replay current text');
    await show(text.error, 'error', 'error', false);
    assert.deepEqual(await drain(), [], 'errors never enter or rewrite the polite channel');
    assert.equal((await state()).announcement, text.first);
    assert.deepEqual(await page.$eval('[data-toast-key="error"]', el => [el.getAttribute('role'), el.getAttribute('aria-live'), el.getAttribute('aria-atomic')]), ['alert', 'assertive', 'true']);
    await page.evaluate(() => window.__toastTest.clear()); await settle();
    assert.deepEqual(nonempty(await drain()), []);
    assert.equal((await state()).sameRegion, true); assert.equal((await state()).announcement, '');

    // Superseded or dismissed notices cannot leak from a pending 100 ms timer.
    await page.evaluate(text => { window.__toastTest.show(text.first, 'pending-a'); window.__toastTest.show(text.second, 'pending-b'); }, text);
    await waitText(text.second);
    assert.deepEqual(nonempty(await drain()), [text.second], 'only the newest pending notice is inserted');
    await page.evaluate(() => window.__toastTest.clear()); await drain();
    await page.evaluate(text => { window.__toastTest.show(text, 'dismiss-pending'); window.__toastTest.dismiss('dismiss-pending'); }, text.first);
    await settle();
    assert.equal((await state()).announcement, ''); assert.deepEqual(nonempty(await drain()), []);

    // Actual native button semantics and keyboard activation, not mocked callbacks.
    await show(text.first, 'controls');
    assert.deepEqual(await page.$eval('[data-toast-key="controls"]', el => [...el.querySelectorAll('button')].map(button => ({
      name: button.getAttribute('aria-label') || button.textContent.trim(), type: button.type, disabled: button.disabled, tabIndex: button.tabIndex,
    }))), [{ name: text.action, type: 'button', disabled: false, tabIndex: 0 }, { name: text.close, type: 'button', disabled: false, tabIndex: 0 }]);
    await page.focus('#outside'); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.matches('.toast-action')), true);
    await page.keyboard.press('Enter');
    assert.equal((await state()).actions, 1); assert.equal((await state()).closes, 0);
    assert.equal((await state()).toasts.length, 0);
    await show(text.first, 'close');
    await page.focus('#outside'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.matches('.toast-close')), true);
    await page.keyboard.press('Enter');
    assert.equal((await state()).closes, 1); assert.equal((await state()).toasts.length, 0);

    // Real production timer, unchanged 5000 ms: keyboard focus pauses expiry.
    await page.mouse.move(2, 2);
    const timedId = await show(text.first, 'timed', 'info', false);
    await page.focus('#outside'); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.matches('[data-toast-key="timed"] .toast-close')), true);
    await waitText(text.first); await drain();
    const lifetime = await page.evaluate(() => window.__toastTest.TOAST_MS);
    assert.equal(lifetime, 5000);
    await new Promise(done => setTimeout(done, lifetime + 250));
    assert.equal((await state()).toasts[0]?.id, timedId, 'focused toast survives beyond its normal lifetime');
    assert.deepEqual(await drain(), [], 'focus pause does not replay live text');
    await page.focus('#outside');
    await page.waitForSelector('[data-toast-key="timed"]', { hidden: true, timeout: lifetime + 1500 });
    mutations = await drain();
    assert.deepEqual(nonempty(mutations), []);
    current = await state();
    assert.equal(current.sameRegion, true); assert.equal(current.announcement, ''); assert.equal(current.closes, 1, 'timer expiry is not a user close');
    results.push({ lang, persistentRegion: true, replacements: true, singletonClearThenInsert: true, cancelledPendingNotices: true, noStaleReplay: true, errorChannel: true, keyboardButtons: true, focusPauseMs: lifetime + 250, speechVerified: false });
    await context.close(); page = null;
  }
  assert.deepEqual(forbidden, [], 'the isolated component made no API, native or external request');
  assert.deepEqual(errors, [], 'no page/console errors');
  await writeFile(join(out, 'result.json'), JSON.stringify({ results, forbidden, errors, speechVerified: false, runtime: 'Vite + isolated actual component/store only' }, null, 2));
  console.log(JSON.stringify({ out, results, speechVerified: false }, null, 2));
} catch (error) {
  await writeFile(join(out, 'failure.json'), JSON.stringify({ error: String(error?.stack || error), results, forbidden, errors, speechVerified: false }, null, 2));
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  try { await browser?.close(); } finally {
    try { await vite?.close(); } finally {
      // Delete only the mkdtemp directory owned by this invocation, never a user profile.
      assert.equal(dirname(resolve(runtime)), tempParent);
      assert.ok(basename(runtime).startsWith('fairbeam-toast-test-'));
      await rm(runtime, { recursive: true, force: true });
    }
  }
}
