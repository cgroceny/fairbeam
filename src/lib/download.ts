// Browser downloads and the honest wording of their feedback.
//
// An <a download> click only *requests* a download: a browser may save it silently, ask where to
// save it, block it or let the user cancel, and none of that is reported back to the page. So in a
// browser the UI says "Download requested: <name>", never "Saved" or "Downloaded".
//
// The desktop shell does see the outcome: it forwards the webview's download events as an
// "fairbeam:download" window event, matched to the request by its exact URL, so there the message
// becomes "Saved to <path>" (with Show in folder) or failed/cancelled.
import { t } from "../i18n/index.ts";

export type DownloadStatus = "requested" | "saved" | "cancelled" | "failed";

export interface DownloadResult {
  /** the file name offered to the browser */
  name: string;
  status: DownloadStatus;
  path?: string;
  stopTracking?: () => void;
}

function clickAnchor(name: string, href: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  // in the document: Firefox ignores clicks on detached anchors
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
  }
}

/** Request a download of generated content (bytes, a Blob or text) under `name`. Throws only if
 * the content could not be handed to the browser; a blocked or cancelled download is unobservable. */
export function requestDownload(name: string, data: Blob | Uint8Array | string, type = "application/octet-stream", onFinish?: (result: NativeDownloadResult) => void): DownloadResult {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const stopTracking = onFinish ? trackDownload(url, onFinish) : undefined;
  try {
    clickAnchor(name, url);
  } catch (e) {
    stopTracking?.();
    URL.revokeObjectURL(url);
    throw e;
  }
  // the browser reads the blob URL asynchronously (WebKit later than Chromium): revoke it late
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { name, status: "requested", stopTracking };
}

/** Request a download of a URL the page already has (e.g. a canvas data: URL). */
export function requestDownloadUrl(name: string, href: string): DownloadResult {
  clickAnchor(name, href);
  return { name, status: "requested" };
}

/** The visible, announced feedback for a download; `detail` is appended in parentheses. */
export function downloadMessage(r: DownloadResult, detail?: string): string {
  const more = detail ? ` (${detail})` : "";
  switch (r.status) {
    case "saved":
      if (r.path) return t("download.savedTo", { path: r.path, more });
      return t("download.saved", { name: r.name, more });
    case "cancelled":
      if (r.path === undefined) return t("download.cancelled");
      return t("download.cancelledName", { name: r.name });
    case "failed":
      return t("download.failed", { name: r.name, more });
    default:
      return t("download.requested", { name: r.name, more });
  }
}

/** Save generated content through the desktop Save As flow, or request a browser download. */
export async function saveDownload(name: string, data: Blob | Uint8Array | string, type = "application/octet-stream"): Promise<DownloadResult> {
  if (!isDesktopDownload()) return requestDownload(name, data, type);
  let bytes: Uint8Array;
  if (typeof data === "string") bytes = new TextEncoder().encode(data);
  else if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
  else bytes = data;
  return invokeSaveDownload(name, bytes);
}

/** Save an existing URL through desktop Save As; browsers retain the original anchor behavior. */
export async function saveDownloadUrl(name: string, href: string): Promise<DownloadResult> {
  if (!isDesktopDownload()) return requestDownloadUrl(name, href);
  let bytes: Uint8Array;
  if (href.startsWith("data:")) {
    const comma = href.indexOf(",");
    if (comma < 0) throw new Error(t("download.error.dataUrl"));
    const metadata = href.slice(0, comma);
    const payload = href.slice(comma + 1);
    if (/;base64/i.test(metadata)) {
      const binary = atob(payload);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } else bytes = new TextEncoder().encode(decodeURIComponent(payload));
  } else {
    const response = await fetch(href);
    if (!response.ok) throw new Error(t("download.error.readUrl", { status: response.status }));
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  return invokeSaveDownload(name, bytes);
}

async function invokeSaveDownload(name: string, bytes: Uint8Array): Promise<DownloadResult> {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error(t("download.error.noDesktop"));
  if (bytes.byteLength > 200 * 1024 * 1024) throw new Error(t("download.error.tooLarge"));
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const result = await invoke("save_download", { name, bytes: Array.from(bytes), extension }) as { status?: string; path?: string };
  if (result?.status === "cancelled") return { name, status: "cancelled" };
  if (result?.status === "saved" && typeof result.path === "string") return { name, status: "saved", path: result.path };
  throw new Error(t("download.error.invalid"));
}

/** The feedback when the content itself could not be generated or handed over. */
export function downloadFailedMessage(name: string, e: unknown): string {
  const why = e instanceof Error ? e.message : String(e);
  return t("download.exportFailed", { name, error: why || t("download.unknownError") });
}

export type NativeDownloadResult = { path: string; success: boolean };
type NativeDownloadEvent = { url: string; path: string | null; success: boolean };

declare global {
  interface Window {
    __TAURI__?: { core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
  }
}

export function isDesktopDownload(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Attach before requesting the download: other exports must never complete this request. */
export function trackDownload(url: string, onFinish: (result: NativeDownloadResult) => void): () => void {
  if (!isDesktopDownload()) return () => {};
  const stop = () => window.removeEventListener("fairbeam:download", listener);
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<NativeDownloadEvent>).detail;
    if (!detail || detail.url !== url) return;
    stop();
    onFinish({ path: detail.path ?? "", success: detail.success && !!detail.path });
  };
  window.addEventListener("fairbeam:download", listener);
  return stop;
}

export async function revealDownloadedFile(path: string): Promise<void> {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error(t("download.error.noReveal"));
  await invoke("reveal_download", { path });
}
