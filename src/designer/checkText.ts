// Design checks in the UI language. The checks themselves stay English on both sides
// (python/fairbeam/design_checks.py, the authority, and its browser mirror checks.ts), so their
// parity holds; this module translates at display time, by the check's code:
//
// - explanations: `checks.explain.<code>`, whose English is the check's `explain` text exactly
//   (Python's EXPLANATIONS). A text the table does not know (a newer server) is shown as it is.
// - messages: `checks.msg.<code>.<variant>`, whose English is the message template with {name}
//   placeholders where the check writes a value. The message is matched against each English
//   template of its code; on a match the chosen language's template is filled with the captured
//   values (plain decimals with the locale's decimal separator). No match: the English as it is.
//   A captured value may itself be a phrase with templates of its own,
//   `checks.sub.<code>.<name>.<variant>` (a side of a sheet, "start" / "stop").
// - the server's fix buttons: `checks.fix.<code>.<variant>`, the same way.
//
// In English every function returns the check's own text unchanged.
import en from "../i18n/en.json" with { type: "json" };
import { decimalComma, locale, t, tEn } from "../i18n/index.ts";
import type { Check } from "./checks.ts";

const EN = en as Record<string, unknown>;

/** Captured values that are names, expressions or code, never reformatted as numbers. */
const RAW = new Set(["expr", "name", "names", "other", "under", "comp", "tok", "mode", "detail", "fn", "w", "where", "reason", "dims", "unit"]);

interface Template { key: string; re: RegExp; names: string[]; literal: number }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compile(key: string, text: string): Template {
  const names: string[] = [];
  let src = "", literal = 0, last = 0;
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    const lit = text.slice(last, m.index);
    src += escape(lit);
    literal += lit.length;
    const name = m[1];
    // a value written twice is the same value: a back-reference (a group name can occur once)
    src += names.includes(name) ? `\\k<${name}>` : `(?<${name}>[\\s\\S]*?)`;
    if (!names.includes(name)) names.push(name);
    last = m.index! + m[0].length;
  }
  src += escape(text.slice(last));
  literal += text.length - last;
  return { key, re: new RegExp(`^${src}$`), names, literal };
}

const cache = new Map<string, Template[]>();
/** The English templates under a key prefix, the most specific (longest literal text) first. */
function templates(prefix: string): Template[] {
  let list = cache.get(prefix);
  if (!list) {
    list = Object.keys(EN)
      .filter((k) => k.startsWith(prefix) && typeof EN[k] === "string")
      .map((k) => compile(k, EN[k] as string))
      .sort((a, b) => b.literal - a.literal || a.key.localeCompare(b.key));
    cache.set(prefix, list);
  }
  return list;
}

/** A captured plain number in the locale's notation: 3.185 -> 3,185 and 12,345 -> 12.345 in Turkish
 * (a point "x, y, z" becomes "x; y; z", as a decimal comma would make it ambiguous). Only for the
 * text shown: a fix button's values (`fix.set`) are never touched. */
function localValue(name: string, v: string): string {
  // the decimal separator setting decides (General settings › Decimal separator), not the language alone:
  // with a point chosen the Turkish text keeps the point and its comma thousands, so one text never
  // mixes "9.700" (grouping) with "9,700"
  if (!decimalComma() || RAW.has(name)) return v;
  if (name === "coords") return v.split(", ").map((x) => localValue("", x)).join("; ");
  // a plain decimal, or one with its unit ("1.18 ps"); a negative number takes the typographic minus
  if (/^-?\d+\.\d+( \S+)?$/.test(v)) return v.replace(".", ",").replace(/^-/, "−");
  if (/^-?\d{1,3}(,\d{3})+$/.test(v)) return v.replace(/,/g, ".").replace(/^-/, "−");
  if (/^-\d+( \S+)?$/.test(v)) return v.replace(/^-/, "−");
  return v;
}

/** `text` through the templates under `prefix`, or null when none matches. */
function translate(prefix: string, text: string, code: string, depth = 0): string | null {
  for (const tpl of templates(prefix)) {
    const m = tpl.re.exec(text);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (const name of tpl.names) {
      const v = m.groups?.[name] ?? "";
      params[name] = (depth < 3 && subTranslate(code, name, v, depth + 1)) || localValue(name, v);
    }
    return t(tpl.key, params);
  }
  return null;
}

function subTranslate(code: string, name: string, v: string, depth: number): string | null {
  const prefix = `checks.sub.${code}.${name}.`;
  if (templates(prefix).length) return translate(prefix, v, code, depth);
  // "does not build: …": the build's reason, often a check's own wording
  if (code === "build" && name === "detail") {
    for (const tpl of templates("checks.msg.")) {
      if (!tpl.re.test(v)) continue;
      const other = tpl.key.slice("checks.msg.".length, tpl.key.lastIndexOf("."));
      return translate(`checks.msg.${other}.`, v, other, depth);
    }
  }
  return null;
}

/** The check's message in the UI language. Without a code (an issue already in the UI language)
 * the message as it is; `{ code: "expr", message }` translates an expression error. */
export function checkMessage(c: { code?: string; message: string }): string {
  if (locale() === "en" || !c.code || typeof c.message !== "string") return c.message;
  return translate(`checks.msg.${c.code}.`, c.message, c.code) ?? c.message;
}

/** Why the check matters and how to resolve it, in the UI language (a general hint when the check
 * has no explanation). */
export function checkExplain(c: Pick<Check, "code" | "explain">): string {
  if (c.explain === undefined || c.explain === null) return t("checks.explainFallback");
  if (locale() === "en") return c.explain;
  const key = `checks.explain.${c.code}`;
  const english = EN[key];
  if (typeof english !== "string") return c.explain;
  if (english === c.explain) return t(key);
  // an explanation with a value in it (a failed preview's reason)
  if (/\{\w+\}/.test(english)) return translate(key, c.explain, c.code) ?? c.explain;
  return c.explain;
}

/** The label of the server's fix button, in the UI language. */
export function checkFixLabel(c: Pick<Check, "code" | "fix">): string {
  const label = c.fix?.label ?? "";
  if (locale() === "en" || !label) return label;
  return translate(`checks.fix.${c.code}.`, label, c.code) ?? label;
}

/** For the check scripts: the English template a message matches (key and captured values). */
export function matchCheckMessage(c: Pick<Check, "code" | "message">): { key: string; params: Record<string, string> } | null {
  for (const tpl of templates(`checks.msg.${c.code}.`)) {
    const m = tpl.re.exec(c.message);
    if (m) return { key: tpl.key, params: { ...(m.groups ?? {}) } };
  }
  return null;
}

/** For the check scripts: the English text of a template filled with the given values. */
export const checkTemplateEnglish = (key: string, params: Record<string, string>) => tEn(key, params);

/** A message as a title: its first word capitalised when that is a plain lower-case word ("the port
 * has no length…" -> "The port has no length…"). Names, symbols and numbers stay as they are
 * ("'patch' touches…", "εr must…", "f min must…", "{fn}() takes…"). */
export function sentenceCase(text: string): string {
  const m = /^(\p{Ll}+)(?![\p{L}\p{N}_.(])/u.exec(text);
  if (!m || !/^\p{Script=Latin}+$/u.test(m[1]) || (m[1].length === 1 && !(m[1] === "a" && locale() === "en"))) return text;
  return text.charAt(0).toLocaleUpperCase(locale() === "tr" ? "tr-TR" : "en-US") + text.slice(1);
}

/** The check's message as a list title: translated and sentence-cased. The data keeps the check's
 * own text; this is display only. */
export function checkTitle(c: { code?: string; message: string }): string {
  return sentenceCase(checkMessage(c));
}
