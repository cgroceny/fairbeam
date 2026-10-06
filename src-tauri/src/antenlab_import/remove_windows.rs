// Windows: antenlab is uninstalled with its own (NSIS) uninstaller, silently and in place, and its
// data folders are deleted (the agreed "with data removal"; the silent uninstaller keeps them).
// The leftovers follow: the uninstaller itself, the empty install folder, the registry keys and
// the shortcuts that still point at the old program. The workspace and the backup are never
// touched. The string helpers are plain functions so they are tested on every OS.
#![cfg_attr(not(windows), allow(dead_code))]

use std::path::{Path, PathBuf};

pub const EXE: &str = "antenlab.exe";
pub const UNINSTALLER: &str = "uninstall.exe";
pub const LINK: &str = "antenlab.lnk";
/// HKCU: written by the NSIS installer (`UninstallString`)
pub const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\antenlab";
/// HKCU: the install folder (default value)
pub const PRODUCT_KEY: &str = r"Software\antenlab\antenlab";
pub const PRODUCT_PARENT_KEY: &str = r"Software\antenlab";
pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
pub const RUN_VALUE: &str = "antenlab";

/// The program an UninstallString starts: `"C:\…\uninstall.exe" /args`, or the same unquoted.
pub fn parse_uninstall_string(s: &str) -> Option<String> {
    let s = s.trim();
    let program = if let Some(rest) = s.strip_prefix('"') {
        &rest[..rest.find('"')?]
    } else {
        let end = s.to_ascii_lowercase().find(".exe").map(|i| i + 4).unwrap_or(s.len());
        s[..end].trim()
    };
    (!program.is_empty()).then(|| program.to_string())
}

/// The arguments for an in-place silent uninstall. NSIS reads `_?=` raw to the end of the command
/// line: it must come last and must not be quoted, even with spaces in the path.
pub fn uninstall_args(dir: &str) -> String {
    format!("/S _?={}", dir.trim_end_matches(['\\', '/']))
}

/// Whether a .lnk file names `target` (ASCII-case-insensitive), in its ANSI or UTF-16 strings.
pub fn lnk_mentions(bytes: &[u8], target: &str) -> bool {
    let lower = |c: u16| if (b'A' as u16..=b'Z' as u16).contains(&c) { c + 32 } else { c };
    let want: Vec<u16> = target.encode_utf16().map(lower).collect();
    if want.is_empty() {
        return false;
    }
    // UTF-16LE strings (StringData, LinkTargetIDList), at either byte alignment
    for offset in 0..2 {
        let units: Vec<u16> = bytes[offset.min(bytes.len())..]
            .chunks_exact(2)
            .map(|c| lower(u16::from_le_bytes([c[0], c[1]])))
            .collect();
        if units.windows(want.len()).any(|w| w == want.as_slice()) {
            return true;
        }
    }
    // single-byte strings (LinkInfo's local base path), for an ASCII target
    target.is_ascii() && bytes.windows(target.len()).any(|w| w.eq_ignore_ascii_case(target.as_bytes()))
}

/// The per-user Start menu programs folder: %APPDATA%\Microsoft\Windows\Start Menu\Programs.
/// `roaming` is %APPDATA% (the parent of antenlab's config folder).
pub fn start_menu(roaming: &Path) -> PathBuf {
    roaming.join("Microsoft").join("Windows").join("Start Menu").join("Programs")
}

#[cfg(windows)]
pub use win::{antenlab_running, find_install, remove};

#[cfg(windows)]
mod win {
    use std::fs;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteKeyValueW, RegDeleteKeyW, RegDeleteTreeW, RegGetValueW, RegOpenKeyExW, RegQueryInfoKeyW,
        HKEY, HKEY_CURRENT_USER, KEY_READ, RRF_RT_REG_SZ,
    };

    use super::super::detect::{Legacy, Roots};
    use super::super::Step;
    use super::*;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const UNINSTALL_TIMEOUT: Duration = Duration::from_secs(300);

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// A REG_SZ value under HKCU (`None` for the key's default value).
    fn read_string(subkey: &str, value: Option<&str>) -> Option<String> {
        let key = wide(subkey);
        let name = value.map(wide);
        let name_ptr = name.as_ref().map_or(std::ptr::null(), |n| n.as_ptr());
        let mut size: u32 = 0;
        // SAFETY: NUL-terminated wide strings; the first call only asks for the size, the second
        // writes at most `size` bytes into a buffer of that size
        unsafe {
            let r = RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name_ptr,
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            );
            if r != ERROR_SUCCESS || size == 0 {
                return None;
            }
            let mut buf = vec![0u16; (size as usize).div_ceil(2)];
            let r = RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name_ptr,
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut size,
            );
            if r != ERROR_SUCCESS {
                return None;
            }
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Some(String::from_utf16_lossy(&buf[..len]))
        }
    }

    /// Ok(true) deleted, Ok(false) was not there.
    fn delete_tree(subkey: &str) -> Result<bool, String> {
        let key = wide(subkey);
        // SAFETY: a NUL-terminated wide string
        match unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, key.as_ptr()) } {
            ERROR_SUCCESS => Ok(true),
            ERROR_FILE_NOT_FOUND => Ok(false),
            e => Err(format!("registry error {e}")),
        }
    }

    /// Delete a key that has no subkeys and no values left.
    fn delete_key_if_empty(subkey: &str) -> Result<bool, String> {
        let key = wide(subkey);
        let mut h: HKEY = std::ptr::null_mut();
        // SAFETY: the key is opened, queried and closed here; the out-pointers are valid
        unsafe {
            if RegOpenKeyExW(HKEY_CURRENT_USER, key.as_ptr(), 0, KEY_READ, &mut h) != ERROR_SUCCESS {
                return Ok(false);
            }
            let (mut subkeys, mut values) = (0u32, 0u32);
            let r = RegQueryInfoKeyW(
                h,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
                &mut subkeys,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut values,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            RegCloseKey(h);
            if r != ERROR_SUCCESS || subkeys != 0 || values != 0 {
                return Ok(false);
            }
            match RegDeleteKeyW(HKEY_CURRENT_USER, key.as_ptr()) {
                ERROR_SUCCESS => Ok(true),
                e => Err(format!("registry error {e}")),
            }
        }
    }

    fn delete_value(subkey: &str, name: &str) -> Result<(), String> {
        let (key, name) = (wide(subkey), wide(name));
        // SAFETY: NUL-terminated wide strings
        match unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) } {
            ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => Ok(()),
            e => Err(format!("registry error {e}")),
        }
    }

    /// antenlab.exe runs (a process other than this one).
    pub fn antenlab_running() -> bool {
        let me = std::process::id();
        // SAFETY: a process snapshot walked with a correctly sized entry, then closed
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return false;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut found = false;
            let mut more = Process32FirstW(snap, &mut entry) != 0;
            while more {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                if name.eq_ignore_ascii_case(EXE) && entry.th32ProcessID != me {
                    found = true;
                    break;
                }
                more = Process32NextW(snap, &mut entry) != 0;
            }
            CloseHandle(snap);
            found
        }
    }

    /// The install folder (it holds antenlab.exe) and its uninstaller: from the UninstallString,
    /// else the product key, else the installer's default %LOCALAPPDATA%\antenlab.
    pub fn find_install(roots: &Roots) -> Option<(PathBuf, Option<PathBuf>)> {
        let with_exe = |dir: PathBuf| dir.join(EXE).is_file().then_some(dir);
        if let Some(program) = read_string(UNINSTALL_KEY, Some("UninstallString")).as_deref().and_then(parse_uninstall_string) {
            let program = PathBuf::from(program);
            if let Some(dir) = program.parent().map(Path::to_path_buf).and_then(with_exe) {
                return Some((dir, program.is_file().then_some(program)));
            }
        }
        let dir = read_string(PRODUCT_KEY, None)
            .map(|d| PathBuf::from(d.trim()))
            .and_then(with_exe)
            .or_else(|| roots.old_local.parent().map(|p| p.join("antenlab")).and_then(with_exe))?;
        let uninstaller = dir.join(UNINSTALLER);
        Some((dir, uninstaller.is_file().then_some(uninstaller)))
    }

    fn run_uninstaller(uninstaller: &Path, dir: &Path) -> Result<Option<i32>, String> {
        let mut child = Command::new(uninstaller)
            .raw_arg(uninstall_args(&dir.to_string_lossy()))
            .current_dir(dir.parent().unwrap_or(dir))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
        let deadline = Instant::now() + UNINSTALL_TIMEOUT;
        loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                return Ok(status.code());
            }
            if Instant::now() > deadline {
                return Err("still running after 5 minutes".into());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    fn remove_path(p: &Path) -> std::io::Result<()> {
        let meta = fs::symlink_metadata(p)?;
        if meta.is_dir() {
            fs::remove_dir_all(p)
        } else {
            fs::remove_file(p)
        }
    }

    /// Uninstall, then delete the leftovers. One step per item; anything locked is reported and
    /// left for Help › Remove antenlab… to retry.
    pub fn remove(roots: &Roots, legacy: &Legacy, desktop: Option<&Path>) -> Vec<Step> {
        let mut steps = Vec::new();
        let mut target = format!("\\{EXE}");
        if let Some(dir) = &legacy.install_dir {
            target = dir.join(EXE).to_string_lossy().into_owned();
            if !dir.join(EXE).is_file() {
                steps.push(Step::failed("uninstall", format!("{}: no {EXE} in it; not run", dir.display())));
            } else {
                if let Some(un) = &legacy.uninstaller {
                    match run_uninstaller(un, dir) {
                        Ok(Some(0)) => steps.push(Step::ok("uninstall", dir.display().to_string())),
                        Ok(code) => steps.push(Step::failed("uninstall", format!("{}: exit code {code:?}", dir.display()))),
                        Err(e) => steps.push(Step::failed("uninstall", format!("{}: {e}", dir.display()))),
                    }
                }
                // with _?= the uninstaller does not remove itself nor the folder
                let _ = fs::remove_file(dir.join(UNINSTALLER));
                match fs::remove_dir(dir) {
                    Ok(()) => steps.push(Step::ok("delete", dir.display().to_string())),
                    Err(_) if !dir.exists() => {}
                    Err(e) => steps.push(Step::failed("delete", format!("{}: {e}", dir.display()))),
                }
            }
        }
        for p in &legacy.data {
            if fs::symlink_metadata(p).is_err() {
                continue;
            }
            match remove_path(p) {
                Ok(()) => steps.push(Step::ok("delete", p.display().to_string())),
                Err(e) => steps.push(Step::failed("delete", format!("{}: {e}", p.display()))),
            }
        }

        let mut registry = |what: &str, r: Result<bool, String>| match r {
            Ok(true) => steps.push(Step::ok("registry", what.to_string())),
            Ok(false) => {}
            Err(e) => steps.push(Step::failed("registry", format!("{what}: {e}"))),
        };
        registry(PRODUCT_KEY, delete_tree(PRODUCT_KEY));
        registry(PRODUCT_PARENT_KEY, delete_key_if_empty(PRODUCT_PARENT_KEY));
        // the uninstall entry, when its program is gone (the uninstaller normally removes it)
        if let Some(program) = read_string(UNINSTALL_KEY, Some("UninstallString")).as_deref().and_then(parse_uninstall_string) {
            if !Path::new(&program).is_file() {
                registry(UNINSTALL_KEY, delete_tree(UNINSTALL_KEY));
            }
        }
        if read_string(RUN_KEY, Some(RUN_VALUE)).is_some_and(|v| v.to_ascii_lowercase().contains(EXE)) {
            registry(&format!("{RUN_KEY}\\{RUN_VALUE}"), delete_value(RUN_KEY, RUN_VALUE).map(|()| true));
        }

        let mut folders: Vec<PathBuf> = Vec::new();
        if let Some(roaming) = roots.old_config.parent() {
            folders.push(start_menu(roaming));
        }
        folders.extend(desktop.map(Path::to_path_buf));
        folders.push(roots.home.join("Desktop"));
        folders.dedup();
        for folder in folders {
            let link = folder.join(LINK);
            let Ok(bytes) = fs::read(&link) else { continue };
            if !lnk_mentions(&bytes, &target) {
                continue;
            }
            match fs::remove_file(&link) {
                Ok(()) => steps.push(Step::ok("delete", link.display().to_string())),
                Err(e) => steps.push(Step::failed("delete", format!("{}: {e}", link.display()))),
            }
        }
        steps
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uninstall_string_parsing() {
        let p = |s: &str| parse_uninstall_string(s);
        assert_eq!(
            p(r#""C:\Users\İrem Çelik\AppData\Local\antenlab\uninstall.exe""#).as_deref(),
            Some(r"C:\Users\İrem Çelik\AppData\Local\antenlab\uninstall.exe")
        );
        assert_eq!(
            p(r#"  "C:\Program Files\antenlab\uninstall.exe" /currentuser "#).as_deref(),
            Some(r"C:\Program Files\antenlab\uninstall.exe")
        );
        assert_eq!(p(r"C:\apps\antenlab\Uninstall.EXE /S").as_deref(), Some(r"C:\apps\antenlab\Uninstall.EXE"));
        assert_eq!(
            p(r"C:\Program Files\antenlab\uninstall.exe").as_deref(),
            Some(r"C:\Program Files\antenlab\uninstall.exe")
        );
        assert_eq!(p(r#""unterminated"#), None);
        assert_eq!(p(r#""""#), None);
        assert_eq!(p("   "), None);
    }

    #[test]
    fn in_place_uninstall_command_line() {
        assert_eq!(uninstall_args(r"C:\Users\x\AppData\Local\antenlab"), r"/S _?=C:\Users\x\AppData\Local\antenlab");
        // spaces stay unquoted, a trailing separator goes
        assert_eq!(uninstall_args(r"C:\Program Files\antenlab\"), r"/S _?=C:\Program Files\antenlab");
        assert_eq!(uninstall_args(r"D:\İrem Çelik\antenlab"), r"/S _?=D:\İrem Çelik\antenlab");
        assert!(uninstall_args(r"C:\a b").ends_with(r"_?=C:\a b"), "_?= is last");
    }

    #[test]
    fn shortcut_target_matching() {
        let target = r"C:\Users\x\AppData\Local\antenlab\antenlab.exe";
        let utf16: Vec<u8> = r"junk C:\USERS\x\AppData\Local\antenlab\ANTENLAB.EXE junk"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        assert!(lnk_mentions(&utf16, target));
        let mut odd = vec![0u8];
        odd.extend(&utf16);
        assert!(lnk_mentions(&odd, target), "at an odd offset");
        assert!(lnk_mentions(b"\x00\x01C:\\Users\\x\\AppData\\Local\\antenlab\\antenlab.exe\x00", target));
        assert!(!lnk_mentions(b"C:\\Users\\x\\AppData\\Local\\Fairbeam\\fairbeam.exe", target));
        assert!(lnk_mentions(b"..\\antenlab\\antenlab.exe", r"\antenlab.exe"));
        assert!(!lnk_mentions(b"", target));
        assert!(!lnk_mentions(b"abc", ""));
        assert_eq!(
            start_menu(Path::new("Roaming")),
            Path::new("Roaming").join("Microsoft").join("Windows").join("Start Menu").join("Programs")
        );
    }
}
