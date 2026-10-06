// Build an uninstalled, isolated Windows preview folder without updater signing or an installer.
// Usage: node scripts/build-windows-preview.mjs [--preview-id org.fairbeam.desktop.preview.SUFFIX] [--output PATH] [--python PATH] [--openems PATH] [--seed-model PATH] [--seed-design PATH]

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultPreviewIdentifier = 'org.fairbeam.desktop.preview';
let previewIdentifierOption;
let outputOption;
const pyvenvPython = process.env.FAIRBEAM_PREVIEW_PYTHON || '';
let pythonPath = pyvenvPython;
const openemsEnvPath = process.env.FAIRBEAM_PREVIEW_OPENEMS || process.env.OPENEMS_INSTALL_PATH || '';
let openemsPath = openemsEnvPath;
let seedModel = '';
let seedDesign = '';

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--python' && process.argv[i + 1]) pythonPath = process.argv[++i];
  else if (arg.startsWith('--python=')) pythonPath = arg.slice('--python='.length);
  else if (arg === '--openems' && process.argv[i + 1]) openemsPath = process.argv[++i];
  else if (arg.startsWith('--openems=')) openemsPath = arg.slice('--openems='.length);
  else if (arg === '--seed-model' && process.argv[i + 1]) seedModel = process.argv[++i];
  else if (arg.startsWith('--seed-model=')) seedModel = arg.slice('--seed-model='.length);
  else if (arg === '--seed-design' && process.argv[i + 1]) seedDesign = process.argv[++i];
  else if (arg.startsWith('--seed-design=')) seedDesign = arg.slice('--seed-design='.length);
  else if (arg === '--preview-id' && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) previewIdentifierOption = process.argv[++i];
  else if (arg.startsWith('--preview-id=')) previewIdentifierOption = arg.slice('--preview-id='.length);
  else if (arg === '--output' && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) outputOption = process.argv[++i];
  else if (arg.startsWith('--output=')) outputOption = arg.slice('--output='.length);
  else if (arg === '--help' || arg === '-h') {
    console.log('Usage: node scripts/build-windows-preview.mjs [--preview-id org.fairbeam.desktop.preview.SUFFIX] [--output PATH] [--python PATH] [--openems PATH] [--seed-model PATH] [--seed-design PATH]');
    console.log('Default identity: org.fairbeam.desktop.preview.');
    console.log('The output directory must be fresh; choose --output to select a new folder.');
    process.exit(0);
  } else {
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
}

if (previewIdentifierOption !== undefined && !/^org\.fairbeam\.desktop\.preview\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(previewIdentifierOption)) {
  throw new Error('--preview-id must be org.fairbeam.desktop.preview followed by one safe lowercase alphanumeric/hyphen suffix.');
}
if (outputOption !== undefined && !outputOption.trim()) {
  throw new Error('--output must name a fresh output directory.');
}

if (process.platform !== 'win32') throw new Error('This preview packager must run on Windows.');
const previewIdentifier = previewIdentifierOption ?? defaultPreviewIdentifier;
const output = outputOption !== undefined
  ? resolve(outputOption)
  : join(repo, 'src-tauri', 'target', 'release', 'fairbeam-preview-local');
if (await exists(output)) {
  throw new Error(`Preview output already exists: ${output}. Choose a fresh --output path; existing preview data is preserved.`);
}

const cli = join(repo, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
const vite = join(repo, 'node_modules', 'vite', 'bin', 'vite.js');
const exe = join(repo, 'src-tauri', 'target', 'release', 'fairbeam.exe');
const dist = join(repo, 'dist');
const safePython = pythonPath ? resolve(pythonPath) : '';
const safeOpenems = openemsPath ? resolve(openemsPath) : '';
if (safePython && !(await exists(safePython))) {
  throw new Error(`Preview Python does not exist: ${safePython}`);
}
if (safeOpenems && !(await exists(safeOpenems))) {
  throw new Error(`Preview openEMS directory does not exist: ${safeOpenems}`);
}
if (seedModel) {
  seedModel = resolve(seedModel);
  const sourceStat = await stat(seedModel).catch(() => null);
  if (!sourceStat?.isFile() || extname(seedModel).toLowerCase() !== '.py') {
    throw new Error('--seed-model must name an existing Python file.');
  }
}
if (seedDesign) {
  seedDesign = resolve(seedDesign);
  const sourceStat = await stat(seedDesign).catch(() => null);
  if (!sourceStat?.isFile() || !seedDesign.toLowerCase().endsWith('.design.json')) {
    throw new Error('--seed-design must name an existing .design.json file.');
  }
  JSON.parse(await readFile(seedDesign, 'utf8'));
}
if (!(await exists(cli)) || !(await exists(tsc)) || !(await exists(vite))) {
  throw new Error('A locked local build dependency is missing; install the npm dependencies first.');
}

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const trackedChanges = gitPaths(['diff', 'HEAD', '--name-only', '-z']);
const untrackedChanges = gitPaths(['ls-files', '--others', '--exclude-standard', '-z']);
const dirtySourceFiles = [...new Set([...trackedChanges, ...untrackedChanges])]
  .filter((file) => file && !file.startsWith('python/models/'))
  .sort();
const packageVersion = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version;

const buildEnv = { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '4' };
// Windows may expose Path rather than PATH. Keep one case-insensitive key, retaining the
// inherited toolchain paths and making this Node executable available to Tauri's build hook.
const inheritedPathKey = Object.keys(buildEnv).find((key) => key.toLowerCase() === 'path');
const inheritedPath = inheritedPathKey ? buildEnv[inheritedPathKey] : '';
for (const key of Object.keys(buildEnv)) if (key.toLowerCase() === 'path') delete buildEnv[key];
buildEnv.PATH = `${dirname(process.execPath)}${delimiter}${inheritedPath || ''}`;
const cargoBin = join(process.env.CARGO_HOME || join(process.env.USERPROFILE || '', '.cargo'), 'bin');
if (await exists(join(cargoBin, 'cargo.exe'))) {
  buildEnv.PATH = `${cargoBin}${delimiter}${buildEnv.PATH || ''}`;
}
// This is a local non-release build. Do not pass an updater key or Apple signing credentials to it.
for (const key of [
  'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  'APPLE_SIGNING_IDENTITY', 'APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH',
]) delete buildEnv[key];

await run(process.execPath, [tsc, '--noEmit'], repo, buildEnv);
await run(process.execPath, [vite, 'build'], repo, buildEnv);
if (!(await exists(join(dist, 'index.html')))) throw new Error('The viewer build did not produce dist/index.html.');

const tmp = await mkdtemp(join(tmpdir(), 'fairbeam-preview-'));
const overlay = join(tmp, 'tauri.preview.conf.json');
await writeFile(overlay, JSON.stringify({
  productName: 'Fairbeam Preview',
  identifier: previewIdentifier,
  // The viewer was built above; avoid running its build a second time inside the Tauri command.
  build: { beforeBuildCommand: 'node -e "process.exit(0)"' },
}, null, 2));

await run(process.execPath, [cli, 'build', '--no-bundle', '--config', overlay, '--ci'], repo, buildEnv);
if (!(await exists(exe))) throw new Error(`Tauri build did not produce ${exe}`);

await mkdir(dirname(output), { recursive: true });
await mkdir(output);
await copyFile(exe, join(output, 'fairbeam.exe'));
await copyDirectory(dist, join(output, 'ui'));
await copyResources(output);

const workspace = join(output, 'data', 'workspace');
for (const name of ['projects', 'models', 'templates']) {
  const destination = join(workspace, name);
  if (await isDirectoryEmpty(destination)) {
    await copyDirectory(join(output, name), destination);
  }
}
if (seedModel) {
  const models = join(workspace, 'models');
  await mkdir(models, { recursive: true });
  let name = seedModel.split(/[\\/]/).at(-1);
  let target = join(models, name);
  for (let suffix = 2; await exists(target); suffix += 1) {
    const stem = name.slice(0, -extname(name).length);
    target = join(models, `${stem}-copy-${suffix}${extname(name)}`);
  }
  await copyFile(seedModel, target);
}
if (seedDesign) {
  const models = join(workspace, 'models');
  await mkdir(models, { recursive: true });
  const filename = seedDesign.split(/[\\/]/).at(-1);
  let target = join(models, filename);
  for (let suffix = 2; await exists(target); suffix += 1) {
    const stem = filename.slice(0, -'.design.json'.length);
    target = join(models, `${stem}-copy-${suffix}.design.json`);
  }
  await copyFile(seedDesign, target);
}

await writeFile(join(output, 'preview-defaults.json'), JSON.stringify({
  pythonPath: safePython,
  openemsPath: safeOpenems,
}, null, 2) + '\n');
await writeFile(join(output, 'Run-Fairbeam-Preview.ps1'), getLauncherScript(), 'utf8');
await writeFile(join(output, 'Run-Fairbeam-Preview.cmd'), getLauncherCmd(), 'ascii');
await writeFile(join(output, 'README-LOCAL-TEST.txt'), getReadme(), 'utf8');
await writeFile(join(output, 'PREVIEW-BUILD.json'), JSON.stringify({
  applicationVersion: packageVersion,
  previewOnly: true,
  portable: false,
  applicationIdentifier: previewIdentifier,
  externalPython: safePython || null,
  externalOpenems: safeOpenems || null,
  target: 'windows-x64',
  sourceCommit,
  dirtySourceFiles,
  createdAtUtc: new Date().toISOString(),
  seededDesign: seedDesign ? seedDesign.split(/[\\/]/).at(-1) : null,
  localOnlyPastedModel: seedModel ? seedModel.split(/[\\/]/).at(-1) : null,
}, null, 2) + '\n');

const info = await stat(join(output, 'fairbeam.exe'));
console.log(`Local Windows preview ready: ${output}`);
console.log(`Executable: ${info.size} bytes`);
console.log(`Isolated app identity: ${previewIdentifier}`);
console.log(`External Python: ${safePython || '(none; managed runtime setup will be offered)'}`);
console.log(`openEMS libraries: ${safeOpenems || '(inherited from the current environment)'}`);
console.log(`Workspace: ${workspace}`);

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function isDirectoryEmpty(path) {
  try { return (await readdir(path)).length === 0; } catch { return true; }
}

async function run(command, args, cwd, env) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} failed${signal ? ` (${signal})` : ` (exit ${code})`}`));
    });
  });
}

function gitPaths(args) {
  return execFileSync('git', args, { cwd: repo }).toString('utf8').split('\0').filter(Boolean);
}

async function copyDirectory(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}

async function copyResources(root) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repo }).toString('utf8').split('\0').filter(Boolean);
  const specs = [
    { prefix: 'python/fairbeam/', destination: 'python/fairbeam', extension: '.py' },
    { prefix: 'python/models/', destination: 'models', extension: '.py' },
    { prefix: 'python/templates/', destination: 'templates', extension: '.py' },
    { prefix: 'public/projects/', destination: 'projects' },
  ];
  for (const spec of specs) {
    const matches = tracked.filter((file) => file.startsWith(spec.prefix) && (!spec.extension || file.endsWith(spec.extension)));
    for (const file of matches) {
      const tail = file.slice(spec.prefix.length).split('/').join(sep);
      const destination = join(root, spec.destination, tail);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(repo, file.split('/').join(sep)), destination);
    }
    if (matches.length === 0) throw new Error(`No tracked files found under ${spec.prefix}`);
  }
  for (const [source, destination] of [
    ['runtime/pins.json', 'runtime/pins.json'],
    ['runtime/requirements.txt', 'runtime/requirements.txt'],
    ['runtime/install.py', 'runtime/install.py'],
    ['runtime/setup-runtime.ps1', 'runtime/setup-runtime.ps1'],
    ['runtime/setup-runtime.sh', 'runtime/setup-runtime.sh'],
    ['LICENSE', 'LICENSE.txt'],
    ['NOTICE.md', 'NOTICE.md'],
  ]) {
    const target = join(root, destination);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(repo, source), target);
  }
}

function getLauncherScript() { return String.raw`$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$defaultsPath = Join-Path $root 'preview-defaults.json'
$defaults = Get-Content -LiteralPath $defaultsPath -Raw | ConvertFrom-Json
if (-not $env:APPDATA) { throw 'APPDATA is not available in this Windows session.' }
$configDir = Join-Path $env:APPDATA '${previewIdentifier}'
$settingsPath = Join-Path $configDir 'settings.json'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$settings = @{}
if (Test-Path -LiteralPath $settingsPath) {
  $current = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
  foreach ($property in $current.PSObject.Properties) { $settings[$property.Name] = $property.Value }
}
if (-not $settings.ContainsKey('workspace') -or [string]::IsNullOrWhiteSpace([string]$settings['workspace'])) {
  $settings['workspace'] = Join-Path $root 'data\workspace'
}
if (-not $settings.ContainsKey('prefer_gpu')) { $settings['prefer_gpu'] = $false }
if (-not $settings.ContainsKey('check_updates_on_start')) { $settings['check_updates_on_start'] = $false }
$python = [string]$defaults.pythonPath
$openems = [string]$defaults.openemsPath
foreach ($name in @('OPENEMS_EXPERIMENTAL_CPU_PHASE_DISPATCH', 'OPENEMS_EXPERIMENTAL_CPU_UPML_CURSOR', 'OPENEMS_EXPERIMENTAL_CPU_UPML_ROWS', 'OPENEMS_EXPERIMENTAL_CPU_PROFILE')) {
  [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
if ($openems -and (Test-Path -LiteralPath (Join-Path $openems 'openEMS.exe'))) {
  $env:OPENEMS_INSTALL_PATH = $openems
}
if ($python) {
  if (Test-Path -LiteralPath $python) {
    $settings['runtime'] = 'external'
    $settings['python'] = $python
  } else {
    throw 'The configured preview Python is missing.'
  }
} elseif (-not $settings.ContainsKey('runtime')) {
  $settings['runtime'] = 'managed'
}
$json = ConvertTo-Json -InputObject $settings -Depth 16
$encoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
[System.IO.File]::WriteAllText($settingsPath, $json, $encoding)
$env:FAIRBEAM_NO_UPDATE_CHECK = '1'
# This is the interactive desktop window the user starts to inspect and test.
Start-Process -FilePath (Join-Path $root 'fairbeam.exe') -WorkingDirectory $root -WindowStyle Normal
`; }

function getLauncherCmd() { return String.raw`@echo off
setlocal
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0Run-Fairbeam-Preview.ps1"
if errorlevel 1 pause
`; }

function getReadme() { return String.raw`Fairbeam local Windows preview

Run Run-Fairbeam-Preview.cmd to open this preview. It is an uninstalled folder build for this PC:
it does not run an installer, edit PATH or the registry, or use updater signing keys.
It retains the source application version; PREVIEW-BUILD.json identifies this local branch build.

The preview uses a separate Tauri identity (${previewIdentifier}). Its settings,
logs and any managed runtime are stored in the matching preview-only folders under
%APPDATA% and %LOCALAPPDATA%. The launcher points its workspace to this folder's
data\workspace, where example projects, Python models and any supplied local test inputs
are editable copies. Existing files with the same name receive a numbered copy name.

The launcher disables the update check. An explicitly configured local Python must remain
available; a missing selected runtime stops launch. With no external Python configured,
the app offers its normal managed-runtime setup screen.

This folder is not a portable runtime package. Copying the app folder alone is insufficient.
Keep any configured external Python and native-library installations available.
`;
}
