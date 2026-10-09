# Experimental solvers in the app

The Simulation ribbon's **Experimental solvers** command opens a separate research panel. It uses the ordinary run server and its serial job queue. The regular Run command, installed openEMS runtime, project format and antenna result viewer remain unchanged. No additional solver is downloaded or installed automatically.

This is an opt-in research integration, not a production Floquet port or general FEM antenna solver. Windows native execution has been exercised; macOS native execution and packaging still need qualification.

## Configure and run

1. Build and serve this source revision using the normal [source setup](FROM-SOURCE.md).
2. In Design, open Simulation → Experimental solvers.
3. Choose a backend and enter its local executable/package path. Check availability before submitting. A missing or incompatible backend prevents submission.
4. Submit a bounded experiment. It waits behind any existing simulation; cancellation uses the same process-tree cleanup as the ordinary queue.
5. Select the run in the research history to inspect its result. Closing the panel does not cancel an active run. Reopening history retrieves the saved result.

You can instead set `FAIRBEAM_PERIODIC_EXECUTABLE` or `FAIRBEAM_ELMER_ROOT` in the run server's environment. Local path preferences are remembered in this browser profile. An availability check verifies the periodic capability handshake, or locates the Elmer executables; it does not certify arbitrary physical models or all Elmer runtime dependencies.

## Periodic unit cell

Use the native CPU executable built from the [experimental periodic patch](../scripts/experimental-periodic/README.md). Stock openEMS and the normal GPU engine are not substitutes. The app accepts only the required capability revision and pins the executable and adjacent native library hashes when admitting a job.

The implemented scope is zero phase shift across x/y, normal incidence along +z, Ey polarization, PML in z, and the co-polar fundamental reflection/transmission below the first vacuum diffraction threshold. Oblique incidence, nonzero Bloch phase, higher-order Floquet modes, cross-polarized S matrices and GPU execution are not implemented. This can exercise a bounded periodic structure; it does not yet qualify a general metamaterial workflow.

Start with the lossless dielectric slab reference, or select the current Design snapshot. The latter accepts axis-aligned boxes with lossless isotropic dielectric or PEC materials. Parameters are evaluated into that immutable snapshot. The app rejects ports, lumped elements, non-box solids, transforms, cuts, dispersive/lossy material properties, out-of-cell boxes and underresolved features instead of silently dropping them. Split seam-crossing solids explicitly within the centered cell. PEC sheets must lie on mesh planes.

Choose cell periods, the front/back S-parameter reference planes, frequency band and mesh density (20, 30 or 40 cells per wavelength). Objects must lie between the reference planes. The research mesh has bounded resources: at most 64 boxes, 500,000 cells, 80,000 timesteps and 180 seconds per native reference/sample solve. Resource or geometric rejection is not permission to relax these safeguards blindly.

Each result comes from an empty-reference/sample pair. The panel plots S11 and S21 in dB and includes a numerical table and provenance. Full complex values, CSV, NPZ, generated XML, probes and logs are retained in the job directory. Numerical QA checks energy decay, empty-reference reflection and an upper bound on co-polar power. Reference fixtures also check an analytical response. Co-polar power alone cannot establish conservation when power is converted into another polarization.

**A passed run is not a mesh-convergence certificate.** The result explicitly records `mesh_convergence_checked: false`. Compare complex responses across mesh levels for each new design, and establish an independent physical reference before using the result for engineering decisions. Failed numerical QA preserves outputs but marks the job failed.

## Elmer FEM cavity

Select a native package containing `bin/ElmerSolver` and `bin/ElmerGrid` (or its binary directory). The integration runs only a fixed 0.10 × 0.05 × 0.20 m vacuum PEC cavity, at mesh targets 0.025 or 0.0125 m. It does not translate the current Design. It reports eigenfrequencies, the TE101 exact-frequency error and complex field-shape correlation. It has no driven ports, antenna S parameters, radiation boundary or far-field output.

See [the Elmer experiment](ELMER-EXPERIMENT.md) for the analytical definition, standalone command, native observations and distribution evidence. The standalone command remains independent of the app queue; do not run it concurrently with another solver. Third-party binaries are external and are not redistributed by this integration.

## Reproducibility and recovery

Each research job stores `input/research.json` with a SHA-256, selected native binaries/libraries, normalized settings and any Design snapshot. Workers recheck these hashes before launching. Results live under that job's `research/` directory; the job records their hash and rejects modified results on reload. System libraries remain outside the native pin scope.

Research jobs share ordinary queue serialization and process-tree cancellation, but never publish an antenna viewer bundle or replace the current project result. Queued cancellation launches no solver. Interrupted jobs retain their input/logs rather than automatically restarting numerical work. Run history records failures as well as passes.

## Development checks

Run the repository checks in `AGENTS.md`, plus:

```powershell
python -m unittest discover -s python/tests -p test_periodic_cell.py -v
python -m unittest discover -s python/tests -p test_research_jobs.py -v
npm run check:research
```

The browser check uses a synthetic API to exercise state and presentation. Native solver qualification is separate: retain actual input snapshots, raw outputs, numerical comparisons and solver hashes. Neither synthetic results nor a capability probe are evidence of numerical accuracy.

The [Windows qualification record](benchmarks/research-solvers-windows-20261009.json) includes actual native fixture results, failed controls, refinement differences, binary hashes and the real HTTP queue checks. The slab's maximum absolute complex S-parameter error decreased from 0.00912 to 0.00364 to 0.00228 at 20/30/40 cells per wavelength. These are absolute complex-amplitude errors, not dB differences or relative percentages near a zero. This evidence covers those fixtures, not arbitrary designs.
