# Fairbeam

**The open electromagnetic workbench.** *(formerly antenlab)*

Fairbeam designs, simulates and documents antennas on the open-source openEMS FDTD solver, from parametric Python models to a ribbon-based 3D designer. It is built with the FAIR principles in mind: results are **findable** and self-describing (versioned project bundles that record the generator, version and run settings), **accessible** in open formats with no licence server, **interoperable** (Touchstone, CSV, STL, CST-compatible VBA macros, Gerber/Excellon, Blender), and **reusable** (GPL-3.0 parametric models and recorded inputs).

Fairbeam is an antenna simulation workbench built around [openEMS](https://openems.de), the open-source FDTD solver. Antennas are described as small parametric Python models. The `fairbeam` CLI runs openEMS on them and post-processes S11, input impedance, matched bands and the far field (directivity, efficiency, gain, realized gain). Each run is written to a self-contained JSON project bundle. A browser-based viewer (SolidJS + three.js) loads these bundles and shows the exact 3D geometry, mesh and radiation pattern, with charts, a table view for every chart, and a full spec sheet. It can also export the model as a CST-compatible VBA macro.

## Status

Development preview. The Python pipeline and the viewer work end to end on macOS (Apple silicon) and on Windows 11. The Gerber/Excellon fabrication output has not yet been checked in a Gerber viewer or by a fab. The desktop app is released for macOS (Apple silicon) and Windows x64 (0.7.0 is the first release of Fairbeam); the macOS build is signed and notarized, the Windows installer is not signed yet. The bundle schema is versioned (`fairbeam.project/1`); breaking changes will bump the version.

## Quick start

**Trying the desktop app?** Follow [Getting started](docs/GETTING-STARTED.md): install on macOS or
Windows, then design, simulate and read a patch antenna in five minutes.

From source, requirements: macOS with Homebrew, Xcode command line tools, Python 3.10+ (the python.org build is recommended) and Node.js 20+.

```bash
# 1. Build openEMS + CSXCAD from source into ~/opt/openEMS and install fairbeam into its venv
#    (about 5-10 minutes; the VTK step heats the CPU)
scripts/install-openems-macos.sh

# 2. Run a model. This writes public/projects/<slug>.json and updates public/projects/index.json
~/opt/openEMS/venv/bin/fairbeam run python/models/patch_antenna.py

# 3. Open the viewer on http://127.0.0.1:5310, with the run server for the Run panel
npm install
npm run serve &      # optional: fairbeam serve on port 5320 (Run panel, sweeps, optimizer, editor)
npm run dev

# or as a native window: npm run desktop (development), or npm run desktop:build and open the app (docs/DESKTOP.md)
```

Details, install options and the test suite: [docs/FROM-SOURCE.md](docs/FROM-SOURCE.md).

## Features

- **Designer**: a visual workspace to draw a parametric model, set up the simulation, run it and read the results in one place ([designer guide](docs/DESIGNER.md)).
- **Parametric models**: one Python file per antenna or circuit, with templates and automatic meshing ([writing models](docs/MODELS.md), [meshing](docs/MESHING.md)).
- **CLI**: `run`, `sweep`, `converge`, `optimize`, `touchstone`, `serve` and more ([CLI reference](docs/CLI.md)).
- **Viewer**: exact 3D primitives, mesh plane, far-field pattern and surface currents, |S11|, impedance, Smith and polar charts, each with a table ([design](docs/DESIGN.md)).
- **Run server and Run panel**: parameter form with live geometry preview, job queue with live convergence, sweeps, comparison overlays, a goal-driven optimizer and an in-app model editor ([run server](docs/RUN-SERVER.md), [optimizer](docs/OPTIMIZE.md), [studies](docs/STUDIES.md)).
- **Multi-port structures and arrays**: full S-matrices, embedded element patterns and beam steering ([multi-port](docs/MULTIPORT.md), [arrays](docs/ARRAYS.md)).
- **3D antennas**: slanted solids (polyhedra), thin wires, rectangular waveguide ports and circular-polarisation outputs, shown on a pyramidal horn and an axial-mode helix ([included models](docs/MODELS.md#included-models)).
- **Exports**: B&W technical drawings and publication figures, PDF report, export package, fabrication files (Gerber X2, Excellon, DXF; preview) ([exports](docs/EXPORTS.md)).
- **VBA macros**: CST-compatible VBA macro export (`.bas`) and macro import (`.bas`, `.mcs`, `.txt`) ([exports](docs/EXPORTS.md), [designer guide](docs/DESIGNER.md#importing-a-vba-macro)).
- **GPU engine** (optional): the openEMS GPU build, Metal on Apple silicon and CUDA on Windows with a supported NVIDIA card, several times faster with identical results. It is installed separately from the managed runtime ([GPU engine](docs/GPU.md)).
- **Validation**: analytical results ([validation](docs/VALIDATION.md), [how results are computed](docs/RESULTS.md)).
- **Public demo**: a read-only build of the viewer with the example projects ([deploy](docs/DEPLOY.md)).

All guides are listed in [docs/README.md](docs/README.md). Roadmap: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#roadmap).

## License

Fairbeam is licensed under GPL-3.0-or-later (`LICENSE`). openEMS is GPL-3.0-or-later; CSXCAD and fparser are LGPL-3.0-or-later. The released installers come with a written offer of the complete corresponding source; see `NOTICE.md`. The bundle JSON files are plain data produced by your own models.

## Trademarks

CST and CST Studio Suite are trademarks or registered trademarks of Dassault Systèmes or its subsidiaries. Fairbeam is an independent open-source project and is not affiliated with, sponsored by or endorsed by Dassault Systèmes.
