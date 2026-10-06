// Comparison state: projects pinned next to the current one. Charts show at most eight series
// (current + 7 pinned), one per categorical slot in its fixed order, which stays distinguishable
// for colour-vision deficiencies on line charts (docs/DESIGN.md, Charts).
import { createEffect, createMemo, createRoot, createSignal, untrack } from "solid-js";
import { bundle, source } from "../state";
import { projectUrl } from "../env";
import type { Bundle } from "../types";
import { summarize, validateBundle } from "../lib/validate";
import { importReference, isReference, type RefBundle } from "../import/reference";

export const MAX_PINNED = 7;
const KEY = "fairbeam.compare";

export interface Pinned {
  file: string;
  bundle: Bundle | null;
  error?: string;
}

export const [pinned, setPinned] = createSignal<Pinned[]>([]);
export const [zPart, setZPart] = createSignal<"re" | "im">("re");
export const [cutPhi, setCutPhi] = createSignal<0 | 90>(0);
export const [compareOpen, setCompareOpen] = createSignal(false);

// Entries already own their loaded bundles. Keep only request identity, never an extra cache.
const requests = new Map<string, symbol>();
let pinnedGeneration = 0;
let referenceGeneration = 0;

async function fetchBundle(file: string): Promise<Bundle> {
  const r = await fetch(projectUrl(file), { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  // same validation as an opened project: NaN gaps instead of nulls, malformed sections refused
  const v = validateBundle(await r.json());
  if (!v.bundle) throw new Error(summarize(v.errors));
  return v.bundle;
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(pinned().filter((p) => p.file !== REF_KEY).map((p) => p.file)));
  } catch {
    /* per-viewer convenience only */
  }
}

export const isPinned = (file: string) => pinned().some((p) => p.file === file);

export async function pin(file: string) {
  if (isPinned(file) || pinned().length >= MAX_PINNED) return;
  const ticket = Symbol(file);
  requests.set(file, ticket);
  setPinned([...pinned(), { file, bundle: null }]);
  persist();
  try {
    const b = await fetchBundle(file);
    if (requests.get(file) !== ticket || !isPinned(file)) return;
    setPinned(pinned().map((p) => (p.file === file ? { file, bundle: b } : p)));
  } catch (e) {
    if (requests.get(file) !== ticket || !isPinned(file)) return;
    setPinned(pinned().map((p) => (p.file === file ? { file, bundle: null, error: (e as Error).message } : p)));
  } finally {
    if (requests.get(file) === ticket) requests.delete(file);
  }
}

export function unpin(file: string) {
  requests.delete(file);
  setPinned(pinned().filter((p) => p.file !== file));
  persist();
}

export function clearPinned() {
  pinnedGeneration++;
  referenceGeneration++;
  requests.clear();
  setPinned([]);
  persist();
}

/** Replace the pinned set (e.g. "Compare all" for a sweep). */
export async function pinAll(files: string[]) {
  clearPinned();
  const generation = pinnedGeneration;
  for (const f of files.slice(0, MAX_PINNED)) {
    if (generation !== pinnedGeneration) return;
    await pin(f);
  }
}

export function restorePinned() {
  try {
    const files = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (Array.isArray(files)) for (const f of files.slice(0, MAX_PINNED)) if (typeof f === "string") pin(f);
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ imported reference data
// A reference (Touchstone / CSV, src/import) is one pinned entry under REF_KEY: it takes a
// colour slot like a project. Further files (e.g. the far field after the Touchstone) merge into it.

export const REF_KEY = "ref:reference";
export const [refError, setRefError] = createSignal<string | null>(null);
export const reference = () => pinned().find((p) => p.file === REF_KEY)?.bundle as RefBundle | undefined;

export async function importReferenceFile(file: File) {
  // Newer import intent wins; awaited sequential imports still merge into the current reference.
  const generation = ++referenceGeneration;
  const owner = bundle();
  const current = () => generation === referenceGeneration && bundle() === owner;
  try {
    const text = await file.text();
    if (!current()) return;
    const existing = reference();
    const ref = importReference(file.name, text, owner, existing && isReference(existing) ? existing : null);
    const entry: Pinned = { file: REF_KEY, bundle: ref };
    if (existing) setPinned(pinned().map((p) => (p.file === REF_KEY ? entry : p)));
    else {
      const retained = pinned().slice(0, MAX_PINNED - 1);
      for (const file of requests.keys()) if (!retained.some(p => p.file === file)) requests.delete(file);
      setPinned([...retained, entry]); // replaces the last pinned project when full
    }
    setRefError(null);
  } catch (e) {
    if (!current()) return;
    setRefError(`${file.name}: ${(e as Error).message}`);
  }
}

export const clearReference = () => {
  referenceGeneration++;
  setPinned(pinned().filter((p) => p.file !== REF_KEY));
  setRefError(null);
};

// The reference describes one design: drop it when a project of another model opens.
createRoot(() => {
  let refModel: string | null = null;
  let sourceModel = bundle()?.model?.id ?? null;
  createEffect(() => {
    const id = bundle()?.model?.id ?? null;
    if (id !== sourceModel) { referenceGeneration++; sourceModel = id; }
    if (!reference()) { refModel = id; return; }
    if (refModel === null) refModel = id;
    else if (id && id !== refModel) {
      refModel = id;
      untrack(() => clearReference());
    }
  });
});

/** Bundles to draw next to the current project: loaded, simulated, not the current one. */
export const compareBundles = createRoot(() =>
  createMemo(() => pinned().filter((p) => p.bundle?.results && p.file !== source()).map((p) => p.bundle!)),
);
export const comparing = () => !!bundle()?.results && compareBundles().length > 0;
