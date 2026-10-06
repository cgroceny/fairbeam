// macOS update install that works when the app is not on the system volume (docs/RELEASES.md,
// "Updates on macOS").
//
// tauri-plugin-updater moves the running .app into the system temp folder before it puts the new
// one in place (`rename`). A rename cannot cross file systems, so an app on another volume (an
// external disk, a second APFS volume) fails with "Cross-device link (os error 18)". An app that
// macOS runs from App Translocation (opened from Downloads or a disk image without moving it) or
// from a mounted disk image is read-only and cannot be replaced at all.
//
// `location` tells those cases apart before anything is downloaded; `install_beside` is the
// fallback for EXDEV: the archive the plugin downloaded and verified against the updater key is
// unpacked next to the app (same volume) and swapped in with one atomic rename (RENAME_SWAP),
// or two renames where the file system cannot swap.

use std::ffi::{CStr, CString, OsStr};
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

const STAGING_PREFIX: &str = ".fairbeam-update-";
const PROBE_PREFIX: &str = ".fairbeam-write-test";

/// The running .app bundle: `<bundle>.app/Contents/MacOS/<exe>`, from the canonical executable
/// path, the same one the plugin replaces.
pub fn bundle_path() -> Option<PathBuf> {
    let exe = tauri::utils::platform::current_exe().ok()?;
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let ok = macos.file_name() == Some(OsStr::new("MacOS"))
        && contents.file_name() == Some(OsStr::new("Contents"))
        && bundle.extension() == Some(OsStr::new("app"));
    ok.then(|| bundle.to_path_buf())
}

#[derive(Debug, PartialEq, Eq)]
pub enum Location {
    /// the app can replace itself (possibly after an administrator prompt from the plugin)
    Writable,
    /// macOS runs a quarantined app from a read-only randomized copy until it is moved; the
    /// path is the user's original copy when macOS tells us where it is
    Translocated(Option<PathBuf>),
    /// the volume that holds the app is read-only (a mounted disk image, a read-only disk)
    ReadOnly,
}

pub fn location(bundle: &Path) -> Location {
    if bundle.to_string_lossy().contains("/AppTranslocation/") {
        return Location::Translocated(original_path(bundle));
    }
    let Some(parent) = bundle.parent() else { return Location::ReadOnly };
    // a plain mkdir (tempfile wraps its errors and loses the OS error code)
    let probe = parent.join(format!("{PROBE_PREFIX}-{}", std::process::id()));
    match fs::create_dir(&probe) {
        Ok(()) => {
            let _ = fs::remove_dir(&probe);
            Location::Writable
        }
        // only a read-only file system is a dead end; any other error (a folder only an
        // administrator may write, a full disk) is left to the install, which reports it
        Err(e) if e.raw_os_error() == Some(libc::EROFS) => Location::ReadOnly,
        Err(_) => Location::Writable,
    }
}

pub fn is_cross_device(e: &io::Error) -> bool {
    e.raw_os_error() == Some(libc::EXDEV)
}

/// Unpack the updater archive (`<Name>.app/...` inside a .tar.gz) next to `bundle` and swap it in.
/// On success the old bundle is gone; on failure the running app is in place, or, if even the
/// rollback failed, kept in a folder named in the error.
pub fn install_beside(archive: &[u8], bundle: &Path) -> io::Result<()> {
    let parent = bundle
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "the app has no parent folder"))?;
    remove_leftovers(parent);
    let staging = tempfile::Builder::new().prefix(STAGING_PREFIX).tempdir_in(parent)?;
    let unpacked = staging.path().join("unpacked");
    fs::create_dir(&unpacked)?;
    // Archive::unpack validates every entry stays inside `unpacked` (no `..`, no writes through
    // links) and sets directory permissions last
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    tar.set_preserve_permissions(true);
    tar.unpack(&unpacked)?;
    let new_app = single_bundle(&unpacked)?;

    match swap(&new_app, bundle) {
        // `new_app` now holds the old bundle; it is removed with `staging`
        Ok(()) => {}
        Err(e) if matches!(e.raw_os_error(), Some(libc::ENOTSUP) | Some(libc::EINVAL)) => {
            let old_app = staging.path().join("old.app");
            fs::rename(bundle, &old_app)?;
            if let Err(e) = fs::rename(&new_app, bundle) {
                if fs::rename(&old_app, bundle).is_err() {
                    // never delete the only copy of the app: keep the folder and say where it is
                    let kept = staging.keep();
                    return Err(io::Error::new(
                        e.kind(),
                        format!("{e}; the previous app is kept in {}", kept.join("old.app").display()),
                    ));
                }
                return Err(e);
            }
        }
        Err(e) => return Err(e),
    }
    let _ = std::process::Command::new("touch").arg(bundle).status();
    if let Err(e) = staging.close() {
        eprintln!("Fairbeam: the update's staging folder could not be removed: {e}");
    }
    Ok(())
}

/// Exactly one `<name>.app` with `Contents/Info.plist` at the top of the unpacked archive.
fn single_bundle(dir: &Path) -> io::Result<PathBuf> {
    let apps: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension() == Some(OsStr::new("app")) && p.join("Contents").join("Info.plist").is_file())
        .collect();
    match apps.as_slice() {
        [one] => Ok(one.clone()),
        _ => Err(io::Error::new(io::ErrorKind::InvalidData, "the update archive does not hold exactly one app bundle")),
    }
}

/// Atomically exchange two directories on the same volume (APFS, HFS+); ENOTSUP or EINVAL where
/// the file system cannot (exFAT, network shares).
fn swap(a: &Path, b: &Path) -> io::Result<()> {
    let ca = CString::new(a.as_os_str().as_bytes())?;
    let cb = CString::new(b.as_os_str().as_bytes())?;
    // SAFETY: two NUL-terminated paths; renamex_np does not retain them
    let r = unsafe { libc::renamex_np(ca.as_ptr(), cb.as_ptr(), libc::RENAME_SWAP) };
    if r == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

/// Staging and probe folders left by an update that was interrupted (force quit, power loss).
fn remove_leftovers(parent: &Path) {
    let Ok(entries) = fs::read_dir(parent) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if (name.starts_with(STAGING_PREFIX) || name.starts_with(PROBE_PREFIX)) && entry.path().is_dir() {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Where the user's own copy of a translocated app is (SecTranslocateCreateOriginalPathForURL,
/// looked up at run time; None when macOS does not say).
fn original_path(translocated: &Path) -> Option<PathBuf> {
    #[repr(C)]
    struct Opaque([u8; 0]);
    type CFUrl = *const Opaque;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFURLCreateFromFileSystemRepresentation(alloc: *const Opaque, buf: *const u8, len: isize, is_dir: u8) -> CFUrl;
        fn CFURLGetFileSystemRepresentation(url: CFUrl, resolve: u8, buf: *mut u8, max: isize) -> u8;
        fn CFRelease(cf: *const Opaque);
    }
    type Original = unsafe extern "C" fn(CFUrl, *mut *const Opaque) -> CFUrl;
    let bytes = translocated.as_os_str().as_bytes();
    // SAFETY: dlopen/dlsym with constant names; the CF objects are released below
    unsafe {
        let lib = libc::dlopen(c"/System/Library/Frameworks/Security.framework/Security".as_ptr(), libc::RTLD_LAZY);
        if lib.is_null() {
            return None;
        }
        let sym = libc::dlsym(lib, c"SecTranslocateCreateOriginalPathForURL".as_ptr());
        if sym.is_null() {
            return None;
        }
        let f: Original = std::mem::transmute(sym);
        let url = CFURLCreateFromFileSystemRepresentation(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize, 1);
        if url.is_null() {
            return None;
        }
        let orig = f(url, std::ptr::null_mut());
        CFRelease(url);
        if orig.is_null() {
            return None;
        }
        let mut buf = vec![0u8; 4096];
        let ok = CFURLGetFileSystemRepresentation(orig, 1, buf.as_mut_ptr(), buf.len() as isize);
        CFRelease(orig);
        if ok == 0 {
            return None;
        }
        let path = CStr::from_ptr(buf.as_ptr().cast()).to_bytes();
        Some(PathBuf::from(OsStr::from_bytes(path)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive(name: &str, version: &str) -> Vec<u8> {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        {
            let mut b = tar::Builder::new(&mut gz);
            for (path, body) in [
                (format!("{name}/Contents/Info.plist"), format!("<plist>{version}</plist>")),
                (format!("{name}/Contents/MacOS/fairbeam"), format!("#!/bin/sh\necho {version}\n")),
            ] {
                let mut h = tar::Header::new_gnu();
                h.set_size(body.len() as u64);
                h.set_mode(0o755);
                h.set_cksum();
                b.append_data(&mut h, path, body.as_bytes()).unwrap();
            }
            b.finish().unwrap();
        }
        gz.finish().unwrap()
    }

    fn fake_app(dir: &Path) -> PathBuf {
        let app = dir.join("fairbeam.app");
        fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        fs::write(app.join("Contents/Info.plist"), "<plist>old</plist>").unwrap();
        app
    }

    #[test]
    fn install_beside_replaces_the_bundle_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let app = fake_app(dir.path());
        // a folder left by an interrupted update is cleaned up too
        fs::create_dir(dir.path().join(".fairbeam-update-old")).unwrap();
        install_beside(&archive("fairbeam.app", "0.6.8"), &app).unwrap();
        assert_eq!(fs::read_to_string(app.join("Contents/Info.plist")).unwrap(), "<plist>0.6.8</plist>");
        let mode = std::os::unix::fs::PermissionsExt::mode(&fs::metadata(app.join("Contents/MacOS/fairbeam")).unwrap().permissions());
        assert_eq!(mode & 0o111, 0o111, "the executable bit is kept");
        let left: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from("fairbeam.app")], "no staging folder is left behind");
    }

    #[test]
    fn a_broken_or_foreign_archive_leaves_the_running_app_alone() {
        let dir = tempfile::tempdir().unwrap();
        let app = fake_app(dir.path());
        assert!(install_beside(b"not a tar.gz", &app).is_err());
        assert!(install_beside(&archive("not-an-app", "x"), &app).is_err(), "no .app at the top");
        assert_eq!(fs::read_to_string(app.join("Contents/Info.plist")).unwrap(), "<plist>old</plist>");
    }

    #[test]
    fn locations_are_recognised() {
        assert!(matches!(
            location(Path::new("/private/var/folders/x/T/AppTranslocation/ABC/d/fairbeam.app")),
            Location::Translocated(_)
        ));
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(location(&dir.path().join("fairbeam.app")), Location::Writable);
        // other errors (here: a folder that does not exist) are left to the install to report
        assert_eq!(location(Path::new("/nonexistent-folder/fairbeam.app")), Location::Writable);
        // a read-only volume: mount one and set FAIRBEAM_READONLY_TEST_DIR (see cross_volume_install)
        if let Ok(ro) = std::env::var("FAIRBEAM_READONLY_TEST_DIR") {
            assert_eq!(location(&Path::new(&ro).join("fairbeam.app")), Location::ReadOnly);
        }
    }

    #[test]
    fn original_path_lookup_is_safe_on_a_normal_path() {
        // not translocated: macOS returns the path itself (or nothing); it must not crash
        let p = original_path(Path::new("/Applications"));
        assert!(p.is_none() || p == Some(PathBuf::from("/Applications")), "{p:?}");
    }

    #[test]
    fn exdev_is_recognised() {
        assert!(is_cross_device(&io::Error::from_raw_os_error(libc::EXDEV)));
        assert!(!is_cross_device(&io::Error::from_raw_os_error(libc::EACCES)));
    }

    /// Real cross-volume run (manual): mount a RAM disk and point FAIRBEAM_EXDEV_TEST_DIR at it,
    /// then `cargo test -- --ignored cross_volume`. Shows the plugin's move into the system temp
    /// folder fails with EXDEV there, and that install_beside succeeds.
    #[test]
    #[ignore]
    fn cross_volume_install() {
        let Ok(root) = std::env::var("FAIRBEAM_EXDEV_TEST_DIR") else { return };
        let app = Path::new(&root).join("fairbeam.app");
        let _ = fs::remove_dir_all(&app);
        let app = fake_app(Path::new(&root));
        let tmp = tempfile::tempdir().unwrap();
        let moved = fs::rename(&app, tmp.path().join("current_app"));
        assert!(moved.as_ref().is_err_and(is_cross_device), "the plugin's move fails: {moved:?}");
        install_beside(&archive("fairbeam.app", "0.6.8"), &app).unwrap();
        assert_eq!(fs::read_to_string(app.join("Contents/Info.plist")).unwrap(), "<plist>0.6.8</plist>");
        fs::remove_dir_all(&app).unwrap();
    }
}
