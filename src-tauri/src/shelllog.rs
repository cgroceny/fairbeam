// The shell's own log (docs/DESKTOP.md "Folders"): <app data>/logs/shell.log, one line per event
// with a UTC timestamp, append only. server.log is the server's redirected output, so the shell
// never writes there. Past 1 MB the file is moved to shell.log.1 (replacing the older one).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::AppHandle;

const MAX_BYTES: u64 = 1024 * 1024;

pub fn write(app: &AppHandle, line: &str) {
    append(&crate::paths::logs_dir(app), line);
}

fn append(dir: &Path, line: &str) {
    let path = dir.join("shell.log");
    if fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("shell.log.1"));
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} {line}", utc_now());
    }
}

/// 2026-09-25T19:04:05Z (std has no calendar: days since 1970 to a civil date, H. Hinnant's
/// algorithm).
fn utc_now() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    utc(secs)
}

fn utc(secs: u64) -> String {
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_dates() {
        assert_eq!(utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(utc(1_790_362_245), "2026-09-25T18:50:45Z");
    }

    #[test]
    fn appends_and_rotates() {
        let dir = std::env::temp_dir().join(format!("fairbeam-shelllog-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        append(&dir, "first");
        append(&dir, "second");
        let text = fs::read_to_string(dir.join("shell.log")).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with("Z first") && lines[1].ends_with("Z second"));
        fs::write(dir.join("shell.log"), vec![b'x'; MAX_BYTES as usize + 1]).unwrap();
        append(&dir, "third");
        assert!(fs::read_to_string(dir.join("shell.log")).unwrap().ends_with("Z third\n"));
        assert_eq!(fs::metadata(dir.join("shell.log.1")).unwrap().len(), MAX_BYTES + 1);
        fs::remove_dir_all(&dir).unwrap();
    }
}
