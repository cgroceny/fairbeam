// The provider contract (docs/ACCOUNTS.md "Architecture"): identities, tokens, errors, and the HTTP
// and time layers the flows run on, so they are testable without the network.

use std::fmt;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize, Serializer};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Github,
    Google,
}

impl ProviderId {
    pub const ALL: [ProviderId; 2] = [ProviderId::Github, ProviderId::Google];

    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::Github => "github",
            ProviderId::Google => "google",
        }
    }

    pub fn parse(s: &str) -> Option<ProviderId> {
        ProviderId::ALL.into_iter().find(|p| p.as_str() == s)
    }
}

/// Who signed in: the non-secret part, cached in settings.json.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    pub provider: ProviderId,
    /// the provider's stable id (GitHub user id, Google `sub`)
    pub id: String,
    /// GitHub login; none for Google
    #[serde(default)]
    pub login: Option<String>,
    pub name: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    /// only when the user granted it (and, for Google, it is verified)
    #[serde(default)]
    pub email: Option<String>,
    /// unix seconds
    #[serde(default)]
    pub signed_in_at: u64,
}

/// The secret part, kept in the OS credential store only. Debug never shows a token.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// unix seconds; none: does not expire (GitHub OAuth apps)
    #[serde(default)]
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub scope: Option<String>,
}

impl fmt::Debug for Tokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Tokens")
            .field("access_token", &"<redacted>")
            .field("refresh_token", &self.refresh_token.as_ref().map(|_| "<redacted>"))
            .field("expires_at", &self.expires_at)
            .field("scope", &self.scope)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum AuthError {
    /// the accounts switch is off
    Disabled,
    /// no client id compiled in
    NotConfigured(ProviderId),
    NoPendingSignIn,
    Cancelled,
    /// the device code or the browser wait ran out
    Expired,
    /// the user said no
    Denied,
    /// the loopback callback's state did not match
    State,
    /// the grant is gone (revoked, or the refresh token expired)
    Revoked,
    /// an OAuth error code from the provider (never a response body)
    Provider { code: String, description: Option<String> },
    Network(String),
    Invalid(String),
    Store(String),
}

impl AuthError {
    pub fn code(&self) -> &'static str {
        match self {
            AuthError::Disabled => "disabled",
            AuthError::NotConfigured(_) => "not_configured",
            AuthError::NoPendingSignIn => "no_pending_sign_in",
            AuthError::Cancelled => "cancelled",
            AuthError::Expired => "expired",
            AuthError::Denied => "denied",
            AuthError::State => "state_mismatch",
            AuthError::Revoked => "revoked",
            AuthError::Provider { .. } => "provider",
            AuthError::Network(_) => "network",
            AuthError::Invalid(_) => "invalid",
            AuthError::Store(_) => "store",
        }
    }
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthError::Disabled => write!(f, "Signing in is not available in this build"),
            AuthError::NotConfigured(p) => write!(f, "Signing in with {} is not configured in this build", p.as_str()),
            AuthError::NoPendingSignIn => write!(f, "No sign-in is in progress"),
            AuthError::Cancelled => write!(f, "Sign-in was cancelled"),
            AuthError::Expired => write!(f, "The sign-in request expired. Please try again"),
            AuthError::Denied => write!(f, "Sign-in was declined"),
            AuthError::State => write!(f, "The browser's answer did not match this sign-in request"),
            AuthError::Revoked => write!(f, "The sign-in is no longer valid. Please sign in again"),
            AuthError::Provider { code, description } => match description {
                Some(d) => write!(f, "The provider refused the sign-in: {code} ({d})"),
                None => write!(f, "The provider refused the sign-in: {code}"),
            },
            AuthError::Network(e) => write!(f, "Could not reach the sign-in service: {e}"),
            AuthError::Invalid(e) => write!(f, "Unexpected answer from the sign-in service: {e}"),
            AuthError::Store(e) => write!(f, "Could not use the system credential store: {e}"),
        }
    }
}

/// Sent to the viewer as `{ code, message }`.
impl Serialize for AuthError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AuthError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

/// One HTTP request. Debug shows the method, URL and header names only: bodies and Authorization
/// carry secrets.
#[derive(Clone)]
pub struct Request {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Option<String>,
}

impl Request {
    pub fn get(url: &str) -> Request {
        Request { method: Method::Get, url: url.into(), headers: Vec::new(), body: None }
    }

    /// POST with an `application/x-www-form-urlencoded` body; asks for JSON back.
    pub fn post_form(url: &str, form: &[(&str, &str)]) -> Request {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(form.iter())
            .finish();
        Request {
            method: Method::Post,
            url: url.into(),
            headers: vec![
                ("Content-Type", "application/x-www-form-urlencoded".into()),
                ("Accept", "application/json".into()),
            ],
            body: Some(body),
        }
    }

    pub fn header(mut self, name: &'static str, value: impl Into<String>) -> Request {
        self.headers.retain(|(n, _)| !n.eq_ignore_ascii_case(name));
        self.headers.push((name, value.into()));
        self
    }

    pub fn bearer(self, token: &str) -> Request {
        self.header("Authorization", format!("Bearer {token}"))
    }

    /// A form field of the body (tests).
    #[cfg(test)]
    pub fn form_value(&self, key: &str) -> Option<String> {
        let body = self.body.as_deref()?;
        url::form_urlencoded::parse(body.as_bytes())
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
    }
}

impl fmt::Debug for Request {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let names: Vec<&str> = self.headers.iter().map(|(n, _)| *n).collect();
        f.debug_struct("Request")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("headers", &names)
            .field("body", &self.body.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

pub struct Response {
    pub status: u16,
    pub body: String,
}

impl Response {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// The network. The real one is reqwest (plugin.rs); tests script it.
pub trait Http: Send + Sync {
    fn send(&self, req: Request) -> impl Future<Output = Result<Response, AuthError>> + Send;
}

/// Wall time and waiting. The real one is tokio's timer; tests advance a counter.
pub trait Clock: Send + Sync {
    /// unix seconds
    fn now(&self) -> u64;
    fn sleep(&self, d: Duration) -> impl Future<Output = ()> + Send;
}

/// Opens a URL in the system browser (only URLs built or checked by the shell).
pub trait Opener: Send + Sync {
    fn open(&self, url: &str) -> Result<(), AuthError>;
}

/// Cancels a sign-in in progress (the dialog's Cancel, closing it).
#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// What the viewer shows while a sign-in runs.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Prompt {
    /// GitHub: type this code at the verification page
    Device { user_code: String, verification_uri: String, expires_in: u64 },
    /// Google: finish in the browser that just opened
    Browser,
}

/// One sign-in provider. A new provider implements this and gets a `ProviderId`.
pub trait AuthProvider: Send + Sync {
    /// State between `start` and `complete` (device code, loopback listener and PKCE verifier).
    type Pending: Send + 'static;

    fn id(&self) -> ProviderId;

    /// A client id is compiled in.
    fn configured(&self) -> bool;

    /// Begins a sign-in: what to show the user, and the state to complete it with.
    fn start<H: Http, C: Clock>(
        &self,
        http: &H,
        clock: &C,
    ) -> impl Future<Output = Result<(Self::Pending, Prompt), AuthError>> + Send;

    /// A URL to open in the browser right away (Google), or none (GitHub: the user opens it).
    fn browser_url(pending: &Self::Pending) -> Option<String>;

    /// Waits for the user to finish, then returns the tokens and who signed in.
    fn complete<H: Http, C: Clock>(
        &self,
        http: &H,
        clock: &C,
        pending: Self::Pending,
        cancel: &Cancel,
    ) -> impl Future<Output = Result<(Tokens, Profile), AuthError>> + Send;

    /// Silent refresh: renews the tokens where the provider can and re-reads the identity.
    /// `AuthError::Revoked` means the grant is gone.
    fn refresh<H: Http, C: Clock>(
        &self,
        http: &H,
        clock: &C,
        tokens: &Tokens,
    ) -> impl Future<Output = Result<(Tokens, Profile), AuthError>> + Send;

    /// Best-effort revocation at sign-out.
    fn revoke<H: Http>(&self, http: &H, tokens: &Tokens) -> impl Future<Output = ()> + Send;
}

/// The OAuth error object both providers use: `{"error": "...", "error_description": "..."}`.
#[derive(Deserialize)]
pub struct OAuthError {
    pub error: String,
    #[serde(default)]
    pub error_description: Option<String>,
}

pub fn provider_error(resp: &Response) -> AuthError {
    match serde_json::from_str::<OAuthError>(&resp.body) {
        Ok(e) => AuthError::Provider { code: e.error, description: e.error_description },
        Err(_) => AuthError::Invalid(format!("HTTP {}", resp.status)),
    }
}

#[cfg(test)]
pub mod fakes {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicU64;
    use std::sync::Mutex;

    /// Scripted HTTP: each request takes the next answer, whose URL must match.
    #[derive(Default)]
    pub struct ScriptedHttp {
        answers: Mutex<VecDeque<(String, u16, String)>>,
        pub requests: Mutex<Vec<Request>>,
    }

    impl ScriptedHttp {
        pub fn new() -> ScriptedHttp {
            ScriptedHttp::default()
        }
        pub fn answer(self, url: &str, status: u16, body: &str) -> ScriptedHttp {
            self.answers.lock().unwrap().push_back((url.into(), status, body.into()));
            self
        }
        pub fn count(&self) -> usize {
            self.requests.lock().unwrap().len()
        }
        pub fn request(&self, i: usize) -> Request {
            self.requests.lock().unwrap()[i].clone()
        }
    }

    impl Http for ScriptedHttp {
        async fn send(&self, req: Request) -> Result<Response, AuthError> {
            let (url, status, body) = self
                .answers
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| panic!("unexpected request {req:?}"));
            assert_eq!(req.url, url, "request order");
            self.requests.lock().unwrap().push(req);
            Ok(Response { status, body })
        }
    }

    /// Fails the test on any request: the switch-off and offline paths.
    pub struct NoNetwork;

    impl Http for NoNetwork {
        async fn send(&self, req: Request) -> Result<Response, AuthError> {
            panic!("no request may be made here, got {req:?}")
        }
    }

    /// Virtual time: sleeping advances it at once.
    pub struct FakeClock {
        pub ms: AtomicU64,
        pub sleeps: Mutex<Vec<Duration>>,
    }

    impl FakeClock {
        pub fn at(unix: u64) -> FakeClock {
            FakeClock { ms: AtomicU64::new(unix * 1000), sleeps: Mutex::new(Vec::new()) }
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> u64 {
            self.ms.load(Ordering::SeqCst) / 1000
        }
        async fn sleep(&self, d: Duration) {
            self.sleeps.lock().unwrap().push(d);
            self.ms.fetch_add(d.as_millis() as u64, Ordering::SeqCst);
        }
    }

    /// Real time with a thread sleep (loopback tests, which wait for a real socket).
    pub struct ThreadClock;

    impl Clock for ThreadClock {
        fn now(&self) -> u64 {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        }
        async fn sleep(&self, d: Duration) {
            std::thread::sleep(d)
        }
    }

    #[derive(Default)]
    pub struct RecordingOpener(pub Mutex<Vec<String>>);

    impl Opener for RecordingOpener {
        fn open(&self, url: &str) -> Result<(), AuthError> {
            self.0.lock().unwrap().push(url.into());
            Ok(())
        }
    }

    pub fn block_on<F: Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_output_never_shows_tokens() {
        let t = Tokens {
            access_token: "gho_secret123".into(),
            refresh_token: Some("1//refresh-secret".into()),
            expires_at: Some(10),
            scope: None,
        };
        let shown = format!("{t:?}");
        assert!(!shown.contains("secret"), "{shown}");
        let req = Request::post_form("https://example.test/token", &[("code", "the-secret-code")])
            .bearer("gho_secret123");
        let shown = format!("{req:?}");
        assert!(!shown.contains("secret"), "{shown}");
        assert!(shown.contains("Authorization"));
    }

    #[test]
    fn form_bodies_are_url_encoded() {
        let req = Request::post_form("https://x.test/", &[("scope", "read:user user:email"), ("a", "b&c")]);
        assert_eq!(req.body.as_deref(), Some("scope=read%3Auser+user%3Aemail&a=b%26c"));
        assert_eq!(req.form_value("a").as_deref(), Some("b&c"));
    }

    #[test]
    fn errors_reach_the_viewer_as_code_and_message() {
        let v = serde_json::to_value(AuthError::Denied).unwrap();
        assert_eq!(v["code"], "denied");
        assert_eq!(v["message"], "Sign-in was declined");
        assert_eq!(ProviderId::parse("google"), Some(ProviderId::Google));
        assert_eq!(ProviderId::parse("gitlab"), None);
    }
}
