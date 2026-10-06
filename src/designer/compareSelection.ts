/** Foreign runs are overlays; only a run of the active design can become primary. */
export function pickProjectRuns(current: readonly string[], file: string, additive: boolean,
  localFiles: ReadonlySet<string>, max = 8): { files: string[]; full: boolean; accepted: boolean } {
  const unchanged = () => ({ files: [...current], full: false, accepted: false });
  if (!additive) return localFiles.has(file)
    ? { files: [file, ...current.filter(value => !localFiles.has(value))], full: false, accepted: true } : unchanged();
  if (!current.length) return localFiles.has(file) ? { files: [file], full: false, accepted: true } : unchanged();
  if (!localFiles.has(current[0])) return unchanged();
  if (current.includes(file)) {
    const rest = current.filter(value => value !== file);
    if (file === current[0]) {
      const next = rest.find(value => localFiles.has(value));
      if (!next) return { files: [...current], full: false, accepted: true };
      return { files: [next, ...rest.filter(value => value !== next)], full: false, accepted: true };
    }
    return { files: rest, full: false, accepted: true };
  }
  if (current.length >= max) return { files: [...current], full: true, accepted: false };
  return { files: [...current, file], full: false, accepted: true };
}
