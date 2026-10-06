// The Python that runs fairbeam: the app's managed runtime (installed by runtime/setup-runtime.*,
// see docs/DESKTOP.md) or an existing openEMS installation chosen by the user.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::env;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::paths::{home, Res};

pub const MARKER: &str = "fairbeam runtime v1";
// The pinned Windows GPU build uses CUDA 12.8; NVIDIA's CUDA 12.8 release notes list
// 528.33 as the minimum Windows driver for minor-version compatibility.
const MIN_NVIDIA_DRIVER: (u32, u32) = (528, 33);
const MIN_NVIDIA_COMPUTE_CAPABILITY: f32 = 6.0;
const MAX_NVIDIA_COMPUTE_CAPABILITY: f32 = 12.0;

pub enum GpuRuntimeStatus {
    Missing(String),
    Ready { python: PathBuf, openems: String, fairbeam: Option<String> },
}

pub struct GpuInstallSupport {
    pub supported: bool,
    pub reason: Option<&'static str>,
    pub adapter: Option<String>,
    pub driver: Option<String>,
}

impl GpuInstallSupport {
    pub fn explanation(&self) -> String {
        if self.supported {
            return String::new();
        }
        match self.reason.unwrap_or("nvidia_probe_failed") {
            "gpu_runtime_unsupported" => "The managed GPU runtime is available only on Windows x64. On macOS, install the Metal GPU build with scripts/install-openems-gpu-macos.sh (see docs/GPU.md).".into(),
            "nvidia_smi_missing" => "No NVIDIA driver utility was found. Install an NVIDIA driver to use the GPU runtime; CPU simulation remains available.".into(),
            "nvidia_gpu_missing" => "No NVIDIA GPU was reported by the driver. CPU simulation remains available.".into(),
            "nvidia_driver_too_old" => format!("NVIDIA driver {} is too old; driver 528.33 or newer is required. CPU simulation remains available.", self.driver.as_deref().unwrap_or("unknown")),
            "nvidia_compute_unsupported" => format!("{} has compute capability outside the supported 6.0–12.0 range. CPU simulation remains available.", self.adapter.as_deref().unwrap_or("This NVIDIA GPU")),
            "nvidia_compute_capability_unknown" => format!("The NVIDIA driver did not report a compute capability for {}. CPU simulation remains available.", self.adapter.as_deref().unwrap_or("the GPU")),
            _ => "The NVIDIA driver could not be queried. CPU simulation remains available.".into(),
        }
    }
}

pub fn platform_key() -> &'static str {
    if cfg!(all(windows, target_arch = "x86_64")) {
        "windows-x64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "macos-arm64"
    } else {
        "unsupported"
    }
}

pub fn venv_python(runtime: &Path) -> PathBuf {
    if cfg!(windows) {
        runtime.join("venv").join("Scripts").join("python.exe")
    } else {
        runtime.join("venv").join("bin").join("python")
    }
}

/// Hide the console window of a child process on Windows (the app itself has none).
pub fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Environment for `python` of the managed runtime (or an external one, `runtime` = None).
pub fn python_env(cmd: &mut Command, python: &Path, runtime: Option<&Path>, res: &Res) {
    cmd.env("PYTHONIOENCODING", "utf-8").env("PYTHONUNBUFFERED", "1");
    match runtime {
        // DLL lookup of the openEMS/CSXCAD wheels on Windows (fairbeam/__init__.py)
        Some(rt) => {
            cmd.env("OPENEMS_INSTALL_PATH", rt.join("openEMS"));
        }
        // an external install imports the bundled fairbeam; no __pycache__ inside the app's
        // resources (Windows: the uninstaller leaves files it did not install, so the install
        // folder stayed behind; macOS: it would modify the signed .app)
        None => {
            cmd.env("PYTHONPATH", res.root.join("python")).env("PYTHONDONTWRITEBYTECODE", "1");
            // a venv inside its openEMS build (the CUDA install): its wheels and fairbeam must
            // use that build, not the one the user's OPENEMS_INSTALL_PATH names
            if let Some(dir) = openems_around(python) {
                cmd.env("OPENEMS_INSTALL_PATH", dir);
            }
        }
    }
}

/// The Windows openEMS folder a venv sits in: `<prefix>\venv\Scripts\python.exe` with
/// `<prefix>\openEMS.exe` (scripts/install-openems-gpu-windows.ps1). None for any other layout,
/// and on macOS, where there is no openEMS.exe.
pub fn openems_around(python: &Path) -> Option<PathBuf> {
    let prefix = python.parent()?.parent()?.parent()?;
    prefix.join("openEMS.exe").is_file().then(|| prefix.to_path_buf())
}

/// Run a command, killing it after `limit`. Returns (success, stdout + stderr).
pub fn run_with_timeout(mut cmd: Command, limit: Duration) -> Option<(bool, String)> {
    let mut child = no_window(cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())).spawn().ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                if let Some(mut o) = child.stdout.take() {
                    let _ = o.read_to_string(&mut out);
                }
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut out);
                }
                return Some((status.success(), out));
            }
            Ok(None) if start.elapsed() > limit => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
}

/// Does this Python import openEMS, CSXCAD and fairbeam? Returns the openEMS version.
pub fn check_python(py: &Path, runtime: Option<&Path>, res: &Res) -> Result<String, String> {
    if !py.exists() && py.components().count() > 1 {
        return Err("not found".into());
    }
    let mut cmd = Command::new(py);
    cmd.args(["-c", "import openEMS, CSXCAD, fairbeam; from importlib import metadata; print(metadata.version('openEMS'))"]);
    python_env(&mut cmd, py, runtime, res);
    match run_with_timeout(cmd, Duration::from_secs(60)) {
        Some((true, out)) => Ok(out.trim().lines().last().unwrap_or("").to_string()),
        Some((false, out)) => Err(out.trim().lines().last().unwrap_or("import failed").to_string()),
        None => Err("did not start or timed out".into()),
    }
}

/// The openEMS build next to a venv (<prefix>/venv/bin/python -> <prefix>/bin/openEMS; Windows:
/// <prefix>\openEMS.exe) lists a `gpu` engine (the Metal build on macOS, CUDA on Windows).
pub fn has_gpu_engine(py: &Path) -> bool {
    let Some(prefix) = py.parent().and_then(Path::parent).and_then(Path::parent) else { return false };
    let openems = openems_around(py);
    let exe = match &openems {
        Some(dir) => dir.join("openEMS.exe"),
        None => prefix.join("bin").join("openEMS"),
    };
    has_gpu_engine_executable(&exe, openems.as_deref())
}

/// GPU engine check for a managed runtime, whose native executable is nested under `<root>/openEMS`.
pub fn has_gpu_engine_in_runtime(runtime: &Path) -> bool {
    let openems = runtime.join("openEMS");
    has_gpu_engine_executable(&managed_openems_executable(runtime), Some(&openems))
}

pub fn managed_openems_executable(runtime: &Path) -> PathBuf {
    runtime.join("openEMS").join("openEMS.exe")
}

fn has_gpu_engine_executable(exe: &Path, openems_install: Option<&Path>) -> bool {
    if !exe.exists() {
        return false;
    }
    let mut cmd = Command::new(exe);
    cmd.arg("--help");
    if let Some(dir) = openems_install { cmd.env("OPENEMS_INSTALL_PATH", dir); }
    matches!(run_with_timeout(cmd, Duration::from_secs(10)), Some((_, out)) if out.lines().any(|l| l.trim_start().starts_with("gpu:")))
}

/// Check whether this PC has an NVIDIA adapter and a CUDA 12-capable driver. This is a short,
/// read-only probe; a missing driver leaves the CPU runtime as the normal option.
pub fn gpu_install_support() -> GpuInstallSupport {
    if !cfg!(windows) {
        return unsupported("gpu_runtime_unsupported", None, None);
    }
    let Some(program) = find_nvidia_smi() else {
        return unsupported("nvidia_smi_missing", None, None);
    };
    let mut cmd = Command::new(program);
    cmd.args(["--query-gpu=name,driver_version,compute_cap", "--format=csv,noheader,nounits"]);
    match run_with_timeout(cmd, Duration::from_secs(3)) {
        Some((true, output)) => parse_nvidia_smi_output(&output),
        Some((false, output)) if output.to_lowercase().contains("no devices were found") => {
            unsupported("nvidia_gpu_missing", None, None)
        }
        Some((false, _)) | None => unsupported("nvidia_probe_failed", None, None),
    }
}

fn unsupported(reason: &'static str, adapter: Option<String>, driver: Option<String>) -> GpuInstallSupport {
    GpuInstallSupport { supported: false, reason: Some(reason), adapter, driver }
}

fn parse_nvidia_smi_output(output: &str) -> GpuInstallSupport {
    if output.to_lowercase().contains("no devices were found") {
        return unsupported("nvidia_gpu_missing", None, None);
    }
    let rows: Vec<(String, String, (u32, u32), Option<f32>)> = output.lines().filter_map(|line| {
        let mut fields = line.split(',');
        let name = fields.next()?.trim();
        let driver = fields.next()?.trim();
        let capability = fields.next().map(str::trim).and_then(|text| text.parse::<f32>().ok());
        let mut version = driver.split('.');
        let major = version.next()?.parse::<u32>().ok()?;
        let minor = version.next()?.parse::<u32>().ok()?;
        if name.is_empty() { return None; }
        Some((name.to_string(), driver.to_string(), (major, minor), capability))
    }).collect();
    if let Some((adapter, driver, _, _)) = rows.iter().find(|(_, _, major, cap)| {
        *major >= MIN_NVIDIA_DRIVER
            && cap.is_some_and(|value| (MIN_NVIDIA_COMPUTE_CAPABILITY..=MAX_NVIDIA_COMPUTE_CAPABILITY).contains(&value))
    }) {
        return GpuInstallSupport { supported: true, reason: None, adapter: Some(adapter.clone()), driver: Some(driver.clone()) };
    }
    if let Some((adapter, driver, _, _)) = rows.iter().find(|(_, _, version, _)| *version < MIN_NVIDIA_DRIVER) {
        return unsupported("nvidia_driver_too_old", Some(adapter.clone()), Some(driver.clone()));
    }
    if let Some((adapter, driver, _, cap)) = rows.iter().find(|(_, _, version, _)| *version >= MIN_NVIDIA_DRIVER) {
        return unsupported(if cap.is_some() { "nvidia_compute_unsupported" } else { "nvidia_compute_capability_unknown" },
                           Some(adapter.clone()), Some(driver.clone()));
    }
    unsupported("nvidia_probe_failed", None, None)
}

fn find_nvidia_smi() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(system_root) = env::var_os("SystemRoot") {
            let path = PathBuf::from(system_root).join("System32").join("nvidia-smi.exe");
            if path.is_file() { return Some(path); }
        }
        if let Some(program_files) = env::var_os("ProgramFiles") {
            let path = PathBuf::from(program_files).join("NVIDIA Corporation").join("NVSMI").join("nvidia-smi.exe");
            if path.is_file() { return Some(path); }
        }
        let path_var = env::var_os("PATH")?;
        return env::split_paths(&path_var)
            .map(|dir| dir.join("nvidia-smi.exe"))
            .find(|path| path.is_file());
    }
    #[cfg(not(windows))]
    { None }
}

/// Validate the separate GPU runtime before selecting it. A missing or damaged GPU runtime does
/// not invalidate the CPU runtime in its sibling folder.
pub fn gpu_runtime_status(root: &Path, res: &Res) -> GpuRuntimeStatus {
    let manifest: Option<Value> = fs::read_to_string(root.join("manifest.json")).ok()
        .and_then(|text| serde_json::from_str(&text).ok());
    if manifest.as_ref().map_or(true, |m| m["engine"] != "gpu") {
        return GpuRuntimeStatus::Missing("gpu_runtime_not_installed".into());
    }
    let (python, fairbeam) = match managed_status(root) {
        Managed::Ready { python, fairbeam } => (python, fairbeam),
        Managed::Missing(why) => return GpuRuntimeStatus::Missing(why),
    };
    if !has_gpu_engine_in_runtime(root) {
        return GpuRuntimeStatus::Missing("gpu_engine_missing".into());
    }
    match check_python(&python, Some(root), res) {
        Ok(openems) => GpuRuntimeStatus::Ready { python, openems, fairbeam },
        Err(error) => GpuRuntimeStatus::Missing(error),
    }
}

/// Existing openEMS installations worth trying when the managed runtime is not installed.
pub fn external_candidates(prefer_gpu: bool) -> Vec<(PathBuf, &'static str)> {
    candidates_in(&gpu_opt().unwrap_or_else(|| opt_dirs().remove(0)), prefer_gpu)
}

/// The GPU build's Python, at the first default prefix that has one.
pub fn gpu_python() -> Option<PathBuf> {
    gpu_opt().map(|opt| gpu_python_in(&opt))
}

pub fn gpu_build_present() -> bool {
    gpu_opt().is_some()
}

/// The GPU build's folder as the setup screen names it (where it was found, else where the
/// install script puts it).
pub fn gpu_build_label() -> String {
    if cfg!(windows) {
        gpu_opt().unwrap_or_else(|| opt_dirs().remove(0)).join("openEMS-gpu").display().to_string()
    } else {
        "~/opt/openEMS-gpu".into()
    }
}

/// The installation folder of a venv's Python (<prefix>/venv/bin/python, Windows
/// <prefix>\venv\Scripts\python.exe): how Settings names an external Python's openEMS build.
pub fn install_folder(python: &Path) -> PathBuf {
    match python.parent().and_then(Path::parent) {
        Some(venv) if venv.file_name().is_some_and(|n| n == "venv" || n == ".venv") => venv.parent().unwrap_or(venv).to_path_buf(),
        _ => python.to_path_buf(),
    }
}

/// The first of the default prefixes that holds the GPU build.
fn gpu_opt() -> Option<PathBuf> {
    gpu_build_in(&opt_dirs())
}

/// Where the install scripts put openEMS by default: ~/opt on macOS and Linux
/// (scripts/install-openems-*-macos.sh); on Windows C:\opt (scripts/install-openems-gpu-windows.ps1
/// -Prefix), then \opt on the other fixed drives, for a PC whose C: is full (#175: E:\opt).
fn opt_dirs() -> Vec<PathBuf> {
    if cfg!(windows) { drive_opt_dirs(&fixed_drives()) } else { vec![home().join("opt")] }
}

/// `X:\opt` for these drive letters: C: always and first, then the others in order.
fn drive_opt_dirs(letters: &[char]) -> Vec<PathBuf> {
    let mut v: Vec<char> = letters.iter().filter(|c| c.is_ascii_alphabetic()).map(|c| c.to_ascii_uppercase()).collect();
    v.push('C');
    v.sort_by_key(|&c| (c != 'C', c));
    v.dedup();
    v.into_iter().map(|c| PathBuf::from(format!(r"{c}:\opt"))).collect()
}

/// The first prefix whose GPU build's Python exists (existence checks only).
fn gpu_build_in(opts: &[PathBuf]) -> Option<PathBuf> {
    opts.iter().find(|opt| gpu_python_in(opt).is_file()).cloned()
}

/// The letters of the local fixed drives (no floppy, removable, network or optical drive, whose
/// existence checks can be slow or wake a device).
#[cfg(windows)]
fn fixed_drives() -> Vec<char> {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    const DRIVE_FIXED: u32 = 3;
    let mask = unsafe { GetLogicalDrives() };
    (2..26u8) // C: to Z:
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| (b'A' + i) as char)
        .filter(|c| {
            let root: Vec<u16> = format!(r"{c}:\").encode_utf16().chain(Some(0)).collect();
            unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_FIXED }
        })
        .collect()
}

#[cfg(not(windows))]
fn fixed_drives() -> Vec<char> {
    Vec::new()
}

/// The GPU build's Python: <opt>/openEMS-gpu/venv/bin/python, on Windows
/// <opt>\openEMS-gpu\venv\Scripts\python.exe (its openEMS.exe sits in <opt>\openEMS-gpu, which
/// python_env passes on as OPENEMS_INSTALL_PATH).
fn gpu_python_in(opt: &Path) -> PathBuf {
    let venv = opt.join("openEMS-gpu").join("venv");
    if cfg!(windows) { venv.join("Scripts").join("python.exe") } else { venv.join("bin").join("python") }
}

fn candidates_in(opt: &Path, prefer_gpu: bool) -> Vec<(PathBuf, &'static str)> {
    let mut c = Vec::new();
    if prefer_gpu {
        c.push((gpu_python_in(opt), "GPU build (preferred)"));
    }
    // Windows has no default CPU install with a venv: the repository's .venv is chosen by hand
    if cfg!(unix) {
        c.push((opt.join("openEMS/venv/bin/python"), "~/opt/openEMS"));
    }
    c
}

pub enum Managed {
    /// not installed (or for another platform / an older layout)
    Missing(String),
    Ready { python: PathBuf, fairbeam: Option<String> },
}

pub fn managed_status(runtime: &Path) -> Managed {
    let manifest: Option<Value> = fs::read_to_string(runtime.join("manifest.json")).ok().and_then(|t| serde_json::from_str(&t).ok());
    let Some(m) = manifest else { return Managed::Missing("not installed".into()) };
    if m["marker"] != MARKER {
        return Managed::Missing("runtime from another Fairbeam version".into());
    }
    if m["platform"] != platform_key() {
        return Managed::Missing(format!("runtime for {}", m["platform"]));
    }
    let py = venv_python(runtime);
    if !py.exists() {
        return Managed::Missing("the runtime's Python is missing".into());
    }
    Managed::Ready { python: py, fairbeam: m["fairbeam"].as_str().map(str::to_string) }
}

/// The pinned openEMS build changed since this runtime was installed: its unpacked archive
/// (<runtime>/openEMS/.fairbeam-openems.json, written by install.py) has another SHA-256 than the
/// bundled pins.json. An app update then reinstalls openEMS as well, not only the fairbeam package.
pub fn openems_pin_changed(runtime: &Path, res: &Res) -> bool {
    let pinned = fs::read_to_string(res.root.join("runtime").join("pins.json")).ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|p| p["openems"][platform_key()]["sha256"].as_str().map(str::to_string));
    let installed = fs::read_to_string(runtime.join("openEMS").join(".fairbeam-openems.json")).ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["sha256"].as_str().map(str::to_string));
    matches!((pinned, installed), (Some(p), Some(i)) if p != i)
}

/// Can this app install a managed runtime here? (openEMS is pinned for the platform.)
pub fn install_available(res: &Res) -> Result<Value, String> {
    let text = fs::read_to_string(res.root.join("runtime").join("pins.json")).map_err(|e| format!("pins.json: {e}"))?;
    let pins: Value = serde_json::from_str(&text).map_err(|e| format!("pins.json: {e}"))?;
    let key = platform_key();
    let oems = &pins["openems"][key];
    if oems["url"].as_str().is_none() {
        return Err(oems["note"].as_str().map(|n| format!("no prebuilt openEMS for {key} yet: {n}")).unwrap_or_else(|| format!("{key} is not supported")));
    }
    let mb = oems["size"].as_f64().map(|b| b / 1e6).unwrap_or(0.0) + 90.0; // + uv, CPython, packages
    Ok(json!({"openems": pins["openems"]["version"], "downloadMB": mb.round()}))
}

/// Run the runtime installer (stage 1, or stage 2 alone with `app_only`), reporting its
/// FAIRBEAM-PROGRESS lines. The whole output goes to `log`.
pub fn install(runtime: &Path, res: &Res, repair: bool, app_only: bool, log: &Path, on_progress: &dyn Fn(Value)) -> Result<(), String> {
    install_kind(runtime, res, repair, app_only, log, on_progress, false)
}

/// Install or refresh the optional managed GPU runtime in its dedicated folder. This operation
/// never mutates the CPU runtime and refuses to download anything when the NVIDIA probe fails.
pub fn install_gpu(runtime: &Path, res: &Res, repair: bool, app_only: bool, log: &Path,
                   on_progress: &dyn Fn(Value)) -> Result<(), String> {
    let support = gpu_install_support();
    if !support.supported {
        return Err(support.explanation());
    }
    install_kind(runtime, res, repair, app_only, log, on_progress, true)
}

fn install_kind(runtime: &Path, res: &Res, repair: bool, app_only: bool, log: &Path,
                on_progress: &dyn Fn(Value), gpu: bool) -> Result<(), String> {
    if gpu && !cfg!(windows) {
        return Err("the managed GPU runtime is available only on Windows x64".into());
    }
    fs::create_dir_all(runtime).map_err(|e| format!("could not create {}: {e}", runtime.display()))?;
    let rt = runtime.to_string_lossy().into_owned();
    let rs = res.root.to_string_lossy().into_owned();
    let script = res.root.join("runtime");
    let mut cmd = if app_only {
        let mut c = Command::new(venv_python(runtime));
        c.arg(script.join("install.py")).args(["--runtime-root", &rt, "--resources", &rs, "--app-only"]);
        if gpu { c.args(["--engine", "gpu"]); }
        c
    } else if cfg!(windows) {
        let mut c = Command::new("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(script.join("setup-runtime.ps1"))
            .args(["-RuntimeRoot", &rt, "-Resources", &rs]);
        if gpu { c.args(["-Engine", "gpu"]); }
        if repair {
            c.arg("-Repair");
        }
        c
    } else {
        if gpu { return Err("the managed GPU runtime is available only on Windows x64".into()); }
        let mut c = Command::new("/bin/sh");
        c.arg(script.join("setup-runtime.sh")).args(["--runtime-root", &rt, "--resources", &rs]);
        if repair {
            c.arg("--repair");
        }
        c
    };
    cmd.env("PYTHONIOENCODING", "utf-8").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = no_window(&mut cmd).spawn().map_err(|e| format!("could not start the installer: {e}"))?;
    let mut logf = fs::File::create(log).ok();
    let stderr = child.stderr.take();
    let err_thread = thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut e) = stderr {
            let _ = e.read_to_string(&mut buf);
        }
        buf
    });
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(f) = logf.as_mut() {
                let _ = writeln!(f, "{line}");
            }
            if let Some(js) = line.strip_prefix("FAIRBEAM-PROGRESS ") {
                if let Ok(v) = serde_json::from_str::<Value>(js) {
                    on_progress(v);
                }
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let err = err_thread.join().unwrap_or_default();
    if let Some(f) = logf.as_mut() {
        let _ = writeln!(f, "--- stderr ---\n{err}\n--- exit: {status}");
    }
    if status.success() {
        Ok(())
    } else {
        let tail: Vec<&str> = err.trim().lines().rev().take(12).collect();
        Err(tail.into_iter().rev().collect::<Vec<_>>().join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn res(root: &Path) -> Res {
        Res { root: root.into(), ui: None, models: root.join("models"), templates: root.join("templates"), projects: root.join("projects"), dev: false }
    }

    fn env_of(cmd: &Command, key: &str) -> Option<PathBuf> {
        cmd.get_envs().find(|(k, _)| *k == OsStr::new(key)).and_then(|(_, v)| v.map(PathBuf::from))
    }

    #[test]
    fn gpu_candidate_at_the_default_prefix() {
        if cfg!(windows) {
            assert_eq!(opt_dirs()[0], PathBuf::from(r"C:\opt"));
        } else {
            assert_eq!(opt_dirs(), vec![home().join("opt")]);
        }
        let opt = std::env::temp_dir().join(format!("fairbeam-gpu-candidates-{}", std::process::id()));
        let _ = fs::remove_dir_all(&opt);
        // the paths the install scripts write
        let gpu_py = gpu_python_in(&opt);
        let tail: PathBuf = if cfg!(windows) {
            ["openEMS-gpu", "venv", "Scripts", "python.exe"].iter().collect()
        } else {
            ["openEMS-gpu", "venv", "bin", "python"].iter().collect()
        };
        assert_eq!(gpu_py, opt.join(tail));
        // tried first, and only when preferred
        let on = candidates_in(&opt, true);
        let off = candidates_in(&opt, false);
        assert_eq!(on[0], (gpu_py.clone(), "GPU build (preferred)"));
        assert!(off.iter().all(|(p, _)| p != &gpu_py));
        // the CPU install stays a macOS/Linux candidate, after the GPU one
        assert_eq!((on.len(), off.len()), if cfg!(unix) { (2, 1) } else { (1, 0) });
        if cfg!(unix) {
            assert_eq!(on[1], (opt.join("openEMS/venv/bin/python"), "~/opt/openEMS"));
        }
        // the setup screen's option appears only when that Python exists
        assert!(!gpu_py.exists());
        fs::create_dir_all(gpu_py.parent().unwrap()).unwrap();
        fs::write(&gpu_py, b"").unwrap();
        assert!(gpu_py.exists());
        fs::remove_dir_all(&opt).unwrap();
    }

    #[test]
    fn gpu_build_on_another_drive() {
        // C: first even when it is not listed, then the other fixed drives in order, once each
        let dirs = |l: &[char]| drive_opt_dirs(l).iter().map(|p| p.display().to_string()).collect::<Vec<_>>();
        assert_eq!(dirs(&[]), [r"C:\opt"]);
        assert_eq!(dirs(&['E', 'C', 'd', 'E']), [r"C:\opt", r"D:\opt", r"E:\opt"]);
        assert_eq!(dirs(&['Z', '1']), [r"C:\opt", r"Z:\opt"]);

        // the first prefix holding the GPU build's Python wins (#175: nothing on C:, all on E:)
        let root = std::env::temp_dir().join(format!("fairbeam-gpu-drives-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (c, d, e) = (root.join("c-opt"), root.join("d-opt"), root.join("e-opt"));
        let opts = [c.clone(), d.clone(), e.clone()];
        assert_eq!(gpu_build_in(&opts), None);
        fs::create_dir_all(d.join("openEMS-gpu")).unwrap(); // a folder without its venv is not it
        assert_eq!(gpu_build_in(&opts), None);
        for opt in [&e, &d] {
            let py = gpu_python_in(opt);
            fs::create_dir_all(py.parent().unwrap()).unwrap();
            fs::write(&py, b"").unwrap();
        }
        assert_eq!(gpu_build_in(&opts), Some(d.clone()));
        assert_eq!(gpu_build_in(&[c.clone(), e.clone()]), Some(e.clone()));
        // Settings names the folder of an external Python's build
        assert_eq!(install_folder(&gpu_python_in(&e)), e.join("openEMS-gpu"));
        assert_eq!(install_folder(&root.join("repo").join(".venv").join("bin").join("python")), root.join("repo"));
        assert_eq!(install_folder(Path::new("python3")), PathBuf::from("python3"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn nvidia_probe_requires_supported_driver_and_compute_capability() {
        let supported = parse_nvidia_smi_output("NVIDIA GeForce RTX 3060, 591.74, 8.6");
        assert!(supported.supported);
        assert_eq!(supported.adapter.as_deref(), Some("NVIDIA GeForce RTX 3060"));
        assert_eq!(supported.driver.as_deref(), Some("591.74"));

        let old_driver = parse_nvidia_smi_output("NVIDIA GPU, 528.32, 8.6");
        assert_eq!(old_driver.reason, Some("nvidia_driver_too_old"));
        assert!(parse_nvidia_smi_output("NVIDIA GPU, 528.33, 8.6").supported);
        let old_arch = parse_nvidia_smi_output("GeForce GTX 980, 591.74, 5.2");
        assert_eq!(old_arch.reason, Some("nvidia_compute_unsupported"));
        let unknown_arch = parse_nvidia_smi_output("NVIDIA GPU, 591.74, N/A");
        assert_eq!(unknown_arch.reason, Some("nvidia_compute_capability_unknown"));
        let absent = parse_nvidia_smi_output("No devices were found");
        assert_eq!(absent.reason, Some("nvidia_gpu_missing"));
    }

    #[test]
    fn managed_gpu_runtime_uses_nested_openems_executable_path() {
        let root = std::env::temp_dir().join(format!("fairbeam-managed-gpu-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let exe = managed_openems_executable(&root);
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"mock openEMS executable").unwrap();
        assert!(exe.is_file());
        assert_eq!(exe, root.join("openEMS").join("openEMS.exe"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn openems_folder_of_an_external_python() {
        let dir = std::env::temp_dir().join(format!("fairbeam-runtime-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        // the CUDA install: <prefix>\venv\Scripts\python.exe inside the openEMS folder
        let gpu = dir.join("openEMS-gpu");
        let gpu_py = gpu.join("venv").join("Scripts").join("python.exe");
        fs::create_dir_all(gpu_py.parent().unwrap()).unwrap();
        fs::write(&gpu_py, b"").unwrap();
        assert_eq!(openems_around(&gpu_py), None); // no openEMS.exe yet
        fs::write(gpu.join("openEMS.exe"), b"").unwrap();
        assert_eq!(openems_around(&gpu_py), Some(gpu.clone()));
        // a venv elsewhere (the repository's .venv) and a bare command name
        assert_eq!(openems_around(&dir.join("repo").join(".venv").join("Scripts").join("python.exe")), None);
        assert_eq!(openems_around(Path::new("python")), None);

        let r = res(&dir.join("app"));
        let mut cmd = Command::new(&gpu_py);
        python_env(&mut cmd, &gpu_py, None, &r);
        assert_eq!(env_of(&cmd, "OPENEMS_INSTALL_PATH"), Some(gpu.clone()));
        let other = dir.join("repo").join(".venv").join("Scripts").join("python.exe");
        let mut cmd = Command::new(&other);
        python_env(&mut cmd, &other, None, &r);
        assert_eq!(env_of(&cmd, "OPENEMS_INSTALL_PATH"), None); // inherits the user's setting
        // the managed runtime keeps its own folder (<rt>\openEMS), even when the layout matches
        let rt = dir.join("runtime");
        let rt_py = venv_python(&rt);
        fs::create_dir_all(rt_py.parent().unwrap()).unwrap();
        fs::write(rt.join("openEMS.exe"), b"").unwrap();
        let mut cmd = Command::new(&rt_py);
        python_env(&mut cmd, &rt_py, Some(&rt), &r);
        assert_eq!(env_of(&cmd, "OPENEMS_INSTALL_PATH"), Some(rt.join("openEMS")));
        fs::remove_dir_all(&dir).unwrap();
    }
}
