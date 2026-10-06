// Robust text handling for imported ASCII data: BOM, CRLF/CR, comment styles, tab/comma/semicolon/
// space separators, decimal commas (semicolon-separated European CSV), scientific notation
// including three-digit exponents such as "6.634e+000".

export function normalise(text: string): string[] {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
}

const NUM = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][-+]?\d+)?$/;

export const isNumber = (s: string) => NUM.test(s.trim());

/** Parse a number token ("1.5e+000", "1,5" when decimal commas are in use, Fortran "1.5D+00"). */
export function toNumber(s: string, decimalComma = false): number {
  let t = s.trim();
  if (decimalComma) t = t.replace(",", ".");
  t = t.replace(/[dD]/, "e");
  return NUM.test(t) ? Number(t) : NaN;
}

export type Delimiter = ";" | "\t" | "," | " ";

/** The line with every double-quoted section blanked out (so quoted commas do not count). */
const unquoted = (t: string) => t.replace(/"(?:[^"]|"")*"?/g, (m) => " ".repeat(m.length));

/** The column separator of a line, by the same precedence as splitFields: semicolon (European CSV,
 * where the comma is the decimal mark), tab, comma, then runs of spaces. Quoted text is ignored. */
export function delimiterOf(line: string): Delimiter {
  const t = unquoted(line.trim());
  return t.includes(";") ? ";" : t.includes("\t") ? "\t" : t.includes(",") ? "," : " ";
}

/** Split one delimited line with CSV quoting (RFC 4180): quoted fields may hold the delimiter and
 * doubled quotes (""), whitespace around unquoted fields is dropped. */
export function splitDelimited(line: string, delim: "," | ";" | "\t"): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && !cur.trim()) {
      quoted = wasQuoted = true;
      cur = "";
    } else if (ch === delim) {
      out.push(wasQuoted ? cur : cur.trim());
      cur = "";
      wasQuoted = false;
    } else if (!(wasQuoted && /\s/.test(ch))) cur += ch;
  }
  out.push(wasQuoted ? cur : cur.trim());
  return out;
}

const DECIMAL_COMMA = /^[-+]?\d+,\d+(?:[eE][-+]?\d+)?$/;

/** Split a data line on tabs, semicolons, commas or runs of spaces (quote-aware for CSV). */
export function splitFields(line: string): { fields: string[]; decimalComma: boolean } {
  const t = line.trim();
  const d = delimiterOf(t);
  if (d === " ") return { fields: t.split(/\s+/), decimalComma: false };
  const fields = splitDelimited(t, d);
  // "1,5;-10,2" is a European CSV with decimal commas (in a comma CSV only a quoted "1,5" can be)
  return { fields, decimalComma: d !== "\t" && fields.some((f) => DECIMAL_COMMA.test(f)) };
}

/**
 * Column names of a header line, split with the delimiter of the data rows below it, so that
 * `Frequency (GHz),S11 Real,S11 Imaginary` gives three names and `"Frequency / GHz","S1,1 [Real
 * Part]"` keeps the quoted comma. Headers that do not use that delimiter are read as
 * quoted names (`#"Frequency / GHz"\t"S1,1 [Magnitude in dB]"`) or names separated by tabs / 2+
 * spaces (`Frequency / GHz        S1,1/abs,dB`, whose commas are part of the name). A leading
 * comment mark (#, %, //) is dropped.
 */
export function splitHeader(line: string, delim: Delimiter): string[] {
  const h = line.trim().replace(/^(?:#|%|\/\/)\s*/, "");
  if (!h) return [];
  if (delim !== " " && unquoted(h).includes(delim)) return splitDelimited(h, delim);
  if (/"/.test(h)) return [...h.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
  return h.split(/\t|\s{2,}/).filter(Boolean);
}

/** The numbers of a line, or null if any field is not numeric (a header or text line). */
export function numericRow(line: string): number[] | null {
  const t = line.trim();
  if (!t) return null;
  const { fields, decimalComma } = splitFields(t);
  const vals = fields.filter((f) => f !== "").map((f) => toNumber(f, decimalComma));
  return vals.length && vals.every(Number.isFinite) ? vals : null;
}

/** Frequency unit from a header such as "Frequency / GHz", "Freq [MHz]", "f_GHz", "(Hz)". */
export function unitScale(header: string): number | null {
  const m = /(?:^|[^a-z])(thz|ghz|mhz|khz|hz)(?![a-z])/i.exec(header);
  if (!m) return null;
  return { hz: 1, khz: 1e3, mhz: 1e6, ghz: 1e9, thz: 1e12 }[m[1].toLowerCase() as "hz"]!;
}

/** Guess a unit from the value range when the file does not say (documented as a guess). */
export function guessScale(fMax: number): { scale: number; unit: string } {
  if (fMax < 1e3) return { scale: 1e9, unit: "GHz" };
  if (fMax < 1e6) return { scale: 1e6, unit: "MHz" };
  return { scale: 1, unit: "Hz" };
}
