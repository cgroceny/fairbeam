# openEMS lumped resistors: accuracy check (reproduction for the openEMS developers)

**Result: openEMS lumped resistors are accurate.** Measured directly at the element, the resistance
is exact to better than 0.1 % in its real part from 0.5 to 6 GHz. The small parallel reactance
comes from the probe box. The result does not depend on the resistor value (30-300 Ω), the cells
along or across the current (1-8), `caps`, or whether the element is a plain `LumpedElement` or a
passive `LumpedPort`. A lossy material block of the same resistance behaves identically.

An apparent frequency-dependent error seen through a test fixture is a de-embedding artifact.
It scales with fixture length and is independent of R, the element type and the mesh. An earlier
estimate of "+10 % at 2.4 GHz" came from de-embedding a microstrip test line against a differently
meshed reference line and was wrong. Nothing needs to be reported upstream as a bug. The script
and data here are for anyone who wants to check.

## Reproduction

`python/examples/lumped_resistor_test.py` uses only openEMS, CSXCAD and numpy:

```bash
python python/examples/lumped_resistor_test.py --kind lumped --R 100               # upstream openEMS (CPU)
python python/examples/lumped_resistor_test.py --kind port --R 50 --engine gpu     # openEMS GPU fork
```

**Fixture.** Two PEC plates (length a, width w) are a gap g apart in z, in free space with MUR
boundaries. A 50 Ω lumped port drives the gap at x = 0, and the device under test (DUT) bridges it
at x = a. The DUT kinds are:

- `lumped` and `lumped-nocaps`: `AddLumpedElement(ny=2, caps=True/False, R=R)`
- `port`: a passive `LumpedPort` with `excite=0`
- `material`: a block with κ = g / (R w t)

Each case needs three runs: open (no DUT), short (DUT replaced by metal) and the DUT. The DUT
impedance follows from open-short de-embedding:

```
Y'_m = 1/Z_m − 1/Z_open,   Y'_s = 1/Z_short − 1/Z_open,   Z_dut = 1/Y'_m − 1/Y'_s
```

For a passive port as the DUT, the script also reports **−U/I measured at the DUT itself**. This is
the voltage and current of the element's own probes, with no fixture in between. The excitation is
a DC-free Gaussian derivative, and the end criterion is −60 dB. All 14 cases of the table below ran
in 8 s on the openEMS Metal GPU fork. The CPU engine gives the same numbers, only slower.

## Data (Z_dut / R, a = w = g = 1 mm, 4 × 4 cells unless noted)

| Case | 1 GHz | 2.4 GHz | 4 GHz | 6 GHz |
| --- | --- | --- | --- | --- |
| **Passive port, −U/I at the element**, R = 100 Ω | 1.000 | **1.000 − 0.007j** | | **0.999 − 0.017j** |
| Passive port, −U/I at the element, R = 50 Ω | 1.000 | 1.000 − 0.008j | | 0.998 − 0.020j |
| Lumped (caps), fixture de-embedded, R = 30 / 100 / 300 Ω | 0.999 | 0.993 | 0.981 | 0.959 |
| Lumped, 2 × 2 cells | 0.999 | 0.993 | 0.979 | 0.954 |
| Lumped, 8 × 8 cells | 0.999 | 0.994 | 0.982 | 0.961 |
| Lumped, 1 cell along the current | 0.998 | 0.990 | 0.972 | 0.937 |
| Lumped, 8 cells along the current | 0.999 | 0.994 | 0.983 | 0.962 |
| Lumped, 1 cell across | 0.999 | 0.994 | 0.983 | 0.962 |
| Lumped, `caps=False` | 0.999 | 0.993 | 0.981 | 0.959 |
| Passive port as DUT (de-embedded) | 0.999 | 0.993 | 0.981 | 0.959 |
| Lossy material block (κ) | 0.999 | 0.993 − 0.002j | 0.981 − 0.004j | 0.958 − 0.005j |
| Fixture gap 2 mm | 0.998 | 0.990 | 0.972 | 0.937 |
| Fixture plates a = 0.5 mm | 1.000 | 0.997 | 0.992 | 0.983 |

**Reading the table.**

- The de-embedded value shows a factor 1 − k f² that is the same for every R, every element type
  (lumped with or without caps, port, lossy material) and every mesh. It changes only with the
  fixture size: a = 0.5 mm gives 0.983 at 6 GHz, a = 1 mm gives 0.959, and a 2 mm gap gives 0.937.
  That is the signature of the open-short model's lumped assumption failing on a fixture that is
  a short transmission line. The resistor has nothing to do with it.
- Measured at the element, the real part is exact. The imaginary part (−0.7 % of R at 2.4 GHz,
  −1.7 % at 6 GHz) corresponds to a parallel capacitance of about 5 fF from the probe box.

## Consequences for Fairbeam

- **No compensation is needed**, so `Simulation.lumped_resistor(..., compensate=...)` was not
  added.
- **Terminated ports are exact terminations.** In any case, Fairbeam's S-matrix does not depend on
  them: with every port driven it is assembled as `S = B A^-1`, which is exact for any termination.
  Only a partial excitation (`b_i/a_j`) assumes matched terminations.
- **The Wilkinson output-match residual** (VALIDATION.md, section 8) is therefore not a resistor
  modeling error. The same layout with a lossy-material resistor body instead of the lumped
  element gives the same odd-mode impedance: 34.2 + j3 Ω, against 34.1 + j3 Ω.
