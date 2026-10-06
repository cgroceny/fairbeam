// Whether the "Import CST macro" dialog (src/components/CstImportDialog.tsx) is open. The Start
// page, the designer's Home ribbon and File > Import CST macro… open it.
import { createSignal } from "solid-js";

export const [cstImportOpen, setCstImportOpen] = createSignal(false);
