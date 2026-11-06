"""Opt-in cutoff initialization for two pinned openEMS CPU revisions.

Only patches native source; never builds, installs or selects a runtime.
Use --source CHECKOUT --check first, then omit --check to apply.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

REVISIONS = ('67d378488ee40de815eed00f8aaa808f0a9e3c6d',
             '12cd91de21548987b835ce21f10fd8421d74da78')
BEFORE = {'FDTD/excitation.cpp': 'ceba85f7d6c77757129813328a978065ff08c9f41ce7baa761e2f5068dfe409b'}
AFTER = {'FDTD/excitation.cpp': '24ad6dec7304d49a2b839c70821b9e1a8c350b2a36643807311a8f3df48aa77c'}
PATCH = Path(__file__).with_name('openems-excitation-cutoff.patch')
PATCH_SHA = '91a84b736e6280f967368f6a9aa9f82d2536e4ccec80e3c4ab25dd0b987572f9'


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
    for name in BEFORE:
        target = root / name
        if not target.is_file() or not target.resolve().is_relative_to(root):
            raise ValueError('Regular native files inside the checkout are required')
        for part in (target, *target.parents):
            if part == root:
                break
            if part.is_symlink() or getattr(part, 'is_junction', lambda: False)():
                raise ValueError('Regular native files inside the checkout are required')
    revision = git(root, 'rev-parse', 'HEAD')
    if revision not in REVISIONS:
        raise ValueError('Native source revision differs; no files changed')
    if git(root, 'status', '--porcelain=v1', '--untracked-files=all'):
        raise ValueError('Native source must be clean; no files changed')
    if digest(PATCH) != PATCH_SHA or any(digest(root / name) != value for name, value in BEFORE.items()):
        raise ValueError('Patch or source fingerprint differs; no files changed')
    git(root, 'apply', '--check', str(PATCH.resolve()))
    if check_only:
        return dict(status='checked', source_revision=revision, files_changed=0)
    git(root, 'apply', str(PATCH.resolve()))
    if any(digest(root / name) != value for name, value in AFTER.items()):
        raise RuntimeError('Patched fingerprint differs; retain files for inspection')
    return dict(status='applied', source_revision=revision, patch_sha256=PATCH_SHA,
                files_changed=len(AFTER), source_sha256=AFTER)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--check', action='store_true', help='verify without changing files')
    args = parser.parse_args()
    print(json.dumps(apply(args.source, check_only=args.check)))
