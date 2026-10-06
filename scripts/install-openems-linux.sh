#!/usr/bin/env bash
# Build the CPU solver and Python bindings in a user-owned prefix. No sudo or system installs.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: scripts/install-openems-linux.sh [--check | --help]

Build pinned openEMS + CSXCAD, then install this checkout's fairbeam package.
Install the system dependencies listed in docs/LINUX.md first.

Environment:
  PREFIX   Native libraries and venv (default: ~/opt/openEMS)
  SRC      Source/build cache (default: ~/opt/openems-src-linux)
  PYTHON   Python 3.10+ used to create a new venv (default: python3)
  JOBS     Parallel native compile jobs (default: 2; use 1 on low-memory systems)
  CC, CXX  C/C++ compilers (default: gcc, g++)

--check only verifies the existing prefix imports; it downloads and installs nothing.
A working prefix is reused; fairbeam is still installed from this checkout on a normal run.
No existing prefix or source tree is deleted. Use a new PREFIX and SRC for a clean rebuild.
HELP
}
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
CHECK=0
case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --check) CHECK=1; shift ;;
  '') ;;
  *) usage >&2; exit 2 ;;
esac
[[ $# -eq 0 ]] || die "unexpected arguments; see --help"
[[ "$(uname -s)" == Linux ]] || die "this script requires Linux; see docs/FROM-SOURCE.md"

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="$(realpath -m -- "${PREFIX:-$HOME/opt/openEMS}")"
SRC="$(realpath -m -- "${SRC:-$HOME/opt/openems-src-linux}")"
PYTHON="${PYTHON:-python3}"
JOBS="${JOBS:-2}"
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || die "JOBS must be a positive integer"
PROJECT="$SRC/openEMS-Project"
VENV="$PREFIX/venv"
OPENEMS_REPO="https://github.com/thliebig/openEMS-Project.git"
OPENEMS_REF="9f5cdd4d71cae312633ab0b2c1db64867f8c782b"
CSXCAD_REF="bd2c133392d93251b640da1f8e2367163f00b7f5"

export CSXCAD_INSTALL_PATH="$PREFIX" OPENEMS_INSTALL_PATH="$PREFIX"
export LD_LIBRARY_PATH="$PREFIX/lib:$PREFIX/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PYTHONDONTWRITEBYTECODE=1

bindings_work() {
  [[ -x "$VENV/bin/python" ]] && "$VENV/bin/python" -c 'import CSXCAD, openEMS' >/dev/null 2>&1
}
validate_venv() {
  [[ -x "$VENV/bin/python" ]] || die "$VENV exists but has no working Python; choose a new PREFIX"
  "$VENV/bin/python" -c 'import sys; assert sys.prefix != sys.base_prefix; assert sys.version_info >= (3, 10)' \
    >/dev/null 2>&1 || die "$VENV must be a working Python 3.10+ virtual environment; choose a new PREFIX"
}
verify() {
  [[ -x "$VENV/bin/python" ]] || die "no Python at $VENV/bin/python; run the installer first"
  validate_venv
  "$VENV/bin/python" - <<'PY'
import sys
import CSXCAD, openEMS, fairbeam
from importlib.metadata import version
print(f"Python {sys.version.split()[0]}: {sys.executable}")
print(f"openEMS {openEMS.__version__}; CSXCAD {CSXCAD.__version__}; fairbeam {version('fairbeam')}")
PY
}
if [[ "$CHECK" == 1 ]]; then
  verify
  exit 0
fi

# Reject an invalid existing interpreter before cloning, building, or replacing native files.
if [[ -e "$VENV" || -L "$VENV" ]]; then
  validate_venv
fi

step "Prefix: $PREFIX"
if bindings_work; then
  step "Reusing importable openEMS/CSXCAD from $VENV (no native rebuild or version change)"
else
  # CMake and extension build caches can retain the original prefix's library paths.
  # Reusing that cache with a different PREFIX would create a mixed installation.
  for component in fparser CSXCAD openEMS; do
    cache="$SRC/build-linux-$component/CMakeCache.txt"
    if [[ -f "$cache" ]]; then
      cached_prefix="$(sed -n 's/^CMAKE_INSTALL_PREFIX:[^=]*=//p' "$cache")"
      [[ -z "$cached_prefix" || "$cached_prefix" == "$PREFIX" ]] \
        || die "$SRC contains build files for $cached_prefix; choose a new SRC for $PREFIX"
    fi
  done
  step "Building pinned openEMS CPU runtime with $JOBS compile jobs"
  export CC="${CC:-gcc}" CXX="${CXX:-g++}"
  for command in git cmake make "$CC" "$CXX" "$PYTHON"; do
    command -v "$command" >/dev/null || die "missing $command; see system dependencies in docs/LINUX.md"
  done
  "$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
    || die "PYTHON must be Python 3.10 or newer"
  printf '%s\n' 'System development libraries are required; see docs/LINUX.md. This script never runs apt or sudo.'
  mkdir -p -- "$PREFIX" "$SRC"

  if [[ -e "$PROJECT" ]]; then
    [[ -d "$PROJECT/.git" ]] || die "$PROJECT already exists and is not the expected Git checkout; choose a new SRC"
    [[ "$(git -C "$PROJECT" rev-parse HEAD)" == "$OPENEMS_REF" ]] \
      || die "$PROJECT is not at $OPENEMS_REF; choose a new SRC rather than replacing it"
    [[ -z "$(git -C "$PROJECT" status --porcelain --untracked-files=no)" ]] \
      || die "$PROJECT has tracked modifications; preserve them and choose a new SRC"
  else
    git clone --no-checkout "$OPENEMS_REPO" "$PROJECT"
    git -C "$PROJECT" checkout --detach "$OPENEMS_REF"
  fi
  git -C "$PROJECT" submodule update --init --checkout fparser CSXCAD openEMS

  # Individual CMake builds avoid the Qt/AppCSXCAD desktop tools. CMake also checks the
  # system headers/libraries, so locally installed dependencies can be used without apt.
  for component in fparser CSXCAD openEMS; do
    cmake -S "$PROJECT/$component" -B "$SRC/build-linux-$component" \
      -DCMAKE_BUILD_TYPE=Release \
      "-DCMAKE_INSTALL_PREFIX=$PREFIX" \
      "-DCMAKE_PREFIX_PATH=$PREFIX${CMAKE_PREFIX_PATH:+;$CMAKE_PREFIX_PATH}" \
      "-DFPARSER_ROOT_DIR=$PREFIX" "-DCSXCAD_ROOT_DIR=$PREFIX" \
      "-DCMAKE_INSTALL_RPATH=$PREFIX/lib;$PREFIX/lib64"
    cmake --build "$SRC/build-linux-$component" --parallel "$JOBS"
    cmake --install "$SRC/build-linux-$component"
  done

  if [[ ! -e "$VENV" ]]; then
    "$PYTHON" -m venv "$VENV"
  fi
  validate_venv
  "$VENV/bin/python" -m pip --version >/dev/null 2>&1 || "$VENV/bin/python" -m ensurepip
  "$VENV/bin/python" -m pip install 'setuptools>=69' wheel 'setuptools-scm>=8' cython numpy h5py matplotlib
  "$VENV/bin/python" -m pip install --no-build-isolation --no-deps "$PROJECT/CSXCAD/python"
  # Use a pinned, valid dependency URL in openEMS metadata even when SRC contains spaces.
  # The matching CSXCAD binding was installed above; --no-deps prevents another build/download.
  CSXCAD_PYSRC_PATH="git+https://github.com/thliebig/CSXCAD.git@$CSXCAD_REF#subdirectory=python" \
    "$VENV/bin/python" -m pip install --no-build-isolation --no-deps "$PROJECT/openEMS/python"
fi

step "Installing fairbeam from this checkout"
validate_venv
"$VENV/bin/python" -m pip --version >/dev/null 2>&1 || "$VENV/bin/python" -m ensurepip
"$VENV/bin/python" -m pip install -e "$REPO_ROOT/python"
step "Verify"
verify
printf '\nNext: npm ci && npm run build\nThen: PREFIX=%q %q\n' "$PREFIX" "$REPO_ROOT/scripts/run-linux.sh"
