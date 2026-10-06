// Google sign-in for installed apps: authorization code with PKCE and a loopback redirect
// (docs/ACCOUNTS.md "Google"). https://developers.google.com/identity/protocols/oauth2/native-app

use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::Deserialize;

use super::loopback::{Loopback, WAIT};
use super::pkce::{new_state, Pkce};
use super::provider::{
    provider_error, AuthError, AuthProvider, Cancel, Clock, Http, Profile, Prompt, ProviderId,
    Request, Tokens,
};

pub const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
pub const GOOGLE_SCOPE: &str = "openid email profile";
const ISSUERS: [&str; 2] = ["https://accounts.google.com", "accounts.google.com"];

pub struct Google {
    client_id: Option<String>,
    /// Google issues a "secret" with Desktop clients and wants it at the token endpoint; it is not
    /// confidential for installed apps (PKCE protects the code).
    client_secret: Option<String>,
}

pub struct Pending {
    loopback: Loopback,
    pkce: Pkce,
    state: String,
    redirect_uri: String,
    authorize_url: String,
}

#[derive(Deserialize)]
struct TokenAnswer {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
    aud: String,
    exp: u64,
    sub: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    email_verified: Option<bool>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    picture: Option<String>,
}

impl Google {
    pub fn new(client_id: Option<String>, client_secret: Option<String>) -> Google {
        let keep = |v: Option<String>| v.filter(|c| !c.trim().is_empty());
        Google { client_id: keep(client_id), client_secret: keep(client_secret) }
    }

    fn client_id(&self) -> Result<&str, AuthError> {
        self.client_id.as_deref().ok_or(AuthError::NotConfigured(ProviderId::Google))
    }

    fn with_secret<'a>(&'a self, mut form: Vec<(&'a str, &'a str)>) -> Vec<(&'a str, &'a str)> {
        if let Some(s) = &self.client_secret {
            form.push(("client_secret", s));
        }
        form
    }

    /// Exchanges the tokens answer for `Tokens` and the id_token's identity.
    fn tokens(&self, clock: &impl Clock, resp: &super::provider::Response, keep_refresh: Option<&str>) -> Result<(Tokens, Profile), AuthError> {
        if !resp.ok() {
            let err = provider_error(resp);
            // an expired or revoked refresh token
            if matches!(&err, AuthError::Provider { code, .. } if code == "invalid_grant") && keep_refresh.is_some() {
                return Err(AuthError::Revoked);
            }
            return Err(err);
        }
        let answer: TokenAnswer = serde_json::from_str(&resp.body).map_err(|_| AuthError::Invalid("token answer".into()))?;
        let id_token = answer.id_token.as_deref().ok_or_else(|| AuthError::Invalid("no id_token".into()))?;
        let profile = claims_profile(id_token, self.client_id()?, clock.now())?;
        let tokens = Tokens {
            access_token: answer.access_token,
            // a refresh answer does not repeat the refresh token
            refresh_token: answer.refresh_token.or(keep_refresh.map(str::to_string)),
            expires_at: answer.expires_in.map(|s| clock.now() + s),
            scope: answer.scope,
        };
        Ok((tokens, profile))
    }
}

pub fn authorize_url(client_id: &str, redirect_uri: &str, challenge: &str, state: &str) -> String {
    url::Url::parse_with_params(
        AUTH_URL,
        &[
            ("response_type", "code"),
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
            ("scope", GOOGLE_SCOPE),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
        ],
    )
    .expect("static base URL")
    .into()
}

/// The identity in an id_token received straight from Google's token endpoint over TLS: the
/// signature is not checked (OpenID Connect Core 3.1.3.7), the issuer, audience and expiry are.
pub fn claims_profile(id_token: &str, client_id: &str, now: u64) -> Result<Profile, AuthError> {
    let bad = |why: &str| AuthError::Invalid(format!("id_token: {why}"));
    let payload = id_token.split('.').nth(1).ok_or_else(|| bad("not a JWT"))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .or_else(|_| URL_SAFE.decode(payload))
        .map_err(|_| bad("payload is not base64url"))?;
    let c: Claims = serde_json::from_slice(&bytes).map_err(|_| bad("claims"))?;
    if !ISSUERS.contains(&c.iss.as_str()) {
        return Err(bad("issuer"));
    }
    if c.aud != client_id {
        return Err(bad("audience"));
    }
    // a minute of clock skew
    if c.exp + 60 < now {
        return Err(bad("expired"));
    }
    let email = c.email.filter(|_| c.email_verified == Some(true));
    let name = c
        .name
        .filter(|n| !n.trim().is_empty())
        .or_else(|| email.clone())
        .unwrap_or_else(|| "Google account".into());
    Ok(Profile {
        provider: ProviderId::Google,
        id: c.sub,
        login: None,
        name,
        avatar_url: c.picture,
        email,
        signed_in_at: now,
    })
}

impl AuthProvider for Google {
    type Pending = Pending;

    fn id(&self) -> ProviderId {
        ProviderId::Google
    }

    fn configured(&self) -> bool {
        self.client_id.is_some()
    }

    async fn start<H: Http, C: Clock>(&self, _: &H, _: &C) -> Result<(Pending, Prompt), AuthError> {
        let client_id = self.client_id()?;
        let loopback = Loopback::bind()?;
        let pkce = Pkce::new()?;
        let state = new_state()?;
        let redirect_uri = loopback.redirect_uri();
        let authorize_url = authorize_url(client_id, &redirect_uri, &pkce.challenge, &state);
        Ok((Pending { loopback, pkce, state, redirect_uri, authorize_url }, Prompt::Browser))
    }

    fn browser_url(pending: &Pending) -> Option<String> {
        Some(pending.authorize_url.clone())
    }

    async fn complete<H: Http, C: Clock>(
        &self,
        http: &H,
        clock: &C,
        pending: Pending,
        cancel: &Cancel,
    ) -> Result<(Tokens, Profile), AuthError> {
        let client_id = self.client_id()?;
        let code = pending.loopback.wait(clock, &pending.state, cancel, WAIT).await?;
        drop(pending.loopback);
        let form = self.with_secret(vec![
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("code_verifier", &pending.pkce.verifier),
            ("redirect_uri", &pending.redirect_uri),
            ("client_id", client_id),
        ]);
        let resp = http.send(Request::post_form(TOKEN_URL, &form)).await?;
        self.tokens(clock, &resp, None)
    }

    async fn refresh<H: Http, C: Clock>(&self, http: &H, clock: &C, tokens: &Tokens) -> Result<(Tokens, Profile), AuthError> {
        let client_id = self.client_id()?;
        let refresh = tokens.refresh_token.as_deref().ok_or(AuthError::Revoked)?;
        let form = self.with_secret(vec![
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh),
            ("client_id", client_id),
        ]);
        let resp = http.send(Request::post_form(TOKEN_URL, &form)).await?;
        self.tokens(clock, &resp, Some(refresh))
    }

    async fn revoke<H: Http>(&self, http: &H, tokens: &Tokens) {
        let token = tokens.refresh_token.as_deref().unwrap_or(&tokens.access_token);
        let _ = http.send(Request::post_form(REVOKE_URL, &[("token", token)])).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::pkce::{b64url, challenge_for};
    use crate::account::provider::fakes::{block_on, FakeClock, ScriptedHttp, ThreadClock};
    use std::io::{Read, Write};

    const CLIENT: &str = "123-abc.apps.googleusercontent.com";

    fn jwt(claims: serde_json::Value) -> String {
        format!("{}.{}.sig", b64url(br#"{"alg":"RS256"}"#), b64url(claims.to_string().as_bytes()))
    }

    fn claims(exp: u64) -> serde_json::Value {
        serde_json::json!({
            "iss": "https://accounts.google.com", "aud": CLIENT, "exp": exp, "sub": "1098",
            "email": "ada@x.test", "email_verified": true, "name": "Ada L", "picture": "https://lh3.googleusercontent.com/a/p"
        })
    }

    fn google() -> Google {
        Google::new(Some(CLIENT.into()), Some("GOCSPX-not-secret".into()))
    }

    #[test]
    fn authorize_url_carries_pkce_and_state() {
        let u = authorize_url(CLIENT, "http://127.0.0.1:5555/callback", "chal", "st8");
        let url = url::Url::parse(&u).unwrap();
        assert_eq!(url.host_str(), Some("accounts.google.com"));
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5555/callback");
        assert_eq!(q["code_challenge"], "chal");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["scope"], "openid email profile");
        assert_eq!(q["state"], "st8");
        assert_eq!(q["response_type"], "code");
        assert!(!q.contains_key("client_secret"));
    }

    #[test]
    fn id_token_claims_become_the_profile() {
        let p = claims_profile(&jwt(claims(2000)), CLIENT, 1000).unwrap();
        assert_eq!(p.id, "1098");
        assert_eq!(p.name, "Ada L");
        assert_eq!(p.email.as_deref(), Some("ada@x.test"));
        assert_eq!(p.avatar_url.as_deref(), Some("https://lh3.googleusercontent.com/a/p"));
        let mut unverified = claims(2000);
        unverified["email_verified"] = false.into();
        unverified["name"] = serde_json::Value::Null;
        let p = claims_profile(&jwt(unverified), CLIENT, 1000).unwrap();
        assert_eq!((p.email, p.name.as_str()), (None, "Google account"));
    }

    #[test]
    fn id_tokens_for_someone_else_or_expired_are_refused() {
        let mut other = claims(2000);
        other["aud"] = "other-app".into();
        assert!(claims_profile(&jwt(other), CLIENT, 1000).is_err());
        let mut iss = claims(2000);
        iss["iss"] = "https://evil.test".into();
        assert!(claims_profile(&jwt(iss), CLIENT, 1000).is_err());
        assert!(claims_profile(&jwt(claims(100)), CLIENT, 1000).is_err());
        assert!(claims_profile("garbage", CLIENT, 1000).is_err());
    }

    #[test]
    fn sign_in_through_the_loopback_then_exchange_with_the_verifier() {
        let g = google();
        let (pending, prompt) = block_on(g.start(&ScriptedHttp::new(), &ThreadClock)).unwrap();
        assert_eq!(prompt, Prompt::Browser);
        let url = url::Url::parse(&Google::browser_url(&pending).unwrap()).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        let (redirect, state, challenge) = (q["redirect_uri"].clone(), q["state"].clone(), q["code_challenge"].clone());
        let port: u16 = redirect.trim_start_matches("http://127.0.0.1:").trim_end_matches("/callback").parse().unwrap();
        let browser = std::thread::spawn(move || {
            let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(s, "GET /callback?code=4%2Fcode&state={state} HTTP/1.1\r\n\r\n").unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
        });
        let now = ThreadClock.now();
        let answer = serde_json::json!({
            "access_token": "ya29.x", "expires_in": 3599, "refresh_token": "1//r", "scope": "openid email profile",
            "id_token": jwt(claims(now + 3600))
        });
        let http = ScriptedHttp::new().answer(TOKEN_URL, 200, &answer.to_string());
        let (tokens, profile) = block_on(g.complete(&http, &ThreadClock, pending, &Cancel::default())).unwrap();
        browser.join().unwrap();
        assert_eq!(tokens.refresh_token.as_deref(), Some("1//r"));
        assert!(tokens.expires_at.unwrap() >= now + 3599);
        assert_eq!(profile.name, "Ada L");
        let req = http.request(0);
        assert_eq!(req.form_value("code").as_deref(), Some("4/code"));
        assert_eq!(req.form_value("redirect_uri"), Some(redirect));
        assert_eq!(req.form_value("client_secret").as_deref(), Some("GOCSPX-not-secret"));
        assert_eq!(challenge_for(&req.form_value("code_verifier").unwrap()), challenge);
    }

    #[test]
    fn refresh_keeps_the_refresh_token_and_detects_revocation() {
        let clock = FakeClock::at(1000);
        let old = Tokens { access_token: "ya29.old".into(), refresh_token: Some("1//r".into()), expires_at: Some(900), scope: None };
        let answer = serde_json::json!({ "access_token": "ya29.new", "expires_in": 3600, "id_token": jwt(claims(5000)) });
        let http = ScriptedHttp::new().answer(TOKEN_URL, 200, &answer.to_string());
        let (t, _) = block_on(google().refresh(&http, &clock, &old)).unwrap();
        assert_eq!((t.access_token.as_str(), t.refresh_token.as_deref(), t.expires_at), ("ya29.new", Some("1//r"), Some(4600)));
        assert_eq!(http.request(0).form_value("grant_type").as_deref(), Some("refresh_token"));

        let http = ScriptedHttp::new().answer(TOKEN_URL, 400, r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#);
        assert_eq!(block_on(google().refresh(&http, &clock, &old)).err(), Some(AuthError::Revoked));
    }
}
