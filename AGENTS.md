# Notes for coding agents

This file is for any coding agent and for people new to the repository. The pull-request process is
in [CONTRIBUTING.md](CONTRIBUTING.md); the rules for AI-assisted contributions are in
[AI_POLICY.md](AI_POLICY.md).

## Layout
- `src/`: the SolidJS app. It is both the viewer and the designer.
- `src-tauri/`: the desktop shell, in Rust (Tauri 2).
- `python/fairbeam/`: the run server (`fairbeam serve`), the design schema and checks, and the
  openEMS build.
- `scripts/`: the repository checks (`check-*.mjs`) and the build and release scripts.
- Docs are in `docs/`, indexed in [docs/README.md](docs/README.md). The ones to read first are
  FROM-SOURCE.md, DESIGNER.md, RUN-SERVER.md and WINDOWS.md.

## Before opening a PR
Run these checks:
```
npm run typecheck
npm run check:designer
npm run check:exports
npm run check:legal                                       # CST wording and the trademark rules
cd python && python -m unittest discover -s tests -q      # the venv that has openEMS
npm run check:scenarios -- --skip-run                     # browser scenarios; needs Chrome
```
Then run the `npm run check:*` scripts that cover the files you changed (see `package.json`). The
CI workflow (`.github/workflows/ci.yml`) runs a wider set.

## Rules
- **AI policy:** follow [AI_POLICY.md](AI_POLICY.md). Name the model in a `Co-Authored-By:` trailer,
  report what you ran and saw, and never present a model's statement as a measured result.
- **Design format:** a design-format change must stay in step between Python (`design.py`,
  `design_checks.py`) and TS (`src/designer/checks.ts`, and so on).
  `python/tests/fixtures/designer_parity.json` is the shared fixture.
- **UI texts:** every UI string needs an entry in both `src/i18n/en.json` and `src/i18n/tr.json`.
  Numbers in inputs and exported files always use a decimal point.
- **Language:** write the UI and the docs in US English. The terms are Component, Solid and Discrete
  port; in Turkish they are Bileşen, Katı and Ayrık port. See `docs/i18n-glossary.md`.
- **Name:** the product is called Fairbeam. Write "Fairbeam" in code, UI text and docs. In Turkish
  strings the suffixes are written by hand (Fairbeam'i, Fairbeam'e).
- **CST wording:** Fairbeam names CST only for file compatibility (CST-compatible VBA macros), and
  never compares itself with proprietary simulators. `npm run check:legal` enforces the rules in
  `scripts/check-legal.mjs`. When it fails, rephrase the text instead of working around the check.
- **Branches:** work on a topic branch and open a PR to `main`. Don't push to `main` directly; the
  maintainer reviews and merges.
- **Secrets:** never print, log or commit a key or token, such as the updater signing key
  ([docs/RELEASES.md](docs/RELEASES.md)).
- **Releases:** build them only from a tag on `main`, and publish with
  `scripts/publish-release.mjs` (see [docs/RELEASES.md](docs/RELEASES.md)).
- **Simulations:** run them one at a time and prefer coarse runs for smoke tests.
- **Local files:** don't commit personal files in `python/models/`.
