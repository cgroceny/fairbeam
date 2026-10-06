// Python models in the workspace: `import antenlab` becomes `import fairbeam`.
//
// Rules (only in files that import the package):
// - `^(\s*)from\s+antenlab(\.[\w.]+)?\s+import\b`   → the package name becomes fairbeam
// - `^(\s*)import\s+antenlab\b(\.[\w.]+)?(\s+as\s+\w+)?` → likewise
// - then, in a file that matched either rule: `\bantenlab\.(?=[A-Za-z_])` → `fairbeam.` and
//   `\bANTENLAB_ORGANIZATION\b` → `FAIRBEAM_ORGANIZATION`
// `antenlab_utils` and prose such as "antenlab run" stay. Each changed file is copied to the
// backup folder first and written through a temp file and a rename; the BOM and CRLF line ends are
// kept, and a second run changes nothing.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::workspace::write_replace;

const OLD: &str = "antenlab";
const NEW: &str = "fairbeam";
const OLD_ORG: &str = "ANTENLAB_ORGANIZATION";
const NEW_ORG: &str = "FAIRBEAM_ORGANIZATION";
const MAX_BYTES: u64 = 1024 * 1024;
const BOM: char = '\u{feff}';

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Skip Python's whitespace inside a line (not the line end).
fn skip_ws(s: &str) -> &str {
    s.trim_start_matches([' ', '\t', '\x0c'])
}

/// After a keyword: at least one whitespace character, then the rest.
fn after_keyword<'a>(s: &'a str, keyword: &str) -> Option<&'a str> {
    let rest = s.strip_prefix(keyword)?;
    let skipped = skip_ws(rest);
    (skipped.len() < rest.len()).then_some(skipped)
}

/// `.name.name` right after the package name (possibly empty).
fn dotted_len(s: &str) -> usize {
    if !s.starts_with('.') {
        return 0;
    }
    let tail = &s[1..];
    let n = tail.find(|c: char| !(is_word(c) || c == '.')).unwrap_or(tail.len());
    if n == 0 {
        0
    } else {
        n + 1
    }
}

/// The byte offset of the package name in an import line of the old package, if it is one.
fn import_name_at(line: &str) -> Option<usize> {
    let body = skip_ws(line);
    let indent = line.len() - body.len();
    if let Some(rest) = after_keyword(body, "from") {
        let at = body.len() - rest.len();
        let after = rest.strip_prefix(OLD)?;
        let after = &after[dotted_len(after)..];
        let gap = skip_ws(after);
        if gap.len() == after.len() {
            return None;
        }
        let tail = gap.strip_prefix("import")?;
        if tail.starts_with(is_word) {
            return None;
        }
        return Some(indent + at);
    }
    if let Some(rest) = after_keyword(body, "import") {
        let at = body.len() - rest.len();
        let after = rest.strip_prefix(OLD)?;
        if after.starts_with(is_word) {
            return None;
        }
        return Some(indent + at);
    }
    None
}

/// Replace `word` by `with` where it is not preceded by a word character and `follows` accepts
/// the rest of the line after it.
fn replace_bounded(line: &str, word: &str, with: &str, follows: impl Fn(&str) -> bool) -> String {
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while let Some(found) = line[i..].find(word) {
        let at = i + found;
        let before_ok = !line[..at].chars().next_back().is_some_and(is_word);
        let end = at + word.len();
        out.push_str(&line[i..at]);
        if before_ok && follows(&line[end..]) {
            out.push_str(with);
        } else {
            out.push_str(word);
        }
        i = end;
    }
    out.push_str(&line[i..]);
    out
}

/// The rewritten text, or `None` when the file does not import the old package (or is already
/// rewritten).
pub fn rewrite_text(text: &str) -> Option<String> {
    let (bom, body) = match text.strip_prefix(BOM) {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let mut matched = false;
    let mut lines: Vec<String> = body
        .split_inclusive('\n')
        .map(|line| match import_name_at(line) {
            Some(at) => {
                matched = true;
                format!("{}{NEW}{}", &line[..at], &line[at + OLD.len()..])
            }
            None => line.to_string(),
        })
        .collect();
    if !matched {
        return None;
    }
    let dotted = format!("{OLD}.");
    for line in &mut lines {
        if line.contains(&dotted) {
            // the old website (antenlab.akdag.dev) is a host name, not the package
            *line = replace_bounded(line, &dotted, &format!("{NEW}."), |rest| {
                rest.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') && !rest.starts_with("akdag.")
            });
        }
        if line.contains(OLD_ORG) {
            *line = replace_bounded(line, OLD_ORG, NEW_ORG, |rest| !rest.starts_with(is_word));
        }
    }
    let mut out = String::with_capacity(text.len() + 16);
    if bom {
        out.push(BOM);
    }
    out.extend(lines);
    (out != text).then_some(out)
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct PyReport {
    /// .py files looked at
    pub scanned: usize,
    /// rewritten files, relative to the workspace
    pub changed: Vec<String>,
    /// (relative path, reason): over 1 MB, not UTF-8
    pub skipped: Vec<(String, String)>,
    /// (relative path, error)
    pub errors: Vec<(String, String)>,
}

/// Folders never searched: dot-folders (.sim, .git, the backup), node_modules, caches and Python
/// environments (an installed antenlab package must not be rewritten).
fn skip_dir(dir: &Path, name: &str) -> bool {
    name.starts_with('.')
        || matches!(name, "node_modules" | "__pycache__" | "site-packages")
        || dir.join("pyvenv.cfg").is_file()
}

/// Every .py file to look at (sorted), and the ones skipped with why.
pub fn scan(ws: &Path) -> (Vec<PathBuf>, Vec<(PathBuf, String)>) {
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut stack = vec![ws.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            // symlink_metadata: links are never followed
            let Ok(meta) = fs::symlink_metadata(&path) else { continue };
            if meta.is_dir() {
                if !skip_dir(&path, &name) {
                    stack.push(path);
                }
            } else if meta.is_file() && name.ends_with(".py") {
                if meta.len() > MAX_BYTES {
                    skipped.push((path, "over 1 MB".to_string()));
                } else {
                    files.push(path);
                }
            }
        }
    }
    files.sort();
    skipped.sort();
    (files, skipped)
}

fn rel(ws: &Path, p: &Path) -> String {
    p.strip_prefix(ws).unwrap_or(p).to_string_lossy().into_owned()
}

/// Rewrite the workspace's Python files; originals go to `<backup>/<relative path>`.
pub fn rewrite_workspace(ws: &Path, backup: &Path, dry_run: bool) -> PyReport {
    let (files, skipped) = scan(ws);
    let mut report = PyReport {
        scanned: files.len(),
        skipped: skipped.iter().map(|(p, why)| (rel(ws, p), why.clone())).collect(),
        ..PyReport::default()
    };
    for file in files {
        let name = rel(ws, &file);
        let bytes = match fs::read(&file) {
            Ok(b) => b,
            Err(e) => {
                report.errors.push((name, e.to_string()));
                continue;
            }
        };
        let Ok(text) = String::from_utf8(bytes) else {
            report.skipped.push((name, "not UTF-8".into()));
            continue;
        };
        let Some(new_text) = rewrite_text(&text) else { continue };
        if !dry_run {
            let saved = backup.join(file.strip_prefix(ws).unwrap_or(&file));
            let step = (|| -> std::io::Result<()> {
                if !saved.exists() {
                    fs::create_dir_all(saved.parent().unwrap_or(backup))?;
                    fs::copy(&file, &saved)?;
                }
                write_replace(&file, new_text.as_bytes())
            })();
            if let Err(e) = step {
                report.errors.push((name, e.to_string()));
                continue;
            }
        }
        report.changed.push(name);
    }
    report.skipped.sort();
    report
}

#[cfg(test)]
mod tests {
    use super::super::testutil::Temp;
    use super::*;

    #[test]
    fn rewrite_table() {
        let cases: &[(&str, Option<&str>)] = &[
            ("from antenlab import Param, Simulation\n", Some("from fairbeam import Param, Simulation\n")),
            ("from antenlab.mesh import Grid\n", Some("from fairbeam.mesh import Grid\n")),
            ("    from antenlab.analytic.patch import dims  # local\n", Some("    from fairbeam.analytic.patch import dims  # local\n")),
            ("from antenlab import (\n    Param,\n)\n", Some("from fairbeam import (\n    Param,\n)\n")),
            ("import antenlab\n", Some("import fairbeam\n")),
            ("import antenlab as al\n", Some("import fairbeam as al\n")),
            ("import antenlab.analytic as an\n", Some("import fairbeam.analytic as an\n")),
            ("import antenlab, numpy as np\n", Some("import fairbeam, numpy as np\n")),
            (
                "import antenlab\nsim = antenlab.Simulation(name='antenlab run')\n",
                Some("import fairbeam\nsim = fairbeam.Simulation(name='antenlab run')\n"),
            ),
            (
                "from antenlab import Param\nANTENLAB_ORGANIZATION = {\"a\": 1}\nX_ANTENLAB_ORGANIZATION = 2\n",
                Some("from fairbeam import Param\nFAIRBEAM_ORGANIZATION = {\"a\": 1}\nX_ANTENLAB_ORGANIZATION = 2\n"),
            ),
            // a module of the user's own with a similar name
            ("import antenlab_utils\nantenlab_utils.go()\n", None),
            ("from antenlab_utils import go\n", None),
            ("import antenlabx\n", None),
            ("from antenlabs import x\n", None),
            ("from antenlab.mesh importx\n", None),
            (
                "import antenlab\n# see https://antenlab.akdag.dev/guide\nx = antenlab.Param\n",
                Some("import fairbeam\n# see https://antenlab.akdag.dev/guide\nx = fairbeam.Param\n"),
            ),
            // prose and other uses without an import of the package
            ("\"\"\"Run with antenlab run model.py.\"\"\"\nx = antenlab.Simulation\n", None),
            ("# from antenlab import Param\n", None),
            ("x = 1\n", None),
            ("", None),
            // in a file that imports it: dotted names change, other words do not
            (
                "import antenlab\n\"\"\"Docs: antenlab run, antenlab.org? my_antenlab.x and antenlab.5\"\"\"\n",
                Some("import fairbeam\n\"\"\"Docs: antenlab run, fairbeam.org? my_antenlab.x and antenlab.5\"\"\"\n"),
            ),
        ];
        for (input, want) in cases {
            assert_eq!(rewrite_text(input).as_deref(), *want, "input: {input:?}");
        }
    }

    #[test]
    fn keeps_crlf_and_bom_and_is_idempotent() {
        let text = "\u{feff}from antenlab import Param\r\nx = antenlab.Simulation()\r\n";
        let out = rewrite_text(text).unwrap();
        assert_eq!(out, "\u{feff}from fairbeam import Param\r\nx = fairbeam.Simulation()\r\n");
        assert_eq!(rewrite_text(&out), None);
        // no line end at the end of the file
        assert_eq!(rewrite_text("import antenlab").as_deref(), Some("import fairbeam"));
    }

    #[test]
    fn workspace_rewrite_with_backup_and_skips() {
        let t = Temp::new("py-ws");
        let ws = t.path().join("Fairbeam");
        let write = |rel: &str, bytes: &[u8]| {
            let p = ws.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, bytes).unwrap();
            p
        };
        let model = write("models/patch.py", b"from antenlab import Param\r\nprint('antenlab')\r\n");
        let nested = write("models/arrays/feed.py", b"import antenlab as al\n");
        write("models/plain.py", b"x = 1\n");
        write("models/latin1.py", b"import antenlab\n# caf\xe9\n");
        write("models/big.py", &vec![b'#'; (MAX_BYTES + 1) as usize]);
        write(".sim/patch/run.py", b"import antenlab\n");
        write("node_modules/x/a.py", b"import antenlab\n");
        write("venv/pyvenv.cfg", b"home = /usr\n");
        write("venv/lib/python3.12/site-packages/antenlab/__init__.py", b"from antenlab.core import x\n");
        write("models/notes.txt", b"import antenlab\n");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&model, ws.join("models/link.py")).unwrap();

        let backup = ws.join(".fairbeam-import-backup/20261006-101500");
        let dry = rewrite_workspace(&ws, &backup, true);
        assert_eq!(dry.changed.len(), 2);
        assert!(!backup.exists());
        assert_eq!(fs::read_to_string(&model).unwrap(), "from antenlab import Param\r\nprint('antenlab')\r\n");

        let report = rewrite_workspace(&ws, &backup, false);
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(report.changed, vec![format!("models{sep}arrays{sep}feed.py"), format!("models{sep}patch.py")]);
        assert_eq!(report.scanned, 4, "{report:?}");
        assert_eq!(
            report.skipped,
            vec![
                (format!("models{sep}big.py"), "over 1 MB".to_string()),
                (format!("models{sep}latin1.py"), "not UTF-8".to_string())
            ]
        );
        assert!(report.errors.is_empty());
        assert_eq!(fs::read_to_string(&model).unwrap(), "from fairbeam import Param\r\nprint('antenlab')\r\n");
        assert_eq!(fs::read_to_string(&nested).unwrap(), "import fairbeam as al\n");
        assert_eq!(
            fs::read_to_string(backup.join("models/patch.py")).unwrap(),
            "from antenlab import Param\r\nprint('antenlab')\r\n"
        );
        assert_eq!(fs::read_to_string(backup.join("models/arrays/feed.py")).unwrap(), "import antenlab as al\n");
        assert_eq!(fs::read_to_string(ws.join(".sim/patch/run.py")).unwrap(), "import antenlab\n");
        assert_eq!(
            fs::read_to_string(ws.join("venv/lib/python3.12/site-packages/antenlab/__init__.py")).unwrap(),
            "from antenlab.core import x\n"
        );
        // a second run is a no-op (and makes no second backup)
        let again = rewrite_workspace(&ws, &ws.join(".fairbeam-import-backup/later"), false);
        assert!(again.changed.is_empty());
        assert!(!ws.join(".fairbeam-import-backup/later").exists());
    }
}
