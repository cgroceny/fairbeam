// The S-parameter plots of a result data format (charts/plotQuantities.ts): one pane per quantity (dB,
// phase, Re/Im, linear magnitude), stacked. Shared by the designer's result tabs and the Examples dock,
// so both keep the same rules: a pane never shrinks below a readable height (the stack scrolls inside
// the result area instead), its axis titles fit, the phase axis has its five ticks (three on a short
// pane), the |S11| axis reaches above 0 dB when the data do (an unphysical part stays visible), and the
// stack has one Markers button: the panes share the marker mode, the markers and the table
// (markerMode.ts, by the chart key).
import { Index } from "solid-js";
import LineChart, { type LineChartProps } from "./LineChart";
import type { PlotQuantity } from "./plotQuantities";
import { PHASE_TICKS, quantityDomain, quantityLines } from "./quantityAxes";
import "../styles/charts.css";
import { t } from "../i18n";

type PaneExtras = Pick<LineChartProps, "markers" | "onMarker" | "onPick" | "bands" | "extra">;

export default function StackedCharts(props: {
  groups: PlotQuantity[];
  /** the accessible name of a pane */
  ariaLabel: (g: PlotQuantity) => string;
  /** the chart's key for the marker inspector ("designer:run.json:reflection"); none: no inspector */
  inspectionChart?: string;
  /** what a pane adds (the far-field markers and the band shading of the dB pane, a tooltip row) */
  pane?: (g: PlotQuantity) => PaneExtras;
}) {
  const extras = (g: PlotQuantity): PaneExtras => props.pane?.(g) ?? {};
  return (
    <div class="chart-stack" classList={{ "is-stacked": props.groups.length > 1 }}>
      {/* Index: a pane keeps its chart while its quantity changes (dB to phase) */}
      <Index each={props.groups}>{(g, i) => (
        <div class="chart-stack-pane">
          <LineChart ariaLabel={props.ariaLabel(g())} series={g().series} xLabel={t("chart.frequencyGHz")} yLabel={g().yLabel}
            yDomain={quantityDomain(g())} yTickValues={g().key === "phase" ? PHASE_TICKS : undefined} hlines={quantityLines(g())}
            yFormat={(v) => v.toFixed(1)}
            inspection={props.inspectionChart ? { key: `${props.inspectionChart}:${g().key}`, chart: props.inspectionChart, kind: g().kind, toolbar: i === 0 } : undefined}
            markers={extras(g()).markers} onMarker={extras(g()).onMarker} onPick={extras(g()).onPick} bands={extras(g()).bands} extra={extras(g()).extra} />
        </div>
      )}</Index>
    </div>
  );
}
