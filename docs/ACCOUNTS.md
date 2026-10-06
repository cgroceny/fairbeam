# Optional sign-in (GitHub, Google)

Status: **built, switched off**. No release has it on. With the switch off, the app shows no account
UI, has no account commands and makes no network call for accounts. Guest mode is the default and
stays the default when the switch is on: every feature works without an account, offline.

The goal: "sign in with GitHub or Google with one click, and the app remembers who signed in". There
is no backend and no database. The desktop app talks to GitHub and Google directly, and keeps what it
learns on the user's own computer.

## The switch

Two build-time switches, both off by default. Both must be on for sign-in to appear:

| Layer | Switch | Off means |
|---|---|---|
| Desktop shell (Rust) | Cargo feature `accounts` (`src-tauri/Cargo.toml`) | `src-tauri/src/account/` is not compiled, the `account` plugin and its commands do not exist, its capability is not added, `keyring`/`reqwest`/PKCE crates are not linked |
| Viewer (TypeScript) | `VITE_FAIRBEAM_ACCOUNTS=1` at `vite build` time | `accountUiEnabled()` is false: the chip, the dialog and the settings section render nothing and never call the shell |

The viewer also needs the desktop shell (`window.__TAURI_INTERNALS__`): the web demo never shows it.

The OAuth client ids are compiled in from environment variables at `cargo build` time. Unset, they
are placeholders and the provider reports "not configured" (its button is disabled):

| Variable | What |
|---|---|
| `FAIRBEAM_GITHUB_CLIENT_ID` | GitHub OAuth app client id (Device Flow enabled) |
| `FAIRBEAM_GOOGLE_CLIENT_ID` | Google OAuth client id, type "Desktop app" |
| `FAIRBEAM_GOOGLE_CLIENT_SECRET` | the "secret" Google issues with a Desktop client (not confidential, see below) |

## Architecture

```
viewer (127.0.0.1)                       desktop shell (Rust, feature "accounts")
src/lib/account.ts  ── invoke ──►  plugin:account|status / sign_in_start / sign_in_wait /
src/components/Account*.tsx               sign_in_cancel / open_verification / refresh / sign_out
                                           │
                                  src-tauri/src/account/
                                    service.rs   the switch guard, pending sign-in, sign-out, refresh
                                    provider.rs  AuthProvider trait, Tokens, Profile, Http, Clock
                                    github.rs    Device Flow
                                    google.rs    PKCE + loopback redirect, id_token claims
                                    pkce.rs      verifier, S256 challenge, state
                                    loopback.rs  127.0.0.1 callback listener and parser
                                    store.rs     SecretStore trait: keyring (OS), memory (tests)
                                    plugin.rs    Tauri plugin, reqwest Http, settings cache
                                           │
                        Keychain / Credential Manager (tokens)   settings.json (profile cache)
```

- The shell part is an inlined Tauri plugin named `account`. `build.rs` declares its commands only
  when `CARGO_FEATURE_ACCOUNTS` is set (the list is in `src-tauri/src/account/switch.rs`, shared with the
  crate). The capability that lets the viewer call them (`src-tauri/src/account/capability.json`, remote
  `http://127.0.0.1:*/*` like `capabilities/viewer.json`) is added at runtime by the plugin's setup,
  so it does not exist in a build without the feature. The static files in `capabilities/` never
  name an account permission (a unit test checks this).
- Every URL the shell opens comes from the shell: the page names a provider, never a URL
  (the same rule as `open_external_link`).
- Providers sit behind `AuthProvider` (`provider.rs`): `start` returns what the user must see (a
  device code, or "continue in your browser"), `complete` waits for the tokens, `profile` reads the
  identity, `refresh` renews tokens where the provider can. HTTP and time are traits too (`Http`,
  `Clock`), so the flows are unit-tested against scripted responses with no network and no sleeping.
  A third provider (GitLab, ORCID, Microsoft) is one more `AuthProvider` plus a `ProviderId` value.

### GitHub: OAuth Device Flow

No client secret and no redirect: the right shape for a desktop app with no server.

1. `POST https://github.com/login/device/code` with `client_id` and `scope`, `Accept: application/json`.
   The answer has `device_code`, `user_code`, `verification_uri`, `expires_in` and `interval`.
2. The dialog shows the user code. "Copy code and open github.com/login/device" copies it and opens
   the verification page (the shell checks it is `https://github.com/...`).
3. The shell polls `POST https://github.com/login/oauth/access_token` with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code` every `interval` seconds:
   `authorization_pending` waits, `slow_down` adds 5 s (or takes the interval GitHub sends),
   `expired_token`, `access_denied`, `device_flow_disabled` and the rest stop with a message.
   Cancel stops the polling; the code also expires on its own (`expires_in`, 15 min).
4. With the token: `GET https://api.github.com/user` (login, name, avatar, public email) and, when the
   `user:email` scope was granted, `GET /user/emails` for the primary verified address.

Scope: `read:user user:email` (constant `GITHUB_SCOPE`). The public profile (login, name, avatar)
needs no scope at all; an empty scope is enough if the email is not wanted.

OAuth app tokens do not expire, so there is nothing to refresh: "refresh" re-reads `/user` to update
the cached name and avatar, and a 401 (the user revoked the app) signs out locally. The app cannot
revoke a GitHub token itself (that needs the client secret); the user revokes it at
<https://github.com/settings/applications>, which Sign out mentions.

### Google: installed-app OAuth with PKCE and a loopback redirect

1. The shell binds `127.0.0.1:0` (a random free port) and builds
   `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=…&redirect_uri=http://127.0.0.1:<port>/callback&scope=openid email profile&code_challenge=…&code_challenge_method=S256&state=…`.
   The verifier is 32 random bytes in base64url (43 characters, RFC 7636), the challenge its SHA-256
   in base64url, `state` 16 more random bytes.
2. The system browser opens it. The listener accepts one `GET /callback?...`, checks `state`
   (mismatch or missing: rejected), reads `code` or `error` (for example `access_denied`), answers
   with a short "You can close this tab" page and closes. Other paths (`/favicon.ico`) get a 404 and
   the listener keeps waiting. Cancel or 5 minutes without a callback closes it.
3. `POST https://oauth2.googleapis.com/token` with `code`, `code_verifier`, `redirect_uri`,
   `client_id`, `client_secret`, `grant_type=authorization_code`.
4. The `id_token` claims give the identity (`sub`, `email`, `email_verified`, `name`, `picture`). The
   token came straight from Google's token endpoint over TLS, so its signature is not checked
   (OpenID Connect Core 3.1.3.7); `iss`, `aud` (our client id) and `exp` are.
5. Refresh: `grant_type=refresh_token` renews the access token silently; the new `id_token` updates
   the cached name and picture. Sign out also calls `https://oauth2.googleapis.com/revoke`
   (best effort, offline sign-out still works).

Google's rules for installed apps: the Desktop client id and its "client secret" are embedded in the
app and are **not treated as confidential** (Google's own docs say so); PKCE is what protects the
code. Loopback IP redirects are the supported method for desktop apps (the out-of-band flow was
removed in 2022).

Consent screen: `openid`, `email` and `profile` are **non-sensitive** scopes. While the app is in
"Testing" only listed test users (up to 100) can sign in and refresh tokens expire after 7 days. To
publish it "In production" Google asks for the app name, logo, support email, the home page and a
privacy policy link on a verified domain (Fairbeam's site). Brand verification for non-sensitive
scopes is light (a few days) and needs no security assessment; an unverified app shows its name
without the logo until then.

### Remembering who signed in

- **Tokens** go to the OS credential store through the `keyring` crate 3.x: macOS Keychain
  (`apple-native`), Windows Credential Manager (`windows-native`). One entry per provider, service
  `org.fairbeam.desktop`, user `oauth-github` / `oauth-google`, value a small JSON (access token,
  refresh token, expiry). The id_token is not stored (Windows limits a credential to 2560 bytes).
  On Linux (not a release target) keyring falls back to its in-memory mock, so nothing persists.
- **Profile cache** (not secret) in `settings.json` under `account`: provider, id, login, display
  name, avatar URL, email if granted, signed-in date. The chip reads it at start with no network call.
  It is kept as raw JSON in `paths::Settings`, so a build without the feature does not drop it.
- **Sign out** deletes the keychain entry, clears the cache and (Google) revokes the token.
- **Silent refresh** (`refresh`): Google renews its access token with the refresh token; GitHub
  re-reads the profile. The chip calls it once per start while signed in; a failure leaves the
  cached identity, a revoked grant signs out.
- **Never logged**: `Tokens` and HTTP requests have a redacting `Debug`; error messages carry the
  provider's `error` code, never a response body with a token in it.

Dependencies: with the feature on, `cargo tree` gains exactly one crate on macOS and on Windows,
`keyring` 3.6 itself. Its dependencies (`security-framework` 3 on macOS; `windows-sys` 0.60,
`byteorder`, `zeroize` on Windows) and `reqwest`, `rustls`, `sha2`, `base64`, `getrandom`, `url`
and `tokio` are already in the tree for the updater and Tauri. `Cargo.lock` also records
`security-framework` 2.11, which keyring uses on iOS only (never built). With the feature off
none of them is linked into Fairbeam for accounts. If `keyring` ever becomes a problem, the alternative is the platform APIs directly
(`security-framework` `set_generic_password`, `windows-sys` `CredWriteW`), about 80 lines behind the
same `SecretStore` trait.

## UI (written, hidden while off)

- **Top bar chip** (`AccountChip.tsx`): "Guest", or the avatar and name. Opens the dialog.
- **Dialog** (`AccountDialog.tsx`): "Continue with GitHub", "Continue with Google",
  "Continue as guest", with the line "Signing in is optional. Fairbeam works fully offline as a
  guest." GitHub shows the code and the copy-and-open button; Google says to finish in the browser.
- **General settings › Account** (`AccountSettings.tsx`): who is signed in, Sign out; as a guest,
  "Sign in…".
- Shared state and the avatar (`AccountState.tsx`); every shell call goes through
  `src/lib/account.ts`, which checks the switch before each one. Avatars load only from
  `*.githubusercontent.com` / `*.googleusercontent.com` over https, with initials as the fallback.

## Tests

- `cd src-tauri && cargo test` (no feature needed; the module is compiled for tests): PKCE against
  RFC 7636 Appendix B, loopback parsing (state mismatch or missing, `error=`, no code, other paths)
  and a real 127.0.0.1 round trip, device-flow polling (`authorization_pending`, `slow_down`,
  expiry, denial, cancel) against scripted HTTP with virtual time, Google's exchange and refresh,
  id_token checks, the token store behind `SecretStore` with an in-memory fake, and switch-off: every
  service call returns `disabled` with an HTTP layer that fails the test on any request, no command
  is declared and no static capability names the plugin.
- `cargo check --features accounts` compiles the plugin, reqwest, keyring.
- `npm run check:account`: with the flag off (or outside the shell) nothing renders and no call
  reaches the shell; the components are gated and never call out directly.

## Turning it on (maintainer)


1. GitHub: Settings › Developer settings › OAuth Apps › New OAuth App. Homepage
   `https://fairbeam.org` (or the site's URL), any callback URL (the device flow does not use it),
   tick **Enable Device Flow**. Copy the client id. No client secret is needed; do not generate one.
2. Google Cloud: a project › APIs & Services › OAuth consent screen (External; app name, support
   email, logo, home page, privacy policy; scopes `openid`, `email`, `profile`), then Credentials ›
   Create OAuth client ID › **Desktop app**. Copy the client id and secret. Publish the consent
   screen to production when ready (see above).
3. Build with the ids and both switches:
   ```sh
   export FAIRBEAM_GITHUB_CLIENT_ID=… FAIRBEAM_GOOGLE_CLIENT_ID=… FAIRBEAM_GOOGLE_CLIENT_SECRET=…
   VITE_FAIRBEAM_ACCOUNTS=1 npx tauri build --features accounts
   ```
   (`beforeBuildCommand` runs `npm run build`, which sees `VITE_FAIRBEAM_ACCOUNTS`.) The release
   build (`npm run desktop:release`, [RELEASES.md](RELEASES.md)) needs the same variables and
   `--features accounts` once it ships.
4. Publish the privacy notice (below) on the site before the first release that has it on.

## Later: a "who uses it" registry (documented, not built)

The maintainer may want to see who signed in, still without a database. The site's Vercel project
could get a function next to the telemetry one (`api/ping`, which writes to a private GitHub repo):

- `POST /api/register` from the desktop app, **only after a separate, explicit opt-in** in the
  account dialog ("Let the maintainer see that I use Fairbeam: my GitHub login or Google email and
  the date I first signed in"), unticked by default and independent of signing in.
- The function verifies the identity instead of trusting the body: for GitHub it calls
  `GET https://api.github.com/user` with the user's token (used once, not stored); for Google it
  checks the `id_token` (Google's JWKS or `tokeninfo`, `aud` = our client id).
- It writes one file per person to a private repo with the GitHub Contents API, create-only so the
  first-seen date never changes: `users/github-<login>.json` or `users/google-<sha256(email)>.json`
  containing `{provider, login or email, first_seen, consent_version}`. The token is a fine-grained
  PAT with Contents: write on that one repo, kept in a Vercel environment variable.
- It does not store the IP address and does not log request bodies.
- `DELETE /api/register` (same identity check) removes the file: "Remove me" next to the opt-in and
  in General settings, and withdrawing consent does the same.

KVKK (Law No. 6698) and GDPR notes, to be checked by someone qualified before it ships:

- Signing in alone sends nothing to the maintainer: the data stays on the user's computer and with
  the provider the user chose. The registry is a separate processing activity with its own consent
  (KVKK açık rıza, GDPR Art. 6(1)(a)): specific, informed, freely given, as easy to withdraw.
- A privacy notice (KVKK aydınlatma metni, GDPR Art. 13) on the site, linked from the opt-in: who the
  controller is, what is stored (login or email, first-seen date), why (to know who uses Fairbeam),
  where (GitHub and Vercel, both outside Türkiye: cross-border transfer under KVKK Art. 9 as amended
  in 2024), how long (until deletion or two years without use), and the rights (KVKK Art. 11,
  GDPR Arts. 15-17 and 21) with a contact address.
- Account deletion: the in-app "Remove me" deletes the registry file; Sign out deletes everything
  local; an email to the contact address works too. Answer requests within 30 days (KVKK Art. 13,
  GDPR Art. 12(3): one month).
- Data minimization: no IP, no device id, no usage events in the registry. The anonymous telemetry
  (separate document) must never be joined with it.
- Check whether VERBİS registration applies (small controllers are often exempt).
