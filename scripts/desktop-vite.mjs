// `npm run desktop:vite` (started by `tauri dev`): Vite on 5315 with /api proxied to the desktop
// shell's server (FAIRBEAM_API_PORT, default 5325). A script so it also runs in PowerShell / cmd.
import { spawnSync } from "node:child_process";

const api = process.env.FAIRBEAM_API || `http://127.0.0.1:${process.env.FAIRBEAM_API_PORT || 5325}`;
const r = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5315", "--strictPort"],
  { stdio: "inherit", env: { ...process.env, FAIRBEAM_API: api } });
process.exit(r.status ?? 1);
