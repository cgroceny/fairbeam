import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import ArrayPanel from "../../src/components/ArrayPanel";
import type { ArraySession } from "../../src/lib/arraySession";

/** Browser-test mount only; Vite resolves the same Solid instance as the actual UI. */
export function checkArrayPanelIds(session: ArraySession) {
  const host = document.createElement("div");
  host.dataset.arrayIdControl = "";
  document.body.append(host);
  const dispose = render(() => createComponent(ArrayPanel, { session }), host);
  try {
    const ids = [...document.querySelectorAll(".array-panel [id]")].map(e => e.id);
    if (new Set(ids).size !== ids.length) throw new Error("Array panel ids collide");
    for (const label of document.querySelectorAll<HTMLLabelElement>(".array-panel label[for]"))
      if (!document.getElementById(label.htmlFor)) throw new Error("Array label has no target");
  } finally { dispose(); host.remove(); }
}
