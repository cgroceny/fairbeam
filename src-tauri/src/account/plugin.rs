// The inlined Tauri plugin `account` (feature `accounts` only): the real HTTP, clock, keychain,
// settings cache and browser behind the service. The viewer calls `plugin:account|<command>`;
// build.rs declares the commands (switch.rs) and the setup adds capability.json.

use std::process::Command;
use std::time::Duration;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, State, Wry};

use super::provider::{AuthError, Clock, Http, Method, Opener, Profile, Prompt, ProviderId, Request, Response};
use super::service::{Config, ProfileCache, Service, Status};
use super::store::KeyringStore;
use crate::paths::{load_settings, save_settings};

type AppService = Service<ReqwestHttp, TokioClock, KeyringStore, SettingsCache, SystemOpener>;

pub struct ReqwestHttp(reqwest::Client);

impl ReqwestHttp {
    fn new() -> Result<ReqwestHttp, reqwest::Error> {
        // the same TLS setup as the updater plugin (rustls with ring)
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        reqwest::Client::builder()
            .user_agent(concat!("fairbeam/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(20))
            .https_only(true)
            .build()
            .map(ReqwestHttp)
    }
}

impl Http for ReqwestHttp {
    async fn send(&self, req: Request) -> Result<Response, AuthError> {
        let mut b = match req.method {
            Method::Get => self.0.get(&req.url),
            Method::Post => self.0.post(&req.url),
        };
        for (name, value) in &req.headers {
            b = b.header(*name, value);
        }
        if let Some(body) = req.body {
            b = b.body(body);
        }
        let net = |e: reqwest::Error| AuthError::Network(e.without_url().to_string());
        let resp = b.send().await.map_err(net)?;
        let status = resp.status().as_u16();
        let body = resp.text().await.map_err(net)?;
        Ok(Response { status, body })
    }
}

pub struct TokioClock;

impl Clock for TokioClock {
    fn now(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
    async fn sleep(&self, d: Duration) {
        tokio::time::sleep(d).await
    }
}

/// settings.json `account` (paths::Settings): the non-secret profile.
pub struct SettingsCache(AppHandle);

impl ProfileCache for SettingsCache {
    fn load(&self) -> Option<Profile> {
        load_settings(&self.0).account.and_then(|v| serde_json::from_value(v).ok())
    }
    fn save(&self, profile: Option<&Profile>) -> Result<(), AuthError> {
        let mut s = load_settings(&self.0);
        s.account = profile.and_then(|p| serde_json::to_value(p).ok());
        save_settings(&self.0, &s).map_err(AuthError::Store)
    }
}

/// The system browser, https only (the shell built or checked every URL it gets).
pub struct SystemOpener;

impl Opener for SystemOpener {
    fn open(&self, url: &str) -> Result<(), AuthError> {
        if !url.starts_with("https://") {
            return Err(AuthError::Invalid("only https pages are opened".into()));
        }
        #[cfg(target_os = "windows")]
        let child = Command::new("explorer.exe").arg(url).spawn();
        #[cfg(target_os = "macos")]
        let child = Command::new("open").arg(url).spawn();
        #[cfg(all(unix, not(target_os = "macos")))]
        let child = Command::new("xdg-open").arg(url).spawn();
        child.map(|_| ()).map_err(|e| AuthError::Invalid(format!("could not open the browser: {e}")))
    }
}

fn provider(id: &str) -> Result<ProviderId, AuthError> {
    ProviderId::parse(id).ok_or_else(|| AuthError::Invalid(format!("unknown provider {id:?}")))
}

#[tauri::command]
fn status(state: State<'_, AppService>) -> Status {
    state.status()
}

#[tauri::command]
async fn sign_in_start(state: State<'_, AppService>, provider_id: String) -> Result<Prompt, AuthError> {
    state.sign_in_start(provider(&provider_id)?).await
}

#[tauri::command]
async fn sign_in_wait(state: State<'_, AppService>) -> Result<Profile, AuthError> {
    state.sign_in_wait().await
}

#[tauri::command]
fn sign_in_cancel(state: State<'_, AppService>) -> Result<(), AuthError> {
    state.sign_in_cancel()
}

#[tauri::command]
fn open_verification(state: State<'_, AppService>) -> Result<(), AuthError> {
    state.open_verification()
}

#[tauri::command]
async fn refresh(state: State<'_, AppService>) -> Result<Option<Profile>, AuthError> {
    state.refresh().await
}

#[tauri::command]
async fn sign_out(state: State<'_, AppService>) -> Result<(), AuthError> {
    state.sign_out().await
}

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new("account")
        .invoke_handler(tauri::generate_handler![
            status,
            sign_in_start,
            sign_in_wait,
            sign_in_cancel,
            open_verification,
            refresh,
            sign_out
        ])
        .setup(|app, _api| {
            let service: AppService = Service::new(
                super::ENABLED,
                Config::from_build(),
                ReqwestHttp::new()?,
                TokioClock,
                KeyringStore,
                SettingsCache(app.clone()),
                SystemOpener,
            );
            app.manage(service);
            app.add_capability(include_str!("capability.json"))?;
            Ok(())
        })
        .build()
}
