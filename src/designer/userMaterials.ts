// "My materials": the user's own material library, next to the built-in one (materials.ts). Pure
// logic only (no Solid, no storage), so scripts/check-designer.mjs can test it; the list itself and
// where it is kept (the run server's <workspace>/materials.json, or localStorage) are in
// userMaterialsStore.ts. The validation is the same as python/fairbeam/usermaterials.py, and
// python/tests/fixtures/user_materials.json pins both.
//
// The library is only a source for new copies: a design always carries the full copy of each
// material it uses, and the .design.json format is unchanged.
import type { DesignMaterial } from "./types.ts";

/** One saved material. Plain numbers: tan_d_freq in GHz, conductivity in S/m, thickness in mm. */
export interface UserMaterial {
  id: string;
  name: string;
  kind: "metal" | "dielectric";
  eps_r?: number;
  mu_r?: number;
  tan_d?: number;
  tan_d_freq?: number;
  conductivity?: number;
  thickness?: number;
  color?: string;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
const ID = /^[A-Za-z0-9_.-]{1,64}$/;
export const MAX_USER_MATERIALS = 500;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The normalized entry, or why it is skipped. */
export function cleanUserMaterial(raw: unknown): { entry: UserMaterial } | { why: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { why: "not an object" };
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim() || r.name.length > 80) return { why: "missing name" };
  if (r.kind !== "metal" && r.kind !== "dielectric") return { why: "kind must be metal or dielectric" };
  if (typeof r.id !== "string" || !ID.test(r.id)) return { why: "missing id" };
  const out: UserMaterial = { id: r.id, name: r.name.trim(), kind: r.kind };
  if (r.kind === "dielectric") {
    const eps = num(r.eps_r);
    if (eps === null || eps < 1) return { why: "eps_r must be a number of at least 1" };
    const tan = r.tan_d === undefined ? 0 : num(r.tan_d);
    if (tan === null || tan < 0) return { why: "tan_d must be a number of at least 0" };
    if (r.mu_r !== undefined && r.mu_r !== null) {
      const mu = num(r.mu_r);
      if (mu === null || mu <= 0) return { why: "mu_r must be a positive number" };
      out.mu_r = mu;
    }
    out.eps_r = eps;
    out.tan_d = tan;
    if (r.tan_d_freq !== undefined && r.tan_d_freq !== null) {
      const f = num(r.tan_d_freq);
      if (f === null || f <= 0) return { why: "tan_d_freq must be a positive number" };
      out.tan_d_freq = f;
    }
  } else if (r.conductivity !== undefined && r.conductivity !== null) {
    const s = num(r.conductivity);
    if (s === null || s <= 0) return { why: "conductivity must be a positive number" };
    out.conductivity = s;
    if (r.thickness !== undefined && r.thickness !== null) {
      const th = num(r.thickness);
      if (th === null || th <= 0) return { why: "thickness must be a positive number" };
      out.thickness = th;
    }
  }
  if (r.color !== undefined && r.color !== null) {
    if (typeof r.color !== "string" || !COLOR.test(r.color)) return { why: "color must be #rrggbb" };
    out.color = r.color.toLowerCase();
  }
  return { entry: out };
}

/** The valid entries (the first of a repeated id or name wins) and a warning per skipped one. */
export function cleanUserMaterials(raw: unknown): { materials: UserMaterial[]; skipped: string[] } {
  const items = Array.isArray(raw) ? raw : (raw as { materials?: unknown } | null)?.materials;
  if (!Array.isArray(items)) return { materials: [], skipped: ["the list is missing"] };
  const materials: UserMaterial[] = [];
  const skipped: string[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    if (materials.length >= MAX_USER_MATERIALS) {
      skipped.push(`entry ${i + 1}: more than ${MAX_USER_MATERIALS} materials, the rest is skipped`);
      break;
    }
    const res = cleanUserMaterial(items[i]);
    if ("why" in res) skipped.push(`entry ${i + 1}: ${res.why}`);
    else if (ids.has(res.entry.id) || names.has(res.entry.name)) skipped.push(`entry ${i + 1} (${res.entry.name}): id or name used twice`);
    else {
      ids.add(res.entry.id);
      names.add(res.entry.name);
      materials.push(res.entry);
    }
  }
  return { materials, skipped };
}

const plain = (v: unknown): number | null | undefined => {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return undefined;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null; // null: not a plain number (a parameter expression)
};

/** A design material as a library entry. Values that are parameter expressions cannot be saved. */
export function userMaterialFromDesign(m: DesignMaterial, id: string): { entry: UserMaterial } | { why: string } {
  const raw: Record<string, unknown> = { id, name: m.name, kind: m.kind, color: m.color && COLOR.test(m.color) ? m.color : undefined };
  for (const k of ["eps_r", "mu_r", "tan_d", "tan_d_freq", "conductivity", "thickness"] as const) {
    const v = plain(m[k]);
    if (v === null) return { why: k };
    raw[k] = v;
  }
  if (m.kind === "dielectric" && raw.tan_d === undefined) raw.tan_d = 0;
  return cleanUserMaterial(raw);
}

/** A design material with a copy of the entry's values (the counterpart of materials.ts designMaterial). */
export function designMaterialFromUser(u: UserMaterial, name = u.name): DesignMaterial {
  const out: DesignMaterial = { name, kind: u.kind };
  if (u.kind === "dielectric") {
    out.eps_r = u.eps_r;
    if (u.mu_r !== undefined) out.mu_r = u.mu_r;
    out.tan_d = u.tan_d ?? 0;
    if (u.tan_d_freq !== undefined) out.tan_d_freq = u.tan_d_freq;
  } else if (u.conductivity !== undefined) {
    out.conductivity = u.conductivity;
    if (u.thickness !== undefined) out.thickness = u.thickness;
  }
  if (u.color) out.color = u.color;
  return out;
}

/** A name not used in `taken`: "name", "name 2", "name 3" ... */
export function freeName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  for (let n = 2; ; n++) if (!used.has(`${name} ${n}`)) return `${name} ${n}`;
}

export function newUserMaterialId(existing: Iterable<string>): string {
  const used = new Set(existing);
  for (;;) {
    const id = `u-${Math.random().toString(36).slice(2, 10)}`;
    if (!used.has(id)) return id;
  }
}

/** Add `entry` to the list, or replace the entry of the same name (saving a material again updates it). */
export function upsertByName(list: UserMaterial[], entry: UserMaterial): { list: UserMaterial[]; updated: boolean } {
  const i = list.findIndex((q) => q.name === entry.name);
  if (i < 0) return { list: [...list, entry], updated: false };
  const next = list.slice();
  next[i] = { ...entry, id: list[i].id };
  return { list: next, updated: true };
}

/** The JSON file of the export. */
export function exportUserMaterials(list: UserMaterial[]): string {
  return JSON.stringify({ version: 1, materials: list }, null, 2) + "\n";
}

/** Read an exported file (or a bare array) and merge it into `existing`: bad entries are skipped
 * with a warning; names already used get a number, and every import gets a fresh id. */
export function importUserMaterials(text: string, existing: UserMaterial[]): { list: UserMaterial[]; added: number; skipped: string[] } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { list: existing, added: 0, skipped: ["not a valid JSON file"] }; }
  const { materials, skipped } = cleanUserMaterials(raw);
  const list = existing.slice();
  for (const m of materials) {
    if (list.length >= MAX_USER_MATERIALS) { skipped.push(`${m.name}: the list is full`); continue; }
    list.push({ ...m, id: newUserMaterialId(list.map((q) => q.id)), name: freeName(m.name, list.map((q) => q.name)) });
  }
  return { list, added: list.length - existing.length, skipped };
}
