// Browser-only presentation of run outcomes. The report helpers in run.ts remain locale-independent
// so Markdown and PDF exports keep their existing US English wording and decimal points.
import type { FarField, RunStats } from "../types";
import { fmt, locale, t } from "../i18n/index.ts";
import { convergenceText, efficiencyWarning, energyText, finalEnergy, losslessNote, type FinalEnergy, type RunLimits } from "./run.ts";

export function energyTextUi(value: FinalEnergy): string {
  if (locale() === "en") return energyText(value);
  if (value.db === null) return t("runText.energy.unknown");
  const energy = fmt.fixed(value.db, 1);
  if (value.timestep !== null) {
    const params = { value: energy, timestep: fmt.int(value.timestep) };
    return t(value.bound ? "runText.energy.boundAt" : "runText.energy.valueAt", params);
  }
  return t(value.bound ? "runText.energy.bound" : "runText.energy.value", { value: energy });
}

export function convergenceTextUi(run: RunStats, criterionDb: number, limits: RunLimits = {}): string {
  if (locale() === "en") return convergenceText(run, criterionDb, limits);
  const value = finalEnergy(run, criterionDb);
  const energy = energyTextUi(value);
  const criterion = fmt.fixed(criterionDb, 0);
  if (run.converged) {
    return value.bound && value.db === criterionDb
      ? t("runText.converged.atCriterion", { energy })
      : t("runText.converged.value", { energy, criterion });
  }
  const text = t(run.hit_timestep_limit ? "runText.notConverged.atLimit" : "runText.notConverged.stopped", { energy, criterion });
  if (!run.hit_timestep_limit) return text;
  const limit = limits.maxTimesteps ?? run.timesteps;
  const pulse = run.excitation_timesteps;
  if (pulse && limit && pulse >= limit / 2) {
    return `${text} ${t(pulse >= limit ? "runText.excitation.overLimit" : "runText.excitation.tookHalf", {
      pulse: fmt.int(pulse), limit: fmt.int(limit),
    })}`;
  }
  if (!pulse) return text;
  return `${text} ${t("runText.excitation.fieldsStillDecaying")}`;
}

/** efficiencyWarningUi for styling and summaries: null for a lossless model's power-balance note,
 * which stays readable in the tooltip but is not a warning (and never an over-unity value). */
export const efficiencyIssue = (ff: FarField): string | null => (losslessNote(ff) ? null : efficiencyWarningUi(ff));

export function efficiencyWarningUi(ff: FarField): string | null {
  if (locale() === "en") return efficiencyWarning(ff);
  const warning = ff.qa_warnings?.[0];
  const raw = ff.rad_efficiency_raw;
  const toleranceMatch = warning?.match(/within the ([\d.]+) % tolerance|beyond the ([\d.]+) % tolerance/);
  if (typeof raw === "number" && toleranceMatch) {
    return t(toleranceMatch[1] ? "runText.efficiency.losslessWithin" : "runText.efficiency.losslessOutside", {
      raw: fmt.fixed(raw * 100, 1),
      delta: fmt.fixed((raw - 1) * 100, 1),
      tolerance: toleranceMatch[1] ?? toleranceMatch[2],
      frequency: fmt.fixed(ff.f / 1e9, 3),
    });
  }

  const efficiency = ff.rad_efficiency;
  if (efficiency !== null && efficiency > 1) {
    return t("runText.efficiency.overUnity", {
      percent: fmt.fixed(efficiency * 100, 1),
      frequency: fmt.fixed(ff.f / 1e9, 3),
      excess: fmt.fixed((efficiency - 1) * 100, 1),
      errorDb: fmt.fixed(10 * Math.log10(efficiency), 2),
    });
  }
  if (warning) return t("runText.efficiency.qualityNote");
  return null;
}
