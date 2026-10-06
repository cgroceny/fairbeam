// What is left of antenlab on this computer (`Legacy`). The old paths are built from the fixed
// identifier `LEGACY_ID`, never from this app's own identifier: the import must find antenlab's
// folders whatever Fairbeam is called.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// antenlab's bundle identifier (its data folders are named after it)
pub const LEGACY_ID: &str = "dev.antenlab.desktop";
/// antenlab's default workspace folder in Documents
pub const LEGACY_WORKSPACE: &str = "antenlab";
/// Fairbeam's default workspace folder in Documents
pub const NEW_WORKSPACE: &str = "Fairbeam";
/// the farewell version (0.6.9) leaves the viewer preferences here, in antenlab's config folder
pub const HANDOFF_FILE: &str = "fairbeam-handoff.json";

/// Every folder the importer reads or writes. Built from the AppHandle in the app and from temp
/// folders in tests.
#[derive(Debug, Clone)]
pub struct Roots {
    /// antenlab's settings folder (macOS ~/Library/Application Support/<id>, Windows %APPDATA%\<id>)
    pub old_config: PathBuf,
    /// antenlab's runtime and logs (the same folder on macOS, %LOCALAPPDATA%\<id> on Windows)
    pub old_local: PathBuf,
    pub documents: PathBuf,
    /// Fairbeam's settings folder
    pub new_config: PathBuf,
    pub home: PathBuf,
    /// the bundled folders that seed a new workspace
    pub seed: SeedDirs,
}

/// The bundled folders `seed::seed` copies into a new workspace: `projects` to `<ws>/projects`,
/// `models` to `<ws>/models`, `templates` to `<ws>/templates`.
#[derive(Debug, Clone, Default)]
pub struct SeedDirs {
    pub projects: PathBuf,
    pub models: PathBuf,
    pub templates: PathBuf,
}

impl SeedDirs {
    pub fn from_res(res: &crate::paths::Res) -> SeedDirs {
        SeedDirs { projects: res.projects.clone(), models: res.models.clone(), templates: res.templates.clone() }
    }

    /// the bundled folder for a top-level workspace folder name
    pub fn source_for(&self, top: &str) -> Option<&Path> {
        match top {
            "projects" => Some(&self.projects),
            "models" => Some(&self.models),
            "templates" => Some(&self.templates),
            _ => None,
        }
    }
}

impl Roots {
    pub fn from_app(app: &tauri::AppHandle) -> Option<Roots> {
        use tauri::Manager;
        let p = app.path();
        let new_config = p.app_config_dir().ok()?;
        let new_local = p.app_local_data_dir().ok()?;
        let home = crate::paths::home();
        Some(Roots {
            old_config: new_config.parent()?.join(LEGACY_ID),
            old_local: new_local.parent()?.join(LEGACY_ID),
            documents: p.document_dir().unwrap_or_else(|_| home.join("Documents")),
            new_config,
            home,
            seed: SeedDirs::from_res(&crate::paths::Res::locate(app)),
        })
    }

    pub fn old_settings(&self) -> PathBuf {
        self.old_config.join("settings.json")
    }

    pub fn handoff(&self) -> PathBuf {
        self.old_config.join(HANDOFF_FILE)
    }

    pub fn old_default_workspace(&self) -> PathBuf {
        self.documents.join(LEGACY_WORKSPACE)
    }

    pub fn new_default_workspace(&self) -> PathBuf {
        self.documents.join(NEW_WORKSPACE)
    }

    pub fn new_settings(&self) -> PathBuf {
        self.new_config.join("settings.json")
    }

    /// antenlab's own folders (settings, runtime, logs): an external Python inside them is not
    /// kept, since removal takes them away
    pub fn old_app_dirs(&self) -> Vec<PathBuf> {
        let mut v = vec![self.old_config.clone()];
        if self.old_local != self.old_config {
            v.push(self.old_local.clone());
        }
        v
    }

    /// antenlab's data folders and files that removal takes away (never the workspace).
    pub fn data_paths(&self, macos: bool) -> Vec<PathBuf> {
        let mut v = self.old_app_dirs();
        if macos {
            let lib = self.home.join("Library");
            v.extend([
                lib.join("Caches").join(LEGACY_ID),
                lib.join("Logs").join(LEGACY_ID),
                lib.join("WebKit").join(LEGACY_ID),
                lib.join("HTTPStorages").join(LEGACY_ID),
                lib.join("Saved Application State").join(format!("{LEGACY_ID}.savedState")),
                lib.join("Preferences").join(format!("{LEGACY_ID}.plist")),
            ]);
        }
        v
    }
}

/// What was found. Anything at all counts as antenlab being here.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Legacy {
    /// antenlab's settings.json
    pub settings: Option<PathBuf>,
    /// the 0.6.9 handoff with the viewer preferences
    pub handoff: Option<PathBuf>,
    /// data folders and files (see `Roots::data_paths`)
    pub data: Vec<PathBuf>,
    /// <Documents>/antenlab
    pub workspace: Option<PathBuf>,
    /// macOS: antenlab.app bundles that may go to the Trash
    pub bundles: Vec<PathBuf>,
    /// Windows: the install folder (holds antenlab.exe)
    pub install_dir: Option<PathBuf>,
    /// Windows: the uninstaller named by the UninstallString
    pub uninstaller: Option<PathBuf>,
}

impl Legacy {
    pub fn found(&self) -> bool {
        self.importable() || self.removable()
    }

    /// something to import: settings, preferences or the default workspace
    pub fn importable(&self) -> bool {
        self.settings.is_some() || self.handoff.is_some() || self.workspace.is_some()
    }

    /// something "Remove antenlab…" can take away
    pub fn removable(&self) -> bool {
        !self.data.is_empty() || !self.bundles.is_empty() || self.install_dir.is_some()
    }
}

/// The files part of the detection (the same on every OS; `macos` picks the data folder list).
pub fn detect_files(roots: &Roots, macos: bool) -> Legacy {
    let exists = |p: &Path| fs::symlink_metadata(p).is_ok();
    let mut data: Vec<PathBuf> = Vec::new();
    for p in roots.data_paths(macos) {
        if exists(&p) && !data.contains(&p) {
            data.push(p);
        }
    }
    Legacy {
        settings: Some(roots.old_settings()).filter(|p| p.is_file()),
        handoff: Some(roots.handoff()).filter(|p| p.is_file()),
        data,
        workspace: Some(roots.old_default_workspace()).filter(|p| p.is_dir()),
        ..Legacy::default()
    }
}

/// Everything antenlab left: files, plus the app itself (macOS bundles, Windows install).
/// `thorough` also asks Spotlight for bundles elsewhere (slower; not for building the menu).
pub fn detect(roots: &Roots, thorough: bool) -> Legacy {
    let mut legacy = detect_files(roots, cfg!(target_os = "macos"));
    #[cfg(target_os = "macos")]
    {
        legacy.bundles = super::remove_macos::find_bundles(roots, thorough);
    }
    #[cfg(windows)]
    {
        let _ = thorough;
        if let Some((dir, uninstaller)) = super::remove_windows::find_install(roots) {
            legacy.install_dir = Some(dir);
            legacy.uninstaller = uninstaller;
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = thorough;
    legacy
}

#[cfg(test)]
mod tests {
    use super::super::testutil::{roots_in, Temp};
    use super::*;

    #[test]
    fn nothing_found_in_an_empty_home() {
        let t = Temp::new("detect-empty");
        let roots = roots_in(t.path());
        let legacy = detect_files(&roots, true);
        assert_eq!(legacy, Legacy::default());
        assert!(!legacy.found());
    }

    #[test]
    fn finds_settings_handoff_workspace_and_data() {
        let t = Temp::new("detect-all");
        let roots = roots_in(t.path());
        fs::create_dir_all(&roots.old_config).unwrap();
        fs::write(roots.old_settings(), "{}").unwrap();
        fs::write(roots.handoff(), "{}").unwrap();
        fs::create_dir_all(roots.old_default_workspace()).unwrap();
        let caches = roots.home.join("Library/Caches").join(LEGACY_ID);
        fs::create_dir_all(&caches).unwrap();
        let plist = roots.home.join("Library/Preferences").join(format!("{LEGACY_ID}.plist"));
        fs::create_dir_all(plist.parent().unwrap()).unwrap();
        fs::write(&plist, "x").unwrap();

        let legacy = detect_files(&roots, true);
        assert_eq!(legacy.settings, Some(roots.old_settings()));
        assert_eq!(legacy.handoff, Some(roots.handoff()));
        assert_eq!(legacy.workspace, Some(roots.old_default_workspace()));
        assert_eq!(legacy.data, vec![roots.old_config.clone(), caches.clone(), plist.clone()]);
        assert!(legacy.found() && legacy.importable() && legacy.removable());
        // the macOS Library folders are not antenlab's on Windows
        assert_eq!(detect_files(&roots, false).data, vec![roots.old_config.clone()]);
        // Fairbeam's own folders are never in the list
        assert!(!roots.data_paths(true).iter().any(|p| p.starts_with(&roots.new_config)));
    }

    #[test]
    fn only_the_app_left_is_removable_but_not_importable() {
        let t = Temp::new("detect-local");
        let roots = roots_in(t.path());
        fs::create_dir_all(roots.old_local.join("runtime")).unwrap();
        let legacy = detect_files(&roots, false);
        assert!(legacy.found() && legacy.removable() && !legacy.importable());
    }
}
