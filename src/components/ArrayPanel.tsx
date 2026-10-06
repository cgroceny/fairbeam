// "Array" dock tab: beam steering from embedded element patterns. Per-port amplitude and phase
// (with a phasor per port), a live scan-angle slider, reset to uniform, and the resulting main
// beam, HPBW, Dmax and active reflection per port. The steered pattern feeds the 3D view and the
// Pattern tab (arrayStore).

import { createMemo, For, Show } from "solid-js";
import { RotateCcw, TriangleAlert } from "lucide-solid";
import { bundle } from "../state";
import { activeReflection, gammaDb, uniformWeights, type Weight } from "../lib/array";
import { arraySet, arrayWeights, scanPhi, scanTheta, setArrayWeights, setScanTheta, steer, steeredBeam, steeredFarField } from "../lib/arrayStore";
import { radioGroupKeys } from "../lib/a11y";
import { sMatrix } from "../lib/sparams";
import { num } from "../lib/format";
import { t } from "../i18n";
import NumberField from "./NumberField";

const clampNum = (v: string, lo: number, hi: number, fallback: number) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;
};

/** Feed phasor: arrow at the port's phase (counter-clockwise from the right), length ∝ amplitude. */
function Phasor(props: { w: Weight; maxAmp: number }) {
  const R = 9;
  const len = () => (R - 1) * Math.min(1, Math.pow(10, props.w.ampDb / 20) / (props.maxAmp || 1));
  const a = () => (props.w.phaseDeg * Math.PI) / 180;
  const tip = () => [11 + len() * Math.cos(a()), 11 - len() * Math.sin(a())];
  return (
    <svg class="array-phasor" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <circle cx="11" cy="11" r={R} />
      <line x1="11" y1="11" x2={tip()[0]} y2={tip()[1]} />
      <circle class="array-phasor-tip" cx={tip()[0]} cy={tip()[1]} r="1.8" />
    </svg>
  );
}

export default function ArrayPanel() {
  const set = arraySet;
  const ports = () => set()?.elements.map((e) => e.port) ?? [];
  const S = createMemo(() => sMatrix(bundle()));
  const active = createMemo(() => {
    const s = S();
    const st = set();
    return s && st ? activeReflection(s, arrayWeights(), st.f) : new Map<number, [number, number] | null>();
  });
  const bad = () => [...active()].filter(([, g]) => g && gammaDb(g) > -10).map(([p]) => p);

  const update = (port: number, patch: Partial<Weight>) => {
    const next = new Map(arrayWeights());
    next.set(port, { ...(next.get(port) ?? { ampDb: 0, phaseDeg: 0 }), ...patch });
    setArrayWeights(next);
  };
  const reset = () => {
    setArrayWeights(uniformWeights(ports()));
    setScanTheta(0);
  };
  const maxAmp = () => Math.max(...[...arrayWeights().values()].map((w) => Math.pow(10, w.ampDb / 20)), 1e-9);
  const thetaMax = () => (bundle()?.half_space ? 80 : 90);

  return (
    <Show when={set()} fallback={<div class="panel-empty">{t("array.noPatterns")}</div>}>
      <div class="array-wrap"><div class="array-panel">
        <section class="array-block" aria-labelledby="array-weights">
          <h3 class="section-label" id="array-weights">
            {t("array.weights")}
            <button class="btn btn-ghost btn-sm push" onClick={reset} title={t("array.uniformTitle")}>
              <RotateCcw size={14} aria-hidden="true" /> {t("array.uniform")}
            </button>
          </h3>
          <div class="array-table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>{t("spec.port")}</th>
                  <th>{t("array.feed")}</th>
                  <th class="num">{t("array.amplitude")}<span class="th-unit">dB</span></th>
                  <th class="num">{t("chart.q.phase")}<span class="th-unit">°</span></th>
                  <th class="num">{t("array.activeGamma")}<span class="th-unit">dB</span></th>
                </tr>
              </thead>
              <tbody>
                <For each={ports()}>
                  {(p) => {
                    const w = () => arrayWeights().get(p) ?? { ampDb: 0, phaseDeg: 0 };
                    const g = () => active().get(p);
                    const db = () => (g() ? gammaDb(g()!) : null);
                    return (
                      <tr>
                        <td class="mono">P{p}</td>
                        <td><Phasor w={w()} maxAmp={maxAmp()} /></td>
                        <td class="num">
                          <NumberField class="rp-input array-input" step="0.5" min="-60" max="20" aria-label={t("array.amplitudeAria", { port: p })} value={w().ampDb}
                            onChange={(e) => update(p, { ampDb: clampNum(e.currentTarget.value, -60, 20, w().ampDb) })} />
                        </td>
                        <td class="num">
                          <NumberField class="rp-input array-input" step="5" min="-360" max="360" aria-label={t("array.phaseAria", { port: p })} value={w().phaseDeg}
                            onChange={(e) => update(p, { phaseDeg: clampNum(e.currentTarget.value, -360, 360, w().phaseDeg) })} />
                        </td>
                        <td class="num">
                          <Show when={db() !== null} fallback="—">
                            <Show when={db()! > -10} fallback={<span class="mono">{num(db()!, 1)}</span>}>
                              <span class="status status-warn" title={t("array.poorMatchTitle")}>
                                <TriangleAlert size={12} aria-hidden="true" /> {num(db()!, 1)} · {t("array.above10")}
                              </span>
                            </Show>
                          </Show>
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </section>

        <section class="array-block stack" aria-labelledby="array-steer">
          <h3 class="section-label" id="array-steer">{t("array.steer")}</h3>
          <p class="note">{t("array.steerNote")}</p>
          <div class="array-steer">
            <span class="rp-mini">{t("array.scanPlane")}</span>
            <div class="seg seg-sm" role="radiogroup" aria-label={t("array.scanPlane")} onKeyDown={radioGroupKeys}>
              <button class="seg-btn" role="radio" aria-checked={scanPhi() === 0} aria-label={t("array.planeXzAria")} title={t("array.planeXz")} onClick={() => steer(scanTheta(), 0)}>xz</button>
              <button class="seg-btn" role="radio" aria-checked={scanPhi() === 90} aria-label={t("array.planeYzAria")} title={t("array.planeYz")} onClick={() => steer(scanTheta(), 90)}>yz</button>
            </div>
            <label class="rp-mini" for="array-scan">{t("array.scanAngle")}</label>
            <div class="array-scan">
              <input id="array-scan" type="range" min={-thetaMax()} max={thetaMax()} step="1" value={scanTheta()}
                aria-valuetext={t("array.degrees", { n: scanTheta() })} onInput={(e) => steer(Number(e.currentTarget.value), scanPhi())} />
              <NumberField class="rp-input array-input" min={-thetaMax()} max={thetaMax()} step="5" value={scanTheta()} aria-label={t("array.scanAngleAria")}
                onChange={(e) => steer(clampNum(e.currentTarget.value, -thetaMax(), thetaMax(), scanTheta()), scanPhi())} />
              <span class="rp-unit">°</span>
            </div>
          </div>
          <p class="note">{t("array.formula", { f: num((set()!.f) / 1e9, 3) })}</p>
        </section>

        <section class="array-block" aria-labelledby="array-beam">
          <h3 class="section-label" id="array-beam">{t("array.pattern")}</h3>
          <Show when={steeredBeam()}>
            {(bm) => (
              <dl class="kv">
                <dt>{t("results.pattern.frequency")}</dt><dd class="mono">{num(set()!.f / 1e9, 3)} GHz</dd>
                <dt>{t("array.mainBeam")}</dt><dd class="mono">θ {bm().theta}° · φ {bm().phi}°</dd>
                <dt>Dmax</dt><dd class="mono">{num(steeredFarField()!.dmax_dbi, 2)} dBi</dd>
                <dt>{t("array.hpbwElevation")}</dt><dd class="mono">{bm().hpbwTheta === null ? "—" : `${num(bm().hpbwTheta!, 1)}°`}</dd>
                <dt>{t("array.hpbwAcross")}</dt><dd class="mono">{bm().hpbwPhi === null ? "—" : `${num(bm().hpbwPhi!, 1)}°`}</dd>
              </dl>
            )}
          </Show>
          <Show when={bad().length}>
            <p class="status-block status-warn" role="status">
              <TriangleAlert size={14} aria-hidden="true" />
              <span>{t("array.activeAbove", { ports: bad().map((p) => `P${p}`).join(", ") })}</span>
            </p>
          </Show>
          <Show when={!S() || S()!.legacy}>
            <p class="note">{t("array.noSMatrix")}</p>
          </Show>
        </section>
      </div></div>
    </Show>
  );
}
