// GitHub sign-in with the OAuth Device Flow (docs/ACCOUNTS.md "GitHub"): no client secret, no
// redirect. https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow

use std::time::Duration;

use serde::Deserialize;

use super::provider::{
    provider_error, AuthError, AuthProvider, Cancel, Clock, Http, Profile, Prompt, ProviderId,
    Request, Tokens,
};

pub const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
pub const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
pub const USER_URL: &str = "https://api.github.com/user";
pub const EMAILS_URL: &str = "https://api.github.com/user/emails";
/// The only place the shell opens for GitHub: the verification page must be on github.com.
pub const VERIFICATION_PREFIX: &str = "https://github.com/";
/// Public profile plus the email. An empty scope is enough for login, name and avatar.
pub const GITHUB_SCOPE: &str = "read:user user:email";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

pub struct GitHub {
    client_id: Option<String>,
}

pub struct Pending {
    device_code: String,
    pub verification_uri: String,
    interval: u64,
    expires_at: u64,
}

#[derive(Deserialize)]
struct DeviceCode {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    #[serde(default = "default_interval")]
    interval: u64,
}

fn default_interval() -> u64 {
    5
}

/// One poll answer: a token, or an OAuth error code (with a new interval for `slow_down`).
#[derive(Deserialize)]
struct TokenAnswer {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
    #[serde(default)]
    interval: Option<u64>,
}

#[derive(Deserialize)]
struct User {
    id: u64,
    login: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

#[derive(Deserialize)]
struct Email {
    email: String,
    #[serde(default)]
    primary: bool,
    #[serde(default)]
    verified: bool,
}

impl GitHub {
    pub fn new(client_id: Option<String>) -> GitHub {
        GitHub { client_id: client_id.filter(|c| !c.trim().is_empty()) }
    }

    fn client_id(&self) -> Result<&str, AuthError> {
        self.client_id.as_deref().ok_or(AuthError::NotConfigured(ProviderId::Github))
    }

    /// Polls the token endpoint until the user approves, declines or the code expires.
    pub async fn poll<H: Http, C: Clock>(
        &self,
        http: &H,
        clock: &C,
        pending: &Pending,
        cancel: &Cancel,
    ) -> Result<Tokens, AuthError> {
        let client_id = self.client_id()?;
        let mut interval = pending.interval.max(1);
        loop {
            clock.sleep(Duration::from_secs(interval)).await;
            if cancel.is_cancelled() {
                return Err(AuthError::Cancelled);
            }
            if clock.now() >= pending.expires_at {
                return Err(AuthError::Expired);
            }
            let resp = http
                .send(Request::post_form(
                    TOKEN_URL,
                    &[("client_id", client_id), ("device_code", &pending.device_code), ("grant_type", DEVICE_GRANT)],
                ))
                .await?;
            // GitHub answers errors with 200 and an `error` field; anything unparsable is fatal
            let answer: TokenAnswer = serde_json::from_str(&resp.body).map_err(|_| provider_error(&resp))?;
            if let Some(access_token) = answer.access_token.filter(|t| !t.is_empty()) {
                return Ok(Tokens {
                    access_token,
                    refresh_token: answer.refresh_token,
                    expires_at: answer.expires_in.map(|s| clock.now() + s),
                    scope: answer.scope,
                });
            }
            match answer.error.as_deref() {
                Some("authorization_pending") => {}
                // RFC 8628 3.5: add 5 seconds; GitHub also sends the new interval
                Some("slow_down") => interval = answer.interval.unwrap_or(interval + 5).max(interval + 1),
                Some("expired_token") => return Err(AuthError::Expired),
                Some("access_denied") => return Err(AuthError::Denied),
                Some(code) => {
                    return Err(AuthError::Provider { code: code.into(), description: answer.error_description })
                }
                None => return Err(AuthError::Invalid("no token and no error".into())),
            }
        }
    }

    /// The identity behind a token: `/user`, and `/user/emails` for a private primary address.
    pub async fn profile<H: Http, C: Clock>(&self, http: &H, clock: &C, tokens: &Tokens) -> Result<Profile, AuthError> {
        let api = |url: &str| {
            Request::get(url)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .bearer(&tokens.access_token)
        };
        let resp = http.send(api(USER_URL)).await?;
        if resp.status == 401 {
            return Err(AuthError::Revoked);
        }
        if !resp.ok() {
            return Err(AuthError::Invalid(format!("GitHub /user answered HTTP {}", resp.status)));
        }
        let user: User = serde_json::from_str(&resp.body).map_err(|e| AuthError::Invalid(e.to_string()))?;
        let mut email = user.email.filter(|e| !e.is_empty());
        let may_read_emails = tokens.scope.as_deref().is_some_and(|s| s.split([',', ' ']).any(|x| x == "user:email" || x == "user"));
        if email.is_none() && may_read_emails {
            // optional: a failure here keeps the sign-in without an email
            if let Ok(resp) = http.send(api(EMAILS_URL)).await {
                if resp.ok() {
                    if let Ok(list) = serde_json::from_str::<Vec<Email>>(&resp.body) {
                        email = list.into_iter().find(|e| e.primary && e.verified).map(|e| e.email);
                    }
                }
            }
        }
        Ok(Profile {
            provider: ProviderId::Github,
            id: user.id.to_string(),
            name: user.name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| user.login.clone()),
            login: Some(user.login),
            avatar_url: user.avatar_url,
            email,
            signed_in_at: clock.now(),
        })
    }
}

impl AuthProvider for GitHub {
    type Pending = Pending;

    fn id(&self) -> ProviderId {
        ProviderId::Github
    }

    fn configured(&self) -> bool {
        self.client_id.is_some()
    }

    async fn start<H: Http, C: Clock>(&self, http: &H, clock: &C) -> Result<(Pending, Prompt), AuthError> {
        let client_id = self.client_id()?;
        let resp = http
            .send(Request::post_form(DEVICE_CODE_URL, &[("client_id", client_id), ("scope", GITHUB_SCOPE)]))
            .await?;
        if !resp.ok() {
            return Err(provider_error(&resp));
        }
        let code: DeviceCode = serde_json::from_str(&resp.body).map_err(|_| provider_error(&resp))?;
        if !code.verification_uri.starts_with(VERIFICATION_PREFIX) {
            return Err(AuthError::Invalid("the verification page is not on github.com".into()));
        }
        let prompt = Prompt::Device {
            user_code: code.user_code,
            verification_uri: code.verification_uri.clone(),
            expires_in: code.expires_in,
        };
        let pending = Pending {
            device_code: code.device_code,
            verification_uri: code.verification_uri,
            interval: code.interval,
            expires_at: clock.now() + code.expires_in,
        };
        Ok((pending, prompt))
    }

    fn browser_url(_: &Pending) -> Option<String> {
        None
    }

    async fn complete<H: Http, C: Clock>(
        &self,
        http: &H,
        clock: &C,
        pending: Pending,
        cancel: &Cancel,
    ) -> Result<(Tokens, Profile), AuthError> {
        let tokens = self.poll(http, clock, &pending, cancel).await?;
        let profile = self.profile(http, clock, &tokens).await?;
        Ok((tokens, profile))
    }

    /// OAuth app tokens do not expire: re-read the profile (a 401 means revoked).
    async fn refresh<H: Http, C: Clock>(&self, http: &H, clock: &C, tokens: &Tokens) -> Result<(Tokens, Profile), AuthError> {
        let profile = self.profile(http, clock, tokens).await?;
        Ok((tokens.clone(), profile))
    }

    /// Revoking needs the client secret, which the app does not have: the user revokes the grant at
    /// github.com/settings/applications.
    async fn revoke<H: Http>(&self, _: &H, _: &Tokens) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::provider::fakes::{block_on, FakeClock, NoNetwork, ScriptedHttp};

    const DEVICE: &str = r#"{"device_code":"dev123","user_code":"WDJB-MJHT","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#;
    const PENDING: &str = r#"{"error":"authorization_pending","error_description":"waiting"}"#;
    const TOKEN: &str = r#"{"access_token":"gho_abc","token_type":"bearer","scope":"read:user,user:email"}"#;
    const USER: &str = r#"{"id":42,"login":"octo","name":"Octo Cat","avatar_url":"https://avatars.githubusercontent.com/u/42","email":null}"#;
    const EMAILS: &str = r#"[{"email":"old@x.test","primary":false,"verified":true},{"email":"octo@x.test","primary":true,"verified":true}]"#;

    fn gh() -> GitHub {
        GitHub::new(Some("Iv1.test".into()))
    }

    fn started(http: &ScriptedHttp, clock: &FakeClock) -> (Pending, Prompt) {
        block_on(gh().start(http, clock)).unwrap()
    }

    #[test]
    fn start_asks_for_a_device_code() {
        let http = ScriptedHttp::new().answer(DEVICE_CODE_URL, 200, DEVICE);
        let clock = FakeClock::at(1000);
        let (pending, prompt) = started(&http, &clock);
        assert_eq!(
            prompt,
            Prompt::Device { user_code: "WDJB-MJHT".into(), verification_uri: "https://github.com/login/device".into(), expires_in: 900 }
        );
        assert_eq!(pending.expires_at, 1900);
        let req = http.request(0);
        assert_eq!(req.form_value("client_id").as_deref(), Some("Iv1.test"));
        assert_eq!(req.form_value("scope").as_deref(), Some(GITHUB_SCOPE));
        assert!(req.headers.iter().any(|(k, v)| *k == "Accept" && v == "application/json"));
    }

    #[test]
    fn a_verification_page_off_github_is_refused() {
        let body = DEVICE.replace("https://github.com/login/device", "https://evil.test/login/device");
        let http = ScriptedHttp::new().answer(DEVICE_CODE_URL, 200, &body);
        assert!(matches!(block_on(gh().start(&http, &FakeClock::at(0))), Err(AuthError::Invalid(_))));
    }

    #[test]
    fn device_flow_disabled_is_reported() {
        let http = ScriptedHttp::new().answer(DEVICE_CODE_URL, 400, r#"{"error":"device_flow_disabled"}"#);
        assert_eq!(
            block_on(gh().start(&http, &FakeClock::at(0))).err(),
            Some(AuthError::Provider { code: "device_flow_disabled".into(), description: None })
        );
    }

    #[test]
    fn polls_until_approved_then_reads_the_profile() {
        let http = ScriptedHttp::new()
            .answer(DEVICE_CODE_URL, 200, DEVICE)
            .answer(TOKEN_URL, 200, PENDING)
            .answer(TOKEN_URL, 200, r#"{"error":"slow_down","interval":10}"#)
            .answer(TOKEN_URL, 200, PENDING)
            .answer(TOKEN_URL, 200, TOKEN)
            .answer(USER_URL, 200, USER)
            .answer(EMAILS_URL, 200, EMAILS);
        let clock = FakeClock::at(1000);
        let (pending, _) = started(&http, &clock);
        let (tokens, profile) = block_on(gh().complete(&http, &clock, pending, &Cancel::default())).unwrap();
        assert_eq!(tokens.access_token, "gho_abc");
        assert_eq!(tokens.expires_at, None);
        // 5 s, 5 s, then slow_down: 10 s from then on
        let sleeps: Vec<u64> = clock.sleeps.lock().unwrap().iter().map(|d| d.as_secs()).collect();
        assert_eq!(sleeps, vec![5, 5, 10, 10]);
        let poll = http.request(1);
        assert_eq!(poll.form_value("device_code").as_deref(), Some("dev123"));
        assert_eq!(poll.form_value("grant_type").as_deref(), Some(DEVICE_GRANT));
        assert!(http.request(5).headers.iter().any(|(k, v)| *k == "Authorization" && v == "Bearer gho_abc"));
        assert_eq!(
            profile,
            Profile {
                provider: ProviderId::Github,
                id: "42".into(),
                login: Some("octo".into()),
                name: "Octo Cat".into(),
                avatar_url: Some("https://avatars.githubusercontent.com/u/42".into()),
                email: Some("octo@x.test".into()),
                signed_in_at: 1030,
            }
        );
    }

    #[test]
    fn slow_down_without_an_interval_adds_five_seconds() {
        let http = ScriptedHttp::new()
            .answer(DEVICE_CODE_URL, 200, DEVICE)
            .answer(TOKEN_URL, 200, r#"{"error":"slow_down"}"#)
            .answer(TOKEN_URL, 200, TOKEN);
        let clock = FakeClock::at(0);
        let (pending, _) = started(&http, &clock);
        block_on(gh().poll(&http, &clock, &pending, &Cancel::default())).unwrap();
        let sleeps: Vec<u64> = clock.sleeps.lock().unwrap().iter().map(|d| d.as_secs()).collect();
        assert_eq!(sleeps, vec![5, 10]);
    }

    #[test]
    fn denied_expired_and_other_errors_stop_polling() {
        for (answer, expected) in [
            (r#"{"error":"access_denied"}"#, AuthError::Denied),
            (r#"{"error":"expired_token"}"#, AuthError::Expired),
            (
                r#"{"error":"incorrect_client_credentials","error_description":"bad id"}"#,
                AuthError::Provider { code: "incorrect_client_credentials".into(), description: Some("bad id".into()) },
            ),
        ] {
            let http = ScriptedHttp::new().answer(DEVICE_CODE_URL, 200, DEVICE).answer(TOKEN_URL, 200, answer);
            let clock = FakeClock::at(0);
            let (pending, _) = started(&http, &clock);
            assert_eq!(block_on(gh().poll(&http, &clock, &pending, &Cancel::default())), Err(expected));
            assert_eq!(http.count(), 2);
        }
    }

    #[test]
    fn the_code_expires_locally_and_cancel_stops_before_the_next_poll() {
        let short = DEVICE.replace("\"expires_in\":900", "\"expires_in\":12");
        let http = ScriptedHttp::new()
            .answer(DEVICE_CODE_URL, 200, &short)
            .answer(TOKEN_URL, 200, PENDING)
            .answer(TOKEN_URL, 200, PENDING);
        let clock = FakeClock::at(0);
        let (pending, _) = started(&http, &clock);
        // polls at 5 s and 10 s, stops at 15 s without a third request
        assert_eq!(block_on(gh().poll(&http, &clock, &pending, &Cancel::default())), Err(AuthError::Expired));
        assert_eq!(http.count(), 3);

        let cancel = Cancel::default();
        cancel.cancel();
        let pending = Pending { device_code: "d".into(), verification_uri: String::new(), interval: 5, expires_at: 999 };
        assert_eq!(block_on(gh().poll(&NoNetwork, &FakeClock::at(0), &pending, &cancel)), Err(AuthError::Cancelled));
    }

    #[test]
    fn unconfigured_makes_no_request_and_revoked_tokens_are_detected() {
        let none = GitHub::new(Some("  ".into()));
        assert!(!none.configured());
        assert_eq!(block_on(none.start(&NoNetwork, &FakeClock::at(0))).err(), Some(AuthError::NotConfigured(ProviderId::Github)));
        let http = ScriptedHttp::new().answer(USER_URL, 401, r#"{"message":"Bad credentials"}"#);
        let t = Tokens { access_token: "gho_x".into(), refresh_token: None, expires_at: None, scope: None };
        assert_eq!(block_on(gh().refresh(&http, &FakeClock::at(0), &t)).err(), Some(AuthError::Revoked));
    }

    #[test]
    fn without_the_email_scope_only_the_user_is_read() {
        let http = ScriptedHttp::new().answer(USER_URL, 200, &USER.replace("\"name\":\"Octo Cat\"", "\"name\":null"));
        let t = Tokens { access_token: "gho_x".into(), refresh_token: None, expires_at: None, scope: Some(String::new()) };
        let p = block_on(gh().profile(&http, &FakeClock::at(0), &t)).unwrap();
        assert_eq!((p.name.as_str(), p.email), ("octo", None));
        assert_eq!(http.count(), 1);
    }
}
