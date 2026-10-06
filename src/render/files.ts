// Saving a render: the workspace folder renders/<design-id>/ through the local server (the same server
// that saves designs), with the browser's download as the fallback when no server answers. Also the
// two small actions the dialog offers on a picture: open the folder, copy the image.
import { saveDownload } from "../lib/download";
import { renderFolderId } from "./options.ts";

export interface SavedRender {
  name: string;
  /** the absolute path on this computer, when the server saved it */
  path?: string;
  /** "workspace": saved into renders/<design-id>/; "download": handed to the browser or the Save As dialog */
  via: "workspace" | "download";
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`/api${path}`, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(blob);
  });
}

/** Save one PNG into the design's renders folder. The server answers with the name it used (a name
 *  that is already taken gets a -2, -3, ... suffix, so no render is ever overwritten). */
export async function saveRenderFile(designId: string, name: string, blob: Blob): Promise<SavedRender> {
  let response: Response | null = null;
  try { response = await post(`/renders/${encodeURIComponent(renderFolderId(designId))}`, { name, data: await toBase64(blob) }); }
  catch { response = null; }
  if (response?.ok) {
    const saved = await response.json() as { name: string; path: string };
    return { name: saved.name, path: saved.path, via: "workspace" };
  }
  // no server (the page opened on its own): the usual download, which on the desktop is the Save As dialog
  const result = await saveDownload(name, blob, "image/png");
  if (result.status === "cancelled") throw new Error("cancelled");
  return { name: result.name, path: result.path, via: "download" };
}

/** Open the design's renders folder in the system file manager (the server does it). */
export async function openRendersFolder(designId: string): Promise<void> {
  const response = await post(`/renders/${encodeURIComponent(renderFolderId(designId))}/open`, {});
  if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${response.status}`);
}

/** Put a PNG on the clipboard. False when the browser or webview does not allow it. */
export async function copyImageToClipboard(blob: Blob): Promise<boolean> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch { return false; }
}
