// The mesh numbers and the solver-time estimate of the design being edited, for the Run dialog, the
// Simulation settings, the mesh view, the ribbon and the status bar. They come from the latest preview
// of the draft (runner/store.ts draftPreview), never from a run's results shown in the 3D view (a
// mesh-convergence run at another density, an earlier run with another timestep limit), and the
// estimate takes the timestep limit the draft itself sets.
import { draftPreview } from "../runner/store";
import { draft } from "./store";
import { estimateTime, meshStats, type MeshStats, type TimeEstimate } from "./meshStats";

/** The draft's mesh: lines, cells, smallest cell, timestep; null before its first server preview. */
export const draftMeshStats = (): MeshStats | null => meshStats(draftPreview());

/** Ports that are excited one after the other in a run of the draft. */
export const draftExcitedPorts = () => Math.max(1, (draft.ports ?? []).filter((p) => p.excite !== false).length);

/** The solver time of a run of the draft on `engine`: its mesh, its excited ports and its own timestep
 * limit (none set: the server sizes the limit to the run, so no "stops at the limit" remark). */
export const draftEstimate = (engine: string): TimeEstimate | null =>
  estimateTime(draftPreview(), engine, draftExcitedPorts(), { maxTimesteps: draft.simulation.max_timesteps ?? null });
