// First start: fill the workspace with the bundled example projects, models and templates. A
// folder is seeded only while it does not exist or is empty, so the user's files are never touched.
// On every start the app-owned example bundles (the files the bundled index lists) are refreshed
// as well, so an update's new or regenerated examples reach existing workspaces; user runs and
// copies are other files and stay as they are. The examples' sources (the Python models and the
// 867 MHz example designs, read-only in the app) that are missing from the models folder are
// copied too, so every example can be opened as a new design; a file already there is kept.

use std::fs;
use std::io;
use std::path::Path;

use crate::paths::{Res, Workspace};

fn is_empty(dir: &Path) -> bool {
    fs::read_dir(dir).map(|mut it| it.next().is_none()).unwrap_or(true)
}

fn copy_tree(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if name.to_string_lossy() == "__pycache__" {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        if entry.file_type()?.is_dir() {
            copy_tree(&from, &to)?;
        } else if !to.exists() {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// The bundled example bundles: the top-level files listed in `<src>/index.json`.
fn bundled_examples(src: &Path) -> Vec<(String, serde_json::Value)> {
    let Ok(text) = fs::read_to_string(src.join("index.json")) else { return Vec::new() };
    let Ok(index) = serde_json::from_str::<serde_json::Value>(&text) else { return Vec::new() };
    index["projects"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|e| {
                    let f = e["file"].as_str()?;
                    // a plain file name in the folder itself, never a path out of it
                    let ok = !f.is_empty() && !f.contains(['/', '\\']) && f != "index.json" && f.ends_with(".json");
                    ok.then(|| (f.to_string(), e.clone()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Copy the bundled example bundles that are missing or differ into `dst`, and put their entries
/// into `dst/index.json` (replacing entries for the same file, keeping every other entry and its
/// order). Returns the files that were copied.
pub fn refresh_examples(src: &Path, dst: &Path) -> io::Result<Vec<String>> {
    let examples = bundled_examples(src);
    if examples.is_empty() || !dst.is_dir() {
        return Ok(Vec::new());
    }
    let mut copied = Vec::new();
    for (file, _) in &examples {
        let (from, to) = (src.join(file), dst.join(file));
        let Ok(new) = fs::read(&from) else { continue };
        if fs::read(&to).map(|old| old != new).unwrap_or(true) {
            let tmp = to.with_extension("json.tmp");
            fs::write(&tmp, &new)?;
            fs::rename(&tmp, &to)?;
            copied.push(file.clone());
        }
    }
    let index_path = dst.join("index.json");
    let mut index: serde_json::Value = fs::read_to_string(&index_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .filter(|v: &serde_json::Value| v["projects"].is_array())
        .unwrap_or_else(|| serde_json::json!({ "projects": [] }));
    let entries = index["projects"].as_array_mut().unwrap();
    let mut changed = false;
    for (file, entry) in &examples {
        if !dst.join(file).is_file() {
            continue;
        }
        match entries.iter_mut().find(|e| e["file"].as_str() == Some(file)) {
            Some(e) if e == entry => {}
            Some(e) => {
                *e = entry.clone();
                changed = true;
            }
            None => {
                entries.push(entry.clone());
                changed = true;
            }
        }
    }
    if changed {
        let tmp = index_path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&index).unwrap())?;
        fs::rename(&tmp, &index_path)?;
    }
    Ok(copied)
}

/// Copy the examples' sources in `src` (`*.py` models and `*.design.json` designs) that `dst` lacks.
/// A file already in `dst` is never replaced (a source is read-only in the app; a file of that name
/// stays as it is). Returns the files that were copied.
pub fn add_missing_sources(src: &Path, dst: &Path) -> io::Result<Vec<String>> {
    if !src.is_dir() || !dst.is_dir() {
        return Ok(Vec::new());
    }
    let mut names: Vec<String> = fs::read_dir(src)?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".py") || n.ends_with(".design.json"))
        .collect();
    names.sort();
    let mut copied = Vec::new();
    for name in names {
        let to = dst.join(&name);
        if to.exists() {
            continue;
        }
        fs::copy(src.join(&name), &to)?;
        copied.push(name);
    }
    Ok(copied)
}

/// Seed the workspace; returns the folders that were filled.
pub fn seed(ws: &Workspace, res: &Res) -> Result<Vec<String>, String> {
    if ws.checkout {
        return Ok(Vec::new());
    }
    let mut done = Vec::new();
    for (src, dst) in [(&res.projects, ws.projects.clone()), (&res.models, ws.models.clone()), (&res.templates, ws.templates())] {
        if src.is_dir() && is_empty(&dst) {
            copy_tree(src, &dst).map_err(|e| format!("could not seed {}: {e}", dst.display()))?;
            done.push(dst.display().to_string());
        }
    }
    // a failed refresh only means older examples: it never stops the start
    if let Err(e) = refresh_examples(&res.projects, &ws.projects) {
        eprintln!("could not refresh the bundled examples in {}: {e}", ws.projects.display());
    }
    if let Err(e) = add_missing_sources(&res.models, &ws.models) {
        eprintln!("could not add the examples' sources to {}: {e}", ws.models.display());
    }
    for d in [&ws.jobs, &ws.sim] {
        fs::create_dir_all(d).map_err(|e| format!("could not create {}: {e}", d.display()))?;
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("fairbeam-seed-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn refresh_adds_new_and_changed_examples_and_keeps_user_runs() {
        let (src, dst) = (dir("src"), dir("dst"));
        fs::write(src.join("index.json"), r#"{"projects":[{"file":"horn.json","name":"Horn v2"},{"file":"uav.json","name":"UAV"}]}"#).unwrap();
        fs::write(src.join("horn.json"), "new horn").unwrap();
        fs::write(src.join("uav.json"), "uav").unwrap();
        fs::write(dst.join("index.json"), r#"{"projects":[{"file":"my-run.json","name":"Mine"},{"file":"horn.json","name":"Horn v1"}],"updated":"x"}"#).unwrap();
        fs::write(dst.join("horn.json"), "old horn").unwrap();
        fs::write(dst.join("my-run.json"), "mine").unwrap();

        let copied = refresh_examples(&src, &dst).unwrap();
        assert_eq!(copied, vec!["horn.json".to_string(), "uav.json".to_string()]);
        assert_eq!(fs::read_to_string(dst.join("horn.json")).unwrap(), "new horn");
        assert_eq!(fs::read_to_string(dst.join("my-run.json")).unwrap(), "mine");
        let index: serde_json::Value = serde_json::from_str(&fs::read_to_string(dst.join("index.json")).unwrap()).unwrap();
        let files: Vec<&str> = index["projects"].as_array().unwrap().iter().map(|e| e["file"].as_str().unwrap()).collect();
        assert_eq!(files, vec!["my-run.json", "horn.json", "uav.json"]);
        assert_eq!(index["projects"][1]["name"], "Horn v2");
        assert_eq!(index["updated"], "x");

        // a second start changes nothing
        assert!(refresh_examples(&src, &dst).unwrap().is_empty());
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn missing_example_sources_are_added_and_existing_files_kept() {
        let (src, dst) = (dir("src3"), dir("dst3"));
        fs::write(src.join("dipole.py"), "bundled dipole").unwrap();
        fs::write(src.join("yagi_867.design.json"), "bundled yagi").unwrap();
        fs::write(src.join("notes.txt"), "not a source").unwrap();
        fs::create_dir_all(src.join("__pycache__")).unwrap();
        fs::write(dst.join("dipole.py"), "kept as it is").unwrap();

        let copied = add_missing_sources(&src, &dst).unwrap();
        assert_eq!(copied, vec!["yagi_867.design.json".to_string()]);
        assert_eq!(fs::read_to_string(dst.join("yagi_867.design.json")).unwrap(), "bundled yagi");
        assert_eq!(fs::read_to_string(dst.join("dipole.py")).unwrap(), "kept as it is");
        assert!(!dst.join("notes.txt").exists() && !dst.join("__pycache__").exists());
        assert!(add_missing_sources(&src, &dst).unwrap().is_empty());
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn refresh_ignores_paths_out_of_the_folder() {
        let (src, dst) = (dir("src2"), dir("dst2"));
        fs::write(src.join("index.json"), r#"{"projects":[{"file":"../evil.json"},{"file":"index.json"}]}"#).unwrap();
        assert!(refresh_examples(&src, &dst).unwrap().is_empty());
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }
}
