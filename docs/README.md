# Fairbeam documentation

**New to Fairbeam? Start with [Getting started](GETTING-STARTED.md)**: install the desktop app and
design, run and read a patch antenna. The repository [README](../README.md) is the
short overview. To contribute, read [CONTRIBUTING.md](../CONTRIBUTING.md) and the
[AI policy](../AI_POLICY.md).

The user guides and the reference are also published at https://fairbeam.org/docs/ (the list is
`landing/docs.json`; the pages are built from these files). Turkish editions are published at
https://fairbeam.org/docs/tr/ from `docs/tr/<source basename>.md`, including sources outside
`docs/`. Keep the heading order and levels, code blocks, commands and numeric values in step with
the English source. Relative links use the English source location; the site preserves its heading
IDs so links and language switching keep the same section. Page and group titles use `titleTr` in
`landing/docs.json`; shared site strings remain in `landing/language.js`.

Run `npm run check:docs-translations` and `npm run check:links` after editing translations. The
build also rejects changed code examples or heading structure. Missing translations render the
English body with a Turkish note; the completeness check requires every published page to be
translated. To check a locally served site in Chrome, run `npm run check:docs-language` with
`FAIRBEAM_DOCS_URL` pointing to it; `FAIRBEAM_SCREENSHOT_DIR` optionally saves the screenshots.

## Using Fairbeam

| Guide | What it covers |
| --- | --- |
| [Getting started](GETTING-STARTED.md) | Installing the desktop app (macOS signed with a Developer ID and notarized by Apple, Windows), a walkthrough from the patch starter to results, the other starters, mesh convergence, field planes, sweeps and the optimizer, importing a VBA macro, where files live, reporting a problem |
| [Running from source](FROM-SOURCE.md) | Requirements, building openEMS and installing Fairbeam from the repository, first run, the test suite, platform notes |
| [The designer](DESIGNER.md) | The visual workspace: start screen and starters, the one-row ribbon (Home, Modeling, Transform, Simulation, Optimize, Post-processing), navigation tree and components, modeling, checks, simulation settings, mesh view and mesh convergence, running and results (efficiency, gain patterns, field planes), design files, VBA macro import, known limitations, feedback |
| [Example designs](../examples/designs/README.md) | Six 867 MHz antennas as designer files (blade, wideband, meander and sleeve dipoles, collinear, Yagi), with parameters, results and how to scale them |
| [CLI reference](CLI.md) | Every `fairbeam` command and the options of `run` |
| [Writing models](MODELS.md) | Model files (`MODEL`, `PARAMS`, `build`), an example, templates and the in-app editor |
| [Automatic meshing](MESHING.md) | `sim.auto_mesh()`: options, rules, report, validation against hand meshes |
| [Run server and Run panel](RUN-SERVER.md) | `fairbeam serve`, the Run panel, sweeps, comparison overlays, the optimizer in the UI |
| [Optimizer](OPTIMIZE.md) | Goals, driven ports, algorithms, output and simulated examples |
| [Studies](STUDIES.md) | `sweep`, `converge`, `touchstone` and the study file format |
| [Multi-port structures and arrays](MULTIPORT.md) | One run per driven port, S-matrices, the S-parameters and Array tabs |
| [Arrays](ARRAYS.md) | Embedded element patterns, normalization, beam steering, the 2×1 and 4×1 arrays |
| [Drawings, figures, package, fabrication](EXPORTS.md) | Technical drawings, publication figures, the export package, the PDF report, Gerber/Excellon/DXF |
| [GPU engine](GPU.md) | The optional GPU build of openEMS (Metal on Apple silicon, CUDA on Windows) and measured timings |
| [Desktop app](DESKTOP.md) | The Tauri app: managed runtime (uv, CPython, openEMS), workspace, shell, packaging |
| [Releases and updates](RELEASES.md) | Public release repository, updater key, publishing installers (macOS signing and notarization) and the macOS openEMS pack, what each version added |
| [Fairbeam on Windows](WINDOWS.md) | Running simulations locally on Windows 10/11: openEMS, the Python package, the run server and the viewer |

## Background and reference

| Document | What it covers |
| --- | --- |
| [How results are computed](RESULTS.md) | Excitation, end criterion, S11/Zin, bands, far field, efficiency, gain; accuracy notes |
| [Validation](VALIDATION.md) | Comparison with closed-form theory; mesh convergence; recommended settings |
| [Experimental periodic CPU study](../scripts/experimental-periodic/README.md) | Opt-in native source patch and reproducible zero-phase unit-cell research gates; not production Floquet support |
| [Lumped resistor in openEMS](openems-lumped-resistor.md) | How the lumped resistor behaves, and why the Wilkinson residual is not a resistor error |
| [Bundle schema](BUNDLE.md) | `fairbeam.project/1`, field by field |
| [Architecture](ARCHITECTURE.md) | Data flow, run server, project layout, roadmap |
| [Design](DESIGN.md) | Visual design rules, tokens, layout primitives, keyboard map |
| [Turkish UI glossary](i18n-glossary.md) | The Turkish/English terms of the interface and the alternatives considered for each term |
| [Usage statistics](TELEMETRY.md) | Opt-in weekly install counts, download totals and the privacy notice. Asked once on first start in release builds |
| [Optional sign-in](ACCOUNTS.md) | GitHub and Google sign-in for the desktop app: the build switches, the flow, what is stored. Built but switched off |
| [Deploy](DEPLOY.md) | The public site (landing page and demo) on Vercel |
| [Benchmarks](BENCHMARKS.md) | The historical benchmark set of 14 examples on reference machines (Windows and macOS): results and solver times |
| [Designer state and viewport checks](DESIGNER-STATE-LIFECYCLE.md) | The designer async-state tests and the viewport lifecycle checks, and how to run them |
