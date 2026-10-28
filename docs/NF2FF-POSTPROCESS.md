# Far fields from retained raw data

An ordinary run can retain its NF2FF recording so that additional far-field frequencies can
be calculated later without another FDTD run. Retention is optional and off by default.
The original model, mesh, phase center and runtime are fixed: this is a new transform of
the same electromagnetic recording, not a new simulation or an accuracy/convergence study.

## Designer and Viewer

Enable **Keep raw data for additional far fields** in the Designer Run dialog before starting an ordinary
run with a far-field monitor. The option is off by default and keeps extra raw data on disk.
Open the finished result's Pattern view and expand **Additional far-field frequencies**.
Choose frequencies in GHz and angular steps in degrees, then create a new result. The
original result is preserved. Designer follows the new job in its Run tab; Viewer follows
it in the ordinary Run panel.

Viewer offers the same panel for a result loaded from the current local workspace and
linked to its retained source job. Importing a JSON file, even one with the same filename,
does not grant access to raw data. Compare and synthesized-array views do not submit a
new transform. Old runs, deleted raw data, or another workspace show run-again guidance.

## Designer and viewer

In the Run dialog, enable **Keep raw data for additional far fields** before starting an ordinary run. It is off by default and requires a far-field monitor. Retaining the original E/H files can use substantial disk space.

Open a completed result's Pattern view, expand **Additional far-field frequencies**, and enter the frequencies in GHz and angular steps in degrees. The panel accepts only a known completed retained job in the same workspace. Imported files and older results without that link show run-again guidance. The viewer uses the Run panel; the Designer follows its result tree. A queued transform gets its own job and result; it does not replace the source.

## Command line

Run a saved model or Design with `--retain-nf2ff` and a fresh run name:

```sh
fairbeam run model.design.json --name retained-example --retain-nf2ff --out results --sim-root raw
```

The completed run prints a `fairbeam: retained-nf2ff` receipt containing the raw folder
and its manifest SHA-256. Keep that receipt. Request a new result with frequencies in Hz:

```sh
fairbeam farfield raw/retained-example --manifest-sha256 ORIGINAL_MANIFEST_SHA256 --frequency 2.4e9,2.45e9 --output results/additional-farfield.json
```

`--theta-step` and `--phi-step` use degrees and default to 3 and 5. A request allows at most
16 frequencies, 65,536 angular cells per frequency and 262,144 cells per driven port in total.
The output must be a new `.json` file outside the source raw folder. A source or previous
derivative is never overwritten. A retained run folder cannot be reused as a new run target.

Time-domain recordings admit frequencies inside the original excitation band and their
recorded sample-rate limit. Frequency-domain recordings admit only frequencies actually
recorded in the original E/H dumps. A finer angular grid does not improve the original mesh,
time stepping or field convergence. Missing, changed or unsupported raw data requires a new
run with retention; old arbitrary raw folders are not automatically adopted.

## Run-server API

An ordinary `POST /api/runs` accepts `retain_nf2ff: true`. This option is not enabled for
optimization, sweep or convergence members by default. The standalone `run --server`
adapter does not forward this local CLI flag; API callers request retention explicitly.

For a completed local source job:

- `GET /api/runs/{id}/farfield` reports availability, original frequency band, TD/FD mode,
  recorded FD frequencies, storage size and request limits. Availability is preliminary;
  the worker verifies all hashes and the runtime again before computation.
- `POST /api/runs/{id}/farfield` accepts only `frequencies_hz`, `theta_step` and `phi_step`.
  It queues a separate `postprocess` job on the existing serial worker and writes a unique
  derivative result. No client-supplied source paths, manifests or output paths are accepted.
- Normal job cancellation applies. A cancelled or failed transform does not publish a new
  result: its worker writes into its private job folder, and the manager publishes only
  after a successful exit while holding the same lock as cancellation. Source-job deletion
  is refused while its transform is queued or running. Admission and queue insertion share
  the cleanup lock so deletion cannot race the new job's ownership of its source.

Deleting raw data with `clean-sim`, deleting the original job, moving its raw folder or
changing its result removes the capability. Cleanup and transforms share an ownership lock;
active source data is protected by a running marker. A queued request whose raw files were
removed fails before native computation.

## Provenance and interpretation

The manifest binds exact saved model bytes and resolved parameters, original result bytes,
the full original mesh (without bundle display rounding), enabled E/H dump hashes and
recording metadata. It also fingerprints loaded Python bindings, configured native library
files, Python version and the Fairbeam postprocessing sources. Native library hashes describe
the configured installation; they are not a claim that every file was loaded by the OS.
The independent original-run receipt binds the manifest itself. Relative raw paths cannot
traverse symbolic links, Windows reparse points or external HDF5 storage.

The worker restores the recorded NF2FF box adapter without building a model, CSX geometry
or FDTD solver. It writes native intermediate output into a separate temporary folder and
checks original hashes again before publishing the derivative. Intermediate native output
hashes are retained in the result's `postprocess` receipt; the temporary HDF5 files are not.

Only `results.farfield` is replaced. Network data, complex embedded element patterns,
efficiency sweeps, original run statistics and saved requirement/source snapshots keep their
original frequencies and provenance. New radiation efficiency and gain use linear
interpolation of the original per-drive accepted-power and reflection-power sweep; no new
port measurements are implied. The derivative records its parent SHA-256, original manifest
SHA-256, source identity, request, runtime and an explicit `fdtd_rerun: false` flag.

Current admission supports Cartesian, cell-interpolated E/H recordings with explicit
`NXYZ` or `NZYX` dataset order. Unsupported legacy layouts fail closed. Time-domain and
frequency-domain admission controls use synthetic HDF5 tests; native equivalence must be
verified separately on a retained run and does not follow from those controls alone.
