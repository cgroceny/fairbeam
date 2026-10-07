# Release license inventory

Run `npm run licenses` after installing the exact npm lockfile. Regeneration uses Node, Vite,
Cargo, Python 3.10 or newer, and curl. It builds the viewer in memory, follows Cargo's normal
(default-feature) dependency graph for macOS arm64 and Windows x64, and reads pinned registry and
runtime archives without installing or executing downloaded code. No new npm packages are needed.
Optional Rust features require extending the inventory before distributing a build with them.

`inventory.json` preserves the metadata and full original license/NOTICE texts. The root
`THIRD-PARTY-NOTICES.md` is generated from this snapshot. `npm run check:licenses` is offline:
it verifies input fingerprints, rejects unreviewed missing licenses or texts, and compares the
entire generated output. Rendering normalizes line endings and trailing whitespace; the snapshot
retains the original text. CI runs the same check. Run `node scripts/third-party-licenses.mjs` to
render an unchanged snapshot without downloading metadata again.

Downloads are cached by URL and verified against available Cargo checksums, npm integrity values,
PyPI hashes, and runtime pins. Set `FAIRBEAM_LICENSE_CACHE` to choose the scratch cache directory;
set `CARGO_HOME` to isolate Cargo's registry cache. Clear the download cache to refresh mutable
upstream license-reference URLs. Exact versioned registry packages and runtime pins are authoritative
for those distributions. Cargo workspace-root licenses omitted from crate archives are retrieved
at their recorded source commits. `crate-sources.json` supplies one reviewed missing repository URL.

`solver-components.json` maps native binaries to upstream license references. An unfamiliar
DLL or executable fails regeneration until reviewed. Windows pack PE FileVersion values are
recorded when available; they are not substitutes for upstream source revisions. Static and header
dependencies declared by the solver's build manifests are also listed. The macOS pack's component
table and license texts are preserved, together with VTK's vendored source notices.

The upstream Windows packs omit most native copyright notices and precise dependency provenance.
Their entries explicitly distinguish upstream license references from confirmed binary terms.
The macOS pack also omits its CGAL header version. Resolve these provenance questions and retain
matching source and notices before publishing affected binaries. `exceptions.json` records exact
component/version exceptions for SZIP and separately licensed Microsoft runtimes. It is a review
record, not a conclusion about legal compatibility or permission to redistribute an unknown binary.

Python standalone builds are derived from the pinned uv release's download metadata. The installer
can reuse a managed Python installation matching the requested minor version. Preserve its actual
runtime manifest when investigating an installed copy. WebView2 Evergreen updates separately and
is covered in its own Microsoft section.

The publishing script requires the package version to match the release version, checks the
inventory before publishing, and uploads the generated notices and their checksum with the release.
Source offers and the release checklist remain in `NOTICE.md` and `docs/RELEASES.md`.
