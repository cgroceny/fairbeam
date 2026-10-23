// Pure owned-resource lifecycle controls. No browser, child process, server or filesystem work.
import assert from 'node:assert/strict';
import { cleanupBrowserScenario } from './scenarios/cleanup-browser.mjs';

let cases = 0;
const closeFailure = new Error('Synthetic browser close failed');
const stopFailure = new Error('Synthetic stack stop failed');
const resources = (calls, closeError, stopError) => ({
  browser: { async close() { calls.push('close'); if (closeError) throw closeError; } },
  stack: { async stop() { calls.push('stop'); if (stopError) throw stopError; } },
});

{
  const calls = [], { browser, stack } = resources(calls);
  await cleanupBrowserScenario(browser, stack);
  assert.deepEqual(calls, ['close', 'stop'], 'successful cleanup attempts each owned resource once');
  cases++;
}
for (const [closeError, stopError] of [[closeFailure, undefined], [undefined, stopFailure], [closeFailure, stopFailure]]) {
  const calls = [], { browser, stack } = resources(calls, closeError, stopError);
  await assert.rejects(() => cleanupBrowserScenario(browser, stack), error => {
    assert.ok(error instanceof AggregateError, 'cleanup failure must fail an otherwise successful test');
    assert.deepEqual(error.errors, [closeError, stopError].filter(Boolean), 'retain exact failures in resource order');
    return true;
  });
  assert.deepEqual(calls, ['close', 'stop'], 'one cleanup failure cannot skip the other owned resource');
  cases++;
}
{
  const primary = new Error('Synthetic original assertion failure');
  const calls = [], { browser, stack } = resources(calls, closeFailure, stopFailure);
  const reports = [], originalError = console.error;
  let caught;
  console.error = (...values) => reports.push(values.map(String).join(' '));
  try {
    try { throw primary; }
    finally { await cleanupBrowserScenario(browser, stack, true); }
  } catch (error) { caught = error; }
  finally { console.error = originalError; }
  assert.equal(caught, primary, 'the actual pending assertion error survives both cleanup failures');
  assert.deepEqual(calls, ['close', 'stop']);
  assert.ok(reports.some(report => report.includes(closeFailure.message)), 'close failure remains visible');
  assert.ok(reports.some(report => report.includes(stopFailure.message)), 'stop failure remains visible');
  cases++;
}
{
  const calls = [], { browser, stack } = resources(calls);
  await cleanupBrowserScenario(undefined, stack);
  assert.deepEqual(calls, ['stop'], 'failed browser launch still leaves an owned stack to stop');
  cases++;
  calls.length = 0;
  await cleanupBrowserScenario(browser, undefined);
  assert.deepEqual(calls, ['close'], 'missing stack does not prevent browser cleanup');
  cases++;
  await cleanupBrowserScenario(undefined, undefined);
  assert.deepEqual(calls, ['close'], 'nothing was acquired: no resource operation is invented');
  cases++;
}
console.log(`Browser cleanup: ${cases} pure lifecycle cases passed; no processes or browser launched.`);
