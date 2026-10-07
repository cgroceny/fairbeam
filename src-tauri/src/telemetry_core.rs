// Local install-count consent, random identity and weekly scheduling.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::Path};

pub const SCHEMA_ID: &str = "fairbeam.ping/3";
pub const WEEK: u64 = 7 * 86_400;

// An empty OS lock file serializes processes sharing the same local installation state.
// Holding the file keeps the lock alive; dropping it releases the lock even on process exit.
pub struct StateLock { _file: fs::File }
pub fn lock(dir: &Path) -> Result<StateLock, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .open(dir.join("state.lock")).map_err(|e| e.to_string())?;
    file.lock().map_err(|e| e.to_string())?;
    Ok(StateLock { _file: file })
}

#[derive(Default, Serialize, Deserialize)]
pub struct State {
    pub consent: Option<String>,
    pub install_id: Option<String>,
    pub consent_schema: Option<String>,
    // Time of the last attempted request, saved before sending. Failed requests also wait a week.
    pub last_sent: Option<u64>,
}
impl State {
    pub fn load(dir: &Path) -> Self {
        let value: Value = fs::read(dir.join("state.json")).ok()
            .and_then(|s| serde_json::from_slice(&s).ok()).unwrap_or(Value::Null);
        // Old consent covered a different report. Require a fresh choice and discard old data.
        if value.get("consent_schema").and_then(Value::as_str) != Some(SCHEMA_ID) {
            return Self { last_sent: value.get("last_sent").and_then(Value::as_u64), ..Self::default() };
        }
        serde_json::from_value(value).unwrap_or_default()
    }
    pub fn save(&self, dir: &Path) -> Result<(), String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join("state.json.tmp");
        fs::write(&tmp, serde_json::to_vec(self).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        fs::rename(tmp, dir.join("state.json")).map_err(|e| e.to_string())
    }
    pub fn set_consent(&mut self, granted: bool) -> Result<(), String> {
        if granted && (self.consent.as_deref() != Some("granted") || self.install_id.is_none()) {
            self.install_id = Some(random_id()?);
        }
        if !granted { self.install_id = None; }
        self.consent = Some(if granted { "granted" } else { "denied" }.into());
        self.consent_schema = Some(SCHEMA_ID.into());
        Ok(())
    }
    pub fn reset_id(&mut self) -> Result<(), String> {
        if self.consent.as_deref() == Some("granted") { self.install_id = Some(random_id()?); }
        Ok(())
    }
    pub fn active(&self, build: bool, disabled: bool) -> bool {
        build && !disabled && self.consent.as_deref() == Some("granted") && self.install_id.is_some()
    }
    pub fn due(&self, now: u64) -> bool {
        self.last_sent.is_none_or(|last| now.checked_sub(last).is_some_and(|age| age >= WEEK))
    }
}
#[cfg(not(any(feature = "telemetry", test)))]
pub fn random_id() -> Result<String, String> { Err("Install counting is disabled".into()) }
#[cfg(any(feature = "telemetry", test))]
pub fn random_id() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    Ok(format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}", b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9],b[10],b[11],b[12],b[13],b[14],b[15]))
}
pub fn payload(version: &str, os: &str, arch: &str) -> Value {
    json!({"schema": SCHEMA_ID, "app_version": version, "os": os, "arch": arch})
}
pub fn env_disabled_value(v: Option<&str>) -> bool {
    v.is_some_and(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "" | "0" | "false" | "no"))
}
// The caller holds the same lock as consent changes until the request finishes.
pub fn send_due(dir: &Path, build: bool, disabled: bool, now: u64, body: &Value,
                post: impl FnOnce(&str) -> Result<u16, String>) -> Result<bool, String> {
    if !build || disabled { return Ok(false); }
    let _lock = lock(dir)?;
    let mut state = State::load(dir);
    if !state.active(build, disabled) || !state.due(now) { return Ok(false); }
    state.last_sent = Some(now);
    state.save(dir)?;
    let mut body = body.clone();
    body["install_id"] = json!(state.install_id);
    let status = post(&body.to_string())?;
    if !(200..300).contains(&status) { return Err(format!("HTTP {status}")); }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn identity_lifecycle() {
        let mut s = State::default();
        assert!(s.install_id.is_none());
        s.set_consent(false).unwrap();
        assert!(s.install_id.is_none());
        s.set_consent(true).unwrap();
        let first = s.install_id.clone().unwrap();
        assert_eq!(first.len(), 36); assert_eq!(&first[14..15], "4");
        assert!(matches!(&first[19..20], "8" | "9" | "a" | "b"));
        s.last_sent = Some(100);
        s.set_consent(true).unwrap(); assert_eq!(s.install_id.as_ref(), Some(&first));
        s.reset_id().unwrap(); assert_ne!(s.install_id.as_ref(), Some(&first));
        let second = s.install_id.clone();
        s.set_consent(false).unwrap(); assert!(s.install_id.is_none());
        s.set_consent(true).unwrap(); assert_ne!(s.install_id, second);
        assert_eq!(s.last_sent, Some(100));
    }
    #[test]
    fn concurrent_senders_share_one_weekly_request() {
        use std::sync::{Arc, Barrier, atomic::{AtomicUsize, Ordering}};
        let dir = std::env::temp_dir().join(format!("fairbeam-concurrent-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        State { consent: Some("granted".into()), install_id: Some(random_id().unwrap()), consent_schema: Some(SCHEMA_ID.into()), last_sent: None }.save(&dir).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let calls = Arc::new(AtomicUsize::new(0));
        let handles: Vec<_> = (0..2).map(|_| {
            let dir = dir.clone();
            let barrier = barrier.clone();
            let calls = calls.clone();
            std::thread::spawn(move || {
                barrier.wait();
                send_due(&dir, true, false, WEEK, &payload("0.7.0", "linux", "x86_64"), |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(202)
                }).unwrap();
            })
        }).collect();
        for h in handles { h.join().unwrap(); }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn gates_and_weekly_attempts() {
        let dir = std::env::temp_dir().join(format!("fairbeam-weekly-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let p = payload("0.7.0", "linux", "x86_64");
        let calls = Cell::new(0);
        let post = |body: &str| {
            let body: Value = serde_json::from_str(body).unwrap();
            assert_eq!(body.as_object().unwrap().len(), 5);
            assert!(body["install_id"].as_str().is_some());
            calls.set(calls.get()+1); Ok(202)
        };
        assert!(!send_due(&dir, false, false, 100, &p, post).unwrap());
        assert!(!dir.exists());
        assert!(!send_due(&dir, true, false, 100, &p, post).unwrap());
        State { consent: Some("granted".into()), install_id: Some(random_id().unwrap()), consent_schema: Some(SCHEMA_ID.into()), last_sent: None }.save(&dir).unwrap();
        assert!(!send_due(&dir, true, true, 100, &p, post).unwrap());
        assert!(send_due(&dir, true, false, 100, &p, post).unwrap());
        assert!(!send_due(&dir, true, false, 99, &p, post).unwrap());
        assert!(!send_due(&dir, true, false, 100+WEEK-1, &p, post).unwrap());
        assert!(send_due(&dir, true, false, 100+WEEK, &p, |_| Err("offline".into())).is_err());
        assert!(!send_due(&dir, true, false, 101+WEEK, &p, post).unwrap());
        let mut s = State::load(&dir);
        s.consent = Some("denied".into()); s.save(&dir).unwrap();
        assert!(!send_due(&dir, true, false, 100+2*WEEK, &p, post).unwrap());
        s.consent = Some("granted".into()); s.save(&dir).unwrap();
        assert!(!send_due(&dir, true, false, 101+WEEK, &p, post).unwrap());
        assert_eq!(calls.get(), 1);
        assert_eq!(p.as_object().unwrap().len(), 4);
        fs::write(dir.join("state.json"), r#"{"install_id":"old","consent":"granted"}"#).unwrap();
        assert!(State::load(&dir).consent.is_none());
        State::load(&dir).save(&dir).unwrap();
        assert!(State::load(&dir).install_id.is_none());
        let blocked = dir.join("not-a-folder");
        fs::write(&blocked, "file").unwrap();
        assert!(State { consent: Some("granted".into()), install_id: Some(random_id().unwrap()), consent_schema: Some(SCHEMA_ID.into()), last_sent: None }.save(&blocked).is_err());
        assert_eq!(calls.get(), 1);
        for v in [None, Some(""), Some("0"), Some("false"), Some("no")] {
            assert!(!env_disabled_value(v));
        }
        for v in [Some("1"), Some("true"), Some(" YES ")] {
            assert!(env_disabled_value(v));
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
