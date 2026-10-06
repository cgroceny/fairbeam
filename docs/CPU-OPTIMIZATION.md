# Experimental openEMS CPU optimizations

Opt-in source patches target the pinned openEMS beta engine at commit `08e15ff532a7f4cfd1d4e7164ec262f5187bf30e`: extension-phase scheduling, scalar SSE index mapping in UPML boundary hooks, and a separate UPML coefficient/flux row-pointer experiment. The first two patches came first; the row-pointer patch is the subsequent experiment. Except on macOS (see [the last section](#macos-shipped-and-on-by-default)), these engines are not installed or distributed as a Fairbeam runtime and application defaults remain unchanged.

The current engine calls six extension phases per timestep: pre-voltage, post-voltage, apply-voltage, pre-current, post-current, and apply-current. Each extension hook is followed by a worker barrier. The prototype caches per-phase schedules and classifies only exact dynamic types whose hook masks were audited:

| Exact extension type | Active phases |
| --- | --- |
| `Engine_Ext_UPML` | Pre/post voltage and pre/post current |
| `Engine_Ext_Excitation` | Apply voltage and apply current |
| `Engine_Ext_LumpedRLC` | Pre-voltage and apply-voltage |
| `Engine_Ext_Mur_ABC` | Pre-voltage, post-voltage, and apply-voltage |
| Any other type, including subclasses of the listed types | All six phases |

Pre phases retain reverse extension priority; post and apply phases retain forward priority. Every active hook still has its following barrier. Consecutive audited-empty hooks become one barrier-only schedule entry, including leading, interior, trailing, and fully empty phases. Retaining the leading pre-voltage fence matters because thread zero publishes `numTS` after the previous apply-current barrier and Mur checks that timestep before its hook. The two core field-update barriers are unchanged. The schedule pointer snapshot is checked before each `IterateTS` releases workers, then rebuilt if the multigrid engine replaced, added, or reordered extensions after initialization. Mutating an extension list while an iteration is running remains unsupported.

The legacy path remains the default. To opt a newly launched native solver process into the prototype, set the environment variable before the process starts:

```powershell
$env:OPENEMS_EXPERIMENTAL_CPU_PHASE_DISPATCH = 'phase-lists'
& 'C:\path\to\openEMS.exe' <normal arguments>
Remove-Item Env:OPENEMS_EXPERIMENTAL_CPU_PHASE_DISPATCH
```

The first iteration prints scheduled versus legacy extension-barrier counts per timestep; the two core barriers are reported as unchanged. Those counts are source-level scheduling counts, not measurements of wait time or solve speed.

## Apply and inspect

Use a clean checkout at the exact pinned revision. The application script refuses a different revision, a dirty source worktree, or patch context that does not match:

```powershell
.\scripts\native-cpu\apply-cpu-dispatch.ps1 -SourceRoot 'C:\src\openEMS'
git -C 'C:\src\openEMS' diff --check
```

The script applies `scripts/native-cpu/openems-cpu-phase-dispatch.patch` without committing. To remove the prototype from that source checkout, run `git -C 'C:\src\openEMS' apply -R 'C:\path\to\fairbeam\scripts\native-cpu\openems-cpu-phase-dispatch.patch'` after stopping any build or solver using it.

The dependency-light harness compiles the production phase-list header and the pinned `Engine_Extension` base implementation. It checks exact-type masks, unknown and derived fallback, hook order, collapsed empty runs, barriers, and thread-zero no-argument delegation:

```powershell
.\scripts\native-cpu\run-dispatch-harness.ps1 -SourceRoot 'C:\src\openEMS'
```

This helper drives workers sequentially and counts barrier callbacks. The separate native integration harness uses real `Engine_Multithread` workers with PML and Mur boundaries at one and four workers. It checks setup/reset/double reset, zero-length Cartesian batches, 1,000 steps in a single batch versus single-step batches, and parked extension-priority reorder/cache refresh. A Dirac excitation on a Mur plane additionally verifies delayed activation at step 12. Full E/H snapshots match exactly both within each build and between baseline/candidates. It does not test concurrent mutation/reset during an active iteration; that remains unsupported. Cylindrical/multigrid integration remains outside the tested scope.

## Separate UPML SSE cursor experiment

The separate `scripts/native-cpu/openems-cpu-upml-cursor.patch` removes repeated scalar `z % N` and `z / N` mapping from the four UPML voltage/current hooks. It is enabled only when `OPENEMS_EXPERIMENTAL_CPU_UPML_CURSOR=cursor` is set before the process loads the native runtime and the engine's exact dynamic type is `Engine_sse`, `Engine_SSE_Compressed`, or `Engine_Multithread`. The latter two inherit the same `ArrayENG` field layout; additional derived types—including cylindrical/multigrid engines—and all unknown engines retain their original accessors. The setting is sampled at library load, the default path returns before RTTI or array checks, and one line names the supported types when the cursor path is first selected. The cursor uses `ArrayENG`'s component and vector strides, initializes `r=startZ%N` and `lane=startZ/N` once per phase, resets each XY row, and advances across only the physical z range. UPML coefficients, arithmetic, component order, flux updates, and loop bounds remain as in the existing implementation.

Apply it to a clean checkout at the pinned openEMS revision. To combine it with the exact frozen phase-dispatch patch, pass the explicit switch; the helper checks that patch's three file hashes before adding the non-overlapping UPML changes:

```powershell
.\scripts\native-cpu\apply-upml-cursor.ps1 -SourceRoot 'C:\src\openEMS'
# Or, on the exact pinned phase-dispatch candidate:
.\scripts\native-cpu\apply-upml-cursor.ps1 -SourceRoot 'C:\src\openEMS' -AllowKnownPhaseDispatchPatch
```

The dependency-light harness compiles the production cursor helper with the real `ArrayENG` container in both supported storage layouts. It checks the production exact-type predicate against an inheritance fixture (the three exact supported classes pass and a further-derived type falls back), then checks all four `Nz mod 4` classes, complete physical rows, nonzero starts crossing vector-index wraps, row resets, and padded-lane sentinels:

```powershell
.\scripts\native-cpu\run-upml-cursor-harness.ps1 `
  -SourceRoot 'C:\src\openEMS' `
  -CompilerPath 'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.42.34433\bin\Hostx64\x64\cl.exe'
```

The harness runner also verifies that the production dispatch binds the predicate to `Engine_sse`, `Engine_SSE_Compressed`, and `Engine_Multithread`. Both storage-layout mapping tests passed. The separate native field harness confirms actual multithread cursor activation and exact baseline field equality for all four `Nz mod 4` classes (42–45 z lines), including batch/single-step equivalence, parked reorder and reset. These diagnostic grids are not included in timed solver results. Standalone uncompressed/compressed single-thread engine types and native cylindrical/multigrid engines have not been integration-tested; the latter retain the cursor fallback.

## Separate UPML coefficient/flux row pointers

The third patch, `scripts/native-cpu/openems-cpu-upml-rows.patch`, derives coefficient and flux row addresses once per XY row from each `ArrayNIJK` object's own component and z strides. The four voltage/current pre/post hooks retain their scalar operations, component order, flux-store order and physical loop bounds. No mesh, precision, contraction, SIMD/ISA, material or stopping-rule change is introduced. Pointers are phase-local and are not advanced after the last physical row element.

Rows is nested under the existing cursor's exact engine-type gate. Set `OPENEMS_EXPERIMENTAL_CPU_UPML_CURSOR=cursor` and `OPENEMS_EXPERIMENTAL_CPU_UPML_ROWS=rows` in the child environment before native DLL load. Phase dispatch is a separate setting; the validated combined experiment also sets `OPENEMS_EXPERIMENTAL_CPU_PHASE_DISPATCH=phase-lists`. Setting only the rows flag keeps the legacy path. Each nonempty phase logs activation once; an array-bounds rejection logs once before any write and falls back to the cursor path. Disabled flags, unknown/further-derived engines, cylindrical/multigrid engines and GPU engines retain their existing paths.

Apply rows only to the exact frozen phase-dispatch-plus-cursor source state at the pinned revision. The helper checks revision, changed-file set, base-file hashes, dependency-patch hashes, rows-patch bytes and forward context before applying:

```powershell
.\scripts\native-cpu\apply-cpu-dispatch.ps1 -SourceRoot 'C:\src\openEMS'
.\scripts\native-cpu\apply-upml-cursor.ps1 -SourceRoot 'C:\src\openEMS' -AllowKnownPhaseDispatchPatch
.\scripts\native-cpu\apply-upml-rows.ps1 -SourceRoot 'C:\src\openEMS'
.\scripts\native-cpu\run-upml-rows-harness.ps1 `
  -SourceRoot 'C:\src\openEMS' `
  -CompilerPath 'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.42.34433\bin\Hostx64\x64\cl.exe'
```

Use PowerShell 7 and the matching x64 Visual Studio developer environment for these helpers. The dependency-light test exercises the actual production row helper and real `ArrayNIJK`: contiguous and swapped strides, nonzero row starts, empty worker slabs, zero z count, a one-element row, terminal component/XY rows, and out-of-bounds/fewer-component rejection. The separate native harness compares full E/H plus every UPML voltage/current flux array, including extension counts and extents. Its 36 serial cases cover workers 1–4, PML/Mur/mixed boundaries, PML thickness 1/4/8/12, z line counts 42–45, 1,000-step batch/single-step equality, parked priority reorder, zero-length batches and reset/double reset. Standalone single-thread SSE types, cylindrical/multigrid engines and GPU integration have not been tested for rows.

## Windows validation checkpoint, 1 October 2026

The dependency prefix, fparser, CSXCAD, baseline engine, phase-only candidate and combined phase/cursor candidate all built successfully with MSVC 14.42. All three engines use matching dependencies and Release `/MD /O2 /Ob2 /DNDEBUG /fp:precise`, CUDA off and flush-to-zero on. Successful builds have fresh provenance records. Python loads the staged openEMS, CSXCAD, fparser and nf2ff DLLs, and their actual paths and hashes are checked. With both opt-in flags absent, the combined candidate's retained solver outputs also match the baseline. No installed runtime or global environment setting is changed.

The subsequent row-pointer candidate built with the same compiler, flags and dependencies. Relative to the previous phase/cursor engine, five alternating pairs per worker count measured native solve medians of **27.49 → 10.37 s at one worker (62.3% less time)** and **11.48 → 6.85 s at four workers (40.3% less time)**. Every pair won and median gaps exceeded both observed ranges. All 26 full solves retained bitwise baseline equality and the 36-case E/H/UPML-state matrix passed. Independent post-run binary checks also verified finite, nonzero voltage/current flux for every captured UPML extension; the C++ harness itself asserts nonzero E/H and UPML presence/extents. Numeric exports and snapshots were rehashed independently. This is a single coarse PML-heavy dipole on the recorded Ryzen 9 7900X system, with no physical-convergence, universal or combined-GPU-runtime speed claim. Profiling runs are excluded from these measurements.

## Paired native build

The paired driver is experimental preparation for native parity testing. It requires clean, exact source checkouts for vcpkg, fparser, CSXCAD and the unmodified/patched openEMS pair, plus a completed vcpkg target prefix. The tracked manifest and custom triplet pin the dependency selection and x64 Release ABI; `prepare-vtk-overlay.ps1` creates the narrow VTK IO-module overlay from the pinned vcpkg port. The driver refuses mismatched revisions, a dirty baseline, unexpected candidate files, changed manifest/triplet/VTK port, missing dependencies, or a wrong compiler/toolchain cache.

Run the VTK overlay preparation once against a clean vcpkg checkout at the pinned revision, then install the checked-in manifest with that overlay and triplet into a scratch prefix. The overlay output directory must not already exist:

```powershell
$repo = 'C:\path\to\fairbeam'
$study = 'C:\path\to\cpu-study'
$vcpkg = 'C:\path\to\clean\vcpkg-cpu-study'
& "$repo\scripts\native-cpu\prepare-vtk-overlay.ps1" `
  -VcpkgRoot $vcpkg `
  -OverlayPortsRoot "$study\deps\overlay-ports"
```

The build driver expects the prepared manifest at `deps\manifest-v002`, the custom triplet at `deps\triplets`, the generated port overlay at `deps\overlay-ports`, and installed packages at `deps\installed`. Run it from an x64 Visual Studio 2022 developer environment with the pinned CMake 3.29.5, Ninja and MSVC 14.42 paths. It builds fparser, CSXCAD, baseline openEMS and candidate openEMS sequentially, each with two Ninja jobs, Release `/MD /O2 /Ob2 /DNDEBUG /fp:precise`, CUDA off and flush-to-zero on. The two openEMS builds receive identical CMake arguments and separate clean build and stage directories. It copies the rebuilt native DLLs and prepared vcpkg DLLs into both stage directories and records source revisions, compiler and cache settings, command logs, completed stages, failures, and hashes for staged DLLs/executables/import libraries plus rebuilt fparser/CSXCAD binaries and import libraries under `results\<run>\provenance.json`.

The driver performs no solver run. Its successful paired provenance reaches `paired-native-builds-and-stages-complete`; native harness and timed solver evidence are recorded separately. The additional combined candidate reuses the successful configure arguments, compiler and dependency prefix, changing only source/build/install paths. If a build fails, its provenance records the failing command and completed stages for diagnosis. Legacy behavior remains the default: neither CUDA support nor a production runtime release was validated by these CPU-only experimental builds.

## macOS: shipped and on by default

The macOS openEMS pack ships the three patches, and Fairbeam turns them on by default on macOS, because
five CPU cases were bitwise identical to the unpatched build on both bases
(patch starter, pyramidal horn, blade 867, two-port microstrip, dipole; solver 1.3 to 1.7 times
faster). Windows and Linux are unchanged: the patches stay opt-in there, as described above.

- **Base.** The pack is built from openEMS `12cd91de2` (`runtime/pins.json`), not from the `08e15ff`
  beta that the sections above target. The cursor and rows patches apply to both unchanged; the
  phase-dispatch patch for `12cd91de2` is `scripts/native-cpu/macos/openems-cpu-phase-dispatch-12cd91de2.patch`
  (one include-order change). `scripts/native-cpu/apply-macos.sh <openEMS source>` refuses any other
  revision, checks the SHA-256 of the three patches and of every changed file, and is idempotent.
- **Build.** `scripts/install-openems-macos.sh` calls it before it builds openEMS (`NATIVE_CPU=1` by
  default; `NATIVE_CPU=0` builds the unmodified openEMS) and rebuilds openEMS alone when the installed
  library lacks the patches. `scripts/build-openems-macos-pack.py` detects them in the library, records
  their hashes in `openems-pack.json` and `NOTICE.md`, and adds `-ncpu1` to the pack's name.
- **Activation.** `fairbeam/__init__.py` sets `OPENEMS_EXPERIMENTAL_CPU_PHASE_DISPATCH=phase-lists`,
  `OPENEMS_EXPERIMENTAL_CPU_UPML_CURSOR=cursor` and `OPENEMS_EXPERIMENTAL_CPU_UPML_ROWS=rows` before
  openEMS loads, on macOS only, and never replaces a value already in the environment. A library
  without the patches ignores them (the GPU build in `~/opt/openEMS-gpu` is one; the Metal engine
  does not use them).
- **Opt out.** `FAIRBEAM_NATIVE_CPU=0` (also `off`, `false`, `no`) in the environment of the app, the run
  server or the CLI.
- **Run log.** The run log shows `fairbeam: note: native CPU patches requested (...)` and, from openEMS
  itself, one `Experimental CPU ...` line per patch that was applied (six lines with PML, one with
  MUR). Without those lines the run used the plain engine.
