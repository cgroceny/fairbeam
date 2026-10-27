import { createMemo, createUniqueId, For, Show } from "solid-js";
import type { Bundle } from "../types";
import { fmt, t } from "../i18n";
import { smallAntennaAnalysis } from "../lib/smallAntenna";
import type { SmallAntennaSession } from "../lib/smallAntennaSession";
import type { SmallAntennaAnalysis } from "../lib/smallAntennaResult";
import NumberField from "./NumberField";
import "../styles/small-antenna.css";

const valueText = (value: number | null | undefined, digits = 4) => value != null && Number.isFinite(value) ? fmt.num(value, digits) : "—";
const reasonText = (reason: string | null | undefined) => reason ? t(`smallAntenna.reason.${reason}`) : "";

function Metric(props: { label: string; value: number | null; unit?: string; reason?: string | null; field: string; digits?: number }) {
  return <><dt>{props.label}</dt><dd data-small-metric={props.field}>
    <span class="mono">{valueText(props.value, props.digits)}<Show when={props.value !== null && props.unit}> {props.unit}</Show></span>
    <Show when={props.reason}><span class="note small-antenna-reason">{reasonText(props.reason)}</span></Show>
  </dd></>;
}

/** Both Designer views use the same owned session; comparison panels are read-only snapshots. */
export default function SmallAntennaPanel(props: { bundle: Bundle; session: SmallAntennaSession; readOnly?: boolean; label?: string }) {
  const uid = createUniqueId();
  const current = () => props.session.source() === props.bundle;
  const analysis = createMemo<SmallAntennaAnalysis>(() => current() && props.session.analysis()
    ? props.session.analysis()! : smallAntennaAnalysis(props.bundle));
  const editing = () => !props.readOnly && current() && props.session.editable();
  const geometry = () => analysis().geometry;
  const q = () => analysis().q;
  const selected = () => current() ? props.session.options().selectedPartIndices : geometry().selectedPartIndices;
  const assumptions = () => [...new Set(analysis().assumptions)];
  const label = () => props.label ? `${props.label} · ${t("smallAntenna.title")}` : t("smallAntenna.title");
  return <section class="small-antenna" data-small-antenna aria-label={label()}>
    <Show when={(props.readOnly && props.session.source()) || current()} fallback={<p class="note" data-small-unavailable>{t("smallAntenna.reason.no-results")}</p>}>
    <details class="small-antenna-panel">
      <summary><span>{label()}</span><Show when={q().available && q().qz !== null}>
        <span class="small-antenna-headline mono">Q_Z {valueText(q().qz, 3)} · ka {valueText(geometry().ka, 4)}</span>
      </Show></summary>
      <Show when={analysis().reason}><p class="note" role="status" data-small-unavailable>{reasonText(analysis().reason)}</p></Show>
      <Show when={editing()}>
        <div class="small-antenna-controls">
          <label class="rdk-field" for={`small-resonance-${uid}`}><span>{t("smallAntenna.resonance")}</span>
            <select class="dz-input" id={`small-resonance-${uid}`} data-small-resonance disabled={!analysis().candidates.length}
              value={analysis().selectedCandidateId ?? ""} onChange={event => props.session.selectResonance(event.currentTarget.value || null)}>
              <option value="">{t("smallAntenna.chooseResonance")}</option>
              <For each={analysis().candidates}>{candidate => <option value={candidate.id} disabled={!candidate.available}>
                {valueText(candidate.f0Hz / 1e9, 6)} GHz{candidate.reason ? ` · ${reasonText(candidate.reason)}` : ""}
              </option>}</For>
            </select>
          </label>
          <label class="rdk-field" for={`small-vswr-${uid}`}><span>{t("smallAntenna.vswr")}</span>
            <NumberField id={`small-vswr-${uid}`} class="dz-input" data-small-vswr min="1" step="0.1"
              value={props.session.vswrText()} aria-invalid={props.session.invalidVswr()}
              aria-describedby={props.session.invalidVswr() ? `small-vswr-error-${uid}` : undefined}
              onInput={event => props.session.setVswr(event.currentTarget.value, event.currentTarget.dataset.badInput === "true")} />
          </label>
        </div>
        <Show when={props.session.invalidVswr()}><p id={`small-vswr-error-${uid}`} class="note" role="status">{t("smallAntenna.vswrError")}</p></Show>
      </Show>
      <dl class="kv small-antenna-values">
        <Metric field="frequency" label={t("smallAntenna.resonance")} value={!q().available || q().f0Hz === null ? null : q().f0Hz! / 1e9} unit="GHz" digits={6} />
        <Metric field="qz" label={t("smallAntenna.q")} value={q().available ? q().qz : null} reason={q().reason} />
        <Metric field="predicted" label={t("smallAntenna.predictedBandwidth")} value={!analysis().bandwidth.predicted.available || analysis().bandwidth.predicted.hz === null ? null : analysis().bandwidth.predicted.hz! / 1e6} unit="MHz" reason={analysis().bandwidth.predicted.reason} />
        <Metric field="observed" label={t("smallAntenna.sampledBandwidth")} value={!analysis().bandwidth.observed.available || analysis().bandwidth.observed.hz === null ? null : analysis().bandwidth.observed.hz! / 1e6} unit="MHz" reason={analysis().bandwidth.observed.reason} />
        <Metric field="radius" label={t("smallAntenna.radius")} value={!geometry().available || geometry().radiusM === null ? null : geometry().radiusM! * 1e3} unit="mm" reason={geometry().reason} />
        <Metric field="ka" label={t("smallAntenna.ka")} value={geometry().ka} />
        <Metric field="reference" label={t("smallAntenna.reference")} value={analysis().reference.available ? analysis().reference.qChuMcLean : null} reason={analysis().reference.reason} />
        <Metric field="ratio" label={t("smallAntenna.ratio")} value={analysis().reference.ratioReason ? null : analysis().reference.ratio} reason={analysis().reference.ratioReason} />
        <Metric field="efficiency" label={t("smallAntenna.efficiency")} value={(!analysis().efficiency.available && analysis().efficiency.kind !== "model-normalized") || analysis().efficiency.value === null ? null : analysis().efficiency.value! * 100} unit="%" reason={analysis().efficiency.reason} />
        <Show when={analysis().efficiency.kind === "model-normalized"}>
          <Metric field="efficiency-raw" label={t("smallAntenna.efficiencyRaw")} value={analysis().efficiency.raw === null ? null : analysis().efficiency.raw! * 100} unit="%" />
        </Show>
      </dl>
      <Show when={q().r0Ohm !== null}><p class="note">{t("smallAntenna.matchAssumption", { resistance: valueText(q().r0Ohm) })} {t("smallAntenna.vswr")}: {valueText(analysis().bandwidth.vswr)}.</p></Show>
      <details class="small-antenna-geometry">
        <summary>{t("smallAntenna.geometry")} · {t("smallAntenna.geometryCount", { selected: selected().length, total: geometry().parts.filter(part => !part.void).length })}</summary>
        <p class="note">{t("smallAntenna.geometryHint")}</p>
        <Show when={editing()} fallback={<p class="note">{current() && props.session.custom() ? t("smallAntenna.selectionCustom") : t("smallAntenna.selectionDefault")}</p>}>
          <button type="button" class="btn btn-ghost btn-sm" data-small-all-parts onClick={() => props.session.selectAllParts()}>{t("smallAntenna.includeAll")}</button>
        </Show>
        <fieldset class="small-antenna-parts" disabled={!editing()}><legend class="visually-hidden">{t("smallAntenna.geometry")}</legend>
          <For each={geometry().parts.filter(part => !part.void)}>{part => <label for={`small-part-${uid}-${part.index}`}>
            <input type="checkbox" id={`small-part-${uid}-${part.index}`} data-small-part={part.index} checked={selected().includes(part.index)}
              onChange={event => props.session.selectPart(part.index, event.currentTarget.checked)} />
            <span>{part.name} <span class="note">#{part.index + 1}</span></span>
          </label>}</For>
        </fieldset>
        <Show when={props.bundle.half_space}>
          <label class="rdk-field" for={`small-enclosure-${uid}`}><span>{t("smallAntenna.convention")}</span>
            <select id={`small-enclosure-${uid}`} class="dz-input" data-small-enclosure disabled={!editing()} value={geometry().enclosure}
              onChange={event => props.session.setEnclosure(event.currentTarget.value as "finite" | "pec-image")}>
              <option value="finite">{t("smallAntenna.finite")}</option><option value="pec-image">{t("smallAntenna.image")}</option>
            </select>
          </label>
          <Show when={geometry().planeM !== null}><p class="note">{t("smallAntenna.imagePlane", { position: valueText(geometry().planeM! * 1e3), unit: "mm" })}</p></Show>
        </Show>
      </details>
      <details class="small-antenna-assumptions"><summary>{t("smallAntenna.assumptions")}</summary>
        <p class="note">{t("smallAntenna.diagnostic")}</p>
        <p class="note">{t("smallAntenna.port")}: {analysis().provenance.port ?? "—"} · {analysis().provenance.portType ?? "—"} · {t(analysis().provenance.plane === "original-stored" ? "smallAntenna.originalPlane" : "smallAntenna.reason.projected-plane")}</p>
        <For each={assumptions()}>{assumption => <p class="note">{t(`smallAntenna.assumption.${assumption}`)}</p>}</For>
      </details>
    </details>
    </Show>
  </section>;
}

export function SmallAntennaComparison(props: { runs: { file: string; bundle: Bundle; label: string }[]; session: SmallAntennaSession }) {
  return <div class="small-antenna-comparison" data-small-comparison>
    <p class="note">{t("smallAntenna.compareHint")}</p>
    <For each={props.runs}>{run => <SmallAntennaPanel bundle={run.bundle} label={run.label} session={props.session} readOnly />}</For>
  </div>;
}
