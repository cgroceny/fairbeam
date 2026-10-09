# Standalone native Bloch kernel milestone

This C++17 kernel advances paired real/imaginary electric and magnetic fields in three
dimensions with nonzero x/y Bloch seams. It is compiled and tested independently of
openEMS. It does not modify the installed solver, the existing zero-phase patch, the
revision-4 handshake, or Fairbeam's run path. No native openEMS nonzero-phase capability
is advertised.

## Architecture and scope

The inspected native source is the experimental zero-phase patch applied to openEMS
revision `08e15ff532a7f4cfd1d4e7164ec262f5187bf30e`. Its `FDTD/engine.cpp`
updates voltage from backward current differences, advances current from negative
forward voltage differences, and copies periodic high planes after extensions.
`Engine` stores one real voltage/current channel. `Engine_Ext_UPML` separately owns
real voltage/current flux states; excitation and the extension dispatcher use scalar
engine access. A real native integration therefore needs changes to storage, extensions,
excitation, diagnostics, and outputs together.

`bloch_kernel.h` isolates the next algebraic step:

- Three electric and three magnetic components, each represented by two real doubles.
- Unique x/y samples plus duplicated high endpoints, including the double-seam corner.
- Negative current-seam operands rotated by `exp(-i phase)` and positive voltage
  duplicates rotated by `exp(+i phase)`.
- Real coefficient arrays and repeated E-then-H stepping in the native update order.
- Independent paired auxiliary flux states with the inspected UPML pre/post recurrence.
- Paired electric and magnetic source increments, applied at their respective update
  stages before periodic synchronization.

The coefficients are **synthetic algebra inputs**. The code does not build a physical
mesh/operator, material coefficients, a qualified UPML absorber, a timestep, or a
plane-wave source. It has no geometry, parser, source waveform generator, native field
monitor, modal projection, SIMD/GPU engine, or production integration. Low-z backward
differences are clamped as in the inspected native loop; the last z current plane is
not advanced. Those finite-domain details are compared algebraically, without claiming
a physically qualified z boundary.

The unique x/y counts are `lines[0]-1` and `lines[1]-1`. Electric fields are advanced
over all z lines; currents over `lines[2]-1`. `Engine::step` synchronizes E after its
update and source application, then H after its corresponding stages. Initial H
duplicates are synchronized before the first voltage update. Auxiliary flux duplicate
planes receive the same phase rotations. Callers of `update_current` directly must
first synchronize voltage duplicates. Sources on high duplicate x/y planes are refused
because those values are derived. Real coefficients and auxiliary activation must be
periodic across duplicate planes in any future physical producer. E/H flux states must
be independent, and the flux pre/post sequence is enforced.

## Convention and paired spectra

The kernel uses the [foundation convention](../../../docs/BLOCH-FOUNDATION.md):
`F(r,t)=F0 exp(+i k dot r) exp(-i omega t)`, with positive seam relation
`F(r+a,t)=exp(+i kt dot a) F(r,t)`. Both stored quadratures evolve in time; they are
not already frequency-domain phasors. Real phase inputs retain the selected unwrapped
branch.

The existing native probe utility applies a negative temporal DFT kernel. For an ordinary
real trace `R(t)=Re{A exp(-i omega t)}`, its single-sided transform recovers `conj(A)`.
For **paired complex time-domain storage** `F(t)=R(t)+i I(t)`, transforming only R loses
information in general. With the same single-sided factor two on each trace, define

```text
R_minus = (2/N) sum R(t_j) exp(-i omega t_j)
I_minus = (2/N) sum I(t_j) exp(-i omega t_j)
foundation peak amplitude = (conj(R_minus) + i conj(I_minus)) / 2
existing +i omega t amplitude = (R_minus - i I_minus) / 2
```

The factor `/2` here removes the doubled contribution created by combining two
single-sided transforms. If each raw transform uses `1/N`, the combination instead has
no `/2`. The native control verifies these formulas for synthetic bin-aligned E and H
harmonics. It also verifies that conjugating both field channels maps the discrete
engine with phase `(theta_x,theta_y)` to the engine with phase
`(-theta_x,-theta_y)`. This representation sign change does not reverse the physical
wavevector when converting to an existing conjugate phasor consumer.

The producer must still specify actual E/H timestamps, spatial staggering, source
normalization, and pulse/Fourier units. This harmonic identity is not a native field reader,
an HDF5 convention check, or a physical-watt calibration.

## Deterministic verification contract

All cases are synthetic controls; no native EM solver process is launched. The hypothesis
is that paired real arithmetic reproduces explicitly complex arithmetic and known
discrete curl symbols under the declared storage/boundary contract. The nine control
groups are:

1. x/y high planes and corners for every component, phase zero, positive/negative
   phases, an unwrapped phase beyond `2 pi`, and a one-unique-cell axis.
2. Analytical discrete plane-wave curl eigenvalues for all three components, including
   reciprocal branches `(m,n)=(1,-2)`. This independent symbol control checks curl
   signs/orientation in addition to the reference-loop comparison.
3. The transverse adjoint identity `D_minus=-D_plus*` with paired seam operands.
4. Thirty-one full nonzero-phase steps against a separately written `std::complex`
   reference that wraps logical neighbors directly rather than reading duplicate planes.
5. The same repeated control with electric/magnetic auxiliary flux states and sources.
6. Zero-phase real-only repeated steps against the complex reference.
7. The same zero-phase control with flux states and sources; imaginary fields remain
   exactly zero.
8. The temporal Fourier convention bridge and conjugated-phase engine identity.
9. Shape/phase/storage/source and auxiliary sequence rejection controls.

The comparison tolerance is `2e-12` for the scaled error
`abs(actual-expected)/max(1,abs(expected))`, reported as `max_scaled_error`. For expected
magnitudes below one this is a scaled absolute error, not a relative error.
Coefficients and field values are deterministically generated from fixed trigonometric
expressions; no random seeds or solver inputs are hidden. The zero-phase controls compare
the standalone kernel to its independent reference. They do not compare raw probe files
against the installed native solver; that separate result belongs to the original
zero-phase qualification study.

`native_bloch_tests` returns JSON and nonzero status on failure. One CTest test executes
all nine groups. The reported `checks` count includes pointwise numerical comparisons
and guard assertions; it is not a count of independent simulations or physical cases.
`test_native_bloch_runner.py` separately checks eight runner contracts without compiling.

## Reproduce and retain evidence

The runner needs Python, CMake, Git, and a C++17 compiler, with no openEMS dependencies.
Use a **new** output directory. The build is limited to at most two jobs; every command
has a bounded timeout. On timeout or interruption, the runner attempts process-tree
termination, falls back to killing the direct child when needed, and retains available logs
and an interrupted/failed manifest. Tree termination is best-effort when the platform helper
fails. On Windows, subprocess
helpers use `CREATE_NO_WINDOW`. The runner copies the code into `output/source` and builds
that frozen source. It retains source hashes, the base Git revision and working-tree
status, CMake/compiler metadata, executable hash, stdout/stderr, timestamps, and a JSON
manifest. Failed/timed-out subprocesses retain their diagnostics and failed manifest.

```powershell
python scripts/experimental-periodic/native-bloch/run_native_tests.py --output E:/new-native-bloch-study --generator "Visual Studio 17 2022" --architecture x64 --jobs 2
python -m unittest discover -s scripts/experimental-periodic -p test_native_bloch_runner.py -v
```

On systems with a default compiler/generator, omit `--generator` and `--architecture`.
The equivalent direct native commands are:

```text
cmake -S scripts/experimental-periodic/native-bloch -B /new/build
cmake --build /new/build --config Release --parallel 2
ctest --test-dir /new/build -C Release --output-on-failure
```

[measured-results.json](measured-results.json) records the Windows build and actual
control results. There is no mesh refinement, empty-cell oblique propagation, absorbing
boundary qualification, directional power, or external physical comparison in this
milestone. Those gates remain required before native nonzero-phase capability enablement.
No binaries are included. The kernel and controls are GPL-3.0-or-later. Codex GPT-6.1 Sol
generated this milestone; its test evidence is reproducible but is not independent
review of the numerical method.
