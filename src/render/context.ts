// The designer-aware half of part lookup: a design's bundle does not carry its material names, but the
// draft does. In the designer a part is classified from its material's name and library entry; a
// result or an example (no draft) is classified from the bundle alone (conductivity, permittivity).
import { draft } from "../designer/store";
import { appMode } from "../workspace";
import { partInfo } from "./materials.ts";
import type { PartInfoLookup } from "./scene.ts";

export function partInfoLookup(): PartInfoLookup {
  if (appMode() !== "design") return (part) => partInfo(part);
  const parts = new Map(draft.parts.map((p) => [p.name, p]));
  const materials = new Map(draft.materials.map((m) => [m.name, m]));
  return (part) => {
    const own = parts.get(part.name);
    const material = own ? materials.get(own.material) : undefined;
    return partInfo(part, { materialName: material?.name ?? own?.material, library: material?.library });
  };
}
