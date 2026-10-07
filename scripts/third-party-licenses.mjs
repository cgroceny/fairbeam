// Regenerate release notices from a versioned metadata snapshot; refresh retrieves upstream texts.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { renderNotices } from './licenses/render.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
export const inputs = ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'runtime/pins.json', 'runtime/requirements.txt', 'runtime/install.py', 'runtime/setup-runtime.sh', 'runtime/setup-runtime.ps1', 'scripts/build-openems-macos-pack.py', 'scripts/install-openems-macos.sh', 'vite.config.ts', 'scripts/third-party-licenses.py', 'scripts/third-party-licenses.mjs', 'scripts/licenses/render.mjs', 'scripts/licenses/exceptions.json', 'scripts/build-site.mjs', 'scripts/licenses/solver-components.json', 'scripts/licenses/crate-sources.json'];
const hash = f => createHash('sha256').update(readFileSync(f)).digest('hex');
// Source imports affect the rendered module graph even when the npm lock is unchanged.
const sourceFiles = execFileSync('rg', ['--files', 'src', 'landing', 'public'], {encoding:'utf8'}).trim().split('\n').filter(f => /\.(tsx?|css|html|js|svg)$/.test(f));
const fingerprints = Object.fromEntries(inputs.sort().map(f => [f, hash(f)]));
fingerprints.viewerSources = createHash('sha256').update(sourceFiles.sort().map(f => `${f}:${hash(f)}`).join('\n')).digest('hex');
if (process.argv.includes('--refresh')) {
  const modules = new Set();
  await build({build: {write:false}, plugins:[{name:'license-modules', generateBundle(_, bundle) {
    for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') for (const id of Object.keys(chunk.modules)) {
      const match = id.replaceAll('\\','/').match(/(?:^|\/)(node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*)/);
      if (match) modules.add(match[1]);
    }
  }}]});
  const cache = process.env.FAIRBEAM_LICENSE_CACHE ?? (process.platform === 'win32' ? join(tmpdir(), 'fairbeam-license-downloads') : '/tmp/fairbeam-license-downloads');
  mkdirSync(cache, {recursive:true});
  writeFileSync(join(cache, 'viewer-modules.json'), JSON.stringify([...modules].sort()));
  execFileSync('python3', ['scripts/third-party-licenses.py'], {stdio:'inherit', env:{...process.env, FAIRBEAM_LICENSE_CACHE:cache}});
  const data = JSON.parse(readFileSync('scripts/licenses/inventory.json'));
  data.inputs = fingerprints;
  writeFileSync('scripts/licenses/inventory.json', JSON.stringify(data, null, 2)+'\n');
}
const data = JSON.parse(readFileSync('scripts/licenses/inventory.json'));
if (JSON.stringify(data.inputs) !== JSON.stringify(fingerprints)) throw new Error('License metadata is stale. Run node scripts/third-party-licenses.mjs --refresh.');
const exceptions = JSON.parse(readFileSync('scripts/licenses/exceptions.json'));
const out = renderNotices(data, exceptions, JSON.parse(readFileSync('package.json')).version);
const destination = 'THIRD-PARTY-NOTICES.md';
if (process.argv.includes('--check')) {
  if (readFileSync(destination,'utf8') !== out) throw new Error(`${destination} is stale; regenerate it.`);
  console.log('Third-party notices match the release inputs and metadata.');
} else writeFileSync(destination, out);
