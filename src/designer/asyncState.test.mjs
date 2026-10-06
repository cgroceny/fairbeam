import assert from "node:assert/strict";
import test from "node:test";
import { DesignerAsyncState } from "./asyncState.ts";

test("the last navigation wins, and deleting its target cancels it", () => {
  const state = new DesignerAsyncState();
  const first = state.startNavigation();
  const second = state.startNavigation();
  assert.equal(state.isNavigationCurrent(first), false);
  assert.equal(state.isNavigationCurrent(second), true);
  state.cancelNavigation();
  assert.equal(state.isNavigationCurrent(second), false);
});

test("a save may update its document baseline after a newer edit, but not its draft checks", () => {
  const state = new DesignerAsyncState();
  state.replaceDocument();
  const saving = state.ticket();
  state.editDraft();
  assert.equal(state.isDocumentCurrent(saving), true);
  assert.equal(state.isDraftCurrent(saving), false);
  state.replaceDocument();
  assert.equal(state.isDocumentCurrent(saving), false);
});

test("queued and running previews expire on edit, replacement, or explicit invalidation", () => {
  const state = new DesignerAsyncState();
  const first = state.ticket();
  state.invalidatePreview();
  assert.equal(state.isPreviewCurrent(first), false);
  const second = state.ticket();
  state.editDraft();
  assert.equal(state.isPreviewCurrent(second), false);
  const third = state.ticket();
  state.replaceDocument();
  assert.equal(state.isPreviewCurrent(third), false);
  assert.equal(state.isPreviewCurrent(state.ticket()), true);
});
