import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src", import.meta.url));
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) files.push(path);
  }
}
walk(root);

const nativeDialog = /\bwindow\s*\.\s*(?:confirm|alert|prompt)\s*\(/g;
const matches = files.flatMap((path) => {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(nativeDialog)].map((match) => ({ path, call: match[0] }));
});
assert.deepEqual(matches, [], "browser prompt, confirm and alert must not be used in src");

console.log("check-native-dialogs: ok");
