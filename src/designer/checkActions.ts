// Client-side actions of a design check, beside the server's fix button (which edits a value): the
// feed checks have no single edit when the design has no port or the feed floats where no metal face
// is near, so they offer to add a discrete port instead ("Add a discrete port…" opens the same
// dialog as the ribbon). Pure (no Solid, no DOM), so scripts/check-check-actions.mjs tests it.
import type { Check } from "./checks.ts";

export type CheckAction = "add-port";

/** The extra action of a check, or null. `ports` is how many ports the design has: a design whose
 * ports are all switched off ("no port is excited") needs one switched on, not another port. */
export function checkAction(c: Pick<Check, "code">, ports: number): CheckAction | null {
  if (c.code === "no-port" && ports === 0) return "add-port";
  if (c.code === "port-floating") return "add-port";
  return null;
}
