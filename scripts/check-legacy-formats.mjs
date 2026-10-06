// Proof that what antenlab (0.6.x) wrote still opens in the viewer, and that the one-time storage
// carry-over and the import step's preference handoff behave. The fixtures are the 0.6.8 files in
// python/tests/fixtures/legacy/ (the Python side opens the same files: tests/test_legacy_formats.py).
//
//   node --experimental-strip-types scripts/check-legacy-formats.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { designChecks } from "../src/designer/checks.ts";
import { clearBackup, readBackup, writeBackup } from "../src/designer/draftBackup.ts";
import { applyImportedViewerPrefs } from "../src/lib/importedPrefs.ts";
import {
  CARRY_OVER_DONE_KEY, LEGACY_SCHEMAS, carryOverLegacyStorage, currentSchema, isLegacySchema, isReservedName, schemaFamily,
} from "../src/lib/legacy.ts";
import { validateBundle } from "../src/lib/validate.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name) => readFileSync(join(root, "python/tests/fixtures/legacy", name), "utf8");
let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks++; };
const eq = (a, b, what) => { assert.deepEqual(a, b, what); checks++; };

const store = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { m, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

// 1. schema ids: every old id maps to the new one, other values come back unchanged
for (const [old, now] of Object.entries(LEGACY_SCHEMAS)) {
  eq(currentSchema(old), now, old);
  ok(isLegacySchema(old) && !isLegacySchema(now), `${old} is the only legacy spelling`);
}
eq(currentSchema("fairbeam.design/1"), "fairbeam.design/1", "current ids stay");
eq(currentSchema(undefined), undefined, "a missing id stays missing");
eq(currentSchema("other.design/1"), "other.design/1", "foreign ids stay");
ok(schemaFamily("antenlab.project/2", "fairbeam.project/") && schemaFamily("fairbeam.project/7", "fairbeam.project/"), "families");
ok(!schemaFamily("other.project/1", "fairbeam.project/") && !schemaFamily(null, "fairbeam.project/"), "other families are not accepted");

// 2. a 0.6.8 project bundle opens, and is read as a current one
{
  const raw = JSON.parse(fixture("antenlab-0.6.8.project.json"));
  eq(raw.schema, "antenlab.project/1", "the fixture is in the old format");
  const v = validateBundle(raw);
  ok(v.bundle !== null, `the legacy bundle opens: ${v.errors.join("; ")}`);
  eq(v.errors, [], "no errors");
  eq(v.bundle.schema, "fairbeam.project/1", "read as a current bundle");
  const newer = validateBundle({ ...JSON.parse(fixture("antenlab-0.6.8.project.json")), schema: "antenlab.project/2" });
  ok(newer.bundle !== null && newer.warnings.length > 0, "a newer legacy schema opens with a warning");
  ok(validateBundle({ ...JSON.parse(fixture("antenlab-0.6.8.project.json")), schema: "other.project/1" }).bundle === null, "a foreign schema is refused");
}

// 3. a 0.6.8 design: the checks run on it; a draft kept under the old id is restored as a current one
{
  const design = JSON.parse(fixture("antenlab-0.6.8.design.json"));
  eq(design.schema, "antenlab.design/1", "the fixture is in the old format");
  ok(!designChecks(design).some((c) => c.severity === "error"), "the design checks find no error in the legacy design");
  const ls = store();
  globalThis.localStorage = ls;
  const scope = "models-v1:" + "c".repeat(64);
  writeBackup(design.model.id, "base", design, scope);
  const written = [...ls.m.keys()][0];
  ok(written.startsWith("fairbeam:draft:v2:"), `new drafts use the fairbeam key: ${written}`);
  const back = readBackup(design.model.id, "base", scope);
  ok(back !== null, "a draft with the old design id is accepted");
  eq(back.design.schema, "fairbeam.design/1", "and comes back as a current design");
  clearBackup(design.model.id, scope);
  delete globalThis.localStorage;
}

// 4. a 0.6.8 parameter sweep file: its id is the old one, which the import dialog maps
{
  const sweep = JSON.parse(fixture("antenlab-0.6.8.sweep.json"));
  eq(currentSchema(sweep.schema), "fairbeam.parameter-sweep/1", "sweep");
  ok(Array.isArray(sweep.sequences) && sweep.sequences.length === 2, "two sequences");
  eq(currentSchema(JSON.parse(fixture("antenlab-0.6.8.study.json")).schema), "fairbeam.study/1", "study");
}

// 5. reserved names: the program's own prefix, and the old one
ok(isReservedName("fairbeam_J_1") && isReservedName("antenlab_F_0"), "both prefixes are reserved");
ok(!isReservedName("patch") && !isReservedName("my_antenlab"), "other names are not");

// 6. web carry-over: old keys are copied once, never over a new key, and the old ones stay
{
  const s = store({
    "antenlab.theme": "dark", "antenlab.generalSettings": '{"units":"compact"}', "antenlab:draft:v2:s:id:b": "{}",
    "fairbeam.generalSettings": '{"units":"standard"}', "unrelated": "x",
  });
  eq(carryOverLegacyStorage(s), 2, "two keys copied");
  eq(s.getItem("fairbeam.theme"), "dark", "theme");
  eq(s.getItem("fairbeam:draft:v2:s:id:b"), "{}", "drafts");
  eq(s.getItem("fairbeam.generalSettings"), '{"units":"standard"}', "an existing new key wins");
  eq(s.getItem("antenlab.theme"), "dark", "the old key stays");
  ok(s.getItem(CARRY_OVER_DONE_KEY) !== null, "marked as done");
  s.removeItem("fairbeam:draft:v2:s:id:b");
  eq(carryOverLegacyStorage(s), 0, "a second run copies nothing");
  eq(s.getItem("fairbeam:draft:v2:s:id:b"), null, "a cleared draft does not come back");
  eq(carryOverLegacyStorage(store({ "fairbeam.theme": "light" })), 0, "nothing old: nothing copied");
  const broken = { get length() { throw new Error("blocked"); } };
  eq(carryOverLegacyStorage(broken), 0, "unavailable storage is not an error");
}

// 7. the desktop handoff: only fairbeam.* string values are written
{
  const s = store({ "fairbeam.theme": "light" });
  eq(applyImportedViewerPrefs({ "fairbeam.theme": "dark", "fairbeam.home.favoriteDesigns": '["a"]', "antenlab.theme": "x", "fairbeam.n": 3, other: "y" }, s), 2, "two written");
  eq([...s.m.entries()], [["fairbeam.theme", "dark"], ["fairbeam.home.favoriteDesigns", '["a"]']], "the imported value replaces the default");
  eq(applyImportedViewerPrefs(null, s) + applyImportedViewerPrefs([], s) + applyImportedViewerPrefs("x", s), 0, "nothing to import");
}

console.log(`legacy formats: ${checks} checks passed (0.6.8 bundle, design, sweep and study open; storage carry-over; viewer preference handoff)`);
