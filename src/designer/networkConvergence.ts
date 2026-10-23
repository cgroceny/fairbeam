// Opt-in network criteria reuse the CLI grammar and backend measurements. Frequencies
// in requests are GHz; saved studies and result measurements use Hz.
import { t } from "../i18n/index.ts";
import type { ConvergenceStudy } from "./convergence";

export const NETWORK_KINDS = ["coupling", "isolation", "directivity", "phase", "phase_balance", "s11"] as const;
export type NetworkKind = typeof NETWORK_KINDS[number];
export interface NetworkDraft { kind: NetworkKind; output: string; reference: string; input: string; tolerance: string }
export interface NetworkRequest { frequency_ghz: number; metrics: string[] }
export interface NetworkCriterion { key: string; kind: Exclude<NetworkKind, "phase_balance">; ports: number[]; tolerance: number; unit: "deg" | "dB" }
export interface NetworkConfig { frequency_hz: number; criteria: NetworkCriterion[] }
export interface NetworkMeasurement extends NetworkConfig { values: { value: number | null; reason: string | null }[]; solver_converged: boolean }
export interface NetworkCheck extends NetworkCriterion { before: number | null; after: number | null; delta: number | null; ok: boolean; reason: string | null }
export interface NetworkStep { checks: NetworkCheck[]; converged: boolean; reason: string | null }

export const isRelativeNetwork = (kind: NetworkKind) => kind === "directivity" || kind === "phase_balance";
export const networkUnit = (kind: NetworkKind) => kind === "phase" || kind === "phase_balance" ? "deg" : "dB";
export function newNetworkDraft(ports: readonly number[]): NetworkDraft {
  return { kind: ports.length > 1 ? "coupling" : "s11", output: String(ports[1] ?? ports[0] ?? ""), reference: String(ports[2] ?? ports[0] ?? ""), input: String(ports[0] ?? ""), tolerance: "0.2" };
}

/** Disabled means absent, including when unfinished inputs remain in the dialog. */
export function networkRequest(enabled: boolean, frequency: string, rows: readonly NetworkDraft[], ports: readonly number[]): { request?: NetworkRequest; error?: string } {
  if (!enabled) return {};
  const f = Number(frequency);
  if (!frequency.trim() || !Number.isFinite(f) || f <= 0 || !Number.isFinite(f * 1e9)) return { error: t("conv.net.err.frequency") };
  if (!rows.length || rows.length > 12) return { error: t("conv.net.err.count") };
  const metrics: string[] = [], keys = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const n = index + 1;
    if (!(NETWORK_KINDS as readonly string[]).includes(row.kind)) return { error: t("conv.net.err.kind", { n }) };
    const ps = (row.kind === "s11" ? [row.output] : isRelativeNetwork(row.kind) ? [row.output, row.reference, row.input] : [row.output, row.input]).map(Number);
    if (ps.some(p => !Number.isInteger(p) || p < 1 || !ports.includes(p))) return { error: t("conv.net.err.ports", { n }) };
    if (isRelativeNetwork(row.kind) && ps[0] === ps[1]) return { error: t("conv.net.err.outputs", { n }) };
    const tolerance = Number(row.tolerance);
    if (!row.tolerance.trim() || !Number.isFinite(tolerance) || tolerance <= 0) return { error: t("conv.net.err.tolerance", { n }) };
    const kind = row.kind === "phase_balance" ? "phase" : row.kind;
    const key = `${kind}:${ps.join(",")}`;
    if (keys.has(key)) return { error: t("conv.net.err.duplicate", { n }) };
    keys.add(key);
    metrics.push(`${key}:${tolerance}`);
  }
  return { request: { frequency_ghz: f, metrics } };
}

export function networkLabel(criterion: NetworkCriterion): string {
  const kind = criterion.kind === "phase" && criterion.ports.length === 3 ? "phase_balance" : criterion.kind;
  return `${t(`conv.net.kind.${kind}`)} (${criterion.ports.join(", ")})`;
}

/** Backend reasons are an explicit contract; unknown failures stay visible. */
export function networkReason(reason: string | null | undefined): string {
  const known: Record<string, string> = {
    "frequency is outside the valid sampled band": "band",
    "requested port is absent": "port",
    "requested excitation column is absent": "column",
    "invalid complex S-parameter samples": "samples",
    "response is too close to stored precision (amplitude <= 1e-4)": "precision",
    "network measurements missing or inconsistent": "missing",
    "energy convergence missing": "energy",
  };
  return reason ? known[reason] ? t(`conv.net.reason.${known[reason]}`) : reason : "";
}

/** Display unavailable/incomplete evidence without turning it into a pass. */
export function networkReportRows(study: ConvergenceStudy) {
  return study.members.flatMap((member, index) => (study.network_criteria?.criteria ?? []).map((criterion, ci) => {
    const measured = member.metrics.network;
    const spec = measured?.criteria?.[ci];
    const matches = measured?.frequency_hz === study.network_criteria?.frequency_hz && spec?.key === criterion.key
      && spec?.tolerance === criterion.tolerance && spec?.unit === criterion.unit;
    const measurement = matches ? measured?.values?.[ci] : undefined;
    const step = index ? study.convergence.steps[index - 1] : undefined;
    const check = step?.network?.checks.find(check => check.key === criterion.key);
    const value = measurement?.value;
    const available = typeof value === "number" && Number.isFinite(value);
    const evidenceMissing = member.status === "done" && (!measurement || index > 0 && !check);
    const reason = networkReason(measurement?.reason ?? check?.reason ?? step?.network?.reason ?? (evidenceMissing ? "network measurements missing or inconsistent" : null));
    const status = member.status !== "done" || !available ? t("conv.net.unavailable")
      : !index ? t("conv.net.first") : !check || check.reason ? t("conv.net.unavailable")
      : measured?.solver_converged !== true || study.members[index - 1].metrics.network?.solver_converged !== true
        || step?.quality?.energy !== true || step?.quality?.local_mesh !== true ? t("conv.net.unverified")
      : check.ok ? t("conv.yes") : t("conv.no");
    return { density: member.density, criterion, value: available ? value : null, delta: check?.delta ?? null, status, reason };
  }));
}
