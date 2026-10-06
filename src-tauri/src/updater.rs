// Updates (docs/RELEASES.md): once the viewer is up, ask the release feed
// (fairbeam-releases/latest.json, signed with the fairbeam updater key) whether a newer app exists.
// If so, offer it in a native dialog; on yes, stop the server, install, restart.
// Every check leaves one line in shell.log (skipped, up to date, offered and the answer, failed).

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::shelllog;
use crate::update_progress::{self as progress, Phase};

static CHECKING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CheckResult {
    UpToDate { version: String },
    UpdateAvailable { current: String, version: String },
    Unavailable,
    PreviewBlocked,
    InProgress,
    Disabled,
}

struct CheckGuard;

impl Drop for CheckGuard {
    fn drop(&mut self) {
        CHECKING.store(false, Ordering::Release);
    }
}

pub fn check_later(app: AppHandle) {
    if INSTALL_FAILED.load(Ordering::Acquire) {
        shelllog::write(&app, "update check: skipped (an install failed in this session)");
        return;
    }
    if !crate::paths::load_settings(&app).check_updates_on_start {
        shelllog::write(&app, "update check: skipped (disabled in settings)");
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _ = check_now(app, false).await;
    });
}

/// Check for updates without forcing an install. Manual checks bypass the startup preference.
/// `show_result` is used by Help › Check for updates; the Settings button renders its own status.
pub async fn check_now(app: AppHandle, show_result: bool) -> CheckResult {
    if CHECKING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        if show_result {
            show_result_dialog(&app, &CheckResult::InProgress);
        }
        return CheckResult::InProgress;
    }
    let guard = CheckGuard;

    // debug builds: FAIRBEAM_FAKE_UPDATE=1 plays the progress indicator (update_progress.rs)
    #[cfg(debug_assertions)]
    if show_result && progress::demo_enabled() {
        progress::demo(app.clone());
        return CheckResult::UpToDate { version: app.package_info().version.to_string() };
    }
    if cfg!(debug_assertions) {
        let result = CheckResult::PreviewBlocked;
        if show_result {
            show_result_dialog(&app, &result);
        }
        return result;
    }
    if std::env::var("FAIRBEAM_NO_UPDATE_CHECK").as_deref() == Ok("1") {
        shelllog::write(&app, "update check: skipped (FAIRBEAM_NO_UPDATE_CHECK=1)");
        let result = CheckResult::Disabled;
        if show_result {
            show_result_dialog(&app, &result);
        }
        return result;
    }
    let current = app.package_info().version.to_string();
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            shelllog::write(&app, &format!("update check: failed: {e}"));
            let result = CheckResult::Unavailable;
            if show_result {
                show_result_dialog(&app, &result);
            }
            return result;
        }
    };
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            shelllog::write(&app, &format!("update check: up to date ({current})"));
            let result = CheckResult::UpToDate { version: current };
            if show_result {
                show_result_dialog(&app, &result);
            }
            return result;
        }
        Err(e) => {
            shelllog::write(&app, &format!("update check: failed: {e}"));
            let result = CheckResult::Unavailable;
            if show_result {
                show_result_dialog(&app, &result);
            }
            return result;
        }
    };
    let version = update.version.clone();
    shelllog::write(
        &app,
        &format!("update check: {version} offered (running {current})"),
    );
    let notes = dialog_notes(update.body.as_deref().unwrap_or_default(), &version);
    // The dialog in the viewer's language; release notes stay as published.
    let lang = crate::i18n::lang(&crate::paths::load_settings(&app));
    let text = crate::i18n::fill(
        crate::i18n::text(lang, "update-message"),
        &[
            ("version", &version),
            ("current", &current),
            ("notes", &notes),
        ],
    );
    let handle = app.clone();
    // Keep the global check busy while the user decides, then through an install attempt. This
    // prevents a second Help or Settings check from opening another update offer at the same time.
    let dialog_guard = guard;
    app.dialog()
        .message(text)
        .title(crate::i18n::text(lang, "update-title"))
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            crate::i18n::text(lang, "update-install"),
            crate::i18n::text(lang, "update-later"),
        ))
        .show(move |yes| {
            if !yes {
                shelllog::write(&handle, "update: Later");
                drop(dialog_guard);
                return;
            }
            shelllog::write(
                &handle,
                &format!("update: Install and restart ({})", update.version),
            );
            // macOS: an app running from App Translocation or a read-only disk cannot replace
            // itself; say how to fix it instead of downloading an update that cannot be installed
            #[cfg(target_os = "macos")]
            if let Some(bundle) = crate::macos_update::bundle_path() {
                let place = crate::macos_update::location(&bundle);
                if place != crate::macos_update::Location::Writable {
                    shelllog::write(
                        &handle,
                        &format!("update: not installed, the app runs from a read-only place ({place:?}): {}", bundle.display()),
                    );
                    // the check stays busy until this dialog is closed
                    show_move_dialog(&handle, lang, &bundle, place, dialog_guard);
                    return;
                }
            }
            tauri::async_runtime::spawn(async move {
                let _guard = dialog_guard;
                // download (the plugin verifies the signature) while the server keeps running; the
                // viewer shows the progress (update_progress.rs)
                let version = update.version.clone();
                progress::announce(
                    &handle,
                    &Phase::Downloading { version: &version, downloaded: 0, total: None },
                    &format!("update: downloading {version}"),
                );
                let state = Arc::new(Mutex::new(progress::Download::new()));
                let on_chunk = {
                    let (handle, version, state) = (handle.clone(), version.clone(), state.clone());
                    move |len: usize, total: Option<u64>| {
                        let step = state.lock().unwrap().chunk(Instant::now(), len, total);
                        if let Some((downloaded, total)) = step {
                            progress::emit(&handle, &Phase::Downloading { version: &version, downloaded, total });
                        }
                    }
                };
                let on_finish = {
                    let (handle, version, state) = (handle.clone(), version.clone(), state.clone());
                    move || {
                        let (downloaded, total) = state.lock().unwrap().finish();
                        progress::emit(&handle, &Phase::Downloading { version: &version, downloaded, total });
                    }
                };
                let bytes = match update.download(on_chunk, on_finish).await {
                    Ok(b) => b,
                    Err(e) => {
                        fail(&handle, lang, &e.to_string(), false);
                        return;
                    }
                };
                // the viewer learns of the install first: it must not read the stopped server as a
                // failure (src/runner/store.ts)
                progress::announce(
                    &handle,
                    &Phase::Installing { version: &version },
                    &format!("update: installing {version}"),
                );
                crate::stop_server(&handle);
                match install(&handle, lang, &update, &bytes) {
                    Ok(()) => {
                        progress::announce(
                            &handle,
                            &Phase::Restarting { version: &version },
                            &format!("update: {version} installed, restarting"),
                        );
                        handle.restart()
                    }
                    Err(e) => fail(&handle, lang, &e, true),
                }
            });
        });
    CheckResult::UpdateAvailable { current, version }
}

/// A failed install keeps the running app (macos_update.rs keeps even its rollback copy); the
/// next startup check would offer the same update again at once, so it is skipped for this run.
static INSTALL_FAILED: AtomicBool = AtomicBool::new(false);

fn fail(app: &AppHandle, lang: &str, error: &str, restart_server: bool) {
    shelllog::write(app, &format!("update: install failed: {error}"));
    INSTALL_FAILED.store(true, Ordering::Release);
    progress::emit(app, &Phase::Failed);
    app.dialog()
        .message(crate::i18n::fill(
            crate::i18n::text(lang, "update-failed"),
            &[("error", error)],
        ))
        .title(crate::i18n::text(lang, "update-failed-title"))
        .kind(MessageDialogKind::Error)
        .show(|_| {});
    if restart_server {
        crate::start(app.clone());
    }
}

/// Install the downloaded, verified archive. On macOS an app on another volume than the system
/// temp folder makes the plugin's move fail with EXDEV; it is then installed beside the app
/// instead (macos_update.rs).
fn install(
    app: &AppHandle,
    lang: &str,
    update: &tauri_plugin_updater::Update,
    bytes: &[u8],
) -> Result<(), String> {
    match update.install(bytes) {
        Ok(()) => Ok(()),
        #[cfg(target_os = "macos")]
        Err(tauri_plugin_updater::Error::Io(e)) if crate::macos_update::is_cross_device(&e) => {
            let Some(bundle) = crate::macos_update::bundle_path() else {
                return Err(e.to_string());
            };
            shelllog::write(
                app,
                &format!("update: {e}; installing beside the app in {}", bundle.display()),
            );
            crate::macos_update::install_beside(bytes, &bundle).map_err(|e| {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    crate::i18n::fill(
                        crate::i18n::text(lang, "update-folder-not-writable"),
                        &[("path", &bundle.parent().unwrap_or(&bundle).display().to_string())],
                    )
                } else {
                    e.to_string()
                }
            })
        }
        Err(e) => {
            let _ = (app, lang);
            Err(e.to_string())
        }
    }
}

#[cfg(target_os = "macos")]
fn show_move_dialog(
    app: &AppHandle,
    lang: &str,
    bundle: &std::path::Path,
    place: crate::macos_update::Location,
    guard: CheckGuard,
) {
    use crate::macos_update::Location;
    // a translocated app runs from a random read-only copy: show (and reveal) the user's own copy
    let (key, shown) = match &place {
        Location::Translocated(Some(original)) => ("update-move", Some(original.clone())),
        Location::Translocated(None) => ("update-move", None),
        _ => ("update-move-read-only", Some(bundle.to_path_buf())),
    };
    let path = shown
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| crate::i18n::text(lang, "update-move-unknown-path"));
    let dialog = app
        .dialog()
        .message(crate::i18n::fill(crate::i18n::text(lang, key), &[("path", &path)]))
        .title(crate::i18n::text(lang, "update-move-title"))
        .kind(MessageDialogKind::Warning);
    match shown {
        Some(reveal) => dialog
            .buttons(MessageDialogButtons::OkCancelCustom(
                crate::i18n::text(lang, "update-ok"),
                crate::i18n::text(lang, "update-show-in-finder"),
            ))
            .show(move |ok| {
                if !ok {
                    let _ = std::process::Command::new("open").arg("-R").arg(&reveal).spawn();
                }
                drop(guard);
            }),
        None => dialog
            .buttons(MessageDialogButtons::OkCustom(crate::i18n::text(lang, "update-ok")))
            .show(move |_| drop(guard)),
    }
}

fn show_result_dialog(app: &AppHandle, result: &CheckResult) {
    let lang = crate::i18n::lang(&crate::paths::load_settings(app));
    let title = crate::i18n::text(lang, "update-check-title");
    let message = match result {
        CheckResult::UpToDate { version } => crate::i18n::fill(
            crate::i18n::text(lang, "update-up-to-date"),
            &[("version", version)],
        ),
        CheckResult::Unavailable => crate::i18n::text(lang, "update-unavailable"),
        CheckResult::PreviewBlocked => crate::i18n::text(lang, "update-preview-blocked"),
        CheckResult::InProgress => crate::i18n::text(lang, "update-in-progress"),
        CheckResult::Disabled => crate::i18n::text(lang, "update-disabled"),
        CheckResult::UpdateAvailable { .. } => return,
    };
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

/// The update dialog's notes: a native message box cannot scroll, so long or Markdown release notes
/// (older feeds carried the whole release page) become plain text of at most `MAX_NOTES` characters,
/// followed by a link to the full notes. The feed's own summary (scripts/publish-release.mjs) fits.
const MAX_NOTES: usize = 480;

fn dialog_notes(body: &str, version: &str) -> String {
    let url = format!("https://github.com/ismailakdag/fairbeam-releases/releases/tag/v{version}");
    let mut lines = Vec::new();
    for raw in body.lines() {
        let mut line = raw.trim();
        // headings, quotes, list markers and rules
        line = line
            .trim_start_matches(|c| c == '#' || c == '>')
            .trim_start();
        if let Some(rest) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            line = rest;
        }
        if line.chars().all(|c| c == '-' || c == '*' || c == '_') {
            line = "";
        }
        let clean = line.replace("**", "").replace('`', "");
        if clean.starts_with("Full release notes:") {
            continue; // added once below
        }
        if clean.is_empty() {
            if lines.last().is_some_and(|l: &String| !l.is_empty()) {
                lines.push(String::new());
            }
        } else {
            lines.push(clean);
        }
    }
    let text = lines.join("\n");
    let text = text.trim();
    let short = if text.chars().count() > MAX_NOTES {
        let cut: String = text.chars().take(MAX_NOTES).collect();
        let at = cut.rfind(char::is_whitespace).unwrap_or(cut.len());
        format!("{}…", cut[..at].trim_end())
    } else {
        text.to_string()
    };
    if short.is_empty() {
        format!("Release notes: {url}")
    } else {
        format!("{short}\n\nFull release notes: {url}")
    }
}

#[cfg(test)]
mod tests {
    use super::{dialog_notes, CheckResult};

    #[test]
    fn short_summary_is_kept() {
        let n = dialog_notes(
            "Gain patterns and an Efficiency result.\n\nFull release notes: https://x",
            "0.4.3",
        );
        assert_eq!(n, "Gain patterns and an Efficiency result.\n\nFull release notes: https://github.com/ismailakdag/fairbeam-releases/releases/tag/v0.4.3");
    }

    #[test]
    fn long_markdown_is_plain_and_capped() {
        let body = format!(
            "**New in 0.4.3**\n- **Gain:** `x` works\n> quoted\n---\n{}",
            "word ".repeat(300)
        );
        let n = dialog_notes(&body, "0.4.3");
        assert!(!n.contains("**") && !n.contains('`') && !n.contains("\n- ") && !n.contains("---"));
        assert!(n.starts_with("New in 0.4.3\nGain: x works\nquoted"));
        let notes = n.split("\n\nFull release notes:").next().unwrap();
        assert!(notes.chars().count() <= 481 && notes.ends_with('…'));
        assert!(n.ends_with("/releases/tag/v0.4.3"));
    }

    #[test]
    fn every_updater_text_exists_in_both_languages() {
        // updater.rs looks its texts up with i18n::text(lang, "…"), which the i18n key scan misses
        let src = include_str!("updater.rs");
        let mut keys: Vec<&str> = src
            .match_indices("\"update-")
            .map(|(i, _)| &src[i + 1..])
            .filter_map(|rest| rest.split('"').next())
            .filter(|k| k.len() > "update-".len() && k.chars().all(|c| c.is_ascii_lowercase() || c == '-'))
            .collect();
        keys.sort();
        keys.dedup();
        assert!(keys.len() >= 10, "found {keys:?}");
        for key in keys {
            for lang in ["en", "tr"] {
                assert_ne!(crate::i18n::text(lang, key), key, "{key} has no {lang} text");
            }
        }
    }

    #[test]
    fn manual_check_status_has_a_stable_frontend_shape() {
        let json = serde_json::to_value(CheckResult::UpToDate {
            version: "0.5.4".into(),
        })
        .unwrap();
        assert_eq!(json["status"], "up_to_date");
        assert_eq!(json["version"], "0.5.4");
    }
}
