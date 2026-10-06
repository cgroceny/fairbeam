// The UI translations (src/i18n): tr.json has exactly the keys of en.json, with the same {params};
// every key is used somewhere in src/, and every t("literal") names a key that exists. A key built
// at run time (t(`checks.${code}.message`)) counts every key under its literal prefix as used.
// The splash page (src-tauri/splash/index.html) carries its own small table: both languages there
// must have the same keys and parameters too.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const problems = [];
const fail = (msg) => problems.push(msg);
const load = (l) => JSON.parse(readFileSync(join(root, `src/i18n/${l}.json`), "utf8"));
const en = load("en"), tr = load("tr");

const forms = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v) : []);
const params = (v) => new Set(forms(v).flatMap((s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1])));
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const shape = (key, v, l) => {
  if (typeof v === "string") { if (!v.trim()) fail(`${l}.json: "${key}" is empty`); return; }
  if (!v || typeof v !== "object" || typeof v.other !== "string") { fail(`${l}.json: "${key}" must be a string or { "one"?, "other" }`); return; }
  for (const f of Object.keys(v)) if (!["zero", "one", "two", "few", "many", "other"].includes(f)) fail(`${l}.json: "${key}" has an unknown plural form "${f}"`);
};
for (const [key, v] of Object.entries(en)) {
  shape(key, v, "en");
  if (!(key in tr)) { fail(`tr.json lacks "${key}" (en: ${JSON.stringify(v)})`); continue; }
  shape(key, tr[key], "tr");
  const a = params(v), b = params(tr[key]);
  // a plural's "one" form may leave out {count} ("one file" / "bir dosya"); compare the rest
  a.delete("count"); b.delete("count");
  if (!same(a, b)) fail(`"${key}": parameters differ, en {${[...params(v)].join(", ")}} tr {${[...params(tr[key])].join(", ")}}`);
}
for (const key of Object.keys(tr)) if (!(key in en)) fail(`tr.json has "${key}", which en.json lacks`);
for (const key of Object.keys(en)) if (!/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/.test(key)) fail(`"${key}" is not a dotted id (area.item)`);

// ---- usage in the sources
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|mjs|js)$/.test(name)) files.push(p);
  }
};
walk(join(root, "src"));
const literal = new Set();
const prefixes = new Set();
const called = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/(["'`])([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+)\1/g)) literal.add(m[2]);
  for (const m of text.matchAll(/`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)*\.)\$\{/g)) prefixes.add(m[1]);
  if (!f.replaceAll("\\", "/").includes("/src/i18n/")) for (const m of text.matchAll(/\b(?:t|tEn)\(\s*(["'])([^"'\n]+)\1/g)) called.push([relative(root, f), m[2]]);
}
const unused = Object.keys(en).filter((k) => !literal.has(k) && ![...prefixes].some((p) => k.startsWith(p)));
for (const k of unused) fail(`"${k}" is not used in src/ (remove it, or reference the literal key)`);
for (const [f, k] of called) if (!(k in en)) fail(`${f}: t("${k}") names no key in en.json`);

// ---- exported data keeps the decimal point: the writers of files and reports never format for the
// UI language (fmt / localDecimal / t()); they may import only the locale-free numPlain from lib/format
for (const f of files) {
  const rel = relative(root, f).replaceAll("\\", "/");
  if (!/^src\/(export|drawing|fab)\//.test(rel) && rel !== "src/lib/run.ts") continue;
  const text = readFileSync(f, "utf8");
  if (/from\s+["'][^"']*i18n[^"']*["']/.test(text)) fail(`${rel}: exported text must not import the i18n layer (decimal point in every language)`);
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*\/format(?:\.ts)?["']/g))
    for (const name of m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean))
      if (name !== "numPlain") fail(`${rel}: imports "${name}" from lib/format; exports use numPlain (decimal point)`);
}

// ---- the splash page's own table
const splash = readFileSync(join(root, "src-tauri/splash/index.html"), "utf8");
const table = splash.match(/const TEXT = (\{[\s\S]*?\n {2}\});/);
if (!table) fail("splash: no `const TEXT = { en: {…}, tr: {…} };` table");
else {
  const text = Function(`"use strict"; return (${table[1]});`)();
  for (const k of Object.keys(text.en)) {
    if (!(k in text.tr)) fail(`splash: tr lacks "${k}"`);
    else if (!same(params(text.en[k]), params(text.tr[k]))) fail(`splash: "${k}" parameters differ`);
  }
  for (const k of Object.keys(text.tr)) if (!(k in text.en)) fail(`splash: en lacks "${k}"`);
  const used = new Set([...splash.matchAll(/\bL\(\s*"([^"]+)"/g)].map((m) => m[1]));
  for (const k of used) if (!(k in text.en)) fail(`splash: L("${k}") names no key`);
}

if (problems.length) {
  console.error(`check-i18n: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-i18n: ${Object.keys(en).length} keys, en and tr agree; all used (${files.length} source files)`);
