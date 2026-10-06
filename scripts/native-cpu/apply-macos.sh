#!/usr/bin/env bash
# Apply the three native CPU patches (phase dispatch, UPML cursor, UPML rows) to the openEMS source
# that scripts/install-openems-macos.sh builds, so that the macOS openEMS pack ships them.
#
#   scripts/native-cpu/apply-macos.sh <openEMS source dir>   # ~/opt/openems-src/openEMS-Project/openEMS
#
# The macOS pack is built from openEMS 12cd91de2 (runtime/pins.json), not from the 08e15ff beta that
# the Windows scripts (apply-*.ps1) target. The cursor and rows patches apply to both unchanged. The
# phase-dispatch patch needs one include-order change for 12cd91de2:
# macos/openems-cpu-phase-dispatch-12cd91de2.patch (the same code and hunks otherwise).
#
# The script refuses any other revision, checks the SHA-256 of every patch before it applies them and
# the SHA-256 of every file it changed afterwards. It is idempotent: on a tree that already carries
# the patches it only verifies them. It never commits. To remove the patches again, from the source
# dir: git checkout -- . && git clean -fd FDTD/extensions
# Nothing is active until a process sets the OPENEMS_EXPERIMENTAL_CPU_* variables (fairbeam does that
# by default on macOS; docs/CPU-OPTIMIZATION.md).
set -euo pipefail

PIN="12cd91de21548987b835ce21f10fd8421d74da78"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-}"
[[ -n "$SRC" && -d "$SRC" ]] || { echo "usage: $0 <openEMS source dir>" >&2; exit 2; }
SRC="$(cd "$SRC" && pwd)"

# patch file and its SHA-256, in the order they are applied
PATCHES=(
  "$HERE/macos/openems-cpu-phase-dispatch-12cd91de2.patch 905bc8b729e46f260f16fd02620d9f5f507fd7a6b430590b05553f924636b7bf"
  "$HERE/openems-cpu-upml-cursor.patch 44f8230d5b7ef4e3ac4c87ebacbe26393032059834853668d92e444026372b7e"
  "$HERE/openems-cpu-upml-rows.patch f7fc923aea49bffdd2241da62a3c515cfd3c6eb90ade06e2b29878318404655a"
)
# the files the patches create or change, and their SHA-256 once all three are applied
RESULT=(
  "FDTD/engine_multithread.cpp 6d50278077e9319b6945f717d6ce662c800d94c6c9f614105b5fc2bd8a91dde1"
  "FDTD/engine_multithread.h eb60fe5e3804fe145ea4b379e6e3ff1c6dfc00fcfb9f606ad51e9c9dad8555b8"
  "FDTD/extensions/engine_extension_phase_dispatch.h 4c4cd3f9ae9097a13f1d23001f3c44166d9e3202e2282cbe91e8b99620b27a0e"
  "FDTD/extensions/engine_ext_upml.cpp cdee31cbf134507b84ffbb9db7b00b43d1f68637705f24d2c0bca6087a9b208f"
  "FDTD/extensions/engine_ext_upml.h 7cf1edca07b130e44264a6a7149661a28ce8fd6d2db7626c2fa2f8530f3fb861"
  "FDTD/extensions/engine_ext_upml_sse_cursor.h 9c3bc2af156fdff0704fc2ba83b42d79343af971321c155417aa6b9bdb9fc954"
  "FDTD/extensions/engine_ext_upml_sse_rows.h 07c8b8dd039ed093037c34929b816f65d2f2cb3e2ee1c5b51bc1d0223216e3ed"
)

die() { printf 'native-cpu: %s\n' "$*" >&2; exit 1; }
sha() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
src_git() { git -C "$SRC" "$@"; }

verify_result() {
  local entry f want
  for entry in "${RESULT[@]}"; do
    f="${entry%% *}"; want="${entry##* }"
    [[ -f "$SRC/$f" && "$(sha "$SRC/$f")" == "$want" ]] || return 1
  done
}

head="$(src_git rev-parse HEAD 2>/dev/null)" || die "$SRC is not a git checkout"
if [[ "$head" != "$PIN" ]]; then
  if [[ "${NATIVE_CPU_CHECKOUT:-0}" == "1" && -z "$(src_git status --porcelain)" ]]; then
    echo "native-cpu: openEMS is at $head; checking out the pinned revision $PIN"
    src_git fetch -q --depth 1 origin "$PIN" && src_git checkout -q --detach "$PIN" || die "could not check out $PIN"
  else
    die "openEMS is at $head, the pinned revision is $PIN. Check it out first: git -C '$SRC' fetch --depth 1 origin $PIN && git -C '$SRC' checkout --detach $PIN (the installer does this with NATIVE_CPU_CHECKOUT=1 on a clean tree)"
  fi
fi

if verify_result; then
  echo "native-cpu: patches already applied to $SRC (all file hashes match)"
  exit 0
fi
[[ -z "$(src_git status --porcelain)" ]] || die "the source tree has other changes; use a clean checkout of $PIN. Nothing was changed."

for entry in "${PATCHES[@]}"; do
  p="${entry%% *}"; want="${entry##* }"
  [[ -f "$p" ]] || die "patch file is missing: $p"
  [[ "$(sha "$p")" == "$want" ]] || die "$(basename "$p") has an unexpected SHA-256; refusing to apply. Nothing was changed."
done

# the tree is clean (checked above), so a failure part-way can be undone completely
undo() { src_git checkout -q -- . && src_git clean -fdq -- FDTD/extensions; }
for entry in "${PATCHES[@]}"; do
  p="${entry%% *}"
  if ! src_git apply "$p"; then
    undo
    die "$(basename "$p") does not apply to $PIN; the tree was restored. Nothing was changed."
  fi
done
if ! verify_result; then
  undo
  die "the patched files do not match the validated hashes; the tree was restored. Nothing was changed."
fi
echo "native-cpu: applied 3 patches to openEMS $PIN in $SRC (not committed)"
