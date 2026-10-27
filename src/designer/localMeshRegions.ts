import { evaluate } from "./expr.ts";
import type { Design, Expr, LocalMeshRegion } from "./types.ts";

export const LOCAL_MESH_REGIONS_MAX = 32;
export const LOCAL_MESH_REGION_EXPLANATION = "Use up to 32 named boxes with unique IDs, finite coordinates, increasing bounds, and a positive cell size inside the mesh domain. Coordinates use the model length unit; manual mesh keeps these settings inactive.";
export const LOCAL_MESH_REGION_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
/** These use the region code but need the generated mesh/captured source, not the cheap mirror. */
export const LOCAL_MESH_RESOLVED_MESSAGES = new Set([
  "region must lie inside the mesh domain",
  "captured expressions differ from the resolved mesh regions",
  "captured parameter definitions differ from their resolved values",
]);
export const localMeshRegionNameValid = (value: unknown): value is string => typeof value === "string" &&
  value.trim().length > 0 && [...value.trim()].length <= 80 && !/[\x00-\x1f\x7f]/.test(value);
const expression = (value: unknown): value is Expr => typeof value === "number" ? Number.isFinite(value)
  : typeof value === "string" && value.trim().length > 0;

/** The manual branch deliberately checks only stored shape, not currently inactive expressions. */
export function localMeshRegionChecks(value: unknown, manual: boolean, names: Record<string, number>):
  { path: string; code: "mesh-local-region"; message: string }[] {
  const out: { path: string; code: "mesh-local-region"; message: string }[] = [];
  const error = (path: string, message: string) => out.push({ path, code: "mesh-local-region", message });
  if (value === undefined) return out;
  if (!Array.isArray(value)) { error("mesh.local_regions", "local regions must be a list"); return out; }
  if (value.length > LOCAL_MESH_REGIONS_MAX) { error("mesh.local_regions", "use at most 32 local regions"); return out; }
  const ids = new Set<string>();
  value.forEach((region, i) => {
    const path = `mesh.local_regions[${i}]`;
    if (!region || typeof region !== "object" || Array.isArray(region)) { error(path, "local region must be an object"); return; }
    if (typeof region.id !== "string" || !LOCAL_MESH_REGION_ID.test(region.id)) error(`${path}.id`, "region id must be 1–64 letters, digits, underscores or hyphens, starting with a letter or underscore");
    else if (ids.has(region.id)) error(`${path}.id`, "region ids must be unique");
    else ids.add(region.id);
    if (!localMeshRegionNameValid(region.name)) error(`${path}.name`, "region name must contain 1–80 characters without control characters");
    const read = (field: string, raw: unknown): number | null => {
      if (!expression(raw)) { error(field, "region value must be a finite number or nonempty expression"); return null; }
      if (manual) return null;
      try { const n = evaluate(raw, names); if (!Number.isFinite(n)) throw new Error("region value must be finite"); return n; }
      catch (problem) { error(field, (problem as Error).message); return null; }
    };
    const vector = (end: "start" | "stop") => {
      const raw = region[end];
      if (!Array.isArray(raw) || raw.length !== 3) { error(`${path}.${end}`, "region bounds need exactly 3 coordinates"); return null; }
      return raw.map((x, k) => read(`${path}.${end}[${k}]`, x));
    };
    const start = vector("start"), stop = vector("stop"), cap = read(`${path}.cell_size`, region.cell_size);
    if (!manual && start && stop) for (let k = 0; k < 3; k++) {
      if (start[k] !== null && stop[k] !== null && !(stop[k]! > start[k]!))
        error(`${path}.stop[${k}]`, "region stop must be greater than start on every axis");
    }
    if (cap !== null && cap <= 0) error(`${path}.cell_size`, "region cell size must be greater than zero");
  });
  return out;
}

/** Reconstructed automatic settings must never restore an older region list from a stash. */
export function retainLocalMeshRegions(current: Design["mesh"], next: Design["mesh"]): Design["mesh"] {
  const result = { ...next };
  if (current.local_regions === undefined) delete result.local_regions;
  else result.local_regions = current.local_regions;
  return result;
}

export function newLocalMeshRegion(existing: readonly LocalMeshRegion[], name: string,
  domain?: { min: readonly number[]; max: readonly number[] }): LocalMeshRegion {
  let n = 1; while (existing.some(region => region.id === `region_${n}`)) n++;
  const usable = domain && [0, 1, 2].every(k => Number.isFinite(domain.min[k]) && Number.isFinite(domain.max[k]) &&
    Number.isFinite(domain.max[k] - domain.min[k]) && domain.max[k] > domain.min[k]);
  const start: [number, number, number] = [-1, -1, -1], stop: [number, number, number] = [1, 1, 1];
  if (usable) for (let k = 0; k < 3; k++) {
    const span = domain!.max[k] - domain!.min[k], middle = domain!.min[k] + span / 2, half = span / 20;
    start[k] = middle - half; stop[k] = middle + half;
  }
  return { id: `region_${n}`, name, start, stop, cell_size: Math.min(...stop.map((x, k) => x - start[k])) / 4 };
}
