// Shared by the repository guards: the tracked files and
// their text.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Tracked paths (forward slashes) that exist in the working tree. */
export function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 1 << 28 }).toString("utf8");
  return out.split("\0").filter((p) => p && existsSync(resolve(root, p)));
}

/** The file's text, or null when it is binary or unreadable. */
export function readText(path) {
  let buf;
  try {
    buf = readFileSync(resolve(root, path));
  } catch {
    return null;
  }
  if (buf.subarray(0, 8192).includes(0)) return null;
  return buf.toString("utf8");
}

/** A glob (`**`, `*`, `?`) as a RegExp over a forward-slash path. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Area label for a path: `python/<dir>` and `docs/<dir>` get two levels, everything else one. */
export function areaOf(path) {
  const parts = path.split("/");
  if (parts.length === 1) return "(root)";
  if (["python", "docs", "landing", "examples", "src-tauri"].includes(parts[0]) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}
