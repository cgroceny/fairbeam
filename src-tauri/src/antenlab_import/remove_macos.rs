// macOS: antenlab's app bundles and data folders go to the Trash (NSFileManager trashItemAtURL),
// never a permanent delete. The keychain item is left alone. A bundle that cannot be moved (App
// Management, a standard user in /Applications) is shown in Finder instead.

use std::ffi::{CStr, CString};
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::detect::{Legacy, Roots, LEGACY_ID};
use super::Step;

pub const BUNDLE: &str = "antenlab.app";
const EXECUTABLE: &str = "antenlab";

/// The usual install places: /Applications and ~/Applications.
pub fn bundle_candidates(roots: &Roots) -> Vec<PathBuf> {
    vec![Path::new("/Applications").join(BUNDLE), roots.home.join("Applications").join(BUNDLE)]
}

/// Bundles with antenlab's identifier anywhere Spotlight knows of.
fn spotlight_bundles() -> Vec<PathBuf> {
    let query = format!("kMDItemCFBundleIdentifier == \"{LEGACY_ID}\"");
    let Ok(out) = Command::new("/usr/bin/mdfind").arg(&query).output() else { return Vec::new() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.ends_with(".app"))
        .map(PathBuf::from)
        .collect()
}

/// antenlab bundles that may go to the Trash. `thorough` adds Spotlight's results.
pub fn find_bundles(roots: &Roots, thorough: bool) -> Vec<PathBuf> {
    let running = crate::macos_update::bundle_path();
    let mut candidates = bundle_candidates(roots);
    if thorough {
        candidates.extend(spotlight_bundles());
    }
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for c in candidates {
        let key = fs::canonicalize(&c).unwrap_or_else(|_| c.clone());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        if is_legacy_bundle(&c, running.as_deref(), LEGACY_ID) {
            out.push(c);
        }
    }
    out
}

/// A real folder (not a link), not the running bundle, in a place the user installed it to (not
/// in the Trash, not translocated, not a build output, not on a read-only volume such as a mounted
/// disk image), whose Info.plist has `identifier`.
pub fn is_legacy_bundle(candidate: &Path, running: Option<&Path>, identifier: &str) -> bool {
    let Ok(meta) = fs::symlink_metadata(candidate) else { return false };
    if !meta.is_dir() {
        return false;
    }
    let Ok(canon) = fs::canonicalize(candidate) else { return false };
    if let Some(running) = running {
        if fs::canonicalize(running).is_ok_and(|r| r == canon) {
            return false;
        }
    }
    let text = canon.to_string_lossy();
    if text.contains("/.Trash/") || text.contains("/AppTranslocation/") || is_build_output(&canon) {
        return false;
    }
    if read_only_volume(&canon) {
        return false;
    }
    bundle_identifier(&candidate.join("Contents/Info.plist")).as_deref() == Some(identifier)
}

/// `…/target/<profile>/bundle/macos/antenlab.app`: a developer's build, not an install.
fn is_build_output(p: &Path) -> bool {
    let parts: Vec<&std::ffi::OsStr> = p.iter().collect();
    parts.iter().position(|c| *c == "target").is_some_and(|i| parts[i + 1..].iter().any(|c| *c == "bundle"))
}

fn read_only_volume(p: &Path) -> bool {
    let Ok(c) = CString::new(p.as_os_str().as_bytes()) else { return true };
    // SAFETY: a NUL-terminated path and a zeroed statfs the call fills in
    unsafe {
        let mut st: libc::statfs = std::mem::zeroed();
        if libc::statfs(c.as_ptr(), &mut st) != 0 {
            return false;
        }
        st.f_flags & (libc::MNT_RDONLY as u32) != 0
    }
}

/// CFBundleIdentifier of an Info.plist (XML, or binary through plutil).
pub fn bundle_identifier(plist: &Path) -> Option<String> {
    let bytes = fs::read(plist).ok()?;
    let xml = if bytes.starts_with(b"bplist") {
        let out = Command::new("/usr/bin/plutil").args(["-convert", "xml1", "-o", "-"]).arg(plist).output().ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8(out.stdout).ok()?
    } else {
        String::from_utf8(bytes).ok()?
    };
    identifier_in_xml(&xml)
}

/// The `<string>` right after `<key>CFBundleIdentifier</key>` in an XML property list.
pub fn identifier_in_xml(xml: &str) -> Option<String> {
    let key = "<key>CFBundleIdentifier</key>";
    let after = &xml[xml.find(key)? + key.len()..];
    let rest = after.trim_start().strip_prefix("<string>")?;
    Some(rest[..rest.find("</string>")?].trim().to_string())
}

/// antenlab runs (any process named exactly `antenlab`, other than this one).
pub fn antenlab_running() -> bool {
    let Ok(out) = Command::new("/usr/bin/pgrep").args(["-x", EXECUTABLE]).output() else { return false };
    let me = std::process::id();
    String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.trim().parse::<u32>().ok()).any(|pid| pid != me)
}

/// Move every bundle and data path to the Trash. One step per path.
pub fn remove(legacy: &Legacy) -> Vec<Step> {
    let mut steps = Vec::new();
    for bundle in &legacy.bundles {
        match trash(bundle) {
            Ok(()) => steps.push(Step::ok("trash", bundle.display().to_string())),
            Err(e) => {
                let _ = Command::new("/usr/bin/open").arg("-R").arg(bundle).spawn();
                steps.push(Step::failed("trash", format!("{}: {e} (shown in Finder)", bundle.display())));
            }
        }
    }
    for path in &legacy.data {
        if fs::symlink_metadata(path).is_err() {
            continue;
        }
        match trash(path) {
            Ok(()) => steps.push(Step::ok("trash", path.display().to_string())),
            Err(e) => steps.push(Step::failed("trash", format!("{}: {e}", path.display()))),
        }
    }
    steps
}

/// NSFileManager trashItemAtURL: the item goes to the Trash (it can be put back), never deleted.
pub fn trash(path: &Path) -> Result<(), String> {
    use std::ffi::{c_char, c_void};
    type Id = *mut c_void;
    type Sel = *const c_void;
    // BOOL is `bool` on arm64 and `signed char` on x86_64: one byte either way
    type Bool = i8;
    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(pool: *mut c_void);
    }
    #[link(name = "Foundation", kind = "framework")]
    extern "C" {}

    let c_path = CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    // SAFETY: objc_msgSend is called through the exact signature of each method; the objects are
    // autoreleased and the pool is drained before returning
    unsafe {
        let send = objc_msgSend as unsafe extern "C" fn();
        let msg0: unsafe extern "C" fn(Id, Sel) -> Id = std::mem::transmute(send);
        let utf8: unsafe extern "C" fn(Id, Sel) -> *const c_char = std::mem::transmute(send);
        let file_url: unsafe extern "C" fn(Id, Sel, *const c_char, Bool, Id) -> Id = std::mem::transmute(send);
        let trash_item: unsafe extern "C" fn(Id, Sel, Id, *mut Id, *mut Id) -> Bool = std::mem::transmute(send);

        let pool = objc_autoreleasePoolPush();
        let result = (|| {
            let url = file_url(
                objc_getClass(c"NSURL".as_ptr()),
                sel_registerName(c"fileURLWithFileSystemRepresentation:isDirectory:relativeToURL:".as_ptr()),
                c_path.as_ptr(),
                1,
                std::ptr::null_mut(),
            );
            if url.is_null() {
                return Err("no file URL".to_string());
            }
            let manager = msg0(objc_getClass(c"NSFileManager".as_ptr()), sel_registerName(c"defaultManager".as_ptr()));
            let mut error: Id = std::ptr::null_mut();
            let ok = trash_item(
                manager,
                sel_registerName(c"trashItemAtURL:resultingItemURL:error:".as_ptr()),
                url,
                std::ptr::null_mut(),
                &mut error,
            );
            if ok != 0 {
                return Ok(());
            }
            if error.is_null() {
                return Err("NSFileManager did not say why".to_string());
            }
            let text = msg0(error, sel_registerName(c"localizedDescription".as_ptr()));
            let chars = if text.is_null() { std::ptr::null() } else { utf8(text, sel_registerName(c"UTF8String".as_ptr())) };
            Err(if chars.is_null() { "unknown error".to_string() } else { CStr::from_ptr(chars).to_string_lossy().into_owned() })
        })();
        objc_autoreleasePoolPop(pool);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::{roots_in, Temp};
    use super::*;

    fn fake_app(dir: &Path, name: &str, identifier: &str) -> PathBuf {
        let app = dir.join(name);
        fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        fs::write(
            app.join("Contents/Info.plist"),
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n<dict>\n  <key>CFBundleExecutable</key>\n  <string>antenlab</string>\n  <key>CFBundleIdentifier</key>\n  <string>{identifier}</string>\n</dict>\n</plist>\n"
            ),
        )
        .unwrap();
        fs::write(app.join("Contents/MacOS/antenlab"), "#!/bin/sh\n").unwrap();
        app
    }

    #[test]
    fn a_legacy_bundle_is_antenlab_and_not_the_running_app() {
        let t = Temp::new("macos-bundles");
        let running = fake_app(&t.path().join("Applications"), "Fairbeam.app", "org.fairbeam.desktop");
        let old = fake_app(&t.path().join("Applications"), BUNDLE, LEGACY_ID);
        assert!(is_legacy_bundle(&old, Some(&running), LEGACY_ID));
        assert!(is_legacy_bundle(&old, None, LEGACY_ID));
        assert!(!is_legacy_bundle(&old, Some(&old), LEGACY_ID), "never the running bundle");
        assert!(!is_legacy_bundle(&t.path().join("missing.app"), None, LEGACY_ID));
        // another app that happens to be called antenlab.app
        let foreign = fake_app(&t.path().join("Other"), BUNDLE, "com.example.antenlab");
        assert!(!is_legacy_bundle(&foreign, None, LEGACY_ID));
        // a link named antenlab.app is never trashed
        fs::create_dir_all(t.path().join("Links")).unwrap();
        std::os::unix::fs::symlink(&old, t.path().join("Links").join(BUNDLE)).unwrap();
        assert!(!is_legacy_bundle(&t.path().join("Links").join(BUNDLE), None, LEGACY_ID));
        // in the Trash, or a developer's build output
        let trashed = fake_app(&t.path().join(".Trash"), BUNDLE, LEGACY_ID);
        assert!(!is_legacy_bundle(&trashed, None, LEGACY_ID));
        let built = fake_app(&t.path().join("code/antenlab/src-tauri/target/release/bundle/macos"), BUNDLE, LEGACY_ID);
        assert!(!is_legacy_bundle(&built, None, LEGACY_ID));
        // a binary Info.plist is read through plutil
        let status = Command::new("/usr/bin/plutil")
            .args(["-convert", "binary1"])
            .arg(old.join("Contents/Info.plist"))
            .status()
            .unwrap();
        assert!(status.success());
        assert!(fs::read(old.join("Contents/Info.plist")).unwrap().starts_with(b"bplist"));
        assert!(is_legacy_bundle(&old, Some(&running), LEGACY_ID));
    }

    #[test]
    fn candidates_are_the_two_application_folders() {
        let t = Temp::new("macos-candidates");
        let roots = roots_in(t.path());
        assert_eq!(
            bundle_candidates(&roots),
            vec![PathBuf::from("/Applications/antenlab.app"), roots.home.join("Applications/antenlab.app")]
        );
        assert!(!read_only_volume(t.path()));
        assert!(read_only_volume(Path::new("/System")) || !Path::new("/System").exists());
    }

    #[test]
    fn identifier_from_xml() {
        let xml = "<dict><key>CFBundleName</key><string>antenlab</string>\n\t<key>CFBundleIdentifier</key>\n\t<string>dev.antenlab.desktop</string></dict>";
        assert_eq!(identifier_in_xml(xml).as_deref(), Some("dev.antenlab.desktop"));
        assert_eq!(identifier_in_xml("<dict><key>CFBundleIdentifier</key><integer>1</integer></dict>"), None);
        assert_eq!(identifier_in_xml("<dict></dict>"), None);
    }

    #[test]
    fn trash_reports_why_it_failed() {
        // the Objective-C calls run end to end without touching the user's Trash
        let t = Temp::new("macos-trash");
        let err = trash(&t.path().join("missing")).unwrap_err();
        assert!(!err.is_empty() && err != "unknown error", "{err}");
        // removal skips paths that are already gone
        let legacy = Legacy { data: vec![t.path().join("gone")], ..Legacy::default() };
        assert!(remove(&legacy).is_empty());
    }

    /// Manual: puts an empty temp folder into the current user's Trash
    /// (`cargo test -- --ignored trash_moves`).
    #[test]
    #[ignore]
    fn trash_moves_a_folder_to_the_trash() {
        let t = Temp::new("macos-trash-manual");
        let item = t.path().join("fairbeam-trash-test");
        fs::create_dir(&item).unwrap();
        trash(&item).unwrap();
        assert!(!item.exists());
    }
}
