// The Windows installer's version info: Tauri's NSIS template writes no CompanyName, so
// src-tauri/windows/installer-hooks.nsh adds it as plain text (the hooks are included before the
// template defines ${MANUFACTURER}). It must stay equal to bundle.publisher, and bundle.copyright
// must be set for LegalCopyright in the installer and in fairbeam.exe.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path) => readFileSync(fileURLToPath(new URL(`../src-tauri/${path}`, import.meta.url)), "utf8");
const bundle = JSON.parse(read("tauri.conf.json")).bundle;
const hooks = read("windows/installer-hooks.nsh");

assert.ok(bundle.publisher, "bundle.publisher is set");
assert.match(bundle.copyright ?? "", /^Copyright © \d{4} \S/, "bundle.copyright is set");
const company = [...hooks.matchAll(/^\s*VIAddVersionKey\s+"CompanyName"\s+"([^"]*)"/gm)].map((match) => match[1]);
assert.deepEqual(company, [bundle.publisher], "installer-hooks.nsh writes CompanyName once, equal to bundle.publisher");
assert.doesNotMatch(hooks, /^\s*VIAddVersionKey\s+"(ProductName|FileDescription|LegalCopyright|FileVersion|ProductVersion)"/m,
  "the template already writes these keys; a second VIAddVersionKey would fail the build");

console.log(`check-installer-info: CompanyName "${bundle.publisher}", ${bundle.copyright}`);
