import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import { partDropDecision } from "../src/designer/navModel.ts";

const parts = [{ component: "" }, { component: "antenna" }, { component: "antenna/feed" }];
assert.deepEqual(partDropDecision(parts, 0, { kind: "root" }), { kind: "move", path: "" }, "root drop");
assert.deepEqual(partDropDecision(parts, 0, { kind: "folder", path: " antenna/feed/ " }), { kind: "move", path: "antenna/feed" }, "folder path normalized");
assert.deepEqual(partDropDecision(parts, 0, { kind: "part", index: 1 }), { kind: "group", onto: 1 }, "part drop groups it");
assert.equal(partDropDecision(parts, 1, { kind: "part", index: 1 }), null, "self drop rejected");
assert.equal(partDropDecision(parts, -1, { kind: "root" }), null, "invalid source rejected");
assert.equal(partDropDecision(parts, 0, { kind: "part", index: 99 }), null, "invalid target rejected");

const source = readFileSync(new URL("../src/designer/NavTree.tsx", import.meta.url), "utf8");
const file = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
let partRows = 0;
function visit(node) {
  if (node?.type === "JSXOpeningElement" && node.name.name === "div") {
    const attributes = new Map(node.attributes.filter((a) => a.type === "JSXAttribute").map((a) => [a.name.name, a]));
    if (attributes.get("role")?.value?.value === "treeitem") {
      partRows++;
      const draggable = attributes.get("draggable")?.value;
      assert.equal(source.slice(draggable?.start, draggable?.end), "{!!part}", "treeitem DOM markup makes part rows draggable");
      assert.ok(attributes.has("onDragStart") && attributes.has("onDragOver") && attributes.has("onDrop"), "treeitem DOM markup wires drag and drop events");
    }
  }
  if (node && typeof node === "object") for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value?.type) visit(value);
  }
}
visit(file);
assert.equal(partRows, 1, "one shared treeitem row declaration checked");
assert.match(source, /"dz-drop": dropTarget !== null && dropAt\(\) === dropTarget\.key/, "highlight targets one row");
console.log("tree drop: 10 checks passed");
