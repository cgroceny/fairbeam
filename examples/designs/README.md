# Example designs

Designer files (`<name>.design.json`, format in [docs/DESIGNER.md](../../docs/DESIGNER.md#files)).
To edit one in the designer, copy it into your models folder (`~/Documents/fairbeam/models/` for the
desktop app, `python/models/` in a checkout). It then appears under Start › Your designs. They also
run from the command line like any model:

```bash
fairbeam run examples/designs/blade_867.design.json --engine gpu --out /tmp/blade
```

`python/tests/test_example_designs.py` checks that every design here builds and passes the design
checks.

## UAV blade antenna, 867 MHz (`blade_867.design.json`)

A telemetry blade for a UAV (for example the Teknofest UAV competition) in the 863–870 MHz SRD /
LoRa band. It is vertically polarised and omnidirectional in azimuth, and sits on the airframe skin.

**Model.** A swept metal blade (a PEC sheet in the xz plane) stands on a 300 × 300 mm PEC ground
plane that stands in for the fuselage skin. x is the flight axis (+x aft), z points up, out of the
skin. A 50 Ω lumped port bridges the gap `g` from the ground plane to the blade's feed tab, like
the pin of a coax connector through the skin. Above the tab, a taper of height `ht` widens the blade
to the base width `wb`, and the top edge (`wt` wide) is offset aft by `sweep`. The open boundaries
are MUR, with a quarter wavelength at 0.7 GHz (107 mm) of air on every side, including below the
ground plane. The mesh is automatic, 20 cells per wavelength at 1.05 GHz (about 137 000 cells), with
cells half that size next to the blade and ground sheets, normal to them.

The model uses a plain metal blade rather than a PCB one. Most UAV blades are a metal plate, or a
copper radiator on a thin board, inside a glass-fiber or polyurethane radome. The metal sheet is
that radiator without the dielectric, so it has no FR-4 loss and no dependence on the substrate. It
also needs no mesh through a 1.6 mm board, so a run takes about a second on the GPU engine. The
radome and a board both lower the frequency by a few per cent, and the wide band below covers that.
To model a PCB blade, add an FR-4 part (εr 4.3, tan δ 0.02) as a `linpoly` with normal y, 1.6 mm
thick, beside the sheet. Then re-tune `h`, which should end up about 5–10 % shorter.

| Parameter | Value | Meaning |
| --- | --- | --- |
| `f0` | 0.867 GHz | design frequency (far field and surface current) |
| `gnd` | 300 mm | ground plane (fuselage skin), square |
| `h` | 80 mm | blade height above the feed gap (tuned; the tip is at z = 82 mm, 0.237 λ) |
| `wb` | 60 mm | base width, at the top of the taper |
| `wt` | 30 mm | top width |
| `sweep` | 25 mm | aft offset of the top edge center; the leading edge is swept 30.5° (`sweep_deg`) |
| `g` | 2 mm | feed gap (port length) |
| `wf` | 4 mm | feed tab width |
| `ht` | 12 mm | height of the taper from the feed tab to `wb` |

Band 0.7–1.05 GHz, end criterion −50 dB, far field and surface current at `f0`, radiation
efficiency at 21 frequencies across the band.

**Tuning.** `fairbeam optimize --vary h=70:95 --goal "s11_max=-30@0.867" --max-evals 5` and a scan
with the final mesh put the best match at h = 80 mm. |S11| at 867 MHz was −16.1 dB at h = 72 mm,
−20.1 dB at 76, −22.3 dB at 78, −23.1 dB at 80, −22.1 dB at 82, −20.8 dB at 84 and −17.5 dB at
88 mm, so the value is not critical. (Before the mesh put fine cells next to the blade sheet, the
same design resonated at 0.843 GHz instead of 0.904 GHz, and the scan gave the same h = 80 mm.)

**Results** (h = 80 mm, GPU engine, 2304 timesteps, 0.4 s solver time):

| Quantity | Value |
| --- | --- |
| \|S11\| at 867 MHz | −23.1 dB (VSWR 1.15); −22.7 / −23.3 dB at 863 / 870 MHz |
| Input impedance at 867 MHz | 50.9 + j7.1 Ω |
| Lowest \|S11\| | −24.6 dB at 0.904 GHz |
| −10 dB band | 0.737 GHz to above 1.05 GHz, the end of the simulated band. A run from 0.7 to 2.0 GHz puts it at 0.750–1.771 GHz (about 80 %) |
| Dmax / gain / realized gain | 4.08 / 4.06 / 4.03 dBi |
| Radiation / total efficiency | 99.5 % / 99.0 % (PEC: no metal loss modeled) |
| Main lobe | 45° above the skin (θ = 45°), all around |
| Azimuth, horizon (θ = 90°) | mean −1.4 dBi, ripple 1.5 dB (−0.7 dBi at φ ≈ 70°, −2.2 dBi forward at φ = 180°) |
| Azimuth, at the main lobe (θ = 45°) | ripple 1.8 dB (2.3 to 4.1 dBi) |
| Zenith (θ = 0°) / below the skin | −10.8 dBi / up to −1.1 dBi |

**Mesh convergence.** The resonance is converged at the default density: the lowest |S11| is at
0.904 GHz at 20 cells per wavelength and at 0.907 and 0.908 GHz at 30 and 40. Before the cells
next to the blade were refined it was 0.843, 0.890 and 0.906 GHz at 20, 30 and 40, and 0.908 GHz
only from 50. The 0.7–2.0 GHz run meshes 867 MHz at
about 46 cells per wavelength, so it also checks the mesh. Dmax changed by 0.02 dB, |S11| at 867 MHz
went to −18 dB and Zin to 49.2 + j12.6 Ω (30 cells per wavelength at 2 GHz: −16 dB, 48.3 + j15.3 Ω).
The feed reactance is the least converged number (it keeps rising with density, probably with how
the 2 mm gap and the 4 mm feed tab are resolved), but the match stays at −16 dB (VSWR 1.4) or
better at 867 MHz in every run.

**Against theory.** A thin λ/4 monopole on an infinite ground plane has about 36 + j21 Ω at
h = λ/4. It resonates, at about 36 Ω, a little below that height and has 5.15 dBi at the horizon.
The blade differs in three ways:

- **Impedance and bandwidth.** The blade is 60 mm (0.17 λ) wide. Like a fat monopole or a planar
  UWB monopole, it has a higher radiation resistance (about 50 Ω here, which suits a 50 Ω feed
  without a matching network) and a nearly flat reactance. Its −10 dB bandwidth is about 80 %; a
  wire monopole has about 10 %.
- **Directivity and tilt.** The 300 mm ground plane is only 0.87 λ wide. Currents diffracted at
  its edges tilt the main lobe to about 45° above the skin, cost about 1 dB of peak directivity
  (4.1 dBi instead of 5.15), and put about 5.5 dB less at the horizon than at the peak. They also
  radiate below the skin. On an infinite ground plane the peak would be on the horizon.
- **Ripple.** The swept blade and the square ground plane are not round, so the azimuth pattern
  ripples by 1.6 dB. It is weakest forward (−x), strongest near the broadside directions of the
  blade.

**Caveats.**

- **Ground plane.** The ground plane is a flat 300 mm square. A real fuselage is curved and
  narrower (a 100–200 mm body), and has wings, a tail and carbon parts. Its size mostly moves the
  elevation tilt and the horizon gain (a larger skin lowers the tilt), and moves the match only a
  little. Set `gnd` to your airframe, or model the fuselage.
- **Radome and materials.** The radome, the paint and the mounting base are not modeled. A thin
  glass-fiber shell lowers the frequency by a few per cent. The −10 dB band starts at 0.74 GHz and
  ends at 1.8 GHz, so about 130 MHz of margin remains on the low side and more on the high side.
  The metal is lossless: aluminum or brass costs a few tenths of a per cent of efficiency at most.
- **Feed.** The feed is a 2 mm lumped port, not an SMA or N connector. The connector's own
  impedance and length shift the phase of S11 but hardly change |S11|.

**Other bands.** Start from the 867 MHz dimensions scaled by `k = 0.867 / f_new`. Scale `h`, `wb`,
`wt`, `sweep`, `wf` and `ht`, keep `g` at 1–2 mm, and set `f0` and the simulated band (`f_min`,
`f_max` under Simulation settings, about 0.8 × and 1.2 × f0). Then re-tune `h` with a few runs or
`fairbeam optimize --vary h=... --goal "s11_max=-25@<f0>"`. The table gives starting points; only
867 MHz has been simulated.

| Band | f0 | k | h | wb | wt | sweep | ht | wf | g | band to simulate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 433 MHz ISM | 0.433 | 2.0 | 160 | 120 | 60 | 50 | 24 | 8 | 2 | 0.35–0.52 GHz |
| 915 MHz ISM | 0.915 | 0.95 | 76 | 57 | 28 | 24 | 11 | 4 | 2 | 0.73–1.1 GHz |
| 2.4 GHz ISM | 2.44 | 0.355 | 28 | 21 | 11 | 9 | 4 | 1.5 | 1 | 2.0–2.9 GHz |

The wide band means the 867 MHz blade already covers 902–928 MHz (|S11| < −10 dB up to 1.8 GHz).
The 915 MHz row centers that band on 915 MHz. At 433 MHz a 300 mm skin is only 0.43 λ: the match
and the pattern then depend strongly on the airframe, so model the real size (`gnd`) there.

## Slotted wideband planar dipole, 867 MHz (`wideband_dipole_867.design.json`)

A telemetry antenna for a UAV with a **composite (non-metal) fuselage**, where there is no metal
skin to act as the ground plane of a monopole such as `blade_867`. It is a balanced printed dipole
that fits a blade radome, for the 863–870 MHz SRD / LoRa band. It is vertically polarised and
omnidirectional in azimuth. The arms are wide ("fat") for bandwidth and slotted ("kesikli") for
height.

**Model.** A vertical FR-4 strip (εr 4.3, tan δ 0.02 at `f0`, 1.6 mm, in the xz plane; x is the
flight axis, z points up) carries two copper arms (PEC sheets) on its y = 0 face, above and below
a center feed gap `g`. A 50 Ω lumped port bridges the gap. Each arm widens from a feed tab `wf` wide
at the gap to the full width `w_arm` over the flare height `ht`, and runs on to the tip, `h_arm`
from the gap edge. Four pairs of transverse slots, `l_s` long and `w_s` wide, are cut in from both
outer edges of each arm (the designer's part cuts, so they follow the parameters). The first pair
is `z_s` from the gap edge, the next ones every `p_s`. The top arm is drawn and cut once and
mirrored across z = 0 to make the bottom arm. There is no ground plane. The open boundaries are PML (8
cells), with a quarter wavelength at 0.7 GHz (107 mm) of air on every side. The mesh is automatic, 30 cells
per wavelength at 1.05 GHz (about 270 000 cells), with 2 cells across each 2 mm slot and 4 through
the board.

Facing slots leave a solid spine `w_arm − 2 l_s` = 6 mm wide down the middle of each arm. A wide
arm carries most of its current along its outer edges. The slots cut that path, so the current
detours around every slot and crowds through the spine and the slot ends, which the surface-current
map at `f0` shows. The electrical length grows, so the resonance moves down for the same height.
Because the slots come in facing pairs, their horizontal currents cancel, and the pattern stays
vertically polarised.

| Parameter | Value | Meaning |
| --- | --- | --- |
| `f0` | 0.867 GHz | design frequency (far field and surface current) |
| `h_arm` | 54 mm | arm height from the feed-gap edge to the tip (tuned). Tip to tip `H_tot` = 110 mm (0.32 λ) |
| `w_arm` | 40 mm | arm width (x), 0.12 λ |
| `ht` | 8 mm | flare height, from the feed tab to the full width |
| `wf` | 18 mm | feed tab width at the gap (tuned: a wide tab lowers the feed inductance) |
| `g` | 2 mm | feed gap (port length) |
| `l_s` | 17 mm | slot length, in from each outer edge. The spine between facing slots (`spine`) is 6 mm |
| `w_s` | 2 mm | slot width |
| `p_s` | 10 mm | slot pitch |
| `z_s` | 16 mm | first slot pair above the feed-gap edge. The last slot ends 48 mm above it (`slot_top`) |
| `t_sub` | 1.6 mm | FR-4 thickness |
| `m` | 3 mm | FR-4 margin around the copper. The board is 46 × 116 mm (`W_b` × `L_b`) |

Band 0.7–1.05 GHz, end criterion −60 dB, far field and surface current at `f0`, radiation
efficiency at 21 frequencies across the band. The slot count is fixed at four pairs per arm, one
cut per slot in the file. `h_arm` should stay above `slot_top`; below it the last cuts remove
nothing, and the checks say so.

**Tuning** (GPU engine, about 7 s per run). The first guess (`h_arm` 60, `wf` 3, `l_s` 14) matched
from 0.758 to 0.897 GHz, too low, and only to −16.5 dB. Shortening the arm moved the band up, by
about 1.3 % per mm of `h_arm`. A wider feed tab lowers the inductance of the feed. At `h_arm` = 56,
widening `wf` from 3 to 10 mm improved the best |S11| from −16.8 to −19.3 dB and the band from
18.2 to 19.9 %. At 58 mm, going from 10 to 18 mm improved them from −19.1 to −22.3 dB and from
19.2 to 20.6 % (band 0.797–0.976 GHz at `l_s` = 14). Longer slots (`l_s` 17) then lowered the
resonance by 5 %, and 4 mm less of each arm brought it back, at 17.8 % bandwidth.

**Results** (defaults: PML 8, 30 cells per wavelength; GPU engine, 6.6 s solver time):

| Quantity | Value |
| --- | --- |
| \|S11\| at 863 / 867 / 870 MHz | −17.7 / −18.7 / −19.4 dB (best −22.3 dB at 0.889 GHz) |
| Input impedance at 867 MHz | 39.6 + j0.4 Ω (the series resonance, X = 0, sits at 867 MHz) |
| −10 dB band | 0.816–0.987 GHz (171 MHz, 19 %). The margin is 47 MHz (5.4 %) below 863 MHz and 117 MHz (13 %) above 870 MHz |
| Dmax / gain / realized gain | 2.02 / 1.97 / 1.91 dBi (Dmax from the pattern alone: 2.01 dBi) |
| Radiation / total efficiency | 98.9 % / 97.6 % at 867 MHz. Total efficiency is above 95 % from 0.84 to 0.95 GHz |
| Main lobe | on the horizon (θ = 90°), elevation beamwidth about 85° |
| Azimuth, horizon (θ = 90°) | mean gain 1.90 dBi, ripple 0.13 dB |
| Polarisation | vertical (E_θ). Cross-polarisation (E_φ) is at least 40 dB below the peak everywhere, and vanishes on the horizon by symmetry |
| Zenith (θ = 0°) | −38 dBi, the dipole's null |

The design was first tuned with MUR boundaries at 20 cells per wavelength. That gave 2.21 dBi
Dmax against 2.01 dBi from the pattern alone and 41.8 + j6.4 Ω: with only a quarter wavelength of
air, MUR reflects enough to bias the power balance (the sleeve dipole below measured the same). PML
at 30 cells per wavelength brings the two Dmax estimates within 0.02 dB and is the default now; the
match barely moved.

**Slots against no slots.** The same arms without the slots (the cuts removed, the same `wf`, `ht`
and `w_arm`) reach the same resonance at `h_arm` = 67 mm: X = 0 at 0.847 GHz and a band of
0.769–1.000 GHz. The slots take the tip-to-tip height from 136 mm to 110 mm, 19 % shorter at the
same 40 mm width. They cost bandwidth: the unslotted dipole matches over 27 %, with −27 dB at
867 MHz. It also has 0.2 dB more directivity (2.43 / 2.19 dBi from the pattern) and twice the
azimuth ripple (0.27 dB).

**Against theory and `blade_867`.**

| | Ideal λ/2 dipole (thin wire) | This dipole | `blade_867` |
| --- | --- | --- | --- |
| Needs a ground plane | no | no | yes (the metal skin) |
| Height × width | about 166 mm (0.48 λ) × a wire | 110 × 40 mm (board 116 × 46 mm) | 82 mm above the skin × 60 mm, on a 300 mm skin |
| Zin | 73 + j42 Ω at 0.5 λ, about 70 Ω at resonance (0.48 λ) | 39.6 + j0.4 Ω at 867 MHz | 50.2 − j4.2 Ω |
| −10 dB band (50 Ω) | roughly 5–10 %, depending on the wire thickness | 19 % | about 80 % |
| Dmax | 2.15 dBi | 2.02 dBi | 4.08 dBi, 45° above the skin |
| Horizon gain, ripple | 2.15 dBi, 0 dB | 1.90 dBi, 0.13 dB | −1.4 dBi, 1.6 dB |

At 0.32 λ tip to tip, the dipole is shorter than a resonant λ/2 dipole. Its directivity lies between
that of a short dipole (1.76 dBi) and that of a λ/2 dipole. The wide arms keep its resistance near
40 Ω, where a thin dipole this short would have about 25 Ω, and give it two to three times the
bandwidth of a thin dipole. On the horizon it has about 3.5 dB more gain than the blade on its small ground
plane. The blade's lobe is tilted up by the edges of the ground plane.

**Caveats.**

- **Balun.** The port is balanced. A coax connected straight to the gap puts current on the outer
  conductor of the cable, which radiates, tilts the pattern and moves the match. In practice, run
  the coax along the center of the lower arm to the gap and add a sleeve choke (a λ/4 sleeve, about
  86 mm in air at 867 MHz, or ferrite beads) where it leaves the arm, or print a balun (a tapered
  microstrip or a Marchand balun) on the back of the board. The model has none of these.
- **Radome and FR-4 tolerance.** The radome, the paint and the mount are not modeled. A thin
  glass-fiber shell lowers the frequency by a few per cent, and FR-4's εr varies from about 4.2 to
  4.7 between suppliers and with frequency. Both mostly lower the band. The band reaches 11 % above
  870 MHz and 6 % below 863 MHz, so a downward shift of up to about 10 % keeps 863–870 MHz inside
  it. If the fitted radome shifts the band by more, shorten `h_arm`: 1 mm moves the band by about
  1.3 %.
- **Mounting.** The dipole needs its composite surroundings. Carbon-fiber parts, cables, the battery
  and metal hardware within about λ/4 (86 mm) change the match and the pattern. Route the feed coax
  away from the arms, perpendicular to them where possible.
- **Losses.** The copper is lossless (PEC). Real copper costs a few tenths of a per cent. The
  FR-4 loss is modeled. It costs about 1 %, because most of the field is in the air.

## Printed meander dipole for non-metal airframes, 867 MHz (`meander_dipole_867.design.json`)

The blade above is a monopole: its ground plane is the metal skin of the fuselage. A composite or
foam fuselage (glass fiber, foam, 3D-printed plastic) has no such skin, so a monopole on it has
nothing to work against: the coax shield becomes the other half of the antenna and the match and the
pattern depend on how the cable runs. A dipole carries both halves itself. This design is a vertical
printed dipole for 863–870 MHz that fits a blade radome of about 110 × 35 mm.

**Model.** A 1.6 mm FR-4 board (εr 4.3, tan δ 0.02) stands in the xz plane: x is the flight axis
(+x aft), z points up. Its outline is blade-like, 34 mm wide at the root and 22 mm at the tip, with
the forward edge swept back by `sweep`. The copper is on one face (y = 0), drawn 35 µm thick and
built as a sheet (the designer's thin-metal default). Each arm starts at the center gap as a straight
strip `l_feed` long and ends in a meander of `n` turns (turn width `a`, pitch `p`: two rungs per turn)
and a short straight end section `l_end`. The lower arm is the mirror image of the upper one
(a `mirror` transform on each arm part), so the horizontal currents in the rungs of the two arms
flow in opposite directions and cancel in the far field. A balanced 50 Ω lumped port, `w` wide,
bridges the gap `g` at the center. There is no ground plane: the open boundaries are PML (8 cells),
with a quarter wavelength at 0.75 GHz (100 mm) of air between the board and the PML on every side.

The arms are bricks per segment (rungs, the links between them, the feed strip and the tip), with
`translate` copies that follow `n`, so every value stays editable and the optimizer can vary them.
The board is two polygons that meet at z = 0. The joint puts a mesh line in the middle of the feed
gap, so the port gets two cells instead of one.

**Why straight arms with meandered tips.** The current on a short dipole is largest at the feed
and falls to zero at the tips. The part near the feed does most of the radiating and sets the
radiation resistance. A meander there would carry opposing currents in its rungs, which radiate
almost nothing. So the arms are straight where the current is high, and the meander sits at the
tips, where it adds electrical length (it loads the arm like a coil) at a small cost in resistance.
The first try used 3 turns and a 25 mm straight section (112 mm tall). It resonated at 767 MHz with
only 29 Ω. Two turns and a 30 mm straight section give 40 Ω at 101 mm.

| Parameter | Value | Meaning |
| --- | --- | --- |
| `f0` | 0.867 GHz | design frequency (far field and surface current) |
| `w` | 2 mm | trace width (and port width) |
| `g` | 2 mm | feed gap (port length) |
| `l_feed` | 30 mm | straight section from the gap to the first rung |
| `n` | 2 | meander turns per arm (rounded to a whole number, `nt`, so a sweep or the optimizer can vary it) |
| `a` | 16 mm | meander turn width (x), also the copper width |
| `p` | 8 mm | turn pitch (z); the gap between rungs is `p/2 − w` = 2 mm |
| `l_end` | 1.5 mm | straight end section at each tip (tuned) |
| `t` | 1.6 mm | FR-4 thickness |
| `t_cu` | 35 µm | copper thickness (modeled as a sheet) |
| `m` | 3 mm | board margin around the copper |
| `sweep` | 12 mm | extra board chord forward at the root |

Derived: copper height `H` = 101 mm tip to tip (0.29 λ at 867 MHz), board 107 × 34 mm (`H_board`,
`W_board`), trace length of one arm `L_arm` ≈ 114 mm. A straight printed λ/2 dipole would be about
140–150 mm tall.

Band 0.75–1.0 GHz, end criterion −50 dB, far field and surface current at `f0`, radiation
efficiency at 21 frequencies across the band. The automatic mesh (20 cells per wavelength at
1 GHz) has 966 000 cells. The smallest cell is 0.26 mm: 6 cells across the 2 mm trace, 6 across the
2 mm gaps between the rungs and 2 across the feed gap. A run takes 18 500 timesteps, 10 s of solver
time on the GPU engine.

**Boundaries.** With MUR the fields decayed too slowly (−37 dB after 60 000 timesteps) and the far
field came out at 2.5 dBi, more than a dipole this short can have. The first-order MUR boundary
reflects part of the wave that a small, low-gain antenna sends towards it at grazing angles. PML
absorbs it: the run reaches −50 dB in 18 500 timesteps, and 1.97 dBi is between a short dipole
(1.76 dBi) and a λ/2 dipole (2.15 dBi).

**Tuning.** GPU engine, 14 cells per wavelength and −40 dB while tuning, then the final run at the
design's 20 cells per wavelength and −50 dB:

| Run | Change | Boundaries | Resonance (Im Z = 0) | R there | Solver time |
| --- | --- | --- | --- | --- | --- |
| 1 | n = 3, l_feed = 25, l_end = 4 (H = 112 mm) | MUR | 767 MHz | 29 Ω | 12 s |
| 2 | n = 2, l_feed = 30, l_end = 4 (H = 106 mm) | MUR | 848 MHz (not converged) | 34 Ω | 11 s |
| 3 | l_end = 1.5 (H = 101 mm) | PML 8 | 875.6 MHz | 40 Ω | 9 s |
| 4 | final, 20 cells/λ, −50 dB | PML 8 | 875.3 MHz | 40 Ω | 10 s |
| 5 | FR-4 εr 4.5 instead of 4.3 | PML 8 | 872.2 MHz | 40 Ω | 9 s |
| 6 | l_end = 4 (H = 106 mm) | PML 8 | 856.9 MHz | 41 Ω | 9 s |

The mesh change from run 3 to run 4 moved the resonance by 0.3 MHz. Run 6 gives the tuning slope:
−7.5 MHz per mm of `l_end` (each tip), about −0.9 % per mm. Run 5 shows that FR-4 matters little
here, because most of the field is in the air: +0.2 in εr moves the band by −0.4 %.

**Results** (final run, defaults):

| Quantity | Value |
| --- | --- |
| \|S11\| at 863 / 867 / 870 MHz | −15.4 / −16.8 / −17.8 dB (VSWR 1.41 / 1.34 / 1.29) |
| Best match | −19.4 dB at 878 MHz |
| −10 dB band | 843.8–915.6 MHz (72 MHz, 8.2 %), center 879.7 MHz: 1.5 % above 867 MHz |
| Input impedance at 867 MHz | 38.8 − j6.4 Ω |
| Dmax / gain / realized gain at 867 MHz | 1.97 / 1.77 / 1.68 dBi |
| Radiation / total efficiency at 867 MHz | 95.5 % / 93.5 % (FR-4 loss; the copper is lossless) |
| Radiation efficiency over the band | 95.2 % at 862.5 MHz, 96.0 % at 875 MHz; 93–99.6 % over 0.75–1.0 GHz (21 points) |
| Azimuth, horizon (θ = 90°) | 1.93 to 1.97 dBi: ripple 0.04 dB |
| Elevation | main lobe on the horizon; half-power beamwidth 85° (θ = 48° to 132°); nulls up and down |
| Polarisation | vertical (E_θ). Cross-polar (E_φ) below −44 dB on the horizon and −33 dB anywhere |

Margins in the −10 dB band: the band can move down by 5.0 % (the upper edge reaching 870 MHz) or
up by 2.2 % (the lower edge reaching 863 MHz) before 863–870 MHz leaves it. A radome, which lowers
the frequency, has the larger side.

**Compared with the others.**

| | Ideal λ/2 dipole | This meander dipole | Blade monopole (`blade_867`) |
| --- | --- | --- | --- |
| Height | 0.48 λ (about 165 mm as a thin wire, 140–150 mm printed on FR-4) | 101 mm (0.29 λ) | 82 mm above the skin |
| Needs | a balun | a balun | a metal skin (ground plane) |
| Resistance at resonance | 73 Ω | 40 Ω | 50 Ω |
| −10 dB bandwidth (50 Ω) | about 5–10 %, with the conductor thickness | 8.2 % | about 80 % |
| Dmax | 2.15 dBi | 1.97 dBi | 4.08 dBi (45° above the skin) |
| Radiation efficiency | 100 % | 95.5 % (FR-4) | 99.5 % (PEC) |
| Horizon | 2.15 dBi, omni | 1.95 dBi, 0.04 dB ripple | −1.4 dBi, 1.6 dB ripple |

The meander dipole gives up 0.2 dB of directivity against a full λ/2 dipole for a third less height.
It needs no ground plane, and its pattern peaks on the horizon, where the ground station is for
most of a flight. The blade has more peak gain and a much wider band, but only on a metal skin of
about λ or more, and its peak is tilted 45° up by the finite skin.

**Build notes and caveats.**

- **Balun.** The port is balanced; the coax is not modeled. A coax soldered straight onto the
  arms carries current on its shield, which radiates, tilts the pattern and moves the match with
  the cable route. Use a balun or a common-mode choke at the feed: a λ/4 sleeve (bazooka) balun on
  the cable where it leaves the feed (about 80 mm), clip-on ferrite beads rated for UHF on the cable
  within 2–3 cm of the feed, or a printed balun on the board. Measure S11 with the choke fitted. Run the cable away from the feed at right angles to the dipole (along
  the x axis) for at least λ/4 (86 mm) before it turns.
- **Match.** 40 Ω gives |S11| of −19 dB at best, with no matching network. A 50 Ω match needs a
  higher resistance, which a longer straight section `l_feed` with fewer or narrower turns (a
  smaller `a`) gives, at the cost of height. A wider trace `w` widens the band a little.
- **Radome and FR-4.** The radome is not modeled; a glass-fiber shell a few millimeters thick lowers
  the frequency by a few per cent, inside the 5 % margin. FR-4 varies (εr 4.2–4.7, tan δ 0.015–0.025
  from batch to batch and with frequency); that moves the band by under 1 %. Real copper (the
  model's sheets are lossless) costs roughly another 1 % on the 2 mm trace. After building, measure S11
  inside the radome and trim `l_end` (−7.5 MHz per mm, the same on both tips).
- **Airframe.** A non-metal airframe is assumed. Carbon fiber conducts: keep the antenna away from
  carbon tubes and skins, batteries, servo and power wiring (ideally λ/4, 86 mm), or model them.
- **Feed.** The feed is a 2 mm lumped port, not a connector.

**Other bands.** Scale every length by `k = 0.867 / f_new` (FR-4 thickness excepted), set `f0` and the
simulated band (about 0.85 × and 1.15 × f0), and re-tune `l_end`, or `l_feed` for larger steps. Only
867 MHz has been simulated. The −10 dB band of the 867 MHz dipole ends at 916 MHz, so it does not
cover the 902–928 MHz ISM band: that needs its own tuning.

## Printed sleeve dipole, 867 MHz (`sleeve_dipole_867.design.json`)

A coax-fed telemetry dipole for a UAV with a **composite (non-metal) fuselage**, where there is no
metal skin to act as a monopole's ground plane. It is a half-wave dipole printed on a slim FR-4
strip that fits a blade radome, for the 863–870 MHz SRD / LoRa band. It is vertically polarised and
omnidirectional in azimuth. The lower arm is a sleeve around the feed coax, so the coax reaches the
center feed along the antenna itself and leaves at its bottom end, with no separate balun.

**Model.** A vertical FR-4 strip (εr 4.3, tan δ 0.02 at `f0`, `t` = 1.6 mm, in the xz plane; x is
the flight axis, z points up) carries all the copper (PEC sheets) on its y = 0 face:

- the **upper arm**, `w_up` wide and `l_up` long, above the feed gap `g`;
- the **sleeve** (the lower arm), `w_sl` wide and `l_sl` long below the gap. It is a pair of strips
  (each `ws` wide) either side of the coax, with a slot `s` between each strip and the coax. A
  bridge `hb` tall across the full sleeve width joins the strips and the coax braid at the top;
- the **coax**, modeled as its outer conductor: a strip `w_f` wide on the center line, from the
  bridge down to the bottom edge of the board, where the cable leaves.

A 50 Ω lumped port, `w_f` wide, bridges the gap from the bridge to the upper arm. It stands for the
coax inner conductor, which jumps the gap from the end of the cable to the base of the upper arm.
Because the braid touches the sleeve only at the bridge, the coax and the sleeve strips form a
short-circuited coplanar stub (about 66 mm, roughly 0.3 λ in the board's effective medium at
867 MHz). This is the choke of a sleeve dipole: it presents a high impedance between the braid and
the sleeve at the open lower end, which keeps the antenna current off the outside of the cable. The
board extends `m` beyond the copper at both ends. There is no ground plane. The open boundaries are
PML (8 cells) behind a quarter wavelength at 0.75 GHz (100 mm) of air on every side. The mesh is
automatic, 30 cells per wavelength at 1.0 GHz (about 443 000 cells), with 3 cells across each 1 mm
slot, 3 across the 2 mm feed gap and 4 through the board.

**Where the coax goes.** Use a thin coax (RG-178, RG-316, or 2.2 mm semi-rigid for a stiff build)
laid on the center strip. Solder its braid to the bridge pad and, if you like, along the strip. The
braid must not touch the sleeve strips anywhere else: the two 1 mm slots keep them apart. Solder the
inner conductor across the 2 mm gap to the base of the upper arm. The cable runs down the axis and
leaves the board at its bottom edge (z = −73.8 mm), through the radome base.

| Parameter | Value | Meaning |
| --- | --- | --- |
| `f0` | 0.867 GHz | design frequency (far field and surface current) |
| `l_up` | 68.8 mm | upper arm length above the feed gap (tuned) |
| `l_sl` | 68.8 mm | sleeve length below the feed gap (tuned, equal to `l_up`) |
| `w_up` | 10 mm | upper arm width |
| `w_sl` | 16 mm | sleeve width: both strips, the coax and the two slots. Each strip (`ws`) is 6 mm |
| `g` | 2 mm | feed gap (port length) |
| `wb` | 20 mm | board width |
| `t` | 1.6 mm | FR-4 thickness |
| `w_f` | 2 mm | coax (feed line) width |
| `s` | 1 mm | slot between the coax and each sleeve strip |
| `hb` | 3 mm | bridge height at the sleeve top (the braid solder pad) |
| `m` | 4 mm | board margin above the arm and below the sleeve |

The dipole is `L` = 139.6 mm from tip to end (0.40 λ at 867 MHz); the board is `H` = 147.6 ×
20 × 1.6 mm. Band 0.75–1.0 GHz, end criterion −60 dB (timestep limit 150 000), far field and
surface current at `f0`, radiation efficiency at 21 frequencies across the band.

**Tuning** (GPU engine, 11 runs, 7–61 s each):

| Run | Change | Best \|S11\| at | Solver time |
| --- | --- | --- | --- |
| 1 | first guess, `l_up` = `l_sl` = 74 mm, MUR, 20 cells/λ | 0.803 GHz (−50 dB). Stopped at the 60 000-step limit at −44 dB | 6.7 s |
| 2–4 | 68, 67, 66.5 mm, with a 150 000-step limit | 0.863, 0.874, 0.880 GHz | 10.6 s each |
| 5 | 66.5 mm, PML 8 instead of MUR | 0.892 GHz, −19.7 dB | 22.2 s |
| 6 | 67.8 mm | 0.877 GHz, −19.6 dB | 23.0 s |
| 7 | `w_up` = 16 mm | 0.884 GHz, −18.9 dB: 1.3 % more bandwidth, no better match. Not kept | 23.3 s |
| 8, 9 | 30 and 40 cells/λ | 0.889, 0.890 GHz | 31.4, 43.8 s |
| 10 | 68.8 mm, 30 cells/λ (the defaults) | 0.877 GHz, −19.6 dB | 32.5 s |
| 11 | defaults with 175 mm of air instead of 100 mm | the same S11 to 0.05 dB, Dmax −0.03 dB | 58.9 s |

The first run decayed slowly: the coax-and-sleeve stub resonates near 0.7 GHz, below the band,
with a Q set mostly by the FR-4 loss, and the excitation for a narrow band is long (9 900 steps).
With 150 000 steps allowed, runs converge at about 98 000 (20 cells/λ) or 137 000 steps (30 cells/λ).
The boundaries matter here. With MUR, openEMS' Dmax (2.72 dBi) and the Dmax integrated from the
pattern (2.10 dBi) disagreed by 0.6 dB, and the match was about 1.4 % low in frequency. With PML 8,
the two agree within 0.03 dB and more air changes nothing. The 20-cell mesh put the match 1.4 %
low, while 30 and 40 cells agree within 0.1 %, so the file uses 30. One millimeter of both lengths
moves the match by about 11 MHz (1.3 %).

**Results** (defaults, GPU engine, 442 800 cells, 137 448 timesteps, 32.5 s solver time):

| Quantity | Value |
| --- | --- |
| \|S11\| at 863 / 867 / 870 MHz | −18.2 / −18.8 / −19.2 dB (VSWR 1.26 at 867 MHz) |
| Best match | −19.6 dB at 877 MHz, 1.1 % above 867 MHz for the radome (see the caveats) |
| Input impedance at 867 MHz | 55.8 − j10.7 Ω. Series resonance (X = 0) at 0.896 GHz, R = 65 Ω |
| −10 dB band | 0.817–0.954 GHz (137 MHz, 15.4 %). The margin is 46 MHz (5.3 %) below 863 MHz and 84 MHz (9.6 %) above 870 MHz |
| Dmax / gain / realized gain | 2.10 / 2.05 / 1.99 dBi (Dmax from the pattern alone: 2.09 dBi) |
| Radiation / total efficiency | 98.8 % / 97.5 % at 867 MHz. The radiation efficiency is 97.7–99.0 % across the band; the total efficiency is above 95 % from 0.844 to 0.917 GHz |
| Main lobe | on the horizon (θ = 90°), elevation beamwidth 78° (51°–129°) |
| Azimuth, horizon (θ = 90°) | mean 2.08 dBi, ripple 0.04 dB |
| Polarisation | vertical (E_θ). Horizontal (E_φ) power is 46 dB below the total, and at least 63 dB below E_θ on the horizon |
| Zenith / nadir | −39 dBi, the dipole's nulls |

**Against theory and the other two designs.**

| | Ideal λ/2 dipole (thin wire) | This sleeve dipole | `wideband_dipole_867` | `blade_867` |
| --- | --- | --- | --- | --- |
| Needs a ground plane | no | no | no | yes (the metal skin) |
| Feed | balanced (needs a balun) | coax, through the sleeve | balanced (needs a balun) | coax through the skin |
| Height × width | about 166 mm (0.48 λ) × a wire | 139.6 × 16 mm (board 147.6 × 20 mm) | 110 × 40 mm (board 116 × 46 mm) | 82 mm above the skin × 60 mm, on a 300 mm skin |
| Zin | 73 + j42 Ω at 0.5 λ, about 70 Ω at resonance | 55.8 − j10.7 Ω at 867 MHz, 65 Ω at resonance | 41.8 + j6.4 Ω | 50.2 − j4.2 Ω |
| −10 dB band (50 Ω) | roughly 5–10 % | 15.4 % | 17.8 % | about 80 % |
| Dmax | 2.15 dBi | 2.10 dBi | 2.0–2.2 dBi | 4.08 dBi, 45° above the skin |
| Horizon gain, ripple | 2.15 dBi, 0 dB | 2.08 dBi, 0.04 dB | 2.14 dBi, 0.12 dB | −1.4 dBi, 1.6 dB |

The sleeve dipole behaves like a λ/2 dipole: the same pattern (78° beamwidth, 0.05 dB less
directivity) and a resonant resistance of 65 Ω, close to a thin dipole's 70 Ω. The FR-4 under the
copper shortens it: it resonates (X = 0) at 0.42 λ instead of 0.48 λ. The 10–16 mm wide strips give it about
twice a wire's bandwidth, but the match stays at −19 dB: its resistance rises through the band (51 Ω
at 0.85 GHz, 67 Ω at 0.90 GHz). It is the narrowest of the three in width (a 20 mm board) and the
only one fed by coax without a balun. On the horizon it has 3.5 dB more gain than the blade on its
small ground plane. It is 30 mm taller than the slotted wideband dipole.

**Caveats.**

- **The cable.** The model ends the coax at the bottom edge of the board. A real cable continues
  from there, and whatever current reaches the braid's outside at the sleeve end flows on down the
  cable, radiates, tilts the pattern and moves the match. In the model, the coax strip carries up
  to about 15 % of the peak arm current near its lower end. The stub is 0.3 λ long, not the ideal
  λ/4, so its choking is good but not perfect. Keep the cable on the antenna axis for at least λ/4
  (86 mm) below the board. If it must turn, add a ferrite bead or a clip-on ferrite at the board
  edge. To see the effect, add a `wire` of the cable's radius that continues the `coax` strip down
  from the board edge, and compare.
- **Radome.** The radome, the paint and the mount are not modeled. A thin glass-fiber shell lowers
  the frequency by a few per cent. The best match sits 1.1 % high, and the band reaches 5.3 % below
  863 MHz and 9.6 % above 870 MHz, so a shift of up to about 5 % down keeps 863–870 MHz inside the
  −10 dB band. If the fitted radome shifts it by more, shorten `l_up` and `l_sl` together: 1 mm
  moves the band by about 1.3 %.
- **FR-4 tolerance.** FR-4's εr varies from about 4.2 to 4.7 between suppliers and with frequency,
  and the thickness by ±10 %. Most of the field is in the air, so the band moves by roughly a
  fifth of the relative change in εr (about 2 % down at εr 4.7; an estimate from how much the board
  shortens the dipole, not simulated). Measure S11 on the first boards
  and trim both lengths together.
- **Mounting.** Carbon-fiber parts, cables, the battery and metal hardware within about λ/4 (86 mm)
  of the antenna change the match and the pattern.
- **Losses.** The copper is lossless (PEC); real copper costs a few tenths of a per cent. The FR-4
  loss is modeled and costs about 1 %.

## Printed 2-element collinear, 867 MHz (`collinear_867.design.json`)

A higher-gain telemetry antenna for a UAV with a **composite (non-metal) fuselage**. It is the sleeve
dipole above with a second half-wave element stacked on top and fed in phase. It is vertically
polarised and omnidirectional in azimuth for 863–870 MHz, and needs no ground plane and no balun. It
answers one question: how much more gain on the horizon than a λ/2 dipole is possible, and what that
costs in elevation beamwidth and length. The answer is 2.0 dB more on the horizon (4.1 dBi against
2.1 dBi). The elevation beam narrows from 78° to 39°, and the antenna is 352 mm long instead of 140 mm.

**Model.** A vertical FR-4 strip (εr 4.3, tan δ 0.02 at `f0`, `t` = 1.6 mm, 30 mm wide, in the xz
plane; x is the flight axis, z points up). All the radiating copper (PEC sheets) is on its y = 0 face:

- the **lower element**, the sleeve dipole of `sleeve_dipole_867`. This is an arm `l_up` long above
  the feed gap `g`, and a sleeve `l_sl` long below it. The sleeve is two strips either side of the
  braid strip `w_f`, with a slot `s` on each side, joined to the braid strip by a bridge `hb` at the
  top. As in that design, the braid strip and the sleeve form the choke that keeps the current off
  the cable;
- the **phasing meander**, `n_m` = 6 turns of a `w_m` = 2 mm trace, `2 a_m` = 26 mm wide, with pitch
  `p_m`, from the top of the arm to the bottom of the upper element (74 mm tall);
- the **upper element**, `l_top` long and `w_top` wide, fed at its lower end by the meander.

The feed point is about 200 Ω, which a 50 Ω cable cannot feed directly: the upper element is fed
through the dipole arm, so its radiation resistance adds to the dipole's. So the feed is a
**quarter-wave line**. A `w_t` = 1.2 mm trace on the back face (y = −t) runs up behind the 1.2 mm
braid strip, from z = −`l_t` to the feed gap, where a via joins it to the base of the arm. The trace
and the braid strip form a broadside strip pair across the board, about 116 Ω. It is `l_t` = 58 mm
long, about a quarter of the guided wavelength once the via and the ends are counted. The 50 Ω
lumped port bridges the board at the lower end of the line, where the coax ends. There, the braid
is soldered to the braid strip and the inner conductor goes through a via to the back trace.

There is no ground plane. The open boundaries are PML (8 cells) behind a quarter wavelength at
0.75 GHz (100 mm) of air on every side. The mesh is automatic, 30 cells per wavelength at 1.0 GHz
(3.46 million cells). It has 3 cells across each 1 mm slot, 4 across the feed gap, 6 across the
1.2 mm feed trace, 10 in the 4 mm gaps between the meander rungs and 12 through the board.

**Why this variant.** Three kinds of collinear were considered:

- a **center-fed pair** of in-phase dipoles with a corporate feed, which needs a balanced
  divider and a balun on a 30 mm strip;
- a **Franklin** (two λ/2 strips joined by a phase-reversing stub), fed at the center of one
  element. With a balanced port it needs a balun, like the plain printed dipoles above;
- a **sleeve-dipole base with a stub and a second element** (this one).

The sleeve base is the most practical to build. The coax arrives along the axis through its own
choke, and the rest is a single-sided etch plus one line on the back and two vias. All of it is thin
copper on FR-4 with a lumped port, which Fairbeam models faithfully (only the copper is idealised,
as lossless). The stub must reverse the current between the two elements. With a plain gap the two
elements would radiate in antiphase, and a λ/2 of straight wire would add an antiphase radiator
between them. So the stub is folded into a meander, whose rungs carry opposite currents that cancel.

The spacing sets the gain. Two ideal collinear λ/2 dipoles have 3.8 dBi at 0.5 λ between centers,
4.4 dBi at 0.6 λ and 5.0 dBi at 0.75 λ (half-power beamwidth 48°, 42° and 35°). On FR-4 each
element is only about 0.41 λ long, so an in-line stub is also the only way to get the spacing. The
74 mm meander puts the centers 211 mm (0.61 λ) apart. The 5 dBi of the 0.75 λ case needs about
50 mm more length, about 400 mm in total, which is beyond the 350 mm budget.

| Parameter | Value | Meaning |
| --- | --- | --- |
| `f0` | 0.867 GHz | design frequency (far field and surface current) |
| `l_up`, `l_sl` | 68.8 mm | dipole arm above the feed gap, and sleeve below it (as in `sleeve_dipole_867`) |
| `w_up`, `w_sl` | 10, 16 mm | arm width; sleeve width (both strips, the braid strip and the slots). Each strip (`ws`) is 6.4 mm |
| `g` | 2 mm | feed gap |
| `w_f` | 1.2 mm | braid strip width (the front conductor of the feed line) |
| `s`, `hb` | 1, 3 mm | slot beside the braid strip; bridge height at the sleeve top |
| `w_t` | 1.2 mm | feed trace width on the back face (the strip pair is about 116 Ω) |
| `l_t` | 58 mm | feed line length, from the coax end (the port) to the feed gap (tuned) |
| `w_v` | 1 mm | the via into the arm sits `w_v`/2 above the feed gap |
| `n_m` | 6 | meander turns (rounded to a whole number, `nt`) |
| `p_m` | 12 mm | meander pitch (two rungs); the gap between rungs is 4 mm |
| `a_m` | 13 mm | meander half-width, from the axis to the outer edge of the links (tuned) |
| `w_m` | 2 mm | meander trace width |
| `l_top`, `w_top` | 142, 10 mm | upper element length and width |
| `wb`, `t`, `m` | 30, 1.6, 4 mm | board width, FR-4 thickness, board margin at both ends |

Derived: meander height `H_m` = 74 mm and trace length `L_m` ≈ 384 mm. The tightly coupled rungs
make that trace much longer than a λ/2. Element spacing `d_el` = 211 mm (0.61 λ). Antenna length
`L` = 351.6 mm from the sleeve end to the tip; the board is `H` = 359.6 × 30 × 1.6 mm. Band
0.75–1.0 GHz, end criterion −60 dB (timestep limit 250 000). Far field and surface current at `f0`,
radiation efficiency at 21 frequencies across the band.

**Tuning** (GPU engine, 12 runs. Runs 1–7 at 30 cells/λ and −50 dB, 8–9 at 30 cells/λ and −40 dB,
10 at 20 cells/λ and −40 dB, 11–12 at the defaults):

| Run | Phasing section and feed | Beam (θ = 90° is the horizon) | Match | Solver time |
| --- | --- | --- | --- | --- |
| 1 | three-leg zig-zag stub ("N"), 30 mm tall; port at the gap | 27° below the horizon; −3 dBi on the horizon | 124 − j31 Ω | 50 s |
| 2–4 | the same, 60 / 45 / 50 mm | 27.5° up / 14° down / 7.6° down | 58 − j80 / 182 + j27 / 275 − j108 Ω | 59–63 s |
| 5 | the same, 52.5 mm | on the horizon, Dmax 4.30 dBi, but 2.1 dB azimuth ripple | 181 − j195 Ω | 64 s |
| 6 | two mirrored meanders in parallel, 5 turns | 38° up: the pair acts as a loop | 327 − j109 Ω | 73 s |
| 7 | one full-width meander, 4 turns, `a_m` 10.5 | 25° down (too little phase) | 148 − j146 Ω | 74 s |
| 8 | 5 turns, and the strip-pair line (`w_t` 1.6, `l_t` 48) | 9.5° down, Dmax 3.78 dBi | band 0.902–1.0 GHz | 134 s |
| 9 | `a_m` 11.2, `w_t` 1.2 | 7.4° down, Dmax 4.22 dBi | band 0.875–1.0 GHz | 199 s |
| 10 | 6 turns | 3.7° down, Dmax 4.80 dBi | −17 dB at 867 MHz, band 0.851–0.998 GHz | 213 s |
| 11 | `a_m` 13 | 1.0° down, Dmax 4.74 dBi | −12.1 dB at 867 MHz, band 0.837–0.894 GHz | 460 s |
| 12 | `l_t` 58 (the defaults) | 1.1° down, Dmax 4.76 dBi | −12.0 dB at 867 MHz, band 0.822–0.969 GHz | 420 s |

The zig-zag stub (runs 1–5) set the phase: near the right height, each mm moved the beam by 1.3–3°.
But its links are not mirror-symmetric. At the right height they left a horizontal current that put
2.1 dB of ripple into the azimuth pattern. A meander whose rungs span the full width cancels that
current (0.2 dB ripple). More turns or wider rungs add phase: one more turn lifted the beam by
about 15° (runs 7–8), and 0.7 mm more of `a_m` by 2° (runs 8–9). With the port at the gap, the
variants that pointed the beam near the horizon had 150–300 Ω at the feed. The strip-pair
transformer brings that down to 50 Ω. Runs 11 and 12 differ only in its length (48 and 58 mm): the
longer line widened the band and moved it up. The runs slowed down as the model grew. The meander's
fine cells took the grid from 1.1 to 3.5 million cells, and the choke and the feed line ring down
slowly (227 000 timesteps to −60 dB).

**Results** (defaults, GPU engine, 3.46 million cells, 227 360 timesteps, 420 s solver time):

| Quantity | Value |
| --- | --- |
| \|S11\| at 863 / 867 / 870 MHz | −12.3 / −12.0 / −11.8 dB (VSWR 1.67 at 867 MHz) |
| −10 dB band | 0.822–0.969 GHz (147 MHz, 15.7 %), with two minima: −15.1 dB at 0.84 GHz and −17.8 dB at 0.935 GHz. The margin is 41 MHz (4.8 %) below 863 MHz and 99 MHz (11 %) above 870 MHz |
| Input impedance at 867 MHz | 67.9 − j24.3 Ω at the port (the coax end of the feed line) |
| Dmax / gain / realized gain | 4.76 / 4.19 / 3.90 dBi (Dmax from the pattern alone: 4.75 dBi) |
| Radiation / total efficiency | 87.6 % / 82.2 % at 867 MHz. The radiation efficiency is 83–88 % from 0.84 to 1.0 GHz. Below the band it falls (23 % at 0.75 GHz), where the antenna is badly mismatched. All 21 points are within the reliability limit |
| Horizon (θ = 90°) | gain 4.09 dBi (mean over azimuth), ripple 0.20 dB; realized gain 3.81 dBi |
| Elevation | half-power beamwidth 38.8° (θ = 71.9° to 110.8°); peak 1.1° below the horizon. Side lobes at −15 to −17 dBi from 45° to 75° below the horizon |
| Zenith / nadir | −32 / −34 dBi |

The surface current at `f0` has two maxima, one on the dipole arm and one on the upper element, in
phase within 15°. Between them, the meander rungs carry large opposite currents that cancel. The
meander is not a perfect phase shifter, though. Its links carry a net vertical current in antiphase,
comparable to the upper element's, and that costs some gain. So the antenna has 4.1 dBi on the
horizon, 0.3 dB less than two ideal dipoles at the same 0.61 λ. The bundle stores the total
directivity only, so the cross-polarisation is not separated. The rungs are symmetric about the
axis, and the azimuth ripple is 0.2 dB.

**Against the sleeve dipole and the ideal collinear.**

| | `sleeve_dipole_867` | This collinear | Ideal 2-element collinear, 0.61 λ | Ideal 2-element collinear, 0.75 λ |
| --- | --- | --- | --- | --- |
| Length × width | 139.6 × 16 mm (board 147.6 × 20 mm) | 351.6 × 26 mm (board 359.6 × 30 mm) | about 380 mm of wire | about 425 mm of wire |
| Horizon gain | 2.08 dBi | 4.09 dBi (+2.0 dB) | 4.42 dBi | 5.04 dBi |
| Dmax / gain | 2.10 / 2.05 dBi | 4.76 / 4.19 dBi | 4.42 dBi | 5.04 dBi |
| Elevation HPBW | 78° | 38.8° | 41.4° | 35.1° |
| Beam tilt | 0° | 1.1° down | 0° | 0° |
| Azimuth ripple | 0.04 dB | 0.20 dB | 0 dB | 0 dB |
| \|S11\| at 867 MHz, −10 dB band | −18.8 dB, 15.4 % | −12.0 dB, 15.7 % | | |
| Radiation efficiency | 98.8 % | 87.6 % | 100 % | 100 % |

**What the narrow beam means in flight.** The 2 dB is gained only near the horizon. At range, a
ground station is usually within a few degrees of the horizon, so long, level flight gets the full
gain. The table gives the gain (mean over azimuth) against the angle below the horizon, with the
antenna vertical:

| Below the horizon | 0° | 5° | 10° | 15° | 20° | 30° | 45° | 60° |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| This collinear | 4.1 | 4.0 | 3.5 | 2.6 | 1.3 | −2.7 | −15.7 | −17.5 dBi |
| λ/2 dipole (2.08 dBi, ideal pattern shape) | 2.1 | 2.0 | 1.9 | 1.6 | 1.3 | 0.3 | −2.0 | −5.5 dBi |

The collinear is better out to about 20° from the horizon and worse beyond. The difference is large
past 30°:

- **Banking.** A 30° bank tilts the beam by 30°: down on the low-wing side, up on the high-wing
  side. A ground station on the horizon, out to the side, is then 30° off the beam peak. The
  collinear gives −4.9 dBi on the low-wing side and −2.7 dBi on the high-wing side, where the λ/2
  dipole still gives 0.3 dBi. That is 3–5 dB worse than the dipole, instead of 2 dB better. A
  station 10–20° below the horizon gets 0.4 to 3.1 dBi on the low-wing side, and −10 to −25 dBi on
  the high-wing side. Only along the flight direction does the bank leave the beam alone. For
  turns, budget the link with about −5 dBi for the collinear and 0 dBi for the dipole.
- **Overhead passes.** Within about 45° of the vertical (above the station, on a climb-out, or
  close to the field), the collinear has −15 to −18 dBi, against −2 to −12 dBi for the dipole. Both
  have a null straight down, but the collinear's cone of weak signal is much wider. A UAV that
  flies over or near the ground station needs the link margin for that, or a second antenna with
  diversity (for example a dipole, or a patch looking down).

The collinear pays off for long-range, mostly level flight. For short-range work with steep banks
or overflights, the sleeve dipole's 78° beam is the more robust choice.

**Build notes and caveats.**

- **Feed and cable.** Lay a thin coax (RG-178 or RG-316) on the braid strip, from the bottom edge
  of the board to the lower end of the feed line (z = −58 mm). Solder its braid to the strip there,
  and take the inner conductor through a plated via to the back-face trace. The trace ends in a
  second via into the base of the arm, 1.5 mm above the gap. The braid must not touch the sleeve
  strips: the two 1 mm slots keep them apart, so strip only a short length. As in the sleeve
  dipole, the cable beyond the board is not modeled. Keep it on the axis for at least λ/4 (86 mm)
  below the board, or fit a ferrite on it at the board edge.
- **Match.** The match across 863–870 MHz is −12 dB, not the −19 dB of the sleeve dipole. The band
  is wide (15.7 %), but it has two minima, with −11.5 dB at about 880 MHz between them. Its center
  sits 3 % above 867 MHz, not the 1 % aimed for. No further tuning runs were made. The
  next steps are a slightly wider trace `w_t` (a lower line impedance), or re-tuning `l_t` by a
  millimeter or two around 58 mm. The mismatch costs 0.28 dB of realized gain.
- **Radome.** A thin glass-fiber shell lowers the frequency by a few per cent. The band reaches
  4.8 % below 863 MHz, so a shift of up to about 4 % keeps 863–870 MHz inside it. The phase is more
  sensitive: if the radome slows the meander more than the elements, the beam tilts. Check the
  pattern (or the signal strength at the horizon) with the radome fitted, and trim `a_m` (about 3°
  of tilt per mm) or the upper element.
- **Length.** At 360 mm, the board is long for a UAV. It needs a stiff radome or a mast. A board
  that flexes in flight tilts the beam, just as a bank does. The lower 150 mm (the sleeve dipole)
  can sit inside the fuselage, if the skin is glass fiber and not carbon.
- **Losses.** The radiation efficiency is 87.6 %, against 98.8 % for the sleeve dipole. The extra
  loss is most likely in the FR-4 under the feed line and the meander rungs, where the current
  density is high (an estimate: the model does not separate it). A low-loss laminate (tan δ about
  0.004) would recover most of it, but it changes εr, so re-tune `l_t` and `a_m`. The copper is
  lossless (PEC); real copper costs a few tenths of a per cent more.
- **FR-4 tolerance.** An εr anywhere from 4.2 to 4.7 moves the band and, through the meander, the
  tilt. Measure S11 and the pattern on the first boards before fixing the design.

## Ground-station 5-element Yagi, 867 MHz (`yagi_867.design.json`)

A directional antenna for the **ground station** of a UAV telemetry link in the 863–870 MHz SRD /
LoRa band. The UAV keeps an omnidirectional antenna (`sleeve_dipole_867`), and the extra gain for
range comes from the station. It is a five-element Yagi-Uda on a 283 mm boom: a reflector, a driven
dipole with a hairpin match, and three directors. It has 10.4 dBi of gain and an 18.6 dB
front-to-back ratio. Mount it with the elements **vertical**, to match the vertical polarisation of
the UAV's dipole.

**Model.** All the metal is aluminum, modeled as PEC sheets in the xz plane (y = 0). x is the boom
axis (+x forward, towards the UAV), and z points up along the elements. There is no board and no
dielectric. Each element is a **4 mm rod** (`d`), modeled as a flat strip `w` = 2 `d` = 8 mm wide.
A flat strip of width w has the equivalent radius w/4 of a round wire, so the strip and the rod
have about the same current distribution and resonance. Sheets need no mesh through a volume, which
keeps the timestep reasonable. The automatic mesh puts 6 cells (1.33 mm) across each strip, and two
cells of that size either side of the sheet plane. The parts are:

- the **reflector**, `L_r` long, at x = −`s_r`;
- the **driven element**, the two halves of a straight dipole, `L_de` from tip to tip, with a feed
  gap `g` = 6 mm between them at the origin;
- the **hairpin** (a beta match). Two rails, as wide as the elements, run back from the two halves
  towards the reflector, along the edges of the feed gap. A bar shorts them `l_hp` = 23 mm behind the
  rear edge of the driven element, 35 mm from its axis (`x_hp`). The hairpin is a shorted strip-pair
  stub in parallel with the feed: a shunt inductance of about 7–9 nH;
- **directors** 1–3, `L_d1`, `L_d2` and `L_d3` long, at x = `s_1`, `s_1 + s_2` and `s_1 + s_2 + s_3`.

A 50 Ω lumped port, 8 mm wide, bridges the feed gap. The feed is **balanced**: in practice the coax
needs a 1:1 balun at the gap (see the build notes). The boom is taken to be **non-metal** (glass
fiber, PVC or wood) and is left out. The open boundaries are PML (8 cells) behind a quarter
wavelength at 0.8 GHz (94 mm) of air on every side. The mesh is automatic, 30 cells per wavelength
at 0.95 GHz (715 000 cells). The smallest cell is 0.37 mm, where the hairpin rails meet the short.

**Why this variant.** Three kinds of driven element were considered:

- a **folded dipole** (about 200–300 Ω in a Yagi). It needs a 4:1 balun, and a 50 Ω port would see
  a 4–6:1 mismatch unless the balun is modeled too;
- a **printed quasi-Yagi on FR-4**. It is compact, but the FR-4 costs efficiency (the collinear
  above loses 12 %), its εr tolerance moves the band, and 10 dBi needs a board about 0.8 λ
  (280 mm) long;
- a **straight dipole with a hairpin match** (this one). A Yagi with about 10 dBi of gain has a low
  feed-point resistance (25 Ω in the first run below). The driven element is set slightly short
  (capacitive), and the hairpin's shunt inductance transforms the result to 50 Ω.

The hairpin variant is the easiest of the three to build from rod or strip, and it needs only a 1:1
balun. It is all metal strips in the air with a lumped port across the gap, which Fairbeam models
faithfully. The hairpin's short is a voltage null, so it can be bonded to the boom or the mast as a
DC ground.

The dimensions start from the **NBS 5-element design** (NBS Technical Note 688: a 0.8 λ boom, 0.2 λ
spacings, a 0.482 λ reflector and 0.428/0.420/0.428 λ directors, for d/λ = 0.0085). The NBS design is
optimized for gain alone. A thin-wire method-of-moments (MoM) model with the 4 mm rods gave it
11.3 dBi but only 12.9 dB front-to-back at 867 MHz, and 11.7 dB at 870 MHz. (The MoM model is a
small Python script, not part of fairbeam.) The lengths and spacings were re-optimized in that
model for 10.3–10.8 dBi, with at least 20 dB front-to-back over 863–870 MHz. This moved the
reflector further back and the last director further forward, giving a 0.82 λ boom. The FDTD runs
then corrected the lengths for the strip model (see Tuning below).

| Parameter | Value | Meaning |
| --- | --- | --- |
| `f0` | 0.867 GHz | design frequency (far field and surface current) |
| `d` | 4 mm | element rod diameter; the strips are `w` = 2 `d` = 8 mm wide |
| `L_r` | 162.4 mm | reflector length (0.470 λ) |
| `L_de` | 156 mm | driven element, tip to tip, including the 6 mm gap (0.451 λ; tuned) |
| `L_d1`, `L_d2`, `L_d3` | 142.9, 137.1, 129.8 mm | director lengths (0.413, 0.396, 0.375 λ) |
| `s_r` | 78 mm | reflector to driven element (0.226 λ) |
| `s_1`, `s_2`, `s_3` | 47, 60, 98 mm | driven element to director 1, director 1 to 2, director 2 to 3 (0.136, 0.174, 0.283 λ) |
| `g` | 6 mm | feed gap between the dipole halves, and the gap between the hairpin rails |
| `l_hp` | 23 mm | hairpin slot length, from the rear edge of the driven element to the short (tuned) |

Derived: the boom length `boom` is 283 mm (0.82 λ) from the reflector to director 3. The hairpin
length `x_hp` is 35 mm, from the driven element's axis to the back of the short. The antenna is
283 × 162 mm, plus 8 mm in x for the strip widths. Band 0.8–0.95 GHz, end criterion −60 dB
(timestep limit 200 000). Far field and surface current at `f0`, radiation efficiency at 21
frequencies across the band.

**Tuning** (GPU engine, 6 runs: 1–5 at 20 cells/λ and −40 dB, 6 at the defaults):

| Run | Change | Result at 867 MHz | Solver time |
| --- | --- | --- | --- |
| 1 | the MoM lengths (reflector 166.5, driven element 152, directors 146.5/140.5/133 mm), no hairpin | driven element 25.7 + j0.4 Ω; Dmax 10.78 dBi, F/B 15.8 dB | 2.0 s |
| 2 | parasitic elements 2.5 % shorter, `L_de` 145.4 mm, hairpin `l_hp` 5 mm | F/B 18.0 dB, Dmax 10.44 dBi; 21.9 + j72.2 Ω (−2.4 dB) | 5.5 s |
| 3 | `L_de` 152 mm | 42.7 + j49.3 Ω (−6.5 dB) | 4.2 s |
| 4 | `L_de` 158 mm, `l_hp` 18 mm | −14.6 dB; best −18.5 dB at 858 MHz | 3.6 s |
| 5 | `L_de` 156.5 mm, `l_hp` 23 mm | −22.8 dB; best −30.7 dB at 863 MHz | 3.6 s |
| 6 | `L_de` 156 mm: the defaults, 30 cells/λ and −60 dB | −27.2 dB; best −33.0 dB at 865 MHz | 38.0 s |

Run 1 showed the strips behaving about 2.5 % longer than the MoM rods: to match it, the MoM model
needed every length scaled up by 2.5–3 %. Its front-to-back ratio (15.8 dB) and gain matched the
MoM model at about 882 MHz instead of 867 MHz. Run 2 shortened the parasitic elements by 2.5 %,
which gave 18 dB front-to-back across the band. After that the pattern hardly changed: Dmax stayed
within 0.05 dB and the front-to-back ratio within 0.7 dB in the remaining runs. The hairpin and the
driven element were tuned together. After each run, a fit of the runs so far picked the next
values; the fit models the hairpin as a shorted stub in parallel with a driven element whose
impedance is linear in `L_de`. One millimeter of `L_de` changes the reactance at the feed by about
6–8 Ω. The final run's match sits within about 0.3 % of where the coarse runs put it for 156 mm.

**Results** (defaults, GPU engine, 714 840 cells, 79 206 timesteps, 38.0 s solver time):

| Quantity | Value |
| --- | --- |
| \|S11\| at 863 / 867 / 870 MHz | −28.6 / −27.2 / −20.7 dB (VSWR 1.09 at 867 MHz) |
| Best match | −33.0 dB at 864.7 MHz |
| Input impedance at 867 MHz | 49.4 + j4.3 Ω. X = 0 at 863.6 MHz, R = 53.1 Ω |
| −10 dB band | 844.4–883.1 MHz (38.7 MHz, 4.5 %). The margin is 19 MHz (2.2 %) below 863 MHz and 13 MHz (1.5 %) above 870 MHz |
| Dmax / gain / realized gain | 10.45 / 10.40 / 10.39 dBi (Dmax from the pattern alone: 10.45 dBi) |
| Radiation / total efficiency | 99.0 % / 98.8 % at 867 MHz. The radiation efficiency is 97–99.6 % from 0.80 to 0.935 GHz; the metal is PEC, so the missing per cent is numerical. The total efficiency is above 89 % from 0.845 to 0.883 GHz. All 21 points are within the reliability limit |
| Front-to-back ratio | 18.6 dB at 867 MHz (18.9 dB at 863 MHz, 18.1 dB at 870 MHz). The back lobe is the largest lobe in the rear half-space, so the front-to-rear ratio is the same |
| E-plane (vertical, the plane of the elements) | half-power beamwidth 54.1° (53.8–54.5° over 863–870 MHz), peak on the horizon. The element nulls at the zenith and nadir are at −24 dBi |
| H-plane (horizontal, azimuth) | half-power beamwidth 69.8° (69.2–70.6°). Broadside (90° off the boom) is −11.7 dBi, 22 dB below the peak |
| Over 863 / 867 / 870 MHz | Dmax 10.35 / 10.45 / 10.52 dBi, realized gain 10.29 / 10.39 / 10.42 dBi |

The beamwidths are interpolated from the pattern (3° steps in θ, 5° in φ). For the band-edge
values, the final run used a copy of the file with far fields at 863, 867 and 870 MHz; the file
itself records the far field at `f0` only.
The surface current at `f0` peaks on the driven element. Relative to that peak, the directors carry
59 %, 76 % and 52 % (directors 1 to 3), the reflector 51 %, and the hairpin's short 60 % (its
circulating current).

**Against theory and the sleeve dipole.**

| | NBS 5-element (0.8 λ), MoM, 4 mm rods | Re-optimized, MoM | This design, FDTD | `sleeve_dipole_867` |
| --- | --- | --- | --- | --- |
| Boom | 277 mm (0.80 λ) | 283 mm (0.82 λ) | 283 mm (0.82 λ) | none |
| Gain at 867 MHz | 11.3 dBi | 10.5 dBi | 10.40 dBi (realized 10.39 dBi) | 2.05 dBi (realized 1.99 dBi) |
| Front-to-back | 12.9 dB (11.7 dB at 870 MHz) | 20.9 dB | 18.6 dB | 0 dB |
| E / H-plane HPBW | 47° / 57° | 54° / 71° | 54.1° / 69.8° | 78° / omnidirectional |
| Feed | 17 + j19 Ω | 25 − j18 Ω before the hairpin | 49.4 + j4.3 Ω with the hairpin | 55.8 − j10.7 Ω |

A 0.8 λ Yagi has about 10–11 dBi (the NBS table gives about 9.2 dBd, 11.3 dBi, for its
gain-optimized version). Trading 0.9 dB of that for a clean rear hemisphere is the usual choice for
a ground station, where the back lobe mostly picks up interference and ground reflections. The
FDTD front-to-back ratio is 2.3 dB below the MoM one, most likely because the strips couple a
little differently from round rods. It stays within 0.5 dB of 18.6 dB across 863–870 MHz.

**Link budget: the extra range.** In free space, the range at a fixed link margin grows with the
square root of the product of the two antenna gains. So a gain difference ΔG (in dB) at one end
multiplies the range by 10^(ΔG/20). With the Yagi (10.39 dBi realized) in place of the sleeve dipole
(1.99 dBi realized) at the station:

| Station antenna | Realized gain | ΔG | Range factor | A link that reached 10 km now reaches |
| --- | --- | --- | --- | --- |
| `sleeve_dipole_867` | 1.99 dBi | | 1 | 10 km |
| This Yagi, pointed at the UAV | 10.39 dBi | 8.4 dB | 2.63 | 26 km |
| This Yagi, 30° off the UAV in azimuth | 8.3 dBi | 6.3 dB | 2.07 | 21 km |

The factor applies to the uplink and the downlink alike, since the antenna is reciprocal. It is a
free-space figure. On a real path, the ground reflection, the Fresnel-zone clearance and the
earth's curvature limit the range first, so the antenna heights and the terrain matter as much as
the gain. The SRD band's power limit (typically 25 mW ERP, 14 dBm, over most of 863–870 MHz) counts
the antenna gain. So a transmitting station with the Yagi must lower its transmitter power by the
Yagi's gain over a dipole (8.2 dB) to stay within it. The receive direction keeps the full 8.4 dB.

**Build notes and caveats.**

- **Pointing.** The station Yagi must point at the UAV. The azimuth beamwidth is 70°: the gain
  drops by 3 dB at ±35° off the boom and by about 12 dB at ±60°. For a UAV that flies all around
  the field, a tracker helps: a pan servo driven from the UAV's GPS position in the telemetry. A
  tilt axis helps on close, high passes, where the UAV is more than about 25° above the horizon. A
  fixed Yagi suits a mission flown in one sector.
- **Polarisation.** Mount the elements vertically, to match the UAV's vertical dipole. A
  horizontal Yagi would lose 20 dB or more to cross-polarisation against it.
- **Balun.** The feed is balanced, so the coax needs a 1:1 current balun at the gap. Ferrite beads
  over the last 50 mm of the cable work (for example 3–5 type 43 or 61 beads on RG-316, or a clip-on
  core on RG-58), and so does a λ/4 sleeve (bazooka) balun, about 86 mm long. Without a balun,
  current on the outside of the coax distorts the pattern and costs front-to-back ratio. Take the
  coax away along the boom, not parallel to the elements.
- **Boom and mast.** The model has no boom. With a non-metal boom, fit the elements as they are.
  With a metal boom and the elements bonded through it, lengthen each element by the boom
  correction: roughly 0.5–0.7 times the boom diameter for a small round boom, following DL6WU's
  chart (not simulated here). With the elements insulated and at least one boom diameter above the
  boom, the correction is almost zero. The driven element must be insulated from a metal boom,
  apart from the center of the hairpin's short, which may be bonded. A metal mast close to and
  parallel with the vertical elements degrades the pattern. Mount the boom on the mast behind the
  reflector, or use a non-metal mast section for the top half meter.
- **Rods or strips.** The model is a flat strip 8 mm wide. Flat aluminum strip of that width
  (1–2 mm thick) builds exactly what was simulated. Round 4 mm rods are equivalent in theory; expect
  the match to move by up to about 1 %. Trim `L_de` or `l_hp` on the finished antenna: 1 mm of
  `L_de` moves the match by about 5 MHz.
- **Hairpin.** Build the rails from the same rod or strip, 6 mm apart edge to edge, level with the
  edges of the feed gap. The slot length `l_hp` and `L_de` set the match together; a longer slot
  adds inductance. The geometry keeps the short behind the driven element for any `l_hp` > 0. The
  design checks would not flag a short that crossed the feed gap (a sheet across the port shorts
  it), so keep that in mind when editing the hairpin.
- **Band.** The −10 dB band is 4.5 % wide, narrower than the printed dipoles', so the length
  tolerance is about ±1 % (±2 mm on `L_de`). The pattern has a wider band: the front-to-back ratio
  stays above 18 dB over 863–870 MHz.
- **Losses.** The metal is lossless (PEC). Aluminum costs a few tenths of a per cent at 867 MHz.
- **Surroundings.** Buildings, vehicles and people within a few wavelengths in front of the
  antenna change the pattern and reflect the signal. Mount it high and clear.
