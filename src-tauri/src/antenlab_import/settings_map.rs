// antenlab's settings.json (and the 0.6.9 handoff) → Fairbeam's Settings. Both are read as plain
// JSON values, so fields an older or newer antenlab wrote are tolerated; only the listed ones are
// taken over.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::paths::Settings;

/// localStorage keys (without the `antenlab.` prefix) taken over from the handoff, renamed to
/// `fairbeam.<key>`. Drafts (`draft:*`) and the last opened design (`lastDesign:*`) never are.
pub const VIEWER_KEYS: &[&str] = &[
    "generalSettings",
    "theme",
    "userMaterials",
    "home.favoriteDesigns",
    "home.designSort",
    "home.favoritesOnly",
    "render.options",
    "ribbonTab",
    "ribbonMinimized",
    // panel sizes
    "panel-left-width",
    "panel-right-width",
    "dock-height",
];

const OLD_PREFIX: &str = "antenlab.";
const NEW_PREFIX: &str = "fairbeam.";
const MAX_RECENT: usize = 8;

/// What the import takes over. `None` keeps Fairbeam's default.
#[derive(Debug, Default, PartialEq)]
pub struct Mapped {
    pub language: Option<String>,
    pub check_updates_on_start: Option<bool>,
    pub prefer_gpu: Option<bool>,
    pub gpu_runtime_enabled: Option<bool>,
    pub recent_designs: Vec<String>,
    /// an external Python (runtime "external") outside antenlab's own folders
    pub external_python: Option<String>,
    /// renamed handoff keys for the viewer (`take_imported_viewer_prefs`)
    pub viewer_prefs: Option<Map<String, Value>>,
    /// settings that were present and not taken over, by name (never their values)
    pub dropped: Vec<String>,
}

/// Read a JSON file; `None` when it is missing or not JSON.
pub fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

pub fn map(old: &Value, handoff: Option<&Value>, old_dirs: &[PathBuf]) -> Mapped {
    let bool_of = |k: &str| old.get(k).and_then(Value::as_bool);
    let mut m = Mapped {
        language: old
            .get("language")
            .and_then(Value::as_str)
            .filter(|l| matches!(*l, "en" | "tr"))
            .map(String::from),
        check_updates_on_start: bool_of("check_updates_on_start"),
        prefer_gpu: bool_of("prefer_gpu"),
        gpu_runtime_enabled: bool_of("gpu_runtime_enabled"),
        recent_designs: old
            .get("recent_designs")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .filter(|id| crate::valid_design_id(id))
                    .take(MAX_RECENT)
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default(),
        ..Mapped::default()
    };

    // an existing openEMS install the user chose: kept when it is not antenlab's own runtime
    let runtime = old.get("runtime").and_then(Value::as_str);
    let python = old.get("python").and_then(Value::as_str).filter(|p| !p.is_empty());
    if let (None | Some("external"), Some(py)) = (runtime, python) {
        if Path::new(py).is_file() && !inside_any(Path::new(py), old_dirs) {
            m.external_python = Some(py.to_string());
        } else {
            m.dropped.push("python".into());
        }
    }

    // (the workspace is the workspace step's business)
    for key in ["server_port", "account", "bundle_renamed", "old_copy_prompted"] {
        if old.get(key).is_some_and(|v| !v.is_null()) {
            m.dropped.push(key.into());
        }
    }

    let mut prefs = handoff.map(viewer_prefs).unwrap_or_default();
    // The viewer keeps its language choice in localStorage (General settings) and sends the
    // resolved language back to the shell on every start. Fairbeam's localStorage starts empty
    // ("System"), so without this an imported Turkish became the system language at once
    // (English on an English Windows). A choice the 0.6.9 handoff carries wins.
    if let Some(lang) = &m.language {
        with_language(&mut prefs, lang);
    }
    if !prefs.is_empty() {
        m.viewer_prefs = Some(prefs);
    }
    m
}

const GENERAL_SETTINGS: &str = "fairbeam.generalSettings";

/// `fairbeam.generalSettings` with `language` set, unless it names a language already (or is not
/// a JSON object, which the viewer would drop anyway).
fn with_language(prefs: &mut Map<String, Value>, lang: &str) {
    let mut general = match prefs.get(GENERAL_SETTINGS).and_then(Value::as_str) {
        None => Map::new(),
        Some(text) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(o)) => o,
            _ => return,
        },
    };
    if general.contains_key("language") {
        return;
    }
    general.insert("language".into(), Value::String(lang.into()));
    prefs.insert(GENERAL_SETTINGS.into(), Value::String(Value::Object(general).to_string()));
}

/// The allowlisted handoff keys, renamed `antenlab.X` → `fairbeam.X`.
pub fn viewer_prefs(handoff: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(storage) = handoff.get("local_storage").and_then(Value::as_object) else {
        return out;
    };
    for (key, value) in storage {
        let Some(rest) = key.strip_prefix(OLD_PREFIX) else { continue };
        if VIEWER_KEYS.contains(&rest) && value.is_string() {
            out.insert(format!("{NEW_PREFIX}{rest}"), value.clone());
        }
    }
    out
}

fn inside_any(p: &Path, dirs: &[PathBuf]) -> bool {
    let canon = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let p = canon(p);
    dirs.iter().any(|d| p.starts_with(canon(d)))
}

impl Mapped {
    pub fn apply(&self, s: &mut Settings) {
        if let Some(l) = &self.language {
            s.language = Some(l.clone());
        }
        if let Some(v) = self.check_updates_on_start {
            s.check_updates_on_start = v;
        }
        if let Some(v) = self.prefer_gpu {
            s.prefer_gpu = v;
        }
        if let Some(v) = self.gpu_runtime_enabled {
            s.gpu_runtime_enabled = v;
        }
        if !self.recent_designs.is_empty() {
            s.recent_designs = self.recent_designs.clone();
        }
        if let Some(py) = &self.external_python {
            s.runtime = Some("external".into());
            s.python = Some(py.clone());
        }
        if let Some(prefs) = &self.viewer_prefs {
            s.imported_viewer_prefs = Some(Value::Object(prefs.clone()));
        }
    }

    /// the names of what was taken over (for the report)
    pub fn imported(&self) -> Vec<&'static str> {
        let mut v = Vec::new();
        if self.language.is_some() {
            v.push("language");
        }
        if self.check_updates_on_start.is_some() {
            v.push("check_updates_on_start");
        }
        if self.prefer_gpu.is_some() {
            v.push("prefer_gpu");
        }
        if self.gpu_runtime_enabled.is_some() {
            v.push("gpu_runtime_enabled");
        }
        if !self.recent_designs.is_empty() {
            v.push("recent_designs");
        }
        if self.external_python.is_some() {
            v.push("python");
        }
        if self.viewer_prefs.is_some() {
            v.push("viewer_prefs");
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::Temp;
    use super::*;
    use serde_json::json;

    #[test]
    fn takes_over_the_listed_settings() {
        let old = json!({
            "language": "tr", "check_updates_on_start": false, "prefer_gpu": true,
            "gpu_runtime_enabled": true, "recent_designs": ["patch_24", "horn"],
            "runtime": "managed", "workspace": "/somewhere"
        });
        let m = map(&old, None, &[]);
        let mut s = Settings::default();
        m.apply(&mut s);
        assert_eq!(s.language.as_deref(), Some("tr"));
        assert!(!s.check_updates_on_start && s.prefer_gpu && s.gpu_runtime_enabled);
        assert_eq!(s.recent_designs, vec!["patch_24", "horn"]);
        // the managed runtime is never reused
        assert_eq!((s.runtime, s.python), (None, None));
        assert_eq!(s.workspace, None, "the workspace step decides");
        // the language also reaches the viewer, which otherwise starts on "System"
        assert_eq!(s.imported_viewer_prefs, Some(json!({"fairbeam.generalSettings": "{\"language\":\"tr\"}"})));
        // no language: no viewer preferences
        assert!(map(&json!({"prefer_gpu": false}), None, &[]).viewer_prefs.is_none());
    }

    #[test]
    fn the_language_joins_the_handoff_general_settings_unless_it_has_one() {
        let handoff = |general: &str| json!({"local_storage": {"antenlab.generalSettings": general, "antenlab.theme": "dark"}});
        let old = json!({"language": "tr"});
        let general = |m: &Mapped| -> Value {
            serde_json::from_str(m.viewer_prefs.as_ref().unwrap()["fairbeam.generalSettings"].as_str().unwrap()).unwrap()
        };
        let m = map(&old, Some(&handoff("{\"units\":\"compact\"}")), &[]);
        assert_eq!(general(&m), json!({"units": "compact", "language": "tr"}));
        assert_eq!(m.viewer_prefs.as_ref().unwrap()["fairbeam.theme"], "dark");
        // the viewer's own choice (here "System") is kept
        let m = map(&old, Some(&handoff("{\"language\":\"system\"}")), &[]);
        assert_eq!(general(&m), json!({"language": "system"}));
        // a value that is no JSON object is left as it is
        let m = map(&old, Some(&handoff("[1]")), &[]);
        assert_eq!(m.viewer_prefs.unwrap()["fairbeam.generalSettings"], "[1]");
    }

    #[test]
    fn keeps_a_0_4_1_gpu_choice() {
        // 0.4.1 and older wrote prefer_gpu: false unless the box was ticked
        let m = map(&json!({"prefer_gpu": false}), None, &[]);
        let mut s = Settings::default();
        m.apply(&mut s);
        assert!(!s.prefer_gpu);
        // missing: Fairbeam's default (on)
        let mut s = Settings::default();
        map(&json!({}), None, &[]).apply(&mut s);
        assert!(s.prefer_gpu && s.check_updates_on_start);
    }

    #[test]
    fn tolerates_unknown_missing_and_wrongly_typed_fields() {
        let old = json!({"future_field": {"x": 1}, "language": "de", "prefer_gpu": "yes",
            "recent_designs": ["ok_id", 3, "../escape", "Bad"]});
        let m = map(&old, None, &[]);
        assert_eq!(m.language, None);
        assert_eq!(m.prefer_gpu, None);
        assert_eq!(m.recent_designs, vec!["ok_id"]);
        assert_eq!(map(&json!(null), None, &[]), Mapped::default());
        assert_eq!(map(&json!([1, 2]), None, &[]), Mapped::default());
    }

    #[test]
    fn port_account_and_rename_flags_are_dropped() {
        let old = json!({"server_port": 5321, "account": {"login": "x"}, "bundle_renamed": true});
        let m = map(&old, None, &[]);
        assert_eq!(m.dropped, vec!["server_port", "account", "bundle_renamed"]);
        let mut s = Settings::default();
        m.apply(&mut s);
        assert_eq!(s.server_port, None);
        assert!(s.account.is_none());
    }

    #[test]
    fn external_python_inside_the_old_folders_is_dropped() {
        let t = Temp::new("settings-python");
        let old_dir = t.path().join("old");
        let inside = old_dir.join("runtime/venv/bin/python3");
        let outside = t.path().join("opt/openEMS/venv/bin/python3");
        for p in [&inside, &outside] {
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, "").unwrap();
        }
        let dirs = [old_dir.clone()];
        let m = map(&json!({"runtime": "external", "python": inside}), None, &dirs);
        assert_eq!(m.external_python, None);
        assert_eq!(m.dropped, vec!["python"]);

        let m = map(&json!({"runtime": "external", "python": outside}), None, &dirs);
        assert_eq!(m.external_python.as_deref(), Some(outside.to_str().unwrap()));
        let mut s = Settings::default();
        m.apply(&mut s);
        assert_eq!(s.runtime.as_deref(), Some("external"));
        assert_eq!(s.external(), Some(outside.clone()));
        // runtime unset with a python is external too (Settings::external)
        assert!(map(&json!({"python": outside}), None, &dirs).external_python.is_some());
        // a python that no longer exists, or a managed runtime, is not kept
        assert_eq!(map(&json!({"runtime": "external", "python": "/missing/python"}), None, &dirs).external_python, None);
        assert_eq!(map(&json!({"runtime": "managed", "python": outside}), None, &dirs).external_python, None);
    }

    #[test]
    fn handoff_keys_are_allowlisted_and_renamed() {
        let handoff = json!({
            "schema": "antenlab.handoff/1", "version": "0.6.9",
            "local_storage": {
                "antenlab.theme": "dark",
                "antenlab.generalSettings": "{\"units\":\"mm\"}",
                "antenlab.home.favoriteDesigns": "[\"horn\"]",
                "antenlab.panel-left-width": "280",
                "antenlab.draft:horn": "{...}",
                "antenlab.lastDesign:x": "horn",
                "antenlab.threads": "8",
                "other.theme": "light",
                "antenlab.ribbonMinimized": true
            }
        });
        let m = map(&json!({}), Some(&handoff), &[]);
        let prefs = m.viewer_prefs.clone().unwrap();
        let mut keys: Vec<&String> = prefs.keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            ["fairbeam.generalSettings", "fairbeam.home.favoriteDesigns", "fairbeam.panel-left-width", "fairbeam.theme"]
        );
        assert_eq!(prefs["fairbeam.theme"], "dark");
        let mut s = Settings::default();
        m.apply(&mut s);
        assert_eq!(s.imported_viewer_prefs, Some(Value::Object(prefs)));
        // no handoff, or one without local_storage: nothing
        assert_eq!(map(&json!({}), Some(&json!({"schema": "x"})), &[]).viewer_prefs, None);
        assert!(m.imported().contains(&"viewer_prefs"));
    }
}
