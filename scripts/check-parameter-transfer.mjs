import assert from "node:assert/strict";
import { exportCsv, exportJson, parseTransfer, previewTransfer } from "../src/designer/parameterTransfer.ts";

const data = [{ key: "W", expression: "2", evaluated: "2", unit: "mm", description: "width, outer\nface" }, { key: "H", expression: "W/2", evaluated: "1", unit: "mm", description: "say \"hi\"" }];
assert.deepEqual(parseTransfer(exportCsv(data), "csv"), data);
assert.deepEqual(parseTransfer(exportJson(data), "json"), data);
assert.deepEqual(parseTransfer("\uFEFF" + exportJson(data), "json"), data);
const preview = previewTransfer(data, [{ key: "W", default: 1, min: 0, max: 3, label: "Width" }]);
assert.equal(preview[0].kind, "changed");
assert.equal(preview[0].param.min, 0);
assert.equal(preview[0].param.label, "Width");
assert.equal(preview[1].kind, "added");
assert.equal(previewTransfer([{ ...data[0], key: "bad-key" }], []).at(0).kind, "error");
assert.equal(previewTransfer([data[0], data[0]], []).at(1).kind, "error");
assert.equal(previewTransfer([{ ...data[1], expression: "Unknown/2" }], []).at(0).kind, "error");
assert.deepEqual(previewTransfer(data, []).map((r) => r.kind), ["added", "added"]);
assert.equal(previewTransfer([{ ...data[0], expression: "0x10" }], []).at(0).kind, "error");
console.log("Parameter CSV/JSON transfer parsing, preview validation and merge preservation passed");

const replacement = previewTransfer([{ ...data[0], unit: "", description: "" }],
  [{ key: "W", expr: "1+1", unit: "mm", description: "old", min: 0 }])[0].param;
assert.equal(replacement.default, 2);
assert.equal(replacement.expr, undefined);
assert.equal(replacement.unit, undefined);
assert.equal(replacement.description, undefined);
assert.equal(replacement.min, 0);
