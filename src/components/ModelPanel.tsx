import { lumpedLabel } from "../lumped.ts";
import { For, Show } from "solid-js";
import { Eye, EyeOff, PenTool } from "lucide-solid";
import { bundle, fieldPlaneMap, hiddenParts, hoverPart, layers, meshPlane, setFieldPlaneMap, setHiddenParts, setHoverPart, setLayers, setMeshPlane, source, type Axis, type Layers } from "../state";
import { fieldPlaneLabel } from "../designer/navModel";
import "../styles/field-map.css";
import { DEMO } from "../env";
import { designFor, exampleConversionBlocker, exampleSourceFor, isExample } from "../runner/examples";
import { models, openExampleCopy, serverState } from "../runner/store";
import { enterDesign } from "../designer/store";
import { dims, num } from "../lib/format";
import { partKind } from "../scene/partKind";
import { radioGroupKeys } from "../lib/a11y";
import { fmt, t } from "../i18n";
import { paramLabelText } from "../lib/paramLabel";

/** label and hint: i18n keys model.layer.<key> and model.layer.<key>.hint */
const LAYERS: { key: keyof Layers }[] = [
  { key: "pattern" }, { key: "current" }, { key: "mesh" }, { key: "guideGrid" }, { key: "edges" },
  { key: "dielectricXray" }, { key: "ground" }, { key: "domain" }, { key: "nf2ff" },
];

/** Examples mode: copy the source into Design or open its source design. */
function ExampleActions(props: { model: string }) {
  const design = () => designFor(models(), props.model);
  const sourceModel = () => isExample({ file: source() }) ? exampleSourceFor(models(), props.model) : undefined;
  // shapes the Design schema cannot hold: say so on the button (it stays hoverable for the reason)
  const blocker = () => { const b = bundle(); return b && isExample({ file: source() }) ? exampleConversionBlocker(b) : null; };
  const reason = () => blocker() ? t("model.cantOpen", { reason: blocker() }) : !sourceModel() ? t("model.noSource") : null;
  return (
    <Show when={!DEMO && serverState() === "online"}>
      <div class="cluster-sm ex-actions">
        <button class="btn btn-ghost btn-sm" aria-disabled={reason() ? "true" : undefined}
          title={reason() ?? t("model.openCopyTitle")}
          onClick={() => { if (!reason() && sourceModel()) openExampleCopy(sourceModel()!.key, source()); }}>
          {t("model.openCopy")}
        </button>
        <Show when={design()}>
          <button class="btn btn-ghost btn-sm" onClick={() => enterDesign(design()!.key)} title={t("model.openDesignTitle")}>
            <PenTool size={13} aria-hidden="true" /> {t("model.openDesign")}
          </button>
        </Show>
      </div>
    </Show>
  );
}

export default function ModelPanel() {
  const axisLines = () => {
    const b = bundle();
    if (!b) return [];
    return b.mesh[meshPlane.axis];
  };
  return (
    <aside class="panel panel-left" aria-label={t("model.aria")}>
      <Show when={bundle()} fallback={<div class="panel-empty">{t("model.empty")}</div>}>
        {(b) => (
          <>
            <section class="section">
              <h2 class="section-title">{b().model.name}</h2>
              <p class="section-lede">{b().model.description}</p>
              <Show when={b().model.reference}>
                <p class="section-ref">{b().model.reference}</p>
              </Show>
              <ExampleActions model={b().model.id} />
            </section>

            <section class="section">
              <h3 class="section-label">{t("model.parts")}</h3>
              <ul class="part-list">
                <For each={b().parts}>
                  {(p) => {
                    const kind = partKind(p);
                    // the line under the name may be cut by the panel width: its full text is the tooltip
                    const subText = `${kind === "metal" ? "PEC" : kind === "dielectric" ? `εr ${num(p.material?.eps_r, 2)}` : p.type} · ${dims(p.bbox)}`;
                    return (
                      <li
                        class="part-row"
                        classList={{ hovered: hoverPart() === p.name, hidden: !!hiddenParts[p.name] }}
                        onMouseEnter={() => setHoverPart(p.name)}
                        onMouseLeave={() => setHoverPart(null)}
                      >
                        <span class={`swatch swatch-${kind}`} aria-hidden="true" />
                        <span class="part-text">
                          <span class="part-name">{p.label ?? p.name}</span>
                          <span class="part-sub" title={subText}>
                            {kind === "metal" ? "PEC" : kind === "dielectric" ? `εr ${num(p.material?.eps_r, 2)}` : p.type}
                            {" · "}
                            <span class="mono">{dims(p.bbox)}</span>
                          </span>
                        </span>
                        <button
                          class="icon-btn icon-btn-sm"
                          onClick={() => setHiddenParts(p.name, !hiddenParts[p.name])}
                          aria-label={t(hiddenParts[p.name] ? "model.showPart" : "model.hidePart", { name: p.label ?? p.name })}
                          aria-pressed={!hiddenParts[p.name]}
                        >
                          <Show when={!hiddenParts[p.name]} fallback={<EyeOff size={14} />}>
                            <Eye size={14} />
                          </Show>
                        </button>
                      </li>
                    );
                  }}
                </For>
                <Show when={b().half_space}>
                  <li class="part-row">
                    <span class="swatch swatch-ground" aria-hidden="true" />
                    <span class="part-text">
                      <span class="part-name">{t("model.infiniteGround")}</span>
                      <span class="part-sub">{t("model.pecBoundary")} · {b().half_space!.axis} = {fmt.num(b().half_space!.position, 6)} mm</span>
                    </span>
                  </li>
                </Show>
                <For each={b().ports}>
                  {(port) => (
                    <li class="part-row">
                      <span class="swatch swatch-port" aria-hidden="true" />
                      <span class="part-text">
                        <span class="part-name">{t("model.port", { n: port.number })}</span>
                        {(() => {
                          const text = port.type === "waveguide"
                            ? t("model.waveguidePort", { mode: port.mode ?? "TE10", z: fmt.num(port.R, 1), dir: port.direction })
                            : t("model.lumpedPort", { r: fmt.num(port.R, 6), dir: port.direction });
                          return <span class="part-sub" title={text}>{text}</span>;
                        })()}
                      </span>
                    </li>
                  )}
                </For>
                <For each={b().lumped_elements ?? []}>
                  {(e) => (
                    <li class="part-row">
                      <span class="swatch swatch-lumped" aria-hidden="true" />
                      <span class="part-text">
                        <span class="part-name">{e.label || e.name}</span>
                        <span class="part-sub" title={lumpedLabel(e)}>{e.type === "resistor" && e.R !== undefined ? t("model.lumpedElement", { type: e.type, r: fmt.num(e.R, 6), dir: e.direction }) : lumpedLabel(e)}</span>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </section>

            <section class="section">
              <h3 class="section-label">{t("model.layers")}</h3>
              <div class="toggle-list">
                {/* the infinite ground plane exists only in a model with a PEC half-space: elsewhere the
                    layer is left out; a layer this result has no data for is off and says why */}
                <For each={LAYERS.filter((l) => l.key !== "ground" || !!b().half_space)}>
                  {(l) => {
                    const disabled = () =>
                      (l.key === "pattern" && !(b().results?.farfield?.length)) ||
                      (l.key === "current" && !(b().fields?.planes?.length));
                    return (
                      <label class="toggle" classList={{ disabled: disabled() }} title={t(disabled() ? `model.layer.${l.key}.none` : `model.layer.${l.key}.hint`)}>
                        <input
                          type="checkbox"
                          checked={layers[l.key] && !disabled()}
                          disabled={disabled()}
                          onChange={(e) => setLayers(l.key, e.currentTarget.checked)}
                        />
                        <span class="toggle-box" aria-hidden="true" />
                        <span>{t(`model.layer.${l.key}`)}</span>
                      </label>
                    );
                  }}
                </For>
              </div>
              {/* a run with E/H field planes: pick the map to draw in the 3D view (its colour bar has the phase and animation controls) */}
              <Show when={b().field_planes?.length}>
                <label class="fm-field"><span>{t("model.fieldPlanes")}</span>
                  <select class="btn btn-ghost btn-sm" title={t("model.fieldPlanes.hint")} onChange={(e) => setFieldPlaneMap(e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}>
                    <option value="" selected={fieldPlaneMap() === null}>{t("model.fieldPlanes.none")}</option>
                    <For each={b().field_planes}>{(m, i) => <option value={i()} selected={fieldPlaneMap() === i()}>{fieldPlaneLabel(m)}</option>}</For>
                  </select>
                </label>
              </Show>
              <Show when={layers.mesh}>
                <div class="mesh-controls">
                  <div class="seg seg-sm" role="radiogroup" aria-label={t("results.mesh.planeNormal")} onKeyDown={radioGroupKeys}>
                    <For each={["x", "y", "z"] as Axis[]}>
                      {(a) => (
                        <button
                          class="seg-btn"
                          role="radio"
                          aria-checked={meshPlane.axis === a}
                          classList={{ active: meshPlane.axis === a }}
                          onClick={() => {
                            const lines = b().mesh[a];
                            const zero = lines.findIndex((v) => v >= 0);
                            setMeshPlane({ axis: a, index: Math.max(0, zero) });
                          }}
                        >
                          {a}
                        </button>
                      )}
                    </For>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={axisLines().length - 1}
                    value={meshPlane.index}
                    onInput={(e) => setMeshPlane("index", Number(e.currentTarget.value))}
                    aria-label={t("results.mesh.planePosition")}
                  />
                  <span class="mono mesh-pos">
                    {meshPlane.axis} = {num(axisLines()[meshPlane.index], 3)} mm
                  </span>
                </div>
              </Show>
            </section>

            <section class="section">
              <h3 class="section-label">{t("model.parameters")}</h3>
              <dl class="kv">
                <For each={b().model.params}>
                  {(p) => (
                    <>
                      <dt title={p.description || p.key}>{paramLabelText(p.label)}</dt>
                      <dd class="mono" classList={{ changed: p.value !== p.default }}>
                        {typeof p.value === "number" ? fmt.num(p.value, 6) : String(p.value)}
                        <Show when={p.unit}> {p.unit}</Show>
                      </dd>
                    </>
                  )}
                </For>
              </dl>
            </section>
          </>
        )}
      </Show>
    </aside>
  );
}
