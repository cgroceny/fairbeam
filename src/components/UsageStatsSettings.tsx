// Opt-in usage counts and an exact payload preview.
import { createSignal, onMount, Show } from "solid-js";
import { openPrivacyPage, setUsageConsent, USAGE_SUMMARY, usagePreview, usageStatus, type UsagePreview, type UsageStatus } from "../lib/telemetry";
import { t } from "../i18n";
import "../styles/usage-stats.css";

export default function UsageStatsSettings() {
  const [status, setStatus] = createSignal<UsageStatus | null>(null);
  const [preview, setPreview] = createSignal<UsagePreview | null>(null);
  const [message, setMessage] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  onMount(async () => setStatus(await usageStatus(true)));
  const usable = () => !!status()?.build_enabled && !status()?.env_disabled;
  const run = async (errorKey: string, fn: () => Promise<void>) => {
    setBusy(true); setMessage("");
    try { await fn(); } catch (e) { setMessage(t(errorKey, { error: e instanceof Error ? e.message : String(e) })); } finally { setBusy(false); }
  };
  const choose = (granted: boolean) => run("usage.error.saveChoice", async () => {
    setStatus(await setUsageConsent(granted));
    if (preview()) setPreview(await usagePreview());
  });
  const show = () => run("usage.error.readCounts", async () => { setPreview(preview() ? null : await usagePreview()); });
  const pretty = (v: unknown) => JSON.stringify(v, null, 2);
  return <Show when={status()}>
    <hr />
    <section class="us-section" aria-labelledby="us-title">
      <h3 id="us-title" class="dz-label">{t("usage.title")}</h3>
      <Show when={!status()!.build_enabled}><p class="note">{t("usage.notInBuild")}</p></Show>
      <Show when={status()!.build_enabled && status()!.env_disabled}><p class="note">{t("usage.envOffBefore")}<span class="mono">FAIRBEAM_NO_TELEMETRY</span>{t("usage.envOffAfter")}</p></Show>
      <div class="us-choice" role="radiogroup" aria-labelledby="us-title">
        <label class="gs-check"><input type="radio" name="usage-stats" checked={status()!.consent !== "granted"} disabled={!usable() || busy()} onChange={() => void choose(false)} /> {t("usage.off")}</label>
        <label class="gs-check"><input type="radio" name="usage-stats" checked={status()!.consent === "granted"} disabled={!usable() || busy()} onChange={() => void choose(true)} /> {t("usage.on")}</label>
      </div>
      <p class="note">{USAGE_SUMMARY.what}</p>
      <p class="note">{USAGE_SUMMARY.never} {USAGE_SUMMARY.where} {USAGE_SUMMARY.off}</p>
      <div class="us-actions">
        <button class="btn btn-ghost btn-sm" disabled={busy()} aria-expanded={!!preview()} onClick={() => void show()}>{preview() ? t("usage.hidePreview") : t("usage.showPreview")}</button>
        <button class="btn btn-ghost btn-sm" onClick={() => void openPrivacyPage().catch((e) => setMessage(t("usage.error.openPage", { error: String(e) })))}>{t("usage.whatIsCollected")}</button>
      </div>
      <Show when={preview()}>{(p) => <>
        <Show when={p().example}><p class="note">{t("usage.example")}</p><pre class="us-json mono">{pretty(p().example)}</pre></Show>
        <Show when={!p().example}>
          <p class="note">{p().status.active ? t("usage.nextPing") : t("usage.nextPingOff")}</p>
          <pre class="us-json mono">{p().next ? pretty(p().next) : t("usage.nothingToSend")}</pre>
        </Show>
      </>}</Show>
      <Show when={message()}><p role="status" class="note">{message()}</p></Show>
    </section>
  </Show>;
}
