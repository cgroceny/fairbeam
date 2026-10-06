// Fairbeam desktop shell (docs/DESKTOP.md). The app is the web viewer plus `fairbeam serve`; the
// shell only provides the Python, the workspace and the server's lifetime:
//   1. pick the Python: the managed runtime (installed per user on first start, with progress on
//      the splash page), or an existing openEMS installation (setting, or found on this machine
//      while the managed runtime is not installed),
//   2. seed the workspace (~/Documents/Fairbeam) with the bundled examples, models and templates,
//   3. start `python -m fairbeam serve` on a free port with the bundled viewer, poll /api/health
//      behind the splash page, then navigate the window to the server (debug builds: to Vite),
//   4. before the window closes or the app quits, let the viewer ask Save / Don't save / Cancel for
//      an unsaved design (`request_leave`),
//   5. on quit, stop the server gracefully (POST /api/shutdown with a per-start token), forcibly
//      after a grace period (process group / Windows job object).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod design_reveal;

#[cfg(any(feature = "accounts", test))]
mod account;
// the one-time import from the previous app and its removal (Help › Remove …)
mod antenlab_import;
mod i18n;
#[cfg(target_os = "macos")]
mod macos_update;
mod paths;
mod runtime;
mod seed;
mod server;
mod shelllog;
mod telemetry;
mod update_progress;
mod updater;
mod workspace_settings;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::webview::{DownloadEvent, WebviewWindowBuilder};
use tauri::WebviewUrl;
use tauri::{AppHandle, Manager, RunEvent, Url, WindowEvent};
use tauri_plugin_dialog::DialogExt;

use paths::{
    load_settings, local_data, logs_dir, runtime_root, save_settings, settings_path, workspace,
    Res, Settings,
};
use runtime::Managed;
use server::{http_ok, Server};

#[derive(Default)]
struct Shell {
    server: Mutex<Option<Server>>,
    /// workspace passed to the server that is currently running
    active_workspace: Mutex<Option<PathBuf>>,
    /// true only when the running server uses the app-managed GPU runtime
    active_gpu_runtime: Mutex<bool>,
    /// last state shown on the splash page (replayed when the page asks)
    splash: Mutex<Value>,
    /// bumps on every (re)start so an older start thread stops reporting
    generation: Mutex<u64>,
    /// a runtime installation is running
    installing: Mutex<bool>,
    /// the optional managed GPU runtime is being prepared for the next start
    gpu_installing: Mutex<bool>,
    /// a close or quit waiting for the viewer's decision
    leaving: Mutex<Option<LeaveRequest>>,
    /// numbers the close/quit requests (the viewer ignores a decision made for an older one)
    leave_seq: Mutex<u64>,
    /// where each running download was asked to go, by URL (WKWebView's "finished" has no path)
    download_targets: Mutex<HashMap<String, PathBuf>>,
    /// files this window saved: the only paths "Show in folder" will reveal
    saved_downloads: Mutex<HashSet<PathBuf>>,
    /// enabled states for native commands whose availability follows the viewer's workspace
    menu_availability: Mutex<HashMap<String, bool>>,
}

/// How the app is left: the window's own close (title-bar X, Alt+F4, Close Window) or Quit.
#[derive(Clone, Copy, PartialEq)]
enum Leave {
    Window,
    Quit,
}

struct LeaveRequest {
    id: u64,
    leave: Leave,
    /// the viewer did not answer (hung page, script error): the next request leaves without asking
    silent: bool,
}

/// The window's close button, Alt+F4, Close Window, File > Exit and Quit / Cmd+Q all come here.
/// The viewer is served from 127.0.0.1 and may call only `reveal_download`, so the shell asks it with
/// `window.fairbeamWindowClose(kind, id)` (src/designer/windowClose.ts) and asks again while the
/// answer is "pending" (its Save / Don't save / Cancel dialog is open). "close" leaves, "cancel"
/// keeps the window. A page without that function (the splash page) is left at once.
fn request_leave(app: &AppHandle, leave: Leave) {
    let shell = app.state::<Shell>();
    let mut guard = shell.leaving.lock().unwrap();
    if let Some(req) = guard.as_mut() {
        // already asking: Quit wins over closing the window, and a page that does not answer
        // cannot keep the app open against a second request
        if leave == Leave::Quit {
            req.leave = Leave::Quit;
        }
        if req.silent {
            let leave = req.leave;
            *guard = None;
            drop(guard);
            leave_now(app, leave);
        }
        return;
    }
    let id = {
        let mut seq = shell.leave_seq.lock().unwrap();
        *seq += 1;
        *seq
    };
    *guard = Some(LeaveRequest {
        id,
        leave,
        silent: false,
    });
    drop(guard);
    let app = app.clone();
    thread::spawn(move || ask_viewer(app, id));
}

fn ask_viewer(app: AppHandle, id: u64) {
    let set_silent = |silent: bool| {
        let shell = app.state::<Shell>();
        let mut guard = shell.leaving.lock().unwrap();
        if let Some(req) = guard.as_mut().filter(|r| r.id == id) {
            req.silent = silent;
        }
    };
    loop {
        let leave = match app.state::<Shell>().leaving.lock().unwrap().as_ref() {
            Some(req) if req.id == id => req.leave,
            _ => return,
        };
        let Some(win) = app.get_webview_window("main") else {
            return;
        };
        let kind = if leave == Leave::Quit {
            "quit"
        } else {
            "window"
        };
        let script = format!(
            "typeof window.fairbeamWindowClose === 'function' ? window.fairbeamWindowClose('{kind}', {id}) : 'close'"
        );
        let (tx, rx) = mpsc::channel::<String>();
        if win
            .eval_with_callback(script, move |answer| {
                let _ = tx.send(answer);
            })
            .is_err()
        {
            finish_leave(&app, id, true);
            return;
        }
        let answer = match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(answer) => answer,
            Err(RecvTimeoutError::Timeout) => {
                // the page is busy or hung: keep waiting, but a second request leaves
                set_silent(true);
                match rx.recv() {
                    Ok(answer) => {
                        set_silent(false);
                        answer
                    }
                    Err(_) => return,
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                set_silent(true);
                return;
            }
        };
        // the answer comes as JSON (a quoted string)
        match answer.trim().trim_matches('"') {
            "pending" => thread::sleep(Duration::from_millis(150)),
            "cancel" => {
                finish_leave(&app, id, false);
                return;
            }
            "close" => {
                finish_leave(&app, id, true);
                return;
            }
            _ => {
                // a script error: stay open this time, a second request leaves
                set_silent(true);
                return;
            }
        }
    }
}

/// End request `id`; leave when the viewer said so.
fn finish_leave(app: &AppHandle, id: u64, leave: bool) {
    let taken = {
        let shell = app.state::<Shell>();
        let mut guard = shell.leaving.lock().unwrap();
        if guard.as_ref().map(|r| r.id) != Some(id) {
            return;
        }
        guard.take()
    };
    if let (true, Some(req)) = (leave, taken) {
        leave_now(app, req.leave);
    }
}

/// Leave without asking again; the server stops on RunEvent::Exit.
fn leave_now(app: &AppHandle, leave: Leave) {
    match (leave, app.get_webview_window("main")) {
        // destroy, not close: close would raise CloseRequested and ask again
        (Leave::Window, Some(win)) => {
            let _ = win.destroy();
        }
        _ => app.exit(0),
    }
}

/// Update the splash page (stored, so the page can ask for it again after loading).
fn splash(app: &AppHandle, mut state: Value) {
    // the page shows its texts in the viewer's last language (src-tauri/splash/index.html)
    if let Some(fields) = state.as_object_mut() {
        if let Some(lang) = load_settings(app).language {
            fields.insert("lang".into(), json!(lang));
        }
    }
    let shell = app.state::<Shell>();
    *shell.splash.lock().unwrap() = state.clone();
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval(&format!(
            "window.fairbeamSplash && window.fairbeamSplash({state})"
        ));
    }
}

fn stop_server(app: &AppHandle) {
    let shell = app.state::<Shell>();
    *shell.active_workspace.lock().unwrap() = None;
    *shell.active_gpu_runtime.lock().unwrap() = false;
    let taken = shell.server.lock().unwrap().take();
    if let Some(s) = taken {
        s.stop();
    }
}

fn gpu_runtime_root(app: &AppHandle) -> PathBuf {
    local_data(app).join("gpu-runtime")
}

fn dev_url() -> Option<String> {
    if cfg!(debug_assertions) {
        Some(std::env::var("FAIRBEAM_DEV_URL").unwrap_or_else(|_| "http://127.0.0.1:5315/".into()))
    } else {
        None
    }
}

fn stamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// "Show in folder" for a file this window downloaded. The viewer is a remote page to Tauri, so
/// its capability (capabilities/viewer.json) allows reveal and Save As, and it only reveals
/// paths the shell itself saw in a finished download: never an arbitrary path from the page.
#[tauri::command]
fn reveal_download(shell: tauri::State<'_, Shell>, path: String) -> Result<(), String> {
    let file = PathBuf::from(path);
    if !shell.saved_downloads.lock().unwrap().contains(&file) {
        return Err("Only files downloaded in this window can be shown".into());
    }
    if !file.is_file() {
        return Err("Downloaded file no longer exists".into());
    }
    reveal_file(&file)
}

fn reveal_file(file: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let spawned = {
        use std::os::windows::process::CommandExt;
        // quoted in one raw argument: Explorer splits /select, on commas and spaces otherwise
        // (a Windows path cannot contain a double quote)
        Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", file.display()))
            .spawn()
    };
    #[cfg(target_os = "macos")]
    let spawned = Command::new("open").arg("-R").arg(&file).spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let spawned: std::io::Result<std::process::Child> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Show in folder is unavailable on this platform",
    ));
    // Explorer's exit code is 1 even when it worked, so only a failure to start counts
    spawned.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_design(app: AppHandle, id: String, path: String) -> Result<(), String> {
    let shell = app.state::<Shell>();
    let root = shell.active_workspace.lock().unwrap().clone()
        .unwrap_or_else(|| workspace(&app, &load_settings(&app), &Res::locate(&app)).root);
    reveal_file(&design_reveal::validate(&root, &id, Path::new(&path))?)
}

const SAVE_LIMIT: usize = 200 * 1024 * 1024;
const SAVE_EXTENSIONS: &[&str] = &[
    "csv", "json", "py", "bas", "png", "pdf", "zip", "svg", "txt", "tsv", "jpg", "jpeg", "webp", "stl", "glb", "blend",
];
/// Touchstone files are named by their port count: s1p, s2p, …, s99p.
fn is_touchstone_extension(extension: &str) -> bool {
    let e = extension.as_bytes();
    e.len() >= 3
        && e.len() <= 4
        && e[0] == b's'
        && e[e.len() - 1] == b'p'
        && e[1..e.len() - 1].iter().all(u8::is_ascii_digit)
        && e[1] != b'0'
}

fn validate_save_name(name: &str, extension: &str, byte_count: usize) -> Result<(), String> {
    if byte_count > SAVE_LIMIT {
        return Err("Export exceeds the 200 MiB save limit".into());
    }
    if !SAVE_EXTENSIONS.contains(&extension) && !is_touchstone_extension(extension) {
        return Err("Unsupported export extension".into());
    }
    if name
        .chars()
        .any(|c| matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err("Export name contains an invalid filename character".into());
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return Err("Export name is a reserved device name".into());
    }
    let path = Path::new(name);
    if name.is_empty()
        || name == "."
        || name == ".."
        || path.file_name().and_then(|n| n.to_str()) != Some(name)
        || name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err("Export name must be a basename".into());
    }
    if path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case(extension))
        != Some(true)
    {
        return Err("Export name must use the selected extension".into());
    }
    Ok(())
}

fn validate_save_path(path: &Path, extension: &str) -> Result<(), String> {
    if !path.is_absolute() || !path.parent().is_some_and(Path::is_dir) {
        return Err("Save location must have an existing absolute parent directory".into());
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid save filename")?;
    validate_save_name(name, extension, 0)?;
    if let Ok(meta) = fs::symlink_metadata(path) {
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err("Save location must be a regular file".into());
        }
    }
    Ok(())
}

fn write_save_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_download(
    app: AppHandle,
    shell: tauri::State<'_, Shell>,
    name: String,
    bytes: Vec<u8>,
    extension: String,
) -> Result<Value, String> {
    validate_save_name(&name, &extension, bytes.len())?;
    let dialog_app = app.clone();
    let filter_name = extension.to_uppercase();
    let dialog_extension = extension.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_file_name(&name)
            .add_filter(filter_name, &[&dialog_extension])
            .blocking_save_file()
            .map(|p| p.into_path().map_err(|e| e.to_string()))
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())??;
    let Some(path) = path else {
        return Ok(json!({"status": "cancelled"}));
    };
    validate_save_path(&path, &extension)?;
    let destination = path.clone();
    tauri::async_runtime::spawn_blocking(move || write_save_file(&destination, &bytes))
        .await
        .map_err(|e| e.to_string())??;
    shell.saved_downloads.lock().unwrap().insert(path.clone());
    Ok(json!({"status": "saved", "path": path.to_string_lossy()}))
}

#[cfg(test)]
mod save_download_tests {
    use super::*;

    #[test]
    fn writes_bytes_to_chosen_path() {
        let path = std::env::temp_dir().join(format!(
            "fairbeam-save-{}-{}.txt",
            std::process::id(),
            stamp()
        ));
        let expected = b"native save helper";
        write_save_file(&path, expected).unwrap();
        assert_eq!(fs::read(&path).unwrap(), expected);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_unsafe_names_and_oversized_exports() {
        assert!(validate_save_name("result.csv", "csv", SAVE_LIMIT).is_ok());
        assert!(validate_save_name("../result.csv", "csv", 1).is_err());
        assert!(validate_save_name("result.py", "csv", 1).is_err());
        assert!(validate_save_name("result.csv", "csv", SAVE_LIMIT + 1).is_err());
        assert!(validate_save_name("result:stream.csv", "csv", 1).is_err());
        assert!(validate_save_name("NUL.csv", "csv", 1).is_err());
        assert!(validate_save_name("parameters.json", "json", 1).is_ok());
        assert!(validate_save_name("antenna.stl", "stl", 84).is_ok());
        assert!(validate_save_name("open-ended-waveguide.xyz", "xyz", 84).is_err());
        assert!(validate_save_name("patch.bas", "bas", 84).is_ok());
        assert!(validate_save_name("patch.blend", "blend", 84).is_ok());
        assert!(validate_save_name("antenna.glb", "glb", 20).is_ok());
        assert!(validate_save_name("antenna.exe", "exe", 20).is_err());
        assert!(validate_save_name("patch.s1p", "s1p", 1).is_ok());
        assert!(validate_save_name("coupler.s4p", "s4p", 1).is_ok());
        assert!(validate_save_name("array.s12p", "s12p", 1).is_ok());
        assert!(validate_save_name("bad.s0p", "s0p", 1).is_err());
        assert!(validate_save_name("bad.sxp", "sxp", 1).is_err());
        assert!(validate_save_name("bad.s123p", "s123p", 1).is_err());
        assert!(validate_save_path(Path::new("relative.csv"), "csv").is_err());
        assert!(validate_save_path(&std::env::temp_dir(), "csv").is_err());
    }
}

#[cfg(test)]
mod fit_tests {
    use super::{fit_for, Fit};

    #[test]
    fn maximized_only_when_the_default_size_does_not_fit() {
        // 1920 × 1080 with the taskbar: 1440 × 900 fits and opens centred
        assert_eq!(
            fit_for(1920.0, 1040.0),
            Fit {
                maximize: false,
                min: (1024.0, 700.0)
            }
        );
        // the Windows PC of #175: a 2560 × 1380 px work area at 156 % is 1641 × 885 points
        assert!(fit_for(2560.0 / 1.56, 1380.0 / 1.56).maximize);
        // a 1352 × 878 MacBook work area
        assert_eq!(
            fit_for(1352.0, 878.0),
            Fit {
                maximize: true,
                min: (1024.0, 700.0)
            }
        );
        // a 1366 × 728 laptop: the minimum shrinks to what is left under the title bar
        assert_eq!(
            fit_for(1366.0, 728.0),
            Fit {
                maximize: true,
                min: (1024.0, 688.0)
            }
        );
        assert_eq!(fit_for(1000.0, 700.0).min, (1000.0, 660.0));
    }
}

#[cfg(test)]
mod external_link_tests {
    use super::{external_url, valid_design_id};

    #[test]
    fn opens_only_fixed_links_by_key() {
        assert_eq!(external_url("developer"), Some("https://akdag.dev"));
        // only public places: the source repository is private
        assert_eq!(
            external_url("repository"),
            Some("https://github.com/ismailakdag/fairbeam-releases")
        );
        assert_eq!(
            external_url("docs"),
            Some("https://fairbeam.org/guide.html")
        );
        assert_eq!(
            external_url("issues"),
            Some("https://github.com/ismailakdag/fairbeam-releases/issues/new/choose")
        );
        assert_eq!(
            external_url("openems"),
            Some("https://github.com/thliebig/openEMS")
        );
        assert_eq!(
            external_url("csxcad"),
            Some("https://github.com/thliebig/CSXCAD")
        );
        assert_eq!(
            external_url("privacy"),
            Some("https://fairbeam.org/privacy.html")
        );
        // the page names a link; a URL it supplies is never opened, not even an allowed one
        assert_eq!(external_url("https://akdag.dev"), None);
        assert_eq!(external_url("javascript:alert(1)"), None);
        assert_eq!(external_url(""), None);
    }

    #[test]
    fn recent_design_ids_are_bounded_and_safe() {
        assert!(valid_design_id("patch_antenna"));
        assert!(!valid_design_id("../patch"));
        assert!(!valid_design_id("C:\\temp"));
        assert!(!valid_design_id("a"));
        assert!(!valid_design_id("Antenna"));
    }
}

fn tail(path: &Path, lines: usize) -> String {
    let text = fs::read_to_string(path).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// The chosen Python and what it needs.
struct Chosen {
    python: PathBuf,
    /// Some: the managed runtime root; None: an external installation
    runtime: Option<PathBuf>,
    openems: String,
    gpu: bool,
    note: Option<String>,
}

struct GpuChoice {
    python: PathBuf,
    openems: String,
    runtime: Option<PathBuf>,
    source: &'static str,
    path: String,
    fairbeam: Option<String>,
}

/// Return a usable explicit GPU start choice. The separate managed GPU runtime takes priority
/// when the current NVIDIA driver supports it; otherwise a discovered GPU openEMS installation
/// remains selectable ahead of a saved CPU-only external Python.
fn gpu_choice(
    res: &Res,
    managed_root: &Path,
    status: &runtime::GpuRuntimeStatus,
    support: &runtime::GpuInstallSupport,
) -> Option<GpuChoice> {
    if support.supported {
        if let runtime::GpuRuntimeStatus::Ready {
            python,
            openems,
            fairbeam,
        } = status
        {
            return Some(GpuChoice {
                python: python.clone(),
                openems: openems.clone(),
                runtime: Some(managed_root.to_path_buf()),
                source: "managed",
                path: managed_root.display().to_string(),
                fairbeam: fairbeam.clone(),
            });
        }
    }
    let python = runtime::gpu_python()?;
    if !runtime::has_gpu_engine(&python) {
        return None;
    }
    let openems = runtime::check_python(&python, None, res).ok()?;
    let path = runtime::install_folder(&python).display().to_string();
    Some(GpuChoice {
        python,
        openems,
        runtime: None,
        source: "external",
        path,
        fairbeam: None,
    })
}

/// The setup screen: install the managed runtime, or use an existing installation.
fn setup_screen(
    app: &AppHandle,
    res: &Res,
    s: &Settings,
    text: &str,
    detail: String,
    tried: Vec<Value>,
) {
    let install = runtime::install_available(res);
    // testing aid: FAIRBEAM_AUTO_INSTALL=1 presses "Install" (unattended checks of the first start)
    static AUTO_DONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if install.is_ok()
        && std::env::var("FAIRBEAM_AUTO_INSTALL").as_deref() == Ok("1")
        && !AUTO_DONE.swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        install_runtime(app.clone(), false);
        return;
    }
    // an installed managed runtime is offered as is (no reinstall) when another choice failed
    let managed_ready = matches!(
        runtime::managed_status(&runtime_root(app)),
        Managed::Ready { .. }
    );
    let gpu_root = gpu_runtime_root(app);
    let gpu_status = runtime::gpu_runtime_status(&gpu_root, res);
    let gpu_support = runtime::gpu_install_support();
    let gpu_installing = *app.state::<Shell>().gpu_installing.lock().unwrap();
    splash(
        app,
        json!({
            "phase": "setup", "text": text, "detail": detail, "managedReady": managed_ready,
            "canInstall": install.is_ok() && !managed_ready, "install": install.as_ref().ok(), "installNote": install.err(),
            "runtime": runtime_root(app), "tried": tried, "settings": settings_path(app),
            "gpuAvailable": runtime::gpu_build_present(), "gpuPath": runtime::gpu_build_label(), "preferGpu": s.prefer_gpu,
            "gpuRuntime": gpu_root, "gpuRuntimeReady": matches!(&gpu_status, runtime::GpuRuntimeStatus::Ready { .. }),
            "gpuRuntimeInstalling": gpu_installing, "gpuSupported": gpu_support.supported,
            "gpuSupportReason": gpu_support.reason, "gpuAdapter": gpu_support.adapter,
            "gpuDriver": gpu_support.driver, "gpuRuntimeEnabled": s.gpu_runtime_enabled,
        }),
    );
}

/// Decide which Python runs fairbeam; shows the setup screen (and returns None) when there is none.
fn choose(app: &AppHandle, res: &Res, s: &Settings, current: &dyn Fn() -> bool) -> Option<Chosen> {
    let rt = runtime_root(app);
    let mut gpu_fallback_note = None;
    // A user who explicitly selected GPU can use the ready managed runtime or an existing GPU
    // build, even when Settings also contains a CPU-only external Python. Without this explicit
    // preference the saved Python keeps its existing priority.
    if s.gpu_runtime_enabled {
        let gpu_root = gpu_runtime_root(app);
        let support = runtime::gpu_install_support();
        let status = runtime::gpu_runtime_status(&gpu_root, res);
        let mut selected = gpu_choice(res, &gpu_root, &status, &support);
        if let Some(choice) = selected.as_ref() {
            if choice.runtime.is_some() {
                let bundled = res.fairbeam_version();
                if bundled.is_some() && bundled != choice.fairbeam {
                    splash(
                        app,
                        json!({"phase": "installing", "step": "install-app", "text": "Updating Fairbeam in the GPU runtime…"}),
                    );
                    let log = logs_dir(app).join(format!("gpu-runtime-{}.log", stamp()));
                    if let Err(error) =
                        runtime::install_gpu(&gpu_root, res, false, true, &log, &|progress| {
                            shelllog::write(app, &format!("GPU runtime update: {progress}"));
                        })
                    {
                        shelllog::write(app, &format!("GPU runtime update failed: {error}"));
                        gpu_fallback_note = Some(format!(
                            "The managed GPU runtime could not be updated; using the available GPU build instead. {error}"
                        ));
                        let missing = runtime::GpuRuntimeStatus::Missing("update failed".into());
                        selected = gpu_choice(res, &gpu_root, &missing, &support);
                    }
                }
            }
        }
        if let Some(choice) = selected {
            if !current() {
                return None;
            }
            let note = gpu_fallback_note.clone().or_else(|| {
                Some(match choice.source {
                    "managed" => format!("using the managed GPU runtime at {}", choice.path),
                    _ => format!("using the discovered GPU build at {}", choice.path),
                })
            });
            return Some(Chosen {
                python: choice.python,
                runtime: choice.runtime,
                openems: choice.openems,
                gpu: true,
                note,
            });
        }
        let reason = support.explanation();
        gpu_fallback_note = Some(if reason.is_empty() {
            "GPU startup is selected, but no usable GPU runtime is ready; continuing with the saved runtime.".into()
        } else {
            format!("GPU startup is selected, but no usable GPU runtime is ready; continuing with the saved runtime. {reason}")
        });
    }
    // 1. an external installation chosen in the settings, unless GPU was explicitly selected above
    if let Some(py) = s.external() {
        splash(
            app,
            json!({"phase": "searching", "text": "Checking the chosen Python…", "python": py}),
        );
        return match runtime::check_python(&py, None, res) {
            Ok(v) => Some(Chosen {
                gpu: runtime::has_gpu_engine(&py),
                python: py,
                runtime: None,
                openems: v,
                note: gpu_fallback_note.clone(),
            }),
            Err(e) => {
                setup_screen(
                    app,
                    res,
                    s,
                    "The chosen Python cannot run Fairbeam.",
                    format!(
                        "{} does not import openEMS, CSXCAD and fairbeam: {e}",
                        py.display()
                    ),
                    vec![json!({"python": py, "why": "saved setting", "result": e})],
                );
                None
            }
        };
    }
    // 2. the GPU build, when preferred (the default) and present: it has the CPU engine too, so the
    // viewer offers both engines. A broken or CPU-only build there falls through to the runtime.
    // (Windows: C:\opt\openEMS-gpu, else \opt\openEMS-gpu on another fixed drive)
    if let Some(py) = (s.runtime.is_none() && s.prefer_gpu)
        .then(runtime::gpu_python)
        .flatten()
    {
        if runtime::has_gpu_engine(&py) {
            if let Ok(v) = runtime::check_python(&py, None, res) {
                return Some(Chosen {
                    python: py,
                    runtime: None,
                    openems: v,
                    gpu: true,
                    note: Some(format!(
                        "using the GPU build at {}",
                        runtime::gpu_build_label()
                    )),
                });
            }
        }
    }
    // 3. the managed runtime
    splash(
        app,
        json!({"phase": "searching", "text": "Checking the Fairbeam runtime…", "runtime": rt}),
    );
    match runtime::managed_status(&rt) {
        Managed::Ready { python, fairbeam } => {
            let bundled = res.fairbeam_version();
            // a new pinned openEMS build (e.g. the macOS pack with the native CPU patches) is
            // installed in full; otherwise an app update only refreshes the fairbeam package
            let new_openems = runtime::openems_pin_changed(&rt, res);
            if new_openems || (bundled.is_some() && bundled != fairbeam) {
                splash(
                    app,
                    json!({"phase": "installing", "step": "install-app", "text": if new_openems { "Updating openEMS in the runtime…" } else { "Updating Fairbeam in the runtime…" }}),
                );
                let log = logs_dir(app).join(format!("runtime-{}.log", stamp()));
                if let Err(e) = runtime::install(&rt, res, false, !new_openems, &log, &|_| {}) {
                    setup_screen(app, res, s, "The runtime could not be updated.", e, vec![]);
                    return None;
                }
            }
            if !current() {
                return None;
            }
            match runtime::check_python(&python, Some(&rt), res) {
                Ok(v) => {
                    return Some(Chosen {
                        python,
                        runtime: Some(rt),
                        openems: v,
                        gpu: false,
                        note: gpu_fallback_note.clone(),
                    })
                }
                Err(e) => {
                    setup_screen(app, res, s, "The Fairbeam runtime is damaged.",
                        format!("Its Python does not import openEMS, CSXCAD and fairbeam: {e}. Repair reinstalls it."),
                        vec![json!({"python": python, "why": "managed runtime", "result": e})]);
                    return None;
                }
            }
        }
        Managed::Missing(why) => {
            let mut tried = vec![json!({"python": rt, "why": "managed runtime", "result": why})];
            // 4. not configured yet: an existing installation on this machine is used as is
            if s.runtime.is_none() {
                for (py, why) in runtime::external_candidates(s.prefer_gpu) {
                    if why.starts_with("GPU") && py.exists() && !runtime::has_gpu_engine(&py) {
                        tried.push(json!({"python": py, "why": why, "result": "no gpu engine in this openEMS build"}));
                        continue;
                    }
                    match runtime::check_python(&py, None, res) {
                        Ok(v) => {
                            let gpu = runtime::has_gpu_engine(&py);
                            return Some(Chosen {
                                python: py,
                                runtime: None,
                                openems: v,
                                gpu,
                                note: Some(format!(
                                    "using the openEMS installation found at {why}"
                                )),
                            });
                        }
                        Err(e) => tried.push(json!({"python": py, "why": why, "result": e})),
                    }
                }
            }
            setup_screen(app, res, s, "Fairbeam needs to install its runtime.",
                "Python, the Python packages and openEMS are installed once for your user account, in the folder below. Nothing is installed system-wide.".into(),
                tried);
            None
        }
    }
}

/// Choose the Python, seed the workspace, start the server, wait for it and show the viewer.
fn start(app: AppHandle) {
    let generation = {
        let shell = app.state::<Shell>();
        let mut g = shell.generation.lock().unwrap();
        *g += 1;
        *g
    };
    thread::spawn(move || {
        // first: the import from the previous app (moves the workspace before the seed step)
        antenlab_import::on_start(&app, &|text: &str| splash(&app, json!({"phase": "starting", "text": text})));
        let current = || *app.state::<Shell>().generation.lock().unwrap() == generation;
        stop_server(&app);
        let s = load_settings(&app);
        let res = Res::locate(&app);
        let Some(chosen) = choose(&app, &res, &s, &current) else {
            return;
        };
        if !current() {
            return;
        }
        let ws = workspace(&app, &s, &res);
        match seed::seed(&ws, &res) {
            Ok(done) if !done.is_empty() => {
                splash(
                    &app,
                    json!({"phase": "starting", "text": "Preparing your workspace…", "workspace": ws.root}),
                );
            }
            Ok(_) => {}
            Err(e) => {
                splash(
                    &app,
                    json!({"phase": "error", "text": "The workspace could not be prepared.", "detail": e}),
                );
                return;
            }
        }
        let port = if cfg!(debug_assertions) {
            std::env::var("FAIRBEAM_API_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(5325)
        } else {
            let mut s = load_settings(&app);
            let port = server::stable_port(s.server_port).unwrap_or(5320);
            if s.server_port != Some(port) {
                s.server_port = Some(port);
                let _ = save_settings(&app, &s);
            }
            port
        };
        let log = logs_dir(&app).join("server.log");
        splash(
            &app,
            json!({"phase": "starting", "text": "Starting the Fairbeam server…", "python": chosen.python,
            "openems": chosen.openems, "gpu": chosen.gpu, "port": port, "log": log, "workspace": ws.root, "note": chosen.note}),
        );

        let mut cmd = Command::new(&chosen.python);
        cmd.args([
            "-m",
            "fairbeam",
            "serve",
            "--port",
            &port.to_string(),
            "--exit-with-parent",
        ])
        .arg("--models")
        .arg(&ws.models)
        .arg("--projects")
        .arg(&ws.projects)
        .arg("--jobs")
        .arg(&ws.jobs)
        .arg("--sim-root")
        .arg(&ws.sim)
        .arg("--python")
        .arg(&chosen.python)
        .current_dir(&ws.root)
        .stdin(Stdio::null());
        runtime::python_env(&mut cmd, &chosen.python, chosen.runtime.as_deref(), &res);
        // usage statistics (docs/TELEMETRY.md): only with the telemetry build switch on
        if let Some(dir) = telemetry::server_dir(&app, chosen.gpu) {
            cmd.env("FAIRBEAM_TELEMETRY_DIR", dir);
        }
        if let Some(ui) = &res.ui {
            cmd.arg("--ui").arg(ui);
        }
        match fs::File::create(&log)
            .ok()
            .and_then(|f| f.try_clone().ok().zip(Some(f)))
        {
            Some((o, e)) => {
                cmd.stdout(o).stderr(e);
            }
            None => {
                cmd.stdout(Stdio::null()).stderr(Stdio::null());
            }
        }
        let srv = match Server::spawn(cmd, port) {
            Ok(s) => s,
            Err(e) => {
                splash(
                    &app,
                    json!({"phase": "error", "text": "Could not start the server.", "detail": e.to_string(), "log": log}),
                );
                return;
            }
        };
        *app.state::<Shell>().server.lock().unwrap() = Some(srv);

        let started = Instant::now();
        let deadline = started + Duration::from_secs(90);
        loop {
            if !current() {
                return;
            }
            if http_ok(port, "/api/health") {
                *app.state::<Shell>().active_workspace.lock().unwrap() = Some(ws.root.clone());
                let using_gpu_runtime = chosen.gpu
                    && chosen.runtime.as_ref().is_some_and(|root| {
                        paths::canonical(root) == paths::canonical(&gpu_runtime_root(&app))
                    });
                *app.state::<Shell>().active_gpu_runtime.lock().unwrap() = using_gpu_runtime;
                break;
            }
            let exited = {
                let shell = app.state::<Shell>();
                let mut guard = shell.server.lock().unwrap();
                guard.as_mut().map(|s| s.exited()).unwrap_or(true)
            };
            if exited || Instant::now() > deadline {
                splash(
                    &app,
                    json!({"phase": "error",
                    "text": if exited { "The server stopped during start-up." } else { "The server did not answer within 90 s." },
                    "detail": tail(&log, 14), "log": log, "python": chosen.python}),
                );
                return;
            }
            // the server usually answers ~0.3 s after spawn: poll finely at first, then back off
            let step = if started.elapsed() < Duration::from_secs(3) {
                50
            } else {
                250
            };
            thread::sleep(Duration::from_millis(step));
        }

        let target = match dev_url() {
            Some(url) => {
                splash(
                    &app,
                    json!({"phase": "starting", "text": format!("Waiting for the Vite dev server at {url}…"), "port": port}),
                );
                let dev_port = Url::parse(&url).ok().and_then(|u| u.port()).unwrap_or(5315);
                while current() && !http_ok(dev_port, "/") {
                    thread::sleep(Duration::from_millis(300));
                }
                url
            }
            None => format!("http://127.0.0.1:{port}/"),
        };
        splash(
            &app,
            json!({"phase": "ready", "text": "Opening Fairbeam…", "port": port}),
        );
        if let (Some(win), Ok(url)) = (app.get_webview_window("main"), Url::parse(&target)) {
            let _ = win.navigate(url);
        }
        updater::check_later(app.clone());
    });
}

#[tauri::command]
fn splash_state(shell: tauri::State<'_, Shell>) -> Value {
    shell.splash.lock().unwrap().clone()
}

#[tauri::command]
fn retry(app: AppHandle) {
    start(app);
}

/// Install (or repair) the managed runtime, then start with it.
#[tauri::command]
fn install_runtime(app: AppHandle, repair: bool) {
    {
        let shell = app.state::<Shell>();
        let mut busy = shell.installing.lock().unwrap();
        let gpu_busy = shell.gpu_installing.lock().unwrap();
        if *busy || *gpu_busy {
            return;
        }
        *busy = true;
    }
    // no start thread may report over the installer's progress
    *app.state::<Shell>().generation.lock().unwrap() += 1;
    thread::spawn(move || {
        stop_server(&app);
        let res = Res::locate(&app);
        let rt = runtime_root(&app);
        let log = logs_dir(&app).join(format!("runtime-{}.log", stamp()));
        splash(
            &app,
            json!({"phase": "installing", "step": "start", "text": "Installing the Fairbeam runtime…", "runtime": rt, "log": log}),
        );
        let progress_app = app.clone();
        let progress_log = log.clone();
        let result = runtime::install(&rt, &res, repair, false, &log, &move |p: Value| {
            splash(
                &progress_app,
                json!({"phase": "installing", "text": "Installing the Fairbeam runtime…",
                "step": p["step"], "fraction": p["fraction"], "message": p["message"], "log": progress_log}),
            );
        });
        *app.state::<Shell>().installing.lock().unwrap() = false;
        match result {
            Ok(()) => {
                let mut s = load_settings(&app);
                s.runtime = Some("managed".into());
                s.python = None;
                let _ = save_settings(&app, &s);
                start(app);
            }
            Err(e) => {
                splash(
                    &app,
                    json!({"phase": "error", "text": "The runtime could not be installed.", "detail": e,
                    "log": log, "installFailed": true}),
                );
            }
        }
    });
}

/// Not a command: only `choose_python` calls it, so no page can name an executable for the shell.
fn use_python(app: AppHandle, path: String) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.runtime = Some("external".into());
    s.python = Some(path);
    save_settings(&app, &s)?;
    start(app);
    Ok(())
}

#[tauri::command]
fn use_managed(app: AppHandle) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.runtime = Some("managed".into());
    s.python = None;
    save_settings(&app, &s)?;
    start(app);
    Ok(())
}

/// The window's first size (logical points), used when it fits the screen.
const DEFAULT_SIZE: (f64, f64) = (1440.0, 900.0);
/// Room for the title bar around the inner size (macOS about 28 points, Windows about 32).
const TITLE_BAR: f64 = 40.0;

/// How the main window opens on a screen.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Fit {
    /// the default size plus the title bar does not fit the work area: fill it (maximized)
    maximize: bool,
    /// the minimum inner size: 1024 × 700, or less on a screen smaller than that
    min: (f64, f64),
}

/// A laptop screen can be smaller than the default window once the menu bar, the Dock or the
/// taskbar are taken off: the window then fills the screen's work area (maximized) instead of
/// running off its bottom edge. `w` × `h`: the work area in logical points.
fn fit_for(w: f64, h: f64) -> Fit {
    Fit {
        maximize: DEFAULT_SIZE.0 > w || DEFAULT_SIZE.1 + TITLE_BAR > h,
        min: (w.min(1024.0), (h - TITLE_BAR).min(700.0)),
    }
}

/// Decided from the primary monitor before the window exists (the new window is centred there),
/// so the builder creates it maximized instead of resizing it afterwards.
fn fit_to_screen(monitor: Option<tauri::Monitor>) -> Fit {
    let Some(m) = monitor else {
        return Fit {
            maximize: false,
            min: (1024.0, 700.0),
        };
    };
    let scale = m.scale_factor();
    let area = m.work_area().size;
    fit_for(area.width as f64 / scale, area.height as f64 / scale)
}

#[tauri::command]
fn set_prefer_gpu(app: AppHandle, value: bool) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.prefer_gpu = value;
    save_settings(&app, &s)?;
    start(app);
    Ok(())
}

/// Settings › "Use the GPU build": saved only, applied at the next start (restarting the server
/// here would drop the viewer's unsaved work).
#[tauri::command]
fn set_gpu_build(app: AppHandle, value: bool) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.prefer_gpu = value;
    save_settings(&app, &s)
}

/// Async: it may run the external Python's `openEMS --help` (has_gpu_engine), which must not
/// block the main thread.
#[tauri::command]
async fn get_general_settings(app: AppHandle) -> Value {
    let s = load_settings(&app);
    let res = Res::locate(&app);
    let next_workspace = workspace(&app, &s, &res).root;
    let current_workspace = app
        .state::<Shell>()
        .active_workspace
        .lock()
        .unwrap()
        .clone();
    let workspace_pending = current_workspace
        .as_ref()
        .is_some_and(|path| paths::canonical(path) != paths::canonical(&next_workspace));
    let gpu_root = gpu_runtime_root(&app);
    let gpu_status = runtime::gpu_runtime_status(&gpu_root, &res);
    let gpu_runtime_ready = matches!(&gpu_status, runtime::GpuRuntimeStatus::Ready { .. });
    let gpu_runtime_status = match &gpu_status {
        runtime::GpuRuntimeStatus::Ready { .. } => "ready".to_string(),
        runtime::GpuRuntimeStatus::Missing(reason) => reason.clone(),
    };
    let gpu_support = runtime::gpu_install_support();
    let gpu_installing = *app.state::<Shell>().gpu_installing.lock().unwrap();
    let external = s.external();
    // a Python chosen in the setup screen comes first; when its openEMS lists the gpu engine it
    // is the GPU build as far as Settings is concerned (#175: E:\opt\openEMS-gpu chosen by hand)
    let external_gpu = external.as_deref().filter(|py| runtime::has_gpu_engine(py));
    let gpu_build = match external_gpu {
        Some(py) => Some(runtime::install_folder(py).display().to_string()),
        None => runtime::gpu_build_present().then(runtime::gpu_build_label),
    };
    let gpu_choice = gpu_choice(&res, &gpu_root, &gpu_status, &gpu_support);
    json!({
        "check_updates_on_start": s.check_updates_on_start,
        "workspace": next_workspace.display().to_string(),
        "next_workspace": next_workspace.display().to_string(),
        "current_workspace": current_workspace.map(|p| p.display().to_string()),
        "workspace_pending": workspace_pending,
        "prefer_gpu": s.prefer_gpu,
        "gpu_build": gpu_build,
        "external_is_gpu": external_gpu.is_some(),
        "external_python": external.map(|p| p.display().to_string()),
        "gpu_runtime": gpu_root.display().to_string(),
        "gpu_runtime_ready": gpu_runtime_ready,
        "gpu_runtime_status": gpu_runtime_status,
        "gpu_runtime_installing": gpu_installing,
        "gpu_runtime_enabled": s.gpu_runtime_enabled,
        "gpu_choice_ready": gpu_choice.is_some(),
        "gpu_choice_source": gpu_choice.as_ref().map(|choice| choice.source),
        "gpu_choice_path": gpu_choice.as_ref().map(|choice| choice.path.clone()),
        "gpu_supported": gpu_support.supported,
        "gpu_support_reason": gpu_support.reason,
        "gpu_adapter": gpu_support.adapter,
        "gpu_driver": gpu_support.driver,
    })
}

#[tauri::command]
async fn check_updates_now(app: AppHandle) -> updater::CheckResult {
    updater::check_now(app, false).await
}

#[tauri::command]
fn set_update_check_on_start(app: AppHandle, value: bool) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.check_updates_on_start = value;
    save_settings(&app, &s)
}

#[tauri::command]
fn set_gpu_runtime_enabled(app: AppHandle, value: bool) -> Result<(), String> {
    if value {
        let res = Res::locate(&app);
        let support = runtime::gpu_install_support();
        let gpu_root = gpu_runtime_root(&app);
        let gpu_status = runtime::gpu_runtime_status(&gpu_root, &res);
        if gpu_choice(&res, &gpu_root, &gpu_status, &support).is_none() {
            if !support.supported {
                return Err(support
                    .reason
                    .unwrap_or("gpu_runtime_unsupported")
                    .to_string());
            }
            return Err("gpu_runtime_not_ready".into());
        }
    }
    let mut settings = load_settings(&app);
    settings.gpu_runtime_enabled = value;
    save_settings(&app, &settings)
}

#[tauri::command]
async fn install_gpu_runtime(app: AppHandle) -> Result<(), String> {
    {
        let shell = app.state::<Shell>();
        let cpu_installing = shell.installing.lock().unwrap();
        if *cpu_installing {
            return Err("runtime_installing".into());
        }
        if *shell.active_gpu_runtime.lock().unwrap() {
            return Err("gpu_runtime_in_use_until_exit".into());
        }
        let mut installing = shell.gpu_installing.lock().unwrap();
        if *installing {
            return Err("gpu_runtime_installing".into());
        }
        *installing = true;
    }

    let worker_app = app.clone();
    let worker_result = tauri::async_runtime::spawn_blocking(move || {
        let res = Res::locate(&worker_app);
        let root = gpu_runtime_root(&worker_app);
        let status = runtime::gpu_runtime_status(&root, &res);
        if let runtime::GpuRuntimeStatus::Ready { fairbeam, .. } = &status {
            if res
                .fairbeam_version()
                .as_ref()
                .is_none_or(|version| fairbeam.as_ref() == Some(version))
            {
                return Ok(());
            }
        }
        let (repair, app_only) = match status {
            runtime::GpuRuntimeStatus::Ready { .. } => (false, true),
            runtime::GpuRuntimeStatus::Missing(_) => (root.exists(), false),
        };
        let log = logs_dir(&worker_app).join("gpu-runtime-install.log");
        runtime::install_gpu(&root, &res, repair, app_only, &log, &|line| {
            shelllog::write(&worker_app, &format!("GPU runtime install: {line}"));
        })
    })
    .await;
    *app.state::<Shell>().gpu_installing.lock().unwrap() = false;
    worker_result.map_err(|e| format!("gpu_runtime_install_worker_failed: {e}"))?
}

#[tauri::command]
async fn pick_workspace_folder(app: AppHandle) -> Result<Option<String>, String> {
    let settings = load_settings(&app);
    let starting_folder = workspace(&app, &settings, &Res::locate(&app)).root;
    let lang = i18n::lang(&settings);
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title(i18n::text(lang, "choose-workspace-title"))
        .set_directory(starting_folder)
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    let path = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .map_err(|_| "workspace_picker_failed".to_string())?;
    Ok(path
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string()))
}

/// Settings > General > Blender > Browse: a native file picker for the Blender executable (the path is kept
/// in the viewer's settings and sent to the run server with each render; nothing is stored here).
#[tauri::command]
async fn pick_blender_executable(app: AppHandle) -> Result<Option<String>, String> {
    let lang = i18n::lang(&load_settings(&app));
    let tx = |key: &str| i18n::text(lang, key);
    let (sender, receiver) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title(tx("choose-blender-title"))
        .pick_file(move |path| {
            let _ = sender.send(path);
        });
    let path = tauri::async_runtime::spawn_blocking(move || receiver.recv().ok().flatten())
        .await
        .map_err(|_| "blender_picker_failed".to_string())?;
    Ok(path
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string()))
}

#[tauri::command]
fn set_workspace_folder(app: AppHandle, path: String) -> Result<String, String> {
    let selected = PathBuf::from(path);
    let res = Res::locate(&app);
    let protected_data = local_data(&app);
    let validated = workspace_settings::validate(&selected, &res.root, &protected_data)
        .map_err(|e| e.code().to_string())?;
    let mut settings = load_settings(&app);
    let previous = workspace(&app, &settings, &res).root;
    let changed = paths::canonical(&previous) != paths::canonical(&validated);
    settings.workspace = Some(validated.to_string_lossy().into_owned());
    // The native Open Recent menu belongs to the active workspace. Drop it as soon as a different
    // workspace is scheduled so paths from this workspace do not appear after the next start.
    if changed {
        settings.recent_designs.clear();
    }
    save_settings(&app, &settings)?;
    if changed {
        if let Ok(menu) = app_menu(&app) {
            let _ = app.set_menu(menu);
        }
    }
    Ok(validated.display().to_string())
}

/// The viewer's language (General settings › Language, resolved: "en" or "tr"): saved for the next
/// start (the menus and the splash page) and the native menus rebuilt in it now.
#[tauri::command]
fn set_language(app: AppHandle, lang: String) -> Result<(), String> {
    if !i18n::valid(&lang) {
        return Err("Unsupported language".into());
    }
    let mut s = load_settings(&app);
    if s.language.as_deref() == Some(lang.as_str()) {
        return Ok(());
    }
    s.language = Some(lang);
    save_settings(&app, &s)?;
    app.set_menu(app_menu(&app).map_err(|e| e.to_string())?)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_workspace(app: AppHandle) -> Result<(), String> {
    let s = load_settings(&app);
    let dir = app
        .state::<Shell>()
        .active_workspace
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| workspace(&app, &s, &Res::locate(&app)).root);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open_directory(&dir)
}

fn valid_design_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (2..=41).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

#[tauri::command]
fn remember_recent_design(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_design_id(&id) {
        return Err("Invalid design id".into());
    }
    let mut settings = load_settings(&app);
    let current = app
        .state::<Shell>()
        .active_workspace
        .lock()
        .unwrap()
        .clone();
    let next = workspace(&app, &settings, &Res::locate(&app)).root;
    if current
        .as_ref()
        .is_some_and(|path| paths::canonical(path) != paths::canonical(&next))
    {
        // The current server may still be editing the old workspace after a next-start change.
        // Keep its recent designs out of settings so they do not reappear in the new workspace.
        return Ok(());
    }
    settings.recent_designs.retain(|entry| entry != &id);
    settings.recent_designs.insert(0, id);
    settings.recent_designs.truncate(8);
    save_settings(&app, &settings)?;
    app.set_menu(app_menu(&app).map_err(|e| e.to_string())?)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Opens one of a fixed set of links in the default browser. The page names the link by key; the
/// URL itself always comes from this table, never from the page.
#[tauri::command]
fn open_external_link(link: String) -> Result<(), String> {
    let url = external_url(&link).ok_or("External link is not allowlisted")?;
    open_url(url)
}

fn open_url(url: &'static str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let child = Command::new("explorer.exe").arg(url).spawn();
    #[cfg(target_os = "macos")]
    let child = Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let child = Command::new("xdg-open").arg(url).spawn();
    child.map(|_| ()).map_err(|e| e.to_string())
}

fn external_url(link: &str) -> Option<&'static str> {
    Some(match link {
        "developer" => "https://akdag.dev",
        // public places only (the source repository is private): the releases repository, the
        // getting-started guide on the website and the issue forms of the public tracker
        "repository" => "https://github.com/ismailakdag/fairbeam-releases",
        "docs" => "https://fairbeam.org/guide.html",
        "issues" => "https://github.com/ismailakdag/fairbeam-releases/issues/new/choose",
        "openems" => "https://github.com/thliebig/openEMS",
        "csxcad" => "https://github.com/thliebig/CSXCAD",
        // what usage statistics would collect (docs/TELEMETRY.md)
        "privacy" => "https://fairbeam.org/privacy.html",
        _ => return None,
    })
}

fn open_directory(dir: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let child = Command::new("explorer.exe").arg(dir).spawn();
    #[cfg(target_os = "macos")]
    let child = Command::new("open").arg(dir).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let child = Command::new("xdg-open").arg(dir).spawn();
    child.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn choose_python(app: AppHandle) {
    let handle = app.clone();
    let lang = i18n::lang(&load_settings(&app));
    let tx = |key: &str| i18n::text(lang, key);
    let title = if cfg!(windows) {
        tx("choose-python-windows")
    } else {
        tx("choose-python-unix")
    };
    app.dialog()
        .file()
        .set_title(title)
        .pick_file(move |picked| {
            let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
                return;
            };
            let _ = use_python(handle, path.to_string_lossy().into_owned());
        });
}

/// Keep Tauri's platform menus (including macOS services and Hide), but make Cmd/Ctrl+W
/// close the open project through its save prompt, or close the window when none is open.
/// Quit (File > Exit on Windows, the app menu's Quit / Cmd+Q on macOS) is our own item: the
/// predefined one ends the app at once (PostQuitMessage / terminate:) without asking the viewer.
const CONTEXTUAL_MENU_IDS: &[&str] = &[
    "file-save",
    "file-save-as",
    "file-close",
    "export-cst",
    "export-python",
    "export-touchstone",
    "export-package",
    "view-design",
    "view-tree",
    "view-dock",
    "view-properties",
    "view-ribbon",
    "view-iso",
    "view-top",
    "view-front",
    "view-right",
    "view-bottom",
    "view-back",
    "view-left",
    "view-zoom-in",
    "view-zoom-out",
    "view-zoom-reset",
];

fn action_enabled(handle: &AppHandle, id: &str) -> bool {
    if !CONTEXTUAL_MENU_IDS.contains(&id) {
        return true;
    }
    let Some(shell) = handle.try_state::<Shell>() else {
        return true;
    };
    let enabled = shell
        .menu_availability
        .lock()
        .unwrap()
        .get(id)
        .copied()
        .unwrap_or(true);
    enabled
}

fn action_item(handle: &AppHandle, id: &str, label: &str) -> tauri::Result<MenuItem<tauri::Wry>> {
    MenuItem::with_id(handle, id, label, action_enabled(handle, id), None::<&str>)
}

fn set_menu_item_enabled_in_items(
    items: &[MenuItemKind<tauri::Wry>],
    id: &str,
    enabled: bool,
) -> tauri::Result<bool> {
    for item in items {
        match item {
            MenuItemKind::MenuItem(menu_item) if menu_item.id().as_ref() == id => {
                menu_item.set_enabled(enabled)?;
                return Ok(true);
            }
            MenuItemKind::Submenu(submenu) => {
                let nested = submenu.items()?;
                if set_menu_item_enabled_in_items(&nested, id, enabled)? {
                    return Ok(true);
                }
            }
            _ => {}
        }
    }
    Ok(false)
}

/// Apply the viewer's current mode to only the native commands in the fixed contextual allowlist.
#[tauri::command]
fn sync_native_menu_availability(
    app: AppHandle,
    availability: HashMap<String, bool>,
) -> Result<(), String> {
    if availability.len() != CONTEXTUAL_MENU_IDS.len()
        || availability
            .keys()
            .any(|id| !CONTEXTUAL_MENU_IDS.contains(&id.as_str()))
        || CONTEXTUAL_MENU_IDS
            .iter()
            .any(|id| !availability.contains_key(*id))
    {
        return Err("Invalid native menu availability state".into());
    }

    let shell = app.state::<Shell>();
    *shell.menu_availability.lock().unwrap() = availability.clone();

    let menu = app
        .menu()
        .ok_or_else(|| "The native menu is unavailable".to_string())?;
    let items = menu.items().map_err(|error| error.to_string())?;
    for id in CONTEXTUAL_MENU_IDS {
        let enabled = availability[*id];
        if !set_menu_item_enabled_in_items(&items, id, enabled)
            .map_err(|error| error.to_string())?
        {
            return Err(format!("Native menu item is unavailable: {id}"));
        }
    }
    Ok(())
}

fn action_submenu(
    handle: &AppHandle,
    title: &str,
    entries: &[(&str, &str)],
) -> tauri::Result<Submenu<tauri::Wry>> {
    let items = entries
        .iter()
        .map(|(id, label)| action_item(handle, id, label))
        .collect::<tauri::Result<Vec<_>>>()?;
    let refs = items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect::<Vec<_>>();
    Submenu::with_items(handle, title, true, &refs)
}

fn app_menu(handle: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(handle)?;
    // the menus in the viewer's language (src-tauri/src/i18n.rs)
    let lang = i18n::lang(&load_settings(handle));
    let tx = |key: &str| i18n::text(lang, key);
    let command = if cfg!(target_os = "macos") {
        "⌘"
    } else {
        "Ctrl+"
    };
    let control = if cfg!(target_os = "macos") {
        "⌃"
    } else {
        "Ctrl+"
    };
    let close_window = MenuItem::with_id(
        handle,
        "close-window",
        tx("close-window"),
        true,
        Some("CmdOrCtrl+W"),
    )?;
    #[cfg(target_os = "macos")]
    let quit = MenuItem::with_id(
        handle,
        "quit",
        i18n::fill(tx("quit-macos"), &[("app", &handle.package_info().name)]),
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    #[cfg(windows)]
    let quit = MenuItem::with_id(handle, "quit", tx("quit-windows"), true, None::<&str>)?;
    #[cfg(not(any(windows, target_os = "macos")))]
    let quit = MenuItem::with_id(handle, "quit", tx("quit-other"), true, None::<&str>)?;
    let recent_entries = load_settings(handle)
        .recent_designs
        .into_iter()
        .filter(|id| valid_design_id(id))
        .take(8)
        .map(|id| action_item(handle, &format!("file-open-recent:{id}"), &id))
        .collect::<tauri::Result<Vec<_>>>()?;
    let recent_refs = recent_entries
        .iter()
        .map(|entry| entry as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect::<Vec<_>>();
    let recent = Submenu::with_items(handle, tx("open-recent"), true, &recent_refs)?;
    let export_labels = [
        ("export-cst", tx("export-cst")),
        ("export-python", tx("export-python")),
        ("export-touchstone", tx("export-touchstone")),
        ("export-package", tx("export-package")),
    ];
    let export_refs = export_labels
        .iter()
        .map(|(id, label)| (*id, label.as_str()))
        .collect::<Vec<_>>();
    let export = action_submenu(handle, &tx("export"), &export_refs)?;
    let file_actions = vec![
        action_item(handle, "file-new", &tx("file-new"))?,
        action_item(handle, "file-import-cst", &tx("file-import-cst"))?,
        action_item(handle, "file-import-pcb", &tx("file-import-pcb"))?,
        action_item(handle, "file-open", &tx("file-open"))?,
        action_item(
            handle,
            "file-save",
            &format!("{}    {command}S", tx("file-save")),
        )?,
        action_item(handle, "file-save-as", &tx("file-save-as"))?,
        action_item(handle, "file-close", &tx("file-close"))?,
        #[cfg(target_os = "macos")]
        close_window.clone(),
        #[cfg(not(target_os = "macos"))]
        action_item(handle, "settings", &tx("settings"))?,
        #[cfg(not(target_os = "macos"))]
        quit.clone(),
    ];
    let mut file_items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = file_actions
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();
    file_items.insert(3, &recent);
    file_items.insert(6, &export);
    let file_menu = Submenu::with_items(handle, tx("file"), true, &file_items)?;
    // The page handles designer shortcuts before native menu accelerators. When a text field has
    // focus, the menu action instead asks the WebView to apply its text undo/redo.
    let edit_menu = Submenu::with_items(
        handle,
        tx("edit"),
        true,
        &[
            &MenuItem::with_id(handle, "edit-undo", tx("undo"), true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(
                handle,
                "edit-redo",
                tx("redo"),
                true,
                Some("CmdOrCtrl+Shift+Z"),
            )?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, Some(&tx("cut")))?,
            &PredefinedMenuItem::copy(handle, Some(&tx("copy")))?,
            &PredefinedMenuItem::paste(handle, Some(&tx("paste")))?,
            &PredefinedMenuItem::select_all(handle, Some(&tx("select-all")))?,
            &PredefinedMenuItem::separator(handle)?,
            &action_item(handle, "edit-delete", &tx("delete"))?,
        ],
    )?;
    let view_labels = [
        ("view-start", tx("view-start")),
        ("view-design", tx("view-design")),
        ("view-examples", tx("view-examples")),
        (
            "view-tree",
            format!("{}    {control}Shift+1", tx("view-tree")),
        ),
        (
            "view-dock",
            format!("{}    {control}Shift+2", tx("view-dock")),
        ),
        (
            "view-properties",
            format!("{}    {control}Shift+3", tx("view-properties")),
        ),
        (
            "view-ribbon",
            format!("{}    {control}F1", tx("view-ribbon")),
        ),
        ("view-iso", tx("view-iso")),
        ("view-top", tx("view-top")),
        ("view-front", tx("view-front")),
        ("view-right", tx("view-right")),
        ("view-bottom", tx("view-bottom")),
        ("view-back", tx("view-back")),
        ("view-left", tx("view-left")),
        ("view-zoom-in", tx("view-zoom-in")),
        ("view-zoom-out", tx("view-zoom-out")),
        ("view-zoom-reset", tx("view-zoom-reset")),
    ];
    let view_refs = view_labels
        .iter()
        .map(|(id, label)| (*id, label.as_str()))
        .collect::<Vec<_>>();
    let view_menu = action_submenu(handle, &tx("view"), &view_refs)?;
    let mut help_labels = vec![
        ("help-shortcuts", tx("help-shortcuts")),
        ("about", tx("about")),
        ("help-docs", tx("help-docs")),
        ("help-issues", tx("help-issues")),
        ("help-updates", tx("help-updates")),
    ];
    // the importer's removal entry while anything of the previous app is left
    help_labels.extend(antenlab_import::menu_entry(handle, lang));
    let help_refs = help_labels
        .iter()
        .map(|(id, label)| (*id, label.as_str()))
        .collect::<Vec<_>>();
    let help_menu = action_submenu(handle, &tx("help"), &help_refs)?;
    let window_menu = Submenu::with_id_and_items(
        handle,
        tauri::menu::WINDOW_SUBMENU_ID,
        tx("window"),
        true,
        &[
            &PredefinedMenuItem::minimize(handle, Some(&tx("minimize")))?,
            &PredefinedMenuItem::maximize(handle, Some(&tx("maximize")))?,
            &action_item(handle, "window-fullscreen", &tx("window-fullscreen"))?,
            &close_window,
        ],
    )?;
    let mut found_file = false;
    let mut found_edit = false;
    let mut found_view = false;
    let mut found_window = false;
    let mut found_help = false;
    for (position, item) in menu.items()?.into_iter().enumerate() {
        if let MenuItemKind::Submenu(submenu) = item {
            // macOS: the app menu (the first one) ends with the predefined Quit
            #[cfg(target_os = "macos")]
            if position == 0 {
                // Remove by identity first and insert afterwards: indices from the snapshot shift
                // once About is gone (inserting Quit at its old index was past the end and aborted
                // the app at start).
                for entry in submenu.items()? {
                    if let MenuItemKind::Predefined(predefined) = entry {
                        let text = predefined.text()?;
                        if text.starts_with("About") || text.starts_with("Quit") {
                            submenu.remove(&predefined)?;
                        }
                    }
                }
                // About Fairbeam, —, Settings… ⌘,, —, Services, —, Hide, Hide Others, —, Quit ⌘Q
                submenu.prepend(&action_item(handle, "about", &tx("about"))?)?;
                let at = submenu.items()?.len().min(2);
                submenu.insert(
                    &MenuItem::with_id(
                        handle,
                        "settings",
                        tx("settings"),
                        true,
                        Some("CmdOrCtrl+,"),
                    )?,
                    at,
                )?;
                submenu.insert(&PredefinedMenuItem::separator(handle)?, at + 1)?;
                submenu.append(&quit)?;
                continue;
            }
            if submenu.text()? == "File" {
                menu.remove(&submenu)?;
                menu.insert(&file_menu, position)?;
                found_file = true;
            } else if submenu.text()? == "Edit" {
                menu.remove(&submenu)?;
                menu.insert(&edit_menu, position)?;
                found_edit = true;
            } else if submenu.text()? == "View" {
                menu.remove(&submenu)?;
                menu.insert(&view_menu, position)?;
                found_view = true;
            } else if submenu.id().as_ref() == tauri::menu::WINDOW_SUBMENU_ID {
                // Use the same routed Close Window command in both menus.
                menu.remove(&submenu)?;
                menu.insert(&window_menu, position)?;
                found_window = true;
            } else if submenu.id().as_ref() == tauri::menu::HELP_SUBMENU_ID
                || submenu.text()? == "Help"
            {
                menu.remove(&submenu)?;
                menu.insert(&help_menu, position)?;
                found_help = true;
            }
        }
    }
    if !found_file {
        menu.prepend(&file_menu)?;
    }
    if !found_edit {
        menu.append(&edit_menu)?;
    }
    if !found_view {
        let position = menu.items()?.iter().position(|item| {
            matches!(item, MenuItemKind::Submenu(submenu) if submenu.id().as_ref() == tauri::menu::WINDOW_SUBMENU_ID)
        }).unwrap_or(menu.items()?.len());
        menu.insert(&view_menu, position)?;
    }
    if !found_window {
        menu.append(&window_menu)?;
    }
    if !found_help {
        menu.append(&help_menu)?;
    }
    Ok(menu)
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Shell::default())
        .on_menu_event(|app, event| {
            let close_window = event.id().as_ref() == "close-window";
            let id = event.id().as_ref();
            if close_window || id == "close-project" {
                if let Some(win) = app.get_webview_window("main") {
                    let target = win.clone();
                    let _ = win.eval_with_callback(
                        "window.dispatchEvent(new Event('fairbeam:close-project', { cancelable: true }))",
                        move |unhandled| {
                        if close_window && unhandled == "true" {
                            request_leave(target.app_handle(), Leave::Window);
                        }
                        },
                    );
                }
            } else if id == "quit" {
                request_leave(app, Leave::Quit);
            } else if id == "help-updates" {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = updater::check_now(handle, true).await;
                });
            } else if id == antenlab_import::MENU_ID {
                antenlab_import::on_menu(app);
            } else if id == "help-docs" {
                if let Some(url) = external_url("docs") {
                    let _ = open_url(url);
                }
            } else if id == "help-issues" {
                if let Some(url) = external_url("issues") {
                    let _ = open_url(url);
                }
            } else if id == "window-fullscreen" {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_fullscreen(!win.is_fullscreen().unwrap_or(false));
                }
            } else if let Some(win) = app.get_webview_window("main") {
                // our own menu id as a JSON string literal; the splash page has no router
                let script = format!(
                    "typeof window.fairbeamMenuAction === 'function' && window.fairbeamMenuAction({})",
                    serde_json::to_string(id).unwrap()
                );
                let _ = win.eval(&script);
            }
        })
        .on_window_event(|window, event| {
            // the title-bar X, Alt+F4, the red close button: the viewer decides
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    request_leave(window.app_handle(), Leave::Window);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![splash_state, retry, install_runtime, use_managed, set_prefer_gpu, set_gpu_build, choose_python, reveal_download, reveal_design, save_download, get_general_settings, set_update_check_on_start, check_updates_now, set_language, sync_native_menu_availability, open_workspace, pick_workspace_folder, pick_blender_executable, set_workspace_folder, install_gpu_runtime, set_gpu_runtime_enabled, open_external_link, remember_recent_design, telemetry::telemetry_status, telemetry::telemetry_set_consent, telemetry::telemetry_preview, telemetry::telemetry_reset_id, telemetry::telemetry_count, antenlab_import::take_imported_viewer_prefs])
        .setup(|app| {
            // the menu reads the saved recent designs, so it is built once the path resolver exists
            // (Builder::menu runs before setup and panicked: state() called before manage())
            let menu = app_menu(app.handle())?;
            app.set_menu(menu)?;
            let fit = fit_to_screen(app.primary_monitor().ok().flatten());
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Fairbeam")
                .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
                .min_inner_size(fit.min.0, fit.min.1)
                .center()
                .maximized(fit.maximize)
                .visible(false)
                // WebView2 may ignore HTML autocomplete="off" and show "Saved info" over CAD fields.
                // Tauri documents this as a no-op on macOS and Linux, so it is safe without a cfg gate.
                .general_autofill_enabled(false)
                // Let the component tree receive HTML5 drag/drop instead of native file drops.
                // File drops onto the window are handled by the page (src/lib/fileDrop.ts, HTML5
                // events); no Rust code listens for native drag-drop events, so nothing is lost.
                .disable_drag_drop_handler()
                .on_download(|webview, event| {
                    let shell = webview.state::<Shell>();
                    match event {
                        DownloadEvent::Requested { url, destination } => {
                            shell.download_targets.lock().unwrap().insert(url.to_string(), destination.clone());
                        }
                        DownloadEvent::Finished { url, path, success } => {
                            // WKWebView reports no path when a download finishes: use the requested one
                            let requested = shell.download_targets.lock().unwrap().remove(url.as_str());
                            let path = path.or(requested).filter(|p| !p.as_os_str().is_empty());
                            if let (true, Some(p)) = (success, &path) {
                                shell.saved_downloads.lock().unwrap().insert(p.clone());
                            }
                            let payload = json!({ "url": url.as_str(), "path": path.map(|p| p.to_string_lossy().into_owned()), "success": success });
                            let _ = webview.eval(&format!("window.dispatchEvent(new CustomEvent('fairbeam:download', {{ detail: {payload} }}))"));
                        }
                        _ => {}
                    }
                    true
                })
                .build()?;
            let _ = window.show();
            // Windows: the maximized state of a hidden window does not survive (the resize to the
            // monitor's scale factor clears it, and show() then opens it Normal, #175), so it is
            // maximized again once visible. A no-op when it is maximized already (macOS).
            if fit.maximize {
                let _ = window.maximize();
            }
            // counts this start and starts the daily ping; nothing without the telemetry feature
            telemetry::on_app_start(app.handle());
            start(app.handle().clone());
            Ok(())
        });
    // optional sign-in (docs/ACCOUNTS.md), off unless built with `--features accounts`
    #[cfg(feature = "accounts")]
    let builder = builder.plugin(account::plugin());
    let app = builder
        .build(tauri::generate_context!())
        .expect("failed to build the Fairbeam app");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_server(handle);
        }
    });
}
