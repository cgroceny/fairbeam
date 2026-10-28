# Experimental solvers in the app

The regular **Run** dialog offers openEMS (the default), **Elmer FEM — Experimental eigenmodes**, and **Elmer FEM · Experimental antenna**. Elmer Design runs use the ordinary run server and serial queue, with their own settings and result history. The installed openEMS runtime, its run path, project format and antenna results are unchanged. The Simulation ribbon's **Experimental solvers** command also retains the fixed research fixtures and runtime setup. No additional solver is downloaded or installed automatically.

This is an opt-in research integration, not a production Floquet port or general FEM antenna solver. Windows native execution has been exercised; macOS native execution and packaging still need qualification.

## Configure and run

1. Installed desktop users should follow the [experimental solver guide](EXPERIMENTAL-SOLVERS.md); there is no source-build prerequisite. Contributors running this source revision should use the normal [source setup](FROM-SOURCE.md).
2. In Design, open Simulation → Experimental solvers.
3. Choose a backend and enter its local executable/package path. The stock PEC/PMC cell can use the installed openEMS runtime with a blank path. Check availability before submitting. A missing or incompatible backend prevents submission.
4. Submit a bounded experiment. It waits behind any existing simulation; cancellation uses the same process-tree cleanup as the ordinary queue.
5. Select the run in the research history to inspect its result. Closing the panel does not cancel an active run. Reopening history retrieves the saved result.

**Elmer on Windows without a manual install.** With the Elmer backend selected and no Elmer found, the panel offers **Install Elmer**. Fairbeam then downloads the official portable Windows package (`ElmerFEM-nogui-nompi-Windows-AMD64-rel26.1.zip`, 124 MB, from the Elmer download mirror) and checks it against the size and SHA-256 pinned in `python/fairbeam/elmer_runtime.py`. It unpacks the package into the app's data folder (`%LOCALAPPDATA%\org.fairbeam.desktop\elmer\26.1`) and uses it whenever the path field is left blank. Nothing is installed system-wide. A folder you enter, `FAIRBEAM_ELMER_ROOT` or Elmer on `PATH` still take precedence. On macOS and Linux, install Elmer yourself.

You can instead set `FAIRBEAM_PERIODIC_EXECUTABLE` or `FAIRBEAM_ELMER_ROOT` in the run server's environment. Local path preferences are remembered in this browser profile. An availability check verifies the periodic capability handshake, or locates the Elmer executables; it does not certify arbitrary physical models or all Elmer runtime dependencies.

### Installed-app adapter

The desktop bundle includes `fairbeam_elmer.py` and copies it into the managed Python app directory during updates. If an older or damaged installation reports `No module named fairbeam_elmer`, update or repair Fairbeam; reinstalling the Elmer binaries alone does not repair the missing adapter.

The panel includes a **How to run this experiment** guide. A missing periodic runtime is a prerequisite failure, not evidence of an Elmer installation problem. There is no automatic periodic backend installer: build the explicitly linked research backend first. On macOS its native build still needs platform qualification.

## Periodic unit cell

Use the native CPU executable built from the [experimental periodic patch](../scripts/experimental-periodic/README.md). Stock openEMS and the normal GPU engine are not substitutes. The app accepts only the required capability revision and pins the executable and adjacent native library hashes when admitting a job.

The implemented scope is zero phase shift across x/y, normal incidence along +z, Ey polarization, PML in z, and the co-polar fundamental reflection/transmission below the first vacuum diffraction threshold. Oblique incidence, nonzero Bloch phase, higher-order Floquet modes, cross-polarized S matrices and GPU execution are not implemented. This can exercise a bounded periodic structure; it does not yet qualify a general metamaterial workflow.

Start with the lossless dielectric slab reference, or select the current Design snapshot. The latter accepts axis-aligned boxes with lossless isotropic dielectric or PEC materials. Parameters are evaluated into that immutable snapshot. The app rejects ports, lumped elements, non-box solids, transforms, cuts, dispersive/lossy material properties, out-of-cell boxes and underresolved features instead of silently dropping them. Split seam-crossing solids explicitly within the centered cell. PEC sheets must lie on mesh planes.

Choose cell periods, the front/back S-parameter reference planes, frequency band and mesh density (20, 30 or 40 cells per wavelength). Objects must lie between the reference planes. The research mesh has bounded resources: at most 64 boxes, 500,000 cells, 80,000 timesteps and 180 seconds per native reference/sample solve. Resource or geometric rejection is not permission to relax these safeguards blindly.

Each result comes from an empty-reference/sample pair. The panel plots S11 and S21 in dB and includes a numerical table and provenance. Full complex values, CSV, NPZ, generated XML, probes and logs are retained in the job directory. Numerical QA checks energy decay, empty-reference reflection and an upper bound on co-polar power. Reference fixtures also check an analytical response. Co-polar power alone cannot establish conservation when power is converted into another polarization.

**A passed run is not a mesh-convergence certificate.** The result explicitly records `mesh_convergence_checked: false`. Compare complex responses across mesh levels for each new design, and establish an independent physical reference before using the result for engineering decisions. Failed numerical QA preserves outputs but marks the job failed.

## Stock openEMS PEC/PMC cell

Choose **Stock openEMS · PEC/PMC cell** for the installed CPU runtime, without the
experimental periodic patch. This is a symmetry-boundary model: Ey excitation,
normal propagation along +z, PMC on the two x faces, PEC on the two y faces and
16-cell PML at both z ends. It has no Bloch phase, Floquet ports, oblique incidence,
cross-polarized response or multimode scattering output. The boundary convention
follows the upstream [parallel-plate tutorial](https://docs.openems.de/en/latest/python/openEMS/Tutorials/Parallel_Plate_Waveguide.html).

The slab fixture or current Design must consist of constant, lossless isotropic
dielectric boxes or PEC boxes/sheets. Every box must have an x- and y-reflected
counterpart with the same material and priority; a centered box is its own
counterpart. Admission compares the box multiset, not just its bounding envelope.
Only 32 binary64 ULPs at the coordinate scale are allowed for expression roundoff;
this is not a physical-distance or mesh tolerance. Ambiguous equal-priority
material overlaps, including a PEC sheet with the same priority inside a dielectric,
are refused. Geometry, material losses, material-level sheet-thickness metadata,
dispersion, transforms, ports or other unsupported physics are never removed to
make a Design fit. An unsupported Design must be changed explicitly by its author.

The setup uses the same bounded uniform-mesh policy as the research box controls:
20, 30 or 40 cells per wavelength, at most 64 boxes and 500,000 cells, 80,000 time
steps and 180 seconds per native solve. Both runs use one explicit conservative
vacuum-Courant time step (supported dielectrics have εr ≥ 1). The complete mesh,
probe locations and measured probe time step must agree. Failure, cancellation,
nonconvergence or an invalid empty reference prevents a sample solve. There is no
automatic retry or time-limit extension. Raw probes, logs, XML, input and binary
hashes, CSV and complex arrays remain in the research job directory.

Results contain co-polar S11/S21 referred to the selected front/back sample faces.
Wrapped reflection phase uses exp(+jωt) and the front face as its reference; it is
unavailable where |S11| < 0.001 (−60 dB), where reflection phase is poorly defined.
The phase floor is an interpretation bound, not measured instrument dynamic range.
The CSV includes the actual frequency, complex S values, phase and any reliable
material inversion. JSON export retains the result's complete recorded provenance.

**Retrieve slab εr and μr (NRW)** is optional and is admitted only for one homogeneous
dielectric slab filling the cross-section between the selected faces. Its thickness
is exactly `back − front`; a patterned surface or a PEC reflector cannot be relabeled
as an effective homogeneous material. The existing Nicolson–Ross–Weir inversion
uses group delay with the explicit nonmagnetic material constraint to choose a
branch. The half-wave reliability floor is 0.3 by default, with the stricter 0.5
option; it cannot be reduced here. Opaque, ambiguous-branch and unreliable
half-wave points stay unavailable in the table and CSV, while the raw inversion,
branch segments and masks remain in JSON. Imaginary parts follow exp(+jωt), so a
passive dielectric loss would have a negative imaginary part under this convention.

Completion is **results_exported**, never a validated-material or mesh-convergence
certificate. Required numerical gates cover energy decay, empty-reference
reflection ≤ 0.001 and co-polar power ≤ 1.01, with an absolute complex-S error ≤ 0.02
for a fixed analytical fixture. These gates do not establish general conservation
or physical accuracy. Native stock-binary air, PEC-reflector and slab controls,
independent phase checks and mesh refinement remain necessary for platform
qualification. PMC wall discretization has its own uncertainty. This interface
does not resolve the separate periodic/Floquet or seam-Q research questions.

## Elmer FEM cavity

### Current Design from the Run dialog

1. Open a saved Design and choose **Run → Solver → Elmer FEM — Experimental eigenmodes**.
2. Review the enclosure bounds suggested from box geometry, or enter custom bounds in millimeters. Empty space is vacuum. The mesh places planes at box faces and subdivides to the requested maximum cell size.
3. Set a target frequency in GHz. The solver searches for two eigenmodes near that target, not necessarily the lowest modes or a frequency sweep. If the eigenvalue search does not converge, choose a target closer to an expected mode and inspect the retained solver log.
4. Select the explicit closed-PEC option. All six enclosure faces and internal PEC surfaces get a zero tangential electric-field boundary. These are separate Elmer settings: existing openEMS boundary, frequency and mesh settings are neither applied nor modified.
5. Leave the path blank for managed Elmer, or enter its installation folder. **Elmer setup and history** opens the existing installation controls. Save and run; results open in solver history, also accessible from the shared queue.

Supported geometry is axis-aligned box volumes with constant, positive, lossless isotropic dielectric properties or PEC. Overlaps, ports, lumped elements, sheets, curves, transforms, cuts, losses and dispersion are rejected before submission. The experimental solve is limited to 4,000 elements, 10,000 nodes, one CPU thread and a 120-second native timeout. No driven ports, S parameters, radiation pattern or field viewer are provided. Raw VTU fields, mesh, SIF, logs and immutable Design inputs are retained with the job.

A completed Design run is **results_exported**, not **results_validated**. Completion requires two finite positive frequencies and a finite nonzero electric field; it is not mesh convergence or physical validation. Repeated eigenfrequencies are permitted for degenerate modes. The selected target and material properties are recorded with the mesh.

Minimal Windows smoke: an air-filled Design box from (0,0,0) to (100,50,200) mm, matching PEC enclosure bounds, 25 mm cells and a 1.8 GHz target returned 1.712767517 and 2.174670253 GHz with native Elmer 26.1, including through the actual shared queue. The first agrees with the earlier fixed-fixture numerical result (analytical TE101 is 1.675890788 GHz, about 2.20% discretization error). This single control is not qualification of arbitrary Design geometries. Native macOS execution still needs a platform check.

### Fixed reference fixture

Select a native package containing `bin/ElmerSolver` and `bin/ElmerGrid` (or its binary directory). The reference experiment runs a fixed 0.10 × 0.05 × 0.20 m vacuum PEC cavity, at mesh targets 0.025 or 0.0125 m. This reference fixture does not translate the current Design; use the Run dialog workflow above for that. It reports eigenfrequencies, the TE101 exact-frequency error and complex field-shape correlation. It has no driven ports, antenna S parameters, radiation boundary or far-field output.

See [the Elmer experiment](ELMER-EXPERIMENT.md) for the analytical definition, standalone command, native observations and distribution evidence. The standalone command remains independent of the app queue; do not run it concurrently with another solver. Third-party binaries are external and are not redistributed by this integration.

## Reproducibility and recovery

Each research job stores `input/research.json` with a SHA-256, selected native binaries/libraries, normalized settings and any Design snapshot. Workers recheck these hashes before launching. Results live under that job's `research/` directory; the job records their hash and rejects modified results on reload. System libraries remain outside the native pin scope.

Research jobs share ordinary queue serialization and process-tree cancellation, but never publish an antenna viewer bundle or replace the current project result. Queued cancellation launches no solver. Interrupted jobs retain their input/logs rather than automatically restarting numerical work. Run history records failures as well as passes.

## Development checks

Run the repository checks in `AGENTS.md`, plus:

```powershell
python -m unittest discover -s python/tests -p test_periodic_cell.py -v
python -m unittest discover -s python/tests -p test_research_jobs.py -v
python -m unittest discover -s python/tests -p test_stock_cell.py -v
npm run check:research
```

The browser check uses a synthetic API to exercise state and presentation. Native solver qualification is separate: retain actual input snapshots, raw outputs, numerical comparisons and solver hashes. Neither synthetic results nor a capability probe are evidence of numerical accuracy.

The [Windows qualification record](benchmarks/research-solvers-windows-20261009.json) includes actual native fixture results, failed controls, refinement differences, binary hashes and the real HTTP queue checks. The slab's maximum absolute complex S-parameter error decreased from 0.00912 to 0.00364 to 0.00228 at 20/30/40 cells per wavelength. These are absolute complex-amplitude errors, not dB differences or relative percentages near a zero. This evidence covers those fixtures, not arbitrary designs.
## Driven Elmer antenna prototype

Choose **Run → Elmer FEM · Experimental antenna** for a patch Design made of axis-aligned
dielectric boxes and PEC sheets with one ideal line lumped port. Sweep bounds and far-field
frequency start from the Design. Air padding generates the open region automatically; it
uses first-order absorbing boundaries, not PEC walls or PML. The user explicitly accepts a
finite rectangular FEM terminal width (initially 1 mm). Its width axis is the first Cartesian
axis other than the excitation direction; both terminal ends must contact PEC sheets.
The source Design and openEMS setup are never changed.

The adapter uses Elmer VectorHelmholtz, native port impedance and complex S-matrix extraction,
and a direct UMFPACK solve. Dielectric loss is translated to conductivity at the Design's
loss-reference frequency. The antenna UI approximates finite-conductivity metals as PEC only
in the FEM snapshot, explicitly omitting conductor loss; affected material names are recorded
in the result. The source Design keeps its conductivity. Curved geometry, transforms, cuts, additional
lumped components and multiple ports are rejected. The initial limits are 10,000 cells,
3–21 sweep samples plus the requested far-field frequency, one thread and 180 seconds per
frequency. Native macOS execution still needs qualification, including UMFPACK availability.

Results include S11, a rotatable normalized 3D field pattern and directivity cuts. A vacuum
Huygens surface integral uses exported complex E/H fields and Elmer's exp(-i omega t)
convention. It is checked against Hertzian-dipole power and directivity at two surface radii
(power error below 1%, directivity error below 0.02 dB). It does not expose gain or efficiency.
Raw fields, complex S11, input Design, settings, generated meshes, logs and hashes stay with
the job. A completed run is **results_exported**, never a convergence certificate.

Windows patch starter smoke: at 2.35 GHz, 1 mm feed and 40 mm padding, maximum 12 mm air
cells gave S11 = -0.77437268 + 0.16389637i and peak directivity 6.75286 dBi. With 8 mm cells,
S11 = -0.81870534 + 0.10499537i and peak directivity 6.76860 dBi. With 12 mm cells and 60 mm
padding, S11 = -0.79490084 + 0.15111720i and peak directivity 6.67766 dBi. These differences
remain numerical uncertainty, not proof of convergence or agreement with an ideal line feed.
An attempted iterative 8 mm solve failed to converge; its evidence is retained. The direct
solver completed that mesh. A real three-frequency queue run and EN/TR browser flow also
completed, showing S11 and the 3D/cut pattern while retaining the original port.

For supported box Designs, the eigenmode enclosure initially follows the geometry envelope.
The bounds remain editable. This convenience does not infer an open radiation boundary:
the user still explicitly acknowledges six PEC walls.

## Native scattering control

`scripts/check-elmer-scattering.py` exercises Elmer's own two-port VectorHelmholtz control,
pinned to upstream revision `5a8de867068be0568f09af40fb90fee300dfbede`. It retains downloaded
inputs, binary and input hashes, logs, and the complex S matrix in a fresh output folder:

```text
python scripts/check-elmer-scattering.py --elmer-root <installation> --out <new-folder>
```

On the Windows Elmer 26.1 runtime, the 2.5 GHz control passed both upstream reference norms.
Its maximum S-matrix singular value was 1.0000000000396843 and reciprocity error was
4.24e-11. The S11 magnitude was -40.83097 dB. These are **waveguide control results**, not
patch-antenna results or a qualification of the Design adapter. Passivity is checked on the
whole complex matrix, without clipping, with tolerance 0.001; reciprocity tolerance is 1e-6.

### Qualification still needed

Driven Elmer runs now follow the designer's ordinary Run dock and publish a project
bundle under Results. S11, impedance, Smith and directivity use the existing tabs and
comparison tools. The research dialog remains for cavity and periodic experiments.
The bundle retains the admitted input hash and FEM settings. Native Elmer complex
S11 uses `exp(-i omega t)`; export conjugates it to the shared `exp(+i omega t)`
convention. Raw native files remain unchanged. Completion does not become an FDTD
energy-convergence badge, and unknown accepted power and efficiency stay null.

Refine both the maximum cell size and the substrate thickness cell count (2–10),
then increase the air padding separately. The 10,000-element admission limit remains
in force. Reaching that limit is not evidence of convergence. A common-coordinate
FDTD mesh is not automatically equivalent to a finite-element mesh: its staggered
current probe needs a nondegenerate contour, and sheet-edge placement changes its
effective electrical geometry. Use each method's appropriate mesh and convergence
controls when comparing results.

Establish terminal-width, mesh and padding convergence with a sufficiently dense resonance
sweep. Compare a consistent finite feed model across solvers before claiming agreement.
Add matched-terminal and accepted/radiated-power controls before exposing gain/efficiency.
The existing native waveguide test and analytical far-field test do not establish arbitrary
Design accuracy. Keep this path explicitly experimental; openEMS remains the default.

The October 11 patch comparison did **not** qualify the driven adapter. With PEC sheets,
a 32 × 40 mm patch, a 1.524 mm substrate (relative permittivity 3.38), and a 1 mm
terminal, the production openEMS mesh sampled its S11 minimum near 2.45 GHz, while
the 7 mm Elmer mesh sampled its minimum at 2.25 GHz (50 MHz sweep spacing).
The maximum complex-S11 change between the 8 mm and 7 mm FEM meshes was 0.128,
above the study's 0.03 criterion. Increasing substrate layers from two to four
changed complex S11 by only 0.0016 at the three checked frequencies. Increasing
the air margin from 40 to 60 mm on the 12 mm mesh changed it by 0.052.
Neither control explains the full discrepancy. Local surface and adjacent-air
refinement also did not establish agreement and was not promoted into the adapter.

At 2.45 GHz the 7 mm FEM and fine production openEMS meshes differed by about
0.02 dB in peak directivity and 4.9% in a solid-angle-weighted relative L2 pattern
comparison. This normalized pattern agreement does not validate input impedance,
gain, efficiency, or the remaining S11 discrepancy. The production openEMS
20-to-40 cells-per-wavelength comparison also exceeded the study's strict complex
S11 criterion (0.065 versus 0.03), so it is not an exact reference solution.
