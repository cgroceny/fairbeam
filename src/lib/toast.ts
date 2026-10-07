// Short-lived feedback that floats over the app (a download requested or saved, an export that
// failed, a file that could not be opened). Toasts never take part in the page layout, so showing
// one never moves the header, the ribbon or the 3D view under the pointer.
//
// One message per action: a surface that reports through a toast shows no inline copy of the same
// text. Information hides by itself; an error stays until it is closed (or replaced by its key).
import { createSignal } from "solid-js";
import { downloadMessage, revealDownloadedFile, type DownloadResult } from "./download.ts";
import { t } from "../i18n/index.ts";

export type ToastTone = "info" | "error";
export interface ToastAction { label: string; run: () => void | Promise<void> }
export interface ToastOptions {
  tone?: ToastTone;
  /** one button beside the text (Show in folder, Retry) */
  action?: ToastAction;
  /** a toast with the same key replaces the shown one instead of stacking */
  key?: string;
  /** called when the user closes the toast (not when it hides by itself or is replaced) */
  onClose?: () => void;
}
export interface Toast extends Required<Pick<ToastOptions, "tone">> {
  id: number;
  text: string;
  key: string;
  action?: ToastAction;
  onClose?: () => void;
}

/** information hides after this long (it pauses while the pointer or the focus is on it) */
export const TOAST_MS = 5000;
/** a toast with an action (Show in folder) stays long enough to reach the button */
export const TOAST_ACTION_MS = 15000;
/** at most this many toasts are shown; the oldest goes first */
export const TOAST_LIMIT = 3;

const [toastList, setToastList] = createSignal<Toast[]>([]);
let nextId = 1;

/** the shown toasts, oldest first */
export const toasts = toastList;

/** How long a toast stays before it hides by itself; null: until it is closed. */
export function toastLifetime(toast: Pick<Toast, "tone" | "action">): number | null {
  if (toast.tone === "error") return null;
  return toast.action ? TOAST_ACTION_MS : TOAST_MS;
}

/** Show a toast. The same text (or the same key) replaces the shown toast, so a repeated click
 * does not stack copies. Returns the toast's id. */
export function showToast(text: string, options: ToastOptions = {}): number {
  const message = text.trim();
  if (!message) return 0;
  const key = options.key ?? message;
  const toast: Toast = { id: nextId++, text: message, key, tone: options.tone ?? "info", action: options.action, onClose: options.onClose };
  setToastList((list) => [...list.filter((x) => x.key !== key), toast].slice(-TOAST_LIMIT));
  return toast.id;
}

/** Hide a toast by id or key; `byUser` runs its onClose (the user dismissed what it reported). */
export function dismissToast(idOrKey: number | string, byUser = false): void {
  const gone = toastList().filter((x) => (typeof idOrKey === "number" ? x.id === idOrKey : x.key === idOrKey));
  if (!gone.length) return;
  setToastList((list) => list.filter((x) => !gone.includes(x)));
  if (byUser) for (const x of gone) x.onClose?.();
}

/** The toast for a download's outcome: "Download requested" in a browser, "Saved to …" with
 * Show in folder in the desktop app, a persistent error when it failed. */
export function downloadToast(result: DownloadResult, detail?: string): number {
  const text = downloadMessage(result, detail);
  const path = result.status === "saved" ? result.path : undefined;
  return showToast(text, {
    tone: result.status === "failed" ? "error" : "info",
    action: path ? {
      label: t("results.toolbar.showInFolder"),
      run: () => revealDownloadedFile(path).catch((error) =>
        void showToast(t("results.toolbar.showInFolderFailed", { error: String(error) }), { tone: "error" })),
    } : undefined,
  });
}
