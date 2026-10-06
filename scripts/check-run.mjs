// Checks for the run outcome text (src/lib/run.ts convergenceText): a run that stopped at the
// timestep limit names its likely cause (the excitation pulse, or slow decay), and bundles from
// before the pulse length was recorded keep the plain text.
//
//   node --experimental-strip-types scripts/check-run.mjs

import { convergenceText, efficiencyWarning, energyText } from "../src/lib/run.ts";
import { convergenceTextUi, efficiencyWarningUi, energyTextUi } from "../src/lib/runText.ts";
import { setLanguage } from "../src/i18n/index.ts";

let checks = 0;
let failures = 0;
const has = (text, part, where) => {
  checks++;
  if (!text.includes(part)) {
    failures++;
    console.error(`  FAIL ${where}: ${JSON.stringify(part)} not in ${JSON.stringify(text)}`);
  }
};
const lacks = (text, part, where) => {
  checks++;
  if (text.includes(part)) {
    failures++;
    console.error(`  FAIL ${where}: ${JSON.stringify(part)} unexpectedly in ${JSON.stringify(text)}`);
  }
};

const run = (extra) => ({
  energy_trace: [{ timestep: 51747, db: -8.2 }], final_energy_db: -8.2, timesteps: 60000,
  hit_timestep_limit: true, converged: false, threads: 1, host: { os: "", machine: "", cpu: null }, log_tail: [], ...extra,
});
const limits = { maxTimesteps: 60000, minCell: 0.01167 };

// the user's thin-copper run: the pulse took most of the limit
let t = convergenceText(run({ excitation_timesteps: 54760, timestep_s: 3.30737e-14 }), -50, limits);
has(t, "Not converged: stopped at the timestep limit", "pulse: head");
has(t, "took 54,760 of the 60,000 timesteps at a timestep of 33 fs", "pulse: numbers");
has(t, "smallest cell (0.012 mm)", "pulse: cell");
has(t, "Model thin metal as sheets", "pulse: advice");

// a pulse longer than the limit
t = convergenceText(run({ excitation_timesteps: 62700, timestep_s: 3.3e-14 }), -50, limits);
has(t, "needs 62,700 timesteps", "over: needs");
has(t, "more than the limit of 60,000", "over: limit");

// a short pulse and a slow decay
t = convergenceText(run({ excitation_timesteps: 1654, timestep_s: 1.1e-12 }), -50, limits);
has(t, "The fields were still decaying", "slow decay");
lacks(t, "excitation pulse", "slow decay: no pulse sentence");

// an older bundle without the pulse length keeps the plain text
t = convergenceText(run({}), -50, limits);
lacks(t, "excitation pulse", "old bundle: no pulse sentence");
lacks(t, "still decaying", "old bundle: no decay sentence");

// converged, and stopped early without hitting the limit
t = convergenceText(run({ converged: true, hit_timestep_limit: false, final_energy_db: undefined, timesteps: 3192, excitation_timesteps: 1654 }), -50, limits);
has(t, "Converged: field energy reached the end criterion", "converged");
t = convergenceText(run({ hit_timestep_limit: false, excitation_timesteps: 54760 }), -50, limits);
lacks(t, "excitation pulse", "not at the limit: no cause");

// UI result messages follow the selected language, while report calls keep their English default.
setLanguage("tr");
const converged = run({ converged: true, hit_timestep_limit: false, final_energy_db: undefined, timesteps: 3192, excitation_timesteps: 1654 });
const trConvergence = convergenceTextUi(converged, -50, limits);
has(trConvergence, "Yakınsadı", "Turkish UI convergence");
lacks(trConvergence, "Converged", "Turkish UI convergence: no English copy");
const trEnergy = energyTextUi({ db: -60, bound: true, timestep: 1234 });
has(trEnergy, "zaman adımında", "Turkish UI energy");
lacks(trEnergy, "timestep", "Turkish UI energy: no English copy");
const farfield = {
  f: 2e9, theta: [], phi: [], directivity_dbi: [], dmax_dbi: 0, rad_efficiency: 1.1,
  prad_w: 1.1, pacc_w: 1, qa_warnings: ["radiation efficiency 110.0 % at 2.000 GHz exceeds 100 %"],
};
const trWarning = efficiencyWarningUi(farfield);
has(trWarning, "ışıma verimi", "Turkish UI efficiency warning");
lacks(trWarning, "radiation efficiency", "Turkish UI efficiency warning: no English copy");
has(convergenceText(converged, -50, limits), "Converged", "English report remains English under Turkish UI");
has(energyText({ db: -60, bound: true, timestep: 1234 }), "at timestep", "English report energy remains English under Turkish UI");
has(efficiencyWarning(farfield), "radiation efficiency", "English report warning remains English under Turkish UI");
setLanguage("en");
has(convergenceTextUi(converged, -50, limits), "Converged", "English UI copy remains unchanged");

console.log(`run text: ${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
