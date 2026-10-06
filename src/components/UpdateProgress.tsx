import { Show } from "solid-js";
import { Download, LoaderCircle, RefreshCw } from "lucide-solid";
import { fraction, updateAnnouncement, updateState, updateText } from "../lib/updateProgress";

/** Banner under the header while the desktop app updates itself (downloading, installing,
 * restarting). Not blocking: the app stays usable while it downloads. The numbers change several
 * times a second, so screen readers get the phase only (a polite live region that changes with the
 * phase), and the bar is a progressbar element with its own value. */
export default function UpdateProgress() {
  return (
    <Show when={updateState()}>
      {(state) => (
        <div class="banner up-banner" data-update-phase={state().phase}>
          <span role="status" aria-live="polite" class="visually-hidden">{updateAnnouncement(state())}</span>
          <Show when={state().phase === "downloading"} fallback={
            state().phase === "installing" ? <LoaderCircle size={14} class="up-spin" aria-hidden="true" /> : <RefreshCw size={14} class="up-spin" aria-hidden="true" />
          }>
            <Download size={14} aria-hidden="true" />
          </Show>
          <span class="up-text num" aria-hidden="true">{updateText(state())}</span>
          <div class="up-bar" classList={{ "up-bar-indeterminate": fraction(state()) === null }} aria-hidden="true">
            <span style={fraction(state()) === null ? undefined : { width: `${(fraction(state())! * 100).toFixed(1)}%` }} />
          </div>
        </div>
      )}
    </Show>
  );
}
