// The scenario harness: one browser page per scenario and language, with
//  - i18n-key based helpers (a scenario never hard-codes a visible text, so it runs in EN and TR),
//  - a visual audit after every step (horizontal overflow, clipped text without a tooltip, raw i18n
//    keys, document scroll),
//  - a console watch (errors and warnings from our code, `[i18n]` warnings for missing keys),
//  - screenshots of the failing step.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const failureDir = join(tmpdir(), 'fairbeam-scenario-failures');

// Browser-side noise that is not ours: WebGL software rendering, Vite's dev client, DevTools hints
const NOISE = /vite\]|Download the Solid|GPU stall|GL Driver|swiftshader|ReadPixels|WebGL: |favicon|Automatic fallback to software|net::ERR_ABORTED/i;

/** Runs in the page: the visual problems inside `scope` (a CSS selector, default the whole page). */
export function auditInPage(scope) {
  const root = document.querySelector(scope) ?? document.body;
  const out = [];
  const seen = new Set();
  const label = (e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
  const text = (e) => (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50);
  const shown = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(e);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const skip = (e) => e.closest('svg, canvas, [data-audit-skip], .cm-editor, script, style, .visually-hidden, .skip-link:not(:focus)') || ['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'CANVAS'].includes(e.tagName);
  const floatingRibbonGroup = (e) => {
    const items = e.querySelector(':scope > .rb-items');
    return e.matches('.rb-group[data-collapsed][data-open]') && !!items && getComputedStyle(items).position === 'absolute';
  };
  const insideScroller = (node, owner, e) => {
    for (let parent = node?.parentElement; parent && parent !== e; parent = parent.parentElement) {
      if (parent === owner) return true;
    }
    return false;
  };
  const scrollerOwners = (e, bounds) => [...e.querySelectorAll('*')].filter((owner) => {
    const style = getComputedStyle(owner);
    const box = owner.getBoundingClientRect();
    return ['auto', 'scroll'].includes(style.overflowX) && owner.clientWidth > 0
      && owner.scrollWidth > owner.clientWidth + 1
      && box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
  });
  const hasVisibleTextOutside = (e, bounds, scrollers) => {
    const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || scrollers.some((owner) => insideScroller(node, owner, e))) continue;
      if (parent.closest('svg, canvas, [data-audit-skip], .cm-editor, script, style, .visually-hidden, .skip-link:not(:focus)')) continue;
      if (!shown(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const outside = [...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0
        && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1));
      if (!outside) continue;
      // A nearer clipping ancestor may hide the excess text without contributing visible overflow
      // to `e`; account for that before deciding the parent itself has visible text outside it.
      let clipped = false;
      for (let owner = parent; owner && owner !== e; owner = owner.parentElement) {
        const style = getComputedStyle(owner);
        if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') continue;
        const box = owner.getBoundingClientRect();
        if ([...range.getClientRects()].some((rect) => rect.left < box.left - 1 || rect.right > box.right + 1)) {
          clipped = true;
          break;
        }
      }
      if (!clipped) return true;
    }
    return false;
  };
  const containedScroller = (e) => {
    const bounds = e.getBoundingClientRect();
    const scrollers = scrollerOwners(e, bounds);
    const protruding = [...e.querySelectorAll('*')].filter((child) => {
      const box = child.getBoundingClientRect();
      return box.left < bounds.left - 1 || box.right > bounds.right + 1;
    });
    return protruding.length > 0 && protruding.every((child) => scrollers.some((owner) => owner.contains(child)))
      && !hasVisibleTextOutside(e, bounds, scrollers);
  };
  const add = (kind, e, extra = '') => {
    const key = `${kind}|${label(e)}|${text(e)}`;
    if (!seen.has(key)) { seen.add(key); out.push(`${kind}: ${label(e)} "${text(e)}"${extra}`); }
  };
  const hasTip = (e) => !!(e.matches('[title], [aria-label]') || e.parentElement?.matches('[title], [aria-label]')
    || (e.tagName.toLowerCase() === 'svg' && e.querySelector(':scope > title')));
  for (const e of root.querySelectorAll('*')) {
    if (skip(e) || !shown(e)) continue;
    const cs = getComputedStyle(e);
    // Horizontal overflow of a container (children or text past the box)
    if (e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1) {
      if (cs.overflowX === 'visible' && !floatingRibbonGroup(e) && !containedScroller(e)) add('overflow', e, ` (${e.scrollWidth} > ${e.clientWidth})`);
      else if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && text(e) && !hasTip(e)) add('clipped-no-title', e, ` (${e.scrollWidth} > ${e.clientWidth})`);
    }
    // A leaf that shows a raw i18n key
    if (!e.children.length && /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+){1,4}$/.test((e.textContent || '').trim()) && !/\.(json|txt|csv|s\d+p|py|dxf|gbr|zip|md)$/i.test((e.textContent || '').trim())) add('raw-i18n-key', e);
  }
  // The dialogs, menus and popovers stay inside the window
  for (const e of root.querySelectorAll('[role=dialog], [role=menu], .dialog, .rb-pop, .menu, .rb-group[data-collapsed][data-open] > .rb-items')) {
    if (skip(e) || !shown(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.left < -1 || r.right > innerWidth + 1) add('outside-window', e, ` (${Math.round(r.left)}..${Math.round(r.right)} of ${innerWidth})`);
  }
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page scrolls horizontally (${document.documentElement.scrollWidth} > ${innerWidth})`);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitForPaint = (page, timeout = 1000) => page.evaluate((timeoutMs) => new Promise((resolve) => {
  let frames = 0;
  let complete = false;
  const timer = setTimeout(() => {
    if (!complete) { complete = true; resolve(false); }
  }, timeoutMs);
  const next = () => {
    if (complete) return;
    if (++frames === 2) {
      complete = true;
      clearTimeout(timer);
      resolve(true);
    } else requestAnimationFrame(next);
  };
  requestAnimationFrame(next);
}), timeout);

export class Session {
  constructor(page, { lang, scenario, url }) {
    this.page = page; this.lang = lang; this.scenario = scenario; this.url = url;
    this.results = []; this.stepName = ''; this.consoleIssues = [];
    this.auditIgnore = [];
    /** console messages this step expects (a request the server refuses on purpose is logged by the browser) */
    this.consoleAllow = [];
    page.on('console', (m) => {
      const type = m.type();
      if (type !== 'error' && type !== 'warning') return;
      const text = m.text();
      if (NOISE.test(text)) return;
      this.consoleIssues.push(`console ${type}: ${text.slice(0, 300)}`);
    });
    page.on('pageerror', (e) => this.consoleIssues.push(`page error: ${String(e.message).slice(0, 300)}`));
  }

  // ---- page helpers -------------------------------------------------------------------------
  /** A text in the page's current language, by i18n key. */
  T(key, params) {
    return this.page.evaluate(async (key, params) => (await import('/src/i18n/index.ts')).t(key, params), key, params);
  }
  /** Evaluate in the page with the app's modules: `mods` maps names to /src paths. */
  async ev(fn, arg, mods = {}) {
    return this.page.evaluate(async (fnSource, arg, mods) => {
      const m = {};
      for (const [k, p] of Object.entries(mods)) m[k] = await import(/* @vite-ignore */ p);
      return (0, eval)(`(${fnSource})`)(arg, m);
    }, fn.toString(), arg, mods);
  }
  /** The designer's store (draft, file, selection, …) */
  store(fn, arg, mods = {}) { return this.ev(fn, arg, { s: '/src/designer/store.ts', ...mods }); }

  async waitFor(fn, arg, { timeout = 15000, what = 'condition' } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      let ok = false;
      try { ok = await this.page.evaluate(fn, arg); } catch { /* page navigating */ }
      if (ok) return ok;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(80);
    }
  }
  sleep(ms) { return sleep(ms); }

  /** The first visible element matching `sel` whose text or aria-label contains `text` (or `[text]`, any of). */
  async find(sel, text, { within = 'body', exact = false } = {}) {
    const handle = await this.page.evaluateHandle((sel, text, within, exact) => {
      const wants = [].concat(text ?? []).filter((x) => x !== undefined);
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const roots = [...document.querySelectorAll(within)].reverse(); // the topmost dialog first
      for (const root of roots) {
        for (const e of root.querySelectorAll(sel)) {
          if (!vis(e)) continue;
          if (!wants.length) return e;
          const hay = [norm(e.getAttribute('aria-label')), norm(e.textContent), norm(e.title)];
          if (wants.some((w) => hay.some((h) => (exact ? h === norm(w) : h.includes(norm(w)))))) return e;
        }
      }
      return null;
    }, sel, text, within, exact);
    const el = handle.asElement();
    if (!el) { await handle.dispose(); return null; }
    return el;
  }
  async need(sel, text, opts) {
    const el = await this.find(sel, text, opts);
    if (!el) throw new Error(`no visible ${sel}${text ? ` with "${[].concat(text).join('" / "')}"` : ''}${opts?.within ? ` in ${opts.within}` : ''}`);
    return el;
  }
  /** Wait for an element to show up (polls `find`) */
  async wait(sel, text, opts = {}) {
    const end = Date.now() + (opts.timeout ?? 15000);
    for (;;) {
      const el = await this.find(sel, text, opts);
      if (el) return el;
      if (Date.now() > end) throw new Error(`timed out waiting for ${sel}${text ? ` "${[].concat(text).join('" / "')}"` : ''}`);
      await sleep(80);
    }
  }
  async gone(sel, text, opts = {}) {
    const end = Date.now() + (opts.timeout ?? 8000);
    while (await this.find(sel, text, opts)) {
      if (Date.now() > end) throw new Error(`${sel}${text ? ` "${text}"` : ''} is still shown`);
      await sleep(80);
    }
  }
  /** Click a button (or menu item, tab, …) by the visible text of an i18n key (or several keys). */
  async click(keyOrKeys, { sel = 'button, [role=menuitem], [role=tab], a, .rb-btn, summary', within = 'body', params, exact = false } = {}) {
    const keys = [].concat(keyOrKeys);
    const texts = await Promise.all(keys.map((k) => this.T(k, params)));
    const el = await this.wait(sel, texts, { within, exact });
    await el.evaluate((e) => e.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    await el.click();
    await sleep(60);
    return el;
  }
  async clickSel(sel, opts = {}) { const el = await this.need(sel, undefined, opts); await el.click(); await sleep(60); return el; }
  /** Type into an input the way a user does: focus, select all, type, Tab. */
  async fill(elOrSel, value, { blur = true } = {}) {
    const el = typeof elOrSel === 'string' ? await this.wait(elOrSel) : elOrSel;
    await el.click({ clickCount: 3 });
    await el.evaluate((e) => e.select?.());
    if (String(value) === '') await this.page.keyboard.press('Backspace');
    else await this.page.keyboard.type(String(value), { delay: 4 });
    if (blur) await this.page.keyboard.press('Tab');
    await sleep(60);
  }
  /** The input inside the `.dz-field` whose label contains the text of an i18n key (or the raw text) */
  async field(labelText, { within = 'body', nth = 0 } = {}) {
    const handle = await this.page.evaluateHandle((labelText, within, nth) => {
      const roots = [...document.querySelectorAll(within)].reverse();
      const hits = [];
      for (const root of roots) {
        for (const f of root.querySelectorAll('.dz-field, label')) {
          const l = f.querySelector('.dz-label') ?? (f.tagName === 'LABEL' ? f.querySelector('span') : null) ?? f;
          const own = (l.textContent || '').replace(/\s+/g, ' ').trim();
          if (own === labelText || own.startsWith(labelText + ' ') || own === labelText.trim()) {
            const input = f.querySelector('input, select, textarea');
            const r = input?.getBoundingClientRect();
            if (input && r.width > 0) hits.push(input);
          }
        }
      }
      return hits[nth] ?? null;
    }, labelText, within, nth);
    const el = handle.asElement();
    if (!el) throw new Error(`no field "${labelText}" in ${within}`);
    return el;
  }
  async pick(selectEl, optionText) {
    const value = await selectEl.evaluate((s, txt) => [...s.options].find((o) => o.textContent.replace(/\s+/g, ' ').trim().startsWith(txt))?.value ?? null, optionText);
    if (value === null) throw new Error(`no option "${optionText}"`);
    await selectEl.select(value);
    await sleep(60);
  }
  /** Open the real compact-layout strip; never bypass layout state through the store. */
  async showDesignPanel(side = 'tree') {
    const strip = await this.page.$(`[data-layout-focus="${side}-strip"]`);
    if (strip) await strip.click();
  }
  /** Reach an action through Tab while verifying modal containment and viewport visibility. */
  async tabTo(selector, within = '.dz-feed-dialog') {
    for (let i = 0; i < 80; i++) {
      const state = await this.page.evaluate((selector, within) => {
        const el = document.activeElement, r = el?.getBoundingClientRect();
        return { inside: !!el?.closest(within), found: !!el?.matches(selector),
          visible: !!r && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth };
      }, selector, within);
      if (!state.inside) throw new Error(`keyboard focus escaped ${within}`);
      if (state.found) {
        if (!state.visible) throw new Error(`${selector} is outside the viewport after Tab`);
        return;
      }
      await this.page.keyboard.press('Tab');
    }
    throw new Error(`${selector} is unreachable by Tab`);
  }
  async text(sel = 'body') { return this.page.evaluate((sel) => document.querySelector(sel)?.innerText ?? '', sel); }
  async press(key, mods = []) {
    for (const m of mods) await this.page.keyboard.down(m);
    await this.page.keyboard.press(key);
    for (const m of mods.reverse()) await this.page.keyboard.up(m);
    await sleep(80);
  }

  // ---- steps --------------------------------------------------------------------------------
  /** One step: run it, then audit the visuals and the console. A thrown error fails the step and
   * ends the scenario (the next steps depend on it); visual and console findings fail it too. */
  async step(name, fn, { audit = '.app, body', settle = 250 } = {}) {
    this.stepName = name;
    this.consoleIssues = [];
    this.consoleAllow = [];
    const problems = [];
    let fatal = false;
    const t0 = Date.now();
    try { await fn(); }
    catch (e) { problems.push(`function: ${e.message}`); fatal = true; }
    await sleep(settle);
    try {
      if (!await waitForPaint(this.page)) problems.push('visual: layout did not complete two animation frames before audit');
      const issues = await this.page.evaluate(auditInPage, audit);
      for (const i of issues) if (!this.auditIgnore.some((re) => re.test(i))) problems.push(`visual: ${i}`);
    } catch (e) { problems.push(`audit failed: ${e.message}`); }
    for (const c of this.consoleIssues) if (!this.consoleAllow.some((re) => re.test(c))) problems.push(c);
    const ms = Date.now() - t0;
    const rec = { scenario: this.scenario, lang: this.lang, step: name, ok: !problems.length, problems, ms };
    if (problems.length) {
      try {
        mkdirSync(failureDir, { recursive: true });
        rec.screenshot = join(failureDir, `${this.scenario}-${this.lang}-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.png`);
        await this.page.screenshot({ path: rec.screenshot });
      } catch { /* the page is gone */ }
    }
    this.results.push(rec);
    console.log(`  ${rec.ok ? 'ok  ' : 'FAIL'} ${this.scenario}/${this.lang} ${name} (${ms} ms)`);
    for (const p of problems) console.log(`         ${p}`);
    if (rec.screenshot) console.log(`         screenshot: ${rec.screenshot}`);
    if (fatal) { const e = new Error(`step "${name}" failed`); e.fatalStep = true; throw e; }
    return rec;
  }
}

/** The audit must catch what it claims to: run it over a page with known faults (and known good). */
export async function auditSelfTest(page) {
  await page.setContent(`<style>
    .skip-link { display:block; width:50px; height:1px; overflow:hidden; white-space:nowrap }
    .skip-link:not(:focus) { width:1px; height:1px; padding:0; margin:-1px; clip:rect(0 0 0 0); border:0 }
    #flyout-parent { position:fixed; left:-40px; top:0; width:50px }
    #flyout-parent > .rb-items { position:absolute; left:0; top:100%; width:200px }
    #scroll-parent { position:relative; width:50px; height:50px }
    #scroll-owner { width:50px; overflow-x:auto }
    #scroll-owner > span { display:block; width:250px }
    #scroll-sibling { position:absolute; left:60px; top:20px; width:140px }
    #scroll-mixed { position:relative; width:50px; height:50px; white-space:nowrap }
    #scroll-mixed-owner { display:inline-block; width:50px; overflow-x:auto; vertical-align:top }
    #scroll-mixed-owner > span { display:block; width:250px }
  </style><body style="margin:0"><div id="root">
    <a id="skip-hidden" class="skip-link" href="#root">skip to workspace</a>
    <a id="skip-focused" class="skip-link" href="#root">focused link must still be audited</a>
    <div id="flyout-parent" class="rb-group" data-collapsed data-open><div id="flyout-popup" class="rb-items">open ribbon commands</div></div>
    <div id="scroll-parent"><div id="scroll-owner"><span>content handled by a nested scroller</span></div><span id="scroll-sibling">unrelated overflow</span></div>
    <div id="scroll-mixed"><div id="scroll-mixed-owner"><span>scroller content</span></div> direct visible text continues beyond parent</div>
    <div id="over" style="width:50px;overflow:visible"><span style="display:block;width:200px">wide child</span></div>
    <div id="clip" style="width:50px;overflow:hidden;white-space:nowrap">a long clipped text without a tooltip</div>
    <div id="tip" title="full text" style="width:50px;overflow:hidden;white-space:nowrap">a long clipped text with a tooltip</div>
    <div id="unrelated-tip" style="width:50px;overflow:hidden;white-space:nowrap">a long clipped text without a tooltip <span title="unrelated tooltip">another item</span></div>
    <div id="scroll" style="width:50px;overflow:auto;white-space:nowrap">a long text in a scroll box</div>
    <p id="key">tree.add.port</p>
    <div role="dialog" style="position:fixed;left:-40px;top:0;width:100px">off screen</div>
  </div></body>`);
  const found = (await page.evaluate(auditInPage, '#root')).join('\n');
  const need = [['overflow: div#over', /overflow: div#over/], ['unrelated sibling overflow beside a scroller', /overflow: div#scroll-parent/], ['own text overflow alongside a valid nested scroller', /overflow: div#scroll-mixed/], ['clipped-no-title', /clipped-no-title: div#clip/], ['unrelated tooltip does not cover clipped text', /clipped-no-title: div#unrelated-tip/], ['raw-i18n-key', /raw-i18n-key: p#key/], ['outside-window', /outside-window: div/], ['outside-window ribbon flyout', /outside-window: div#flyout-popup/]];
  const missing = need.filter(([, re]) => !re.test(found)).map(([n]) => n);
  if (missing.length) throw new Error(`the visual audit missed: ${missing.join(', ')}\n${found}`);
  if (/div#tip "|div#flyout-parent\b/.test(found)) throw new Error(`the visual audit flagged a titled element or open ribbon group wrapper:\n${found}`);
  if (/skip-hidden/.test(found)) throw new Error(`the visual audit flagged an intentionally hidden skip link:\n${found}`);
  await page.focus('#skip-focused');
  const focused = (await page.evaluate(auditInPage, '#root')).join('\n');
  if (!/clipped-no-title: a#skip-focused/.test(focused)) throw new Error(`the visual audit missed a focused clipped skip link:\n${focused}`);
}
