# Fairbeam (Python package)

Runs openEMS antenna models and exports self-contained project bundles for the Fairbeam viewer.
See the repository README for installation, the model format and the CLI.

## Offline planar feed calibration

`fairbeam.network` provides opt-in NumPy post-processing; it does not run FDTD or
change a model, a bundle or Designer. Run the synthetic reproduction from this
directory:

```text
python examples/planar_feed_calibration.py
python -m unittest tests.test_planar_calibration tests.test_network -v
```

For two reciprocal straight lines of lengths `ls < ll` in **meters**, measured
with the same cross-section, launches and positive real port references, the
matched single-mode model is:

```text
gamma = alpha + j*beta                 [1/m], exp(+j*omega*t) convention
S21(l) = g1*g2 * exp(-gamma*l)
alpha = -log(abs(S21(ll)/S21(ls))) / (ll-ls)
beta = (-arg(S21(ll)/S21(ls)) + 2*pi*k) / (ll-ls)
```

`two_line_calibration(f, s_short, s_long, *, short_length_m, long_length_m,
beta_hint, match_tol=0.05, reciprocity_tol=0.01, transmission_floor=1e-6)` accepts
positive, strictly increasing **Hz**, complete complex `(frequency, 2, 2)` S,
and a nonnegative real `beta_hint` vector in **rad/m** at every frequency. The
hint must be within `pi/(ll-ls)` of the physical beta; it selects the logarithm
branch independently at each frequency. A material/delay estimate is a hint,
not an independent electromagnetic result. Branch ties are refused. Phase
continuity alone cannot resolve the absolute branch.

The returned in-memory dict includes `frequency_hz`, `gamma_per_m`,
`launch_product` (`g1*g2`), `branch` (forward/reverse columns),
`length_difference_m`, `match_max` and `reciprocity_max`. Both directions are
used. The controls are refused if reflection exceeds `match_tol`, relative
S21/S12 error exceeds `reciprocity_tol`, or either transmission falls below the
floor. Small measured reflection is necessary but cannot prove identical
launches or exclude hidden mismatch/coupling. Small length differences amplify
measurement noise. Negative measured alpha is retained, not clipped to zero.

`shift_reference_planes(s, gamma_per_m, distances_m, *, launch_factors=None)`
returns a new S array of any port count with:

```text
S'_ij = S_ij * exp(gamma_i*d_i + gamma_j*d_j)
```

Positive distance moves the measurement plane into the device, removing feed;
negative distance adds line. Reflection has twice the one-way correction.
Gamma has shape `(frequency,)` for a common medium or `(frequency, port)`;
distances are a real scalar for all ports or a real `(port,)` vector in meters.
Feed characteristic impedances must equal the existing port reference
impedances. This is not impedance renormalization. The optional independently
known, matched one-way `launch_factors` have shape `(frequency, port)` and divide
the result by `g_i*g_j`. Two lines only determine the product: neither API
assumes equal launches or chooses a square root to split it.

for measured Fairbeam bundles, `fairbeam.touchstone.full_matrix(bundle)` returns
`(f, s, z_ref)`. Explicitly check the two control/DUT frequency vectors and port
references agree before using these APIs; incomplete columns, NaNs and unsafe
exponential corrections are refused. Convert bundle drawing coordinates to
meters using `bundle['units']['length_m']` before specifying plane distances.
Keep raw and corrected arrays separately; bundle measurement metadata is not
rewritten. A corrected file may be written separately with
`fairbeam.touchstone.format_snp`, after choosing a common real reference.

This first stage separates uniform matched feed propagation from the DUT. It
does not remove mismatched launch reflections, mode conversion, radiation or
coupling between fixtures, and does not provide full TRL/error-box calibration.
For that distinction and the need for reflect standards, see the primary
[scikit-rf Multiline TRL documentation](https://scikit-rf.readthedocs.io/en/latest/examples/metrology/Multiline%20TRL.html).
The synthetic example and tests check circuit algebra (including lossy ABCD
cascades and independent nodal multiport networks); they do not demonstrate
FDTD mesh convergence or validate any textbook application.
