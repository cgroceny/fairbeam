import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planChecks, runChecks, groups} from './check-ci-web.mjs';

const fixture = {
  'check:first': 'node a.mjs && npm run -s check:shared && node --conditions=browser b.mjs',
  'check:second': 'npm run -s check:shared && node b.mjs',
  'check:shared': 'node shared.mjs',
};
const p = planChecks(fixture, ['check:first', 'check:second']);
assert.equal(p.duplicates, 1);
assert.deepEqual(p.checks.map(c => c.command), ['node a.mjs', 'node shared.mjs', 'node --conditions=browser b.mjs', 'node b.mjs']);
const completed = [];
await runChecks(p, async check => completed.push(check.command));
assert.equal(completed.length, 4);
const failed = [];
await assert.rejects(runChecks(p, async check => { failed.push(check.command); if (failed.length === 2) throw new Error('test failure'); }), /test failure/);
assert.deepEqual(failed, ['node a.mjs', 'node shared.mjs']);
assert.throws(() => planChecks({'check:x': 'npm run -s check:x'}, ['check:x']), /Recursive/);
assert.throws(() => planChecks({}, ['check:missing']), /Missing/);
for (const cmd of ['node a.mjs; echo ok', 'node a.mjs || true', 'node a.mjs > hidden.log', 'node "a b.mjs"']) {
  assert.throws(() => planChecks({'check:x':cmd}, ['check:x']), /Unsupported/);
}
// Coverage comes from the repository's real groups, not a second hand-maintained list.
const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
const actual = planChecks(scripts);
const individually = groups.flatMap(group => planChecks(scripts, [group]).checks.map(c => JSON.stringify(c.args)));
assert.deepEqual(new Set(actual.checks.map(c => JSON.stringify(c.args))), new Set(individually));
assert(actual.duplicates > 0);
console.log(`CI web planning passed: full command coverage, exact-argument deduplication, fail-fast, and unsupported syntax refusal; ${actual.checks.length} commands, ${actual.duplicates} repeats removed.`);
