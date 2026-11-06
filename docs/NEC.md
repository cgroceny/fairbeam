# NEC thin-wire solver and optimization

Fairbeam can export numeric NEC decks, run a user-selected **NEC2++ 2.3.4**
executable, and optimize a free-space PEC dipole using its existing search core.
These Python CLI commands are separate from the openEMS designer/run queue.
They do not download a solver, convert a Design silently, or require an FDTD run.

## Model boundary

The `fairbeam.nec/1` model accepts straight round PEC wires, positive physical
radii, free space, one 1 V applied-field segment source, and a positive real
reference resistance. Input coordinates are **mm** and frequencies **GHz**;
exported NEC cards use **m/MHz**. Reference resistance only normalizes S11; it
does not insert a physical load. This source is not a finite-gap lumped port.

Limits: 399 total segments, 81 strictly increasing frequencies, segment length
between 8 radii and wavelength/20 at the highest frequency. These conservative
admission rules are not a convergence certificate. Connected wires must have
exact shared endpoints, equal radii and an angle of at least 60 degrees.
Overlapping wires and contacts away from shared endpoints are rejected. Detached
parasitic wires are permitted. The numerical benchmark below covers a straight
dipole, not every admitted wire arrangement; check convergence for each design.

Ground, finite conductivity, loads, multiple feeds, dielectric/substrate models,
strips, sheets, arbitrary solids and Boolean histories are unsupported. Extra
model fields are rejected. NEC-2 itself has other formulations; this adapter's
scope does not describe all NEC capabilities. In particular, Fairbeam's existing
strip dipole example is not an equivalent round-wire model.

## Import and edit a numeric deck

On Start, open **Antenna starting dimensions → NEC wire model**. Create a
separate round-wire dipole from the estimated length, or select a UTF-8 NEC
file. Set the reference resistance explicitly; NEC cards do not store the S11
reference. The run server validates the geometry without starting a solver,
creating a Design, or writing to the workspace.

Review the stored frequencies, source wire/segment and all wire endpoints.
The table shows 25 wires per page; exports always contain every wire. **Edit
wire** changes endpoints, radius or segment count and rechecks the whole model.
Invalid edits retain the last accepted model. Input changes above the table
apply to the next creation/import, not to an already stored model.

Download the NEC deck, wire-model JSON or complete transfer record before
leaving Start; this panel is not a saved project. The JSON model can be passed
to `nec-run`. A transfer record includes the exported deck hash and assumptions,
and, for an unedited import, the original UTF-8 source hash and card counts.
After an edit, the record describes the new geometry, not the original source.
No import, edit or export implies a successful simulation.

The importer accepts at most 1 MiB, 4096 lines and 512 characters per card.
Fields must be explicit whitespace-separated numbers. Supported cards are
`CM/CE`, `GW`, `GE 0`, `GN -1`, `EK 0`, optional `PT -1`, one real 1 V
`EX 0` source, linear `FR 0` requests followed by `XQ 0` or the adapter's
whole-sphere `RP` request, and final `EN`. Both free space and the extended
thin-wire kernel must be explicit. Every frequency request must use the same
pattern mode. Units convert from m/MHz to mm/GHz. Deck export retains 12
significant digits; it does not promise a lossless float64 round trip.

Unknown cards, omitted fields, ground, loads, kernel changes, expressions,
includes and changes of the model between frequency requests are rejected.
This is a bounded numeric transfer format, not a general 4nec2 interpreter.
The physical admission limits above still apply.

The CLI also captures the original source bytes in a fresh directory:

```sh
python -m fairbeam nec-import antenna.nec --reference-ohm 50 --out imported-wire
```

It validates before creating the directory, never overwrites an existing
directory, and writes `source.nec`, `model.json`, `model.nec`, `manifest.json`
and `import.json`. It does not download or run NEC2++.

`POST /api/nec/transfer` accepts exactly one of `{source, reference_ohm}`,
`{model, pattern}`, or `{dipole: {length_mm, radius_mm, segments,
frequency_ghz, reference_ohm}}`. It returns the validated model, pattern flag,
deck, export manifest and import report (null for newly created or edited
models). Invalid models return 422. The existing local-host/origin checks and
1 MiB JSON request limit apply; JSON escaping can make this limit smaller than
the CLI's file limit.

## Run

From the repository's configured Python environment:

```sh
python -m fairbeam nec-dipole --length-mm 499.654096667 --radius-mm 0.05 \
  --segments 61 --frequency-ghz 0.29 0.30 0.31 --out dipole-export

# Add an explicitly selected executable to solve, rather than only export:
python -m fairbeam nec-dipole --length-mm 499.654096667 --radius-mm 0.05 \
  --segments 61 --frequency-ghz 0.3 --pattern --timeout 30 \
  --solver /path/to/nec2++ --out dipole-run

python -m fairbeam nec-optimize --length-mm 450 520 --radius-mm 0.05 \
  --segments 61 --frequency-ghz 0.3 --reference-ohm 50 --target-db -15 \
  --max-evals 12 --timeout 300 --solver /path/to/nec2++ --out dipole-search
```

Use a **new output directory** for every attempt. Each captures the model,
numeric deck, hashes and assumptions. Solved captures additionally retain the
solver version/executable hash, adapter hash, host/timing, all stdout and NEC
output, complex impedance/S11, `s11.csv` and its hash. Failures retain `run.json`
with their error; incomplete results cannot become successful optimization
candidates. Ctrl+C cancels the owned solver process group. The whole solve has
a 30 s default; the search defaults to 300 s total, each evaluation at most 30 s.
Both allow an explicit total budget up to 1800 s; searches cap at 30 evaluations.
File output is capped at 8 MiB per solver file. No automatic retry occurs.

For explicit wire models, save the model object (the `model` member of an export
manifest is an example) as JSON and run:

```sh
python -m fairbeam nec-run wire-model.json --solver /path/to/nec2++ --out wire-run
```

`--pattern` samples the whole sphere at 10-degree intervals (703 rows including
the azimuth seam). `sampled_peak_gain_dbi` is not a continuous peak estimate.
The NEC printed gain floor (-999.99) becomes JSON null with
`gain_below_output_floor: true`. Field magnitude/phase retain NEC's convention:
the propagation factor exp(-jkR)/R is omitted; these are not near-field values
or absolute fields at an unspecified observation distance.

Optimization minimizes a single-frequency S11 objective using bounded
Nelder–Mead. `state: completed` means the search ended with at least one valid
candidate; inspect `result.reason` and `best.met` to learn whether the target
was met. Matching does not establish radiation efficiency, bandwidth or
discretization convergence. No FDTD energy-decay fields are fabricated.

## Solver and verification

The adapter was tested on Windows with upstream
[NEC2++](https://github.com/tmolteno/necpp) commit
`7605c056b24a5154fcc15c0f9b92000e2daffce6`, MSVC 19.42, Release x64,
`NECPP_BUILD_TESTS=ON`, `BUILD_SHARED_LIBS=OFF`, `NECPP_ENABLE_LTO=OFF`.
Upstream source headers declare GPL-2.0-or-later. No upstream code or solver
binary is redistributed by this feature. Select your own compatible executable;
the version probe rejects other output formats. macOS integration is pending
platform review; 4nec2/xnec2c import has not been tested.

For a synthetic 499.654096667 mm long, 0.05 mm radius center-fed dipole at
300 MHz, the native 31/61/121-segment results were:

| Segments | Input impedance (ohm) | Sampled peak gain (dBi) |
| --- | --- | --- |
| 31 | 79.066 + j44.942 | 2.17 |
| 61 | 79.264 + j45.179 | 2.17 |
| 121 | 79.392 + j45.347 | 2.17 |

Successive relative complex-impedance differences were 0.3385% and 0.2310%,
below the preset final 2% threshold and decreasing. This checks segmentation
for this case; it is not a physical measurement or broad accuracy guarantee.
The separate 12-evaluation search stopped at its evaluation budget: its best
483.69 mm candidate gave -14.9263 dB S11, **not** the requested -15 dB goal.
The first native parser attempt rejected valid pole rows with blank polarization
sense; the parser and regression coverage were corrected. That failed capture
is retained, rather than counted as a successful solve.

Run unit/control tests with `python -m unittest tests.test_nec`. Reproduce the
explicit native cohort with `python scripts/check-nec-native.py --solver PATH
--out NEW_DIRECTORY` from the repository root. The latter runs real solves
serially and is intentionally not part of ordinary discovery or hosted CI.

Card semantics: [GW](https://www.nec2.org/part_3/cards/gw.html),
[EX](https://www.nec2.org/part_3/cards/ex.html),
[FR](https://www.nec2.org/part_3/cards/fr.html),
[RP](https://nec2.org/part_3/cards/rp.html).
