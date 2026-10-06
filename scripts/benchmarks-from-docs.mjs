// Hand-entered benchmark facts for scripts/build-benchmarks.mjs. Everything here is copied from the
// docs; the JSON measurements (docs/benchmarks/*.json) and the committed bundles (public/projects/)
// are read by the script itself. When a number in docs/BENCHMARKS.md or docs/GPU.md changes, change
// it here too and run `node scripts/build-benchmarks.mjs`.

/**
 * Machines, keyed by the host CPU string the bundles and bench_compare.py record (`run.host.cpu`).
 * `logical_threads` turns a run with "all threads" (threads 0) into a number (docs/BENCHMARKS.md, Host).
 * `gpu` names the GPU a gpu-engine run used; the Windows JSON does not record it.
 */
export const MACHINES = {
  "Apple M5 Pro": { label: "Apple M5 Pro", order: 0, backend: "Metal" },
  "AMD Ryzen 9 7900X 12-Core Processor": {
    label: "AMD Ryzen 9 7900X",
    order: 1,
    logical_threads: 24,
    backend: "CUDA",
    gpu: { label: "NVIDIA RTX 3060 (on the 7900X)", order: 2 },
  },
};

/**
 * Measurements stated only in the docs. A row with the same model, parameters, host, engine and
 * threads as a committed bundle replaces that bundle's row (the doc value is the newer measurement).
 * `timesteps` / `grid` / `mcells_s` are null where the doc does not state them.
 */
export const DOC_ROWS = [
  // docs/BENCHMARKS.md, "The same patch antenna on the M5 Pro, re-measured on 2026-09-25", and
  // docs/GPU.md footnote 1: CPU engine, 4 threads, 12628 timesteps, 10.6 s (best of 10.59 / 10.75 s),
  // 329 MCells/s. The committed bundle (16.06 s, 18468 timesteps) predates the fixed end-criterion schedule.
  {
    model: "patch-antenna", params: {}, host_cpu: "Apple M5 Pro", engine: "cpu", threads: 4,
    timesteps: [12628], solver_s: 10.6, mcells_s: 329, grid: [69, 69, 58], date: "2026-09-25",
    source: "docs/BENCHMARKS.md", note: "best of two runs, 10.59 and 10.75 s",
  },
  // docs/GPU.md, table "Measured on an Apple M5 Pro": patch antenna, −60 dB, Metal GPU 1.6 s.
  {
    model: "patch-antenna", params: {}, host_cpu: "Apple M5 Pro", engine: "gpu", threads: null,
    timesteps: null, solver_s: 1.6, mcells_s: null, grid: null, date: null,
    source: "docs/GPU.md", note: "timesteps not recorded",
  },
  // docs/GPU.md, same table: Sierpinski monopole, iteration 3 (the default), Metal GPU 2.7 s, 2650 MCells/s.
  {
    model: "sierpinski-monopole", params: {}, host_cpu: "Apple M5 Pro", engine: "gpu", threads: null,
    timesteps: null, solver_s: 2.7, mcells_s: 2650, grid: null, date: null,
    source: "docs/GPU.md", note: "timesteps not recorded",
  },
];

/**
 * Repeated runs stated in the docs for rows read from the JSON files (matched by model, host, engine
 * and threads; the JSON holds the first run). The row takes the median as its solver time, as
 * BENCHMARKS.md and the landing page do. Timesteps and cells are the same in every run, so MCells/s is
 * scaled by first-run time / median. The 24-thread patch row is a single run in the docs (49.9 s).
 */
export const DOC_MEDIANS = [
  // docs/BENCHMARKS.md: "Patch antenna, 4 threads, three runs: 46.6, 52.9 and 58.0 s, median 52.9 s"
  { model: "patch-antenna", host_cpu: "AMD Ryzen 9 7900X 12-Core Processor", engine: "cpu", threads: 4,
    runs: [46.6, 52.9, 58.0], median: 52.9, source: "docs/BENCHMARKS.md" },
  // docs/BENCHMARKS.md / GPU.md: "Patch antenna on CUDA, three runs: 2.53, 2.56 and 2.58 s (median 2.56 s)"
  { model: "patch-antenna", host_cpu: "AMD Ryzen 9 7900X 12-Core Processor", engine: "gpu", threads: null,
    runs: [2.53, 2.56, 2.58], median: 2.56, source: "docs/BENCHMARKS.md" },
];
