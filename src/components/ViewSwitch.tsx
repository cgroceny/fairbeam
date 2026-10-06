import { For } from "solid-js";
import { centerView, setCenterView, type CenterView } from "../state";
import { radioGroupKeys } from "../lib/a11y";
import { t } from "../i18n";

/** "3D | Drawing" segmented control above the centre stage. Kept apart from DrawingView so the
 * drawing code (and jsPDF) only loads when the drawing is opened. */
export default function ViewSwitch() {
  // labels are i18n keys
  const items: { id: CenterView; label: string }[] = [
    { id: "3d", label: "viewSwitch.threeD" },
    { id: "drawing", label: "viewSwitch.drawing" },
  ];
  return (
    <div class="stage-switch seg" role="radiogroup" aria-label={t("viewSwitch.aria")} onKeyDown={radioGroupKeys}>
      <For each={items}>
        {(it) => (
          <button
            class="seg-btn"
            role="radio"
            aria-checked={centerView() === it.id}
            classList={{ active: centerView() === it.id }}
            onClick={() => setCenterView(it.id)}
          >
            {t(it.label)}
          </button>
        )}
      </For>
    </div>
  );
}
