// "Import from antenlab, then remove antenlab": Fairbeam is a separate app (its own identifier,
// data and workspace). On the first start it finds what antenlab left on this computer, asks once,
// and imports the settings, the workspace (<Documents>/antenlab becomes <Documents>/Fairbeam) and
// the Python models (`import antenlab` becomes `import fairbeam`, originals backed up). It then
// offers to remove antenlab: to the Trash on macOS, through antenlab's uninstaller on Windows.
// Help › "Remove antenlab…" offers the removal again while anything of antenlab is left.
//
// - Every step is idempotent: a start that finds `state: "started"` resumes without asking.
// - Each step is logged to shell.log as `import: …` (paths and counts only, never contents); the
//   full report goes to <config>/antenlab-import.json.
// - FAIRBEAM_NO_IMPORT=1 turns it off; FAIRBEAM_IMPORT_DRY_RUN=1 writes the plan to shell.log and
//   changes nothing of antenlab's, and nothing in the workspace. The only thing it writes is the
//   record `state: "dry-run"` in Fairbeam's own settings.json when that file did not exist, so
//   that the settings file the start creates does not look like Fairbeam being in use (the next
//   normal start still offers the import).
// - An app whose own identifier is antenlab's never imports or removes anything.

mod detect;
mod pyrewrite;
#[cfg(target_os = "macos")]
mod remove_macos;
mod remove_windows;
mod settings_map;
mod text;
mod workspace;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::paths::{load_settings, save_settings, Res, Settings};
use crate::shelllog;

use detect::{Legacy, Roots, LEGACY_ID};
use pyrewrite::PyReport;
use workspace::{JobsReport, WsPlan};

pub const NO_IMPORT_ENV: &str = "FAIRBEAM_NO_IMPORT";
pub const DRY_RUN_ENV: &str = "FAIRBEAM_IMPORT_DRY_RUN";
/// Help › Remove antenlab…
pub const MENU_ID: &str = "help-remove-antenlab";
const REPORT_FILE: &str = "antenlab-import.json";
/// <config>/imported: copies of antenlab's settings.json and handoff
const IMPORTED_DIR: &str = "imported";
/// <workspace>/.fairbeam-import-backup/<UTC yyyymmdd-hhmmss>: the originals of rewritten files
pub const BACKUP_DIR: &str = ".fairbeam-import-backup";

// ---- the record in settings.json and the report ----

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Step {
    pub step: String,
    pub ok: bool,
    pub detail: String,
}

impl Step {
    pub fn ok(step: &str, detail: impl Into<String>) -> Step {
        Step { step: step.into(), ok: true, detail: detail.into() }
    }

    pub fn failed(step: &str, detail: impl Into<String>) -> Step {
        Step { step: step.into(), ok: false, detail: detail.into() }
    }
}

/// `Settings::legacy_import`: "asked" | "started" | "done" | "declined" | "failed"
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Record {
    pub state: String,
    pub at: String,
    #[serde(default)]
    pub steps: Vec<Step>,
}

fn set_record(settings: &mut Settings, state: &str, at: &str, steps: &[Step]) {
    let record = Record { state: state.into(), at: at.into(), steps: steps.to_vec() };
    settings.legacy_import = serde_json::to_value(record).ok();
}

fn record_state(record: Option<&Value>) -> Option<&str> {
    record?.get("state")?.as_str()
}

/// <config>/antenlab-import.json
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Report {
    pub version: u32,
    pub state: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub resumed: bool,
    pub dry_run: bool,
    pub legacy: Legacy,
    /// setting names taken over / present but not taken over (never values)
    pub settings_imported: Vec<String>,
    pub settings_dropped: Vec<String>,
    pub workspace: Option<WsPlan>,
    /// the workspace Fairbeam uses after the import, when the import set one
    pub workspace_final: Option<PathBuf>,
    pub moved: bool,
    pub jobs: Option<JobsReport>,
    pub python: Option<PyReport>,
    pub backup: Option<PathBuf>,
    pub steps: Vec<Step>,
    #[serde(default)]
    pub removal: Vec<Step>,
}

impl Report {
    fn step(&mut self, host: &mut dyn Host, step: Step) {
        host.log(&format!("{} {}: {}", step.step, if step.ok { "ok" } else { "FAILED" }, step.detail));
        self.steps.push(step);
    }

    /// settings or the workspace failed: no removal is offered
    pub fn failed(&self) -> bool {
        self.steps.iter().any(|s| !s.ok && matches!(s.step.as_str(), "settings" | "workspace"))
    }
}

// ---- the decision ----

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Offer {
    Nothing(&'static str),
    /// ask, then import
    Import,
    /// an import was interrupted: continue without asking
    Resume,
    /// nothing to import, but antenlab is still installed: offer the removal once
    RemoveOnly,
}

pub fn decide(
    same_identifier: bool,
    debug: bool,
    opted_out: bool,
    fairbeam_settings_existed: bool,
    record: Option<&Value>,
    legacy: Option<&Legacy>,
) -> Offer {
    if same_identifier {
        return Offer::Nothing("same identifier");
    }
    if debug {
        return Offer::Nothing("debug build");
    }
    if opted_out {
        return Offer::Nothing("opted out");
    }
    let Some(legacy) = legacy.filter(|l| l.found()) else {
        return Offer::Nothing("no antenlab");
    };
    match record_state(record) {
        Some("started") => Offer::Resume,
        // asked, but the app quit before an answer
        Some("asked") => Offer::Import,
        // a dry run made Fairbeam's settings.json: that does not count as Fairbeam being in use
        Some("dry-run") if !legacy.importable() => Offer::RemoveOnly,
        Some("dry-run") => Offer::Import,
        Some(_) => Offer::Nothing("imported before"),
        None if fairbeam_settings_existed => Offer::Nothing("Fairbeam in use"),
        None if !legacy.importable() => Offer::RemoveOnly,
        None => Offer::Import,
    }
}

// ---- the import (steps 1–5), without an AppHandle so tests run it on temp folders ----

pub enum Ask<'a> {
    /// antenlab is open: Try again (true) / Later
    Running,
    /// the workspace rename failed: Try again (true) / keep the old folder
    MoveFailed { old: &'a Path, new: &'a Path, error: &'a str },
}

pub trait Host {
    fn save(&mut self, s: &Settings) -> Result<(), String>;
    fn ask(&mut self, q: Ask) -> bool;
    fn antenlab_running(&mut self) -> bool;
    /// one shell.log line (the host adds the `import:` prefix)
    fn log(&mut self, line: &str);
}

/// UTC time: `iso` for records, `compact` for folder names.
#[derive(Clone, Debug)]
pub struct Stamp {
    pub iso: String,
    pub compact: String,
}

impl Stamp {
    pub fn now() -> Stamp {
        Stamp::at(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
    }

    pub fn at(secs: u64) -> Stamp {
        let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
        // days since 1970 to a civil date (H. Hinnant's algorithm)
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = yoe + era * 400 + i64::from(m <= 2);
        let (h, mi, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
        Stamp {
            iso: format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z"),
            compact: format!("{y:04}{m:02}{d:02}-{h:02}{mi:02}{s:02}"),
        }
    }
}

pub enum Outcome {
    /// antenlab is open and the user chose Later: asked again on the next start
    Postponed,
    Finished(Report),
}

/// Run the import. `default_ws` is the workspace Fairbeam uses when none is set: a move there
/// leaves the setting unset. With `dry_run` nothing is written and nobody is asked.
#[allow(clippy::too_many_arguments)]
pub fn run(
    roots: &Roots,
    legacy: &Legacy,
    settings: &mut Settings,
    default_ws: &Path,
    resumed: bool,
    dry_run: bool,
    now: &Stamp,
    host: &mut dyn Host,
) -> Outcome {
    let mut report = Report {
        version: 1,
        state: "started".into(),
        started_at: now.iso.clone(),
        resumed,
        dry_run,
        legacy: legacy.clone(),
        ..Report::default()
    };
    let save = |settings: &Settings, host: &mut dyn Host| {
        if !dry_run {
            if let Err(e) = host.save(settings) {
                host.log(&format!("settings not saved: {e}"));
            }
        }
    };

    // 1. preflight: antenlab must not run while its folders move
    while host.antenlab_running() {
        if dry_run {
            report.step(host, Step::failed("preflight", "antenlab is running"));
            break;
        }
        if !host.ask(Ask::Running) {
            host.log("antenlab is open; asked again on the next start");
            set_record(settings, "started", &now.iso, &[Step::failed("preflight", "antenlab was open")]);
            save(settings, host);
            return Outcome::Postponed;
        }
    }
    if !dry_run {
        let dir = roots.new_config.join(IMPORTED_DIR);
        for file in [&legacy.settings, &legacy.handoff].into_iter().flatten() {
            let copied = fs::create_dir_all(&dir).and_then(|()| fs::copy(file, dir.join(file.file_name().unwrap_or_default())));
            match copied {
                Ok(_) => report.step(host, Step::ok("preflight", format!("copied {} to {}", file.display(), dir.display()))),
                Err(e) => report.step(host, Step::failed("preflight", format!("{}: {e}", file.display()))),
            }
        }
    }
    set_record(settings, "started", &now.iso, &report.steps);
    save(settings, host);

    // 2. settings
    let old = match &legacy.settings {
        None => Some(Value::Null),
        Some(p) => settings_map::read_json(p),
    };
    let handoff = legacy.handoff.as_deref().and_then(settings_map::read_json);
    match &old {
        None => report.step(host, Step::failed("settings", "antenlab's settings.json could not be read")),
        Some(old) => {
            let mapped = settings_map::map(old, handoff.as_ref(), &roots.old_app_dirs());
            if !dry_run {
                mapped.apply(settings);
            }
            report.settings_imported = mapped.imported().into_iter().map(String::from).collect();
            report.settings_dropped = mapped.dropped.clone();
            let detail = format!(
                "imported [{}], not imported [{}]{}",
                report.settings_imported.join(", "),
                report.settings_dropped.join(", "),
                if handoff.is_some() { "" } else { "; no handoff from antenlab 0.6.9 (appearance not imported)" }
            );
            report.step(host, Step::ok("settings", detail));
        }
    }
    save(settings, host);

    // 3. workspace
    let old_ws = old.as_ref().and_then(|v| v.get("workspace")).and_then(Value::as_str);
    let plan = workspace::plan(old_ws, roots, resumed);
    report.workspace = Some(plan.clone());
    let mut ws_final: Option<PathBuf> = None;
    match &plan {
        WsPlan::Move { from, to } | WsPlan::Moved { from, to } => {
            // the forms of the old path, read before the folder is gone
            let olds = old_forms(from);
            let mut moved = matches!(plan, WsPlan::Moved { .. });
            while !moved && !dry_run {
                match workspace::move_workspace(from, to, &roots.seed) {
                    Ok(()) => moved = true,
                    Err(e) => {
                        let error = e.to_string();
                        host.log(&format!("could not rename {} to {}: {error}", from.display(), to.display()));
                        if !host.ask(Ask::MoveFailed { old: from, new: to, error: &error }) {
                            break;
                        }
                    }
                }
            }
            if moved || dry_run {
                report.moved = true;
                ws_final = Some(to.clone());
                if !dry_run {
                    settings.workspace = (!same_place(to, default_ws)).then(|| to.to_string_lossy().into_owned());
                }
                report.step(host, Step::ok("workspace", format!("{} → {}", from.display(), to.display())));
                let backup = to.join(BACKUP_DIR).join(&now.compact);
                // a dry run reads the jobs where they still are
                let jobs_root = if dry_run && from.is_dir() { from } else { to };
                let jobs = workspace::rewrite_jobs(jobs_root, &olds, to, &backup, dry_run);
                let step = if jobs.errors.is_empty() { Step::ok } else { Step::failed };
                report.step(
                    host,
                    step("jobs", format!("{} job.json files, {} rewritten, {} errors", jobs.files, jobs.changed, jobs.errors.len())),
                );
                if jobs.changed > 0 {
                    report.backup = Some(to.join(BACKUP_DIR).join(&now.compact));
                }
                report.jobs = Some(jobs);
            } else {
                // the user chose to keep the old folder
                settings.workspace = Some(from.to_string_lossy().into_owned());
                ws_final = Some(from.clone());
                report.step(host, Step::ok("workspace", format!("kept at {} (the rename failed)", from.display())));
            }
        }
        WsPlan::Keep { path, reason } => {
            if !dry_run {
                settings.workspace = Some(path.to_string_lossy().into_owned());
            }
            ws_final = Some(path.clone());
            report.step(host, Step::ok("workspace", format!("kept at {} ({reason})", path.display())));
        }
        WsPlan::Checkout { path } => {
            report.step(host, Step::ok("workspace", format!("{} is a repository checkout; not touched", path.display())))
        }
        WsPlan::Nothing { reason } => report.step(host, Step::ok("workspace", format!("nothing to take over ({reason})"))),
    }
    report.workspace_final = ws_final.clone();
    save(settings, host);

    // 4. Python models
    if let Some(ws) = &ws_final {
        // a dry run of a move looks at the folder that is still there
        let look_at = if dry_run && !ws.exists() { plan_source(&plan).unwrap_or(ws) } else { ws };
        let backup = ws.join(BACKUP_DIR).join(&now.compact);
        let py = pyrewrite::rewrite_workspace(look_at, &backup, dry_run);
        let step = if py.errors.is_empty() { Step::ok } else { Step::failed };
        report.step(
            host,
            step(
                "python",
                format!(
                    "{} .py files, {} rewritten, {} skipped, {} errors{}",
                    py.scanned,
                    py.changed.len(),
                    py.skipped.len(),
                    py.errors.len(),
                    if py.changed.is_empty() { String::new() } else { format!("; originals in {}", backup.display()) }
                ),
            ),
        );
        if !py.changed.is_empty() {
            report.backup = Some(backup);
        }
        report.python = Some(py);
    }

    // 5. done
    report.state = if report.failed() { "failed".into() } else { "done".into() };
    report.finished_at = Some(Stamp::now().iso);
    set_record(settings, &report.state, &now.iso, &report.steps);
    save(settings, host);
    if !dry_run {
        if let Err(e) = write_report(&roots.new_config, &report) {
            host.log(&format!("report not written: {e}"));
        }
    }
    host.log(&format!("finished: {}", report.state));
    Outcome::Finished(report)
}

fn plan_source(plan: &WsPlan) -> Option<&PathBuf> {
    match plan {
        WsPlan::Move { from, .. } => Some(from),
        _ => None,
    }
}

/// The old workspace as written, canonical, and with only its parent resolved (works after the
/// folder has moved away).
fn old_forms(old: &Path) -> Vec<String> {
    let mut v = workspace::old_forms(old);
    if let (Some(parent), Some(name)) = (old.parent(), old.file_name()) {
        if let Ok(p) = fs::canonicalize(parent) {
            let s = crate::paths::canonical(&p).join(name).to_string_lossy().into_owned();
            if !v.contains(&s) {
                v.push(s);
            }
        }
    }
    v
}

fn same_place(a: &Path, b: &Path) -> bool {
    crate::paths::canonical(a) == crate::paths::canonical(b)
}

fn write_report(dir: &Path, report: &Report) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(report).map_err(|e| e.to_string())?;
    workspace::write_replace(&dir.join(REPORT_FILE), &bytes).map_err(|e| e.to_string())
}

fn read_report(dir: &Path) -> Option<Report> {
    serde_json::from_str(&fs::read_to_string(dir.join(REPORT_FILE)).ok()?).ok()
}

// ---- texts built from the plan and the report ----

/// `~/…` for paths in the home folder (not on Windows, where the full path is familiar).
fn pretty(p: &Path, home: &Path) -> String {
    if cfg!(not(windows)) {
        if let Ok(rest) = p.strip_prefix(home) {
            return format!("~/{}", rest.display());
        }
    }
    p.display().to_string()
}

pub fn import_message(lang: &str, plan: &WsPlan, appearance: bool, home: &Path) -> String {
    let appearance_item = if appearance { text::text(lang, "appearance-item") } else { String::new() };
    let mut lines = vec![text::text(lang, "import-intro"), text::fill(lang, "import-settings", &[("appearance", &appearance_item)])];
    match plan {
        WsPlan::Move { from, to } | WsPlan::Moved { from, to } => lines.push(text::fill(
            lang,
            "import-workspace-move",
            &[("old", &pretty(from, home)), ("new", &pretty(to, home))],
        )),
        WsPlan::Keep { path, .. } => lines.push(text::fill(lang, "import-workspace-keep", &[("path", &pretty(path, home))])),
        WsPlan::Checkout { .. } | WsPlan::Nothing { .. } => {}
    }
    if let Some(ws) = plan.target() {
        lines.push(text::fill(lang, "import-python", &[("backup", &pretty(&ws.join(BACKUP_DIR), home))]));
    }
    lines.push(String::new());
    lines.push(text::text(lang, if appearance { "import-not" } else { "import-not-appearance" }));
    lines.join("\n")
}

pub fn summary(lang: &str, report: &Report, home: &Path) -> String {
    let mut parts = Vec::new();
    if !report.settings_imported.is_empty() {
        parts.push(text::text(lang, "summary-settings"));
    }
    if let Some(ws) = &report.workspace_final {
        let key = if report.moved { "summary-moved" } else { "summary-kept" };
        parts.push(text::fill(lang, key, &[("path", &pretty(ws, home))]));
    }
    if let Some(py) = report.python.as_ref().filter(|p| !p.changed.is_empty()) {
        parts.push(text::fill(lang, "summary-python", &[("n", &py.changed.len().to_string())]));
    }
    if parts.is_empty() {
        "–".into()
    } else {
        parts.join(", ")
    }
}

fn failed_list(lang: &str, steps: &[Step]) -> String {
    let mut names: Vec<String> = Vec::new();
    for s in steps.iter().filter(|s| !s.ok) {
        let key = match s.step.as_str() {
            "preflight" => "step-preflight",
            "settings" => "step-settings",
            "workspace" | "jobs" => "step-workspace",
            "python" => "step-python",
            _ => continue,
        };
        let name = text::text(lang, key);
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names.join(", ")
}

pub fn dir_size(p: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(p) else { return 0 };
    if !meta.is_dir() {
        return meta.len();
    }
    fs::read_dir(p).map(|entries| entries.flatten().map(|e| dir_size(&e.path())).sum()).unwrap_or(0)
}

pub fn format_size(bytes: u64, lang: &str) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    let b = bytes as f64;
    let s = if b >= 1024.0 * MB {
        format!("{:.1} GB", b / (1024.0 * MB))
    } else if b >= MB {
        format!("{:.0} MB", b / MB)
    } else {
        format!("{:.0} KB", (b / 1024.0).ceil())
    };
    if lang == "tr" {
        s.replace('.', ",")
    } else {
        s
    }
}

// ---- the app side: dialogs, settings, shell.log, the menu ----

fn env_on(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|v| !v.is_empty() && v != "0")
}

fn same_identifier(app: &AppHandle) -> bool {
    app.config().identifier == LEGACY_ID
}

fn ask_dialog(app: &AppHandle, title: &str, message: &str, yes: String, no: String) -> bool {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(yes, no))
        .blocking_show()
}

fn tell(app: &AppHandle, title: &str, message: &str, warning: bool) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(if warning { MessageDialogKind::Warning } else { MessageDialogKind::Info })
        .buttons(MessageDialogButtons::Ok)
        .blocking_show();
}

fn log(app: &AppHandle, line: &str) {
    shelllog::write(app, &format!("import: {line}"));
}

fn os_antenlab_running() -> bool {
    #[cfg(target_os = "macos")]
    {
        remove_macos::antenlab_running()
    }
    #[cfg(windows)]
    {
        remove_windows::antenlab_running()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        false
    }
}

struct AppHost<'a> {
    app: &'a AppHandle,
    lang: &'static str,
}

impl Host for AppHost<'_> {
    fn save(&mut self, s: &Settings) -> Result<(), String> {
        save_settings(self.app, s)
    }

    fn ask(&mut self, q: Ask) -> bool {
        let tx = |key: &str| text::text(self.lang, key);
        match q {
            Ask::Running => ask_dialog(self.app, &tx("import-title"), &tx("running-message"), tx("running-yes"), tx("running-no")),
            Ask::MoveFailed { old, new, error } => {
                let home = crate::paths::home();
                let message = text::fill(
                    self.lang,
                    "move-failed-message",
                    &[("old", &pretty(old, &home)), ("new", &pretty(new, &home)), ("error", error)],
                );
                ask_dialog(self.app, &tx("import-title"), &message, tx("move-yes"), tx("move-no"))
            }
        }
    }

    fn antenlab_running(&mut self) -> bool {
        os_antenlab_running()
    }

    fn log(&mut self, line: &str) {
        log(self.app, line);
    }
}

/// At the top of the start thread, before the settings are read and the workspace is seeded (the
/// workspace must move before the seed step creates <Documents>/Fairbeam). Once per process.
/// `splash` shows a status line on the splash page.
pub fn on_start(app: &AppHandle, splash: &dyn Fn(&str)) {
    // held for the whole import: a second start thread (Retry) waits for it, then skips it
    static RAN: Mutex<bool> = Mutex::new(false);
    let mut ran = RAN.lock().unwrap_or_else(|e| e.into_inner());
    if std::mem::replace(&mut *ran, true) {
        return;
    }
    let same_id = same_identifier(app);
    let dry_run = env_on(DRY_RUN_ENV);
    let Some(roots) = (!same_id).then(|| Roots::from_app(app)).flatten() else { return };
    let existed = roots.new_settings().is_file();
    let mut settings = load_settings(app);
    let legacy = detect::detect(&roots, false);
    let offer = decide(
        same_id,
        cfg!(debug_assertions) && !dry_run,
        env_on(NO_IMPORT_ENV),
        existed,
        settings.legacy_import.as_ref(),
        Some(&legacy),
    );
    if let Offer::Nothing(reason) = offer {
        if legacy.found() && matches!(reason, "opted out" | "debug build") {
            log(app, &format!("skipped ({reason})"));
        }
        if !dry_run {
            return;
        }
    }

    let old = legacy.settings.as_deref().and_then(settings_map::read_json).unwrap_or(Value::Null);
    let lang = text::lang(old.get("language").and_then(Value::as_str).or(settings.language.as_deref()));
    let default_ws = crate::paths::workspace(app, &Settings::default(), &Res::locate(app)).root;
    let now = Stamp::now();
    let mut host = AppHost { app, lang };

    if dry_run {
        let mut scratch = settings.clone();
        let resumed = offer == Offer::Resume;
        let plan = match run(&roots, &legacy, &mut scratch, &default_ws, resumed, true, &now, &mut host) {
            Outcome::Finished(report) => serde_json::to_string(&report).unwrap_or_default(),
            Outcome::Postponed => String::new(),
        };
        // Fairbeam's settings.json is created by this start anyway: mark it, so the next normal
        // start does not take it for Fairbeam being in use
        let marked = legacy.found() && !existed && settings.legacy_import.is_none();
        if marked {
            set_record(&mut settings, "dry-run", &now.iso, &[]);
            let _ = save_settings(app, &settings);
        }
        log(
            app,
            &format!(
                "dry run ({DRY_RUN_ENV}=1), antenlab's files and the workspace are untouched{}; decision {offer:?}; plan {plan}",
                if marked { "; Fairbeam's own settings.json got the record state \"dry-run\" (it does not count as use)" } else { "" }
            ),
        );
        let thorough = detect::detect(&roots, true);
        log(
            app,
            &format!(
                "dry run: removal would take {:?} {:?} {:?} ({})",
                thorough.bundles,
                thorough.install_dir,
                thorough.data,
                format_size(removal_size(&thorough), "en")
            ),
        );
        return;
    }

    match offer {
        Offer::Import => {
            set_record(&mut settings, "asked", &now.iso, &[]);
            let _ = save_settings(app, &settings);
            let plan = workspace::plan(old.get("workspace").and_then(Value::as_str), &roots, false);
            let message = import_message(lang, &plan, legacy.handoff.is_some(), &roots.home);
            let tx = |key: &str| text::text(lang, key);
            if !ask_dialog(app, &tx("import-title"), &message, tx("import-yes"), tx("import-no")) {
                set_record(&mut settings, "declined", &now.iso, &[]);
                let _ = save_settings(app, &settings);
                log(app, "declined (Start fresh)");
                refresh_menu(app);
                return;
            }
        }
        Offer::Resume => log(app, "resuming an interrupted import"),
        Offer::RemoveOnly => {
            set_record(&mut settings, "done", &now.iso, &[Step::ok("settings", "nothing to import")]);
            let _ = save_settings(app, &settings);
            log(app, "nothing to import; antenlab is still installed");
            offer_removal(app, &roots, lang, None);
            return;
        }
        Offer::Nothing(_) => return,
    }

    splash(&text::text(lang, "importing"));
    let report = match run(&roots, &legacy, &mut settings, &default_ws, offer == Offer::Resume, false, &now, &mut host) {
        Outcome::Postponed => return,
        Outcome::Finished(report) => report,
    };
    // the language and the recent designs may have changed
    refresh_menu(app);
    if report.failed() {
        let message = text::fill(lang, "failed-message", &[("list", &failed_list(lang, &report.steps))]);
        tell(app, &text::text(lang, "import-title"), &message, true);
        return;
    }
    offer_removal(app, &roots, lang, Some(summary(lang, &report, &roots.home)));
}

fn removal_size(legacy: &Legacy) -> u64 {
    legacy.bundles.iter().chain(&legacy.data).chain(&legacy.install_dir).map(|p| dir_size(p)).sum()
}

/// Ask whether to remove antenlab, then remove it. `summary`: after an import ("Import finished:
/// …"); `None` from the Help menu.
fn offer_removal(app: &AppHandle, roots: &Roots, lang: &'static str, summary: Option<String>) {
    static BUSY: AtomicBool = AtomicBool::new(false);
    if !cfg!(any(target_os = "macos", windows)) || same_identifier(app) || BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    remove_flow(app, roots, lang, summary);
    BUSY.store(false, Ordering::SeqCst);
}

fn remove_flow(app: &AppHandle, roots: &Roots, lang: &'static str, summary: Option<String>) {
    let tx = |key: &str| text::text(lang, key);
    let title = tx("remove-title");
    let legacy = detect::detect(roots, true);
    if !legacy.removable() {
        if summary.is_none() {
            tell(app, &title, &tx("remove-none"), false);
        }
        refresh_menu(app);
        return;
    }
    let os = if cfg!(windows) { "windows" } else { "macos" };
    let question = text::fill(lang, &format!("remove-message-{os}"), &[("size", &format_size(removal_size(&legacy), lang))]);
    let message = match &summary {
        Some(s) => format!("{}\n\n{question}", text::fill(lang, "remove-intro", &[("summary", s)])),
        None => question,
    };
    if !ask_dialog(app, &title, &message, tx("remove-yes"), tx("remove-no")) {
        log(app, "removal: kept for now");
        return;
    }
    while os_antenlab_running() {
        if !ask_dialog(app, &title, &tx("running-message"), tx("running-yes"), tx("running-no")) {
            log(app, "removal: antenlab is open; not removed");
            return;
        }
    }
    let steps = remove_now(app, roots, &legacy);
    for s in &steps {
        log(app, &format!("removal {} {}: {}", s.step, if s.ok { "ok" } else { "FAILED" }, s.detail));
    }
    if let Some(mut report) = read_report(&roots.new_config) {
        report.removal.extend(steps.iter().cloned());
        let _ = write_report(&roots.new_config, &report);
    }
    refresh_menu(app);
    let failed: Vec<&str> = steps.iter().filter(|s| !s.ok).map(|s| s.detail.as_str()).collect();
    if failed.is_empty() {
        tell(app, &title, &tx(&format!("remove-done-{os}")), false);
    } else {
        tell(app, &title, &text::fill(lang, "remove-failed", &[("list", &failed.join("; "))]), true);
    }
}

#[allow(unused_variables)]
fn remove_now(app: &AppHandle, roots: &Roots, legacy: &Legacy) -> Vec<Step> {
    #[cfg(target_os = "macos")]
    {
        remove_macos::remove(legacy)
    }
    #[cfg(windows)]
    {
        use tauri::Manager;
        let desktop = app.path().desktop_dir().ok();
        remove_windows::remove(roots, legacy, desktop.as_deref())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Vec::new()
    }
}

// ---- Help › Remove antenlab… ----

/// whether the menu item shows; detected once, again after a removal
static MENU_VISIBLE: Mutex<Option<bool>> = Mutex::new(None);

/// The Help menu entry (id, label) while anything of antenlab is left to remove.
pub fn menu_entry(app: &AppHandle, lang: &str) -> Option<(&'static str, String)> {
    if same_identifier(app) || !cfg!(any(target_os = "macos", windows)) {
        return None;
    }
    let mut cached = MENU_VISIBLE.lock().unwrap();
    let visible = *cached.get_or_insert_with(|| Roots::from_app(app).is_some_and(|r| detect::detect(&r, false).removable()));
    visible.then(|| (MENU_ID, text::text(lang, "menu-remove")))
}

fn refresh_menu(app: &AppHandle) {
    *MENU_VISIBLE.lock().unwrap() = None;
    if let Ok(menu) = crate::app_menu(app) {
        let _ = app.set_menu(menu);
    }
}

/// Help › Remove antenlab… (on its own thread: the dialogs wait for answers).
pub fn on_menu(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let lang = text::lang(load_settings(&app).language.as_deref());
        if let Some(roots) = Roots::from_app(&app) {
            offer_removal(&app, &roots, lang, None);
        }
    });
}

/// The viewer preferences imported from antenlab 0.6.9 (`fairbeam.*` localStorage keys and their
/// values), once: the first call returns them and clears them.
#[tauri::command]
pub fn take_imported_viewer_prefs(app: AppHandle) -> Option<Value> {
    let mut s = load_settings(&app);
    let prefs = s.imported_viewer_prefs.take()?;
    if let Err(e) = save_settings(&app, &s) {
        log(&app, &format!("viewer preferences not cleared: {e}"));
    }
    Some(prefs)
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::detect::{Roots, SeedDirs, LEGACY_ID};

    /// A temp folder removed on drop (the crate's tempfile dependency is macOS-only).
    pub struct Temp(PathBuf);

    impl Temp {
        pub fn new(name: &str) -> Temp {
            static N: AtomicUsize = AtomicUsize::new(0);
            let n = N.fetch_add(1, Ordering::SeqCst);
            let p = std::env::temp_dir().join(format!("fairbeam-import-{name}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Temp(crate::paths::canonical(&p))
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Roots inside `dir`: the old settings and runtime in separate folders (as on Windows).
    pub fn roots_in(dir: &Path) -> Roots {
        Roots {
            old_config: dir.join("Roaming").join(LEGACY_ID),
            old_local: dir.join("Local").join(LEGACY_ID),
            documents: dir.join("home").join("Documents"),
            new_config: dir.join("Roaming").join("org.fairbeam.desktop"),
            home: dir.join("home"),
            seed: SeedDirs {
                projects: dir.join("res").join("projects"),
                models: dir.join("res").join("models"),
                templates: dir.join("res").join("templates"),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::{roots_in, Temp};
    use super::*;
    use serde_json::json;

    fn legacy_with_settings() -> Legacy {
        Legacy { settings: Some(PathBuf::from("/x/settings.json")), ..Legacy::default() }
    }

    #[test]
    fn decide_table() {
        let l = legacy_with_settings();
        let app_only = Legacy { data: vec![PathBuf::from("/x")], ..Legacy::default() };
        let started = json!({"state": "started"});
        let asked = json!({"state": "asked"});
        let done = json!({"state": "done"});
        let declined = json!({"state": "declined"});
        let failed = json!({"state": "failed"});
        let dry = json!({"state": "dry-run"});
        let none: Option<&Legacy> = None;
        let empty = Legacy::default();
        // (same id, debug, opted out, settings existed, record, legacy) → offer
        let rows: Vec<(bool, bool, bool, bool, Option<&Value>, Option<&Legacy>, Offer)> = vec![
            (true, false, false, false, None, Some(&l), Offer::Nothing("same identifier")),
            (false, true, false, false, None, Some(&l), Offer::Nothing("debug build")),
            (false, false, true, false, None, Some(&l), Offer::Nothing("opted out")),
            (false, false, false, false, None, none, Offer::Nothing("no antenlab")),
            (false, false, false, false, None, Some(&empty), Offer::Nothing("no antenlab")),
            (false, false, false, false, Some(&started), Some(&l), Offer::Resume),
            (false, false, false, true, Some(&started), Some(&l), Offer::Resume),
            (false, false, false, true, Some(&asked), Some(&l), Offer::Import),
            (false, false, false, false, Some(&done), Some(&l), Offer::Nothing("imported before")),
            (false, false, false, false, Some(&declined), Some(&l), Offer::Nothing("imported before")),
            (false, false, false, false, Some(&failed), Some(&l), Offer::Nothing("imported before")),
            (false, false, false, true, None, Some(&l), Offer::Nothing("Fairbeam in use")),
            (false, false, false, false, None, Some(&l), Offer::Import),
            (false, false, false, false, None, Some(&app_only), Offer::RemoveOnly),
            // a dry run left its mark: Fairbeam's settings do not count as use
            (false, false, false, true, Some(&dry), Some(&l), Offer::Import),
            (false, false, false, false, Some(&dry), Some(&l), Offer::Import),
            (false, false, false, true, Some(&dry), Some(&app_only), Offer::RemoveOnly),
            (false, false, false, true, Some(&dry), none, Offer::Nothing("no antenlab")),
            (false, false, false, true, Some(&dry), Some(&empty), Offer::Nothing("no antenlab")),
            (false, true, false, true, Some(&dry), Some(&l), Offer::Nothing("debug build")),
            (false, false, true, true, Some(&dry), Some(&l), Offer::Nothing("opted out")),
        ];
        for (i, (same, debug, out, existed, record, legacy, want)) in rows.into_iter().enumerate() {
            assert_eq!(decide(same, debug, out, existed, record, legacy), want, "row {i}");
        }
    }

    #[derive(Default)]
    struct FakeHost {
        running: usize,
        answers: Vec<bool>,
        asked: Vec<String>,
        saved: Vec<Settings>,
        lines: Vec<String>,
    }

    impl Host for FakeHost {
        fn save(&mut self, s: &Settings) -> Result<(), String> {
            self.saved.push(s.clone());
            Ok(())
        }
        fn ask(&mut self, q: Ask) -> bool {
            self.asked.push(match q {
                Ask::Running => "running".into(),
                Ask::MoveFailed { error, .. } => format!("move: {error}"),
            });
            if self.answers.is_empty() {
                true
            } else {
                self.answers.remove(0)
            }
        }
        fn antenlab_running(&mut self) -> bool {
            if self.running > 0 {
                self.running -= 1;
                true
            } else {
                false
            }
        }
        fn log(&mut self, line: &str) {
            self.lines.push(line.to_string());
        }
    }

    /// antenlab 0.6.x as it is left on disk: settings, handoff, runtime, the default workspace
    /// with a job and two models.
    fn fake_antenlab(roots: &Roots) -> String {
        fs::create_dir_all(&roots.old_config).unwrap();
        fs::create_dir_all(roots.old_local.join("runtime")).unwrap();
        fs::write(
            roots.old_settings(),
            json!({"language": "tr", "check_updates_on_start": false, "prefer_gpu": false,
                   "recent_designs": ["patch_24"], "server_port": 5321, "runtime": "managed"})
            .to_string(),
        )
        .unwrap();
        fs::write(roots.handoff(), json!({"local_storage": {"antenlab.theme": "dark"}}).to_string()).unwrap();
        let ws = roots.old_default_workspace();
        let old = ws.to_string_lossy().into_owned();
        fs::create_dir_all(ws.join("models")).unwrap();
        fs::create_dir_all(ws.join("jobs/j1")).unwrap();
        fs::create_dir_all(ws.join(".sim/patch")).unwrap();
        fs::write(ws.join("models/patch.py"), "from antenlab import Param\nimport antenlab.mesh as m\n").unwrap();
        fs::write(ws.join("models/plain.py"), "x = 1\n").unwrap();
        fs::write(
            ws.join("jobs/j1/job.json"),
            json!({"model_path": format!("{old}/models/patch.py"), "sim_dir": format!("{old}/.sim/patch")}).to_string(),
        )
        .unwrap();
        old
    }

    fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    out.push((p.clone(), Vec::new()));
                    stack.push(p);
                } else {
                    out.push((p.clone(), fs::read(&p).unwrap()));
                }
            }
        }
        out.sort();
        out
    }

    #[test]
    fn full_import_on_temp_folders() {
        let t = Temp::new("run-full");
        let roots = roots_in(t.path());
        let old = fake_antenlab(&roots);
        let legacy = detect::detect_files(&roots, false);
        assert_eq!(decide(false, false, false, false, None, Some(&legacy)), Offer::Import);

        let mut settings = Settings::default();
        let mut host = FakeHost::default();
        let now = Stamp::at(1_790_000_000);
        let Outcome::Finished(report) =
            run(&roots, &legacy, &mut settings, &roots.new_default_workspace(), false, false, &now, &mut host)
        else {
            panic!("postponed")
        };
        assert_eq!(report.state, "done", "{:?}", report.steps);
        assert!(!report.failed());

        // settings
        assert_eq!(settings.language.as_deref(), Some("tr"));
        assert!(!settings.check_updates_on_start && !settings.prefer_gpu);
        assert_eq!(settings.recent_designs, vec!["patch_24"]);
        assert_eq!(settings.server_port, None);
        assert_eq!(settings.runtime, None, "a fresh runtime is installed");
        assert_eq!(
            settings.imported_viewer_prefs,
            Some(json!({"fairbeam.theme": "dark", "fairbeam.generalSettings": "{\"language\":\"tr\"}"}))
        );
        // the default workspace moved, and the setting stays unset
        let new = roots.new_default_workspace();
        assert!(!roots.old_default_workspace().exists());
        assert!(new.join(".sim/patch").is_dir());
        assert_eq!(settings.workspace, None);
        assert!(report.moved);
        let job: Value = serde_json::from_str(&fs::read_to_string(new.join("jobs/j1/job.json")).unwrap()).unwrap();
        assert_eq!(job["model_path"], format!("{}/models/patch.py", new.display()));
        assert_eq!(job["sim_dir"], format!("{}/.sim/patch", new.display()));
        // the models, with their backup
        assert_eq!(
            fs::read_to_string(new.join("models/patch.py")).unwrap(),
            "from fairbeam import Param\nimport fairbeam.mesh as m\n"
        );
        let backup = new.join(BACKUP_DIR).join(&now.compact);
        assert_eq!(report.backup.as_ref(), Some(&backup));
        assert!(fs::read_to_string(backup.join("models/patch.py")).unwrap().starts_with("from antenlab import"));
        // the backup keeps the old paths (compared parsed: JSON escapes the backslashes of Windows paths)
        let backed: Value = serde_json::from_str(&fs::read_to_string(backup.join("jobs/j1/job.json")).unwrap()).unwrap();
        assert_eq!(backed["model_path"], format!("{old}/models/patch.py"));
        // copies of antenlab's files, the record and the report
        assert!(roots.new_config.join("imported/settings.json").is_file());
        assert!(roots.new_config.join("imported").join(detect::HANDOFF_FILE).is_file());
        assert_eq!(record_state(settings.legacy_import.as_ref()), Some("done"));
        assert_eq!(record_state(host.saved.first().unwrap().legacy_import.as_ref()), Some("started"));
        let on_disk = read_report(&roots.new_config).unwrap();
        assert_eq!(on_disk, report);
        // antenlab's own folders are not touched by the import
        assert!(roots.old_settings().is_file() && roots.old_local.join("runtime").is_dir());
        // shell.log lines name steps and counts, never file contents
        assert!(host.lines.iter().any(|l| l.starts_with("python ok: 2 .py files, 1 rewritten")), "{:?}", host.lines);
        assert!(!host.lines.iter().any(|l| l.contains("Param") || l.contains("dark")));
        assert_eq!(
            summary("en", &report, &roots.home),
            format!("settings, workspace moved to {}, 1 Python files updated", pretty(&new, &roots.home))
        );
        if cfg!(not(windows)) {
            assert_eq!(pretty(&new, &roots.home), "~/Documents/Fairbeam");
        }

        // a second run (a resume after a crash at the very end) is a no-op on the files
        let before = snapshot(&new);
        let legacy = detect::detect_files(&roots, false);
        let Outcome::Finished(again) =
            run(&roots, &legacy, &mut settings, &roots.new_default_workspace(), true, false, &Stamp::at(1_790_000_100), &mut host)
        else {
            panic!("postponed")
        };
        assert_eq!(again.state, "done");
        assert!(matches!(again.workspace, Some(WsPlan::Moved { .. })));
        assert_eq!(again.python.unwrap().changed.len(), 0);
        let mut after = snapshot(&new);
        after.retain(|(p, _)| !p.ends_with(REPORT_FILE));
        assert_eq!(before, after);
    }

    #[test]
    fn later_while_antenlab_runs_postpones_and_resume_finishes() {
        let t = Temp::new("run-later");
        let roots = roots_in(t.path());
        fake_antenlab(&roots);
        let legacy = detect::detect_files(&roots, false);
        let mut settings = Settings::default();
        let mut host = FakeHost { running: 5, answers: vec![true, false], ..FakeHost::default() };
        let now = Stamp::at(1_790_000_000);
        assert!(matches!(
            run(&roots, &legacy, &mut settings, Path::new("/elsewhere"), false, false, &now, &mut host),
            Outcome::Postponed
        ));
        assert_eq!(host.asked, vec!["running", "running"]);
        assert!(roots.old_default_workspace().is_dir(), "nothing moved");
        assert_eq!(record_state(settings.legacy_import.as_ref()), Some("started"));
        assert_eq!(
            decide(false, false, false, true, settings.legacy_import.as_ref(), Some(&legacy)),
            Offer::Resume
        );

        let mut host = FakeHost::default();
        let Outcome::Finished(report) =
            run(&roots, &legacy, &mut settings, Path::new("/elsewhere"), true, false, &now, &mut host)
        else {
            panic!("postponed")
        };
        assert_eq!(report.state, "done");
        // the app's default workspace is elsewhere: the new folder is named explicitly
        assert_eq!(settings.workspace.as_deref(), Some(roots.new_default_workspace().to_str().unwrap()));
    }

    #[test]
    fn a_workspace_seeded_while_the_import_was_postponed_is_replaced_on_resume() {
        let t = Temp::new("run-seeded");
        let roots = roots_in(t.path());
        fake_antenlab(&roots);
        let legacy = detect::detect_files(&roots, false);
        let mut settings = Settings::default();
        let now = Stamp::at(1_790_000_000);
        let mut host = FakeHost { running: 5, answers: vec![false], ..FakeHost::default() };
        let ws_default = roots.new_default_workspace();
        assert!(matches!(run(&roots, &legacy, &mut settings, &ws_default, false, false, &now, &mut host), Outcome::Postponed));
        // the app went on starting and seeded its own workspace
        fs::create_dir_all(&roots.seed.models).unwrap();
        fs::write(roots.seed.models.join("dipole.py"), "from fairbeam import Param\n").unwrap();
        fs::create_dir_all(ws_default.join("models")).unwrap();
        fs::copy(roots.seed.models.join("dipole.py"), ws_default.join("models/dipole.py")).unwrap();
        fs::create_dir_all(ws_default.join("jobs")).unwrap();
        // and its run server left the jobs-folder lock
        fs::write(ws_default.join("jobs/.server-owner.lock"), [0u8]).unwrap();
        fs::create_dir_all(ws_default.join(".sim")).unwrap();
        assert_eq!(decide(false, false, false, true, settings.legacy_import.as_ref(), Some(&legacy)), Offer::Resume);

        let Outcome::Finished(report) =
            run(&roots, &legacy, &mut settings, &ws_default, true, false, &Stamp::at(1_790_000_100), &mut FakeHost::default())
        else {
            panic!("postponed")
        };
        assert_eq!(report.state, "done");
        assert!(report.moved && matches!(report.workspace, Some(WsPlan::Move { .. })));
        assert!(!roots.old_default_workspace().exists());
        assert!(ws_default.join("models/patch.py").is_file() && !ws_default.join("models/dipole.py").exists());
        assert!(ws_default.join("jobs/j1/job.json").is_file());
        let parent = ws_default.parent().unwrap();
        assert!(fs::read_dir(parent).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().contains("aside")));
    }

    #[test]
    fn a_custom_workspace_stays_and_a_full_target_keeps_the_old_one() {
        let t = Temp::new("run-keep");
        let roots = roots_in(t.path());
        fake_antenlab(&roots);
        let custom = t.path().join("Projects/rf");
        fs::create_dir_all(&custom).unwrap();
        fs::write(custom.join("horn.py"), "import antenlab\n").unwrap();
        let mut old: Value = serde_json::from_str(&fs::read_to_string(roots.old_settings()).unwrap()).unwrap();
        old["workspace"] = json!(custom);
        fs::write(roots.old_settings(), old.to_string()).unwrap();

        let legacy = detect::detect_files(&roots, false);
        let mut settings = Settings::default();
        let now = Stamp::at(1_790_000_000);
        let Outcome::Finished(report) =
            run(&roots, &legacy, &mut settings, &roots.new_default_workspace(), false, false, &now, &mut FakeHost::default())
        else {
            panic!()
        };
        assert_eq!(settings.workspace.as_deref(), Some(custom.to_str().unwrap()));
        assert!(!report.moved);
        assert_eq!(fs::read_to_string(custom.join("horn.py")).unwrap(), "import fairbeam\n");
        assert!(roots.old_default_workspace().is_dir(), "the unused default folder is left alone");
        assert_eq!(summary("en", &report, &roots.home), format!("settings, workspace kept at {}, 1 Python files updated", custom.display()));
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_rename_keeps_the_old_folder_when_asked() {
        use std::os::unix::fs::PermissionsExt;
        let t = Temp::new("run-rename-fails");
        let roots = roots_in(t.path());
        fake_antenlab(&roots);
        let legacy = detect::detect_files(&roots, false);
        // a Documents folder the app may not write to (like a refused macOS privacy prompt)
        fs::set_permissions(&roots.documents, fs::Permissions::from_mode(0o555)).unwrap();
        let mut settings = Settings::default();
        let mut host = FakeHost { answers: vec![true, false], ..FakeHost::default() };
        let outcome =
            run(&roots, &legacy, &mut settings, &roots.new_default_workspace(), false, false, &Stamp::at(1), &mut host);
        fs::set_permissions(&roots.documents, fs::Permissions::from_mode(0o755)).unwrap();
        let Outcome::Finished(report) = outcome else { panic!() };
        assert_eq!(host.asked.len(), 2, "Try again once, then keep: {:?}", host.asked);
        assert!(host.asked[0].starts_with("move: "));
        let old = roots.old_default_workspace();
        assert_eq!(settings.workspace.as_deref(), Some(old.to_str().unwrap()));
        assert!(!report.moved && report.state == "done");
        assert_eq!(fs::read_to_string(old.join("models/patch.py")).unwrap(), "from fairbeam import Param\nimport fairbeam.mesh as m\n");
    }

    #[test]
    fn unreadable_settings_fail_the_import() {
        let t = Temp::new("run-broken");
        let roots = roots_in(t.path());
        fake_antenlab(&roots);
        fs::write(roots.old_settings(), "{ not json").unwrap();
        let legacy = detect::detect_files(&roots, false);
        let mut settings = Settings::default();
        let Outcome::Finished(report) =
            run(&roots, &legacy, &mut settings, &roots.new_default_workspace(), false, false, &Stamp::at(1), &mut FakeHost::default())
        else {
            panic!()
        };
        assert_eq!(report.state, "failed");
        assert_eq!(record_state(settings.legacy_import.as_ref()), Some("failed"));
        assert_eq!(failed_list("en", &report.steps), "settings");
        assert_eq!(failed_list("tr", &report.steps), "ayarlar");
    }

    #[test]
    fn dry_run_changes_nothing() {
        let t = Temp::new("run-dry");
        let roots = roots_in(t.path());
        fake_antenlab(&roots);
        let before = snapshot(t.path());
        let legacy = detect::detect_files(&roots, false);
        let mut settings = Settings::default();
        let mut host = FakeHost { running: 1, ..FakeHost::default() };
        let Outcome::Finished(report) =
            run(&roots, &legacy, &mut settings, &roots.new_default_workspace(), false, true, &Stamp::at(1), &mut host)
        else {
            panic!()
        };
        assert_eq!(snapshot(t.path()), before);
        assert!(host.saved.is_empty() && host.asked.is_empty());
        assert_eq!(settings.language, None, "settings untouched");
        assert!(report.dry_run && report.moved);
        assert_eq!(report.jobs.as_ref().map(|j| j.changed), Some(1), "read where they still are");
        assert_eq!(report.python.as_ref().map(|p| p.changed.len()), Some(1));
        assert!(report.steps.iter().any(|s| s.step == "preflight" && !s.ok));
    }

    #[test]
    fn report_round_trips_through_serde() {
        let report = Report {
            version: 1,
            state: "done".into(),
            started_at: "2026-10-06T10:15:00Z".into(),
            finished_at: Some("2026-10-06T10:15:02Z".into()),
            legacy: Legacy { bundles: vec![PathBuf::from("/Applications/antenlab.app")], ..legacy_with_settings() },
            settings_imported: vec!["language".into()],
            workspace: Some(WsPlan::Move { from: PathBuf::from("/d/antenlab"), to: PathBuf::from("/d/Fairbeam") }),
            moved: true,
            jobs: Some(JobsReport { files: 3, changed: 2, errors: vec!["x: y".into()] }),
            python: Some(PyReport { scanned: 4, changed: vec!["a.py".into()], skipped: vec![("b.py".into(), "not UTF-8".into())], errors: vec![] }),
            steps: vec![Step::ok("settings", "x"), Step::failed("jobs", "y")],
            removal: vec![Step::ok("trash", "/Applications/antenlab.app")],
            ..Report::default()
        };
        let text = serde_json::to_string_pretty(&report).unwrap();
        assert!(text.contains("\"kind\": \"move\""));
        assert_eq!(serde_json::from_str::<Report>(&text).unwrap(), report);
        // a record in settings.json round-trips through Settings
        let mut s = Settings::default();
        set_record(&mut s, "done", "2026-10-06T10:15:00Z", &report.steps);
        let back: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        let record: Record = serde_json::from_value(back.legacy_import.unwrap()).unwrap();
        assert_eq!(record.state, "done");
        assert_eq!(record.steps, report.steps);
        // and the new fields stay out of a settings.json that does not use them
        let plain = serde_json::to_value(Settings::default()).unwrap();
        assert!(plain.get("legacy_import").is_none() && plain.get("imported_viewer_prefs").is_none());
    }

    #[test]
    fn dialog_message_follows_the_plan() {
        let home = Path::new("/Users/a");
        let moved = WsPlan::Move { from: home.join("Documents/antenlab"), to: home.join("Documents/Fairbeam") };
        let m = import_message("en", &moved, false, home);
        let sep = if cfg!(windows) { "\\" } else { "/" };
        if cfg!(not(windows)) {
            assert!(m.contains("• your workspace: ~/Documents/antenlab becomes ~/Documents/Fairbeam"), "{m}");
            assert!(m.contains(&format!("kept in ~/Documents/Fairbeam{sep}.fairbeam-import-backup)")), "{m}");
        }
        assert!(m.contains("GPU choice) and recent designs"));
        assert!(m.ends_with("Not imported: unsaved drafts, GitHub sign-in and appearance settings. The simulation runtime is downloaded and installed again."));
        let m = import_message("tr", &moved, true, home);
        assert!(m.contains("GPU seçimi, görünüm) ve son tasarımlar"), "{m}");
        assert!(m.contains("Aktarılmayanlar: kaydedilmemiş taslaklar ve GitHub oturumu."));
        let none = WsPlan::Nothing { reason: "x".into() };
        let m = import_message("en", &none, true, home);
        assert!(!m.contains("workspace") && !m.contains("Python models"), "{m}");
        assert_eq!(m.lines().count(), 6);
    }

    #[test]
    fn sizes_and_stamps() {
        assert_eq!(format_size(3 * 1024 * 1024 * 1024 / 2, "en"), "1.5 GB");
        assert_eq!(format_size(3 * 1024 * 1024 * 1024 / 2, "tr"), "1,5 GB");
        assert_eq!(format_size(250 * 1024 * 1024, "en"), "250 MB");
        assert_eq!(format_size(10, "en"), "1 KB");
        let s = Stamp::at(1_790_362_245);
        assert_eq!(s.iso, "2026-09-25T18:50:45Z");
        assert_eq!(s.compact, "20260925-185045");
        let t = Temp::new("size");
        fs::create_dir_all(t.path().join("a/b")).unwrap();
        fs::write(t.path().join("a/b/f"), vec![0u8; 1000]).unwrap();
        fs::write(t.path().join("a/g"), vec![0u8; 24]).unwrap();
        assert_eq!(dir_size(t.path()), 1024);
        assert_eq!(dir_size(&t.path().join("missing")), 0);
    }
}
