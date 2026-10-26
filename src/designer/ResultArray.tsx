import { For, Show } from "solid-js";
import ArrayPanel from "../components/ArrayPanel";
import { PatternCutPanel } from "../components/PatternCutPanel";
import { designerArray } from "./arraySession";
import { resultFocus } from "./resultFocus";
import { showView } from "./runResults";
import { freqText } from "../lib/format";
import { t } from "../i18n";

export default function ResultArray() {
  const s = designerArray;
  return <Show when={!resultFocus()?.compare?.length} fallback={<p class="panel-empty">{t("array.singleRun")}</p>}>
    <section class="stack" data-designer-array>
      <p class="note">{t("array.designerScope")}</p>
      <label class="cluster-sm"><span>{t("farfield.frequency")}</span>
        <select data-array-frequency value={s.set()?.f ?? ""} onChange={e => showView("array", Number(e.currentTarget.value), "main")}>
          <For each={s.sets().filter(set => set.elements.length >= 2)}>{set => <option value={set.f}>{freqText(set.f)}</option>}</For>
        </select>
      </label>
      <ArrayPanel session={s} />
      <Show when={s.source() && s.steered()}>
        <p class="note">{t("farfield.arrayPatternNote")}</p>
        <PatternCutPanel entries={[{ id: "designer-array", label: t("farfield.arrayTag"), color: "--al-series-1", bundle: s.source()!, field: s.steered()!, quantity: "directivity" }]} />
      </Show>
    </section>
  </Show>;
}
