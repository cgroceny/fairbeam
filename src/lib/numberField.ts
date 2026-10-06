// Locale-proof number entry (the engine behind <NumberField>).
//
// A number-type input shows and edits its value in the WebView's locale ("0,867" with a
// Turkish region), which clashes with the expressions next to it ("f0 * 1.3") and with the
// machine-readable values the app stores. NumberField is a plain text input that ALWAYS shows a
// point, accepts a typed or pasted comma as the decimal separator (Turkish keyboards) and turns
// it into a point, and keeps the parts of type=number the panels rely on:
//   - `.value` reads "" while the text is empty or is not a number (what type=number reported),
//     otherwise the point-separated text; `.valueAsNumber` reads the number or NaN
//   - ArrowUp / ArrowDown step by the `step` attribute (1 for "any"), clamped to min / max
//   - out-of-range or unparsable text sets a custom validity (so :invalid and checkValidity() work)
// The display setting "Decimal separator" only affects rendered text elsewhere, never these inputs.

/** the `pattern` attribute of a number field: an optionally signed decimal with an optional exponent */
export const NUMBER_PATTERN = "[+\\-]?[0-9]*[.,]?[0-9]*([eE][+\\-]?[0-9]+)?";
const NUMBER_RE = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)([eE][+-]?\d+)?$/;

/** the point-separated text of a number entry: "" when empty, null when it is not a number.
 *  "2,45" -> "2.45", " 1e-3 " -> "1e-3", "2,4,5" / "abc" / "1e" / "-" -> null */
export function normalizeNumberText(raw: string): string | null {
  const s = raw.trim();
  if (s === "") return "";
  if (!NUMBER_RE.test(s)) return null;
  const n = s.replace(",", ".");
  return Number.isFinite(Number(n)) ? n : null;
}

/** the number typed, or null when the entry is empty or not a number */
export function parseNumber(raw: string): number | null {
  const s = normalizeNumberText(raw);
  return s === null || s === "" ? null : Number(s);
}

/** what the entry is doing wrong against its limits, or null: "bad" (not a number),
 *  "underflow" (below min), "overflow" (above max). An empty entry is fine. */
export function numberIssue(raw: string, limits: { min?: number | null; max?: number | null } = {}): "bad" | "underflow" | "overflow" | null {
  const s = normalizeNumberText(raw);
  if (s === null) return "bad";
  if (s === "") return null;
  const n = Number(s);
  if (limits.min != null && Number.isFinite(limits.min) && n < limits.min) return "underflow";
  if (limits.max != null && Number.isFinite(limits.max) && n > limits.max) return "overflow";
  return null;
}

/** `text` with a number's characters only, a comma turned into a point. Keeps the caret honest:
 *  `caret` is mapped to its place in the cleaned text. */
export function cleanNumberText(text: string, caret: number = text.length): { text: string; caret: number } {
  const clean = (s: string) => s.replace(/,/g, ".").replace(/[^0-9.eE+-]/g, "");
  return { text: clean(text), caret: clean(text.slice(0, caret)).length };
}

/** the text after an ArrowUp (+1) / ArrowDown (-1): one `step` (1 for "any"), landing on the step
 *  grid that starts at `min` (or 0), clamped to min / max, without float noise (0.1 + 0.2 -> "0.3"). */
export function stepNumberText(raw: string, dir: 1 | -1, o: { min?: number | null; max?: number | null; step?: number | "any" | null } = {}): string {
  const step = o.step === "any" || o.step == null || !(o.step > 0) ? 1 : o.step;
  const grid = o.step === "any" || o.step == null ? null : (o.min != null && Number.isFinite(o.min) ? o.min : 0);
  const n = parseNumber(raw) ?? 0;
  let next = n + dir * step;
  if (grid !== null) {
    // off the grid, the first press goes to the nearest grid point in that direction (2.3 -> 3 with step 1)
    const k = (n - grid) / step;
    if (Math.abs(k - Math.round(k)) > 1e-9) next = grid + (dir > 0 ? Math.ceil(k) : Math.floor(k)) * step;
  }
  if (o.max != null && Number.isFinite(o.max) && next > o.max) next = o.max;
  if (o.min != null && Number.isFinite(o.min) && next < o.min) next = o.min;
  return String(Number(next.toPrecision(12)));
}

const numAttr = (el: Element, name: string): number | null => {
  const v = el.getAttribute(name);
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const stepAttr = (el: Element): number | "any" | null => {
  const v = el.getAttribute("step");
  if (v == null) return null;
  return v.trim().toLowerCase() === "any" ? "any" : numAttr(el, "step");
};

function findAccessor(el: object, name: string): PropertyDescriptor | undefined {
  for (let o: object | null = el; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, name);
    if (d) return d;
  }
  return undefined;
}

/** Turns a text <input> into a number field (see the file comment). `onBad` hears whether the text
 *  is currently not a number. Returns a function that undoes the wiring. */
export function attachNumberInput(el: HTMLInputElement, onBad?: (bad: boolean) => void): () => void {
  const valueAcc = findAccessor(el, "value");
  if (!valueAcc?.get || !valueAcc.set) return () => {};
  const rawGet = () => valueAcc.get!.call(el) as string;
  const rawSet = (v: string) => valueAcc.set!.call(el, v);

  let bad = false;
  const validate = () => {
    const issue = numberIssue(rawGet(), { min: numAttr(el, "min"), max: numAttr(el, "max") });
    const nowBad = issue === "bad";
    el.setCustomValidity?.(issue === "bad" ? "not a number" : issue === "underflow" ? "below the minimum" : issue === "overflow" ? "above the maximum" : "");
    if (nowBad) el.setAttribute("data-bad-input", "true"); else el.removeAttribute("data-bad-input");
    if (nowBad !== bad) { bad = nowBad; onBad?.(bad); }
  };

  // like type=number: "" for anything that is not a number, otherwise the point-separated text
  Object.defineProperty(el, "value", {
    configurable: true, enumerable: true,
    get: () => normalizeNumberText(rawGet()) ?? "",
    set: (v: unknown) => {
      // A panel that mirrors what it read back ("" for half-typed text such as "1.2." or "-") must not
      // wipe the text being typed: assigning what `.value` already reads leaves the text alone.
      const next = String(v ?? "");
      if (next !== (normalizeNumberText(rawGet()) ?? "")) rawSet(next);
      validate();
    },
  });
  Object.defineProperty(el, "valueAsNumber", {
    configurable: true, enumerable: true,
    get: () => parseNumber(rawGet()) ?? NaN,
    set: (v: number) => { rawSet(Number.isFinite(v) ? String(v) : ""); validate(); },
  });

  // runs on the element itself, before any (delegated) handler of the panel reads the value
  const onInput = () => {
    const raw = rawGet();
    const c = cleanNumberText(raw, el.selectionStart ?? raw.length);
    if (c.text !== raw) {
      const focused = el.ownerDocument?.activeElement === el;
      rawSet(c.text);
      if (focused) { try { el.setSelectionRange(c.caret, c.caret); } catch { /* not selectable */ } }
    }
    validate();
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    if (el.disabled || el.readOnly) return;
    e.preventDefault();
    rawSet(stepNumberText(rawGet(), e.key === "ArrowUp" ? 1 : -1, { min: numAttr(el, "min"), max: numAttr(el, "max"), step: stepAttr(el) }));
    validate();
    // type=number reports a step as an input event followed by a change event
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  el.addEventListener("input", onInput);
  el.addEventListener("keydown", onKey);
  validate();
  return () => {
    el.removeEventListener("input", onInput);
    el.removeEventListener("keydown", onKey);
    delete (el as unknown as Record<string, unknown>).value;
    delete (el as unknown as Record<string, unknown>).valueAsNumber;
  };
}
