import { createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, onMount, Show } from "solid-js";
import { t } from "../i18n";
import { api, type FarfieldCapability } from "../runner/api";
import { attach, health, jobs, jobsScope, refreshRuns, serverState, setRunOpen } from "../runner/store";
import { followInDesigner } from "../runner/designRun";
import { farfieldRequest, retainedSourceJob } from "../lib/retainedFarfield";
import NumberField from "./NumberField";
import "../styles/retained-farfield.css";

/** A new local derivative; the selected result is never edited in place. */
export default function RetainedFarfieldPanel(props: { file?: string; frequency?: number; surface?: "designer" | "viewer" }) {
  const id = createUniqueId();
  const source = createMemo(() => retainedSourceJob(props.file, jobs(), jobsScope() !== null && jobsScope() === health()?.backup_scope));
  const key = createMemo(() => JSON.stringify([props.file, source()?.id, source()?.retained_nf2ff?.sha256, health()?.backup_scope, serverState()]));
  const [capability, setCapability] = createSignal<FarfieldCapability>();
  const [loading, setLoading] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [frequencies, setFrequencies] = createSignal("");
  const [theta, setTheta] = createSignal(3);
  const [phi, setPhi] = createSignal(5);
  let alive = true;
  onCleanup(() => { alive = false; });
  onMount(() => { void refreshRuns(); });
  createEffect(on(key, selected => {
    setCapability(undefined); setError(undefined); setBusy(false);
    setFrequencies(props.frequency ? String(props.frequency / 1e9) : "");
    const job = source();
    if (!job || serverState() !== "online") { setLoading(false); return; }
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    setLoading(true);
    void api.farfieldCapability(job.id, controller.signal).then(value => {
      if (alive && key() === selected) setCapability(value);
    }).catch(reason => {
      if (alive && key() === selected && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (alive && key() === selected) setLoading(false); });
  }));
  const available = () => { const c = capability(); return c?.available ? c : undefined; };
  const parsed = createMemo(() => farfieldRequest(frequencies(), theta(), phi(), capability()));
  const submit = async (event: Event) => {
    event.preventDefault();
    const job = source(), selected = key(), request = parsed().request;
    if (!job || !request || busy() || loading()) return;
    setBusy(true); setError(undefined);
    try {
      const next = await api.submitFarfield(job.id, request);
      void refreshRuns();
      if (alive && key() === selected) {
        if (props.surface === "viewer") { attach(next); setRunOpen(true); }
        else followInDesigner(next);
      }
    } catch (reason) {
      if (alive && key() === selected) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (alive && key() === selected) setBusy(false); }
  };
  return <details class="retained-farfield" data-retained-farfield>
    <summary>{t("nf2ff.title")}</summary>
    <p class="note">{t("nf2ff.description")}</p>
    <Show when={loading()}><p class="note" role="status">{t("nf2ff.checking")}</p></Show>
    <Show when={!loading() && available()} fallback={<Show when={!loading()}>
      <p class="note">{t("nf2ff.unavailable")}</p>
      <Show when={capability() && !capability()!.available}><p class="note">{(capability() as { reason: string }).reason}</p></Show>
    </Show>}>
      <p class="note">{t("nf2ff.source", { file: source()?.bundle ?? "" })}</p>
      <ul class="nf2ff-bands"><For each={available()?.ports}>{port => <li>
        P{port.port}: {(port.band_hz[0] / 1e9).toPrecision(6)}–{(port.band_hz[1] / 1e9).toPrecision(6)} GHz · {port.domain}
        <Show when={port.domain === "FD"}><span> · {t("nf2ff.recorded")}: {port.recorded_frequencies_hz.map(f => f / 1e9).join(", ")} GHz</span></Show>
      </li>}</For></ul>
      <form onSubmit={submit}>
        <fieldset disabled={busy()}>
          <legend class="sr-only">{t("nf2ff.title")}</legend>
          <label for={`${id}-frequency`}>{t("nf2ff.frequencies")}</label>
          <input id={`${id}-frequency`} name="nf2ff-frequencies" class="dz-input" type="text" inputmode="decimal" value={frequencies()}
            aria-invalid={!!parsed().error} aria-describedby={`${id}-hint`} onInput={e => setFrequencies(e.currentTarget.value)} />
          <div class="nf2ff-steps">
            <label>{t("nf2ff.thetaStep")}<NumberField name="nf2ff-theta-step" class="dz-input" min="0.25" max="90" value={theta()}
              onInput={e => setTheta(e.currentTarget.valueAsNumber)} /></label>
            <label>{t("nf2ff.phiStep")}<NumberField name="nf2ff-phi-step" class="dz-input" min="0.25" max="90" value={phi()}
              onInput={e => setPhi(e.currentTarget.valueAsNumber)} /></label>
          </div>
          <p id={`${id}-hint`} class="note">{parsed().error ? t(parsed().error!) : t("nf2ff.limits")}</p>
          <button class="btn btn-secondary btn-sm" type="submit" disabled={!parsed().request || busy()}>{t(busy() ? "nf2ff.submitting" : "nf2ff.submit")}</button>
        </fieldset>
      </form>
    </Show>
    <Show when={error()}><p class="note cell-warn" role="alert">{error()}</p></Show>
  </details>;
}
