// npm run build:report: demo build with the bundle treemap (FAIRBEAM_REPORT, see vite.config.ts),
// then the size summary. A script rather than `VAR=1 cmd` so it also runs in PowerShell / cmd.
import { spawnSync } from "node:child_process";

const env = { ...process.env, FAIRBEAM_REPORT: process.env.FAIRBEAM_REPORT || "1" };
const run = (args) => {
  const r = spawnSync(process.execPath, args, { stdio: "inherit", env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run(["node_modules/vite/bin/vite.js", "build", "--mode", "demo", "--outDir", "dist-demo"]);
run(["scripts/bundle-report.mjs", "dist-demo"]);
