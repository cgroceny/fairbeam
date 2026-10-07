import type { Bundle } from "../types.ts";
import { touchstoneNPort, touchstoneS1p } from "../export/touchstone.ts";
import { sMatrix } from "../lib/sparams.ts";
import { saveDownload, type DownloadResult } from "../lib/download.ts";
import { resultExportStem } from "../lib/resultExportNames.ts";
import { countUsage } from "../lib/telemetry.ts";
import { t } from "../i18n/index.ts";

type Run = { file: string; bundle: Bundle };

function safeBase(value: string): string {
  const leaf = String(value ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const clean = leaf.replace(/\.(?:json|zip|s\d+p)$/i, "").normalize("NFKC")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim();
  return clean.replace(/\s+/g, "_").slice(0, 220) || "results";
}

function checkedText(bundle: Bundle, label: string): { text: string; ports: number[] } {
  const matrix = sMatrix(bundle);
  if (!matrix || !bundle.results || !matrix.f.length || matrix.f.some((f) => !Number.isFinite(f))) {
    throw new Error(t("results.touchstone.noFrequency", { label }));
  }
  if (!matrix.ports.length || matrix.zRef.length !== matrix.ports.length || matrix.zRef.some((z) => !Number.isFinite(z) || z <= 0)) {
    throw new Error(t("results.touchstone.noPorts", { label }));
  }
  let text: string | null;
  if (matrix.ports.length === 1) {
    const port = matrix.ports[0];
    const excited = bundle.ports.find((p) => p.excite) ?? bundle.ports[0];
    if (!excited || excited.number !== port) throw new Error(t("results.touchstone.portMismatch", { label }));
    const c = matrix.get(port, port);
    if (!c || c.re.length !== matrix.f.length || c.im.length !== matrix.f.length || c.re.some((x, i) => !Number.isFinite(x) || !Number.isFinite(c.im[i]))) {
      throw new Error(t("results.touchstone.badS11", { label }));
    }
    const pr = bundle.results.ports[String(port)];
    if (!pr || !Number.isFinite(pr.z_ref) || Math.abs(pr.z_ref - matrix.zRef[0]) > 1e-9) {
      throw new Error(t("results.touchstone.zRefMismatch", { label }));
    }
    // The existing S1P writer reads the sweep port arrays. Reject a bundle whose optional
    // matrix disagrees, so its output cannot silently differ from the values checked above.
    if (pr.s11_re.length !== matrix.f.length || pr.s11_im.length !== matrix.f.length ||
      pr.s11_re.some((re, k) => !Number.isFinite(re) || !Number.isFinite(pr.s11_im[k]) ||
        re !== c.re[k] || pr.s11_im[k] !== c.im[k])) {
      throw new Error(t("results.touchstone.disagree", { label }));
    }
    text = touchstoneS1p(bundle);
  } else {
    if (matrix.legacy) throw new Error(t("results.touchstone.needMatrix", { label }));
    const z0 = matrix.zRef[0];
    if (matrix.zRef.some((z) => Math.abs(z - z0) > 1e-9)) throw new Error(t("results.touchstone.equalZRef", { label }));
    for (const i of matrix.ports) for (const j of matrix.ports) {
      const c = matrix.get(i, j);
      if (!c || c.re.length !== matrix.f.length || c.im.length !== matrix.f.length || c.re.some((x, k) => !Number.isFinite(x) || !Number.isFinite(c.im[k]))) {
        throw new Error(t("results.touchstone.badMatrix", { label, pair: `S${i}${j}` }));
      }
    }
    text = touchstoneNPort(bundle);
  }
  if (!text) throw new Error(t("results.touchstone.failed", { label }));
  return { text, ports: matrix.ports };
}

/** Every Touchstone export of the app; counted for the usage statistics (docs/TELEMETRY.md) once saved. */
export async function exportResultTouchstone(bundle: Bundle, filenameBase: string, runs?: Run[]): Promise<DownloadResult> {
  const result = await writeResultTouchstone(bundle, filenameBase, runs);
  if (result.status !== "cancelled" && result.status !== "failed") countUsage("feature.touchstone_export");
  return result;
}

async function writeResultTouchstone(bundle: Bundle, filenameBase: string, runs?: Run[]): Promise<DownloadResult> {
  const base = safeBase(filenameBase);
  if (!runs || runs.length < 2) {
    const { text, ports } = checkedText(bundle, t("results.touchstone.result"));
    const ext = ports.length === 1 ? ".s1p" : `.s${ports.length}p`;
    return saveDownload(`${base}${ext}`, text, "text/plain;charset=utf-8");
  }
  const members: Record<string, Uint8Array> = Object.create(null);
  const used = new Set<string>();
  for (const run of runs) {
    const { text, ports } = checkedText(run.bundle, run.file || t("results.touchstone.run"));
    const suffix = ports.length === 1 ? ".s1p" : `.s${ports.length}p`;
    const stem = resultExportStem(run.bundle, "sparams");
    let uniqueStem = stem;
    for (let n = 2; used.has(`${uniqueStem}${suffix}`.toLowerCase()); n++) uniqueStem = `${stem}_${n}`;
    const name = `${uniqueStem}${suffix}`;
    used.add(name.toLowerCase());
    members[name] = new TextEncoder().encode(text);
  }
  const { zipSync } = await import("fflate");
  const zip = zipSync(members, { level: 6 });
  return saveDownload(`${base}.zip`, zip, "application/zip");
}
