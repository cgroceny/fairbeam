import { Show } from "solid-js";
import type { Dispersion } from "../types";
import { fmt, t } from "../i18n";

/** Saved model evidence only. A missing/unknown report never becomes a passing fit. */
export default function DispersionInfo(props: { model: Dispersion }) {
  const source = () => props.model.source;
  const report = () => source()?.report as Record<string, unknown> | undefined;
  const number = (key: string) => typeof report()?.[key] === "number" && Number.isFinite(report()![key]) ? report()![key] as number : null;
  const known = () => source()?.model === "djordjevic-sarkar" || props.model.model === "djordjevic-sarkar";
  return <div class="note">
    <b>{known() ? t("props.material.ds") : props.model.model}</b>
    <Show when={source()?.appearance_only} fallback={<>
      <Show when={number("f_min") !== null && number("f_max") !== null && number("poles") !== null} fallback={<p>{t("props.material.dsNoReport")}</p>}>
        <p>{t("props.material.dsFit", { min: fmt.num(number("f_min")! / 1e9, 5), max: fmt.num(number("f_max")! / 1e9, 5), poles: number("poles")! })}</p>
        <Show when={number("max_rel_eps_real") !== null && number("max_abs_tan_d") !== null}>
          <p>{t("props.material.dsErrors", { eps: fmt.num(number("max_rel_eps_real")!, 6), tan: fmt.num(number("max_abs_tan_d")!, 6) })}</p>
        </Show>
        <p>{t("props.material.dsFitLimit")}</p>
      </Show>
    </>}><p>{t("props.material.dsAppearance")}</p></Show>
  </div>;
}
