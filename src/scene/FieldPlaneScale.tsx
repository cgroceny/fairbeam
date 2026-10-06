// The colour bar of the field-plane map shown in the 3D view (scene/fieldPlanes.ts), with its Magnitude
// / Phase / Animate, component and dB / linear controls (FieldPlaneControls.tsx, shared with the 2D
// field-map tab). It sits in the viewport's colour-scale column next to the pattern and current bars.
import { createMemo, Show } from "solid-js";
import { bundle, fieldPlaneMap } from "../state";
import { fieldPlaneLabel } from "../designer/navModel";
import { fieldPlaneValues } from "./fieldPlaneModel";
import { currentFieldPlaneView, FieldPlaneControls, FieldPlaneLegend, valueLabel } from "./FieldPlaneControls";
import { t } from "../i18n";

export default function FieldPlaneScale() {
  const shown = () => {
    const i = fieldPlaneMap();
    return i === null ? undefined : bundle()?.field_planes?.[i];
  };
  return (
    <Show when={shown()}>
      {(m) => {
        const heading = createMemo(() => {
          const v = currentFieldPlaneView(false);
          return valueLabel(m(), fieldPlaneValues(m(), v), v.scale);
        });
        return (
          <div class="colorbar" role="group" aria-label={t("viewport.fieldPlane.aria", { label: fieldPlaneLabel(m()) })} data-field-plane>
            <div class="colorbar-title">{fieldPlaneLabel(m())}</div>
            <Show when={m().port !== undefined}>
              <div class="colorbar-port">{t("viewport.fieldPlane.portDriven", { port: m().port })}</div>
            </Show>
            <FieldPlaneControls map={m()} />
            <FieldPlaneLegend map={m()} />
            <div class="colorbar-unit">
              {heading()}
              {m().unit === "arb." ? "" : `, ${t("viewport.fieldPlane.incident")}`}
            </div>
          </div>
        );
      }}
    </Show>
  );
}
