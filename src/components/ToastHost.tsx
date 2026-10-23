// The one place toasts are drawn (src/lib/toast.ts): fixed in the bottom-right corner, above the
// status bar, outside the page layout. Information is announced politely and hides by itself
// (paused while hovered or focused); an error is an alert that stays until it is closed.
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { CircleAlert, CircleCheck, X } from "lucide-solid";
import { dismissToast, toastLifetime, toasts, type Toast } from "../lib/toast";
import { t } from "../i18n";

function ToastItem(props: { toast: Toast }) {
  let el!: HTMLDivElement;
  let timer: number | undefined;
  let left = toastLifetime(props.toast);
  let started = 0;
  const stop = () => {
    if (timer === undefined || left === null) return;
    window.clearTimeout(timer); timer = undefined;
    left = Math.max(1000, left - (Date.now() - started));
  };
  const start = () => {
    if (timer !== undefined || left === null) return;
    // never hide while the pointer or the keyboard focus is on it
    if (el.matches(":hover") || el.contains(document.activeElement)) return;
    started = Date.now();
    timer = window.setTimeout(() => dismissToast(props.toast.id), left);
  };
  onMount(start);
  onCleanup(() => { if (timer !== undefined) window.clearTimeout(timer); });
  const error = () => props.toast.tone === "error";
  return (
    <div ref={el} class="toast" classList={{ "toast-error": error() }} data-toast-key={props.toast.key}
      role={error() ? "alert" : undefined} aria-live={error() ? "assertive" : undefined} aria-atomic={error() ? "true" : undefined}
      onPointerEnter={stop} onPointerLeave={() => queueMicrotask(start)} onFocusIn={stop}
      onFocusOut={(e) => { if (!el.contains(e.relatedTarget as Node | null)) queueMicrotask(start); }}>
      <Show when={error()} fallback={<CircleCheck aria-hidden="true" />}><CircleAlert aria-hidden="true" /></Show>
      <span class="toast-text">{props.toast.text}</span>
      <Show when={props.toast.action}>{(action) => (
        <button type="button" class="btn btn-ghost btn-sm toast-action" onClick={() => { dismissToast(props.toast.id); void action().run(); }}>{action().label}</button>
      )}</Show>
      <button type="button" class="icon-btn icon-btn-sm toast-close" aria-label={t("common.close")} title={t("common.close")}
        onClick={() => dismissToast(props.toast.id, true)}><X size={13} aria-hidden="true" /></button>
    </div>
  );
}

export default function ToastHost() {
  const [announcement, setAnnouncement] = createSignal("");
  let lastInfoId = 0;
  let announceTimer: number | undefined;
  const clearAnnouncement = () => {
    window.clearTimeout(announceTimer);
    announceTimer = undefined;
    setAnnouncement("");
  };
  createEffect(() => {
    const infos = toasts().filter((toast) => toast.tone === "info");
    const newest = infos.at(-1);
    if (newest && newest.id > lastInfoId) {
      lastInfoId = newest.id;
      clearAnnouncement();
      // Give AT an empty-region update before inserting even an identical repeated notice.
      // Only the newest notice is announced; stacking or dismissal must not replay older ones.
      announceTimer = window.setTimeout(() => {
        announceTimer = undefined;
        if (toasts().some((toast) => toast.id === newest.id)) setAnnouncement(newest.text);
      }, 100);
    } else if (!infos.some((toast) => toast.id === lastInfoId)) {
      clearAnnouncement();
    }
  });
  onCleanup(clearAnnouncement);
  return (
    <div class="toast-region">
      {/* A polite region must exist before its text is inserted. Keep it mounted between
          notices, separately from the visible controls and the assertive error alerts. */}
      <div class="visually-hidden toast-announcements" role="status" aria-live="polite"
        aria-atomic="true">{announcement()}</div>
      <For each={toasts()}>{(toast) => <ToastItem toast={toast} />}</For>
    </div>
  );
}
