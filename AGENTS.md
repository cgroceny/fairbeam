# Notes for coding agents

This file is for any coding agent (Codex, Claude Code or others) and for people new to the
repository. GitHub issues labelled `windows` or `mac` are the work queue for that platform. Each
issue is meant to be self-contained: follow its steps and report back in a comment on the issue.

## Layout
- `src/`: the SolidJS app. It is both the viewer and the designer.
- `src-tauri/`: the desktop shell, in Rust (Tauri 2).
- `python/fairbeam/`: the run server (`fairbeam serve`), the design schema and checks, and the
  openEMS build.
- Docs are in `docs/`. The ones to read first are DESIGNER.md, RUN-SERVER.md, RELEASES.md and
  WINDOWS.md.

## Before opening a PR
Run these checks:
```
npx tsc --noEmit
npm run check:designer
npm run check:exports
npm run check:legal                                       # CST wording and the trademark rules
npm run check:no-antenlab                                 # the old name appears only where it is allowed
cd python && python -m unittest discover -s tests -q      # the venv that has openEMS
npm run check:scenarios -- --skip-run                     # browser scenarios; needs Chrome
```
- Follow [AI_POLICY.md](AI_POLICY.md): name the model in a `Co-Authored-By:` trailer, report what
  you ran and saw, and never present a model's statement as a measured result.
- A design-format change must stay in step between Python (`design.py`, `design_checks.py`) and TS
  (`src/designer/checks.ts`, and so on). `python/tests/fixtures/designer_parity.json` is the shared
  fixture.
- Every UI string needs an entry in both `src/i18n/en.json` and `src/i18n/tr.json`. Numbers in
  inputs and exported files always use a decimal point.
- Write the UI and the docs in US English. The terms are Component, Solid and Discrete port; in
  Turkish they are Bileşen, Katı and Ayrık port. See `docs/i18n-glossary.md`.

## Rules
- **Name:** the product is called Fairbeam. Write "Fairbeam" in code, UI text and docs. The old name
  (the product's previous name) appears only in the files that read or explain old formats, and in
  the importer. The allowlist, with a reason per entry, is in `scripts/check-no-antenlab.mjs`, and the
  check fails on any other hit. Do not add entries
  to it to make a check pass: rename or remove the text instead. In Turkish strings the suffixes are
  written by hand (Fairbeam'i, Fairbeam'e). The CST rules are in `scripts/check-legal.mjs`.
- **Branches:** `windows/<topic>` or `mac/<topic>`, and a PR to `main`. Don't push to `main`
  directly, and don't merge your own PR; the maintainer reviews it.
- **Updater key:** `~/.tauri/fairbeam-updater.key` goes only into the build shell's environment.
  Never print, log or commit it, or any other key.
- **Releases:** build them only from a tag on `main`, and publish with
  `scripts/publish-release.mjs` (see docs/RELEASES.md). The Mac side updates `landing/` (the
  website).
- **Machine load:** run simulations one at a time and prefer coarse runs for smoke tests. Stop only
  processes you started, by their PID.
- **Local files:** don't commit `python/models/deneme.design.json` or other personal files in
  `python/models/`.
- **Windows worktree cleanup:** check for directory junctions and other reparse points before
  removing a checkout. Shared `node_modules` and Cargo `target` directories may be reached
  through junctions. Never recursively remove such a checkout while those junctions remain;
  unlink only the verified checkout-owned junction itself first, preserving its target.
