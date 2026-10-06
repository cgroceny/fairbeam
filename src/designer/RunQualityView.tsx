// The run quality verdict (src/lib/runQuality.ts) in the designer: an amber banner over a run's result
// tabs and the Run tab, and the small badge in the navigation tree and the Runs table. A run that did
// not converge (or shows unphysical numbers) must not look like a good result.
import { createMemo, For, Show } from "solid-js";
import { TriangleAlert } from "lucide-solid";
import { matchHint, POOR_MATCH_DB, type QualityReason, type RunQuality } from "../lib/runQuality";
import { openSimSettings, setDesignDockTab } from "../runner/designRun";
import type { Bundle } from "../types";
import { fmt, t } from "../i18n";
import { bundleQuality, comparedRuns, runShortLabel, showView } from "./runResults";
import "../styles/run-quality.css";

/** The verdict when it is a concern (not converged, or suspicious); null for a clean run. */
export const concern = (q: RunQuality | null | undefined): RunQuality | null => (q && q.verdict !== "converged" ? q : null);

const ghz = (f: number) => fmt.num(f / 1e9, 3);

/** One reason worded, with the settings or view that fixes it. */
function reasonText(r: QualityReason, notConverged = false): { text: string; action: { label: string; run: () => void } } {
  switch (r.code) {
    case "timestep-limit": return {
      text: t(r.port === undefined ? "quality.reason.timestepLimit" : "quality.reason.timestepLimitPort", { port: r.port }),
      action: { label: t("quality.action.solver"), run: () => openSimSettings("solver") },
    };
    case "s11-above-0db": return {
      text: t(notConverged ? "quality.reason.s11NotConverged" : "quality.reason.s11", { db: fmt.fixed(r.db, 2), f: ghz(r.f), port: r.port }),
      action: notConverged ? { label: t("quality.action.solver"), run: () => openSimSettings("solver") }
        : { label: t("quality.action.mesh"), run: () => openSimSettings("mesh") },
    };
    case "port-uncoupled": return {
      text: r.s11MinDb !== undefined && r.efficiency !== undefined
        ? t("quality.reason.uncoupledBoth", { db: fmt.fixed(r.s11MinDb, 2), eta: fmt.num(r.efficiency * 100, 2), port: r.port })
        : r.s11MinDb !== undefined ? t("quality.reason.uncoupledS11", { db: fmt.fixed(r.s11MinDb, 2), port: r.port })
          : t("quality.reason.uncoupledEfficiency", { eta: fmt.num((r.efficiency ?? 0) * 100, 2) }),
      action: { label: t("quality.action.checks"), run: () => setDesignDockTab("checks") },
    };
    case "efficiency-above-100": return {
      text: t("quality.reason.efficiency", { eta: fmt.num(r.efficiency * 100, 1), f: ghz(r.f) }),
      action: { label: t("quality.action.efficiency"), run: () => showView("efficiency", undefined, "main") },
    };
  }
}

/** The headline of a verdict that is a concern: the port that is not coupled has its own words (the
 * other "suspicious" reasons are unphysical numbers). */
export const verdictHeadline = (q: RunQuality, other = false) =>
  q.verdict === "not-converged" ? (other ? "quality.banner.otherNotConverged" : "quality.banner.notConverged")
    : q.reasons.some((r) => r.code === "port-uncoupled") && q.reasons.every((r) => r.code === "port-uncoupled")
      ? (other ? "quality.banner.otherUncoupled" : "quality.banner.uncoupled")
      : other ? "quality.banner.otherSuspicious" : "quality.banner.suspicious";

/** The short badge text of a verdict. */
export const verdictLabel = (q: RunQuality) => t(q.verdict === "not-converged" ? "quality.badge.notConverged" : q.reasons.every((r) => r.code === "port-uncoupled") ? "quality.badge.uncoupled" : "quality.badge.check");

/** Every reason of one verdict as list items. */
function Reasons(props: { q: RunQuality }) {
  // after a run stopped at the limit, |S11| above 0 dB is the truncation's doing: say so first
  const reasons = () => props.q.verdict === "not-converged"
    ? [...props.q.reasons].sort((a, b) => Number(b.code === "timestep-limit") - Number(a.code === "timestep-limit"))
    : props.q.reasons;
  return <ul class="rq-reasons"><For each={reasons()}>{(r) => {
    const w = reasonText(r, props.q.verdict === "not-converged");
    return <li><span>{w.text}</span> <button type="button" class="linklike" onClick={w.action.run}>{w.action.label}</button></li>;
  }}</For></ul>;
}

/** The banner over a run's result: the shown run, and the compared runs that have a concern too.
 * Nothing for a clean run. */
export function RunQualityBanner(props: { file?: string; b: Bundle }) {
  const own = createMemo(() => concern(bundleQuality(props.b)));
  const hint = createMemo(() => matchHint(props.b));
  const others = createMemo(() => comparedRuns().flatMap((c) => {
    const q = concern(bundleQuality(c.bundle));
    return q ? [{ file: c.file, q }] : [];
  }));
  const severe = () => own()?.verdict === "not-converged" || others().some((o) => o.q.verdict === "not-converged");
  return (
    <>
    <Show when={hint()}>{(h) => (
      <div class="rq-banner rq-hint" role="status" data-verdict="hint">
        <div class="rq-body">
          <span>{t(h().off === "below" ? "quality.hint.matchBelow" : h().off === "above" ? "quality.hint.matchAbove" : "quality.hint.matchPoor", {
            f: ghz(h().f), f0: ghz(h().f0), db: fmt.fixed(h().db, 1), pct: fmt.num(Math.abs(h().f - h().f0) / h().f0 * 100, 0), limit: fmt.fixed(POOR_MATCH_DB, 0),
          })}</span>
          <Show when={h().db > POOR_MATCH_DB}> <span>{t("quality.hint.matchFeed")}</span></Show>
        </div>
      </div>
    )}</Show>
    <Show when={own() || others().length}>
      <div class="rq-banner" role="status" data-verdict={severe() ? "not-converged" : "suspicious"}>
        <TriangleAlert size={16} aria-hidden="true" />
        <div class="rq-body">
          <Show when={own()}>{(q) => (
            <>
              <strong>{t(verdictHeadline(q()))}</strong>
              <Reasons q={q()} />
            </>
          )}</Show>
          <For each={others()}>{(o) => (
            <>
              <strong>{t(verdictHeadline(o.q, true), { run: runShortLabel(o.file) })}</strong>
              <Reasons q={o.q} />
            </>
          )}</For>
        </div>
      </div>
    </Show>
    </>
  );
}

/** The badge of a verdict: the icon alone in the tree (`compact`), the icon with its label in a table. */
export function RunQualityBadge(props: { q: RunQuality | null | undefined; compact?: boolean }) {
  const q = () => concern(props.q);
  return (
    <Show when={q()}>{(c) => (
      <span class="rq-badge" classList={{ "rq-badge-compact": props.compact }} data-verdict={c().verdict} title={t(verdictHeadline(c()))}>
        <TriangleAlert size={props.compact ? 12 : 13} aria-hidden="true" />
        <Show when={!props.compact} fallback={<span class="visually-hidden">{verdictLabel(c())}</span>}>{verdictLabel(c())}</Show>
      </span>
    )}</Show>
  );
}
