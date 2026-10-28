import { createMemo, For, Show } from "solid-js";
import type { FarField } from "../types";
import { t } from "../i18n";
import { ludwigReadouts, readComplexFarField, XPD_MAX_DB } from "../lib/ludwig";
import { ludwigReferenceDeg, setLudwigReferenceDeg } from "../lib/patternQuantityStore";
import NumberField from "./NumberField";
import "../styles/ludwig.css";

/** A fixed reference is shared with 3D/cuts/CSV through patternQuantityStore. */
export default function LudwigPolarisationPanel(props: { field: FarField; halfSpace?: boolean; showLimits?: boolean }) {
  const available = createMemo(() => !!readComplexFarField(props.field));
  const points = createMemo(() => ludwigReadouts(props.field, ludwigReferenceDeg(), props.halfSpace));
  const fmt = (v: number | null | undefined, xpd = false) => v == null || !Number.isFinite(v) ? "—"
    : xpd && Math.abs(v) >= XPD_MAX_DB ? (v < 0 ? "≤−60" : "≥60") : v.toFixed(2);
  return <section class="ludwig-panel stack-sm" aria-label={t("ludwig.title")}>
    <h4>{t("ludwig.title")}</h4>
    <Show when={available()} fallback={<p class="note">{t("farfield.reason.noComplexFields")}</p>}>
      <label class="rdk-field"><span>{t("ludwig.reference")}</span>
        <NumberField class="dz-input" name="ludwig-reference-deg" min="0" max="180" step="1"
          value={ludwigReferenceDeg()} onChange={e => {
            const raw = e.currentTarget.value.trim();
            if (raw && Number.isFinite(Number(raw))) setLudwigReferenceDeg(Number(raw));
            e.currentTarget.value = String(ludwigReferenceDeg());
          }} /></label>
      <p class="note">{t("ludwig.referenceHint")}</p>
      <table class="table"><caption>{t("ludwig.title")} · α {ludwigReferenceDeg()}°</caption><thead><tr>
        <th scope="col">{t("ludwig.direction")}</th><th scope="col" class="num" title={t("farfield.quantity.co")}>D<sub>co</sub> <span class="th-unit">dBi</span></th>
        <th scope="col" class="num" title={t("farfield.quantity.cross")}>D<sub>cross</sub> <span class="th-unit">dBi</span></th><th scope="col" class="num">XPD <span class="th-unit">dB</span></th>
      </tr></thead><tbody>
        <For each={["peak", "boresight"] as const}>{key => <tr>
          <th scope="row">{t(`ludwig.${key}`)}<Show when={points()[key]}>{point => <small> θ {point().theta}°, φ {point().phi}°</small>}</Show></th>
          <td class="num">{fmt(points()[key]?.co)}</td><td class="num">{fmt(points()[key]?.cross)}</td><td class="num">{fmt(points()[key]?.xpd, true)}</td>
        </tr>}</For>
      </tbody></table>
      <Show when={props.showLimits !== false}><p class="note">{t("ludwig.limits")}</p></Show>
    </Show>
  </section>;
}
