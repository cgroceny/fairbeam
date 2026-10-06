import type { ProjectIndexEntry } from "../types";

const timestamp = (created: string) => Date.parse(created?.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) || 0;

/** The actual completion time wins over filename order (old indexes may lack a timestamp). */
export const newestResults = (entries: readonly ProjectIndexEntry[], model?: string, finished: ReadonlyMap<string, number> = new Map()) =>
  entries.filter((p) => p.simulated && (!model || p.model === model))
    .sort((a, b) => (finished.get(b.file) ?? timestamp(b.created)) - (finished.get(a.file) ?? timestamp(a.created)) || b.file.localeCompare(a.file));

export function resultGroups(entries: readonly ProjectIndexEntry[]) {
  const groups = new Map<string, ProjectIndexEntry[]>();
  for (const p of newestResults(entries)) {
    const model = p.model || "Other results";
    groups.set(model, [...(groups.get(model) ?? []), p]);
  }
  return [...groups].map(([model, entries]) => ({ model, entries })).sort((a, b) => a.model.localeCompare(b.model));
}
