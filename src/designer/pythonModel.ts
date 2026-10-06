import { api } from "../runner/api";
import { closeRunPanel, models, runOpen, setModels } from "../runner/store";
import { setSidePanelCollapsed } from "./layoutState";
import { createDesign, enterDesign, file } from "./store";

/** Choose a Design key beside the existing Python model without replacing either file. */
function designId(sourceId: string, knownModels: ReturnType<typeof models>): string {
  const used = new Set(knownModels.map((m) => m.key));
  const base = `${sourceId.slice(0, 34)}_design`.replace(/_+$/, "");
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const tail = `_${n}`;
    const candidate = `${base.slice(0, 41 - tail.length)}${tail}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Could not choose a unique Design id.");
}

/** Open a Python model as a Design, reusing its existing linked Design when there is one. */
export async function openPythonModelAsDesign(sourceId: string): Promise<string | null> {
  // The Home row can survive a slow/out-of-order refresh that drops the link metadata from its
  // cached model entry. Ask the server immediately before choosing between reuse and creation;
  // otherwise a stale cache can turn the same source into a second `<id>_design_2` file.
  const knownModels = await api.models();
  setModels(knownModels);
  const linked = knownModels.find((m) => m.kind === "design" && m.python_source_model === sourceId);
  let target = linked?.key;
  if (linked) {
    await enterDesign(linked.key);
  } else {
    const source = knownModels.find((m) => m.key === sourceId && m.kind !== "design" && !m.error);
    const model = source?.model ?? { id: sourceId, name: sourceId };
    const created = await createDesign({
      id: designId(sourceId, knownModels),
      name: model.name,
      python: { source_model: sourceId, model },
    });
    if (!created) return null;
    target = created.id;
  }

  if (!target || file()?.id !== target) return null;
  // The RunPanel occupies the designer's right-hand panel. Close it before opening the linked
  // script so the new Design lands with its Python source visible and editable.
  if (runOpen()) closeRunPanel();
  setSidePanelCollapsed(false);
  // A new Design switches workspace branches; wait for the properties/Python panel host to mount
  // before activating its module-level panel state so mount cleanup cannot immediately clear it.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (file()?.id !== target) return null;
  const panel = await import("./PythonPanel");
  if (file()?.id === target) await panel.openPythonPanel();
  return file()?.id === target ? target : null;
}
