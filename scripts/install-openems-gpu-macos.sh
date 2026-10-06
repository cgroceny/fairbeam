#!/usr/bin/env bash
# Optional: build the Metal GPU engine fork of openEMS (SeanMollet/openEMS, GPL-3.0) side by side
# with the regular install, in its own prefix and venv. Nothing in the regular install is changed.
#
# Prerequisite: scripts/install-openems-macos.sh has run (it provides CSXCAD, fparser, TinyXML and
# the minimal VTK in $BASE, which this build links against). macOS 15+ on Apple silicon.
# Metal shaders are compiled at runtime, so the Command Line Tools are enough (no full Xcode).
#
# Usage:  scripts/install-openems-gpu-macos.sh
#         ~/opt/openEMS-gpu/venv/bin/fairbeam run python/models/patch_antenna.py --engine gpu
#
# Measured on an Apple M5 Pro: patch antenna (97 k cells) 8.0 s -> 0.72 s, Sierpinski monopole
# (2 M cells) 12 s -> 2.7 s (2650 MCells/s), identical S-parameters and far field.

set -euo pipefail

BASE="${BASE:-$HOME/opt/openEMS}"            # regular install (CSXCAD etc.)
PREFIX="${PREFIX:-$HOME/opt/openEMS-gpu}"    # GPU build
SRC="${SRC:-$HOME/opt/openems-gpu-src}"
TAG="${TAG:-v0.37.0-beta1+gpu}"
JOBS="${JOBS:-$(( $(sysctl -n hw.ncpu) / 2 ))}"
PY="${PYTHON:-python3}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

step() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || die "Apple silicon macOS required"
[[ -f "$BASE/lib/libCSXCAD.dylib" ]] || die "no CSXCAD in $BASE; run scripts/install-openems-macos.sh first"
[[ -z "${VIRTUAL_ENV:-}" ]] || die "deactivate the active virtualenv first"

step "Fetching $TAG"
mkdir -p "$SRC"
if [[ ! -d "$SRC/openEMS" ]]; then
  git clone --depth 1 --branch "$TAG" https://github.com/SeanMollet/openEMS.git "$SRC/openEMS"
fi

step "Building openEMS with the Metal backend into $PREFIX ($JOBS jobs)"
mkdir -p "$SRC/build" && cd "$SRC/build"
cmake ../openEMS -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  "-DCMAKE_PREFIX_PATH=$BASE;$(brew --prefix)" -DTinyXML_ROOT_DIR="$BASE" \
  -DVTK_DIR="$BASE/lib/cmake/vtk-9.7" -DFPARSER_ROOT_DIR="$BASE" -DCSXCAD_ROOT_DIR="$BASE" \
  -DENABLE_METAL=ON > cfg.log
grep -q "Metal GPU backend enabled" cfg.log || die "Metal backend not enabled (see $SRC/build/cfg.log)"
cmake --build . -j "$JOBS"
cmake --install . > /dev/null
"$PREFIX/bin/openEMS" --help | grep -q "gpu:" || die "built binary has no gpu engine"

step "Python venv with CSXCAD (regular) + openEMS (GPU fork) bindings"
[[ -x "$PREFIX/venv/bin/python" ]] || "$PY" -m venv "$PREFIX/venv"
V="$PREFIX/venv/bin"
"$V/pip" install -q --upgrade pip
"$V/pip" install -q numpy h5py cython setuptools setuptools_scm
( cd "$BASE/../openems-src/openEMS-Project/CSXCAD/python" 2>/dev/null \
  || die "CSXCAD sources not found next to $BASE (expected ../openems-src/openEMS-Project)"
  CSXCAD_INSTALL_PATH="$BASE" ARCHFLAGS="-arch arm64" "$V/pip" install -q --no-build-isolation . )
# Library search order matters: the GPU libopenEMS must come first, otherwise the extension links
# against the regular (CPU-only) libopenEMS in $BASE and silently ignores engine='gpu'.
( cd "$SRC/openEMS/python" && rm -rf build
  ARCHFLAGS="-arch arm64" CPPFLAGS="-I$PREFIX/include -I$BASE/include" \
  LDFLAGS="-L$PREFIX/lib -L$BASE/lib -Wl,-rpath,$PREFIX/lib -Wl,-rpath,$BASE/lib" \
  OPENEMS_INSTALL_PATH="$PREFIX" CSXCAD_INSTALL_PATH="$BASE" \
  "$V/pip" install -q --force-reinstall --no-deps --no-build-isolation . )
SO="$(ls "$PREFIX"/venv/lib/python3*/site-packages/openEMS/openEMS*.so | head -1)"
otool -L "$SO" | grep -q "$PREFIX/lib/libopenEMS" || die "python extension is not linked against the GPU libopenEMS"
"$V/pip" install -q -e "$REPO/python"

step "Check"
( cd / && "$V/python" -c "import openEMS, fairbeam; print('openEMS', openEMS.__version__, '| fairbeam', fairbeam.__version__)" )
printf '\nDone. Run with:  %s/fairbeam run python/models/patch_antenna.py --engine gpu\n' "$V"
