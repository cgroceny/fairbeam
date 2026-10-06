import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sweep = await readFile(new URL("../src/runner/sweep.ts", import.meta.url), "utf8");
const history = await readFile(new URL("../src/runner/RunHistory.tsx", import.meta.url), "utf8");
const progress = await readFile(new URL("../src/runner/ProgressCard.tsx", import.meta.url), "utf8");

// Guard the full-data contract: stable shared columns, every job retained, metadata preferred,
// and CSV quoting covers commas, quotes and line breaks (RFC 4180 style).
assert.match(sweep, /export function sweepLongTable\(g: SweepGroup\)/);
assert.match(sweep, /\["run_index", "sequence_index", "sequence_name", "status", \.\.\.g\.keys, "band_center_ghz", "s11_min_db", "dmax_dbi", "radiation_efficiency_pct"\]/);
assert.match(sweep, /const rows = g\.jobs\.map/);
assert.match(sweep, /meta\.sequence_index \?\? 0/);
assert.match(sweep, /meta\.sequence_name \?\? ""/);
assert.match(sweep, /s\.replaceAll\('\"', '\"\"'\)/);
assert.match(sweep, /join\("\\r\\n"\)/);

// UI checks: Compare all expands the group's table; copy/export use the same long-format payload;
// table data is not filtered to successful runs. The pin limit remains a chart-only concern.
const enUi = JSON.parse(await readFile(new URL("../src/i18n/en.json", import.meta.url), "utf8"));
assert.match(history, /t\("runHistory\.compareAll"\)/);
assert.equal(enUi["runHistory.compareAll"], "Compare all");
assert.match(history, /sweepLongCsv\(props\.group\)/);
assert.match(history, /saveDownload\(.*text\/csv;charset=utf-8/s);
assert.match(history, /<SweepSummary group=\{g\(\)\} \/>/);
assert.match(progress, /cancelSweep\(job\(\)\.sweep!\.id\)/);
assert.match(progress, /sweepProgress\(\)\?\.done.*sw\(\)\.total/);
// run order: by the server's run index, which runs across the sequences in order
assert.match(sweep, /g\.jobs\.sort\(\(a, b\) => a\.sweep!\.index - b\.sweep!\.index\)/);
assert.doesNotMatch(sweep, /sequence_index \?\? a\.sweep!\.index/, "sequence_index alone ties within a sequence");
// the designer dialog: live progress while active, Stop only then, errors of Stop shown, a11y
const dialog = await readFile(new URL("../src/designer/SweepDialog.tsx", import.meta.url), "utf8");
assert.match(dialog, /if \(!active\(\)\) return;\s*const timer = setInterval\(\(\) => void refreshRuns\(\), 1000\);\s*onCleanup\(\(\) => clearInterval\(timer\)\);/s, "poll the run list only while the sweep is active");
assert.match(dialog, /const current = \(\) => group\(\)\.find\(\(j\) => j\.status === "running"\)/, "current = the running run");
assert.match(dialog, /<Show when=\{active\(\)\}>\s*<button[^>]*onClick=\{\(\) => void stop\(\)\}/s, "Stop only while runs are queued or running");
// the dialog's texts are i18n keys (src/i18n/en.json)
const en = JSON.parse(await readFile(new URL("../src/i18n/en.json", import.meta.url), "utf8"));
assert.match(dialog, /setNotice\(t\("sweep\.err\.stop", \{ error:/);
assert.equal(en["sweep.err.stop"], "Could not stop the sweep: {error}");
assert.doesNotMatch(dialog, />\s*Edit\s*</, "no placeholder Edit button");
assert.match(dialog, /aria-label=\{t\("sweep\.parameterN", \{ n: i\(\) \+ 1 \}\)\}/);
assert.equal(en["sweep.parameterN"], "Parameter {n}");
assert.match(dialog, /aria-label=\{t\("sweep\.kindAria", \{ key: axis\.key \}\)\}/);
assert.equal(en["sweep.kindAria"], "Values of {key}: range or list");
assert.match(dialog, /aria-pressed=\{selected\(\) === i\(\)\}/);
assert.doesNotMatch(dialog, /<(X|Plus|CircleAlert|LoaderCircle) size=\{\d+\}(?![^>]*aria-hidden)[^>]*>/, "icons are aria-hidden");
assert.doesNotMatch(dialog, /cells checked/, "a passed Check is a status line, not an alert");
assert.match(dialog, /<p class="note" role="status">\{info\(\)\}<\/p>/);
console.log("sweep long table, all-run selection, CSV escaping/export and cancellation: ok");
