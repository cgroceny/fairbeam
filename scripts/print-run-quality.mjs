// Prints the run quality verdict (src/lib/runQuality.ts) of every result bundle in a folder as JSON,
// { "file.json": "converged" | "not-converged" | "suspicious" } (bundles without results are left out).
// python/tests/test_run_quality.py compares it with python/fairbeam/cli.py run_quality().
//   node --experimental-strip-types scripts/print-run-quality.mjs [folder]
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runQuality } from "../src/lib/runQuality.ts";

const dir = resolve(process.argv[2] ?? fileURLToPath(new URL("../public/projects/", import.meta.url)));
const out = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json").sort()) {
  const q = runQuality(JSON.parse(readFileSync(resolve(dir, f), "utf8")));
  if (q) out[f] = q.verdict;
}
console.log(JSON.stringify(out));
