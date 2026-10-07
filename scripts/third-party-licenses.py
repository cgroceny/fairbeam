"""Collect original distribution notices without installing or executing downloaded packages."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import zipfile
from concurrent.futures import ThreadPoolExecutor
from email.parser import Parser

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(os.environ.get('FAIRBEAM_LICENSE_CACHE', '/tmp/fairbeam-license-downloads'))
CACHE.mkdir(exist_ok=True)

def get(url, digest=None):
    path = CACHE / hashlib.sha256(url.encode()).hexdigest()
    if not path.exists():
        temporary = path.with_suffix('.partial')
        subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error', '--retry', '3', '--max-time', '240', url, '--output', str(temporary)], check=True)
        temporary.replace(path)
    data = path.read_bytes()
    if digest and hashlib.sha256(data).hexdigest() != digest:
        raise ValueError(f'Checksum mismatch: {url}')
    return data

def archive(data):
    if data[:2] == b'PK':
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            return {n: z.read(n) for n in z.namelist() if not n.endswith('/')}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as t:
        return {m.name: t.extractfile(m).read() for m in t if m.isfile()}

def texts(files):
    return [{'name': n, 'text': b.decode('utf8', errors='replace')} for n, b in sorted(files.items())
            if re.search(r'(^|/)(licen[cs]e[^/]*|copying[^/]*|copyright[^/]*|notice[^/]*|authors|ofl[^/]*|.*[-_]license\.txt|.*[-_]copying.*\.txt|.*[-_]lgpl\.txt|.*[-_]gpl\.txt|tinyxml-readme\.txt)$', n, re.I)
            and len(b) < 2_000_000]

def item(eco, name, version, license, source, content):
    return dict(ecosystem=eco, name=name, version=version, license=license, source=source, texts=content)

# Isolate Cargo's downloaded registry from the developer's environment.
env = dict(os.environ, CARGO_HOME=os.environ.get('CARGO_HOME', str(CACHE / 'cargo')))
metadata = json.loads(subprocess.check_output(['cargo', 'metadata', '--locked', '--manifest-path', str(ROOT / 'src-tauri/Cargo.toml'), '--format-version', '1'], env=env))
# Follow only normal dependencies of the two shipped release targets. Build tooling,
# tests and proc-macro implementation crates do not enter the application binary.
packages_by_id = {p['id']:p for p in metadata['packages']}
resolved = set()
platforms = {}
for target in ('aarch64-apple-darwin', 'x86_64-pc-windows-msvc'):
    graph = json.loads(subprocess.check_output(['cargo','metadata','--locked','--offline','--manifest-path',str(ROOT / 'src-tauri/Cargo.toml'),'--format-version','1','--filter-platform',target],env=env))
    nodes = {n['id']:n for n in graph['resolve']['nodes']}
    pending = [graph['resolve']['root']]
    visited = set()
    while pending:
        id = pending.pop()
        if id in visited: continue
        visited.add(id)
        if any('proc-macro' in t['kind'] for t in packages_by_id[id]['targets']): continue
        resolved.add(id)
        platforms.setdefault(id, []).append(target)
        for dep in nodes[id]['deps']:
            if any(d['kind'] is None for d in dep['dep_kinds']): pending.append(dep['pkg'])
rust = []
crate_sources = json.loads((ROOT / 'scripts/licenses/crate-sources.json').read_text())
for p in metadata['packages']:
    if p['id'] not in resolved or not p['source']:
        continue
    directory = Path(p['manifest_path']).parent
    content = texts({str(f.relative_to(directory)): f.read_bytes() for f in directory.rglob('*') if f.is_file()})
    if p.get('license_file'):
        f = directory / p['license_file']
        if not any(t['name'] == p['license_file'] for t in content):
            content.append({'name': p['license_file'], 'text': f.read_text()})
    rust.append(item('cargo', p['name'], p['version'], p['license'], p['repository'] or crate_sources.get(f"{p['name']}@{p['version']}") or f"https://crates.io/crates/{p['name']}/{p['version']}", content))
    rust[-1]['evidence'] = 'Release targets: ' + ', '.join(platforms[p['id']]) + '. Default features; normal dependencies only.'

# Some crates omit workspace-root licenses from their registry package. Retrieve the
# root texts at the commit recorded by Cargo's own .cargo_vcs_info.json.
by_repo = {}
for p in rust:
    if p['texts']:
        by_repo.setdefault((p['source'].rstrip('/'), p['license']), p['texts'])
metadata_by_key = {(p['name'],p['version']):p for p in metadata['packages']}
for p in rust:
    if p['texts']: continue
    cargo = metadata_by_key[(p['name'],p['version'])]
    vcs = Path(cargo['manifest_path']).parent / '.cargo_vcs_info.json'
    repo = p['source'].rstrip('/')
    if vcs.exists() and repo.startswith('https://github.com/'):
        commit = json.loads(vcs.read_text())['git']['sha1']
        slug = repo.removeprefix('https://github.com/').removesuffix('.git')
        tree = json.loads(get(f'https://api.github.com/repos/{slug}/git/trees/{commit}'))
        files = {v['path']:get(f"https://raw.githubusercontent.com/{slug}/{commit}/{v['path']}") for v in tree.get('tree',[]) if v['type']=='blob' and re.match(r'^(LICENSE|COPYING|COPYRIGHT|NOTICE)',v['path'],re.I)}
        p['texts'] = texts(files)
        p['source'] = f'https://github.com/{slug}/tree/{commit}'
    if not p['texts']:
        p['texts'] = by_repo.get((repo, p['license']), [])


for p in rust:
    if not p['texts'] and p['license'] == 'MPL-2.0':
        p['texts'] = [{'name':'Mozilla Public License 2.0', 'text':get('https://www.mozilla.org/media/MPL/2.0/index.815ca599c9df.txt').decode()}]


lock = json.loads((ROOT / 'package-lock.json').read_text())['packages']
modules = json.loads((CACHE / 'viewer-modules.json').read_text())
modules += ['node_modules/@fontsource/ibm-plex-mono', 'node_modules/@fontsource/ibm-plex-sans']
def npm(lock_path):
    p = lock[lock_path]
    installed = json.loads((ROOT / lock_path / 'package.json').read_text())
    name = installed['name']
    if installed['version'] != p['version']:
        raise ValueError(f'Build install differs from lockfile: {name}')
    # Read from the exact registry archive, not an install symlink which may differ from this lock.
    data = get(p['resolved'])
    import base64
    algorithm, expected = p['integrity'].split('-', 1)
    if base64.b64encode(hashlib.new(algorithm, data).digest()).decode() != expected:
        raise ValueError(f'npm integrity mismatch: {name}')
    files = archive(data)
    manifest = json.loads(files['package/package.json'])
    if manifest['version'] != p['version']:
        raise ValueError(f'npm version mismatch: {name}')
    repository = manifest.get('repository', '')
    if isinstance(repository, dict): repository = repository.get('url', '')
    repository = repository.removeprefix('git+').replace('git://', 'https://')
    return item('npm', name, p['version'], manifest.get('license', p.get('license')), repository or f'https://www.npmjs.com/package/{name}/v/{p["version"]}', texts(files))
with ThreadPoolExecutor(max_workers=4) as pool:
    viewer = list(pool.map(npm, sorted(set(modules))))

requirements = re.findall(r'^([\w-]+)==([^\s\\]+)', (ROOT / 'runtime/requirements.txt').read_text(), re.M)
def python_package(pair):
    name, version = pair
    meta = json.loads(get(f'https://pypi.org/pypi/{name}/{version}/json'))
    urls = meta['urls']
    # Both supported platforms; include binary wheel notices (vendored native dependencies).
    chosen = []
    for platform in ('macosx', 'win_amd64'):
        candidates = [p for p in urls if p['filename'].endswith('.whl') and ((platform in p['filename'] and (platform != 'macosx' or 'arm64' in p['filename'] or 'universal2' in p['filename'])) or 'none-any' in p['filename']) and ('cp313' in p['filename'] or 'py3-' in p['filename'] or 'py2.py3-' in p['filename'] or 'abi3' in p['filename'])]
        if candidates: chosen.append(sorted(candidates, key=lambda p: p['filename'])[0])
    if not chosen: chosen = [next(p for p in urls if p['packagetype'] == 'sdist')]
    content = []
    seen = set()
    for artifact in chosen:
        files = archive(get(artifact['url'], artifact['digests']['sha256']))
        for t in texts(files):
            if t['text'] not in seen:
                seen.add(t['text']); content.append(t)
    info = meta['info']
    license = info.get('license_expression') or info.get('license')
    if not license or len(license) > 200:
        license = '; '.join(c.removeprefix('License :: ') for c in info['classifiers'] if c.startswith('License ::')) or None
    license = {'cycler':'BSD-3-Clause', 'kiwisolver':'BSD-3-Clause', 'matplotlib':'LicenseRef-Matplotlib', 'python-dateutil':'Apache-2.0 OR BSD-3-Clause'}.get(name, license)
    return item('pypi', name, version, license, f'https://pypi.org/project/{name}/{version}/', content)
with ThreadPoolExecutor(max_workers=4) as pool:
    python = list(pool.map(python_package, requirements))

pins = json.loads((ROOT / 'runtime/pins.json').read_text())
uv_version = pins['uv']['version']
uv_files = archive(get(f'https://github.com/astral-sh/uv/archive/refs/tags/{uv_version}.tar.gz'))
python.insert(0, item('runtime', 'uv', uv_version, 'MIT OR Apache-2.0', f'https://github.com/astral-sh/uv/tree/{uv_version}', texts(uv_files)))
# No exact standalone artifact is selected in the current pins. This is an explicit release exception.
downloads = json.loads(next(b for n,b in uv_files.items() if n.endswith('/crates/uv-python/download-metadata.json')))
for os_name, arch in [('darwin', 'aarch64'), ('windows', 'x86_64')]:
    choices = [v for v in downloads.values() if f"{v['major']}.{v['minor']}" == pins['python'] and v['os'] == os_name and v['arch']['family'] == arch and not v.get('variant') and not v.get('prerelease') and not v['arch'].get('variant')]
    pin = max(choices, key=lambda v:(v['patch'],v['build']))
    files = archive(get(pin['url'], pin['sha256']))
    python.append(item('runtime', f'CPython / python-build-standalone {os_name}', f"{pin['major']}.{pin['minor']}.{pin['patch']}+{pin['build']}", 'Python-2.0 and bundled library terms', pin['url'], texts(files)))
solver = []
component_rules = json.loads((ROOT / 'scripts/licenses/solver-components.json').read_text())
def reference_text(pair):
    name, rule = pair
    if name == 'TinyXML (static)':
        pin = pins['openems']['macos-arm64']
        files = archive(get(pin['url'], pin['sha256']))
        text = next(b.decode() for n,b in files.items() if n.endswith('/tinyxml-readme.txt'))
        return name, [{'name':'TinyXML 2.6.2 upstream license reference', 'text':text}]
    return name, ([{'name':rule['text'], 'text':get(rule['text']).decode('utf8', errors='replace')}] if rule['text'] else [])
with ThreadPoolExecutor(max_workers=4) as pool:
    native_texts = dict(pool.map(reference_text, component_rules.items()))
for group in ('openems', 'openems_gpu'):
    for platform, pin in pins[group].items():
        if not isinstance(pin, dict) or not pin.get('url'): continue
        files = archive(get(pin['url'], pin['sha256']))
        content = texts(files)
        if platform == 'macos-arm64':
            notice = next(b.decode() for n,b in files.items() if n.endswith('/NOTICE.md'))
            table = '\n'.join(line for line in notice.splitlines() if line.startswith('|'))
            content = [t for t in content if not t['name'].endswith('/NOTICE.md')]
            content.append({'name':'Component versions and corresponding sources', 'text':table})
        # Some binary packs carry additional native notices only within wheel files.
        for name, data in files.items():
            if name.endswith('.whl'):
                content.extend(texts(archive(data)))
        # Paths in old archives are not product copy; report original license basenames.
        unique = {}
        for t in content:
            t['name'] = Path(t['name']).name
            if t['name'] == 'NOTICE.md' and platform == 'macos-arm64': continue
            unique[t['text']] = t
        content = list(unique.values())
        if platform == 'windows-x64':
            ctb = files['openEMS/CTB/license.txt'].decode('utf8')
            solver.append(item('native', f'{group} Windows Circuit Toolbox', 'archive copy', 'BSD-3-Clause', 'https://github.com/thliebig/CTB/tree/5ac29367ebb7e30e78dd3db13a21464756855599', [{'name':'CTB/license.txt', 'text':ctb}]))
            import struct
            matched = {}
            for path, data in files.items():
                if not path.lower().endswith(('.dll','.exe')): continue
                binary = Path(path).name
                matches = [name for name, rule in component_rules.items() if any(binary.lower().startswith(pattern.lower()) for pattern in rule['patterns'])]
                if len(matches) != 1:
                    raise ValueError(f'Unreviewed native binary: {path} (matches {matches})')
                name = matches[0]
                # FileVersion in PE VS_FIXEDFILEINFO, when upstream records it.
                offset = data.find(b'\xbd\x04\xef\xfe')
                version = None
                if offset >= 0 and len(data) >= offset + 16:
                    ms, ls = struct.unpack_from('<II', data, offset+8)
                    version = '.'.join(str(v) for v in (ms >> 16, ms & 65535, ls >> 16, ls & 65535))
                    if version == '0.0.0.0': version = None
                matched.setdefault(name, []).append((binary,version))
            for name, rule in component_rules.items():
                if rule.get('static'): matched[name] = [('static or header dependency declared by upstream build manifests', None)]
            for name, binaries in sorted(matched.items()):
                rule = component_rules[name]
                versions = sorted(set(v for _,v in binaries if v))
                version = ', '.join(versions) or 'unrecorded'
                source = rule['source']
                if group == 'openems_gpu' and name == 'openEMS': source = 'https://github.com/SeanMollet/openEMS/tree/v0.37.0-beta1%2Bgpu'
                record = item('native', f'{group} Windows {name}', version, rule['license'], source, native_texts[name])
                record['evidence'] = 'Binary files: ' + ', '.join(n for n,_ in sorted(binaries)) + '. Versions are PE FileVersion values, when present. License texts are upstream reference texts; this archive omits matching license provenance. The exact source revision and applicable binary terms require upstream confirmation.'
                solver.append(record)
        solver.append(item('solver', f'{group} {platform}', pins[group]['version'], 'GPL-3.0-or-later; LGPL-3.0-or-later; bundled library terms below', pin['url'], content))
vtk_url = 'https://www.vtk.org/files/release/9.7/VTK-9.7.0.tar.gz'
vtk_files = archive(get(vtk_url, 'affdb7a15ec34ee0174407f911ab70b646c7af01161818bbab4e1160b7eff720'))
solver.append(item('native', 'CGAL macOS header dependency', 'unrecorded', component_rules['CGAL (headers)']['license'], component_rules['CGAL (headers)']['source'], native_texts['CGAL (headers)']))
solver[-1]['evidence'] = 'CGAL is a header dependency of CSXCAD in the pack build. Its version is absent from the published pack notice; confirm the exact build input and the per-component terms. This text is an upstream license reference.'
solver.append(item('native', 'VTK macOS vendored source notices', '9.7.0', 'BSD-3-Clause and bundled library terms', vtk_url, texts({n:b for n,b in vtk_files.items() if '/ThirdParty/' in n or n.endswith('/Copyright.txt')})))
sections = [
    dict(title='Desktop shell (Rust)', packages=sorted(rust, key=lambda p:(p['name'],p['version']))),
    dict(title='Viewer (npm)', packages=[p for p in viewer if not p['name'].startswith('@fontsource/')]),
    dict(title='Runtime (Python)', description='Pinned packages include license texts of native libraries bundled in macOS arm64 and Windows x64 wheels. CPython builds below are the default downloads recorded in the pinned uv release metadata. The installer requests the minor version and can reuse an existing managed installation; the installed runtime manifest is authoritative for that installation.', packages=python),
    dict(title='Solver (openEMS / CSXCAD)', description='Original archive notices below identify the solver and bundled libraries. macOS sources: openEMS commit 12cd91de2, CSXCAD commit bd2c13339, and the component versions in the pack NOTICE. Windows CPU source: https://github.com/thliebig/openEMS-Project/tree/v0.37.0-rc3 (including submodules); GPU source: https://github.com/SeanMollet/openEMS/tree/v0.37.0-beta1%2Bgpu. Fairbeam pack build and patches: scripts/build-openems-macos-pack.py, scripts/install-openems-macos.sh and scripts/native-cpu/ at this release source tag. Complete corresponding source for GPL/LGPL components is available on request for at least three years after release, and longer when required by the license, through https://github.com/ismailakdag/fairbeam-releases/issues. Retain exact source archives and build inputs when publishing a pack.', packages=solver),
    dict(title='Microsoft WebView2', description='The Windows installer includes the Evergreen bootstrapper. The separately installed runtime updates independently; it has no fixed version in Fairbeam\'s locks. Microsoft redistribution terms apply: https://developer.microsoft.com/en-us/microsoft-edge/webview2/ and https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution. These proprietary terms are separate from the Rust webview2 bindings.', packages=[item('runtime', 'Microsoft WebView2', 'Evergreen', 'Microsoft proprietary terms', 'https://developer.microsoft.com/en-us/microsoft-edge/webview2/', [])]),
    dict(title='Fonts and assets', description='IBM Plex Sans and Mono use SIL OFL 1.1. Lucide icons and their upstream notices are in the viewer section. Fairbeam\'s own marks and application icons remain covered by the project license.', packages=[p for p in viewer if p['name'].startswith('@fontsource/')]),
]
(ROOT / 'scripts/licenses/inventory.json').write_text(json.dumps(dict(sections=sections), indent=2, ensure_ascii=False)+'\n')
