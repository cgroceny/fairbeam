//! Native reveal accepts only the exact existing Design selected from its workspace.
use std::path::{Path, PathBuf};
pub fn validate(root: &Path, id: &str, path: &Path) -> Result<PathBuf, String> {
    let bytes = id.as_bytes();
    if !(2..=41).contains(&bytes.len()) || !bytes[0].is_ascii_lowercase()
        || !bytes[1..].iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_') {
        return Err("Invalid design id".into());
    }
    let requested = path.canonicalize().map_err(|e| e.to_string())?;
    for directory in [root.join("models"), root.join("python").join("models")] {
        let expected = directory.join(format!("{id}.design.json"));
        let parent = directory.canonicalize().ok();
        if expected.is_file() && expected.canonicalize().ok().as_ref() == Some(&requested)
            && parent.as_deref() == requested.parent() {
            return Ok(requested);
        }
    }
    Err("Only an existing design in the active workspace can be shown".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn only_exact_existing_workspace_design_can_be_revealed() {
        let parent = std::env::temp_dir();
        let root = parent.join(format!("fairbeam-design-reveal-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(root.join("models")).unwrap();
        let file = root.join("models/saved_design.design.json"); fs::write(&file,b"{}").unwrap();
        assert_eq!(validate(&root,"saved_design",&file).unwrap(),file.canonicalize().unwrap());
        assert!(validate(&root,"../saved_design",&file).is_err());
        assert!(validate(&root,"another_design",&file).is_err());
        let other = root.join("saved_design.design.json"); fs::write(&other,b"{}").unwrap();
        assert!(validate(&root,"saved_design",&other).is_err());
        assert!(validate(&root,"missing_design",&root.join("models/missing_design.design.json")).is_err());
        fs::create_dir_all(root.join("python/models")).unwrap();
        let checkout = root.join("python/models/checkout_design.design.json");fs::write(&checkout,b"{}").unwrap();
        assert!(validate(&root,"checkout_design",&checkout).is_ok());
        assert!(root.starts_with(&parent));
        fs::remove_dir_all(&root).unwrap();
    }
}
