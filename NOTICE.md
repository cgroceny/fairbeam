# Fairbeam: license and source

Fairbeam (formerly antenlab) is free software under the **GNU General Public License, version 3 or later**
(GPL-3.0-or-later); the full text is in `LICENSE`. It comes with no warranty.

## Source code (written offer)

The Fairbeam installers and the files the app downloads are published at
<https://github.com/ismailakdag/fairbeam-releases>. For at least three years after the release of
any version, the maintainer provides the **complete corresponding source code** of that version to
anyone who asks. This covers Fairbeam itself: the viewer, the Python package, the desktop shell and
the build scripts. To request it, open an issue at
<https://github.com/ismailakdag/fairbeam-releases/issues> and name the version. The source of every
version is public: it is the tag `v<version>` of <https://github.com/ismailakdag/fairbeam>. The
source is provided at no charge beyond the cost of delivery, if any.

## Third-party software

- **openEMS** (GPL-3.0-or-later), **CSXCAD** and **fparser** (LGPL-3.0-or-later). The app does not
  contain them; it downloads them on first start:
  - Windows CPU: the official build from <https://github.com/thliebig/openEMS-Project/releases>.
  - Optional Windows GPU: the CUDA build from
    <https://github.com/SeanMollet/openEMS/releases/tag/v0.37.0-beta1%2Bgpu>, with corresponding
    source at that tag. Its archive includes its third-party libraries and license information.
  - macOS: the pack from fairbeam-releases. The pack carries its own `NOTICE.md`, the license
    texts and the source locations of every component in it.
- **Python** and the Python packages NumPy, h5py and matplotlib (with their dependencies). They
  are downloaded on first start from python-build-standalone and PyPI, under their own licenses.
- **uv** (MIT / Apache-2.0), downloaded on first start.
- Bundled with the app, under their own permissive licenses (MIT, ISC, Apache-2.0):
  - desktop shell: Tauri, WebView2 (Windows) and the Rust crates in `src-tauri/Cargo.lock`;
  - viewer: three.js, SolidJS, lucide, jsPDF, CodeMirror and the other npm packages in
    `package-lock.json`;
  - fonts: IBM Plex (SIL OFL 1.1).

## Trademarks

CST and CST Studio Suite are trademarks or registered trademarks of Dassault Systèmes or its subsidiaries. Fairbeam is an independent open-source project and is not affiliated with, sponsored by or endorsed by Dassault Systèmes.
