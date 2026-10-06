// The importer's dialog texts in English and Turkish. They are kept here and not in i18n.rs so that
// only this folder needs to name the old app. Turkish suffixes: antenlab takes back-vowel ones
// (antenlab'ı, antenlab'dan), Fairbeam front-vowel ones (Fairbeam'i, Fairbeam'e).

/// (key, English, Turkish)
const TEXTS: &[(&str, &str, &str)] = &[
    ("import-title", "Import from antenlab", "antenlab'dan içe aktar"),
    (
        "import-intro",
        "Fairbeam found antenlab on this computer. Fairbeam is the new name of antenlab and is installed as a separate app.\n\nImport now:",
        "Fairbeam bu bilgisayarda antenlab'ı buldu. Fairbeam, antenlab'ın yeni adıdır ve ayrı bir uygulama olarak kurulur.\n\nŞimdi içe aktarılacaklar:",
    ),
    (
        "import-settings",
        "• settings (language, update check, GPU choice{appearance}) and recent designs",
        "• ayarlar (dil, güncelleme denetimi, GPU seçimi{appearance}) ve son tasarımlar",
    ),
    ("appearance-item", ", appearance", ", görünüm"),
    ("import-workspace-move", "• your workspace: {old} becomes {new}", "• çalışma klasörünüz: {old}, {new} olur"),
    ("import-workspace-keep", "• your workspace: stays at {path}", "• çalışma klasörünüz: {path} konumunda kalır"),
    (
        "import-python",
        "• your Python models: \"import antenlab\" becomes \"import fairbeam\" (the originals are kept in {backup})",
        "• Python modelleriniz: \"import antenlab\", \"import fairbeam\" olur (asılları {backup} içinde saklanır)",
    ),
    (
        "import-not",
        "Not imported: unsaved drafts and GitHub sign-in. The simulation runtime is downloaded and installed again.",
        "Aktarılmayanlar: kaydedilmemiş taslaklar ve GitHub oturumu. Simülasyon çalışma ortamı yeniden indirilip kurulur.",
    ),
    (
        "import-not-appearance",
        "Not imported: unsaved drafts, GitHub sign-in and appearance settings. The simulation runtime is downloaded and installed again.",
        "Aktarılmayanlar: kaydedilmemiş taslaklar, GitHub oturumu ve görünüm ayarları. Simülasyon çalışma ortamı yeniden indirilip kurulur.",
    ),
    ("import-yes", "Import", "İçe aktar"),
    ("import-no", "Start fresh", "Sıfırdan başla"),
    ("importing", "Importing from antenlab…", "antenlab'dan içe aktarılıyor…"),
    (
        "running-message",
        "antenlab is open. Quit antenlab, then choose Try again.",
        "antenlab açık. antenlab'dan çıkın, sonra Yeniden dene'yi seçin.",
    ),
    ("running-yes", "Try again", "Yeniden dene"),
    ("running-no", "Later", "Sonra"),
    (
        "move-failed-message",
        "{old} could not be renamed to {new}: {error}\n\nClose any program that uses files in it, then choose Try again. Otherwise Fairbeam keeps using {old}.",
        "{old}, {new} olarak yeniden adlandırılamadı: {error}\n\nİçindeki dosyaları kullanan programları kapatıp Yeniden dene'yi seçin. Aksi halde Fairbeam {old} klasörünü kullanmaya devam eder.",
    ),
    ("move-yes", "Try again", "Yeniden dene"),
    ("move-no", "Keep the old folder", "Eski klasörü kullan"),
    ("remove-title", "Remove antenlab", "antenlab'ı kaldır"),
    ("remove-intro", "Import finished: {summary}", "İçe aktarma bitti: {summary}"),
    (
        "remove-message-macos",
        "Remove antenlab now? The antenlab app and its data folders (including its runtime, {size}) go to the Trash. You can put them back until you empty it. Your workspace is not touched.",
        "antenlab şimdi kaldırılsın mı? antenlab uygulaması ve veri klasörleri (çalışma ortamı dahil, {size}) Çöp Sepeti'ne taşınır; sepeti boşaltana kadar geri alabilirsiniz. Çalışma klasörünüze dokunulmaz.",
    ),
    (
        "remove-message-windows",
        "Remove antenlab now? antenlab is uninstalled and its data folders (including its runtime, {size}) are deleted. Your workspace and the backup are not touched.",
        "antenlab şimdi kaldırılsın mı? antenlab kaldırılır ve veri klasörleri (çalışma ortamı dahil, {size}) silinir. Çalışma klasörünüze ve yedeğe dokunulmaz.",
    ),
    ("remove-yes", "Remove antenlab", "antenlab'ı kaldır"),
    ("remove-no", "Keep for now", "Şimdilik kalsın"),
    ("remove-done-macos", "antenlab was moved to the Trash.", "antenlab Çöp Sepeti'ne taşındı."),
    ("remove-done-windows", "antenlab was removed.", "antenlab kaldırıldı."),
    (
        "remove-failed",
        "Some items could not be removed: {list}. Details are in shell.log.",
        "Bazı öğeler kaldırılamadı: {list}. Ayrıntılar shell.log dosyasında.",
    ),
    (
        "remove-none",
        "Nothing of antenlab is left on this computer.",
        "Bu bilgisayarda antenlab'dan bir şey kalmadı.",
    ),
    (
        "failed-message",
        "Some steps did not finish: {list}. Fairbeam starts anyway; details are in shell.log.",
        "Bazı adımlar tamamlanmadı: {list}. Fairbeam yine de açılıyor; ayrıntılar shell.log dosyasında.",
    ),
    ("menu-remove", "Remove antenlab…", "antenlab'ı kaldır…"),
    ("summary-settings", "settings", "ayarlar"),
    ("summary-moved", "workspace moved to {path}", "çalışma klasörü {path} konumuna taşındı"),
    ("summary-kept", "workspace kept at {path}", "çalışma klasörü {path} konumunda kaldı"),
    ("summary-python", "{n} Python files updated", "{n} Python dosyası güncellendi"),
    ("step-preflight", "preparation", "hazırlık"),
    ("step-settings", "settings", "ayarlar"),
    ("step-workspace", "workspace", "çalışma klasörü"),
    ("step-python", "Python models", "Python modelleri"),
];

/// "tr" for Turkish, anything else is English.
pub fn lang(language: Option<&str>) -> &'static str {
    match language {
        Some("tr") => "tr",
        _ => "en",
    }
}

pub fn text(lang: &str, key: &str) -> String {
    TEXTS
        .iter()
        .find(|(k, _, _)| *k == key)
        .map(|(_, en, tr)| if lang == "tr" { *tr } else { *en })
        .unwrap_or(key)
        .to_string()
}

/// `text` with `{name}` placeholders filled in.
pub fn fill(lang: &str, key: &str, args: &[(&str, &str)]) -> String {
    let mut s = text(lang, key);
    for (name, value) in args {
        s = s.replace(&format!("{{{name}}}"), value);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_text_exists_in_both_languages() {
        for (key, en, tr) in TEXTS {
            assert!(!en.is_empty() && !tr.is_empty(), "{key}");
            assert_ne!(en, tr, "{key}");
            // the same placeholders in both languages
            let holes = |s: &str| {
                let mut v: Vec<String> = s.split('{').skip(1).filter_map(|p| p.split('}').next()).map(String::from).collect();
                v.sort();
                v
            };
            assert_eq!(holes(en), holes(tr), "{key}");
        }
        let mut keys: Vec<&str> = TEXTS.iter().map(|(k, _, _)| *k).collect();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), TEXTS.len(), "duplicate keys");
    }

    #[test]
    fn fills_and_falls_back() {
        assert_eq!(fill("en", "summary-python", &[("n", "3")]), "3 Python files updated");
        assert_eq!(fill("tr", "summary-python", &[("n", "3")]), "3 Python dosyası güncellendi");
        assert_eq!(text("de", "import-yes"), "Import");
        assert_eq!(text("en", "no-such-key"), "no-such-key");
        assert_eq!(lang(Some("tr")), "tr");
        assert_eq!(lang(Some("de")), "en");
        assert_eq!(lang(None), "en");
        // Turkish suffixes: back vowels after antenlab, front vowels after Fairbeam
        assert!(text("tr", "menu-remove").starts_with("antenlab'ı"));
        assert!(text("tr", "import-title").starts_with("antenlab'dan"));
    }
}
