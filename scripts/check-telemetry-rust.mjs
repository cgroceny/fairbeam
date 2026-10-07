// Test the scheduling core in a temporary crate; does not build the desktop app.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const dir = mkdtempSync("/tmp/fairbeam-telemetry-core-");
try {
  const core = fileURLToPath(new URL("../src-tauri/src/telemetry_core.rs", import.meta.url));
  writeFileSync(join(dir, "Cargo.toml"), `[package]\nname = "fairbeam-telemetry-core-check"\nversion = "0.0.0"\nedition = "2021"\n[lib]\npath = ${JSON.stringify(core)}\n[dependencies]\nserde = { version = "1", features = ["derive"] }\nserde_json = "1"\ngetrandom = "0.3"\n[features]\ntelemetry = []\n`);
  const r = spawnSync("nice", ["-n", "15", "cargo", "test", "--features", "telemetry", "--manifest-path", join(dir, "Cargo.toml")], {
    stdio: "inherit", env: { ...process.env, CARGO_HOME: join(dir, "cargo-home"), CARGO_TARGET_DIR: join(dir, "target") },
  });
  if (r.error) throw r.error;
  process.exitCode = r.status ?? 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
