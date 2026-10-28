// Serial SDK-free Python/TypeScript parity and saved-source/export integration.
// Uses only an owned temporary fixture directory; no app state, browser or solver.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const venv = win ? join(root, '.venv', 'Scripts', 'python.exe') : join(homedir(), 'opt/openEMS/venv/bin/python');
const python = process.env.FAIRBEAM_PYTHON ?? (existsSync(venv) ? venv : win ? 'python' : 'python3');
const tempRoot = realpathSync(tmpdir());
const scratch = mkdtempSync(join(tempRoot, 'fairbeam-requirements-check-'));
const options = { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } };
try {
  const parity = join(scratch, 'parity.json');
  const integration = join(scratch, 'integration.json');
  execFileSync(python, [join(root, 'python/tests/test_requirements.py'), '--dump', parity], options);
  execFileSync(process.execPath, ['--experimental-strip-types', join(root, 'scripts/check-requirements.mjs'), parity], options);
  execFileSync(python, [join(root, 'python/tests/test_requirements.py'), '--integration-dump', integration], options);
  execFileSync(process.execPath, ['--experimental-strip-types', join(root, 'scripts/check-requirements-integration.mjs'), integration], options);
} finally {
  // Refuse cleanup if this owned directory was replaced or escaped the resolved temp parent.
  const realScratch = realpathSync(scratch);
  if (lstatSync(scratch).isSymbolicLink() || realScratch !== scratch || dirname(realScratch) !== tempRoot)
    throw new Error(`Refusing cleanup of replaced requirements fixture directory: ${scratch}`);
  rmSync(scratch, { recursive: true });
}
