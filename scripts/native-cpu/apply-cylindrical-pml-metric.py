"""Apply an opt-in cylindrical PML experiment to clean, pinned native sources.

Includes the reviewed fixed-profile patch; choose this OR the grading-only
applier on a fresh checkout. Never installs a runtime or changes pack defaults.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

REVISION = '67d378488ee40de815eed00f8aaa808f0a9e3c6d'
BEFORE = {
    'openems.cpp': 'd433af07ad42e961ba521395c59a8acbeed36726abb2a67dd11a4eef05b6a447',
    'FDTD/extensions/operator_ext_upml.cpp': 'a784772894bb6e57cb92eec67a02d28bd3f4c5d9fe1f33cc5e4005efcb456458',
}
AFTER = {
    'openems.cpp': '51e40cbb385bb98d77d84d1c5ae41f3f416cf2338c1ab386e5c4c3118b51cfe7',
    'FDTD/extensions/operator_ext_upml.cpp': 'a206f28932c98b61c1419a562f5cc7699d1ba5e8f320224aac67c97cb134a531',
}
PATCH = Path(__file__).with_name('openems-cylindrical-pml-metric.patch')
PATCH_SHA = '88ca85454e1daf74152d1db34094eeb9e15c0d5523c17283cf91bf9bd3c033e8'


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
        target = root/name
        if (not target.is_file() or not target.resolve().is_relative_to(root)
                or any(part.is_symlink() for part in (target, *target.parents) if part != root)):
            raise ValueError('Regular native files inside the checkout are required')
    if git(root, 'rev-parse', 'HEAD') != REVISION:
        raise ValueError('Native source revision differs; no files changed')
    if git(root, 'status', '--porcelain=v1', '--untracked-files=all'):
        raise ValueError('Native source must be clean; no files changed')
    if digest(PATCH) != PATCH_SHA or any(digest(root/name) != value for name, value in BEFORE.items()):
        raise ValueError('Patch or source fingerprint differs; no files changed')
    git(root, 'apply', '--check', str(PATCH.resolve()))
    if check_only:
        return dict(status='checked', source_revision=REVISION, files_changed=0)
    git(root, 'apply', str(PATCH.resolve()))
    if any(digest(root/name) != value for name, value in AFTER.items()):
        raise RuntimeError('Patched fingerprint differs; retain files for inspection')
    return dict(status='applied', source_revision=REVISION, patch_sha256=PATCH_SHA,
                files_changed=len(AFTER), source_sha256=AFTER)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--check', action='store_true', help='verify without changing files')
    args = parser.parse_args()
    print(json.dumps(apply(args.source, check_only=args.check)))
