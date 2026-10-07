// Minimal local consent and weekly scheduling. No identifiers or feature counters.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::Path};

pub const SCHEMA_ID: &str = "fairbeam.ping/2";
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
    // Time of the last attempted request, saved before sending. Failed requests also wait a week.
    pub last_sent: Option<u64>,
}
impl State {
    pub fn load(dir: &Path) -> Self {
        let value: Value = fs::read(dir.join("state.json")).ok()
            .and_then(|s| serde_json::from_slice(&s).ok()).unwrap_or(Value::Null);
        // Old consent covered a different report. Require a fresh choice and discard old data.
        if value.get("install_id").is_some() { return Self::default(); }
        serde_json::from_value(value).unwrap_or_default()
    }
    pub fn save(&self, dir: &Path) -> Result<(), String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join("state.json.tmp");
        fs::write(&tmp, serde_json::to_vec(self).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        fs::rename(tmp, dir.join("state.json")).map_err(|e| e.to_string())
    }
    pub fn active(&self, build: bool, disabled: bool) -> bool {
        build && !disabled && self.consent.as_deref() == Some("granted")
    }
    pub fn due(&self, now: u64) -> bool {
        self.last_sent.is_none_or(|last| now.checked_sub(last).is_some_and(|age| age >= WEEK))
    }
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
    let status = post(&body.to_string())?;
    if !(200..300).contains(&status) { return Err(format!("HTTP {status}")); }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn concurrent_senders_share_one_weekly_request() {
        use std::sync::{Arc, Barrier, atomic::{AtomicUsize, Ordering}};
        let dir = std::env::temp_dir().join(format!("fairbeam-concurrent-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        State { consent: Some("granted".into()), last_sent: None }.save(&dir).unwrap();
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
        let post = |_: &str| { calls.set(calls.get()+1); Ok(202) };
        assert!(!send_due(&dir, false, false, 100, &p, post).unwrap());
        assert!(!dir.exists());
        assert!(!send_due(&dir, true, false, 100, &p, post).unwrap());
        State { consent: Some("granted".into()), last_sent: None }.save(&dir).unwrap();
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
        assert!(!fs::read_to_string(dir.join("state.json")).unwrap().contains("install_id"));
        let blocked = dir.join("not-a-folder");
        fs::write(&blocked, "file").unwrap();
        assert!(State { consent: Some("granted".into()), last_sent: None }.save(&blocked).is_err());
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
