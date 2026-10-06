// The workspace: the default <Documents>/antenlab becomes <Documents>/Fairbeam with one rename (same
// parent, atomic: .sim moves at no cost), and the absolute paths in jobs/*/job.json follow it. A
// custom workspace stays where it is. Nothing inside the workspace is copied or deleted.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::detect::{Roots, SeedDirs};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WsPlan {
    /// rename the default workspace to <Documents>/Fairbeam
    Move { from: PathBuf, to: PathBuf },
    /// renamed by an earlier, interrupted import: only the job.json rewrite is left
    Moved { from: PathBuf, to: PathBuf },
    /// keep using this folder; the settings name it explicitly
    Keep { path: PathBuf, reason: String },
    /// a repository checkout (contains python/antenlab): no move and no Python rewrite
    Checkout { path: PathBuf },
    /// no old workspace to take over
    Nothing { reason: String },
}

impl WsPlan {
    /// the folder Fairbeam works in after this step, when the import touches one
    pub fn target(&self) -> Option<&Path> {
        match self {
            WsPlan::Move { to, .. } | WsPlan::Moved { to, .. } => Some(to),
            WsPlan::Keep { path, .. } => Some(path),
            WsPlan::Checkout { .. } | WsPlan::Nothing { .. } => None,
        }
    }
}

/// `old_setting`: antenlab's `workspace` setting. `resuming`: an earlier import was interrupted.
pub fn plan(old_setting: Option<&str>, roots: &Roots, resuming: bool) -> WsPlan {
    let default_old = roots.old_default_workspace();
    let new = roots.new_default_workspace();
    let old = old_setting.filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| default_old.clone());
    let is_default = old_setting.is_none_or(str::is_empty) || same_path(&old, &default_old);

    if !old.is_dir() {
        if is_default && resuming && new.is_dir() {
            return WsPlan::Moved { from: default_old, to: new };
        }
        return WsPlan::Nothing { reason: format!("{} does not exist", old.display()) };
    }
    if old.join("python").join("antenlab").is_dir() {
        return WsPlan::Checkout { path: old };
    }
    if !is_default {
        return WsPlan::Keep { path: old, reason: "custom workspace".into() };
    }
    if fs::symlink_metadata(&new).is_err() || is_replaceable(&new, &roots.seed) {
        WsPlan::Move { from: default_old, to: new }
    } else {
        WsPlan::Keep { path: default_old, reason: format!("{} is not empty", new.display()) }
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// An empty folder; one holding only Finder's .DS_Store counts as empty.
pub fn is_empty_dir(p: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(p) else { return false };
    if !meta.is_dir() {
        return false;
    }
    match fs::read_dir(p) {
        Ok(entries) => entries.flatten().all(|e| e.file_name() == ".DS_Store"),
        Err(_) => false,
    }
}

/// A target the import may replace: empty, or holding only what the app itself put there. That is
/// `.DS_Store` files, empty folders (jobs/, .sim/ and the like), the run server's
/// `jobs/.server-owner.lock` and files byte-identical to the
/// bundled seed source at the same place (`seed::seed` copies projects/, models/ and templates/).
/// The examples' `projects/index.json` counts when it is the bundled one or lists nothing but
/// bundled examples (what `seed::refresh_examples` writes). Everything else is the user's: a run
/// in jobs/, an edited or new file, a symlink.
pub fn is_replaceable(p: &Path, seed: &SeedDirs) -> bool {
    is_empty_dir(p) || is_app_only(p, seed)
}

fn is_app_only(root: &Path, seed: &SeedDirs) -> bool {
    let Ok(meta) = fs::symlink_metadata(root) else { return false };
    meta.is_dir() && app_only_dir(root, root, seed)
}

fn app_only_dir(root: &Path, dir: &Path, seed: &SeedDirs) -> bool {
    let Ok(entries) = fs::read_dir(dir) else { return false };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { return false };
        let ok = if kind.is_dir() {
            app_only_dir(root, &path, seed)
        } else if kind.is_file() {
            entry.file_name() == ".DS_Store" || is_server_lock(root, &path) || is_seed_copy(root, &path, seed)
        } else {
            false
        };
        if !ok {
            return false;
        }
    }
    true
}

/// The run server's ownership lock (`python/fairbeam/jobs_owner.py`): every start of the server
/// leaves `jobs/.server-owner.lock` (one byte) behind, so a seeded workspace always has it.
const SERVER_LOCK: &str = ".server-owner.lock";

fn is_server_lock(root: &Path, file: &Path) -> bool {
    file.strip_prefix(root).is_ok_and(|rel| rel == Path::new("jobs").join(SERVER_LOCK))
}

/// `file` (inside `root`) has the same bytes as the bundled file at the same relative path.
fn is_seed_copy(root: &Path, file: &Path, seed: &SeedDirs) -> bool {
    let Ok(rel) = file.strip_prefix(root) else { return false };
    let mut parts = rel.components();
    let Some(top) = parts.next().and_then(|c| c.as_os_str().to_str()) else { return false };
    let rest = parts.as_path();
    if rest.as_os_str().is_empty() {
        return false;
    }
    let Some(src_root) = seed.source_for(top) else { return false };
    let source = src_root.join(rest);
    if same_bytes(&source, file) {
        return true;
    }
    top == "projects" && rest == Path::new("index.json") && lists_only_bundled(file, src_root)
}

fn same_bytes(a: &Path, b: &Path) -> bool {
    let (Ok(ma), Ok(mb)) = (fs::metadata(a), fs::metadata(b)) else { return false };
    if !ma.is_file() || !mb.is_file() || ma.len() != mb.len() {
        return false;
    }
    matches!((fs::read(a), fs::read(b)), (Ok(x), Ok(y)) if x == y)
}

/// The examples index at `file` has only a `projects` list, and every entry in it is one of the
/// entries of the bundled `<src>/index.json` (so nothing in it was added by the user).
fn lists_only_bundled(file: &Path, src: &Path) -> bool {
    let read = |p: &Path| -> Option<Value> { serde_json::from_str(&fs::read_to_string(p).ok()?).ok() };
    let (Some(mine), Some(bundled)) = (read(file), read(&src.join("index.json"))) else { return false };
    let (Some(obj), Some(list), Some(known)) = (mine.as_object(), mine["projects"].as_array(), bundled["projects"].as_array())
    else {
        return false;
    };
    obj.len() == 1 && list.iter().all(|e| known.contains(e))
}

/// Rename `from` to `to`. A `to` that is empty or holds only what the app seeded (`is_replaceable`)
/// is moved aside first (same parent, hidden temp name), the old folder is renamed into place and
/// the aside folder is deleted; if the rename fails, `to` is put back. Anything else there is never
/// replaced.
pub fn move_workspace(from: &Path, to: &Path, seed: &SeedDirs) -> io::Result<()> {
    if fs::symlink_metadata(to).is_err() {
        return fs::rename(from, to);
    }
    if !is_replaceable(to, seed) {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} is not empty", to.display())));
    }
    let name = to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut aside = to.with_file_name(format!(".{name}.fairbeam-import-aside"));
    let mut n = 0;
    while fs::symlink_metadata(&aside).is_ok() {
        n += 1;
        aside = to.with_file_name(format!(".{name}.fairbeam-import-aside-{n}"));
    }
    fs::rename(to, &aside)?;
    if let Err(e) = fs::rename(from, to) {
        return Err(match fs::rename(&aside, to) {
            Ok(()) => e,
            Err(back) => io::Error::new(
                e.kind(),
                format!("{e}; {} could not be put back from {}: {back}", to.display(), aside.display()),
            ),
        });
    }
    // only copies of bundled files and empty folders were in it; a failure leaves a hidden folder
    let _ = fs::remove_dir_all(&aside);
    Ok(())
}

/// `s` with the folder `old` at its start replaced by `new`. Only a whole path component matches:
/// `old` must be followed by a separator or the end (so `.../antenlab2` stays). `windows`: the
/// match ignores ASCII case and takes `/` and `\` as the same separator (job.json files can hold
/// `C:/Users/…` as well as `C:\Users\…`); a path written with `/` keeps `/` in its new prefix.
pub fn rewrite_prefix(s: &str, old: &str, new: &str, windows: bool) -> Option<String> {
    let old = old.trim_end_matches(['/', '\\']);
    let new = new.trim_end_matches(['/', '\\']);
    if old.is_empty() {
        return None;
    }
    let head = s.get(..old.len())?;
    let is_sep = |b: u8| b == b'/' || b == b'\\';
    let matches = if windows {
        head.bytes().zip(old.bytes()).all(|(a, b)| a.eq_ignore_ascii_case(&b) || (is_sep(a) && is_sep(b)))
    } else {
        head == old
    };
    let rest = &s[old.len()..];
    if !(matches && (rest.is_empty() || rest.starts_with(['/', '\\']))) {
        return None;
    }
    let slashes = windows && head.contains('/') && !head.contains('\\');
    Some(if slashes { format!("{}{rest}", new.replace('\\', "/")) } else { format!("{new}{rest}") })
}

/// Rewrite every string in `v` that starts with one of `olds`; returns how many changed.
pub fn rewrite_value(v: &mut Value, olds: &[String], new: &str, windows: bool) -> usize {
    match v {
        Value::String(s) => {
            for old in olds {
                if let Some(r) = rewrite_prefix(s, old, new, windows) {
                    *s = r;
                    return 1;
                }
            }
            0
        }
        Value::Array(a) => a.iter_mut().map(|x| rewrite_value(x, olds, new, windows)).sum(),
        Value::Object(o) => o.values_mut().map(|x| rewrite_value(x, olds, new, windows)).sum(),
        _ => 0,
    }
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobsReport {
    /// job.json files read
    pub files: usize,
    /// job.json files rewritten (each backed up first)
    pub changed: usize,
    /// "<job id>: <error>"
    pub errors: Vec<String>,
}

/// The forms of the old workspace path that job.json files may hold: as written and canonical.
pub fn old_forms(old: &Path) -> Vec<String> {
    let mut v = vec![old.to_string_lossy().into_owned()];
    if let Ok(c) = fs::canonicalize(old) {
        let c = crate::paths::canonical(&c).to_string_lossy().into_owned();
        if !v.contains(&c) {
            v.push(c);
        }
    }
    v
}

/// In `<ws>/jobs/*/job.json`, paths under one of `olds` move to `new`. The original goes to
/// `<backup>/jobs/<id>/job.json` first; the new file is written through a temp file and a rename.
pub fn rewrite_jobs(ws: &Path, olds: &[String], new: &Path, backup: &Path, dry_run: bool) -> JobsReport {
    let mut report = JobsReport::default();
    let new = new.to_string_lossy();
    let Ok(entries) = fs::read_dir(ws.join("jobs")) else { return report };
    let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    dirs.sort();
    for dir in dirs {
        let file = dir.join("job.json");
        if !fs::symlink_metadata(&file).is_ok_and(|m| m.is_file()) {
            continue;
        }
        let id = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        report.files += 1;
        let result = (|| -> Result<bool, String> {
            let text = fs::read_to_string(&file).map_err(|e| e.to_string())?;
            let mut v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if rewrite_value(&mut v, olds, &new, cfg!(windows)) == 0 {
                return Ok(false);
            }
            if dry_run {
                return Ok(true);
            }
            let saved = backup.join("jobs").join(&id).join("job.json");
            if !saved.exists() {
                fs::create_dir_all(saved.parent().unwrap()).map_err(|e| e.to_string())?;
                fs::copy(&file, &saved).map_err(|e| e.to_string())?;
            }
            let out = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
            write_replace(&file, out.as_bytes()).map_err(|e| e.to_string())?;
            Ok(true)
        })();
        match result {
            Ok(true) => report.changed += 1,
            Ok(false) => {}
            Err(e) => report.errors.push(format!("{id}: {e}")),
        }
    }
    report
}

/// Write `bytes` to `path` through a temp file in the same folder and a rename, keeping the
/// permissions of the file it replaces.
pub fn write_replace(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.fairbeam-import.tmp"));
    fs::write(&tmp, bytes)?;
    if let Ok(meta) = fs::metadata(path) {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::super::testutil::{roots_in, Temp};
    use super::*;
    use serde_json::json;

    #[test]
    fn unset_workspace_is_moved() {
        let t = Temp::new("ws-unset");
        let roots = roots_in(t.path());
        fs::create_dir_all(roots.old_default_workspace().join("models")).unwrap();
        let p = plan(None, &roots, false);
        assert_eq!(p, WsPlan::Move { from: roots.old_default_workspace(), to: roots.new_default_workspace() });
        move_workspace(&roots.old_default_workspace(), &roots.new_default_workspace(), &roots.seed).unwrap();
        assert!(roots.new_default_workspace().join("models").is_dir());
        assert!(!roots.old_default_workspace().exists());
    }

    #[test]
    fn explicit_default_path_is_moved_and_custom_is_kept() {
        let t = Temp::new("ws-explicit");
        let roots = roots_in(t.path());
        let old = roots.old_default_workspace();
        fs::create_dir_all(&old).unwrap();
        // the default spelled out (with a trailing separator), or empty
        let spelled = format!("{}/", old.display());
        assert!(matches!(plan(Some(&spelled), &roots, false), WsPlan::Move { .. }));
        assert!(matches!(plan(Some(""), &roots, false), WsPlan::Move { .. }));
        let custom = t.path().join("Projects/antennas");
        fs::create_dir_all(&custom).unwrap();
        assert_eq!(
            plan(Some(custom.to_str().unwrap()), &roots, false),
            WsPlan::Keep { path: custom.clone(), reason: "custom workspace".into() }
        );
        // a custom folder that is gone: nothing to take over
        assert!(matches!(plan(Some("/no/such/folder"), &roots, false), WsPlan::Nothing { .. }));
    }

    #[test]
    fn non_empty_target_keeps_the_old_folder_and_empty_target_is_replaced() {
        let t = Temp::new("ws-target");
        let roots = roots_in(t.path());
        let (old, new) = (roots.old_default_workspace(), roots.new_default_workspace());
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join(".DS_Store"), "x").unwrap();
        assert!(matches!(plan(None, &roots, false), WsPlan::Move { .. }), "empty (only .DS_Store)");
        fs::write(new.join("notes.txt"), "mine").unwrap();
        assert!(matches!(plan(None, &roots, false), WsPlan::Keep { ref path, .. } if *path == old));
        // and the move itself never replaces it
        assert!(move_workspace(&old, &new, &roots.seed).is_err());
        assert_eq!(fs::read_to_string(new.join("notes.txt")).unwrap(), "mine");
        assert!(old.is_dir());
        fs::remove_file(new.join("notes.txt")).unwrap();
        move_workspace(&old, &new, &roots.seed).unwrap();
        assert!(!old.exists() && new.is_dir() && !new.join(".DS_Store").exists());
    }

    /// the bundled folders with a few files, and a workspace seeded from them the way
    /// `seed::seed` does it (copies, the index, empty jobs/ and .sim/)
    fn bundled_and_seeded(roots: &Roots) -> PathBuf {
        let s = &roots.seed;
        for d in [&s.projects, &s.models, &s.templates, &s.models.join("sub")] {
            fs::create_dir_all(d).unwrap();
        }
        let index = r#"{"projects":[{"file":"horn.json","name":"Horn"},{"file":"uav.json","name":"UAV"}]}"#;
        fs::write(s.projects.join("index.json"), index).unwrap();
        fs::write(s.projects.join("horn.json"), "horn").unwrap();
        fs::write(s.projects.join("uav.json"), "uav").unwrap();
        fs::write(s.models.join("dipole.py"), "from fairbeam import Param\n").unwrap();
        fs::write(s.models.join("sub/inner.py"), "x = 1\n").unwrap();
        fs::write(s.templates.join("patch.py"), "template").unwrap();
        let ws = roots.new_default_workspace();
        for (src, name) in [(&s.projects, "projects"), (&s.models, "models"), (&s.templates, "templates")] {
            copy_dir(src, &ws.join(name));
        }
        fs::create_dir_all(ws.join("jobs")).unwrap();
        // the run server leaves its ownership lock behind on every start (Windows test, #359)
        fs::write(ws.join("jobs").join(SERVER_LOCK), [0u8]).unwrap();
        fs::create_dir_all(ws.join(".sim/empty")).unwrap();
        fs::write(ws.join(".sim/.DS_Store"), "x").unwrap();
        ws
    }

    fn copy_dir(src: &Path, dst: &Path) {
        fs::create_dir_all(dst).unwrap();
        for e in fs::read_dir(src).unwrap().flatten() {
            if e.file_type().unwrap().is_dir() {
                copy_dir(&e.path(), &dst.join(e.file_name()));
            } else {
                fs::copy(e.path(), dst.join(e.file_name())).unwrap();
            }
        }
    }

    fn aside_folders(roots: &Roots) -> Vec<String> {
        let parent = roots.new_default_workspace().parent().unwrap().to_path_buf();
        let names = fs::read_dir(parent).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned());
        names.filter(|n| n.contains("aside")).collect()
    }

    #[test]
    fn a_target_holding_only_seeded_copies_is_replaced() {
        let t = Temp::new("ws-seeded");
        let roots = roots_in(t.path());
        let (old, new) = (roots.old_default_workspace(), roots.new_default_workspace());
        fs::create_dir_all(old.join("models")).unwrap();
        fs::write(old.join("models/mine.py"), "mine").unwrap();
        bundled_and_seeded(&roots);
        // an examples index that only lists bundled examples (refresh may reorder or rewrite it)
        fs::write(
            new.join("projects/index.json"),
            r#"{ "projects": [ {"name":"UAV","file":"uav.json"}, {"file":"horn.json","name":"Horn"} ] }"#,
        )
        .unwrap();
        assert!(is_replaceable(&new, &roots.seed));
        assert_eq!(plan(None, &roots, false), WsPlan::Move { from: old.clone(), to: new.clone() });
        move_workspace(&old, &new, &roots.seed).unwrap();
        assert!(!old.exists());
        assert_eq!(fs::read_to_string(new.join("models/mine.py")).unwrap(), "mine");
        assert!(!new.join("projects").exists() && !new.join("templates").exists(), "only the old folder is left");
        assert!(aside_folders(&roots).is_empty(), "the aside folder is deleted");
    }

    #[test]
    fn a_target_with_user_content_is_kept() {
        type Change = fn(&Path);
        let cases: Vec<(&str, Change)> = vec![
            ("extra file", |w| fs::write(w.join("notes.txt"), "x").unwrap()),
            ("new model", |w| fs::write(w.join("models/new.py"), "x").unwrap()),
            ("edited model", |w| fs::write(w.join("models/dipole.py"), "edited").unwrap()),
            ("edited model in a subfolder", |w| fs::write(w.join("models/sub/inner.py"), "edited").unwrap()),
            ("edited template", |w| fs::write(w.join("templates/patch.py"), "edited").unwrap()),
            ("file in jobs", |w| {
                fs::create_dir_all(w.join("jobs/j1")).unwrap();
                fs::write(w.join("jobs/j1/job.json"), "{}").unwrap();
            }),
            ("file in .sim", |w| fs::write(w.join(".sim/out.h5"), "x").unwrap()),
            ("the lock file outside jobs/", |w| fs::write(w.join(SERVER_LOCK), [0u8]).unwrap()),
            ("the lock file in a job folder", |w| {
                fs::create_dir_all(w.join("jobs/j1")).unwrap();
                fs::write(w.join("jobs/j1").join(SERVER_LOCK), [0u8]).unwrap();
            }),
            ("new design", |w| fs::write(w.join("projects/mine.json"), "x").unwrap()),
            ("edited design", |w| fs::write(w.join("projects/horn.json"), "mine").unwrap()),
            ("user entry in the index", |w| {
                fs::write(w.join("projects/index.json"), r#"{"projects":[{"file":"mine.json","name":"Mine"}]}"#).unwrap()
            }),
            ("changed entry in the index", |w| {
                fs::write(w.join("projects/index.json"), r#"{"projects":[{"file":"horn.json","name":"My horn"}]}"#).unwrap()
            }),
            ("extra key in the index", |w| fs::write(w.join("projects/index.json"), r#"{"projects":[],"note":"x"}"#).unwrap()),
            ("index that is not JSON", |w| fs::write(w.join("projects/index.json"), "{").unwrap()),
            ("a bundled file at the wrong place", |w| fs::write(w.join("dipole.py"), "from fairbeam import Param\n").unwrap()),
            ("a bundled file in another folder", |w| {
                fs::write(w.join("projects/dipole.py"), "from fairbeam import Param\n").unwrap()
            }),
            ("a folder with an unknown name", |w| {
                fs::create_dir_all(w.join("other")).unwrap();
                fs::write(w.join("other/x.txt"), "x").unwrap();
            }),
        ];
        for (name, change) in cases {
            let t = Temp::new("ws-user");
            let roots = roots_in(t.path());
            let (old, new) = (roots.old_default_workspace(), roots.new_default_workspace());
            fs::create_dir_all(&old).unwrap();
            bundled_and_seeded(&roots);
            assert!(is_replaceable(&new, &roots.seed), "{name}: untouched seed");
            change(&new);
            assert!(!is_replaceable(&new, &roots.seed), "{name}");
            assert!(matches!(plan(None, &roots, false), WsPlan::Keep { ref path, .. } if *path == old), "{name}");
            assert!(move_workspace(&old, &new, &roots.seed).is_err(), "{name}");
            assert!(old.is_dir() && new.is_dir(), "{name}: nothing moved");
            assert!(aside_folders(&roots).is_empty(), "{name}");
        }
    }

    #[test]
    fn a_failed_rename_puts_the_seeded_target_back() {
        let t = Temp::new("ws-restore");
        let roots = roots_in(t.path());
        let new = bundled_and_seeded(&roots);
        // the old workspace does not exist: the rename into place fails after the target moved aside
        let missing = roots.old_default_workspace();
        assert!(move_workspace(&missing, &new, &roots.seed).is_err());
        assert!(new.join("models/dipole.py").is_file() && new.join("jobs").is_dir(), "restored");
        assert!(aside_folders(&roots).is_empty());
    }

    #[test]
    fn checkout_is_skipped_and_resume_rewrites_only() {
        let t = Temp::new("ws-checkout");
        let roots = roots_in(t.path());
        let repo = t.path().join("code/antenlab");
        fs::create_dir_all(repo.join("python/antenlab")).unwrap();
        assert_eq!(plan(Some(repo.to_str().unwrap()), &roots, false), WsPlan::Checkout { path: repo });
        // after an interrupted import the old folder is gone and the new one is there
        fs::create_dir_all(roots.new_default_workspace()).unwrap();
        assert!(matches!(plan(None, &roots, false), WsPlan::Nothing { .. }));
        assert_eq!(
            plan(None, &roots, true),
            WsPlan::Moved { from: roots.old_default_workspace(), to: roots.new_default_workspace() }
        );
    }

    #[test]
    fn prefix_rewrite_is_component_aware() {
        let r = |s: &str| rewrite_prefix(s, "/Users/a/Documents/antenlab", "/Users/a/Documents/Fairbeam", false);
        assert_eq!(r("/Users/a/Documents/antenlab").as_deref(), Some("/Users/a/Documents/Fairbeam"));
        assert_eq!(r("/Users/a/Documents/antenlab/.sim/x").as_deref(), Some("/Users/a/Documents/Fairbeam/.sim/x"));
        assert_eq!(r("/Users/a/Documents/antenlab2/x"), None);
        assert_eq!(r("prefix /Users/a/Documents/antenlab/x"), None);
        assert_eq!(r("antenlab"), None);
        assert_eq!(r(""), None);
        // Windows-style strings, case-insensitive like the file system
        let w = |s: &str| {
            rewrite_prefix(s, r"C:\Users\İsmail\Documents\antenlab", r"C:\Users\İsmail\Documents\Fairbeam", true)
        };
        assert_eq!(
            w(r"C:\Users\İsmail\Documents\antenlab\models\patch.py").as_deref(),
            Some(r"C:\Users\İsmail\Documents\Fairbeam\models\patch.py")
        );
        assert_eq!(w(r"c:\users\İsmail\documents\ANTENLAB\jobs").as_deref(), Some(r"C:\Users\İsmail\Documents\Fairbeam\jobs"));
        assert_eq!(w(r"C:\Users\İsmail\Documents\antenlab_old\x"), None);
        // the slash form of the same path (Python's as_posix, JSON written by hand): the new
        // prefix takes the slashes too; a mixed form keeps the new prefix as given
        assert_eq!(
            w("C:/Users/İsmail/Documents/antenlab/models/patch.py").as_deref(),
            Some("C:/Users/İsmail/Documents/Fairbeam/models/patch.py")
        );
        assert_eq!(w("c:/users/İsmail/documents/antenlab").as_deref(), Some("C:/Users/İsmail/Documents/Fairbeam"));
        assert_eq!(w(r"C:\Users/İsmail\Documents/antenlab\jobs").as_deref(), Some(r"C:\Users\İsmail\Documents\Fairbeam\jobs"));
        assert_eq!(w("C:/Users/İsmail/Documents/antenlab2/x"), None);
        // not on macOS / Linux, where a backslash is an ordinary character
        assert_eq!(rewrite_prefix(r"\Users\a\Documents\antenlab", "/Users/a/Documents/antenlab", "/x", false), None);
        // a multi-byte character right at the cut does not panic
        assert_eq!(rewrite_prefix("ééé", "éa", "x", false), None);
        assert_eq!(rewrite_prefix("aé", "a\u{301}", "x", false), None);
    }

    #[test]
    fn job_json_paths_follow_the_move_with_a_backup() {
        let t = Temp::new("ws-jobs");
        let ws = t.path().join("Fairbeam");
        let old = "/Users/a/Documents/antenlab";
        let job = ws.join("jobs/20260928-110955-c72e7a");
        fs::create_dir_all(&job).unwrap();
        let original = json!({
            "id": "20260928-110955-c72e7a",
            "model_path": format!("{old}/models/patch.py"),
            "sim_dir": format!("{old}/.sim/patch"),
            "command": ["/venv/bin/python", "-m", "antenlab", "run", format!("{old}/models/patch.py")],
            "name": "antenlab",
            "other": "/Users/a/Documents/antenlab2/x",
            "created": 1759051795.25,
            "stats": {"nested": [format!("{old}/jobs")]}
        });
        fs::write(job.join("job.json"), serde_json::to_string_pretty(&original).unwrap()).unwrap();
        // a job without a job.json, and one that is not JSON
        fs::create_dir_all(ws.join("jobs/empty")).unwrap();
        fs::create_dir_all(ws.join("jobs/broken")).unwrap();
        fs::write(ws.join("jobs/broken/job.json"), "{").unwrap();
        let backup = ws.join(".fairbeam-import-backup/20261006-101500");

        let dry = rewrite_jobs(&ws, &[old.to_string()], Path::new("/Users/a/Documents/Fairbeam"), &backup, true);
        assert_eq!((dry.files, dry.changed), (2, 1));
        assert!(!backup.exists(), "a dry run writes nothing");

        let report = rewrite_jobs(&ws, &[old.to_string()], Path::new("/Users/a/Documents/Fairbeam"), &backup, false);
        assert_eq!((report.files, report.changed), (2, 1));
        assert_eq!(report.errors.len(), 1);
        assert!(report.errors[0].starts_with("broken: "));
        let v: Value = serde_json::from_str(&fs::read_to_string(job.join("job.json")).unwrap()).unwrap();
        assert_eq!(v["model_path"], "/Users/a/Documents/Fairbeam/models/patch.py");
        assert_eq!(v["sim_dir"], "/Users/a/Documents/Fairbeam/.sim/patch");
        assert_eq!(v["command"][4], "/Users/a/Documents/Fairbeam/models/patch.py");
        assert_eq!(v["command"][2], "antenlab", "only paths change");
        assert_eq!(v["name"], "antenlab");
        assert_eq!(v["other"], "/Users/a/Documents/antenlab2/x");
        assert_eq!(v["stats"]["nested"][0], "/Users/a/Documents/Fairbeam/jobs");
        assert_eq!(v["created"], 1759051795.25);
        let saved: Value =
            serde_json::from_str(&fs::read_to_string(backup.join("jobs/20260928-110955-c72e7a/job.json")).unwrap()).unwrap();
        assert_eq!(saved, original);
        // a second run changes nothing
        let again = rewrite_jobs(&ws, &[old.to_string()], Path::new("/Users/a/Documents/Fairbeam"), &backup, false);
        assert_eq!(again.changed, 0);
        assert!(!job.join(".job.json.fairbeam-import.tmp").exists());
    }
}
