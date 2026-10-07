// Opt-in minimal weekly reports. Without the compile-time switch there is no HTTP client here.
#[path = "telemetry_core.rs"]
mod core;
use core::{env_disabled_value, payload, State};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};
use tauri::AppHandle;
#[cfg(feature = "telemetry")]
use std::time::Duration;

pub const BUILD_ENABLED: bool = cfg!(feature = "telemetry");
pub const ENDPOINT: &str = "https://fairbeam.org/api/ping";
static FILES: Mutex<()> = Mutex::new(());
fn disabled() -> bool { env_disabled_value(std::env::var("FAIRBEAM_NO_TELEMETRY").ok().as_deref()) }
fn enabled_here() -> bool { BUILD_ENABLED && !disabled() }
fn dir(app: &AppHandle) -> PathBuf { crate::paths::local_data(app).join("telemetry") }
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|t| t.as_secs()).unwrap_or(0) }
fn body(app: &AppHandle) -> Value {
    payload(&app.package_info().version.to_string(), std::env::consts::OS, std::env::consts::ARCH)
}
fn status_json(state: &State) -> Value {
    json!({"build_enabled": BUILD_ENABLED, "env_disabled": disabled(), "consent": state.consent,
        "active": state.active(BUILD_ENABLED, disabled()),
        "ask": enabled_here() && state.consent.is_none(), "endpoint": ENDPOINT})
}
pub fn on_app_start(app: &AppHandle) {
    if !enabled_here() { return; }
    {
        let _g = FILES.lock().unwrap_or_else(|e| e.into_inner());
        let dir = dir(app);
        let Ok(_lock) = core::lock(&dir) else { return };
        // Remove files produced by the previous implementation, including identifiers in state.
        let state = State::load(&dir);
        if state.save(&dir).is_err() { return; }
        for name in ["counters-shell.json", "counters-server.json", "counters-shell.json.tmp", "counters-server.json.tmp"] { let _ = fs::remove_file(dir.join(name)); }
    }
    spawn_sender(app.clone());
}
#[cfg(feature = "telemetry")]
fn spawn_sender(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        loop {
            // Serializes sending with withdrawal: after Off returns no pending sender can send.
            let _g = FILES.lock().unwrap_or_else(|e| e.into_inner());
            let _ = core::send_due(&dir(&app), BUILD_ENABLED, disabled(), now(), &body(&app), |body| {
                if rustls::crypto::CryptoProvider::get_default().is_none() {
                    let _ = rustls::crypto::ring::default_provider().install_default();
                }
                tauri::async_runtime::block_on(async {
                    let client = reqwest::Client::builder().timeout(Duration::from_secs(20))
                        .redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
                    let r = client.post(ENDPOINT).header("content-type", "application/json")
                        .body(body.to_string()).send().await.map_err(|e| e.to_string())?;
                    Ok(r.status().as_u16())
                })
            });
            drop(_g);
            std::thread::sleep(Duration::from_secs(6 * 3600));
        }
    });
}
#[cfg(not(feature = "telemetry"))]
fn spawn_sender(_app: AppHandle) {}
#[tauri::command]
pub fn telemetry_status(app: AppHandle) -> Value {
    let _g = FILES.lock().unwrap_or_else(|e| e.into_inner());
    status_json(&if enabled_here() { State::load(&dir(&app)) } else { State::default() })
}
#[tauri::command]
pub fn telemetry_set_consent(app: AppHandle, granted: bool) -> Result<Value, String> {
    if !enabled_here() { return Err("Usage statistics are not active in this build".into()); }
    let _g = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let dir = dir(&app);
    let _lock = core::lock(&dir)?;
    let mut state = State::load(&dir);
    state.consent = Some(if granted { "granted" } else { "denied" }.into());
    // Preserve last_sent when toggled: turning Off and On cannot bypass the weekly limit.
    state.save(&dir)?;
    Ok(status_json(&state))
}
#[tauri::command]
pub fn telemetry_preview(app: AppHandle) -> Value {
    let _g = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let state = if enabled_here() { State::load(&dir(&app)) } else { State::default() };
    json!({"status": status_json(&state),
        "next": if state.active(BUILD_ENABLED, disabled()) && state.due(now()) { body(&app) } else { Value::Null },
        "example": if !enabled_here() { body(&app) } else { Value::Null }})
}
