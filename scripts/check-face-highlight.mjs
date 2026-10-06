import assert from "node:assert/strict";
import { clearFaceHighlight, emptyFaceHighlight, faceBoundary, hoverFace, selectFace } from "../src/scene/faceHighlight.ts";

const a = { id: "a" }, b = { id: "b" };
let state = emptyFaceHighlight();
state = hoverFace(state, a);
assert.equal(state.hover, a); assert.equal(state.selected, null);
state = selectFace(state, a);
state = hoverFace(state, b);
assert.equal(state.hover, b); assert.equal(state.selected, a, "selected face survives candidate hover");
state = selectFace(state, null);
assert.equal(state.hover, b); assert.equal(state.selected, null, "closing selection preserves independent hover");
state = clearFaceHighlight(state);
assert.deepEqual(state, { hover: null, selected: null });

const square = [[0,0,0],[1,0,0],[1,1,0], [0,0,0],[1,1,0],[0,1,0]];
assert.equal(faceBoundary(square).length, 8, "two triangles yield four boundary edges, excluding the diagonal");
console.log("Face highlight: hover, selected, clear transitions and triangle boundary passed");
