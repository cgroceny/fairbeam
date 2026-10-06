// Curve files: generic CSV / text tables with one or more curves (|S11| in dB, linear magnitude,
// phase, real / imaginary part). The header is split with the delimiter of the data rows (comma,
// semicolon, tab, with CSV quoting), and each column is classified by name:
//   Frequency (GHz),S11 Real,S11 Imaginary        -> complex S11
//   "Freq [MHz]";"|S11| (dB)";"Phase (deg)"       -> dB magnitude + phase (decimal commas allowed)
//   f (GHz)<tab>Re(S11)<tab>Im(S11)<tab>S21_re<tab>S21_im -> a complex curve per S-parameter
// A real-part column is paired with the next imaginary-part column of the same S-parameter. Several
// curves can follow each other, each with its own header block (a text line after data starts the
// next block); a dashed rule line is skipped.

import { delimiterOf, guessScale, normalise, numericRow, splitHeader, unitScale, type Delimiter } from "./text.ts";
// thrown errors are shown in the UI (translated); warnings become reference notes, which go into
// exported reports and packages, so they stay English
import { t as msg } from "../i18n/index.ts";

export type CurveQuantity = "db" | "linear" | "phase" | "re" | "im" | "complex";

export interface Curve {
  name: string;
  quantity: CurveQuantity;
  /** Hz */
  f: number[];
  y: number[];
  /** second column for "complex" (imaginary part) */
  y2?: number[];
  /** S-parameter indices when the name is S<i>,<j> */
  pair: [number, number] | null;
}

/** `word` as a whole token: "S11_re", "Re(S11)", "S11 Im" but not "Return" or "Impedance". */
const token = (t: string, words: string) => new RegExp(`(?:^|[^a-z])(?:${words})(?![a-z])`).test(t);

function quantityOf(h: string): CurveQuantity | null {
  const t = h.toLowerCase();
  if (/magnitude in db|abs,\s*db|\/\s*db\b|\[db\]|\(db\)/.test(t) || token(t, "db")) return "db";
  if (/phase|\/arg|degrees|°/.test(t) || token(t, "arg|deg|ang|angle|rad|radians?")) return "phase";
  if (/real part|\/re\b|\bre\(/.test(t) || token(t, "re|real")) return "re";
  if (/imaginary part|\/im\b|\bim\(|\bimag/.test(t) || token(t, "im|imag")) return "im";
  if (/magnitude|\/abs\b|\blin|\|\s*s\s*\(?\d/.test(t) || token(t, "abs|mag")) return "linear";
  return null;
}

/** A phase column in radians ("Phase (rad)", "arg S11 [radians]"); degrees otherwise. */
const inRadians = (h: string) => token(h.toLowerCase(), "rad|radians?") && !/deg|°/i.test(h);

function pairOf(h: string): [number, number] | null {
  const m = /S\s*-?\s*\(?\s*(\d+)\s*[,_ ]\s*(\d+)/i.exec(h) ?? /(?:^|[^a-z])S(\d)(\d)(?!\d)/i.exec(h);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const samePair = (a: [number, number] | null, b: [number, number] | null) => !a || !b || (a[0] === b[0] && a[1] === b[1]);

/** Display name: the column name without its unit ("S1,1 [Magnitude in dB]", "S1,1/abs,dB",
 * "S11 Phase (deg)" -> "S1,1", "S1,1", "S11 Phase"); a parenthesis naming the S-parameter stays. */
function cleanName(n: string): string {
  const t = n
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .replace(/\/.*$/, "")
    .replace(/\s*\(([^)]*)\)\s*$/, (m, inner: string) => (/s\s*\(?\d/i.test(inner) ? m : ""))
    .trim();
  return t || n.trim();
}

/** Fit header names to the data columns: an unquoted "S1,1" split by a comma delimiter is joined
 * back ("S1" + "1 Real"), and empty names from a trailing delimiter are dropped. */
function fitNames(names: string[], nCols: number): string[] {
  const out = [...names];
  while (out.length > nCols && out[out.length - 1] === "") out.pop();
  for (let i = 0; out.length > nCols && i < out.length - 1; ) {
    if (/(?:^|[^a-z])s\s*\(?\s*\d+$/i.test(out[i]) && /^\d+(?!\d)/.test(out[i + 1])) out.splice(i, 2, `${out[i]},${out[i + 1]}`);
    else i++;
  }
  return out;
}

/** Parse a CSV / text table (one or more curves). */
export function parseCurves(text: string, opt: { guessUnit?: boolean } = {}): { curves: Curve[]; warnings: string[] } {
  const warnings: string[] = [];
  const curves: Curve[] = [];
  let header: string[] = [];
  let rows: number[][] = [];
  let delim: Delimiter = " ";
  const flush = () => {
    if (!rows.length) return;
    // the last header line holds the column names, split with the data rows' delimiter (CSV) or,
    // for a text table, quoted names or tabs / 2+ spaces
    const h = header[header.length - 1] ?? "";
    const nCols = rows[0].length;
    const names = fitNames(splitHeader(h, delim), nCols);
    if (names.length && names.length !== nCols) warnings.push(`The header "${h.slice(0, 60)}" has ${names.length} column names for ${nCols} data columns: names matched from the left`);
    let scale = unitScale(names[0] ?? "") ?? unitScale(header.join(" "));
    if (!scale) {
      const g = opt.guessUnit ? guessScale(Math.max(...rows.map((r) => r[0]))) : { scale: 1e9, unit: "GHz" };
      warnings.push(`No frequency unit in the header${h ? ` "${h.slice(0, 60)}"` : ""}: ${opt.guessUnit ? "guessed" : "assumed"} ${g.unit}`);
      scale = g.scale;
    }
    const sc = scale;
    const f = rows.map((r) => r[0] * sc);
    const cols = rows[0].slice(1).map((_, k) => {
      const name = names[k + 1] || `column ${k + 2}`;
      const q = quantityOf(name);
      let y = rows.map((r) => r[k + 1]);
      if (q === "phase" && inRadians(name)) {
        y = y.map((v) => (v * 180) / Math.PI);
        warnings.push(`"${name}": phase in radians, converted to degrees`);
      }
      return { name, q, y, pair: pairOf(name) };
    });
    const used = new Set<number>();
    cols.forEach((c, i) => {
      if (used.has(i)) return;
      if (c.q === "re") {
        // real and imaginary part of one S-parameter make one complex curve; never fall back to dB
        const j = cols.findIndex((d, k) => k > i && !used.has(k) && d.q === "im" && samePair(c.pair, d.pair));
        if (j >= 0) {
          used.add(j);
          const pair = c.pair ?? cols[j].pair;
          const name = pair ? `S${pair[0]},${pair[1]}` : cleanName(c.name).replace(/[\s_]*(?:real(?:\s*part)?|re)$/i, "") || cleanName(c.name);
          curves.push({ name, quantity: "complex", f, y: c.y, y2: cols[j].y, pair });
          return;
        }
      }
      if (!c.q) warnings.push(`Unknown quantity "${c.name}": read as dB magnitude. Name the columns (e.g. "S11 (dB)", "S11 Phase (deg)", "S11 Real" and "S11 Imaginary") to import them as intended`);
      curves.push({ name: cleanName(c.name), quantity: c.q ?? "db", f, y: c.y, pair: c.pair });
    });
    rows = [];
    header = [];
  };
  for (const raw of normalise(text)) {
    const line = raw.trim();
    if (!line) continue;
    const nums = numericRow(line);
    if (nums) {
      if (rows.length && nums.length !== rows[0].length) throw new Error(msg("import.error.columnCount", { line: line.slice(0, 40) }));
      if (!rows.length) delim = delimiterOf(line);
      rows.push(nums);
      continue;
    }
    if (/^#?\s*-{5,}/.test(line)) continue; // dashed rule
    if (/^#\s*parameters\s*=/i.test(line)) {
      flush();
      continue;
    }
    // a text line after data starts a new curve block
    if (rows.length) flush();
    header.push(line);
  }
  flush();
  if (!curves.length) throw new Error(msg("import.error.noData"));
  return { curves, warnings };
}
