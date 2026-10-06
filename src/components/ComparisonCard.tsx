// "Comparison" card for the spec panel: openEMS vs imported reference data (Touchstone, CSV).
// Metrics come from src/import/metrics.ts; the grids and interpolation used are stated below them.

import { createMemo, For, Show } from "solid-js";
import { TriangleAlert, X } from "lucide-solid";
import { bundle, farfieldIndex } from "../state";
import { clearReference, reference } from "../compare/store";
import { comparisonMetrics } from "../import/metrics";
import { num } from "../lib/format";
import { t } from "../i18n";

const signed = (v: number, d: number) => `${v >= 0 ? "+" : "−"}${num(Math.abs(v), d)}`;

export default function ComparisonCard() {
  const m = createMemo(() => {
    const b = bundle();
    const r = reference();
    if (!b?.results || !r) return null;
    const ff = b.results.farfield[Math.min(farfieldIndex(), b.results.farfield.length - 1)];
    return comparisonMetrics(b, r, ff?.f);
  });
  return (
    <Show when={m()}>
      {(mm) => (
        <section class="section cmp-card" aria-labelledby="cmp-card-title">
          <h3 class="section-label" id="cmp-card-title">
            {t("compare.card.title")}
            <button class="icon-btn icon-btn-sm push" onClick={clearReference} aria-label={t("compare.card.remove")} title={t("compare.card.remove")}>
              <X size={14} aria-hidden="true" />
            </button>
          </h3>
          <p class="note cmp-card-ref mono" title={reference()?.reference.files.join(", ")}>{mm().label} − openEMS</p>
          <Show when={mm().s11}>
            {(s) => (
              <dl class="kv">
                <dt>{t("compare.card.resonance", { basis: s().basis })}</dt>
                <dd class="mono">{num(s().fOpen / 1e9, 4)} → {num(s().fRef / 1e9, 4)} GHz</dd>
                <dt>{t("compare.card.shift")}</dt>
                <dd class="mono">{signed(s().shiftMHz, 1)} MHz · {t("format.percent", { value: signed(s().shiftPct, 2) })}</dd>
                <dt>{t("compare.card.s11Min")}</dt>
                <dd class="mono">{num(s().minOpenDb, 1)} → {num(s().minRefDb, 1)} dB ({signed(s().dMinDb, 1)})</dd>
                <dt>{t("compare.card.bandwidth")}</dt>
                <dd class="mono">
                  <Show when={s().dBwMHz !== null} fallback={`— (${t("compare.card.bandOpen")})`}>
                    {num(s().bwOpenMHz!, 1)} → {num(s().bwRefMHz!, 1)} MHz ({signed(s().dBwMHz!, 1)})
                  </Show>
                </dd>
              </dl>
            )}
          </Show>
          <Show when={mm().pattern}>
            {(p) => (
              <dl class="kv">
                <dt>{t("compare.card.quantityAt", { quantity: "Dmax", f: num(p().fRef / 1e9, 3) })}</dt>
                <dd class="mono">{num(p().maxOpenDbi, 2)} → {num(p().maxRefDbi, 2)} dBi ({signed(p().dMaxDb, 2)})</dd>
                <dt>{t("compare.card.patternRms")}</dt>
                <dd class="mono" title={t("compare.card.samples", { count: p().samples })}>{num(p().rmsDb, 2)} dB</dd>
                <dt>{t("compare.card.meanShape")}</dt>
                <dd class="mono">{signed(p().meanDb, 2)} · {num(p().shapeRmsDb, 2)} dB</dd>
              </dl>
            )}
          </Show>
          <Show when={!mm().s11 && !mm().pattern}>
            <p class="status-block status-warn" role="status">
              <TriangleAlert size={14} aria-hidden="true" />
              <span>{t("compare.card.nothing")}</span>
            </p>
          </Show>
          <details class="cmp-card-notes">
            <summary>{t("compare.card.notes")}</summary>
            <ul>
              <Show when={mm().s11}><li>{t("compare.card.sparamsGrid", { grid: mm().s11!.grid })}</li></Show>
              <Show when={mm().pattern}><li>{t("compare.card.patternGrid", { grid: mm().pattern!.grid })}</li></Show>
              <For each={[...(reference()?.reference.notes ?? []), ...mm().notes]}>{(n) => <li>{n}</li>}</For>
            </ul>
          </details>
        </section>
      )}
    </Show>
  );
}
