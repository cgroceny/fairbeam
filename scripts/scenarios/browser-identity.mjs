// Pre-launch on-disk identity only, not proof of the browser's loaded image.
// Never execute the selected browser to ask for its version.
import { open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

const MAX_BYTES = 64 * 1024 * 1024;
const version = value => typeof value === 'string' && /^\d+(?:\.\d+){1,5}$/.test(value) && value.length <= 80 ? value : null;
const label = value => typeof value === 'string' && /^[a-z\d_.-]{1,100}$/i.test(value) ? value : null;

export function hostedImageIdentity(env = process.env) {
  // Allowlisted labels only. Never copy the environment, tokens or runner paths.
  return { imageOS: label(env.ImageOS), imageVersion: label(env.ImageVersion), runnerOS: label(env.RUNNER_OS), runnerArch: label(env.RUNNER_ARCH) };
}

export function windowsFileVersion(path, { execute = execFile, env = process.env } = {}) {
  return new Promise(resolve => {
    const script = '$ErrorActionPreference="Stop"; $v=(Get-Item -LiteralPath $env:FAIRBEAM_BROWSER_METADATA_PATH).VersionInfo; @{fileVersion=$v.FileVersion;productVersion=$v.ProductVersion}|ConvertTo-Json -Compress';
    const executable = join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      execute(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, timeout: 5000, maxBuffer: 4096, encoding: 'utf8',
        env: { ...env, FAIRBEAM_BROWSER_METADATA_PATH: path },
      }, (error, stdout) => {
        if (error) return resolve(null); // Never retain arbitrary shell output/errors.
        try {
          const data = JSON.parse(stdout);
          const result = { fileVersion: version(data.fileVersion), productVersion: version(data.productVersion) };
          resolve(result.fileVersion || result.productVersion ? result : null);
        } catch { resolve(null); }
      });
    } catch { resolve(null); }
  });
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

export async function browserExecutableIdentity(path, { platform = process.platform, readVersion = windowsFileVersion, maxBytes = MAX_BYTES } = {}) {
  const result = { scope: 'selected-executable-on-disk-before-launch', status: 'unavailable', sha256: null, bytes: null,
    stableDuringRead: false, fileVersion: null, productVersion: null, versionStatus: platform === 'win32' ? 'unavailable' : 'not-collected' };
  let handle;
  try {
    if (typeof path !== 'string' || !path || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) return result;
    // Refuse special files before opening; on POSIX, nonblocking open also
    // prevents a raced replacement with a FIFO from waiting for a writer.
    if (!(await stat(path)).isFile()) { result.status = 'not-regular-file'; return result; }
    handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK));
    const before = await handle.stat();
    if (!before.isFile()) { result.status = 'not-regular-file'; return result; }
    if (before.size > maxBytes) { result.status = 'size-limit'; return result; }
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let count = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes - count + 1), null);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > maxBytes) { result.status = 'size-limit'; return result; }
      hash.update(buffer.subarray(0, bytesRead));
    }
    result.sha256 = hash.digest('hex'); result.bytes = count;
    if (platform === 'win32') {
      const value = await readVersion(path);
      result.fileVersion = version(value?.fileVersion); result.productVersion = version(value?.productVersion);
      result.versionStatus = result.fileVersion || result.productVersion ? 'file-resource' : 'unavailable';
    }
    const after = await handle.stat(), selected = await stat(path);
    result.stableDuringRead = count === before.size && sameFile(before, after) && sameFile(after, selected);
    result.status = result.stableDuringRead ? 'recorded' : 'changed-during-read';
  } catch { result.status = 'unavailable'; }
  finally { if (handle) try { await handle.close(); } catch { result.status = 'close-failed'; } }
  return result;
}
