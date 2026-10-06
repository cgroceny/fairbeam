// What the thread count "Auto" means for a run: the same rule as python/fairbeam/resources.py
// auto_threads, which the server applies when the run starts (with the grid's cell count, which the
// client sends along). The Run dialog shows it before the run, so the number it names matches the one
// the dock reports afterwards. Pure, so scripts/check-run-threads.mjs tests it against the Python
// table of cases.

/** Threads for a host with `logical` usable CPUs and `physical` cores (default: all logical), and a
 * grid of `cells` FDTD cells (unknown or 0: treated as small). */
export function autoThreads(logical: number, physical?: number | null, cells?: number | null): number {
  const lo = Math.max(1, Math.trunc(logical) || 1);
  const ph = Math.max(1, Math.min(Math.trunc(physical || lo), lo));
  const n = ph >= 4 ? ph - 1 : ph <= 2 ? 1 : ph;   // keep a core for the app
  const cap = !cells || cells < 500_000 ? 4 : cells < 2_000_000 ? 8 : 12;
  return Math.max(1, Math.min(n, cap, lo));
}
