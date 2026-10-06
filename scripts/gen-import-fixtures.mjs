// Write the import fixtures in examples/import-fixtures/: Touchstone and CSV files whose numbers are
// the committed patch antenna's results, shifted by +1 % in frequency, so the comparison metrics
// have known answers.
//
//   node --experimental-strip-types scripts/gen-import-fixtures.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "examples/import-fixtures");
mkdirSync(out, { recursive: true });
const b = JSON.parse(readFileSync(join(root, "public/projects/patch-antenna.json"), "utf8"));
const pr = b.results.ports["1"];
const SHIFT = 1.01;
const f = b.results.frequency.filter((_, i) => i % 4 === 0).map((x) => x * SHIFT); // 201 points
const idx = b.results.frequency.map((_, i) => i).filter((i) => i % 4 === 0);
const re = idx.map((i) => pr.s11_re[i]);
const im = idx.map((i) => pr.s11_im[i]);
const dB = re.map((r, k) => 10 * Math.log10(r * r + im[k] * im[k]));
const g = (v, d = 6) => v.toFixed(d);

// 1. Touchstone at a 75 Ω reference, MHz, DB/angle format (the importer renormalises to 50 Ω)
{
  const z0 = 50, z1 = 75;
  const lines = [
    "! Touchstone fixture, hand-made, 75 ohm reference",
    "! Date: 2026-09-24",
    `# MHz S DB R ${z1}`,
  ];
  f.forEach((x, k) => {
    // Γ at 50 Ω -> Z -> Γ at 75 Ω
    const gr = re[k], gi = im[k];
    const dr = 1 - gr, den = dr * dr + gi * gi;
    const zr = (z0 * ((1 + gr) * dr - gi * gi)) / den, zi = (z0 * (gi * dr + (1 + gr) * gi)) / den;
    const nr = zr - z1, ni = zi, drr = zr + z1, dii = zi;
    const d2 = drr * drr + dii * dii;
    const g1r = (nr * drr + ni * dii) / d2, g1i = (ni * drr - nr * dii) / d2;
    lines.push(`${g(x / 1e6, 6)} ${g(20 * Math.log10(Math.hypot(g1r, g1i)), 9)} ${g((Math.atan2(g1i, g1r) * 180) / Math.PI, 9)}`);
  });
  writeFileSync(join(out, "patch_75ohm.s1p"), lines.join("\n") + "\n");
}

// 2. 2-port Touchstone (MA, GHz, 50 Ω) from the synthetic array: S11 S21 S12 S22 per line
{
  const a = JSON.parse(readFileSync(join(root, "examples/synthetic/array2x1.json"), "utf8"));
  const s = a.results.sparams.s;
  const fa = a.results.frequency;
  const lines = ["! 2-port fixture (synthetic array data), Touchstone v1", "# GHz S MA R 50"];
  const ma = (c, k) => `${g(Math.hypot(c.re[k], c.im[k]), 8)} ${g((Math.atan2(c.im[k], c.re[k]) * 180) / Math.PI, 5)}`;
  fa.forEach((x, k) => { if (k % 8 === 0) lines.push(`${g(x / 1e9, 6)} ${ma(s["1,1"], k)} ${ma(s["2,1"], k)} ${ma(s["1,2"], k)} ${ma(s["2,2"], k)}`); });
  writeFileSync(join(out, "array2x1_synthetic.s2p"), lines.join("\n") + "\n");
}

// 3. generic CSV with semicolons and decimal commas (European spreadsheet), unit in the header
writeFileSync(join(out, "patch_generic_semicolon.csv"),
  "Frequency (GHz);S11 (dB)\n" + f.map((x, k) => `${g(x / 1e9, 6).replace(".", ",")};${g(dB[k], 4).replace(".", ",")}`).join("\n") + "\n");

console.log(`fixtures written to ${out}`);
