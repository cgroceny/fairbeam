export type ProjectSort = "modified" | "name";

/** The model list may contain older entries without a timestamp while the server refreshes. */
export interface ProjectListEntry {
  key: string;
  file?: string;
  model?: { name?: string };
  modified?: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const projectName = (entry: ProjectListEntry) => entry.model?.name?.trim() || entry.key;
const modifiedTime = (entry: ProjectListEntry) => typeof entry.modified === "number" && Number.isFinite(entry.modified) && entry.modified > 0 ? entry.modified : null;

/** Search the visible name, id and file name, then sort deterministically. Undated entries sort
 * after dated ones in Recently modified mode and use their name as a stable fallback. */
export function visibleProjects<T extends ProjectListEntry>(
  entries: readonly T[],
  query: string,
  sort: ProjectSort,
  favoritesOnly: boolean,
  favoriteKeys: ReadonlySet<string>,
): T[] {
  const term = query.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (favoritesOnly && !favoriteKeys.has(entry.key)) return false;
    if (!term) return true;
    return [projectName(entry), entry.key, entry.file ?? ""].some((value) => value.toLocaleLowerCase().includes(term));
  }).sort((a, b) => {
    if (sort === "modified") {
      const aTime = modifiedTime(a), bTime = modifiedTime(b);
      if (aTime !== null || bTime !== null) {
        if (aTime === null) return 1;
        if (bTime === null) return -1;
        if (aTime !== bTime) return bTime - aTime;
      }
    }
    return collator.compare(projectName(a), projectName(b)) || collator.compare(a.key, b.key);
  });
}

export function hasUndatedProjects(entries: readonly ProjectListEntry[]): boolean {
  return entries.some((entry) => modifiedTime(entry) === null);
}
