// Pure Design validation/parameter-reference parity; no browser, server, solver or native build.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { designChecks } from "../src/designer/checks.ts";
import { parameterUses, renameParameter } from "../src/designer/paramRefs.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const venv = win ? join(root, ".venv", "Scripts", "python.exe") : join(homedir(), "opt/openEMS/venv/bin/python");
const python = process.env.FAIRBEAM_PYTHON ?? (existsSync(venv) ? venv : win ? "python" : "python3");
const code = `import json, sys, types
from pathlib import Path
pkg = types.ModuleType('fairbeam')
pkg.__path__ = [str(Path.cwd() / 'python' / 'fairbeam')]
sys.modules['fairbeam'] = pkg
from designer_fixture import load, case_design, key
from fairbeam.design_checks import lint
out = []
for case in load()['cases']:
    if not case['name'].startswith('far-field angular steps'):
        continue
    design = case_design(case)
    out.append(dict(name=case['name'], design=design, expected=case['expect'], checks=sorted(key(c) for c in lint(design))))
print(json.dumps(out))`;
const cases = JSON.parse(execFileSync(python, ["-c", code], {
  cwd: root, windowsHide: true,
  env: { ...process.env, PYTHONPATH: [join(root, "python"), join(root, "python/tests")].join(delimiter) },
}).toString());
assert.equal(cases.length, 13);
for (const c of cases) {
  const checks = designChecks(c.design).map(x => `${x.severity}|${x.code}|${x.path}`).sort();
  assert.deepEqual(checks, [...c.expected].sort(), `${c.name}: TypeScript`);
  assert.deepEqual(c.checks, checks, `${c.name}: Python parity`);
}
const d = structuredClone(cases.find(c => c.name.endsWith("expressions")).design);
assert.ok(parameterUses(d, "f0").includes("far_field.theta_step"));
assert.ok(parameterUses(d, "f0").includes("far_field.phi_step"));
renameParameter(d, "f0", "center_frequency");
assert.equal(d.far_field.theta_step, "center_frequency / 2");
assert.equal(d.far_field.phi_step, "center_frequency");
assert.deepEqual(designChecks(d), []);
console.log(`check-pattern-resolution: ${cases.length} TypeScript/Python cases and parameter rename passed`);
