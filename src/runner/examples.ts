// Examples mode contains only these shipped bundles. User runs and copies stay in their own workflows.
import type { ModelEntry } from "./api";
import type { Bundle, ProjectIndexEntry } from "../types";
import { t } from "../i18n/index.ts";

export const BUNDLED_EXAMPLE_FILES = [
  "branchline-coupler.json", "dipole.json", "helix-axial.json", "inset-patch.json",
  "lowpass-stepped.json", "microstrip-line.json", "minkowski-patch.json", "patch-antenna.json",
  "patch-array-2x1.json", "patch-array-4x1.json", "pyramidal-horn.json",
  "sierpinski-monopole--iterations-0.json", "sierpinski-monopole--iterations-3.json",
  "wilkinson-divider.json",
  // 867 MHz UAV designs (examples/designs/)
  "wideband-dipole-867.json", "meander-dipole-867.json", "sleeve-dipole-867.json",
  "collinear-867.json", "yagi-867.json",
] as const;
const bundledExamples = new Set<string>(BUNDLED_EXAMPLE_FILES);
export const isExample = (entry: Pick<ProjectIndexEntry, "file">) => bundledExamples.has(entry.file);

export const exampleEntries = (entries: readonly ProjectIndexEntry[]) => entries.filter(isExample);

/** Resolve a demo link only against shipped filenames, never an arbitrary fetch path. */
export function linkedExample(entries: readonly ProjectIndexEntry[], search: string): ProjectIndexEntry | undefined {
  const id = new URLSearchParams(search).get("example");
  return id ? entries.find((entry) => isExample(entry) && entry.file === `${id}.json`) : undefined;
}

/** The user's design that a bundle's model was made from, for "Open in designer"; only designs can be
 * edited there, and a bundled example design (read-only) is only the source of its example's copy. */
export const designFor = (models: readonly ModelEntry[], modelId: string | undefined): ModelEntry | undefined =>
  modelId ? models.find((m) => m.kind === "design" && !m.error && !m.readonly && m.model?.id === modelId) : undefined;

/** The read-only source shipped with a bundled example: its Python model, or for the 867 MHz
 * examples its example design (examples/designs, copied into the workspace's models folder). */
export const exampleSourceFor = (models: readonly ModelEntry[], modelId: string | undefined): ModelEntry | undefined =>
  modelId ? models.find((m) => m.readonly && !m.error && m.model?.id === modelId) : undefined;

// Shapes the Design schema cannot hold, so "Open as new project" (python/fairbeam/example_design.py
// _primitive) refuses them: the reason is shown on the disabled button instead of after a server trip.
// Values are i18n keys (examples.shape.*).
const UNCONVERTIBLE: Record<string, string> = {
  curve: "examples.shape.curve",
  rotpoly: "examples.shape.rotpoly",
};

/** Why a bundled example cannot become a Design copy, read from its geometry; null when it can. */
export function exampleConversionBlocker(bundle: Pick<Bundle, "parts">): string | null {
  for (const part of bundle.parts ?? []) {
    for (const prim of part.primitives ?? []) {
      const what = prim.kind === "bbox" ? t("examples.shape.inexact", { kind: prim.source_kind }) : UNCONVERTIBLE[prim.kind] ? t(UNCONVERTIBLE[prim.kind]) : undefined;
      if (what) return t("examples.blocker", { part: part.label || part.name, what });
    }
  }
  return null;
}
