import { paramKeyError, paramValues } from "./expr.ts";
import type { DesignParam } from "./types.ts";

export type TransferRow = { key: string; expression: string; evaluated: string; unit: string; description: string };
export type PreviewRow = { row: number; key: string; kind: "added" | "changed" | "unchanged" | "error"; message?: string; param?: DesignParam };
const fields = ["key", "expression", "evaluated", "unit", "description"] as const;

export function csvCell(value: string): string { return `"${value.replace(/"/g, '""')}"`; }
export function exportCsv(rows: TransferRow[]): string { return [fields.join(","), ...rows.map((r) => fields.map((k) => csvCell(r[k])).join(","))].join("\r\n"); }
export function exportJson(rows: TransferRow[]): string { return JSON.stringify(rows, null, 2); }

/** RFC 4180 style quoted fields, including escaped quotes and embedded line breaks. */
export function parseCsv(text: string): TransferRow[] {
  text = text.replace(/^\uFEFF/, "");
  const table: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') {
      if (cell) throw new Error(`Unexpected quote at character ${i + 1}.`);
      quoted = true;
    } else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); table.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error("CSV ends inside a quoted field.");
  if (cell || row.length) { row.push(cell); table.push(row); }
  if (!table.length || table[0].map((x) => x.trim().toLowerCase()).join(",") !== fields.join(",")) throw new Error(`CSV header must be: ${fields.join(", ")}.`);
  return table.slice(1).filter((r) => !(r.length === 1 && !r[0])).map((r, i) => {
    if (r.length !== fields.length) throw new Error(`CSV row ${i + 2} must have ${fields.length} columns.`);
    return Object.fromEntries(fields.map((k, j) => [k, r[j]])) as TransferRow;
  });
}

export function parseTransfer(text: string, format: "csv" | "json"): TransferRow[] {
  if (format === "csv") return parseCsv(text);
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!Array.isArray(value)) throw new Error("JSON must be an array of parameter objects.");
  return value.map((v, i) => {
    if (!v || typeof v !== "object" || fields.some((k) => typeof (v as Record<string, unknown>)[k] !== "string")) throw new Error(`JSON row ${i + 1} must contain string fields: ${fields.join(", ")}.`);
    return Object.fromEntries(fields.map((k) => [k, (v as Record<string, string>)[k]])) as TransferRow;
  });
}

export function previewTransfer(rows: TransferRow[], current: DesignParam[]): PreviewRow[] {
  const seen = new Set<string>(), existing = new Map(current.map((p) => [p.key, p]));
  const existingCounts = new Map<string, number>();
  current.forEach((p) => existingCounts.set(p.key, (existingCounts.get(p.key) ?? 0) + 1));
  const candidates = rows.map((r, i): PreviewRow => {
    const key = r.key.trim();
    const badKey = paramKeyError(key);
    if (badKey) return { row: i + 1, key, kind: "error", message: badKey };
    if (seen.has(key)) return { row: i + 1, key, kind: "error", message: "Duplicate key in import." };
    seen.add(key);
    if ((existingCounts.get(key) ?? 0) > 1) return { row: i + 1, key, kind: "error", message: "This key is duplicated in the current design." };
    const old = existing.get(key);
    const expression = r.expression.trim();
    if (!expression) return { row: i + 1, key, kind: "error", message: "Expression is required." };
    const literal = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(expression);
    const param: DesignParam = { ...(old ?? { key }), key, ...(literal ? { default: Number(expression) } : { expr: expression }) };
    if (literal) delete param.expr;
    else delete param.default;
    if (r.unit) param.unit = r.unit; else delete param.unit;
    if (r.description) param.description = r.description; else delete param.description;
    const kind = !old ? "added" : old.default === param.default && old.expr === param.expr && old.unit === param.unit && old.description === param.description ? "unchanged" : "changed";
    return { row: i + 1, key, kind, param };
  });
  // Check the complete proposal in file order: later imported rows may depend on earlier ones.
  const valid = candidates.filter((r) => r.param);
  const proposed = current.map((p) => valid.find((r) => r.key === p.key)?.param ?? p);
  for (const r of valid) if (!existing.has(r.key)) proposed.push(r.param!);
  const errs = paramValues(proposed).errors;
  return candidates.map((r) => errs[r.key] && r.kind !== "error" ? { ...r, kind: "error", message: errs[r.key], param: undefined } : r);
}
