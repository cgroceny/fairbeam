import type { Bundle, LocalMeshRefinementReport } from "../types.ts";
import { meshMatchesGeometry } from "./meshBottlenecks.ts";
import { LOCAL_MESH_REGION_ID, LOCAL_MESH_REGIONS_MAX, localMeshRegionNameValid } from "./localMeshRegions.ts";

const tuple = (value: unknown): value is [number, number, number] => Array.isArray(value) && value.length === 3 &&
  value.every(n => typeof n === "number" && Number.isFinite(n));
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const product = (v: readonly number[]) => v.reduce((p, n) => p * n, 1);
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b));
const nextFloat = (value: number) => {
  const bytes = new DataView(new ArrayBuffer(8)); bytes.setFloat64(0, value);
  bytes.setBigUint64(0, bytes.getBigUint64(0) + 1n); return bytes.getFloat64(0);
};

/** Only current resolved reports are overlay sources. Validate stored reports against their own
 * full-precision axes; a carried preview or inconsistent imported report is never fresh evidence. */
export function localMeshReport(b: Bundle | null | undefined): LocalMeshRefinementReport | null {
  if (!b || !meshMatchesGeometry(b)) return null;
  const r = b.mesh.auto?.local_refinement;
  if (!r || r.version !== 1 || r.precision !== "float64-round-trip" || !Array.isArray(r.regions) ||
    r.regions.length < 1 || r.regions.length > LOCAL_MESH_REGIONS_MAX) return null;
  const grids = [b.mesh.x, b.mesh.y, b.mesh.z];
  if (grids.some(g => !Array.isArray(g) || g.length < 2 || g.some((x, i) => !Number.isFinite(x) || (i > 0 && x <= g[i - 1])))) return null;
  const cells = grids.map(g => g.length - 1);
  if (!count(product(cells)) || b.mesh.total_cells !== product(cells) || !count(r.cell_limit) || product(cells) > r.cell_limit) return null;
  const stage = (s: { cells: number[]; total_cells: number; timestep_s: number } | undefined) => !!s &&
    tuple(s.cells) && s.cells.every(count) && count(s.total_cells) && s.total_cells === product(s.cells) && positive(s.timestep_s);
  if (!r.insertion || r.insertion.stage !== "after-automatic-probe-alignment" || !stage(r.insertion.before) || !stage(r.insertion.after) ||
    !r.final || r.final.stage !== "validated-current-grid" || !stage(r.final) || r.final.cells.some((n, k) => n !== cells[k]) ||
    r.final.total_cells !== product(cells) || r.insertion.after.total_cells > r.cell_limit ||
    r.insertion.added_cells !== r.insertion.after.total_cells - r.insertion.before.total_cells ||
    r.insertion.added_cells < 0 || !positive(r.insertion.ratio) ||
    !close(r.insertion.ratio, r.insertion.after.total_cells / r.insertion.before.total_cells)) return null;
  const grading = r.grading;
  if (!grading || ![grading.configured_max_ratio, grading.baseline_max_ratio, grading.admission_ceiling, grading.insertion_max_ratio, grading.final_max_ratio].every(positive) ||
    grading.admission_ceiling !== Math.max(grading.configured_max_ratio, grading.baseline_max_ratio) ||
    grading.insertion_max_ratio > nextFloat(grading.admission_ceiling)) return null;
  const unit = b.units?.length_m ?? 1e-3;
  if (!positive(unit)) return null;
  const minimums: number[] = []; let measuredGrading = 1;
  for (const grid of grids) {
    let minimum = Infinity;
    for (let i = 0; i < grid.length - 1; i++) {
      const width = grid[i + 1] - grid[i]; minimum = Math.min(minimum, width);
      if (i + 2 < grid.length) {
        const next = grid[i + 2] - grid[i + 1]; measuredGrading = Math.max(measuredGrading, width / next, next / width);
      }
    }
    minimums.push(minimum);
  }
  const smallest = Math.min(...minimums);
  const cfl = smallest * unit / (299_792_458 * Math.sqrt(minimums.reduce((sum, width) => sum + (smallest / width) ** 2, 0)));
  if (!positive(cfl) || !close(r.final.timestep_s, cfl) || !close(grading.final_max_ratio, measuredGrading)) return null;
  const ids = new Set<string>();
  for (const region of r.regions) {
    if (!region || typeof region.id !== "string" || !LOCAL_MESH_REGION_ID.test(region.id) || ids.has(region.id) ||
      !localMeshRegionNameValid(region.name) || !tuple(region.start) || !tuple(region.stop) || !positive(region.cell_size) || !tuple(region.max_width)) return null;
    ids.add(region.id);
    for (let k = 0; k < 3; k++) {
      const grid = grids[k];
      if (!(region.start[k] < region.stop[k]) || region.start[k] < grid[0] || region.stop[k] > grid.at(-1)!) return null;
      let maximum = 0;
      for (let i = 0; i < grid.length - 1; i++) if (grid[i] < region.stop[k] && grid[i + 1] > region.start[k])
        maximum = Math.max(maximum, grid[i + 1] - grid[i]);
      if (!positive(maximum) || maximum > nextFloat(region.cell_size) || maximum !== region.max_width[k]) return null;
    }
  }
  return r;
}

/** Twelve world-coordinate edges, in the same drawing units as the displayed mesh. */
export function localMeshRegionSegments(report: LocalMeshRefinementReport): number[] {
  const vertices: number[] = [];
  for (const region of report.regions) for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (const a of [0, 1]) for (const c of [0, 1]) {
      const start = [...region.start], stop = [...region.start];
      start[u] = stop[u] = a ? region.stop[u] : region.start[u];
      start[v] = stop[v] = c ? region.stop[v] : region.start[v]; stop[axis] = region.stop[axis];
      vertices.push(...start, ...stop);
    }
  }
  return vertices;
}
