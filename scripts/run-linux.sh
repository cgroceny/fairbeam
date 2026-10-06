#!/usr/bin/env bash
# Launch the built viewer and Python API together using the supported fairbeam app CLI.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="$(realpath -m -- "${PREFIX:-$HOME/opt/openEMS}")"
PYTHON="${FAIRBEAM_PYTHON:-$PREFIX/venv/bin/python}"
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Linux ]] || die "this launcher requires Linux"
command -v "$PYTHON" >/dev/null || die "Python not found: $PYTHON; run scripts/install-openems-linux.sh or set FAIRBEAM_PYTHON"
# Resolve a custom executable before changing directory, including a path containing spaces.
PYTHON="$(command -v "$PYTHON")"
# Keep the interpreter symlink itself: resolving it can accidentally escape its venv.
if [[ "$PYTHON" != /* ]]; then
  PYTHON="$(cd -- "$(dirname -- "$PYTHON")" && pwd)/$(basename -- "$PYTHON")"
fi
export FAIRBEAM_PYTHON="$PYTHON"
export CSXCAD_INSTALL_PATH="$PREFIX" OPENEMS_INSTALL_PATH="$PREFIX"
export LD_LIBRARY_PATH="$PREFIX/lib:$PREFIX/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

cd -- "$REPO_ROOT"
# Let argparse display help without requiring a built viewer or starting the server.
for argument in "$@"; do
  if [[ "$argument" == --help || "$argument" == -h ]]; then
    exec "$PYTHON" -m fairbeam app "$@"
  fi
done
"$PYTHON" -c 'import CSXCAD, openEMS, fairbeam' \
  || die "runtime imports failed; verify PREFIX/FAIRBEAM_PYTHON and native library dependencies (docs/LINUX.md)"
exec "$PYTHON" -m fairbeam app --ui "$REPO_ROOT/dist" --python "$PYTHON" "$@"
