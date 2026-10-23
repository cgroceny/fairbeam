import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { Bundle } from "../types";
import { portProcessingEligibility, type PortProcessingError } from "../lib/portPostprocess";
import { originalPortResult, portProcessingInfo } from "../lib/portProcessingMetadata";
import { portProcessingSession } from "../designer/portProcessingSession";
import { t } from "../i18n";

/** Explicit Apply/Reset; invalid drafts never change the displayed data. */
export default function PortProcessingPanel(props: { bundle: Bundle }) {
  const raw = () => originalPortResult(props.bundle);
  const eligibility = createMemo(() => portProcessingEligibility(raw()));
  const info = () => portProcessingInfo(props.bundle);
  const [reference, setReference] = createSignal("50");
  const [delays, setDelays] = createSignal<Record<number, string>>({});
  const [error, setError] = createSignal<PortProcessingError | null>(null);
  createEffect(() => {
    const current = info(), e = eligibility();
    setReference(String(current?.settings.referenceOhm ?? e.references[0] ?? 50));
    setDelays(Object.fromEntries(e.physicalPorts.map(id => [id, String(current?.settings.delayPs[id] ?? 0)])));
    setError(null);
  });
  const apply = (event: SubmitEvent) => {
    event.preventDefault();
    if (!reference().trim() || Object.values(delays()).some(value => !value.trim())) { setError("settings"); return; }
    setError(portProcessingSession.apply(raw(), { referenceOhm: Number(reference()),
      delayPs: Object.fromEntries(eligibility().physicalPorts.map(id => [id, Number(delays()[id])])) }));
  };
  return <details class="port-processing-panel">
    <summary>{t("portProcessing.title")}<Show when={info()}> · {t("portProcessing.badge")}</Show></summary>
    <p class="note">{t("portProcessing.scope")}</p>
    <Show when={!eligibility().error} fallback={<p class="note">{t(`portProcessing.error.${eligibility().error}`)}</p>}>
      <form onSubmit={apply}>
        <div class="port-processing-fields">
          <label class="rdk-field"><span>{t("portProcessing.reference")}</span>
            <input class="dz-input" type="number" step="any" value={reference()} onInput={e => setReference(e.currentTarget.value)} /></label>
          <For each={eligibility().physicalPorts}>{(id, i) => <label class="rdk-field">
            <span>{t("portProcessing.delay", { port: id, index: i() + 1 })}</span>
            <input class="dz-input" type="number" step="any" value={delays()[id] ?? "0"} onInput={e => setDelays({ ...delays(), [id]: e.currentTarget.value })} />
          </label>}</For>
        </div>
        <p class="note">{t("portProcessing.delayHint")}</p>
        <div class="port-processing-actions"><button class="btn btn-sm" type="submit">{t("portProcessing.apply")}</button>
          <button class="btn btn-ghost btn-sm" type="button" disabled={!info()} onClick={() => portProcessingSession.reset(raw())}>{t("portProcessing.reset")}</button></div>
        <Show when={error()}><p class="note" role="alert">{t(`portProcessing.error.${error()}`)}</p></Show>
      </form>
    </Show>
    <Show when={info()}>{current => <p class="note">{t("portProcessing.active", { reference: current().settings.referenceOhm, delays: current().physicalPorts.map(id => `P${id}: ${current().settings.delayPs[id]} ps`).join(", "), missing: current().missingSamples })}</p>}</Show>
  </details>;
}
