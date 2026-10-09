# Preparing Floquet channels and FEM meshes

These developer commands build the next solver foundations without changing the working zero-phase periodic backend. They produce plans or mesh inputs, not RF simulation results. They do not install software, start a solver or add a new production Run mode.

Run them from the source checkout with the configured Fairbeam Python environment. Installing the Python package also creates the `fairbeam-research-plan` command.

## Fixed-wavevector Floquet plan

```powershell
python -m fairbeam.research_plan floquet --period-x-mm 6 --period-y-mm 6 --reference-frequency-ghz 10 --theta-deg 30 --phi-deg 0 --frequencies-ghz 4 8 10 --order-radius 1 --out research/floquet-plan
```

The requested angle is defined at the reference frequency. The transverse wavevector and cell-to-cell phase are then held fixed over the requested frequencies. `plan.json` reports the actual angle at each propagating frequency, and explicitly marks evanescent or cutoff incidence. In this example, the fundamental is evanescent at 4 GHz, about 38.68 degrees at 8 GHz, and 30 degrees at 10 GHz. It is not a constant-angle broadband excitation.

The order radius selects a finite square of integer diffraction orders. It is not an automatic enumeration of every propagating channel. Complex longitudinal wavevectors are exported as real/imaginary pairs. Plans are restricted to vacuum and positive frequencies; the underlying mathematical module supports positive lossless isotropic half-space parameters.

See [Bloch foundations](BLOCH-FOUNDATION.md) for TE/TM bases, modal power, spatial DFT projection, cutoff behavior, and the phasor-convention bridge required before using existing openEMS field data. The paired real/imaginary seam stencil in `python/fairbeam/bloch_reference.py` is a tested numerical reference, not a native time-domain engine.

## Native Elmer mesh preparation

The vacuum control is a 100 × 50 × 200 mm box with a maximum cell edge of 25 mm:

```powershell
python -m fairbeam.research_plan fem-mesh --domain-mm 0 0 0 100 50 200 --max-cell-mm 25 --out research/cavity-mesh
```

To evaluate the supported subset of a Design:

```powershell
python -m fairbeam.research_plan fem-mesh --design my-cell.design.json --domain-mm -10 -10 0 10 10 20 --max-cell-mm 2 --out research/design-mesh
```

The output contains Elmer's serial ASCII mesh files, material/body IDs, exterior-face tags and PEC-interface tags. Coordinates are converted from Design millimeters into meters. Box faces become mesh planes; neighboring elements share nodes. PEC volumes are excluded from the volume mesh and their active-side faces are tagged. Unsupported geometry, physical features and ambiguous overlaps are rejected.

See [FEM geometry preparation](FEM-GEOMETRY.md) for exact limits and metadata. This exporter does not create a general Maxwell solver configuration. Ports, material equations, open-space boundaries, field outputs and S-parameter normalization need a separately validated adapter. Exported exterior faces have geometric labels; they do not automatically become PEC walls or radiation boundaries.

## Reproducibility and checks

Use a fresh output directory each time. Existing outputs are refused. Floquet preparations retain `manifest.json`, `plan.json`, source snapshots and hashes. FEM preparations retain `preparation.json`, `mesh.metadata.json`, source snapshots and hashes of the mesh files. Both explicitly record `solver_executed: false`.

```powershell
python -m unittest discover -s python/tests -p "test_bloch*.py" -v
python -m unittest discover -s python/tests -p test_fem_geometry.py -v
python -m unittest discover -s python/tests -p test_research_plan.py -v
```

The current [application integration](RESEARCH-SOLVERS.md) remains bounded to zero-phase periodic CPU experiments and the fixed Elmer cavity. Enabling native Bloch runs still requires paired field/excitation/PML state, phase-correct seam operands, real native regression controls and a new capability contract. A mathematical unit test is not evidence that this native work has already been completed.

The next isolated controls are the [compiled 3D Bloch kernel](../scripts/experimental-periodic/native-bloch/README.md)
and [native dielectric cavity qualification](FEM-QUALIFICATION.md). These exercise the
paired update algebra and FEM material mapping without changing the production Run path.
