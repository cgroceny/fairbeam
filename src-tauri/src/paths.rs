// Settings and folders (docs/DESKTOP.md "Folders"): the app's read-only resources, the per-user
// app data (runtime, logs), and the workspace the server works on.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// The repository checkout a debug build runs from (`npm run desktop`).
pub const BUILD_REPO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    /// "managed" (the app's own runtime) or "external" (`python`); unset: managed, or an existing
    /// openEMS install found on this machine while the managed runtime is not installed
    #[serde(default)]
    pub runtime: Option<String>,
    /// Python of an existing openEMS installation (external runtime)
    #[serde(default)]
    pub python: Option<String>,
    /// Use the separately managed Windows GPU runtime on the next start when it is installed and
    /// valid; otherwise continue with the saved external or CPU runtime.
    #[serde(default)]
    pub gpu_runtime_enabled: bool,
    /// use the GPU build (~/opt/openEMS-gpu/venv, Windows C:\opt\openEMS-gpu or \opt\openEMS-gpu on
    /// another fixed drive) when it offers the gpu
    /// engine, before the managed runtime; on by default (settings written by 0.4.1 and older say
    /// false unless the setup screen's box was ticked, and keep that)
    #[serde(default = "default_prefer_gpu")]
    pub prefer_gpu: bool,
    /// workspace folder (projects, models, jobs, raw data); unset: ~/Documents/Fairbeam, or the
    /// repository checkout in debug builds. A folder containing python/fairbeam is used with the
    /// repository layout.
    #[serde(default)]
    pub workspace: Option<String>,
    /// Check for desktop updates after the viewer starts. Older settings default to enabled.
    #[serde(default = "default_check_updates_on_start")]
    pub check_updates_on_start: bool,
    #[serde(default)]
    pub recent_designs: Vec<String>,
    /// the viewer's UI language, "en" or "tr" (General settings › Language, resolved): the native
    /// menus and the splash page use it; unset until the viewer first sends it (English)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// optional sign-in (docs/ACCOUNTS.md): the non-secret profile of who signed in (tokens are in
    /// the OS credential store). Raw JSON, so a build without the accounts feature keeps it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<serde_json::Value>,
    /// the run server's port from the last start (release builds). The viewer keeps its General
    /// settings in the WebView's localStorage, which belongs to the origin `http://127.0.0.1:<port>`:
    /// a new port on every start would lose them, so the next start reuses this one while it is free
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_port: Option<u16>,
    /// the one-time import from the previous app (the importer module): {state, at, steps}
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_import: Option<serde_json::Value>,
    /// viewer preferences from that import, handed to the viewer once (take_imported_viewer_prefs)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_viewer_prefs: Option<serde_json::Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            runtime: None,
            python: None,
            gpu_runtime_enabled: false,
            prefer_gpu: true,
            workspace: None,
            check_updates_on_start: true,
            recent_designs: Vec::new(),
            language: None,
            account: None,
            server_port: None,
            legacy_import: None,
            imported_viewer_prefs: None,
        }
    }
}

fn default_prefer_gpu() -> bool {
    true
}

fn default_check_updates_on_start() -> bool {
    true
}

impl Settings {
    pub fn external(&self) -> Option<PathBuf> {
        match (self.runtime.as_deref(), &self.python) {
            (Some("external"), Some(p)) | (None, Some(p)) => Some(PathBuf::from(p)),
            _ => None,
        }
    }
}

pub fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

pub fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let path = settings_path(app).ok_or("no app config directory")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(s).unwrap()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// The app's read-only resources: `root` holds runtime/ and python/fairbeam (what the runtime
/// installer calls --resources).
pub struct Res {
    pub root: PathBuf,
    pub ui: Option<PathBuf>,
    pub models: PathBuf,
    pub templates: PathBuf,
    pub projects: PathBuf,
    pub dev: bool,
}

impl Res {
    pub fn locate(app: &AppHandle) -> Res {
        if cfg!(debug_assertions) {
            let repo = canonical(Path::new(BUILD_REPO));
            return Res {
                ui: Some(repo.join("dist")).filter(|d| d.join("index.html").is_file()),
                models: repo.join("python").join("models"),
                templates: repo.join("python").join("templates"),
                projects: repo.join("public").join("projects"),
                root: repo,
                dev: true,
            };
        }
        let root = app
            .path()
            .resource_dir()
            .map(|d| canonical(&d))
            .unwrap_or_else(|_| PathBuf::from("."));
        Res {
            ui: Some(root.join("ui")).filter(|d| d.join("index.html").is_file()),
            models: root.join("models"),
            templates: root.join("templates"),
            projects: root.join("projects"),
            root,
            dev: false,
        }
    }

    /// Version of the bundled fairbeam package (python/fairbeam/_meta.py).
    pub fn fairbeam_version(&self) -> Option<String> {
        let text =
            fs::read_to_string(self.root.join("python").join("fairbeam").join("_meta.py")).ok()?;
        let line = text
            .lines()
            .find(|l| l.trim_start().starts_with("__version__"))?;
        Some(line.split(['"', '\'']).nth(1)?.to_string())
    }
}

/// Where the server keeps its data.
pub struct Workspace {
    pub root: PathBuf,
    pub projects: PathBuf,
    pub models: PathBuf,
    pub jobs: PathBuf,
    pub sim: PathBuf,
    /// the repository layout (a checkout): nothing is seeded
    pub checkout: bool,
}

impl Workspace {
    fn checkout(repo: PathBuf) -> Workspace {
        Workspace {
            projects: repo.join("public").join("projects"),
            models: repo.join("python").join("models"),
            jobs: repo.join(".sim").join("jobs"),
            sim: repo.join(".sim"),
            root: repo,
            checkout: true,
        }
    }

    fn folder(root: PathBuf) -> Workspace {
        // models and templates are siblings: the server finds templates next to models
        Workspace {
            projects: root.join("projects"),
            models: root.join("models"),
            jobs: root.join("jobs"),
            sim: root.join(".sim"),
            root,
            checkout: false,
        }
    }

    pub fn templates(&self) -> PathBuf {
        self.models
            .parent()
            .map(|p| p.join("templates"))
            .unwrap_or_else(|| self.root.join("templates"))
    }
}

pub fn workspace(app: &AppHandle, s: &Settings, res: &Res) -> Workspace {
    if let Some(w) = &s.workspace {
        let p = canonical(Path::new(w));
        return if p.join("python").join("fairbeam").is_dir() {
            Workspace::checkout(p)
        } else {
            Workspace::folder(p)
        };
    }
    if res.dev {
        return Workspace::checkout(res.root.clone());
    }
    let docs = app.path().document_dir().unwrap_or_else(|_| home());
    Workspace::folder(docs.join("Fairbeam"))
}

/// Per-user app data: <root>/runtime and <root>/logs.
pub fn local_data(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("fairbeam"))
}

pub fn runtime_root(app: &AppHandle) -> PathBuf {
    local_data(app).join("runtime")
}

pub fn logs_dir(app: &AppHandle) -> PathBuf {
    let d = local_data(app).join("logs");
    let _ = fs::create_dir_all(&d);
    d
}

pub fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Canonical path without the Windows `\\?\` prefix (which Python and cmd do not always accept).
pub fn canonical(p: &Path) -> PathBuf {
    let c = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    #[cfg(windows)]
    {
        let s = c.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            if !rest.starts_with("UNC\\") {
                return PathBuf::from(rest);
            }
        }
    }
    c
}

#[cfg(test)]
mod settings_tests {
    use super::Settings;

    #[test]
    fn old_settings_keep_update_checks_enabled() {
        let settings: Settings =
            serde_json::from_str(r#"{"runtime":"managed","workspace":"/tmp/work"}"#).unwrap();
        assert!(settings.check_updates_on_start);
        assert_eq!(settings.workspace.as_deref(), Some("/tmp/work"));
        assert!(Settings::default().check_updates_on_start);
    }

    #[test]
    fn update_preference_round_trips() {
        let settings: Settings =
            serde_json::from_str(r#"{"check_updates_on_start":false}"#).unwrap();
        assert!(!settings.check_updates_on_start);
    }

    #[test]
    fn gpu_build_preferred_unless_turned_off() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert!(settings.prefer_gpu);
        assert!(!settings.gpu_runtime_enabled);
        assert!(Settings::default().prefer_gpu);
        let settings: Settings = serde_json::from_str(r#"{"prefer_gpu":false}"#).unwrap();
        assert!(!settings.prefer_gpu);
    }

    #[test]
    fn managed_gpu_preference_is_opt_in_and_round_trips_separately() {
        let settings: Settings = serde_json::from_str(r#"{"runtime":"external","python":"C:\\cpu\\python.exe"}"#).unwrap();
        assert!(!settings.gpu_runtime_enabled);
        let settings: Settings = serde_json::from_str(r#"{"gpu_runtime_enabled":true}"#).unwrap();
        assert!(settings.gpu_runtime_enabled);
    }
}
