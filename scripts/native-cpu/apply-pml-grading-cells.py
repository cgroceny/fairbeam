"""Apply the opt-in PML profile experiment to a clean, pinned native checkout.

This does not install a runtime or alter the default pack recipe. The patch
adds a native runtime argument, not a production Fairbeam CLI option.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

REVISION = '67d378488ee40de815eed00f8aaa808f0a9e3c6d'
BEFORE_SHA = 'd433af07ad42e961ba521395c59a8acbeed36726abb2a67dd11a4eef05b6a447'
AFTER_SHA = '45ad649007da5d63da6b074c7beedc046f6e4c588161b8109ebab62d21cda39e'
PATCH_SHA = '3b568074ba82040f8f10901c14caca62ad0f6b2cb530f326f94306a23be8573f'
PATCH = Path(__file__).with_name('openems-pml-grading-cells.patch')


def digest(path):
    return hashlib.sha256(Path(path).read_bytes().replace(b'\r\n', b'\n')).hexdigest()


def git(root, *args):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True,
                            text=True, encoding='utf-8')
    if result.returncode:
        raise RuntimeError(f'git {args[0]} failed: {result.stderr.strip()}')
    return result.stdout.strip()


def apply(source, *, check_only=False):
    root = Path(source).resolve(strict=True)
    target = root/'openems.cpp'
    if target.is_symlink() or not target.is_file():
        raise ValueError('A regular openems.cpp in the supplied checkout is required')
    if git(root, 'rev-parse', 'HEAD') != REVISION:
        raise ValueError('Native source revision differs; no files changed')
    if git(root, 'status', '--porcelain=v1', '--untracked-files=all'):
        raise ValueError('Native source must be clean; no files changed')
    if digest(PATCH) != PATCH_SHA:
        raise ValueError('Patch fingerprint differs; no files changed')
    if digest(target) != BEFORE_SHA:
        raise ValueError('Native source fingerprint differs; no files changed')
    git(root, 'apply', '--check', str(PATCH.resolve()))
    if check_only:
        return dict(status='checked', source_revision=REVISION, files_changed=0)
    git(root, 'apply', str(PATCH.resolve()))
    if digest(target) != AFTER_SHA:
        raise RuntimeError('Patched source fingerprint differs; retain files for inspection')
    return dict(status='applied', source_revision=REVISION, patch_sha256=PATCH_SHA,
                patched_source_sha256=AFTER_SHA, files_changed=1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--check', action='store_true', help='verify without changing files')
    args = parser.parse_args()
    print(json.dumps(apply(args.source, check_only=args.check)))


if __name__ == '__main__':
    main()
