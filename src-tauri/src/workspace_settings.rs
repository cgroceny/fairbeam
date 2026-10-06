use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, PartialEq, Eq)]
pub enum WorkspaceError {
    NotFolder,
    ProtectedPath,
    NotWritable,
}

impl WorkspaceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFolder => "workspace_not_folder",
            Self::ProtectedPath => "workspace_protected_path",
            Self::NotWritable => "workspace_not_writable",
        }
    }
}

/// Validate a folder before saving it as the workspace for the next app start.
/// The workspace must be an existing writable directory outside app resources and runtime data.
pub fn validate(
    candidate: &Path,
    resources: &Path,
    runtime: &Path,
) -> Result<PathBuf, WorkspaceError> {
    if !candidate.is_dir() {
        return Err(WorkspaceError::NotFolder);
    }

    let candidate = canonical(candidate);
    let resources = canonical(resources);
    let runtime = canonical(runtime);
    if overlaps(&candidate, &resources) || overlaps(&candidate, &runtime) {
        return Err(WorkspaceError::ProtectedPath);
    }
    if !probe_writable(&candidate) {
        return Err(WorkspaceError::NotWritable);
    }
    Ok(candidate)
}

fn canonical(path: &Path) -> PathBuf {
    crate::paths::canonical(path)
}

fn overlaps(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        let normalized = |path: &Path| {
            path.to_string_lossy()
                .replace('/', "\\")
                .trim_end_matches('\\')
                .to_lowercase()
        };
        let a = normalized(a);
        let b = normalized(b);
        return path_contains(&a, &b) || path_contains(&b, &a);
    }
    #[cfg(not(windows))]
    {
        a.starts_with(b) || b.starts_with(a)
    }
}

#[cfg(windows)]
fn path_contains(parent: &str, child: &str) -> bool {
    child == parent || child.starts_with(&format!("{parent}\\"))
}

fn probe_writable(directory: &Path) -> bool {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let probe = directory.join(format!(
        ".fairbeam-workspace-check-{}-{nonce}",
        std::process::id()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .ok()?;
        file.write_all(b"").ok()?;
        drop(file);
        fs::remove_file(&probe).ok()?;
        Some(())
    })();
    if result.is_none() {
        let _ = fs::remove_file(&probe);
    }
    result.is_some()
}

#[cfg(test)]
mod tests {
    use super::{canonical, validate, WorkspaceError};
    use std::fs;
    use std::path::PathBuf;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "fairbeam-workspace-settings-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn accepts_a_writable_folder_outside_resources_and_runtime() {
        let temp = TempRoot::new();
        let candidate = temp.0.join("workspace");
        let resources = temp.0.join("resources");
        let runtime = temp.0.join("app-data").join("runtime");
        fs::create_dir_all(&candidate).unwrap();
        fs::create_dir_all(&resources).unwrap();

        assert_eq!(
            validate(&candidate, &resources, &runtime),
            Ok(canonical(&candidate))
        );
        assert_eq!(
            fs::read_dir(&candidate).unwrap().count(),
            0,
            "the write probe is removed"
        );
    }

    #[test]
    fn rejects_missing_and_overlapping_folders() {
        let temp = TempRoot::new();
        let resources = temp.0.join("resources");
        let runtime = temp.0.join("app-data").join("runtime");
        fs::create_dir_all(resources.join("ui")).unwrap();
        fs::create_dir_all(&runtime).unwrap();

        assert_eq!(
            validate(&temp.0.join("missing"), &resources, &temp.0.join("runtime")),
            Err(WorkspaceError::NotFolder)
        );
        assert_eq!(
            validate(&resources.join("ui"), &resources, &temp.0.join("runtime")),
            Err(WorkspaceError::ProtectedPath)
        );
        assert_eq!(
            validate(&resources, &resources.join("ui"), &temp.0.join("runtime")),
            Err(WorkspaceError::ProtectedPath)
        );
        assert_eq!(
            validate(&temp.0.join("app-data"), &resources, &runtime),
            Err(WorkspaceError::ProtectedPath)
        );
    }
}
