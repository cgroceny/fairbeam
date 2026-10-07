# Fairbeam: license and source

Fairbeam is free software under the **GNU General Public License, version 3 or later**
(GPL-3.0-or-later); the full text is in `LICENSE`. It comes with no warranty.

## Source code (written offer)

The Fairbeam installers and the files the app downloads are published at
<https://github.com/ismailakdag/fairbeam-releases>. For at least three years after release, and any
longer period required by the applicable license, the maintainer provides the **complete
corresponding source code** of that version to
anyone who asks. This covers Fairbeam itself: the viewer, the Python package, the desktop shell and
the build scripts. To request it, open an issue at
<https://github.com/ismailakdag/fairbeam-releases/issues> and name the version. Fairbeam 0.7.0 source is published at
<https://github.com/ismailakdag/fairbeam/tree/v0.7.0>. The
source is provided at no charge beyond the cost of delivery, if any.

## Third-party software

- **openEMS** (GPL-3.0-or-later), **CSXCAD** and **fparser** (LGPL-3.0-or-later). The app does not
  contain them; it downloads them on first start:
  - Windows CPU: the official build from <https://github.com/thliebig/openEMS-Project/releases>.
  - Optional Windows GPU: the CUDA build from
    <https://github.com/SeanMollet/openEMS/releases/tag/v0.37.0-beta1%2Bgpu>, with corresponding
    source at that tag. Its archive includes its third-party libraries and license information.
  - macOS: the pack from fairbeam-releases. The pack carries its own `NOTICE.md`, the license
    texts and component source locations.
- **Python** and the Python packages NumPy, h5py and matplotlib (with their dependencies). They
  are downloaded on first start from python-build-standalone and PyPI, under their own licenses.
- **uv** (MIT / Apache-2.0), downloaded on first start.
- Bundled open-source libraries, under their respective licenses (versions are recorded in the lockfiles):
  - desktop shell: Tauri and the Rust crates in `src-tauri/Cargo.lock`;
  - viewer: three.js, SolidJS, lucide, jsPDF, CodeMirror and the other npm packages in
    `package-lock.json`;
  - fonts: IBM Plex (SIL OFL 1.1).

- **Microsoft WebView2 (Windows)** is separate from the open-source shell libraries. The installer
  includes its bootstrapper; Microsoft runtime and redistribution terms apply.

Runtime components and their licenses and sources are listed in the runtime pack’s `NOTICE.md` and
[`runtime/pins.json`](runtime/pins.json). This overview is not a complete binary license inventory.

## Trademarks

CST and CST Studio Suite are trademarks or registered trademarks of Dassault Systèmes or its subsidiaries. Fairbeam is an independent open-source project and is not affiliated with, sponsored by or endorsed by Dassault Systèmes.
