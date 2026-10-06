// Number inputs are locale-proof: no <input type="number"> is left in src/ (its text follows the
// WebView's region, "0,867" in Turkish), and NumberField -- a text input that always shows a
// point -- parses "2,45" as 2.45, steps with the arrow keys, honours min / max, and reads ""
// for anything that is not a number, like type=number did.
//
//   node --experimental-strip-types scripts/check-number-inputs.mjs
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachNumberInput, cleanNumberText, normalizeNumberText, numberIssue, parseNumber, stepNumberText } from '../src/lib/numberField.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

// --- parsing
assert.equal(parseNumber('2.45'), 2.45);
assert.equal(parseNumber('2,45'), 2.45, 'a typed comma is a decimal separator');
assert.equal(parseNumber(' 0,867 '), 0.867);
assert.equal(parseNumber('1e-3'), 0.001);
assert.equal(parseNumber('1,5E3'), 1500);
assert.equal(parseNumber('-.5'), -0.5);
assert.equal(parseNumber('+3'), 3);
assert.equal(parseNumber('2.'), 2, 'a trailing separator is a number in progress');
assert.equal(parseNumber(''), null, 'empty');
assert.equal(parseNumber('   '), null);
for (const bad of ['abc', '-', '.', '1e', '1,2,3', '1.2.3', '1,234.5', '2 5', '--1', 'Infinity', '1e999', '0x10']) {
  assert.equal(normalizeNumberText(bad), null, `"${bad}" is not a number`);
  assert.equal(parseNumber(bad), null);
}
assert.equal(normalizeNumberText('2,45'), '2.45');
assert.equal(normalizeNumberText(''), '');
assert.equal(cleanNumberText('2,45').text, '2.45');
assert.equal(cleanNumberText('1a2b,5', 4).text, '12.5');
assert.equal(cleanNumberText('1a2b,5', 4).caret, 2, 'the caret moves back over the removed letters');

// --- min / max
assert.equal(numberIssue('5', { min: 1, max: 10 }), null);
assert.equal(numberIssue('0,5', { min: 1, max: 10 }), 'underflow');
assert.equal(numberIssue('11', { min: 1, max: 10 }), 'overflow');
assert.equal(numberIssue('1', { min: 1, max: 10 }), null, 'the limits are inclusive');
assert.equal(numberIssue('x', { min: 1 }), 'bad');
assert.equal(numberIssue('', { min: 1 }), null, 'empty is not an error');

// --- arrow stepping
assert.equal(stepNumberText('5', 1, { min: 1, max: 10, step: 1 }), '6');
assert.equal(stepNumberText('5', -1, { min: 1, max: 10, step: 1 }), '4');
assert.equal(stepNumberText('10', 1, { min: 1, max: 10, step: 1 }), '10', 'clamped to max');
assert.equal(stepNumberText('1', -1, { min: 1, max: 10, step: 1 }), '1', 'clamped to min');
assert.equal(stepNumberText('2,5', 1, { step: 'any' }), '3.5', 'step="any" steps by 1');
assert.equal(stepNumberText('0.1', 1, { step: 0.5 }), '0.5', 'off the grid it lands on the grid');
assert.equal(stepNumberText('-3', 1, { min: -60, max: 20, step: 5 }), '0');
assert.equal(stepNumberText('-60', -1, { min: -60, max: 20, step: 0.5 }), '-60');
assert.equal(stepNumberText('0.1', 1, { step: 0.1 }), '0.2');
assert.equal(stepNumberText('0.2', 1, { step: 0.1 }), '0.3', 'no float noise');
assert.equal(stepNumberText('', 1, { min: 1, step: 1 }), '1', 'from empty, up lands on min');
assert.equal(stepNumberText('abc', 1, { step: 5 }), '5', 'from garbage it starts at 0');
assert.equal(stepNumberText('3', 1), '4', 'no attributes: by 1');
assert.equal(stepNumberText('4', -1, { min: 1, step: 1000 }), '1', 'below the first grid point clamps');
assert.equal(stepNumberText('-10', 1, { max: -10, step: 5 }), '-10');

// --- the element wiring, on a stand-in with a real value accessor on its prototype
class FakeInput extends EventTarget {
  #v = ''; #attrs = new Map(); selectionStart = 0; disabled = false; readOnly = false; validity = '';
  ownerDocument = { activeElement: null };
  get value() { return this.#v; }
  set value(v) { this.#v = String(v); this.selectionStart = this.#v.length; }
  getAttribute(n) { return this.#attrs.has(n) ? this.#attrs.get(n) : null; }
  setAttribute(n, v) { this.#attrs.set(n, String(v)); }
  removeAttribute(n) { this.#attrs.delete(n); }
  setCustomValidity(m) { this.validity = m; }
  setSelectionRange(a) { this.selectionStart = a; }
}
const make = (attrs = {}) => {
  const el = new FakeInput();
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  const bads = [];
  const detach = attachNumberInput(el, (b) => bads.push(b));
  return { el, bads, detach };
};
const type = (el, text) => { el.value = ''; el.value = text; el.selectionStart = text.length; el.dispatchEvent(new Event('input', { bubbles: true })); };
const key = (el, k, extra = {}) => {
  const ev = Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), { key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });
  el.dispatchEvent(ev);
  return ev;
};

{
  const { el, bads } = make({ min: '1', max: '10', step: '1' });
  const seen = [];
  el.addEventListener('input', () => seen.push(['input', el.value]));
  el.addEventListener('change', () => seen.push(['change', el.value]));

  type(el, '2,5');
  assert.equal(el.value, '2.5', 'the value handlers read has a point');
  assert.equal(Object.getOwnPropertyDescriptor(FakeInput.prototype, 'value').get.call(el), '2.5', 'and so does the displayed text');
  assert.equal(el.valueAsNumber, 2.5);
  type(el, 'abc');
  assert.equal(el.value, '', 'letters are dropped');
  type(el, '1,2,3');
  assert.equal(el.value, '', 'not a number reads as empty, like type=number');
  assert.equal(el.getAttribute('data-bad-input'), 'true');
  assert.equal(el.validity, 'not a number');
  assert.equal(bads.at(-1), true, 'the owner hears about bad text');
  assert.ok(Number.isNaN(el.valueAsNumber));
  type(el, '4');
  assert.equal(el.getAttribute('data-bad-input'), null);
  assert.equal(bads.at(-1), false, 'and that it is fine again');
  type(el, '11');
  assert.equal(el.value, '11', 'an out-of-range number is kept for the panel to judge');
  assert.equal(el.validity, 'above the maximum');
  type(el, '1e-3');
  assert.equal(el.value, '1e-3');
  assert.equal(el.validity, 'below the minimum');

  // arrows step, clamp, and report an input event then a change event
  type(el, '9');
  seen.length = 0;
  const up = key(el, 'ArrowUp');
  assert.ok(up.defaultPrevented);
  assert.equal(el.value, '10');
  assert.deepEqual(seen, [['input', '10'], ['change', '10']]);
  key(el, 'ArrowUp');
  assert.equal(el.value, '10', 'stops at max');
  type(el, '1,5');
  key(el, 'ArrowDown');
  assert.equal(el.value, '1', 'the grid point below, clamped to min');
  key(el, 'ArrowDown');
  assert.equal(el.value, '1', 'stops at min');
  assert.equal(key(el, 'ArrowUp', { shiftKey: true }).defaultPrevented, false, 'modified arrows are left alone');
  el.disabled = true;
  assert.equal(key(el, 'ArrowUp').defaultPrevented, false, 'a disabled field does not step');
  el.disabled = false;

  // a panel that mirrors "" back (half-typed text) must not wipe what is being typed
  type(el, '1.2.');
  assert.equal(el.value, '');
  el.value = '';
  assert.equal(Object.getOwnPropertyDescriptor(FakeInput.prototype, 'value').get.call(el), '1.2.', 'the text survives');
  el.value = '3';
  assert.equal(Object.getOwnPropertyDescriptor(FakeInput.prototype, 'value').get.call(el), '3', 'a different value replaces it');

  // the panel resetting the value clears the bad-input state
  type(el, 'zz1,2,3');
  el.value = '5';
  assert.equal(el.getAttribute('data-bad-input'), null);
}
{
  const { el, detach } = make({ step: 'any' });
  el.value = '0,5';
  assert.equal(el.value, '0.5', 'an assigned comma reads back with a point');
  key(el, 'ArrowUp');
  assert.equal(el.value, '1.5');
  el.valueAsNumber = 7.25;
  assert.equal(el.value, '7.25');
  detach();
  assert.equal(el.value, '7.25', 'detached, the plain accessor is back');
  assert.equal(Object.hasOwn(el, 'value'), false);
}

// --- no type="number" left in src/
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(tsx?|jsx?|html|css|mjs)$/.test(name)) files.push(path);
  }
})(join(root, 'src'));
const numberType = /type\s*=\s*\{?\s*["'`]number["'`]|\[type\s*=\s*["']?number/;
const hits = files.filter((f) => numberType.test(readFileSync(f, 'utf8')));
assert.deepEqual(hits.map((f) => f.slice(root.length)), [], 'use <NumberField> instead of a number-type input');
assert.ok(files.length > 50, 'the scan saw the sources');

// every panel that lost one imports NumberField, and the old lang="en" guard is gone
const users = files.filter((f) => /<NumberField\b/.test(readFileSync(f, 'utf8')) && !/(numberField\.ts|NumberField\.tsx)$/.test(f));
assert.ok(users.length >= 11, `NumberField is used in ${users.length} files`);
for (const f of users) assert.match(readFileSync(f, 'utf8'), /import NumberField from /, `${f} imports NumberField`);
assert.equal(/pinNumberInputs/.test(readFileSync(join(root, 'src/i18n/index.ts'), 'utf8')), false);

console.log(`number inputs ok: parsing, min/max, arrow stepping, element wiring, no type="number" in ${files.length} source files (${users.length} use NumberField)`);
