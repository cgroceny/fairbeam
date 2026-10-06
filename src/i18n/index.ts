// The UI language (docs/i18n-glossary.md): a tiny dependency-free layer.
//
//   t("home.title")                          -> "Start" / "Başlangıç"
//   t("home.deleted", { file: "a.json" })    -> interpolates {file}
//   t("tree.parts", { count: 3 })            -> a plural entry { "one": …, "other": … } picks its
//                                               form with Intl.PluralRules; {count} is formatted
//
// Keys are stable ids (area.component.item); English (en.json) is the fallback for a key missing
// in the chosen locale, and the key itself is shown when English lacks it too (a warning in dev
// builds). `locale()` is a Solid signal, so JSX that calls t() re-renders when the language
// changes; never call t() at module top level (a table of labels holds keys, or a function).
//
// Text only: numbers typed into inputs and written to exported files (CSV, Touchstone, .design.json)
// keep their decimal point. `fmt` formats numbers shown as text in the chosen locale.
//
// Imported by modules the checks load straight into Node (--experimental-strip-types), so it
// imports nothing but Solid and the locale files; outside a browser it is always English.
import { createSignal } from "solid-js";
import en from "./en.json" with { type: "json" };
import tr from "./tr.json" with { type: "json" };

export type Locale = "en" | "tr";
export type LanguageChoice = "system" | Locale;
export const LANGUAGE_CHOICES: readonly LanguageChoice[] = ["system", "en", "tr"];
type Entry = string | { one?: string; other: string };
type Table = Record<string, Entry>;
export type Params = Record<string, string | number | null | undefined>;

const TABLES: Record<Locale, Table> = { en: en as Table, tr: tr as Table };
const SETTINGS_KEY = "fairbeam.generalSettings";
const DEV = !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;
// A real page, not a check script: Node has a global `navigator` (with the machine's language) and
// several checks stub `document`, and those must run in English with no DOM work.
const browser = typeof navigator !== "undefined" && typeof HTMLElement === "function" && typeof MutationObserver === "function" &&
  typeof document !== "undefined" && typeof document.documentElement?.querySelectorAll === "function";

/** The OS / browser language, as far as fairbeam has it: Turkish when it is Turkish. */
export function systemLocale(): Locale {
  if (!browser) return "en";
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const l of langs) {
    const base = String(l ?? "").toLowerCase().split(/[-_]/)[0];
    if (base === "tr") return "tr";
    if (base === "en") return "en";
  }
  return "en";
}
export const resolveLocale = (choice: LanguageChoice): Locale => (choice === "system" ? systemLocale() : choice);

/** The saved choice (General settings › Language), read without importing the settings module. */
function savedChoice(): LanguageChoice {
  if (!browser) return "en";
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}")?.language;
    return v === "en" || v === "tr" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

const [choice, setChoiceSignal] = createSignal<LanguageChoice>(savedChoice());
const [locale, setLocaleSignal] = createSignal<Locale>(resolveLocale(choice()));
export { locale, choice as languageChoice };

/** General settings › Decimal separator for numbers shown as text: follow the UI language (comma in
 * Turkish), or always a point, or always a comma. Inputs, expressions and exported data keep the
 * point whatever is chosen (engineering files must stay machine-readable). */
export type DecimalChoice = "language" | "point" | "comma";
function savedDecimals(): DecimalChoice {
  if (!browser) return "language";
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}")?.decimals;
    return v === "point" || v === "comma" ? v : "language";
  } catch {
    return "language";
  }
}
const [decimalChoice, setDecimalChoice] = createSignal<DecimalChoice>(savedDecimals());
export { decimalChoice, setDecimalChoice };
/** Whether numbers shown as text use a decimal comma (and lists of numbers "; "). */
export const decimalComma = (l: Locale = locale()) => decimalChoice() === "comma" || (decimalChoice() === "language" && l === "tr");

/** BCP 47 tag for Intl: tr-TR, en-US */
export const localeTag = (l: Locale = locale()) => (l === "tr" ? "tr-TR" : "en-US");

/** Apply a language choice now (no reload). Saving it is General settings' job. */
export function setLanguage(next: LanguageChoice): void {
  setChoiceSignal(next);
  const l = resolveLocale(next);
  setLocaleSignal(l);
  applyDocumentLanguage(l);
}

function applyDocumentLanguage(l: Locale) {
  if (!browser) return;
  document.documentElement.lang = l;
  // the desktop shell rebuilds its native menus and remembers the language for the splash page
  const native = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
  if (native) void native.invoke("set_language", { lang: l }).catch(() => {});
}
if (browser) {
  applyDocumentLanguage(locale());
  // "System" follows the OS when it changes its language while the app runs
  window.addEventListener("languagechange", () => { if (choice() === "system") setLanguage("system"); });
}

const warned = new Set<string>();
function warn(msg: string) {
  if (!DEV || warned.has(msg)) return;
  warned.add(msg);
  console.warn(`[i18n] ${msg}`);
}

const pluralRules: Partial<Record<Locale, Intl.PluralRules>> = {};
function pick(entry: Entry, l: Locale, params?: Params): string {
  if (typeof entry === "string") return entry;
  const n = Number(params?.count);
  const rules = (pluralRules[l] ??= new Intl.PluralRules(localeTag(l)));
  const form = Number.isFinite(n) ? rules.select(n) : "other";
  return (form === "one" ? entry.one : undefined) ?? entry.other;
}

function interpolate(text: string, l: Locale, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (all, name: string) => {
    const v = params[name];
    if (v === undefined || v === null) return all;
    return typeof v === "number" && name === "count" ? fmt.int(v, l) : String(v);
  });
}

/** Translate `key` in the current locale (reactive), interpolating {name} parameters. */
export function t(key: string, params?: Params): string {
  const l = locale();
  let entry = TABLES[l][key];
  if (entry === undefined) {
    entry = TABLES.en[key];
    if (entry === undefined) { warn(`missing key "${key}"`); return key; }
    if (l !== "en") warn(`"${key}" has no ${l} text; showing English`);
  }
  return interpolate(pick(entry, l, params), l, params);
}

/** English text of a key, whatever the UI language (logs, exported files, matching server text). */
export function tEn(key: string, params?: Params): string {
  const entry = TABLES.en[key];
  if (entry === undefined) { warn(`missing key "${key}"`); return key; }
  return interpolate(pick(entry, "en", params), "en", params);
}

/** Whether a key exists (for optional, code-based translations such as design checks). */
export const hasKey = (key: string, l: Locale = locale()) => TABLES[l][key] !== undefined || TABLES.en[key] !== undefined;

const numberFormats = new Map<string, Intl.NumberFormat>();
function nf(l: Locale, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const id = `${decimalComma(l) ? "comma" : "point"}|${JSON.stringify(opts)}`;
  let f = numberFormats.get(id);
  if (!f) { f = new Intl.NumberFormat(decimalComma(l) ? "tr-TR" : "en-US", opts); numberFormats.set(id, f); }
  return f;
}

/** A negative number shown as text takes the typographic minus (U+2212), as the chart ticks do.
 * Display only: inputs, CSV and every exported file keep the ASCII "-" (they never use `fmt`). */
const typographicMinus = (s: string) => s.replace(/^-/, "\u2212");

/** Numbers and dates shown as text. Never for inputs or exported data. */
export const fmt = {
  /** fixed decimals, like toFixed (no grouping): 2.450 / 2,450; a negative one starts with U+2212 */
  fixed(v: number, digits = 2, l: Locale = locale()): string {
    const s = v.toFixed(digits);
    return typographicMinus(decimalComma(l) ? s.replace(".", ",") : s);
  },
  /** a plain number with up to `digits` decimals (trailing zeros dropped): 2.45 / 2,45 */
  num(v: number, digits = 3, l: Locale = locale()): string {
    const s = String(Number(v.toFixed(digits)));
    return typographicMinus(decimalComma(l) && !/e/i.test(s) ? s.replace(".", ",") : s);
  },
  /** an integer with digit grouping: 1,234,567 / 1.234.567 */
  int(v: number, l: Locale = locale()): string {
    return Number.isFinite(v) ? typographicMinus(nf(l, { maximumFractionDigits: 0 }).format(v)) : String(v);
  },
  /** Intl.NumberFormat with the locale */
  intl(v: number, opts: Intl.NumberFormatOptions = {}, l: Locale = locale()): string {
    return typographicMinus(nf(l, opts).format(v));
  },
  /** a date as text, e.g. 28 Sep / 28 Eyl */
  date(d: Date | number, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }, l: Locale = locale()): string {
    return new Date(d).toLocaleDateString(l === "tr" ? "tr-TR" : "en-GB", opts);
  },
  /** a date and time as text */
  dateTime(d: Date | number, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }, l: Locale = locale()): string {
    return new Date(d).toLocaleString(l === "tr" ? "tr-TR" : "en-GB", opts);
  },
  /** a list: "a, b and c" / "a, b ve c" */
  list(items: string[], l: Locale = locale()): string {
    try { return new Intl.ListFormat(localeTag(l), { type: "conjunction" }).format(items); } catch { return items.join(", "); }
  },
};
