// Progress of the desktop app's in-app update. The shell (src-tauri/src/update_progress.rs) sends a
// `fairbeam:update` window event for each phase and keeps the latest payload in
// `window.__fairbeamUpdate`, for a page that loads after the update began. Phases:
//   downloading {version, downloaded, total|null}   the server keeps running
//   installing {version}                            the server is stopped; it is not an error
//   restarting {version}
//   failed                                          hides the indicator (the shell shows the error)
// The indicator is components/UpdateProgress.tsx; the store keeps quiet about a stopped server while
// `updateInstalling()` (runner/store.ts).
import { createSignal } from "solid-js";
import { t } from "../i18n/index.ts";

export type UpdateState =
  | { phase: "downloading"; version: string; downloaded: number; total: number | null }
  | { phase: "installing"; version: string }
  | { phase: "restarting"; version: string };

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** A payload from the shell as a state; "failed", an unknown phase or a malformed payload as null (hidden). */
export function parseUpdateEvent(raw: unknown): UpdateState | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const version = typeof p.version === "string" ? p.version.slice(0, 64) : "";
  switch (p.phase) {
    case "downloading": {
      if (!version || !isCount(p.downloaded)) return null;
      const total = isCount(p.total) && p.total > 0 ? p.total : null;
      return { phase: "downloading", version, downloaded: p.downloaded, total };
    }
    case "installing": return version ? { phase: "installing", version } : null;
    case "restarting": return version ? { phase: "restarting", version } : null;
    default: return null;
  }
}

/** Megabytes (10^6 bytes) with one decimal and a decimal point, whatever the UI language. */
export function formatMb(bytes: number): string {
  return (Math.max(0, bytes) / 1e6).toFixed(1);
}

/** 0..1 for a determinate bar, null when the total is unknown. */
export function fraction(state: UpdateState): number | null {
  if (state.phase !== "downloading" || state.total === null) return null;
  return Math.min(1, Math.max(0, state.downloaded / state.total));
}

/** The one line the indicator shows (the same text goes to screen readers, minus the numbers). */
export function updateText(state: UpdateState): string {
  if (state.phase === "installing") return t("update.progress.installing", { version: state.version });
  if (state.phase === "restarting") return t("update.progress.restarting");
  return state.total === null
    ? t("update.progress.downloadingUnknown", { version: state.version, done: formatMb(state.downloaded) })
    : t("update.progress.downloading", { version: state.version, done: formatMb(state.downloaded), total: formatMb(state.total) });
}

/** Text for assistive technology: the phase without the changing numbers, so a download does not
 * announce ten times a second. */
export function updateAnnouncement(state: UpdateState): string {
  if (state.phase === "downloading") return t("update.progress.downloadingStart", { version: state.version });
  return updateText(state);
}

export const [updateState, setUpdateState] = createSignal<UpdateState | null>(null);
/** The server is stopped on purpose and the app is about to restart: a lost server is no failure. */
export const updateInstalling = () => {
  const s = updateState();
  return s?.phase === "installing" || s?.phase === "restarting";
};

type Host = { addEventListener: (type: string, fn: (e: Event) => void) => void; removeEventListener: (type: string, fn: (e: Event) => void) => void; __fairbeamUpdate?: unknown };

/** Follow the shell's updates; returns the cleanup. `onFailed` runs when an update attempt failed
 * (the server was stopped and is started again by the shell). */
export function watchUpdate(win: Host = window as unknown as Host, onFailed: () => void = () => {}): () => void {
  const apply = (raw: unknown) => {
    const was = updateInstalling();
    const next = parseUpdateEvent(raw);
    setUpdateState(next);
    if (!next && was) onFailed();
  };
  const onEvent = (e: Event) => apply((e as CustomEvent).detail);
  win.addEventListener("fairbeam:update", onEvent);
  if (win.__fairbeamUpdate !== undefined) apply(win.__fairbeamUpdate);
  return () => { win.removeEventListener("fairbeam:update", onEvent); setUpdateState(null); };
}
