#!/usr/bin/env bash
# Build openEMS + CSXCAD (C++ and Python bindings) from source on macOS and install fairbeam
# into the resulting Python venv.
#
# Verified on: Apple M5 Pro, macOS 27, Homebrew 7, Python 3.13 (python.org build).
#
# Usage:
#   scripts/install-openems-macos.sh
#   PREFIX=~/opt/openEMS SRC=~/opt/openems-src JOBS=8 scripts/install-openems-macos.sh
#   FORCE=1 scripts/install-openems-macos.sh        # rebuild steps that look already done
#
# Environment:
#   PREFIX   install prefix for C++ libraries, binaries and the Python venv  (~/opt/openEMS)
#   SRC      source and build tree                                            (~/opt/openems-src)
#   JOBS     parallel compile jobs (default: half the cores, to keep the machine cool)
#   FORCE    1 = do not skip steps whose output already exists
#   WITH_MATPLOTLIB  1 = also pip install matplotlib into the venv (optional, default 0)
#   NATIVE_CPU  1 (default) = build openEMS with the three native CPU patches of scripts/native-cpu
#            (phase dispatch, UPML cursor, UPML rows; docs/CPU-OPTIMIZATION.md), at the pinned
#            openEMS commit, and rebuild openEMS alone if the installed library lacks them.
#            fairbeam turns them on by default on macOS (FAIRBEAM_NATIVE_CPU=0 opts out), and the
#            macOS openEMS pack (scripts/build-openems-macos-pack.py) ships what this builds.
#            0 = the unmodified upstream openEMS (a patched install then needs FORCE=1 to go back).
#
# Notes:
# - VTK is NOT taken from Homebrew: the bottle pulls in ~165 packages including Qt, and openEMS
#   only needs four VTK IO modules. A minimal VTK is built from the official tarball instead.
# - TinyXML was removed from Homebrew; openEMS ships a script that builds it with SHA256 checks.
# - The AppCSXCAD / QCSXCAD GUI is intentionally skipped (it needs Qt and VTK rendering).
# - This must run under bash (not zsh): it relies on bash word splitting and arrays.

set -euo pipefail

PREFIX="${PREFIX:-$HOME/opt/openEMS}"
SRC="${SRC:-$HOME/opt/openems-src}"
JOBS="${JOBS:-$(( $(sysctl -n hw.ncpu) / 2 ))}"
FORCE="${FORCE:-0}"
WITH_MATPLOTLIB="${WITH_MATPLOTLIB:-0}"
NATIVE_CPU="${NATIVE_CPU:-1}"

VTK_VERSION="9.7.0"
VTK_SERIES="9.7"
VTK_URL="https://www.vtk.org/files/release/${VTK_SERIES}/VTK-${VTK_VERSION}.tar.gz"
VTK_SHA256="affdb7a15ec34ee0174407f911ab70b646c7af01161818bbab4e1160b7eff720"
OPENEMS_REPO="https://github.com/thliebig/openEMS-Project.git"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$SRC/openEMS-Project"
VENV="$PREFIX/venv"

(( JOBS >= 1 )) || JOBS=1

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
skip() { printf '    skip: %s (FORCE=1 to redo)\n' "$*"; }
die()  { printf '\nerror: %s\n' "$*" >&2; exit 1; }
done_already() { [[ "$FORCE" != "1" ]] && [[ -e "$1" ]]; }

# ---------------------------------------------------------------------------------- preflight

step "Preflight"
[[ "$(uname -s)" == "Darwin" ]] || die "this script is for macOS; see README.md for other platforms"
command -v brew >/dev/null || die "Homebrew is required (https://brew.sh)"
command -v git >/dev/null || die "git is required (xcode-select --install)"
command -v python3 >/dev/null || die "python3 is required (python.org installer recommended)"
if [[ -n "${VIRTUAL_ENV:-}" ]]; then
  die "a Python venv is active ($VIRTUAL_ENV); run 'deactivate' first so the openEMS venv is created at $VENV"
fi
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
  || die "python3 >= 3.10 required, found $(python3 --version 2>&1)"
BREW_PREFIX="$(brew --prefix)"
info "PREFIX  = $PREFIX"
info "SRC     = $SRC"
info "JOBS    = $JOBS (of $(sysctl -n hw.ncpu) cores)"
info "python3 = $(command -v python3) ($(python3 --version 2>&1))"
info "brew    = $BREW_PREFIX"
info "repo    = $REPO_ROOT"
mkdir -p "$PREFIX" "$SRC"

# ---------------------------------------------------------------------------------- 1. Homebrew

step "1/8 Homebrew dependencies: cmake boost hdf5 cgal (not vtk)"
brew install cmake boost hdf5 cgal

# ---------------------------------------------------------------------------------- 2. sources

step "2/8 openEMS-Project sources"
if [[ -d "$PROJECT/.git" ]]; then
  skip "$PROJECT already cloned"
else
  git clone --recursive --depth 1 "$OPENEMS_REPO" "$PROJECT"
fi

# ---------------------------------------------------------------------------------- 3. TinyXML

step "3/8 TinyXML (removed from Homebrew; built by openEMS' helper script)"
if done_already "$PREFIX/lib/libtinyxml.dylib"; then
  skip "$PREFIX/lib/libtinyxml.dylib exists"
else
  (
    cd "$PROJECT"
    mkdir -p downloads build-tinyxml "$PREFIX"
    bash scripts/build_tinyxml.sh --build-dir build-tinyxml --install-dir "$PREFIX"
  )
fi

# ---------------------------------------------------------------------------------- 4. VTK

step "4/8 Minimal VTK $VTK_VERSION (IOXML, IOGeometry, IOLegacy, IOPLY only)"
if done_already "$PREFIX/lib/cmake/vtk-$VTK_SERIES/vtk-config.cmake"; then
  skip "VTK already installed in $PREFIX"
else
  info "This compiles for a few minutes (~3 min with 14 jobs on an M5 Pro) and heats the CPU."
  (
    cd "$SRC"
    if [[ ! -f "VTK-$VTK_VERSION.tar.gz" ]]; then
      curl -L --fail -o "VTK-$VTK_VERSION.tar.gz.part" "$VTK_URL"
      mv "VTK-$VTK_VERSION.tar.gz.part" "VTK-$VTK_VERSION.tar.gz"
    fi
    actual="$(shasum -a 256 "VTK-$VTK_VERSION.tar.gz" | cut -d ' ' -f 1)"
    if [[ "$actual" != "$VTK_SHA256" ]]; then
      die "VTK tarball SHA256 mismatch (expected $VTK_SHA256, got $actual); delete $SRC/VTK-$VTK_VERSION.tar.gz and retry"
    fi
    [[ -d "VTK-$VTK_VERSION" ]] || tar -xzf "VTK-$VTK_VERSION.tar.gz"
    mkdir -p build-vtk
    cd build-vtk
    cmake "../VTK-$VTK_VERSION" \
      -DCMAKE_BUILD_TYPE=Release \
      "-DCMAKE_INSTALL_PREFIX=$PREFIX" \
      -DBUILD_SHARED_LIBS=ON \
      -DBUILD_TESTING=OFF \
      -DVTK_BUILD_ALL_MODULES=OFF \
      -DVTK_GROUP_ENABLE_Rendering=DONT_WANT \
      -DVTK_GROUP_ENABLE_StandAlone=DONT_WANT \
      -DVTK_GROUP_ENABLE_Imaging=DONT_WANT \
      -DVTK_GROUP_ENABLE_Views=DONT_WANT \
      -DVTK_GROUP_ENABLE_Web=DONT_WANT \
      -DVTK_GROUP_ENABLE_Qt=DONT_WANT \
      -DVTK_GROUP_ENABLE_MPI=DONT_WANT \
      -DVTK_MODULE_ENABLE_VTK_IOXML=YES \
      -DVTK_MODULE_ENABLE_VTK_IOGeometry=YES \
      -DVTK_MODULE_ENABLE_VTK_IOLegacy=YES \
      -DVTK_MODULE_ENABLE_VTK_IOPLY=YES \
      -DVTK_WRAP_PYTHON=OFF \
      -DVTK_ENABLE_WRAPPING=OFF
    cmake --build . -j "$JOBS"
    cmake --install .
  )
fi

# ---------------------------------------------------------------------------------- 5. C++ libs

build_component() {
  local name="$1" marker="$2"
  if done_already "$marker"; then
    skip "$name already installed ($marker)"
    return 0
  fi
  info "building $name"
  (
    cd "$PROJECT"
    mkdir -p "build-$name"
    cd "build-$name"
    cmake "../$name" \
      -DCMAKE_BUILD_TYPE=Release \
      "-DCMAKE_INSTALL_PREFIX=$PREFIX" \
      "-DCMAKE_PREFIX_PATH=$PREFIX;$BREW_PREFIX" \
      "-DTinyXML_ROOT_DIR=$PREFIX" \
      "-DVTK_DIR=$PREFIX/lib/cmake/vtk-$VTK_SERIES" \
      "-DFPARSER_ROOT_DIR=$PREFIX" \
      "-DCSXCAD_ROOT_DIR=$PREFIX"
    cmake --build . -j "$JOBS"
    cmake --install .
  )
}

step "5/8 fparser, CSXCAD, openEMS (individual builds; AppCSXCAD/QCSXCAD GUI skipped)"
build_component fparser "$PREFIX/lib/libfparser.dylib"
build_component CSXCAD  "$PREFIX/lib/libCSXCAD.dylib"

# libopenEMS carries the patches when it contains their environment variable names (grep -c, not -q:
# with pipefail an early exit of grep would make strings fail)
native_cpu_installed() {
  [[ -f "$PREFIX/lib/libopenEMS.dylib" ]] \
    && [[ "$(strings "$PREFIX/lib/libopenEMS.dylib" | grep -c OPENEMS_EXPERIMENTAL_CPU_PHASE_DISPATCH)" -gt 0 ]]
}

openems_marker="$PREFIX/bin/openEMS"
if [[ "$NATIVE_CPU" == "1" ]]; then
  info "native CPU patches (NATIVE_CPU=0 builds the unmodified openEMS)"
  # pins openEMS to the validated commit, then applies the patches (a no-op when they are in already)
  NATIVE_CPU_CHECKOUT=1 bash "$REPO_ROOT/scripts/native-cpu/apply-macos.sh" "$PROJECT/openEMS" \
    || die "could not apply the native CPU patches (see above); NATIVE_CPU=0 builds without them"
  native_cpu_installed || openems_marker="$PREFIX/bin/.openEMS-needs-native-cpu-rebuild"
fi
build_component openEMS "$openems_marker"

# ---------------------------------------------------------------------------------- 6. Python

step "6/8 CSXCAD + openEMS Python bindings into $VENV"
if [[ "$FORCE" != "1" ]] && [[ -x "$VENV/bin/python" ]] \
   && "$VENV/bin/python" -c "import openEMS, CSXCAD" >/dev/null 2>&1; then
  skip "openEMS and CSXCAD already importable from $VENV"
else
  (
    cd "$PROJECT"
    MAKEFLAGS="-j$JOBS" bash scripts/build_python.sh --cpp-install-dir "$PREFIX"
  )
fi

# ---------------------------------------------------------------------------------- 7. fairbeam

step "7/8 fairbeam (editable install from $REPO_ROOT/python)"
if [[ "$WITH_MATPLOTLIB" == "1" ]]; then
  "$VENV/bin/pip" install matplotlib
else
  info "matplotlib is optional (WITH_MATPLOTLIB=1 to install it)"
fi
"$VENV/bin/pip" install -e "$REPO_ROOT/python"

# ---------------------------------------------------------------------------------- 8. verify

step "8/8 Verify"
version="$("$VENV/bin/python" -c "import openEMS, CSXCAD, fairbeam; print(openEMS.__version__)")" \
  || die "import check failed: $VENV/bin/python -c 'import openEMS, CSXCAD, fairbeam'"
info "openEMS $version, CSXCAD and fairbeam import from $VENV"

cat <<EOF

Done. Next steps (from $REPO_ROOT):

  # simulate a model and write public/projects/<slug>.json
  $VENV/bin/fairbeam run python/models/patch_antenna.py
  $VENV/bin/fairbeam run python/models/sierpinski_monopole.py --set iterations=3 --threads 6

  # start the viewer on http://127.0.0.1:5310
  npm install
  npm run dev

Tip: 'source $VENV/bin/activate' puts fairbeam and python on your PATH.
EOF
