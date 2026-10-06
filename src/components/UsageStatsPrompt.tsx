// The first-start question about usage statistics (docs/TELEMETRY.md). Asked once, and only when
// the shell says so (`ask`): a build with the telemetry feature, no FAIRBEAM_NO_TELEMETRY, and no
// answer yet. In every build without the feature, in a browser and in the demo it never appears.
// Closing it without an answer keeps the setting unset (off); it asks again at the next start.
import { createSignal, onMount, Show } from "solid-js";
import { BarChart3 } from "lucide-solid";
import { useModal } from "../lib/dialog";
import { openPrivacyPage, setUsageConsent, USAGE_SUMMARY, usageStatus } from "../lib/telemetry";
import { t } from "../i18n";

export default function UsageStatsPrompt() {
  let box!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const close = () => setOpen(false);
  useModal(() => open() ? box : undefined, close);
  onMount(async () => {
    const s = await usageStatus();
    if (s?.ask) setOpen(true);
  });
  const answer = async (granted: boolean) => {
    setBusy(true); setError("");
    try { await setUsageConsent(granted); setOpen(false); }
    catch (e) { setError(t("usage.error.saveChoice", { error: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); }
  };
  return <Show when={open()}><div class="scrim">
    <div class="dialog dialog-sm" role="dialog" aria-modal="true" aria-labelledby="usp-title" aria-describedby="usp-what" ref={box} tabindex={-1}>
      <div class="dialog-head"><div><h2 id="usp-title"><BarChart3 size={17} /> {t("usage.prompt.title")}</h2><p class="muted">{t("usage.prompt.subtitle")}</p></div></div>
      <div class="gs-body">
        <p id="usp-what">{USAGE_SUMMARY.what}</p>
        <p>{USAGE_SUMMARY.never}</p>
        <p>{USAGE_SUMMARY.where}</p>
        <p>{USAGE_SUMMARY.off}</p>
        <p><button class="btn btn-ghost btn-sm" type="button" onClick={() => void openPrivacyPage().catch(() => {})}>{t("usage.prompt.fullList")}</button></p>
        <Show when={error()}><p role="alert" class="status-block status-critical">{error()}</p></Show>
        <div class="dialog-actions">
          <button class="btn btn-ghost" disabled={busy()} onClick={() => void answer(false)}>{t("usage.prompt.no")}</button>
          <button class="btn btn-primary" disabled={busy()} onClick={() => void answer(true)}>{t("usage.prompt.yes")}</button>
        </div>
      </div>
    </div>
  </div></Show>;
}
