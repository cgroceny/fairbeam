import type { Bundle } from "../types";

/** Only successful loads are remembered; a failed HTTP request can retry on the next poll. */
export class ResultFollow {
  private completed = "";
  private pending: { key: string } | null = null;

  begin(key: string) {
    if (key === this.completed || key === this.pending?.key) return null;
    return this.pending = { key };
  }

  finish(ticket: { key: string }, success: boolean) {
    if (this.pending !== ticket) return;
    this.pending = null;
    if (success) this.completed = ticket.key;
  }

  /** Closing the tabs also dismisses an in-flight result instead of reopening it next poll. */
  dismiss() {
    if (this.pending) this.completed = this.pending.key;
    this.pending = null;
  }

  reset() {
    this.completed = "";
    this.pending = null;
  }
}

/** Named files may have been deliberately overwritten by a run of a different design. */
export function requireDesignResult(bundle: Pick<Bundle, "model" | "preview">, model: string) {
  if (bundle.preview) throw new Error("This file is a geometry preview, not a run result.");
  if (bundle.model.id !== model) throw new Error("This result file was replaced by a run of another design.");
}
