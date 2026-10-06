/** The app-wide file drop (#87): only a drag that carries files shows the drop hint and opens (a
 * project bundle) or imports (reference data). Other drags, such as a navigation-tree part
 * (application/x-fairbeam-part), text or a link, are left to their own targets: the hint would
 * cover the tree and take the drop. */
export const carriesFiles = (dt: DataTransfer | null | undefined): boolean =>
  !!dt && Array.from(dt.types ?? []).includes("Files");

/** A dragged link (from a browser tab or the address bar), not our own part drag. Dropped on the
 * page, the browser would navigate to it and the open work would be lost. */
const carriesLink = (dt: DataTransfer | null | undefined): boolean =>
  !!dt && Array.from(dt.types ?? []).includes("text/uri-list");

/** Text fields take dropped text and links themselves. */
const editable = (t: EventTarget | null): boolean =>
  typeof Element !== "undefined" && t instanceof Element && !!t.closest("input, textarea, [contenteditable]:not([contenteditable=false])");

export function fileDropHandlers(setDragging: (on: boolean) => void, open: (f: File) => void) {
  return {
    onDragOver: (e: DragEvent) => {
      if (carriesFiles(e.dataTransfer)) {
        e.preventDefault();
        setDragging(true);
      } else if (carriesLink(e.dataTransfer) && !editable(e.target)) {
        e.preventDefault(); // accept it, only so that the drop below can cancel the navigation
      }
    },
    onDragLeave: (e: DragEvent) => { if (e.currentTarget === e.target) setDragging(false); },
    onDrop: (e: DragEvent) => {
      setDragging(false);
      if (carriesFiles(e.dataTransfer)) {
        e.preventDefault();
        const f = e.dataTransfer?.files?.[0];
        if (f) open(f);
      } else if (carriesLink(e.dataTransfer) && !editable(e.target)) {
        e.preventDefault(); // a link dropped outside a text field: do not navigate away
      }
    },
  };
}
