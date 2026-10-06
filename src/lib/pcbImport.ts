// Whether the "Import PCB artwork" dialog (src/components/PcbImportDialog.tsx) is open. The Start
// page, the designer's Home ribbon and File > Import PCB Artwork… open it.
import { createSignal } from "solid-js";

export const [pcbImportOpen, setPcbImportOpen] = createSignal(false);
