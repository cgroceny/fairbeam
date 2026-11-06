# Antenna starting dimensions

Open **Antenna starting dimensions** on the Start screen. It works offline and
does not start a simulation. Choose a half-wave dipole, quarter-wave monopole,
or rectangular patch, enter frequency in GHz and read dimensions in mm.
Export estimate (JSON) retains the inputs, dimensions, units and assumptions.
The file is an estimate record, not a runnable Design.

With the run server connected, **Create editable design** opens a new Design from
the current inputs. An existing unsaved design still gets the normal Save / Don't
save / Cancel prompt. Creation starts a geometry preview, not a simulation. The
frequency and dimensions remain editable parameters; repeated creation chooses
a free file name rather than replacing an existing project.

Dipole and monopole drafts use PEC strips. Their width and feed gap start at
`wavelength / 125`; the estimated length includes the gap. The monopole has a
finite square ground `0.8 * wavelength` wide, so it does not reproduce the
calculator's infinite-ground assumption. Patch drafts have a lossless substrate,
a finite PEC ground, and an editable lumped probe at `L/3` from the center.
These feed and ground choices are starting layouts, not matching or radiation
validation. Inspect the geometry and run mesh/domain convergence before relying
on simulated results.

The free-space wavelength is `299.792458 / f_GHz` mm. Dipole **total** length is
`k * wavelength / 2`; each arm is half that length. Monopole length is
`k * wavelength / 4` and assumes an ideal infinite PEC ground plane. The
adjustable factor `k` defaults to 0.95 as an explicit starting assumption,
not a universal measured correction. Feed gaps, wire radius, surroundings,
insulation and finite ground all change the final design.

The patch estimate uses the rectangular TM10 transmission-line formulas:

```
W = wavelength / 2 * sqrt(2 / (epsilon_r + 1))
epsilon_eff = (epsilon_r + 1)/2 + (epsilon_r - 1)/(2*sqrt(1 + 12*h/W))
delta_L = 0.412*h*(epsilon_eff + 0.3)*(W/h + 0.264) /
          ((epsilon_eff - 0.258)*(W/h + 0.8))
L = wavelength / (2*sqrt(epsilon_eff)) - 2*delta_L
```

Reference: IIT Bombay's [Virtual Electromagnetics Laboratory formulas](https://www.ee.iitb.ac.in/course/~vel/apps/RMSA/Pages/RMSA_Formulae.html),
which cite Balanis, *Antenna Theory*, third edition. Fairbeam's patch starter
already uses these equations. The calculator implements them independently of
the run server, with a conservative thin-substrate admission boundary:
`1 <= epsilon_r <= 20`, positive `h <= wavelength/(20*sqrt(epsilon_r))`, and
`W/h >= 1`. Outside that boundary it requests a full model instead of showing
unqualified dimensions. This boundary is an application restriction, not a
claim that the approximation is exact inside it.

Frequency is limited to 1 kHz–1 THz; the length factor is 0.5–1. Empty, nonfinite
and out-of-range inputs hide results and disable export. Inputs and exported
numbers use decimal points in both English and Turkish.

These calculations do not solve a feed, matching, losses, radiation, bandwidth,
finite-ground effects or manufacturing constraints. Build a suitable model and
check convergence before using the result as a final antenna design.
