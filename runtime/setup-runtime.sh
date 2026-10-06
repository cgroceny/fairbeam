#!/bin/sh
# Fairbeam managed runtime, stage 1 for macOS arm64 (see docs/DESKTOP.md). No system Python, no
# sudo, no PATH edits: everything goes into the runtime root.
#   1. download the pinned uv (runtime/pins.json) and verify its SHA-256,
#   2. install a uv-managed CPython (pins.json "python") into <root>/python,
#   3. create <root>/venv with it,
#   4. hand over to stage 2 (runtime/install.py) with the venv's Python.
# Progress: lines "FAIRBEAM-PROGRESS {json}" on stdout (stage 2 continues the same protocol).
#
#   setup-runtime.sh --runtime-root /abs/path/runtime --resources /abs/app/resources [--repair] [--openems-archive FILE]
set -eu
umask 022

root=
res=
repair=
archive=
fail() { printf 'Fairbeam runtime: error: %s\n' "$*" >&2; exit 1; }
progress() { printf 'FAIRBEAM-PROGRESS {"step": "%s", "message": "%s"}\n' "$1" "$2"; }
while [ "$#" -gt 0 ]; do
    case "$1" in
        --runtime-root) [ "$#" -ge 2 ] || fail "missing value for $1"; root=$2; shift 2;;
        --resources) [ "$#" -ge 2 ] || fail "missing value for $1"; res=$2; shift 2;;
        --repair) repair=--repair; shift;;
        --openems-archive) [ "$#" -ge 2 ] || fail "missing value for $1"; archive=$2; shift 2;;
        *) fail "unknown argument: $1";;
    esac
done
[ -n "$root" ] && [ -n "$res" ] || fail "usage: setup-runtime.sh --runtime-root DIR --resources DIR"
case "$root" in /*) ;; *) fail "the runtime root must be an absolute path";; esac
case "$(basename -- "$root")" in runtime) ;; *) fail "the runtime root must be a dedicated folder named 'runtime'";; esac
[ "$(uname -s)/$(uname -m)" = "Darwin/arm64" ] || fail "this script is for macOS on Apple silicon"
pins=$res/runtime/pins.json
[ -f "$pins" ] || fail "pins.json not found in $res/runtime"

pin() { /usr/bin/plutil -extract "$1" raw -o - "$pins"; }
# the openEMS pack's Homebrew libraries target the macOS they were built on
need=$(pin openems.macos-arm64.macos_min 2>/dev/null || echo 13)
have=$(sw_vers -productVersion | cut -d. -f1)
[ "$have" -ge "$need" ] || fail "the openEMS build for macOS needs macOS $need or newer (this is macOS $have); choose an existing openEMS installation instead"
uv_url=$(pin uv.macos-arm64.url)
uv_sha=$(pin uv.macos-arm64.sha256)
py_ver=$(pin python)

mkdir -p "$root/uv" "$root/downloads" "$root/logs"
if [ -n "$repair" ]; then rm -rf "$root/venv" "$root/python"; fi

export UV_CACHE_DIR="$root/cache"
export UV_PYTHON_INSTALL_DIR="$root/python"
export UV_NO_CONFIG=1
uv=$root/uv/uv

if [ ! -x "$uv" ] || [ "$("$uv" --version 2>/dev/null | cut -d' ' -f2)" != "$(pin uv.version)" ]; then
    progress download-uv "$uv_url"
    tgz=$root/downloads/$(basename -- "$uv_url")
    curl -fsSL --retry 3 -o "$tgz.part" "$uv_url" || fail "could not download $uv_url"
    got=$(shasum -a 256 "$tgz.part" | cut -d' ' -f1)
    [ "$got" = "$uv_sha" ] || { rm -f "$tgz.part"; fail "uv SHA-256 mismatch (expected $uv_sha, got $got)"; }
    mv "$tgz.part" "$tgz"
    tmp=$(mktemp -d "$root/uv.XXXXXX")
    tar -xzf "$tgz" -C "$tmp"
    found=$(find "$tmp" -type f -name uv | head -n 1)
    [ -n "$found" ] || fail "uv binary not found in $tgz"
    mv -f "$found" "$uv"
    chmod 755 "$uv"
    rm -rf "$tmp"
fi

progress install-python "CPython $py_ver"
# --no-bin: no ~/.local/bin/python3.x link; the runtime must not touch anything outside its root
"$uv" python install "$py_ver" --no-bin --quiet || fail "uv could not install CPython $py_ver"
if [ ! -x "$root/venv/bin/python" ]; then
    progress create-venv "$root/venv"
    "$uv" venv "$root/venv" --python "$py_ver" --managed-python --quiet || fail "uv could not create the venv"
fi

set -- --runtime-root "$root" --resources "$res"
[ -z "$repair" ] || set -- "$@" --repair
[ -z "$archive" ] || set -- "$@" --openems-archive "$archive"
exec "$root/venv/bin/python" "$res/runtime/install.py" "$@"
