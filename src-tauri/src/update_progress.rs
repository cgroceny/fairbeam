// Progress of the in-app update (docs/RELEASES.md): what the shell tells the viewer while an update
// downloads, installs and restarts, so the window does not look hung. The shell talks to the viewer
// the way it does for downloads: a `fairbeam:update` window event, plus `window.__fairbeamUpdate`
// holding the latest payload for a page that loads later (src/lib/updateProgress.ts reads both).
// No command and no capability is involved: the shell only evaluates a small script in the window.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::shelllog;

/// At most this often between two download updates (about 10 per second).
pub const MIN_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq)]
pub enum Phase<'a> {
    Downloading { version: &'a str, downloaded: u64, total: Option<u64> },
    Installing { version: &'a str },
    Restarting { version: &'a str },
    /// hides the indicator; the failure dialog (updater.rs `fail`) is the error UI
    Failed,
}

impl Phase<'_> {
    pub fn payload(&self) -> Value {
        match self {
            Phase::Downloading { version, downloaded, total } => {
                json!({ "phase": "downloading", "version": version, "downloaded": downloaded, "total": total })
            }
            Phase::Installing { version } => json!({ "phase": "installing", "version": version }),
            Phase::Restarting { version } => json!({ "phase": "restarting", "version": version }),
            Phase::Failed => json!({ "phase": "failed" }),
        }
    }
}

/// The script that hands a payload to the viewer. The payload is JSON, which is also valid JS.
pub fn script(payload: &Value) -> String {
    format!(
        "window.__fairbeamUpdate = {payload}; window.dispatchEvent(new CustomEvent('fairbeam:update', {{ detail: {payload} }}))"
    )
}

/// Send a phase to the main window (a no-op while the window is not there or the page is not loaded).
pub fn emit(app: &AppHandle, phase: &Phase) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval(script(&phase.payload()));
    }
}

/// Send a phase and leave one line in shell.log. Used for the phases, never per chunk.
pub fn announce(app: &AppHandle, phase: &Phase, line: &str) {
    shelllog::write(app, line);
    emit(app, phase);
}

/// Lets a download update through at most once per `MIN_INTERVAL`, but always the first and the
/// last (the byte count has reached the content length).
pub struct Throttle {
    every: Duration,
    last: Option<Instant>,
}

impl Throttle {
    pub fn new(every: Duration) -> Self {
        Throttle { every, last: None }
    }

    pub fn allow(&mut self, now: Instant, downloaded: u64, total: Option<u64>) -> bool {
        let finished = total.is_some_and(|t| t > 0 && downloaded >= t);
        let due = self.last.map_or(true, |l| now.saturating_duration_since(l) >= self.every);
        if due || finished {
            self.last = Some(now);
            true
        } else {
            false
        }
    }
}

/// Running byte count of one download, fed from the updater's chunk callback.
pub struct Download {
    throttle: Throttle,
    downloaded: u64,
    total: Option<u64>,
}

impl Download {
    pub fn new() -> Self {
        Download { throttle: Throttle::new(MIN_INTERVAL), downloaded: 0, total: None }
    }

    /// One chunk arrived: `Some((downloaded, total))` when the viewer should hear about it now.
    pub fn chunk(&mut self, now: Instant, len: usize, total: Option<u64>) -> Option<(u64, Option<u64>)> {
        self.downloaded += len as u64;
        // a content length of 0 is "unknown" (a chunked response)
        self.total = total.filter(|t| *t > 0);
        self.throttle
            .allow(now, self.downloaded, self.total)
            .then_some((self.downloaded, self.total))
    }

    /// The download is complete: the final numbers (the viewer then shows 100 % before installing).
    pub fn finish(&self) -> (u64, Option<u64>) {
        match self.total {
            Some(t) => (t, Some(t)),
            None => (self.downloaded, None),
        }
    }
}

/// Debug builds cannot reach the release feed. With FAIRBEAM_FAKE_UPDATE=1, Help › Check for
/// updates plays the whole sequence for a made-up 0.0.0-demo update (a 48 MB download, install,
/// restart, then back to normal) so the indicator can be seen without a release. Nothing is
/// stopped, downloaded or installed.
#[cfg(debug_assertions)]
pub fn demo_enabled() -> bool {
    std::env::var("FAIRBEAM_FAKE_UPDATE").as_deref() == Ok("1")
}

#[cfg(debug_assertions)]
pub fn demo(app: AppHandle) {
    let version = "0.0.0-demo";
    std::thread::spawn(move || {
        let total: u64 = 48_000_000;
        let mut download = Download::new();
        shelllog::write(&app, &format!("update demo: downloading {version}"));
        let mut sent = 0u64;
        while sent < total {
            let len = 400_000usize.min((total - sent) as usize);
            sent += len as u64;
            if let Some((downloaded, t)) = download.chunk(Instant::now(), len, Some(total)) {
                emit(&app, &Phase::Downloading { version, downloaded, total: t });
            }
            std::thread::sleep(Duration::from_millis(60));
        }
        let (downloaded, t) = download.finish();
        emit(&app, &Phase::Downloading { version, downloaded, total: t });
        std::thread::sleep(Duration::from_millis(400));
        announce(&app, &Phase::Installing { version }, &format!("update demo: installing {version}"));
        std::thread::sleep(Duration::from_millis(2500));
        announce(&app, &Phase::Restarting { version }, &format!("update demo: restarting {version}"));
        std::thread::sleep(Duration::from_millis(2500));
        announce(&app, &Phase::Failed, "update demo: done");
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ms: u64, base: Instant) -> Instant {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn first_update_always_passes_and_the_rest_wait() {
        let t0 = Instant::now();
        let mut t = Throttle::new(MIN_INTERVAL);
        assert!(t.allow(at(0, t0), 10, Some(1000)));
        assert!(!t.allow(at(30, t0), 20, Some(1000)));
        assert!(!t.allow(at(99, t0), 30, Some(1000)));
        assert!(t.allow(at(100, t0), 40, Some(1000)));
        assert!(!t.allow(at(150, t0), 50, Some(1000)));
    }

    #[test]
    fn the_last_update_always_passes() {
        let t0 = Instant::now();
        let mut t = Throttle::new(MIN_INTERVAL);
        assert!(t.allow(at(0, t0), 10, Some(100)));
        assert!(!t.allow(at(10, t0), 90, Some(100)));
        assert!(t.allow(at(11, t0), 100, Some(100)));
    }

    #[test]
    fn an_unknown_length_is_never_finished() {
        let t0 = Instant::now();
        let mut t = Throttle::new(MIN_INTERVAL);
        assert!(t.allow(at(0, t0), 5, None));
        assert!(!t.allow(at(1, t0), 5_000_000, None));
        assert!(!t.allow(at(2, t0), 5_000_000, Some(0)));
    }

    #[test]
    fn a_fast_download_is_reported_about_ten_times_a_second() {
        let t0 = Instant::now();
        let mut d = Download::new();
        let mut sent = 0;
        for i in 0..2000u64 {
            // 2000 chunks in two seconds
            if d.chunk(at(i, t0), 1000, Some(3_000_000)).is_some() {
                sent += 1;
            }
        }
        assert!((18..=22).contains(&sent), "{sent} updates in two seconds");
        // the first one carries the first chunk
        let mut d = Download::new();
        assert_eq!(d.chunk(t0, 1000, Some(3_000_000)), Some((1000, Some(3_000_000))));
    }

    #[test]
    fn the_final_chunk_is_reported_and_finish_agrees() {
        let t0 = Instant::now();
        let mut d = Download::new();
        assert!(d.chunk(t0, 400, Some(1000)).is_some());
        assert!(d.chunk(at(1, t0), 400, Some(1000)).is_none());
        assert_eq!(d.chunk(at(2, t0), 200, Some(1000)), Some((1000, Some(1000))));
        assert_eq!(d.finish(), (1000, Some(1000)));
    }

    #[test]
    fn a_zero_content_length_means_unknown() {
        let t0 = Instant::now();
        let mut d = Download::new();
        assert_eq!(d.chunk(t0, 10, Some(0)), Some((10, None)));
        assert_eq!(d.finish(), (10, None));
    }

    #[test]
    fn payloads_have_the_shape_the_viewer_reads() {
        let p = Phase::Downloading { version: "0.7.0", downloaded: 5, total: Some(10) }.payload();
        assert_eq!(p, json!({"phase": "downloading", "version": "0.7.0", "downloaded": 5, "total": 10}));
        let p = Phase::Downloading { version: "0.7.0", downloaded: 5, total: None }.payload();
        assert_eq!(p["total"], Value::Null);
        assert_eq!(Phase::Installing { version: "0.7.0" }.payload()["phase"], "installing");
        assert_eq!(Phase::Restarting { version: "0.7.0" }.payload()["phase"], "restarting");
        assert_eq!(Phase::Failed.payload(), json!({"phase": "failed"}));
    }

    #[test]
    fn the_script_sets_the_global_and_fires_the_event() {
        let s = script(&Phase::Installing { version: "0.7.0" }.payload());
        assert!(s.contains("window.__fairbeamUpdate = {"));
        assert!(s.contains("new CustomEvent('fairbeam:update'"));
        // a version is data, never code
        let s = script(&Phase::Installing { version: "1');alert(1);//" }.payload());
        assert!(s.contains(r#""1');alert(1);//""#));
    }
}
