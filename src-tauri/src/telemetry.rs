// Pseudonymous, opt-in usage statistics (docs/TELEMETRY.md). Built and wired, but OFF: without the
// Cargo feature `telemetry` nothing is counted, no file is written, no consent dialog is shown and
// no code that could send a request is compiled in.
//
// When it is on, the counts are kept per UTC day in <app local data>/telemetry/:
//   state.json            (this module)   install id, consent, last version, what was sent
//   counters-shell.json   (this module)   app starts, updates and the viewer's export counts
//   counters-server.json  (the Python run server, python/fairbeam/telemetry.py) simulations etc.
// Each file has one writer. Once a day, with consent `granted` and without FAIRBEAM_NO_TELEMETRY,
// the oldest whole previous day is POSTed to ENDPOINT.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::AppHandle;

/// The build switch: `cargo tauri build --features telemetry` (off in every release so far).
pub const BUILD_ENABLED: bool = cfg!(feature = "telemetry");
pub const ENDPOINT: &str = "https://fairbeam.org/api/ping";
pub const SCHEMA_ID: &str = "fairbeam.ping/1";
/// The one list of counter keys (shared with api/_ping-core.js and the Python tests).
const SCHEMA_JSON: &str = include_str!("../../api/_ping-schema.json");

const STATE_FILE: &str = "state.json";
const SHELL_FILE: &str = "counters-shell.json";
const SERVER_FILE: &str = "counters-server.json";
/// The first check after the start, then every few hours while the app stays open.
const FIRST_CHECK: Duration = Duration::from_secs(60);
const RECHECK: Duration = Duration::from_secs(6 * 3600);

/// Every read-modify-write of the shell's files holds this lock (commands and the sender thread).
static FILES: Mutex<()> = Mutex::new(());

struct Schema {
    keys: HashSet<String>,
    ui_events: Vec<String>,
    #[allow(dead_code)] // compared with the ping by the tests
    fields: Vec<String>,
    max_keys: usize,
    max_value: u64,
    max_age_days: i64,
}

fn schema() -> &'static Schema {
    static S: OnceLock<Schema> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(SCHEMA_JSON).expect("api/_ping-schema.json is valid JSON");
        let list = |k: &str| -> Vec<String> {
            v[k].as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default()
        };
        assert_eq!(v["schema"], SCHEMA_ID, "api/_ping-schema.json has another schema id");
        Schema {
            keys: list("keys").into_iter().collect(),
            ui_events: list("ui_events"),
            fields: list("fields"),
            max_keys: v["max_keys"].as_u64().unwrap_or(120) as usize,
            max_value: v["max_value"].as_u64().unwrap_or(10_000),
            max_age_days: v["max_age_days"].as_i64().unwrap_or(31),
        }
    })
}

/// `app.update_from.<x.y.z>` or `app.update_from.unknown` (the schema's key_patterns).
fn is_update_key(key: &str) -> bool {
    let Some(v) = key.strip_prefix("app.update_from.") else {
        return false;
    };
    v == "unknown" || is_plain_version(v)
}

fn is_plain_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

pub fn key_allowed(key: &str) -> bool {
    schema().keys.contains(key) || is_update_key(key)
}

// ---------------------------------------------------------------- days (UTC, no date crate)

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe as i64 + era * 400;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * mp + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

/// "YYYY-MM-DD" of a day number (days since 1970-01-01).
pub fn day_string(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// The day number of "YYYY-MM-DD", None for anything else (also for 2026-02-30).
pub fn day_number(day: &str) -> Option<i64> {
    let b = day.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i64 = day[0..4].parse().ok()?;
    let m: u32 = day[5..7].parse().ok()?;
    let d: u32 = day[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let n = days_from_civil(y, m, d);
    (day_string(n) == day).then_some(n)
}

pub fn day_of_unix(secs: u64) -> String {
    day_string((secs / 86_400) as i64)
}

pub fn today() -> String {
    day_of_unix(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    )
}

// ---------------------------------------------------------------- files

/// `{"days": {"2026-09-28": {"app.start": 2}}}`: one writer per file.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Counters {
    #[serde(default)]
    pub days: BTreeMap<String, BTreeMap<String, u64>>,
}

impl Counters {
    /// Count `key` on `day`; an unknown key or a malformed day is never recorded.
    pub fn add(&mut self, day: &str, key: &str, n: u64) -> bool {
        if !key_allowed(key) || day_number(day).is_none() {
            return false;
        }
        let max = schema().max_value;
        let v = self.days.entry(day.into()).or_default().entry(key.into()).or_insert(0);
        *v = v.saturating_add(n).min(max);
        true
    }

    /// Drop the days already sent and those too old to send.
    pub fn prune(&mut self, today: &str, sent_through: Option<&str>) {
        let oldest = day_number(today).map(|t| t - schema().max_age_days);
        self.days.retain(|day, _| {
            let Some(n) = day_number(day) else { return false };
            oldest.is_none_or(|o| n >= o) && sent_through.is_none_or(|s| day.as_str() > s)
        });
    }

    fn load(path: &Path) -> Counters {
        fs::read_to_string(path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct State {
    /// a random v4 UUID, created here and resettable; never derived from the hardware
    #[serde(default)]
    pub install_id: Option<String>,
    /// unset until the user answers; "granted" or "denied"
    #[serde(default)]
    pub consent: Option<String>,
    /// what the Python server reads: count while true
    #[serde(default)]
    pub counting: bool,
    #[serde(default)]
    pub last_version: Option<String>,
    #[serde(default)]
    pub gpu_available: bool,
    #[serde(default)]
    pub last_attempt_day: Option<String>,
    #[serde(default)]
    pub sent_through: Option<String>,
}

impl State {
    fn load(dir: &Path) -> State {
        fs::read_to_string(dir.join(STATE_FILE))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn ensure_id(&mut self) -> &str {
        if self.install_id.as_deref().is_none_or(|id| !valid_uuid(id)) {
            self.install_id = Some(new_install_id());
        }
        self.install_id.as_deref().unwrap()
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn new_install_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn valid_uuid(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|u| u.get_version_num() == 4) && id.len() == 36
}

// ---------------------------------------------------------------- the switch

#[derive(Clone, Debug)]
pub struct Switch {
    pub build_enabled: bool,
    pub env_disabled: bool,
    pub consent: Option<String>,
}

impl Switch {
    /// counting and sending: the build switch, no opt-out in the environment, consent granted
    pub fn active(&self) -> bool {
        self.build_enabled && !self.env_disabled && self.consent.as_deref() == Some("granted")
    }

    /// the first-start dialog: only in a build with the switch on, and only until answered
    pub fn ask(&self) -> bool {
        self.build_enabled && !self.env_disabled && self.consent.is_none()
    }
}

/// `FAIRBEAM_NO_TELEMETRY=1` (or any value but empty/0/false) always disables it.
pub fn env_disabled_value(v: Option<&str>) -> bool {
    v.is_some_and(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "" | "0" | "false" | "no"))
}

fn env_disabled() -> bool {
    env_disabled_value(std::env::var("FAIRBEAM_NO_TELEMETRY").ok().as_deref())
}

// ---------------------------------------------------------------- the ping

pub struct Meta {
    pub app_version: String,
    pub os: &'static str,
    pub arch: &'static str,
}

impl Meta {
    fn current(app: &AppHandle) -> Meta {
        Meta {
            app_version: app.package_info().version.to_string(),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        }
    }
}

/// The exact body of a ping: the eight schema fields and nothing else; only listed counter keys
/// with non-zero values (capped).
pub fn payload(install_id: &str, gpu_available: bool, meta: &Meta, day: &str, counts: &BTreeMap<String, u64>) -> Value {
    let s = schema();
    let mut counters = Map::new();
    for (k, v) in counts {
        if *v > 0 && key_allowed(k) && counters.len() < s.max_keys {
            counters.insert(k.clone(), json!((*v).min(s.max_value)));
        }
    }
    json!({
        "schema": SCHEMA_ID,
        "install_id": install_id,
        "app_version": meta.app_version,
        "os": meta.os,
        "arch": meta.arch,
        "gpu_available": gpu_available,
        "day": day,
        "counters": counters,
    })
}

/// Both writers' counts of one day, added up.
fn merged(day: &str, files: &[&Counters]) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::<String, u64>::new();
    for c in files {
        for (k, v) in c.days.get(day).into_iter().flatten() {
            let e = out.entry(k.clone()).or_insert(0);
            *e = e.saturating_add(*v);
        }
    }
    out
}

/// The next ping: the oldest whole previous day not sent yet (never today), within the age limit.
pub fn next_ping(state: &State, shell: &Counters, server: &Counters, today: &str, meta: &Meta) -> Option<(String, Value)> {
    let id = state.install_id.as_deref().filter(|id| valid_uuid(id))?;
    let t = day_number(today)?;
    let oldest = t - schema().max_age_days;
    let mut days: Vec<&String> = shell.days.keys().chain(server.days.keys()).collect();
    days.sort();
    days.dedup();
    for day in days {
        let Some(n) = day_number(day) else { continue };
        if n >= t || n < oldest || state.sent_through.as_deref().is_some_and(|s| day.as_str() <= s) {
            continue;
        }
        let p = payload(id, state.gpu_available, meta, day, &merged(day, &[shell, server]));
        if p["counters"].as_object().is_some_and(|c| !c.is_empty()) {
            return Some((day.clone(), p));
        }
    }
    None
}

/// Sends one ping (nothing else in the app talks to ENDPOINT).
pub trait Transport {
    /// POST `body` (JSON) to `url`: the HTTP status, or an error for no answer at all.
    fn post(&self, url: &str, body: &str) -> Result<u16, String>;
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// the switch, the environment or the consent says no: nothing was read or sent
    Off,
    /// today's one attempt was made already
    AlreadyTried,
    /// no whole previous day with counts
    Nothing,
    Sent(String),
    /// the server refused the content (400/413/422): the day is dropped
    Rejected(String, u16),
    /// no answer, 429 or 5xx: the counts stay, the next day tries again
    Failed(String),
}

/// Once a day at most: prepare under the lock, post without it, then record the answer.
pub fn send_due(dir: &Path, sw: &Switch, meta: &Meta, today: &str, transport: &dyn Transport) -> Outcome {
    if !sw.active() {
        return Outcome::Off;
    }
    let (day, body) = {
        let _g = FILES.lock().unwrap_or_else(|e| e.into_inner());
        let mut state = State::load(dir);
        if state.last_attempt_day.as_deref() == Some(today) {
            return Outcome::AlreadyTried;
        }
        let shell = Counters::load(&dir.join(SHELL_FILE));
        let server = Counters::load(&dir.join(SERVER_FILE));
        let Some((day, p)) = next_ping(&state, &shell, &server, today, meta) else {
            return Outcome::Nothing;
        };
        // recorded before the POST: a crash or a hang cannot turn one day into many requests
        state.last_attempt_day = Some(today.into());
        if write_json(&dir.join(STATE_FILE), &state).is_err() {
            return Outcome::Failed("state not writable".into());
        }
        (day, p.to_string())
    };
    let answer = transport.post(ENDPOINT, &body);
    let done = match answer {
        Ok(s) if (200..300).contains(&s) => Outcome::Sent(day.clone()),
        Ok(s @ (400 | 413 | 422)) => Outcome::Rejected(day.clone(), s),
        Ok(s) => return Outcome::Failed(format!("HTTP {s}")),
        Err(e) => return Outcome::Failed(e),
    };
    let _g = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = State::load(dir);
    if state.sent_through.as_deref().is_none_or(|s| s < day.as_str()) {
        state.sent_through = Some(day.clone());
    }
    let _ = write_json(&dir.join(STATE_FILE), &state);
    let mut shell = Counters::load(&dir.join(SHELL_FILE));
    shell.prune(today, state.sent_through.as_deref());
    let _ = write_json(&dir.join(SHELL_FILE), &shell);
    done
}

// ---------------------------------------------------------------- the app

fn dir(app: &AppHandle) -> PathBuf {
    crate::paths::local_data(app).join("telemetry")
}

fn switch_for(state: &State) -> Switch {
    Switch {
        build_enabled: BUILD_ENABLED,
        env_disabled: env_disabled(),
        consent: state.consent.clone(),
    }
}

fn enabled_here() -> bool {
    BUILD_ENABLED && !env_disabled()
}

/// Called once per app process from `setup`: counts the start and the first run of a version,
/// and starts the daily sender. Does nothing at all with the switch off.
pub fn on_app_start(app: &AppHandle) {
    if !enabled_here() {
        return;
    }
    let dir = dir(app);
    let version = app.package_info().version.to_string();
    let had_settings = crate::paths::settings_path(app).is_some_and(|p| p.is_file());
    {
        let _g = FILES.lock().unwrap_or_else(|e| e.into_inner());
        let mut state = State::load(&dir);
        let sw = switch_for(&state);
        state.ensure_id();
        state.counting = sw.active();
        let today = today();
        let mut shell = Counters::load(&dir.join(SHELL_FILE));
        for key in start_keys(state.last_version.as_deref(), &version, had_settings) {
            if sw.active() {
                shell.add(&today, &key, 1);
            }
        }
        state.last_version = Some(version);
        shell.prune(&today, state.sent_through.as_deref());
        let _ = write_json(&dir.join(STATE_FILE), &state);
        if sw.active() {
            let _ = write_json(&dir.join(SHELL_FILE), &shell);
        }
    }
    spawn_sender(app.clone());
}

/// The keys an app start counts: always `app.start`; on a new version also the install or the
/// update it came from.
pub fn start_keys(last_version: Option<&str>, version: &str, had_settings: bool) -> Vec<String> {
    let mut keys = vec!["app.start".to_string()];
    match last_version {
        Some(v) if v == version => {}
        Some(v) if is_plain_version(v) => keys.push(format!("app.update_from.{v}")),
        Some(_) => keys.push("app.update_from.unknown".into()),
        // settings from an earlier version, but no telemetry state yet
        None if had_settings => keys.push("app.update_from.unknown".into()),
        None => keys.push("app.install".into()),
    }
    keys
}

fn spawn_sender(app: AppHandle) {
    let Some(transport) = http_transport() else {
        return;
    };
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK);
        loop {
            let dir = dir(&app);
            let sw = switch_for(&State::load(&dir));
            let _ = send_due(&dir, &sw, &Meta::current(&app), &today(), transport.as_ref());
            std::thread::sleep(RECHECK);
        }
    });
}

#[cfg(feature = "telemetry")]
fn http_transport() -> Option<Box<dyn Transport + Send>> {
    struct Http;
    impl Transport for Http {
        fn post(&self, url: &str, body: &str) -> Result<u16, String> {
            let body = body.to_string();
            let url = url.to_string();
            // the same TLS setup as the updater plugin and the account module (rustls with ring)
            if rustls::crypto::CryptoProvider::get_default().is_none() {
                let _ = rustls::crypto::ring::default_provider().install_default();
            }
            tauri::async_runtime::block_on(async move {
                let client = reqwest::Client::builder()
                    .timeout(Duration::from_secs(20))
                    .user_agent(concat!("fairbeam/", env!("CARGO_PKG_VERSION")))
                    .build()
                    .map_err(|e| e.to_string())?;
                let r = client
                    .post(url)
                    .header("content-type", "application/json")
                    .body(body)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(r.status().as_u16())
            })
        }
    }
    Some(Box::new(Http))
}

/// Without the build switch there is no HTTP client here at all.
#[cfg(not(feature = "telemetry"))]
fn http_transport() -> Option<Box<dyn Transport + Send>> {
    None
}

/// The folder for the Python server (FAIRBEAM_TELEMETRY_DIR), None with the switch off. Records
/// whether the chosen openEMS has the GPU engine (the ping's gpu_available).
pub fn server_dir(app: &AppHandle, gpu: bool) -> Option<PathBuf> {
    if !enabled_here() {
        return None;
    }
    let dir = dir(app);
    let _g = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = State::load(&dir);
    state.gpu_available = gpu;
    state.ensure_id();
    write_json(&dir.join(STATE_FILE), &state).ok()?;
    Some(dir)
}

fn status_json(state: Option<&State>) -> Value {
    let sw = match state {
        Some(s) => switch_for(s),
        None => Switch { build_enabled: BUILD_ENABLED, env_disabled: env_disabled(), consent: None },
    };
    json!({
        "build_enabled": sw.build_enabled,
        "env_disabled": sw.env_disabled,
        "consent": sw.consent,
        "active": sw.active(),
        "ask": sw.ask(),
        "endpoint": ENDPOINT,
    })
}

fn clear_pending(dir: &Path) {
    let _ = fs::remove_file(dir.join(SHELL_FILE));
    // the server's own file: it also deletes it itself once it sees `counting: false`
    let _ = fs::remove_file(dir.join(SERVER_FILE));
}

#[tauri::command]
pub fn telemetry_status(app: AppHandle) -> Value {
    if !enabled_here() {
        return status_json(None);
    }
    let _g = FILES.lock().unwrap_or_else(|e| e.into_inner());
    status_json(Some(&State::load(&dir(&app))))
}

/// General settings › Usage statistics On/Off, and the first-start dialog's answer.
#[tauri::command]
pub fn telemetry_set_consent(app: AppHandle, granted: bool) -> Result<Value, String> {
    if !enabled_here() {
        return Err("Usage statistics are not active in this build".into());
    }
    let dir = dir(&app);
    let _g = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = State::load(&dir);
    state.ensure_id();
    state.consent = Some(if granted { "granted" } else { "denied" }.into());
    state.counting = switch_for(&state).active();
    if !state.counting {
        clear_pending(&dir);
    }
    write_json(&dir.join(STATE_FILE), &state)?;
    Ok(status_json(Some(&state)))
}

/// "View what would be sent": the exact next ping and today's counts so far. Writes nothing.
#[tauri::command]
pub fn telemetry_preview(app: AppHandle) -> Value {
    let meta = Meta::current(&app);
    let today = today();
    if !enabled_here() {
        let yesterday = day_number(&today).map(|n| day_string(n - 1)).unwrap_or_default();
        let example: BTreeMap<String, u64> = [("app.start", 1), ("sim.started.cpu.design", 1), ("sim.finished.cpu.design", 1)]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        return json!({
            "status": status_json(None),
            "example": payload("00000000-0000-4000-8000-000000000000", false, &meta, &yesterday, &example),
            "next": Value::Null,
            "today": Value::Null,
        });
    }
    let dir = dir(&app);
    let _g = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let state = State::load(&dir);
    let shell = Counters::load(&dir.join(SHELL_FILE));
    let server = Counters::load(&dir.join(SERVER_FILE));
    let id = state.install_id.clone().unwrap_or_default();
    json!({
        "status": status_json(Some(&state)),
        "next": next_ping(&state, &shell, &server, &today, &meta).map(|(_, p)| p),
        "today": payload(&id, state.gpu_available, &meta, &today, &merged(&today, &[&shell, &server])),
    })
}

/// "Reset id": a new random id; the counts not sent yet are deleted with the old one.
#[tauri::command]
pub fn telemetry_reset_id(app: AppHandle) -> Result<Value, String> {
    if !enabled_here() {
        return Err("Usage statistics are not active in this build".into());
    }
    let dir = dir(&app);
    let _g = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = State::load(&dir);
    state.install_id = Some(new_install_id());
    state.sent_through = None;
    state.last_attempt_day = None;
    clear_pending(&dir);
    write_json(&dir.join(STATE_FILE), &state)?;
    Ok(status_json(Some(&state)))
}

/// A viewer action (CST export, Touchstone export, PDF report): only the schema's ui_events.
#[tauri::command]
pub fn telemetry_count(app: AppHandle, event: String) -> Result<(), String> {
    if !schema().ui_events.iter().any(|e| e == &event) {
        return Err("Unknown usage event".into());
    }
    if !enabled_here() {
        return Ok(());
    }
    let dir = dir(&app);
    let _g = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let state = State::load(&dir);
    if !switch_for(&state).active() {
        return Ok(());
    }
    let path = dir.join(SHELL_FILE);
    let mut shell = Counters::load(&path);
    shell.add(&today(), &event, 1);
    write_json(&path, &shell)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake {
        calls: RefCell<Vec<String>>,
        answer: Result<u16, String>,
    }

    impl Fake {
        fn new(answer: Result<u16, String>) -> Fake {
            Fake { calls: RefCell::new(vec![]), answer }
        }
    }

    impl Transport for Fake {
        fn post(&self, url: &str, body: &str) -> Result<u16, String> {
            assert_eq!(url, ENDPOINT);
            self.calls.borrow_mut().push(body.to_string());
            self.answer.clone()
        }
    }

    fn meta() -> Meta {
        Meta { app_version: "0.4.4".into(), os: "macos", arch: "aarch64" }
    }

    fn granted() -> Switch {
        Switch { build_enabled: true, env_disabled: false, consent: Some("granted".into()) }
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "fairbeam-telemetry-{name}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn seeded(name: &str) -> PathBuf {
        let d = temp(name);
        let mut state = State::default();
        state.ensure_id();
        state.consent = Some("granted".into());
        write_json(&d.join(STATE_FILE), &state).unwrap();
        let mut shell = Counters::default();
        shell.add("2026-09-27", "app.start", 2);
        shell.add("2026-09-28", "app.start", 1);
        write_json(&d.join(SHELL_FILE), &shell).unwrap();
        let mut server = Counters::default();
        server.add("2026-09-27", "sim.started.cpu.design", 3);
        write_json(&d.join(SERVER_FILE), &server).unwrap();
        d
    }

    #[test]
    fn days_are_utc_calendar_days() {
        assert_eq!(day_of_unix(0), "1970-01-01");
        assert_eq!(day_of_unix(1_790_553_599), "2026-09-27"); // 23:59:59 UTC
        assert_eq!(day_of_unix(1_790_553_600), "2026-09-28"); // midnight rolls over
        assert_eq!(day_string(day_number("2028-02-29").unwrap() + 1), "2028-03-01");
        assert_eq!(day_string(day_number("2026-12-31").unwrap() + 1), "2027-01-01");
        assert_eq!(day_number("2026-02-30"), None);
        assert_eq!(day_number("2026-9-28"), None);
        assert_eq!(day_number("../../etc"), None);
    }

    #[test]
    fn counters_count_known_keys_per_day_only() {
        let mut c = Counters::default();
        assert!(c.add("2026-09-27", "app.start", 1));
        assert!(c.add("2026-09-27", "app.start", 2));
        assert!(c.add("2026-09-28", "app.start", 1));
        assert!(c.add("2026-09-28", "app.update_from.0.4.3", 1));
        assert!(c.add("2026-09-28", "app.update_from.unknown", 1));
        assert_eq!(c.days["2026-09-27"]["app.start"], 3);
        assert_eq!(c.days["2026-09-28"]["app.start"], 1);
        // nothing that is not in api/_ping-schema.json
        for bad in ["patch_antenna", "/Users/me/design.json", "param.W", "me@example.com", "app.update_from.0.4.3/../x", "app.update_from.1234.0.0", ""] {
            assert!(!c.add("2026-09-28", bad, 1), "{bad} was counted");
        }
        assert!(!c.add("yesterday", "app.start", 1));
        // capped
        c.add("2026-09-28", "sim.started.gpu.python", u64::MAX);
        assert_eq!(c.days["2026-09-28"]["sim.started.gpu.python"], schema().max_value);
    }

    #[test]
    fn day_rollover_sends_only_whole_previous_days_oldest_first() {
        let mut state = State::default();
        state.ensure_id();
        let mut shell = Counters::default();
        shell.add("2026-09-26", "app.start", 1);
        shell.add("2026-09-27", "app.start", 4);
        shell.add("2026-09-28", "app.start", 1);
        let mut server = Counters::default();
        server.add("2026-09-27", "sim.finished.cpu.design", 2);
        server.add("2026-09-28", "sim.finished.cpu.design", 9);
        let (day, p) = next_ping(&state, &shell, &server, "2026-09-28", &meta()).unwrap();
        assert_eq!(day, "2026-09-26");
        assert_eq!(p["counters"], json!({"app.start": 1}));
        state.sent_through = Some("2026-09-26".into());
        let (day, p) = next_ping(&state, &shell, &server, "2026-09-28", &meta()).unwrap();
        assert_eq!(day, "2026-09-27");
        assert_eq!(p["counters"], json!({"app.start": 4, "sim.finished.cpu.design": 2}));
        state.sent_through = Some("2026-09-27".into());
        // today is never sent, however much it holds
        assert!(next_ping(&state, &shell, &server, "2026-09-28", &meta()).is_none());
        // the next UTC day it is
        assert_eq!(next_ping(&state, &shell, &server, "2026-09-29", &meta()).unwrap().0, "2026-09-28");
        // too old to send
        let mut old = Counters::default();
        old.add("2026-07-01", "app.start", 1);
        assert!(next_ping(&State { sent_through: None, ..state.clone() }, &old, &Counters::default(), "2026-09-28", &meta()).is_none());
        old.prune("2026-09-28", None);
        assert!(old.days.is_empty());
    }

    #[test]
    fn payload_has_the_schema_fields_and_nothing_else() {
        let mut counts = BTreeMap::new();
        counts.insert("sim.started.cpu.design".to_string(), 2);
        counts.insert("/Users/ada/Documents/fairbeam/models/secret.design.json".to_string(), 1);
        counts.insert("param.patch_width".to_string(), 1);
        counts.insert("user@example.com".to_string(), 1);
        counts.insert("monitor.far_field".to_string(), 0);
        let id = new_install_id();
        let p = payload(&id, true, &meta(), "2026-09-27", &counts);
        let keys: Vec<&String> = p.as_object().unwrap().keys().collect();
        let mut expected: Vec<&String> = schema().fields.iter().collect();
        let mut got = keys.clone();
        got.sort();
        expected.sort();
        assert_eq!(got, expected);
        assert_eq!(p["counters"], json!({"sim.started.cpu.design": 2}));
        assert_eq!(p["schema"], SCHEMA_ID);
        assert!(valid_uuid(p["install_id"].as_str().unwrap()));
        // no path, e-mail or user name can be in there: only the schema id has a slash
        let mut rest = p.clone();
        rest.as_object_mut().unwrap().remove("schema");
        let text = rest.to_string();
        for forbidden in ['/', '\\', '@', ' '] {
            assert!(!text.contains(forbidden), "{forbidden:?} in {text}");
        }
        if let Ok(user) = std::env::var("USER") {
            if user.len() > 3 {
                assert!(!text.contains(&user));
            }
        }
    }

    #[test]
    fn install_ids_are_random_v4_uuids() {
        let a = new_install_id();
        let b = new_install_id();
        assert_ne!(a, b);
        assert!(valid_uuid(&a) && valid_uuid(&b));
        let mut s = State { install_id: Some("not-a-uuid".into()), ..State::default() };
        assert!(valid_uuid(s.ensure_id()));
    }

    #[test]
    fn switch_off_never_sends_or_reads() {
        let d = seeded("off");
        let before = fs::read_to_string(d.join(STATE_FILE)).unwrap();
        let cases = [
            Switch { build_enabled: false, env_disabled: false, consent: Some("granted".into()) },
            Switch { build_enabled: true, env_disabled: true, consent: Some("granted".into()) },
            Switch { build_enabled: true, env_disabled: false, consent: None },
            Switch { build_enabled: true, env_disabled: false, consent: Some("denied".into()) },
        ];
        for sw in cases {
            let fake = Fake::new(Ok(200));
            assert_eq!(send_due(&d, &sw, &meta(), "2026-09-28", &fake), Outcome::Off);
            assert!(fake.calls.borrow().is_empty());
        }
        assert_eq!(fs::read_to_string(d.join(STATE_FILE)).unwrap(), before);
        // the build switch of this test binary: the default build has no HTTP client
        assert_eq!(BUILD_ENABLED, cfg!(feature = "telemetry"));
        if !BUILD_ENABLED {
            assert!(http_transport().is_none());
            assert!(!Switch { build_enabled: BUILD_ENABLED, env_disabled: false, consent: Some("granted".into()) }.active());
        }
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn environment_opt_out_values() {
        assert!(env_disabled_value(Some("1")));
        assert!(env_disabled_value(Some("true")));
        assert!(!env_disabled_value(Some("0")));
        assert!(!env_disabled_value(Some("")));
        assert!(!env_disabled_value(None));
    }

    #[test]
    fn one_post_per_day_and_sent_days_are_dropped() {
        let d = seeded("send");
        let fake = Fake::new(Ok(202));
        assert_eq!(send_due(&d, &granted(), &meta(), "2026-09-28", &fake), Outcome::Sent("2026-09-27".into()));
        let sent: Value = serde_json::from_str(&fake.calls.borrow()[0]).unwrap();
        assert_eq!(sent["day"], "2026-09-27");
        assert_eq!(sent["counters"], json!({"app.start": 2, "sim.started.cpu.design": 3}));
        // the same day again: no second POST
        assert_eq!(send_due(&d, &granted(), &meta(), "2026-09-28", &fake), Outcome::AlreadyTried);
        assert_eq!(fake.calls.borrow().len(), 1);
        let state = State::load(&d);
        assert_eq!(state.sent_through.as_deref(), Some("2026-09-27"));
        let shell = Counters::load(&d.join(SHELL_FILE));
        assert!(!shell.days.contains_key("2026-09-27"));
        assert!(shell.days.contains_key("2026-09-28"));
        // next day: today's (then yesterday's) counts go
        assert_eq!(send_due(&d, &granted(), &meta(), "2026-09-29", &fake), Outcome::Sent("2026-09-28".into()));
        // nothing left, and no request for nothing
        assert_eq!(send_due(&d, &granted(), &meta(), "2026-09-30", &fake), Outcome::Nothing);
        assert_eq!(fake.calls.borrow().len(), 2);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn failures_keep_the_counts_for_the_next_day() {
        let d = seeded("fail");
        for answer in [Err("offline".to_string()), Ok(503), Ok(429)] {
            let fake = Fake::new(answer);
            let mut state = State::load(&d);
            state.last_attempt_day = None;
            write_json(&d.join(STATE_FILE), &state).unwrap();
            assert!(matches!(send_due(&d, &granted(), &meta(), "2026-09-28", &fake), Outcome::Failed(_)));
            assert_eq!(State::load(&d).sent_through, None);
            assert!(Counters::load(&d.join(SHELL_FILE)).days.contains_key("2026-09-27"));
            // and not again the same day
            assert_eq!(send_due(&d, &granted(), &meta(), "2026-09-28", &fake), Outcome::AlreadyTried);
        }
        let fake = Fake::new(Ok(200));
        assert_eq!(send_due(&d, &granted(), &meta(), "2026-09-29", &fake), Outcome::Sent("2026-09-27".into()));
        // a refused day does not block the next ones
        let fake = Fake::new(Ok(400));
        assert_eq!(send_due(&d, &granted(), &meta(), "2026-09-30", &fake), Outcome::Rejected("2026-09-28".into(), 400));
        assert_eq!(State::load(&d).sent_through.as_deref(), Some("2026-09-28"));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn start_counts_install_and_updates() {
        assert_eq!(start_keys(None, "0.4.4", false), ["app.start", "app.install"]);
        assert_eq!(start_keys(None, "0.4.4", true), ["app.start", "app.update_from.unknown"]);
        assert_eq!(start_keys(Some("0.4.3"), "0.4.4", true), ["app.start", "app.update_from.0.4.3"]);
        assert_eq!(start_keys(Some("0.4.4"), "0.4.4", true), ["app.start"]);
        assert_eq!(start_keys(Some("0.5.0-beta.1"), "0.5.0", true), ["app.start", "app.update_from.unknown"]);
        for keys in [start_keys(None, "1", false), start_keys(Some("0.4.3"), "0.4.4", true)] {
            assert!(keys.iter().all(|k| key_allowed(k)));
        }
    }

    #[test]
    fn ui_events_are_schema_keys() {
        assert!(!schema().ui_events.is_empty());
        for e in &schema().ui_events {
            assert!(key_allowed(e), "{e}");
        }
        assert!(schema().keys.len() <= schema().max_keys);
    }
}
