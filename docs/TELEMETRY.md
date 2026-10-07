# Install and download counts

Release builds enable the Cargo `telemetry` feature by default; debug builds (`cargo run`, `tauri dev`) never ask and never send. Collection remains off until the user chooses **Allow** in the first-start “Help count Fairbeam installs?” dialog. **No thanks** or dismissal records denial. The answer is stored; the dialog does not return after an answer. Existing consent for a different report schema requires a new answer. Browser/demo usage sends nothing. Sign-in remains disabled.

## Report and local controls

```json
{"schema":"fairbeam.ping/3","install_id":"1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b","app_version":"0.7.2","os":"macos","arch":"aarch64"}
```

Only these fields are sent to `https://fairbeam.org/api/ping`. The install ID exists solely to count distinct installs. It is a UUIDv4 generated locally using OS randomness on the first Allow, never from hardware, user names, paths or network data. Nothing about designs, files, results or the user is sent.

Settings › General › Install counts allows withdrawal at any time. Turning counting off deletes the local ID; turning it on again generates a new one. **Reset ID**, beside the switch, generates a new ID while counting is on. Neither action resets the sending schedule. `FAIRBEAM_NO_TELEMETRY=1` overrides consent for that process. Builds using `--no-default-features` have no telemetry HTTP client and do not read or write telemetry settings.

The app's local telemetry `state.json` contains `consent`, `consent_schema`, `install_id` and `last_sent` (Unix seconds of the last attempted request). A request is attempted at most once every seven elapsed days while the app is open. The date is saved before transmission; failures also wait seven days and cause no user-facing error. Clock rollback delays sending. Consent changes, ID resets and sending share a process mutex and an empty OS-locked `state.lock` file (Rust 1.89 or later). After withdrawal completes, no pending sender can start a request. HTTP redirects are disabled. View what would be sent displays the actual report when due; disabled builds show only a format example.

## Storage and retention

Counts are kept in a Redis database that Vercel connects to the project through its Marketplace integration (Upstash Redis). The integration adds the environment variables `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`) to the project by itself, so no token is typed or committed. Without them `/api/ping` answers 503 and does nothing; the app ignores that silently. The setup steps are in [DEPLOY.md](DEPLOY.md#usage-counts-redis). The free tier is enough: a ping is two Redis calls, and only a few keys exist (one salt, one global set and one set per version/OS/architecture for the current week, plus the aggregate hash); the sets hold one 64-character hash per install.

The API does not log payloads, IP addresses, user agents, request headers or exception details. Providers process network requests under their own policies and may retain infrastructure logs. Provider servers may be outside Türkiye. Questions: ismail@fairbeam.org.

How an install is counted, per ping:

1. An atomic Redis script returns the random 256-bit salt of the current UTC ISO week and creates it on the first request of the week. The salt has an absolute expiry at the next Monday 00:00 UTC.
2. The API computes HMAC-SHA-256 of the install ID with that salt. The install ID itself is never sent to Redis, stored or logged; only the hash reaches the database.
3. A second atomic script adds the hash to a weekly set and to a per-version/OS/architecture weekly set, both with the same absolute expiry. The first time a hash enters a set the matching aggregate is incremented in the same script, so the total survives when the hashes expire.

The salt changes every week and is deleted together with the hashes, so after the week ends nothing on the server links a hash to the same install in another week. There is no end-of-week job and no raw event log. Configure Redis persistence/backups so expired temporary keys are not retained in historical backups.

Only aggregates remain after expiry: per ISO week, version, OS and architecture distinct-install totals in the hash `fairbeam:{counts}:aggregates`, whose field `cumulative_weekly_distinct` is incremented once per ID per week across all tuples. **Exact all-time distinct counting is not feasible with weekly salt rotation and deletion of identifiers.** This cumulative weekly sum is an estimate; a returning install contributes again in another week. ID resets and fabricated reports can inflate counts. These are not verified user counts. Aggregates have no scheduled deletion date. Read them with `node scripts/stats-summary.mjs --redis --no-releases` (after `vercel env pull`, or paste the variables into the shell) or in the database's data browser in the Vercel dashboard.

Reports in the schemas of earlier versions are validated and acknowledged, but nothing from them is stored. The API validates body size, content type, exact fields and values; failures return 503 without logging request details.

## Download counts

`node scripts/stats-summary.mjs --releases-only` reads public GitHub release asset totals without a token. Download counts are requests, not unique people or installs; retries and updates can increase them. This requires no app opt-in.

## Verification

`npm run check:telemetry` checks payload validation, the Redis commands (which must contain no install ID, address or header), deduplication contracts, consent gating, weekly scheduling, random ID generation/regeneration, release totals and pagination without production requests. Rust core tests run in a temporary crate with `--features telemetry`, without building the desktop app. `FAIRBEAM_USAGE_URL=http://127.0.0.1:5354 node scripts/check-telemetry-ui.mjs` checks English/Turkish consent and Settings flows with a fake native bridge and screenshots in `/tmp`. For the real Redis script, set `FAIRBEAM_REDIS_SERVER` and `FAIRBEAM_REDIS_CLI` to local Redis binaries and run `node scripts/check-telemetry-redis.mjs`. It uses a disposable Unix-socket instance with persistence off and verifies the salt script, deduplication, tuple isolation, salt rotation and expiry without contacting production. Public English and Turkish notices are on [the privacy page](https://fairbeam.org/privacy.html).
