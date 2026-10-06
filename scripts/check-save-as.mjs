import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { designIdError, suggestDesignId } from "../src/lib/designId.ts";

assert.equal(suggestDesignId("  Déjà Vu Copy!"), "de_ja_vu_copy");
assert.equal(designIdError("x", []), "use at least two letters or digits, starting with a letter");
assert.equal(designIdError("con", []), "a name Windows reserves for devices; add a word");
assert.equal(designIdError("antenna_copy", ["antenna_copy"]), "a model with this name exists");
assert.equal(designIdError("antenna_copy", []), "");

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const dialog = await readFile(new URL("../src/designer/SaveAsDialog.tsx", import.meta.url), "utf8");
const home = await readFile(new URL("../src/home/Home.tsx", import.meta.url), "utf8");
assert.ok(app.includes('"file-save-as": () => { if (appMode() === "design" && designFile()) setSaveAsOpen(true); }'));
assert.ok(!app.includes("window.prompt") && !dialog.includes("window.prompt"));
assert.ok(home.includes("suggestDesignId") && home.includes("designIdError"));
assert.ok(dialog.includes("useModal(() => box, close, () => nameInput)"));
assert.ok(dialog.includes("if (dirty() && !(await saveBeforeLeaving()))"));
assert.ok(dialog.includes('createDesign({ id: id(), name: name().trim(), from: props.source.id })'));
assert.ok(dialog.includes('`${id()}.design.json`'));
console.log("Save As validation and wiring checks passed.");
