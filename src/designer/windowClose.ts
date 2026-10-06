// Closing the desktop window or quitting fairbeam (#99). The native shell (src-tauri/src/main.rs)
// holds every close request (the title-bar X, Alt+F4, Close Window, File > Exit, Quit / Cmd+Q)
// and asks this page with `window.fairbeamWindowClose(kind, id)`. The viewer has no IPC, so the
// shell asks again every 150 ms while the answer is "pending": the Save / Don't save / Cancel
// question (CloseProject.tsx) is open. "close" lets the window go, "cancel" keeps it.
//
// Nothing unsaved (no design open, or a clean one with no save running) closes at once. The
// decision itself is the #86 contract: Save must finish cleanly (saveBeforeLeaving), Don't save
// closes the design and drops its local backup (closeDesign).
import { createSignal } from "solid-js";
import { dirty, file, replaceRequest, saving } from "./store";

export type WindowLeave = "window" | "quit";
export type WindowCloseAnswer = "close" | "pending" | "cancel";

/** The open question: how the app is left, and the shell's request number. */
export const [windowClose, setWindowClose] = createSignal<{ kind: WindowLeave; id: number } | null>(null);
/** the choice made in the dialog, handed to the shell on its next question for the same request */
let decided: { id: number; answer: "close" | "cancel" } | null = null;

/** An unsaved draft, or a save that has not finished (the server must not stop under it). */
export const unsavedAtStake = () => !!file() && (dirty() || saving());

export function answerWindowClose(kind: WindowLeave, id: number): WindowCloseAnswer {
  const open = windowClose();
  if (open) {
    // Quit while "close the window?" is asked: the same question, about quitting
    if (open.id !== id || (kind === "quit" && open.kind !== "quit")) setWindowClose({ kind: kind === "quit" ? "quit" : open.kind, id });
    return "pending";
  }
  const choice = decided;
  decided = null;
  if (choice?.id === id && choice.answer === "cancel") return "cancel";
  // "close" is honoured only while nothing is at stake: an edit or a save since then asks again
  if (!unsavedAtStake()) return "close";
  // the open "Save changes before creating/opening…?" question has to be answered first
  if (replaceRequest()) return "cancel";
  setWindowClose({ kind, id });
  return "pending";
}

/** The dialog's outcome: after a successful Save or Don't save ("close"), or Cancel. */
export function decideWindowClose(answer: "close" | "cancel") {
  const open = windowClose();
  if (!open) return;
  decided = { id: open.id, answer };
  setWindowClose(null);
}
