# Install and download counts

Release builds enable the Cargo `telemetry` feature by default. Collection remains off until the user chooses **Allow** in the first-start “Help count Fairbeam installs?” dialog. **No thanks** or dismissal records denial. The answer is stored; the dialog does not return after an answer. Existing consent for a different report schema requires a new answer. Browser/demo usage sends nothing. Sign-in remains disabled.

## Report and local controls

```json
{"schema":"fairbeam.ping/3","install_id":"1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b","app_version":"0.7.2","os":"macos","arch":"aarch64"}
```

Only these fields are sent to `https://fairbeam.org/api/ping`. The install ID exists solely to count distinct installs. It is a UUIDv4 generated locally using OS randomness on the first Allow, never from hardware, user names, paths or network data. Nothing about designs, files, results or the user is sent.

Settings › General › Install counts allows withdrawal at any time. Turning counting off deletes the local ID; turning it on again generates a new one. **Reset ID**, beside the switch, generates a new ID while counting is on. Neither action resets the sending schedule. `FAIRBEAM_NO_TELEMETRY=1` overrides consent for that process. Builds using `--no-default-features` have no telemetry HTTP client and do not read or write telemetry settings.

The app's local telemetry `state.json` contains `consent`, `consent_schema`, `install_id` and `last_sent` (Unix seconds of the last attempted request). A request is attempted at most once every seven elapsed days while the app is open. The date is saved before transmission; failures also wait seven days and cause no user-facing error. Clock rollback delays sending. Consent changes, ID resets and sending share a process mutex and an empty OS-locked `state.lock` file (Rust 1.89 or later). After withdrawal completes, no pending sender can start a request. HTTP redirects are disabled. View what would be sent displays the actual report when due; disabled builds show only a format example.

## Storage and retention

Configure the following secrets in Vercel, never in the repository:

- `STATS_GITHUB_TOKEN`: a token scoped to Contents write on the statistics repository.
- `STATS_REPO=owner/repository`, preferably restricted; optional `STATS_BRANCH` defaults to `main`.
- `KV_REST_API_URL` and `KV_REST_API_TOKEN`: a Vercel-connected Redis REST store supporting EVAL, sets, hashes and EXAT/EXPIREAT. Restrict access and disable command/request-body logging.

Without storage credentials, pings fail silently in the app. The API does not log payloads, IP addresses, user agents, request headers or exception details. Providers process network requests under their own policies and may retain infrastructure logs. Vercel hosts the API and connects Redis storage; GitHub stores only aggregate snapshots, releases and updates. Provider servers may be outside Türkiye. Questions: ismail@fairbeam.org.

An atomic Redis script maintains a random 256-bit salt for the current UTC ISO week and salted SHA-1 hashes of random UUIDs in a global weekly set and per-version/OS/architecture weekly sets. The salt is shared by concurrent requests and rotates weekly. All salts and hash sets have an absolute expiry at the next Monday 00:00 UTC. Each first occurrence increments the corresponding aggregate in the same script, before hashes expire; there is no end-of-week job or raw event log. Hashes and salts are never written to GitHub. Configure Redis persistence/backups so expired temporary keys are not retained in historical backups.

Only aggregates remain after expiry: per ISO week, version, OS and architecture distinct-install totals in `fairbeam:{counts}:aggregates`. The same Redis hash includes `cumulative_weekly_distinct`, incremented once per ID per week across all tuples. **Exact all-time distinct counting is not feasible with weekly salt rotation and deletion of identifiers.** This cumulative weekly sum is an estimate; a returning install contributes again in another week. ID resets and fabricated reports can inflate counts. These are not verified user counts. Aggregates have no scheduled deletion date.

The API mirrors tuple aggregates to GitHub as `data/YYYY-Www--version--os--arch--installs.json`, with only `week`, `app_version`, `os`, `arch` and `count`. GitHub updates use SHA conflict retries, never decrease a total, and are dated to the week's start. Redis is authoritative: a failed GitHub write does not lose counts, and a later ping for that tuple republishes its latest total. A tuple with no later ping may have an incomplete GitHub snapshot; read Redis for authoritative totals.

Older report schemas remain accepted, but extra identifiers and counters are discarded. Their approximate report totals use separate files without `--installs` and must not be treated as distinct installs. GitHub history never contains the temporary deduplication state. The API validates body size, content type, exact fields and values; failures return 503 without logging request details.

## Download counts

`node scripts/stats-summary.mjs --releases-only` reads public GitHub release asset totals without a token. Download counts are requests, not unique people or installs; retries and updates can increase them. This requires no app opt-in. Aggregate snapshots can be read with `--dir /path/to/stats/data --no-releases` or `--gh --repo owner/repository --no-releases`.

## Verification

`npm run check:telemetry` checks payload validation, aggregate storage, deduplication contracts, consent gating, weekly scheduling, random ID generation/regeneration, release totals and pagination without production requests. Rust core tests run in a temporary crate with `--features telemetry`, without building the desktop app. `FAIRBEAM_USAGE_URL=http://127.0.0.1:5354 node scripts/check-telemetry-ui.mjs` checks English/Turkish consent and Settings flows with a fake native bridge and screenshots in `/tmp`. For the real Redis script, set `FAIRBEAM_REDIS_SERVER` and `FAIRBEAM_REDIS_CLI` to local Redis binaries and run `node scripts/check-telemetry-redis.mjs`. It uses a disposable Unix-socket instance with persistence off and verifies deduplication, tuple isolation, salt rotation and expiry without contacting production. Public English and Turkish notices are on [the privacy page](https://fairbeam.org/privacy.html).
