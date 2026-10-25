import { For, Index, Show } from "solid-js";
import { Plus, X } from "lucide-solid";
import NumberField from "../components/NumberField";
import { fmt, t } from "../i18n";
import { NETWORK_KINDS, isRelativeNetwork, networkLabel, networkReportRows, networkUnit, newNetworkDraft, type NetworkDraft, type NetworkKind } from "./networkConvergence";
import type { ConvergenceStudy } from "./convergence";

export function NetworkFields(props: { enabled: boolean; frequency: string; rows: NetworkDraft[]; ports: number[]; error?: string; enabledChange: (value: boolean) => void; frequencyChange: (value: string) => void; rowsChange: (rows: NetworkDraft[]) => void }) {
  const change = (i: number, key: keyof NetworkDraft, value: string) => props.rowsChange(props.rows.map((row, index) => index === i ? { ...row, [key]: value } : row));
  return <section class="stack cv-network" aria-label={t("conv.net.title")} aria-describedby={props.error ? "cv-setup-error" : undefined}>
    <label class="toggle"><input type="checkbox" checked={props.enabled} onChange={e => props.enabledChange(e.currentTarget.checked)} />{t("conv.net.enable")}</label>
    <Show when={props.enabled}>
      <p class="note">{t("conv.net.excite", { count: props.ports.length })}</p>
      <label class="rp-mini">{t("conv.net.frequency")}
        <NumberField class="rp-input mono" aria-label={t("conv.net.frequency")} step="any" value={props.frequency} onInput={e => props.frequencyChange(e.currentTarget.value)} />
      </label>
      <Index each={props.rows}>{(row, i) => <fieldset class="cv-network-row stack-sm">
        <legend>{t("conv.net.criterion", { n: i + 1 })}</legend>
        <div class="cv-grid">
          <label class="rp-mini">{t("conv.net.metric")}
            <select class="rp-input" value={row().kind} onChange={e => change(i, "kind", e.currentTarget.value as NetworkKind)}>
              <For each={NETWORK_KINDS}>{kind => <option value={kind}>{t(`conv.net.kind.${kind}`)}</option>}</For>
            </select>
          </label>
          <label class="rp-mini">{t(row().kind === "s11" ? "conv.net.port" : "conv.net.output")}
            <select class="rp-input mono" value={row().output} onChange={e => change(i, "output", e.currentTarget.value)}><For each={props.ports}>{p => <option value={p}>{p}</option>}</For></select>
          </label>
          <Show when={isRelativeNetwork(row().kind)}><label class="rp-mini">{t("conv.net.reference")}
            <select class="rp-input mono" value={row().reference} onChange={e => change(i, "reference", e.currentTarget.value)}><For each={props.ports}>{p => <option value={p}>{p}</option>}</For></select>
          </label></Show>
          <Show when={row().kind !== "s11"}><label class="rp-mini">{t("conv.net.input")}
            <select class="rp-input mono" value={row().input} onChange={e => change(i, "input", e.currentTarget.value)}><For each={props.ports}>{p => <option value={p}>{p}</option>}</For></select>
          </label></Show>
          <label class="rp-mini">{t("conv.net.tolerance", { unit: networkUnit(row().kind) })}
            <NumberField class="rp-input mono" step="any" value={row().tolerance} onInput={e => change(i, "tolerance", e.currentTarget.value)} />
          </label>
          <button class="btn btn-ghost btn-sm" onClick={() => props.rowsChange(props.rows.filter((_, index) => index !== i))} aria-label={t("conv.net.remove", { n: i + 1 })}><X size={14} aria-hidden="true" />{t("common.remove")}</button>
        </div>
      </fieldset>}</Index>
      <div><button class="btn btn-ghost btn-sm" disabled={props.rows.length >= 12} onClick={() => props.rowsChange([...props.rows, newNetworkDraft(props.ports)])}><Plus size={14} aria-hidden="true" />{t("conv.net.add")}</button></div>
      <p class="note">{t("conv.net.meaning")}</p>
    </Show>
  </section>;
}

export function NetworkReport(props: { study: ConvergenceStudy }) {
  const config = () => props.study.network_criteria;
  const number = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : fmt.num(value, 4);
  return <Show when={config()}>{c => <section class="stack cv-network-report">
    <h3 class="section-label">{t("conv.net.title")}</h3>
    <p class="note">{t("conv.net.reportNote", { f: number(c().frequency_hz / 1e9) })}</p>
    <div class="cv-table-wrap"><table class="table cv-table">
      <caption>{t("conv.net.results")}</caption>
      <thead><tr><th class="num">{t("conv.col.density")}</th><th>{t("conv.net.metric")}</th><th class="num">{t("conv.net.value")}</th><th class="num">{t("conv.net.delta")}</th><th class="num">{t("conv.net.limit")}</th><th>{t("conv.net.status")}</th></tr></thead>
      <tbody><For each={networkReportRows(props.study)}>{row => <tr>
        <td class="num">{row.density}</td><td>{networkLabel(row.criterion)}</td><td class="num">{number(row.value)} {row.criterion.unit}</td>
        <td class="num">{number(row.delta)} {row.criterion.unit}</td><td class="num">{number(row.criterion.tolerance)} {row.criterion.unit}</td>
        <td><span>{row.status}</span><Show when={row.reason}><div class="note cv-network-reason">{row.reason}</div></Show></td>
      </tr>}</For></tbody>
    </table></div>
  </section>}</Show>;
}
