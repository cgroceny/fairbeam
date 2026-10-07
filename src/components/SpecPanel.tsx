import { For, Show } from "solid-js";
import { CircleCheck, TriangleAlert } from "lucide-solid";
import { bundle, farfieldIndex, setDockTab, setFarfieldIndex, setLayers } from "../state";
import { bandTexts } from "../lib/bands";
import { compact, GHz, ghzText, num, seconds, timeUnit } from "../lib/format";
import { bundleWriter } from "../lib/appVersion";
import { convergenceTextUi, efficiencyIssue, efficiencyWarningUi } from "../lib/runText";
import ComparisonCard from "./ComparisonCard";
import MeasuredTimes from "./MeasuredTimes";
import { fmt, t } from "../i18n";

// The solver card's terms in plain words: the method and the boundaries are translated where the
// bundle carries a known value, and each has a tooltip for a newcomer (an unknown value shows as is).
const FDTD_YEE = "FDTD (Yee, staircase)";
const methodLabel = (method: string) => (method === FDTD_YEE ? t("spec.method.fdtdYee") : method);
const methodTitle = (method: string) => (method === FDTD_YEE ? t("spec.method.fdtdYee.title") : undefined);
const BOUNDARY_HINT: Record<string, string> = { MUR: "sim.bound.mur.hint", PML_8: "sim.bound.pml.hint", PEC: "sim.bound.pec.hint", PMC: "sim.bound.pmc.hint" };
const boundaryLabel = (code: string) => (BOUNDARY_HINT[code] ? t(`spec.boundary.${code}`) : code);
const boundaryHint = (code: string) => (BOUNDARY_HINT[code] ? t(BOUNDARY_HINT[code]) : undefined);

export default function SpecPanel() {
  return (
    <aside class="panel panel-right" aria-label={t("spec.aria")}>
      <Show when={bundle()} fallback={<div class="panel-empty">{t("spec.empty")}</div>}>
        {(b) => {
          const r = () => b().run;
          const res = () => b().results;
          const dt = () => (res()?.signals && "dt_s" in res()!.signals ? (res()!.signals as { dt_s: number | null }).dt_s : null);
          return (
            <>
              <ComparisonCard />
              <Show when={res()?.bands.length || res()?.farfield.length}>
                <section class="section">
                  <h3 class="section-label">{t("spec.results")}</h3>
                  <Show when={res()!.bands.length} fallback={<p class="note">{t("spec.noBand")}</p>}>
                    <table class="table">
                      <caption>{t("spec.bandsCaption")}</caption>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th class="num" title={t("spec.centre.title")}>{t("spec.centre")}<span class="th-unit">GHz</span></th>
                          <th class="num" title={t("spec.bestMatch.title")}>{t("spec.bestMatch")}<span class="th-unit">GHz</span></th>
                          <th class="num">|S11| min<span class="th-unit">dB</span></th>
                          <th class="num">{t("spec.bw")}<span class="th-unit">%</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={res()!.bands}>
                          {(band, i) => {
                            // the centre is the middle of the edges; the |S11| minimum is the best match
                            const c = bandTexts(band, (hz) => ghzText(hz / 1e9), fmt.fixed);
                            return (
                              <tr title={`${c.range} GHz${c.open ? ` · ${t("spec.bandOpen")}` : ""}`}>
                                <td>{i() + 1}</td>
                                <td class="num">{c.centre}</td>
                                <td class="num">{c.best}</td>
                                <td class="num">{num(band.s11_min_db, 1).replace(/^-/, "−")}</td>
                                <td class="num">{c.percent}</td>
                              </tr>
                            );
                          }}
                        </For>
                      </tbody>
                    </table>
                    <Show when={res()!.bands.some((b) => b.edge_lo || b.edge_hi)}><p class="note">{t("spec.bandOpenNote")}</p></Show>
                  </Show>
                  <Show when={res()!.farfield.length}>
                    <table class="table table-ff">
                      <caption>{t("spec.ffCaption")}</caption>
                      <thead>
                        <tr>
                          <Show when={res()!.farfield.some((f) => f.port)}>
                            <th title={t("spec.portTitle")}>{t("spec.port")}</th>
                          </Show>
                          <th class="num">f<span class="th-unit">GHz</span></th>
                          <th class="num">Dmax<span class="th-unit">dBi</span></th>
                          <th class="num">{t("farfield.quantity.gain")}<span class="th-unit">dBi</span></th>
                          <th class="num">η<span class="th-unit">%</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={res()!.farfield}>
                          {(ff, i) => (
                            <tr
                              class="row-select"
                              classList={{ selected: farfieldIndex() === i() }}
                              tabindex={0}
                              aria-selected={farfieldIndex() === i()}
                              onClick={() => { setFarfieldIndex(i()); setLayers("pattern", true); setDockTab("pattern"); }}
                              onKeyDown={(e) => e.key === "Enter" && (setFarfieldIndex(i()), setLayers("pattern", true), setDockTab("pattern"))}
                            >
                              <Show when={res()!.farfield.some((f) => f.port)}>
                                <td class="mono">{ff.port ? `P${ff.port}` : "—"}</td>
                              </Show>
                              <td class="num">{ghzText(ff.f / 1e9)}</td>
                              <td class="num">{num(ff.dmax_dbi, 2)}</td>
                              <td class="num">{ff.gain_dbi !== undefined ? num(ff.gain_dbi, 2) : "—"}</td>
                              <td class="num" classList={{ "cell-warn": !!efficiencyIssue(ff) }} title={efficiencyWarningUi(ff) ?? undefined}>
                                {ff.rad_efficiency !== null ? num(ff.rad_efficiency * 100, 1) : "—"}
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                    <Show when={res()!.farfield.some((ff) => efficiencyIssue(ff))}>
                      <p class="status-block status-warn">
                        <TriangleAlert size={14} aria-hidden="true" />
                        <span>
                          {t("spec.overUnity", { list: res()!.farfield.filter((ff) => efficiencyIssue(ff)).map((ff) => t("spec.overUnityAt", { pct: t("format.percent", { value: num(ff.rad_efficiency! * 100, 1) }), f: num(ff.f / 1e9, 1) })).join(", ") })}
                        </span>
                      </p>
                    </Show>
                    <Show when={b().half_space}>
                      <p class="note">{t("spec.halfSpace")}</p>
                    </Show>
                  </Show>
                </section>
              </Show>

              <section class="section">
                <h3 class="section-label">{t("spec.run")}</h3>
                <Show when={r()} fallback={<p class="muted">{t("spec.geometryOnly")}</p>}>
                  <Show
                    when={r()!.converged}
                    fallback={
                      <p class="status-block status-warn">
                        <TriangleAlert size={14} />
                        <span>{convergenceTextUi(r()!, b().solver.end_criteria_db, { maxTimesteps: b().solver.max_timesteps, minCell: b().mesh.min_cell })}</span>
                      </p>
                    }
                  >
                    <p class="status-block status-good">
                      <CircleCheck size={14} />
                      <span>{convergenceTextUi(r()!, b().solver.end_criteria_db, { maxTimesteps: b().solver.max_timesteps, minCell: b().mesh.min_cell })}</span>
                    </p>
                  </Show>
                  <Show when={r()!.engine_warning}>
                    <p class="status-block status-warn">
                      <TriangleAlert size={14} aria-hidden="true" />
                      <span>{t("spec.gpuWarning", { warning: r()!.engine_warning })}</span>
                    </p>
                  </Show>
                  <dl class="kv">
                    <dt>{t("spec.timesteps")}</dt><dd class="mono">{r()!.timesteps !== undefined && r()!.timesteps !== null ? fmt.int(r()!.timesteps!) : "—"}</dd>
                    <dt>{t("spec.solverTime")}</dt><dd class="mono">{seconds(r()!.solver_time_s)}{(r()!.port_runs?.length ?? 0) > 1 ? ` · ${t("spec.port1")}` : ""}</dd>
                    <Show when={(r()!.port_runs?.length ?? 0) > 1 && r()!.wall_time_total_s}>
                      <dt>{t("spec.allRuns", { count: r()!.port_runs!.length })}</dt><dd class="mono">{t("spec.wall", { time: seconds(r()!.wall_time_total_s) })}</dd>
                    </Show>
                    <dt>{t("spec.throughput")}</dt><dd class="mono">{num(r()!.speed_mcells_s, 0)} MC/s</dd>
                    <dt>{t("measured.engine")}</dt><dd class="mono">{r()!.engine === "gpu" ? "GPU" : `${r()!.engine === "cpu" ? "CPU · " : ""}${t("spec.threads", { n: r()!.threads || t("spec.allThreads") })}`}</dd>
                    <dt>{t("spec.host")}</dt><dd>{r()!.host.cpu ?? r()!.host.machine}</dd>
                  </dl>
                </Show>
                <MeasuredTimes bundle={b()} />
              </section>

              <section class="section">
                <h3 class="section-label">{t("spec.solver")}</h3>
                <dl class="kv">
                  <dt>{t("measured.engine")}</dt><dd>{b().solver.engine}<span class="mono kv-sub" title={b().generator.openems ?? undefined}>{b().generator.openems}</span></dd>
                  <dt>{t("spec.method")}</dt><dd title={methodTitle(b().solver.method)}>{methodLabel(b().solver.method)}</dd>
                  <dt>{t("spec.excitation")}</dt>
                  <dd>
                    {b().solver.excitation.type === "gaussian-derivative" ? t("spec.gaussDerivative") : t("spec.modulatedGauss")}
                    <Show when={b().solver.excitation.dc_free}><span class="chip" title={t("spec.dcFree.title")}>{t("spec.dcFree")}</span></Show>
                  </dd>
                  <dt>{t("spec.band")}</dt><dd class="mono">{num(b().solver.excitation.f_min / 1e9, 2)}–{num(b().solver.excitation.f_max / 1e9, 2)} GHz</dd>
                  <dt>{t("spec.endCriterion")}</dt><dd class="mono">{fmt.num(b().solver.end_criteria_db, 1)} dB</dd>
                </dl>
                <div class="bc-grid" aria-label={t("spec.boundaries")}>
                  <For each={["x-", "x+", "y-", "y+", "z-", "z+"] as const}>
                    {(face) => (
                      <div class="bc-cell" classList={{ pec: b().solver.boundaries[face] === "PEC" }} title={boundaryHint(b().solver.boundaries[face])}>
                        <span class="mono bc-face">{face}</span>
                        <span>{boundaryLabel(b().solver.boundaries[face])}</span>
                      </div>
                    )}
                  </For>
                </div>
              </section>

              <section class="section">
                <h3 class="section-label">{t("spec.mesh")}</h3>
                <dl class="kv">
                  <dt>{t("spec.grid")}</dt><dd class="mono">{t("spec.gridLines", { x: b().mesh.x.length, y: b().mesh.y.length, z: b().mesh.z.length })}</dd>
                  <dt>{t("results.mesh.cells")}</dt><dd class="mono">{compact(b().mesh.total_cells)}</dd>
                  <dt>{t("results.mesh.smallest")}</dt><dd class="mono">{num(b().mesh.min_cell, 3)} mm</dd>
                  <dt>{t("results.mesh.largest")}</dt><dd class="mono">{num(b().mesh.max_cell, 2)} mm</dd>
                  <dt>{t("spec.lambdaPerCell")}</dt><dd class="mono">{num(299792458 / b().solver.excitation.f_max * 1e3 / b().mesh.max_cell, 1)}</dd>
                  <dt>{t("results.mesh.timestep")}</dt><dd class="mono">{timeUnit(dt())}</dd>
                </dl>
              </section>

              <section class="section">
                <h3 class="section-label">{t("spec.materials")}</h3>
                <dl class="kv">
                  <For each={b().parts}>
                    {(p) => (
                      <>
                        <dt>{p.label ?? p.name}</dt>
                        <dd class="mono">
                          <Show when={p.material} fallback="PEC">
                            εr {num(p.material!.eps_r, 2)}
                            <Show when={p.material!.tan_d}> · tan δ {fmt.num(p.material!.tan_d!, 6)} @ {GHz(p.material!.tan_d_freq ?? 0, 2)}</Show>
                          </Show>
                        </dd>
                      </>
                    )}
                  </For>
                </dl>
              </section>

              <section class="section section-foot">
                <p class="muted mono">
                  {[b().schema, bundleWriter(b()), b().generator.csxcad ? `CSXCAD ${b().generator.csxcad}` : null].filter(Boolean).join(" · ")}
                </p>
                <p class="muted mono">{b().created}</p>
              </section>
            </>
          );
        }}
      </Show>
    </aside>
  );
}
