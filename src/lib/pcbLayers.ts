// The logic of the "Import PCB artwork" dialog (src/components/PcbImportDialog.tsx) that needs no
// page: the size limits the server enforces (python/fairbeam/server.py MAX_PCB_*), the layer key the
// server's layer map is keyed by, the role choices of a layer, the reason a role was picked, and
// the import options built from the dialog's text fields. Plain functions, so that
// scripts/check-pcb-import.mjs can run them.
import type { PcbLayer, PcbOptions, PcbRole } from "../runner/api.ts";
import { parseNumber } from "./numberField.ts";   // the number entry's own parser: a point, or a comma typed in Turkish

/** The limits of POST /api/import/pcb: python/fairbeam/server.py MAX_PCB_FILES / MAX_PCB_FILE / MAX_PCB_TOTAL
 * (scripts/check-pcb-import.mjs compares them). */
export const PCB_LIMITS = { files: 12, file: 8_000_000, total: 16_000_000 } as const;

export const PCB_ROLES: readonly PcbRole[] = ["top_copper", "bottom_copper", "outline", "ignore", "top_clearance", "bottom_clearance"];

/** The part of an artwork file name that names its layer (export_patch-F_Cu.dxf, board.GTL, x-B_Cu_Antipad, x-PTH.drl). */
const LAYER_SUFFIX = /[-_. ]+(?:(?:F|B|In\d+)[._]Cu(?:[-_. ]*(?:antipads?|clearances?))?|Edge[._]Cuts|N?PTH(?:[-_.]drl)?|antipads?|clearances?|top|bottom|bot|front|back|copper|outline|profile|board[-_. ]?outline|drills?|drl|g[tb][lops]|gko|gm\d+|silk\w*|mask\w*|paste\w*|courtyard|crtyd|fab)$/i;

/** The design name proposed for a set of artwork files: the stem they share once the extension and the layer part of each
 * name are taken off (export_patch-F_Cu.dxf, export_patch-B_Cu.dxf, export_patch-Edge_Cuts.dxf: "export_patch"); the stem
 * most files share, else the first file's. */
export function designNameFromFiles(names: readonly string[]): string {
  const stems = names.map((n) => {
    let s = n.replace(/\.[^.]+$/, "");
    for (let before = ""; before !== s && s;) { before = s; s = s.replace(LAYER_SUFFIX, ""); }
    return s.trim() || n.replace(/\.[^.]+$/, "");
  });
  if (!stems.length) return "";
  const count = new Map<string, number>();
  for (const s of stems) count.set(s, (count.get(s) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || stems.indexOf(a[0]) - stems.indexOf(b[0]))[0][0];
}

/** The layers whose role the importer guessed from their name (a role it is not sure of), each layer once. */
export function guessedRoles(layers: readonly Pick<PcbLayer, "kind" | "layer" | "source" | "role" | "because">[]): { layer: string; role: PcbRole }[] {
  const seen = new Set<string>();
  const out: { layer: string; role: PcbRole }[] = [];
  for (const l of layers) {
    if (l.because !== "layer name" || !l.role || l.role === "drill" || l.role === "ignore") continue;
    const layer = l.kind === "dxf" ? l.layer : l.source;
    if (seen.has(`${layer}\u0000${l.role}`)) continue;
    seen.add(`${layer}\u0000${l.role}`);
    out.push({ layer, role: l.role });
  }
  return out;
}

/** The i18n key and parameters of a report row the app words itself (python/fairbeam/pcb_import.py rows with a `key`, whose
 * message names a command-line flag), or null: the row is shown as the server wrote it. */
export function noteKey(n: { key?: string; params?: Record<string, string> }, has: (key: string) => boolean): { key: string; params: Record<string, string> } | null {
  return n.key && has(`pcbImport.note.${n.key}`) ? { key: `pcbImport.note.${n.key}`, params: n.params ?? {} } : null;
}

/** The key of a layer in the server's layer map (pcb_import.py _match_map matches a layer's name, its file name or
 * its file stem, case-insensitively, as a pattern). A DXF layer is named by its layer, a Gerber or drill file by
 * its file. `[`, `*` and `?` are escaped so that the name matches only itself. */
export function layerKey(l: Pick<PcbLayer, "kind" | "layer" | "source">): string {
  const name = l.kind === "dxf" ? l.layer : l.source;
  return name.replace(/[[*?]/g, (c) => `[${c}]`);
}

/** The role the dropdown of a layer shows: a layer without a role (nothing in its name says what it is) shows "". */
export const roleValue = (l: Pick<PcbLayer, "role">): string => l.role ?? "";

/** The roles a layer's dropdown offers: an Excellon file is a drill (which the importer turns into vias) or ignored;
 * anything else is top copper, bottom copper, the board outline or ignored. */
export function roleChoices(l: Pick<PcbLayer, "kind" | "role">): (PcbRole | "drill" | "")[] {
  if (l.kind === "drill") return ["drill", "ignore"];
  return l.role === null ? ["", ...PCB_ROLES] : [...PCB_ROLES];
}

/** The layer map after the viewer picked `value` for `layer`: picking a drill file's own role, or the empty
 * "unclear" choice, drops the entry. The map is never changed in place. */
export function withRole(map: Readonly<Record<string, PcbRole>>, layer: Pick<PcbLayer, "kind" | "layer" | "source">, value: string): Record<string, PcbRole> {
  const out = { ...map };
  const key = layerKey(layer);
  if (value === "" || value === "drill") delete out[key];
  else if ((PCB_ROLES as readonly string[]).includes(value)) out[key] = value as PcbRole;
  return out;
}

/** The map without the entry of `layer` (back to the role its name or file gives). */
export function withoutRole(map: Readonly<Record<string, PcbRole>>, layer: Pick<PcbLayer, "kind" | "layer" | "source">): Record<string, PcbRole> {
  const out = { ...map };
  delete out[layerKey(layer)];
  return out;
}

/** The map with only the entries that still name a layer of the files (a file was removed, or the layers changed). */
export function pruneMap(map: Readonly<Record<string, PcbRole>>, layers: readonly Pick<PcbLayer, "kind" | "layer" | "source">[]): Record<string, PcbRole> {
  const keys = new Set(layers.map(layerKey));
  return Object.fromEntries(Object.entries(map).filter(([k]) => keys.has(k))) as Record<string, PcbRole>;
}

/** Whether the viewer chose this layer's role (it comes from the layer map), not the importer. */
export const isChosen = (l: Pick<PcbLayer, "because">): boolean => l.because.startsWith("layer map ");

/** The i18n key (and parameters) of the reason a role was picked, from the importer's `because`. An unknown
 * reason (a newer server) comes back as `null`: the dialog shows the server's own words. */
export function reasonKey(because: string): { key: string; params?: Record<string, string> } | null {
  if (because.startsWith("layer map ")) return { key: "pcbImport.why.map", params: { key: because.slice("layer map ".length) } };
  const key = ({
    "layer name": "pcbImport.why.name",
    "Gerber file function": "pcbImport.why.gerber",
    "Excellon file": "pcbImport.why.excellon",
    "the only layer with outlines": "pcbImport.why.only",
    "no hint in the layer name": "pcbImport.why.none",
  } as Record<string, string>)[because];
  return key ? { key } : null;
}

// ---- files

export interface PcbEntry { name: string; size: number }
export type FileProblem = { key: string; params: Record<string, string | number> };

/** Which of `incoming` can join `existing` within the server's limits, and what is wrong with the others. A file with
 * the name of one already listed is left out (layer maps are keyed by name); sizes are in bytes, `mb` in the text. */
export function admitFiles(existing: readonly PcbEntry[], incoming: readonly PcbEntry[]): { accepted: PcbEntry[]; problems: FileProblem[] } {
  const accepted: PcbEntry[] = [];
  const problems: FileProblem[] = [];
  const names = new Set(existing.map((f) => f.name.toLowerCase()));
  let total = existing.reduce((n, f) => n + f.size, 0);
  let count = existing.length;
  const mb = (bytes: number) => Math.round(bytes / 1e5) / 10;
  for (const f of incoming) {
    if (names.has(f.name.toLowerCase())) { problems.push({ key: "pcbImport.err.duplicate", params: { file: f.name } }); continue; }
    if (f.size <= 0) { problems.push({ key: "pcbImport.err.empty", params: { file: f.name } }); continue; }
    if (f.size > PCB_LIMITS.file) { problems.push({ key: "pcbImport.err.fileTooLarge", params: { file: f.name, size: mb(f.size), max: mb(PCB_LIMITS.file) } }); continue; }
    if (count >= PCB_LIMITS.files) { problems.push({ key: "pcbImport.err.tooMany", params: { max: PCB_LIMITS.files } }); break; }
    if (total + f.size > PCB_LIMITS.total) { problems.push({ key: "pcbImport.err.total", params: { file: f.name, max: mb(PCB_LIMITS.total) } }); continue; }
    names.add(f.name.toLowerCase());
    accepted.push(f);
    total += f.size;
    count++;
  }
  return { accepted, problems };
}

/** Base64 of bytes (the request carries the files as text), in chunks so that a large file does not overflow the stack. */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---- options

/** The dialog's text fields, as typed. */
export interface PcbForm {
  substrate: string;          // a library id ("fr4") or "custom"
  thickness: string;
  epsR: string;
  tanD: string;
  f0: string;
  units: "auto" | "mm" | "inch";
  chordTol: string;
  margin: string;
  origin: "center" | "keep";
}

/** The importer's own defaults (pcb_import.py import_pcb, fairbeam import-pcb). */
export const PCB_DEFAULTS: PcbForm = { substrate: "fr4", thickness: "1.6", epsR: "4.3", tanD: "0.02", f0: "2.45", units: "auto", chordTol: "0.02", margin: "2", origin: "center" };

/** [min, max, min is excluded]: the ranges the server accepts (server.py _pcb_options). */
type PcbNumberField = "thickness" | "epsR" | "tanD" | "f0" | "chordTol" | "margin";
export const PCB_RANGES: Record<PcbNumberField, readonly [number, number, boolean]> = {
  thickness: [0, 100, true], epsR: [1, 200, false], tanD: [0, 1, false], f0: [0, 1000, true], chordTol: [1e-4, 5, false], margin: [0, 1000, false],
};

/** The value of one number field, or an error as an i18n key with its parameters. */
export function fieldValue(field: PcbNumberField, text: string): { value: number } | { error: string; params: Record<string, string> } {
  const v = parseNumber(text);
  const [lo, hi, open] = PCB_RANGES[field];
  if (v === null) return { error: "pcbImport.field.number", params: {} };
  if (v < lo || v > hi || (open && v === lo)) return { error: open ? "pcbImport.field.above" : "pcbImport.field.range", params: { min: String(lo), max: String(hi) } };
  return { value: v };
}

/** The `options` of the import request from the fields and the layer map, with an error per invalid field. The
 * substrate's εr and tan δ are always sent: what the fields show is what the design gets. */
export function buildOptions(form: PcbForm, layerMap: Readonly<Record<string, PcbRole>>): { options: PcbOptions; errors: Partial<Record<PcbNumberField, { error: string; params: Record<string, string> }>> } {
  const errors: Partial<Record<PcbNumberField, { error: string; params: Record<string, string> }>> = {};
  const value = {} as Record<PcbNumberField, number>;
  for (const f of Object.keys(PCB_RANGES) as PcbNumberField[]) {
    const r = fieldValue(f, form[f]);
    if ("error" in r) errors[f] = r; else value[f] = r.value;
  }
  const options: PcbOptions = {
    substrate: form.substrate === "custom" ? "substrate" : form.substrate,
    thickness: value.thickness, eps_r: value.epsR, tan_d: value.tanD, f0: value.f0,
    units: form.units, chord_tol: value.chordTol, margin: value.margin, origin: form.origin,
  };
  if (Object.keys(layerMap).length) options.layer_map = { ...layerMap };
  return { options, errors };
}
