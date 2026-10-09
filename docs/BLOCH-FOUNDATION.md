# Bloch/Floquet foundation

`python/fairbeam/bloch.py` provides a mathematical foundation for future periodic
research: real transverse wavevectors, lattice phases, diffraction channels,
TE/TM admittances, peak-amplitude power normalization, and complex planar field
projection. `python/fairbeam/bloch_reference.py` separately provides a paired
real/imaginary reference for the two seam derivatives on a one-dimensional Yee
line. Neither module enables oblique native runs. The existing experimental
periodic CPU backend still admits only its revision-4, zero-phase capability
handshake and co-polar fundamental outputs.

## Phase and units

All foundation lengths are **meters**, frequencies are **Hz**, angles and seam
phases are **radians**, and wavevectors are **radians per meter**. The chosen peak
phasor convention is

```text
physical field = Re{F(r) exp(-i omega t)}, omega = 2 pi f
plane wave F(r) = F0 exp(+i k dot r)
F(r + a_j) = exp(+i kt dot a_j) F(r)
```

Thus a positive seam crossing multiplies by `exp(+i phase_j)` and a negative
crossing multiplies by its conjugate. A purely real phase is required. For real
translation vectors `a1` and `a2`, `phase_j = kt dot a_j` is stored **unwrapped**.
Wrapping a phase modulo `2 pi` preserves the seam multiplier but changes the
selected wavevector branch and the labels of diffraction orders. The caller
must supply that branch explicitly; the inverse phase function does not guess
it. Meep's public wavevector input uses cycles per length, so it requires
`kt/(2 pi)` for this convention. Its documented adjacent-cell phase relation
provides a primary reference for the sign and factor of `2 pi`.
[Meep FAQ](https://meep.readthedocs.io/en/latest/FAQ/#how-does-k_point-define-the-phase-relation-between-adjacent-unit-cells)

The lattice may be skew and may have either orientation. Vectors are matrix
rows, and reciprocal vectors satisfy `a_i dot b_j = 2 pi delta_ij`. A rectangular
cell has `b1=(2 pi/Lx,0)` and `b2=(0,2 pi/Ly)`. Positive cell area is the absolute
determinant. Degenerate, nonfinite, and severely ill-conditioned lattices are
rejected.

## Diffraction channels and outgoing branch

The supported half-space is homogeneous, isotropic, lossless, and has strictly
positive real `eps_r` and `mu_r`. Absorbing media, anisotropy, negative-index
media, and complex transverse wavevectors require a separate extension.

For each explicitly requested integer pair `(m,n)`,

```text
k = (omega/c0) sqrt(eps_r mu_r)
kt_mn = kt + m b1 + n b2
q = kz_plus = sqrt(k^2 - |kt_mn|^2)
```

The outgoing `+z` branch has positive real `q` for a propagating order and
positive imaginary `q` for an evanescent order. The latter gives decay
`exp(-Im(q) z)` toward positive infinity. An outgoing wave in the `-z`
half-space uses `kz=-q` and decays toward negative infinity. This follows the
homogeneous dispersion relation; Meep's diffraction tutorial documents the
reciprocal-order shift and the real/imaginary longitudinal split.
[Meep diffraction tutorial](https://meep.readthedocs.io/en/latest/Python_Tutorials/Mode_Decomposition/#diffraction-spectrum-of-a-binary-grating)

The classification is `propagating`, `evanescent`, or `cutoff`. Cutoff uses
`abs(k^2-|kt_mn|^2) <= 1e-12 max(k^2,|kt_mn|^2)` and sets `q=0`; its admittance,
wave separation, and power normalization are refused because the traveling
wave decomposition is singular there. This tolerance is an explicit numerical
choice, not a claim about solver accuracy. At most 4,096 unique orders can be
requested. The module does not infer a complete set: omitted orders can still
propagate, and a finite order list alone cannot establish full power balance.

## TE/TM and power

For nonzero transverse wavevector, define tangent unit vectors

```text
p = kt_mn / |kt_mn|                  (TM tangential electric direction)
s = z_hat cross p                   (TE electric direction)
eta = eta0 sqrt(mu_r/eps_r)
Y_TE = q/(omega mu) = (q/k)/eta
Y_TM = omega eps/q = (k/q)/eta
```

At normal incidence the deterministic convention is `p=+x`, `s=+y`. These
directions are unchanged for the two longitudinal signs. The TM coefficient is
the **tangential electric amplitude**, not the magnitude of the full electric
vector. Its longitudinal component is `E_z = -|kt_mn| E_TM/(direction*q)`.
Maxwell's relation `H = k cross E/(omega mu)` gives
`H_t = direction * Y_pol * (z_hat cross E_t)` for either polarization. These
relations agree with the TE/TM transverse wave impedances of oblique incidence.
[MIT Electromagnetics and Applications, Chapter 9](https://ocw.mit.edu/courses/6-013-electromagnetics-and-applications-spring-2009/318e025511f2c95bb95b6322b30f9c06_MIT6_013S09_chap09.pdf)

With peak complex amplitude `a` in V/m, one isolated wave carries unsigned
normal power `P = area * Re(Y_pol) * |a|^2 / 2`. The factor `1/2` belongs to
this peak-phasor convention; RMS fields require a different convention.
For propagating orders, the normalized complex amplitude is
`a_power = sqrt(area*Re(Y_pol)/2) * a` in `sqrt(W)`, so its squared magnitude
equals power and its complex phase is retained. The signed flux of propagating
orders is the sum of forward powers minus backward powers. This general use
of power-normalized coefficients is also documented in the
[Meep mode decomposition reference](https://meep.readthedocs.io/en/latest/Mode_Decomposition/).

An isolated evanescent order has zero real normal power in the supported
lossless medium and cannot be normalized to unit real power. Two
counter-decaying waves of the same order can have a nonzero interference flux.
Do not sum their isolated powers to infer net near-field power. The module
retains both complex coefficients, and the tests include this control.

## Complex planar projection

`project_tangential_fields` accepts `(N1,N2,2)` arrays of collocated complex
peak electric and magnetic phasors, in xy component order, on a plane in a
homogeneous half-space. Sample `(i,j)` must correspond to

```text
r_ij = origin + (i/N1) a1 + (j/N2) a2
0 <= i < N1, 0 <= j < N2
```

The repeated cell endpoints are excluded. For each order, the continuous
coefficient is the cell-area average of `F_t exp(-i kt_mn dot r)`. The
implementation first removes the Bloch carrier, then uses a normalized spatial
FFT and corrects the reciprocal-order phase for `origin`. Coefficients refer
to global xy coordinates and to the sampled z plane. Moving the origin while
sampling the same analytical wave therefore preserves the recovered global
coefficient. Translation to a different z reference plane requires the
appropriate `exp(+/-i q delta_z)` factor outside this routine.

With `g=-z_hat cross H_t=(Hy,-Hx)`, project both E and g onto s and p, then
separate the two directions as

```text
a_plus  = (E_pol + g_pol/Y_pol)/2
a_minus = (E_pol - g_pol/Y_pol)/2
```

Both complex E and H are required. An E-only plane cannot separate forward
and backward waves. The function does not interpolate native Yee samples or
correct staggered time samples. These steps must be verified in the producer.
The centered order interval per axis is `[-N//2,(N-1)//2]`; requested aliases
are rejected. This includes only the negative Nyquist representative for even
N. Actual high-order content outside those intervals still aliases into the
data and requires sampling convergence. Grids are limited to 1,048,576 samples.

## Native Fourier convention bridge

The current native periodic runner reads probe spectra through openEMS
`UI_data`, whose installed `DFT_time2freq` uses a **negative temporal Fourier
kernel**, `sum(trace * exp(-i omega t))`, with a single-sided factor of two.
For a real harmonic trace that kernel recovers the `exp(+i omega t)` phasor,
which is the conjugate of this foundation's `exp(-i omega t)` phasor. This is
consistent with the negative propagation phase currently used in
`periodic_cell.py`. The primary openEMS source exposes the same kernel.
[openEMS utilities source](https://github.com/thliebig/openEMS/blob/master/python/openEMS/utilities.py)

Fairbeam's existing [bundle material convention](BUNDLE.md) and
`python/fairbeam/network.py` also use `exp(+i omega t)`. The current
`field_planes.py` documents that convention for native frequency-domain dumps
and records source normalization. Its viewer-facing maps can be resampled,
rounded, and quantized, and are unsuitable as a raw modal-projection input.

An adapter for such real probe time traces must conjugate **both E and H**
together and retain their correctly aligned timestamps, spatial coordinates,
and scaling. A periodic single-frequency spectrum can have peak-amplitude
units; the default pulse spectrum includes a time-integral scaling, so it
cannot be interpreted directly as physical watts without a source and Fourier
normalization contract. A native HDF5 field-export path must be checked
independently. Raw staggered Yee samples need spatial and temporal
collocation; temporal half-step offsets must use their actual timestamps.
Physical propagation direction and the selected real physical `kt` remain the
same when both spatial phasor fields are conjugated into this convention.
Coefficients returned to an existing `exp(+i omega t)` consumer must be
conjugated back consistently, including any reference-plane phase factors.
No automatic adapter or native planar field reader is provided here. Passing
current native complex results directly into this projection is unsupported.

The installed Python utility was inspected on 2026-10-09; its SHA-256 was
`f6dd353f1138a0122cf124d2e967cde3ed4b2df13cc5c68aad3257ce656c028f`.
The deterministic temporal-kernel test proves the conjugation relation without
requiring native bindings or running a solver.

## Fixed phase in a broadband run

At one frequency, an angle supplies
`kt = k sin(theta) (cos(phi),sin(phi))`. Holding the seam phases fixed on a
fixed lattice holds that selected `kt` fixed. Across a band,
`theta(f) = asin(|kt|/k(f))`; some lower frequencies can have evanescent
incidence. A fixed-phase broadband run does **not** represent a fixed angle.
Meep explicitly documents the angle changing with frequency for fixed Bloch
wavevector. A constant-angle broadband method needs a verified transformed
field or other frequency-dependent treatment, which is outside this module.
[Meep arbitrary-angle source FAQ](https://meep.readthedocs.io/en/latest/FAQ/#how-do-i-create-an-arbitrary-angle-planewave-source-in-meep)

## Example and verification contract

```python
import math
from fairbeam.bloch import (
    Lattice2D, diffraction_orders, fixed_kt_angle_rad, transverse_k_from_angles,
)

lattice = Lattice2D((0.006, 0.0), (0.0, 0.006))
kt = transverse_k_from_angles(10e9, math.radians(30), 0.0)
phases = lattice.phase_rad(kt)
modes = diffraction_orders(lattice, kt, 10e9, [(0, 0), (-1, 0), (1, 0)])
angle_at_8ghz = fixed_kt_angle_rad(kt, 8e9)
```

Mode and coefficient records are immutable dataclasses. JSON export must encode
complex values as real/imaginary pairs; the research-plan exporter does so.

The testable hypothesis is that explicit analytical peak plane waves on the
declared uniform cell grid recover their known complex order, polarization,
and direction coefficients to floating-point precision. Controls cover normal
and oblique waves, skew and reversed lattices, both z directions, dielectric
Fresnel power balance and Brewster incidence, total internal reflection,
evanescent decay and pair interference, shifted origins, and grid aliases.
Input geometry and material values are assumed synthetic controls; the
coefficients are independently derived from the 3D Maxwell cross product.
Fixed seeds keep the mixed-amplitude controls reproducible. Phase and field
comparisons use explicit test tolerances at or tighter than `1e-12`.

Run the foundation controls without a native solve:

```bash
cd python
python -m unittest discover -s tests -p test_bloch.py -v
python -m unittest discover -s tests -p test_bloch_reference.py -v
```

These tests establish the mathematical and sampled-projection implementation
under its assumptions. They do not establish native oblique excitation, mesh
convergence, absorbing-boundary quality, multimode S parameters, or agreement
with measured devices.

## Work required before native nonzero phase

The paired-quadrature Yee reference demonstrates seam rotation and the
adjoint derivative pairing in one dimension. Integrating that idea requires
both real and imaginary field storage through native electric and magnetic
updates; the phase must act on both curl seam operands. Scalar excitation must
be extended consistently, and both UPML auxiliary-state channels must follow
their corresponding field quadratures. Complex planar monitors then need the
verified convention, collocation, and normalization bridge described above.
Empty-cell phase, directional power, polarization, decay, and refinement
controls must pass before advertising a new capability. The zero-phase native
handshake cannot be used as evidence for any of those nonzero-phase features.
