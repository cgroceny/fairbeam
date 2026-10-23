import { safeDiagnosticText } from './startup-diagnostics.mjs';

// Always attempt both owned resources. Cleanup must not replace an existing test failure.
export async function cleanupBrowserScenario(browser, stack, failed = false) {
  const errors = [];
  try { await browser?.close(); } catch (error) { errors.push(error); }
  try { await stack?.stop(); } catch (error) { errors.push(error); }
  if (!errors.length) return;
  if (failed) {
    console.error('Cleanup failed after the primary test failure:',
      ...errors.map(error => safeDiagnosticText(String(error?.stack || error))));
  } else throw new AggregateError(errors, 'Browser scenario cleanup failed');
}
