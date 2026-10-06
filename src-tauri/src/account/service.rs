// The account service behind the plugin commands: the switch guard, the sign-in in progress,
// remembering who signed in, silent refresh and sign-out (docs/ACCOUNTS.md).

use std::sync::Mutex;

use serde::Serialize;

use super::github::{self, GitHub};
use super::google::{self, Google};
use super::provider::{AuthError, AuthProvider, Cancel, Clock, Http, Opener, Profile, Prompt, ProviderId, Tokens};
use super::store::{delete_tokens, load_tokens, save_tokens, SecretStore};

/// The non-secret profile cache (settings.json `account` in the app).
pub trait ProfileCache: Send + Sync {
    fn load(&self) -> Option<Profile>;
    fn save(&self, profile: Option<&Profile>) -> Result<(), AuthError>;
}

/// Client ids compiled in; unset (the placeholders) means "not configured".
#[derive(Clone, Default)]
pub struct Config {
    pub github_client_id: Option<String>,
    pub google_client_id: Option<String>,
    pub google_client_secret: Option<String>,
}

impl Config {
    /// From `FAIRBEAM_GITHUB_CLIENT_ID`, `FAIRBEAM_GOOGLE_CLIENT_ID` and
    /// `FAIRBEAM_GOOGLE_CLIENT_SECRET` at build time. No OAuth app is registered yet: all unset.
    pub fn from_build() -> Config {
        let v = |s: Option<&str>| s.map(str::to_string).filter(|s| !s.trim().is_empty());
        Config {
            github_client_id: v(option_env!("FAIRBEAM_GITHUB_CLIENT_ID")),
            google_client_id: v(option_env!("FAIRBEAM_GOOGLE_CLIENT_ID")),
            google_client_secret: v(option_env!("FAIRBEAM_GOOGLE_CLIENT_SECRET")),
        }
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ProviderStatus {
    pub id: ProviderId,
    pub configured: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Status {
    pub enabled: bool,
    pub providers: Vec<ProviderStatus>,
    /// who signed in; none: guest
    pub profile: Option<Profile>,
}

enum Pending {
    Github(github::Pending),
    Google(google::Pending),
}

pub struct Service<H, C, S, P, O> {
    enabled: bool,
    http: H,
    clock: C,
    store: S,
    cache: P,
    opener: O,
    github: GitHub,
    google: Google,
    pending: Mutex<Option<Pending>>,
    /// the GitHub verification page of the sign-in in progress (checked to be on github.com)
    verification: Mutex<Option<String>>,
    cancel: Mutex<Cancel>,
}

impl<H: Http, C: Clock, S: SecretStore, P: ProfileCache, O: Opener> Service<H, C, S, P, O> {
    pub fn new(enabled: bool, config: Config, http: H, clock: C, store: S, cache: P, opener: O) -> Self {
        Service {
            enabled,
            http,
            clock,
            store,
            cache,
            opener,
            github: GitHub::new(config.github_client_id),
            google: Google::new(config.google_client_id, config.google_client_secret),
            pending: Mutex::new(None),
            verification: Mutex::new(None),
            cancel: Mutex::new(Cancel::default()),
        }
    }

    /// Everything below starts here: with the switch off nothing else runs (no store, no network).
    fn guard(&self) -> Result<(), AuthError> {
        if self.enabled {
            Ok(())
        } else {
            Err(AuthError::Disabled)
        }
    }

    /// Who is signed in, from the cache: no network, no keychain.
    pub fn status(&self) -> Status {
        if !self.enabled {
            return Status { enabled: false, providers: Vec::new(), profile: None };
        }
        Status {
            enabled: true,
            providers: vec![
                ProviderStatus { id: ProviderId::Github, configured: self.github.configured() },
                ProviderStatus { id: ProviderId::Google, configured: self.google.configured() },
            ],
            profile: self.cache.load(),
        }
    }

    pub async fn sign_in_start(&self, provider: ProviderId) -> Result<Prompt, AuthError> {
        self.guard()?;
        // a new sign-in replaces one in progress (its wait sees the old flag cancelled)
        {
            let mut c = self.cancel.lock().unwrap();
            c.cancel();
            *c = Cancel::default();
        }
        *self.pending.lock().unwrap() = None;
        *self.verification.lock().unwrap() = None;
        let (pending, prompt, open) = match provider {
            ProviderId::Github => {
                let (p, prompt) = self.github.start(&self.http, &self.clock).await?;
                *self.verification.lock().unwrap() = Some(p.verification_uri.clone());
                (Pending::Github(p), prompt, None)
            }
            ProviderId::Google => {
                let (p, prompt) = self.google.start(&self.http, &self.clock).await?;
                let url = Google::browser_url(&p);
                (Pending::Google(p), prompt, url)
            }
        };
        *self.pending.lock().unwrap() = Some(pending);
        if let Some(url) = open {
            self.opener.open(&url)?;
        }
        Ok(prompt)
    }

    /// Opens the GitHub verification page of the sign-in in progress (the viewer copies the code).
    pub fn open_verification(&self) -> Result<(), AuthError> {
        self.guard()?;
        let url = self.verification.lock().unwrap().clone().ok_or(AuthError::NoPendingSignIn)?;
        if !url.starts_with(github::VERIFICATION_PREFIX) {
            return Err(AuthError::Invalid("verification page".into()));
        }
        self.opener.open(&url)
    }

    /// Waits for the sign-in started last, then remembers who signed in.
    pub async fn sign_in_wait(&self) -> Result<Profile, AuthError> {
        self.guard()?;
        let pending = self.pending.lock().unwrap().take().ok_or(AuthError::NoPendingSignIn)?;
        let cancel = self.cancel.lock().unwrap().clone();
        let result = match pending {
            Pending::Github(p) => self.github.complete(&self.http, &self.clock, p, &cancel).await.map(|r| (self.github.id(), r)),
            Pending::Google(p) => self.google.complete(&self.http, &self.clock, p, &cancel).await.map(|r| (self.google.id(), r)),
        };
        *self.verification.lock().unwrap() = None;
        let (provider, (tokens, profile)) = result?;
        if cancel.is_cancelled() {
            return Err(AuthError::Cancelled);
        }
        self.remember(provider, &tokens, &profile)?;
        Ok(profile)
    }

    pub fn sign_in_cancel(&self) -> Result<(), AuthError> {
        self.guard()?;
        self.cancel.lock().unwrap().cancel();
        *self.pending.lock().unwrap() = None;
        *self.verification.lock().unwrap() = None;
        Ok(())
    }

    fn remember(&self, provider: ProviderId, tokens: &Tokens, profile: &Profile) -> Result<(), AuthError> {
        // one identity at a time: another provider's tokens go
        for other in ProviderId::ALL.into_iter().filter(|p| *p != provider) {
            delete_tokens(&self.store, other)?;
        }
        save_tokens(&self.store, provider, tokens)?;
        self.cache.save(Some(profile))
    }

    /// Silent refresh: renews tokens where the provider can and updates the cached name and
    /// avatar. Ok(None): signed out (a guest, a missing keychain entry, or a revoked grant).
    pub async fn refresh(&self) -> Result<Option<Profile>, AuthError> {
        self.guard()?;
        let Some(cached) = self.cache.load() else { return Ok(None) };
        let Some(tokens) = load_tokens(&self.store, cached.provider)? else {
            self.cache.save(None)?;
            return Ok(None);
        };
        let result = match cached.provider {
            ProviderId::Github => self.github.refresh(&self.http, &self.clock, &tokens).await,
            ProviderId::Google => self.google.refresh(&self.http, &self.clock, &tokens).await,
        };
        match result {
            Ok((tokens, mut profile)) => {
                profile.signed_in_at = cached.signed_in_at;
                save_tokens(&self.store, cached.provider, &tokens)?;
                self.cache.save(Some(&profile))?;
                Ok(Some(profile))
            }
            Err(AuthError::Revoked) => {
                delete_tokens(&self.store, cached.provider)?;
                self.cache.save(None)?;
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }

    /// Deletes the keychain entries and the cached profile; revokes the Google grant (best effort).
    pub async fn sign_out(&self) -> Result<(), AuthError> {
        self.guard()?;
        for provider in ProviderId::ALL {
            if provider == ProviderId::Google {
                if let Ok(Some(t)) = load_tokens(&self.store, provider) {
                    self.google.revoke(&self.http, &t).await;
                }
            }
            delete_tokens(&self.store, provider)?;
        }
        self.cache.save(None)
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct MemoryCache(pub Mutex<Option<Profile>>);

#[cfg(test)]
impl ProfileCache for MemoryCache {
    fn load(&self) -> Option<Profile> {
        self.0.lock().unwrap().clone()
    }
    fn save(&self, profile: Option<&Profile>) -> Result<(), AuthError> {
        *self.0.lock().unwrap() = profile.cloned();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::provider::fakes::{block_on, FakeClock, NoNetwork, RecordingOpener, ScriptedHttp};
    use crate::account::store::MemoryStore;
    use crate::account::github::{DEVICE_CODE_URL, TOKEN_URL, USER_URL};

    fn config() -> Config {
        Config { github_client_id: Some("Iv1.test".into()), google_client_id: None, google_client_secret: None }
    }

    fn profile(p: ProviderId) -> Profile {
        Profile { provider: p, id: "1".into(), login: None, name: "N".into(), avatar_url: None, email: None, signed_in_at: 7 }
    }

    #[test]
    fn switch_off_means_no_store_no_network_no_browser() {
        let s = Service::new(false, config(), NoNetwork, FakeClock::at(0), MemoryStore::default(), MemoryCache::default(), RecordingOpener::default());
        assert_eq!(s.status(), Status { enabled: false, providers: vec![], profile: None });
        assert_eq!(block_on(s.sign_in_start(ProviderId::Github)).err(), Some(AuthError::Disabled));
        assert_eq!(block_on(s.sign_in_start(ProviderId::Google)).err(), Some(AuthError::Disabled));
        assert_eq!(block_on(s.sign_in_wait()).err(), Some(AuthError::Disabled));
        assert_eq!(block_on(s.refresh()).err(), Some(AuthError::Disabled));
        assert_eq!(block_on(s.sign_out()).err(), Some(AuthError::Disabled));
        assert_eq!(s.open_verification().err(), Some(AuthError::Disabled));
        assert_eq!(s.sign_in_cancel().err(), Some(AuthError::Disabled));
        assert_eq!(*s.store.calls.lock().unwrap(), 0);
        assert!(s.opener.0.lock().unwrap().is_empty());
        // NoNetwork panics on any request: reaching here means none was made
    }

    #[test]
    fn switch_off_exposes_no_commands() {
        use crate::account::switch::{exposed_commands, COMMANDS};
        assert!(exposed_commands(false).is_empty());
        assert_eq!(exposed_commands(true), COMMANDS);
        assert_eq!(crate::account::ENABLED, cfg!(feature = "accounts"));
        // the static capability files never grant an account permission: only the plugin adds one
        for file in ["capabilities/default.json", "capabilities/viewer.json"] {
            let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/").to_string() + file).unwrap();
            assert!(!text.contains("account"), "{file} names an account permission");
        }
        let cap: serde_json::Value = serde_json::from_str(include_str!("capability.json")).unwrap();
        assert_eq!(cap["permissions"], serde_json::json!(["account:default"]));
    }

    #[test]
    fn status_is_offline_and_reports_unconfigured_providers() {
        let cache = MemoryCache::default();
        cache.save(Some(&profile(ProviderId::Github))).unwrap();
        let s = Service::new(true, config(), NoNetwork, FakeClock::at(0), MemoryStore::default(), cache, RecordingOpener::default());
        let st = s.status();
        assert!(st.enabled);
        assert_eq!(st.providers, vec![
            ProviderStatus { id: ProviderId::Github, configured: true },
            ProviderStatus { id: ProviderId::Google, configured: false },
        ]);
        assert_eq!(st.profile.unwrap().name, "N");
        assert_eq!(block_on(s.sign_in_start(ProviderId::Google)).err(), Some(AuthError::NotConfigured(ProviderId::Google)));
        assert_eq!(*s.store.calls.lock().unwrap(), 0);
    }

    #[test]
    fn github_sign_in_is_remembered_and_sign_out_forgets_it() {
        let http = ScriptedHttp::new()
            .answer(DEVICE_CODE_URL, 200, r#"{"device_code":"d","user_code":"AB-CD","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#)
            .answer(TOKEN_URL, 200, r#"{"access_token":"gho_t","scope":""}"#)
            .answer(USER_URL, 200, r#"{"id":9,"login":"ada","name":"Ada","avatar_url":null}"#);
        let s = Service::new(true, config(), http, FakeClock::at(100), MemoryStore::default(), MemoryCache::default(), RecordingOpener::default());
        s.store.set("oauth-google", r#"{"access_token":"old"}"#).unwrap();
        assert!(matches!(block_on(s.sign_in_start(ProviderId::Github)).unwrap(), Prompt::Device { .. }));
        s.open_verification().unwrap();
        assert_eq!(*s.opener.0.lock().unwrap(), vec!["https://github.com/login/device".to_string()]);
        let p = block_on(s.sign_in_wait()).unwrap();
        assert_eq!(p.login.as_deref(), Some("ada"));
        assert_eq!(s.status().profile, Some(p));
        assert_eq!(load_tokens(&s.store, ProviderId::Github).unwrap().unwrap().access_token, "gho_t");
        assert_eq!(load_tokens(&s.store, ProviderId::Google).unwrap(), None);
        assert_eq!(s.open_verification().err(), Some(AuthError::NoPendingSignIn));
        block_on(s.sign_out()).unwrap();
        assert_eq!(s.status().profile, None);
        assert_eq!(load_tokens(&s.store, ProviderId::Github).unwrap(), None);
    }

    #[test]
    fn cancel_before_waiting_drops_the_sign_in() {
        let http = ScriptedHttp::new()
            .answer(DEVICE_CODE_URL, 200, r#"{"device_code":"d","user_code":"AB-CD","verification_uri":"https://github.com/login/device","expires_in":900}"#);
        let s = Service::new(true, config(), http, FakeClock::at(0), MemoryStore::default(), MemoryCache::default(), RecordingOpener::default());
        block_on(s.sign_in_start(ProviderId::Github)).unwrap();
        s.sign_in_cancel().unwrap();
        assert_eq!(block_on(s.sign_in_wait()).err(), Some(AuthError::NoPendingSignIn));
        assert_eq!(s.status().profile, None);
    }

    #[test]
    fn refresh_updates_the_cache_or_signs_out_when_revoked() {
        let cache = MemoryCache::default();
        cache.save(Some(&profile(ProviderId::Github))).unwrap();
        let http = ScriptedHttp::new()
            .answer(USER_URL, 200, r#"{"id":1,"login":"ada","name":"Ada Renamed","avatar_url":"https://avatars.githubusercontent.com/u/1"}"#)
            .answer(USER_URL, 401, "{}");
        let s = Service::new(true, config(), http, FakeClock::at(500), MemoryStore::default(), cache, RecordingOpener::default());
        let t = Tokens { access_token: "gho_t".into(), refresh_token: None, expires_at: None, scope: None };
        save_tokens(&s.store, ProviderId::Github, &t).unwrap();
        let p = block_on(s.refresh()).unwrap().unwrap();
        assert_eq!((p.name.as_str(), p.signed_in_at), ("Ada Renamed", 7));
        assert_eq!(block_on(s.refresh()).unwrap(), None);
        assert_eq!(s.status().profile, None);
        assert_eq!(load_tokens(&s.store, ProviderId::Github).unwrap(), None);
        // a guest refreshes nothing
        assert_eq!(block_on(s.refresh()).unwrap(), None);
    }

    #[test]
    fn a_cached_profile_without_tokens_is_cleared_without_network() {
        let cache = MemoryCache::default();
        cache.save(Some(&profile(ProviderId::Google))).unwrap();
        let s = Service::new(true, config(), NoNetwork, FakeClock::at(0), MemoryStore::default(), cache, RecordingOpener::default());
        assert_eq!(block_on(s.refresh()).unwrap(), None);
        assert_eq!(s.status().profile, None);
    }
}
