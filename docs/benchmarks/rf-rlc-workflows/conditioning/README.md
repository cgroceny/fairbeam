# Series RLC coefficient conditioning (no solver run)

The inspected optimized source uses `FDTD_FLOAT = float` (`tools/constants.h:21`). Both series coefficient arrays and auxiliary J/V state are float32. The base `Calc_LumpedElements` calls `IsLEparRC`, whose predicate requires PARALLEL and no positive L (`operator.cpp:1602,1754`). It skips SERIES: H2 is ruled out for this source, subject to binary/source provenance.

`operator_ext_lumpedRLC.h:30` defines the clamp factor as 20. This analysis uses the fixture's natural Cd estimates, below the clamp threshold; exact stored per-edge coefficients and binary compiler contraction settings were not retained.

## Frozen acceptance criteria

- Existing native fixture: max complex relative Z error over 4–6 GHz <=10%; its retained series failure remains unchanged.
- Float64 replay control: <=0.5%.
- Establishing reproduction of measured failure: <=3 ohms max distance from measured Z after diagnostic subtraction of the independently estimated 8.5 fF shunt. This is not a changed native acceptance criterion.

## Derived recurrence

Source equations, with V/J histories rotated before the update:

`V[n] = vvd * (Vraw[n] + vv2 V[n-2] + vj1 J[n-1] + vj2 J[n-2])`

`J[n] = ib0 (V[n]-V[n-2]) - float(b1*ib0) J[n-1] - float(b2*ib0) J[n-2]`

For q=exp(-j omega dt), `H=J/V=ib0(1-q^2)/(1+a1 q+a2 q^2)`. With the natural grid update `Vraw[n]=V[n-1]+dt/Cd Iexternal[n-1/2]`, elimination gives:

`Yedge = Cd/dt * (1/vvd-q-vv2 q^2-(vj1 q+vj2 q^2) H)`.

The script evaluates the source's independently rounded coefficients in this coupled expression, includes six parallel edges, and centers the half-step current. It also separately replays every float32 arithmetic operation of the prescribed-voltage J recurrence. The latter exercises arithmetic but is not a replay of spatial FDTD or the fixture's port coupling.

## Evidence

Probe interval divided by nearest integer stride (1129, established using energy timestamps) recovers dt=1.845218335792737e-14 s. Energy output prints only 1.84522e-14. At recovered dt, P(1) is 1.7016303e-7 in double and 2.3841858e-7 after separate float32 coefficient products. Using the rounded dt instead produces 5.9604645e-8: this small timestep rounding reverses the apparent effective capacitance shift. Neither a rounded log timestep nor worst-case ulp estimates are adequate for an attribution claim.

At recovered dt, estimated Cd endpoints give 0.223–0.335% coupled double error (passes control), versus 16.005–16.072% float32 error (fails native tolerance). Float32 remains 10.37–10.43 ohms from shunt-corrected measured data, failing the frozen reproduction criterion, and its reactive shift is opposite the reported lower-effective-C hypothesis. Double also does not reproduce measured data (~19.9 ohms distance).

At half dt, float32 P(1)=0 and error~39%; at quarter dt P(1)<0 and error~262%; at twice dt error~4.7%. These are numerical replay results, not solver observations, and show conditioning can worsen as timestep shrinks without proving a monotonic trend at all intermediate timesteps.

Prescribed Gaussian voltage at the actual run length (49676 steps) has a nonzero tail and the double frequency error~1.98%, so that short replay is retained as a failed control. Extending this algebra-only replay to 150000 steps removes truncation: double passes with negligible error; float32 remains ~17.1%. This supports arithmetic sensitivity independent of fixture parasitics, but is not the actual excitation or source impedance.

Retained series voltage has only 11 samples after 0.7 ns and 6 after 0.8 ns. Their log-magnitude slopes are -1.096e10 and -1.145e10/s. They are compatible with a shifted slow mode but are not identified circuit poles: the source is still present, sampling is sparse, and unknown spatial modes contribute. No defensible Prony attribution follows from these slopes alone.

## Conclusion and limits

H2 is rejected for the source inspected. H1 is a demonstrated numerical vulnerability, but this bounded test does not reproduce or establish the cause of the measured series error. Full measured edge coefficients, actual binary compiler/FMA behavior, and source/field coupling remain untested. Keep the retained native series failure and current tolerance. An actual controlled solver comparison remains separate work; none was run here.

`result.json` retains all coefficient cases, both short-control failures and longer replays, descriptive tails, source/input hashes, and thresholds. With NumPy installed, reproduce using `python analyze.py --runs <retained-fixture-directory> --source <matching-openEMS-source> --output <fresh-result.json>`. The run directory contains `validation.json` and the R/series/parallel raw signals; its input and source hashes must match the retained report. No openEMS import, FDTD, native build, or source mutation occurs.
