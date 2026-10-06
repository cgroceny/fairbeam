# Usage statistics (telemetry)

Fairbeam can count, anonymously and only with the user's consent, how often the desktop app is
started and how many simulations it runs, and send these counts once a day. The maintainer then
knows roughly how many people use the app and which features they use. There is no third-party
analytics service (no Aptabase, PostHog or Google Analytics) and no database.

**Status: built and wired, but OFF.** Release builds do not include it. With the switch off:

- no network request is ever made, and the sending code is not even compiled in;
- no consent dialog is shown, and the app writes no telemetry files;
- General settings › Usage statistics says "Not active in this build: nothing is counted or sent."
  Its "View what would be sent" button still works: it shows an example that nothing sends, and
  "What is collected" opens the privacy page.

## Contents

- [The switch](#the-switch)
- [What is counted](#what-is-counted)
- [Where each count happens](#where-each-count-happens)
- [Files on the user's computer](#files-on-the-users-computer)
- [The daily ping](#the-daily-ping)
- [Consent](#consent)
- [The receiving side](#the-receiving-side)
- [Summary script](#summary-script)
- [Turning it on](#turning-it-on)
- [Hard rules](#hard-rules)

## The switch

Four conditions, all needed. Telemetry is active only when all of them hold:

| Condition | Where | Default |
| --- | --- | --- |
| Build switch: the Cargo feature `telemetry` | `src-tauri/Cargo.toml`; `telemetry::BUILD_ENABLED = cfg!(feature = "telemetry")` | off |
| No `FAIRBEAM_NO_TELEMETRY=1` in the environment | checked by the shell and by the Python server | not set |
| Consent `granted` | `<app data>/telemetry/state.json` → `consent`: unset, `"granted"` or `"denied"` | unset |
| The server receiving it is configured | Vercel env vars `STATS_GITHUB_TOKEN` and `STATS_SALT` | unset: the endpoint answers 503 |

With the build switch off:

- the shell never creates `<app data>/telemetry/`;
- it does not pass `FAIRBEAM_TELEMETRY_DIR` to the Python server, so the server counts nothing;
- the viewer's `src/lib/telemetry.ts` never counts. It asks the shell for the status only when
  General settings or the first-start check need it.

The HTTP client (reqwest, already in the dependency tree through the updater) is an optional
dependency of the feature. A build without the feature has no code that can send a ping.

`FAIRBEAM_NO_TELEMETRY=1` wins over everything: over a build with the feature and over consent.

## What is counted

The counts are kept per UTC day. Every counter is a plain integer under a fixed key. The only list
of keys is `api/_ping-schema.json`. The shell (Rust), the receiving function and the Python tests
all read it, so a key that is not listed there can never be sent or accepted.

| Event | Keys |
| --- | --- |
| App start | `app.start` |
| First run of a new install | `app.install` |
| First run of a version after an update | `app.update_from.<previous version>` (`unknown` when the previous version was not recorded); the new version is the ping's `app_version` |
| Simulation started | `sim.started.<engine>.<source>`, with engine `cpu` or `gpu` and source `design` (a user design), `example` (a bundled example) or `python` (a user Python model) |
| Simulation finished | `sim.finished.<engine>.<source>`, plus `sim.duration.<bucket>` (`lt10s`, `10-60s`, `1-10min`, `gt10min`) and `sim.cells.<bucket>` (`lt100k`, `100k-1m`, `gt1m`, when the run reported its cell count) |
| Simulation failed | `sim.failed.<engine>.<category>`. The category is a code, never a message: `start`, `server`, `no-result`, `solver`, `memory`, `gpu`, `timeout`, `mesh-cells`, `design`, `crash`, `interrupted`, `other` |
| Simulation canceled | `sim.cancelled.<engine>` |
| Run refused before it started (design check errors) | `sim.refused.mesh-cells` or `sim.refused.design-check` |
| Monitors used (per design run started) | `monitor.far_field`, `monitor.surface_current`, `monitor.efficiency`, `monitor.field_planes` |
| Parameter sweep started | `sweep.started.<points>`, with points `1-5`, `6-20`, `21-100` or `gt100` (each point is also a simulation) |
| Optimizer run | `optimize.started.<method>` (`auto`, `secant`, `nelder-mead`, `bayesian`, `cma-es`, `particle-swarm`, `genetic`, `trust-region`), `optimize.finished`, `optimize.failed` |
| VBA macro import | `feature.cst_import` |
| VBA macro export | `feature.cst_export` |
| Touchstone export | `feature.touchstone_export` |
| PDF report | `feature.pdf_report` |

An optimizer job is counted as an optimizer run only, not as simulations.

## Where each count happens

| Count | Place | Why there |
| --- | --- | --- |
| `app.start`, `app.install`, `app.update_from.*` | `src-tauri/src/telemetry.rs` `on_app_start`, called once from `main.rs` `setup` | once per app process, before any server exists; a server restart (Retry, a changed GPU setting) does not count again |
| `sim.started.*`, `monitor.*` | `python/fairbeam/telemetry.py` `job_started`, through `JobManager.on_started` (`jobs.py`, when a job's process starts) | the server knows the engine, the model file and the design's monitors |
| `sim.finished.*`, `sim.failed.*`, `sim.cancelled.*`, `sim.duration.*`, `sim.cells.*`, `optimize.finished`, `optimize.failed` | `telemetry.py` `job_finished`, chained onto `JobManager.on_finished` in `server.py` | every job ends there, also when no viewer is watching |
| `sim.refused.*` | `server.py` `App._refuse_broken_design` | the design checks refuse the run before a job exists |
| `sweep.started.*` | `server.py` `App.submit_sweep` | the number of points is known only there |
| `optimize.started.*` | `server.py` `App.submit_optimization` | the method is validated there |
| `feature.cst_import` | `server.py` `App.create_design` with a `cst` macro | the design is created from the macro there |
| `feature.cst_export` | `src/components/ExportDialog.tsx`, after the macro was saved | the macro is written in the browser |
| `feature.touchstone_export` | `src/designer/resultTouchstone.ts` `exportResultTouchstone` | the one function behind every Touchstone export |
| `feature.pdf_report` | `src/components/PackageDialog.tsx`, after the report (or a package with it) was saved | the PDF is written in the browser |

The viewer counts through the Tauri command `telemetry_count`, not over HTTP. The command accepts
only the `ui_events` of the schema. The viewer calls it only when the shell reported telemetry as
active, and never in a browser or in the web demo.

## Files on the user's computer

Everything lives in `<app local data>/telemetry/`. That is
`~/Library/Application Support/org.fairbeam.desktop/telemetry` on macOS and
`%LOCALAPPDATA%\org.fairbeam.desktop\telemetry` on Windows. The folder exists only in a build with
the switch on. The consent lives here too, not in `settings.json`, so the setting exists only in a build with
the switch on. The shell creates `state.json` with a random install id at the first start of such a
build. The id stays on the computer until the user says yes. Each file has exactly one writer, so
the shell and the server never overwrite each other:

| File | Writer | Content |
| --- | --- | --- |
| `state.json` | shell | `install_id`, `consent`, `counting` (consent granted and not disabled), `last_version`, `gpu_available`, `last_attempt_day`, `sent_through` |
| `counters-shell.json` | shell | `{"days": {"2026-09-28": {"app.start": 2, "feature.cst_export": 1}}}` |
| `counters-server.json` | Python server | the same shape, for the simulation, sweep, optimizer and import counts |

The server reads `state.json`: it counts only while `counting` is true. When `counting` is false it
deletes its own file, and it drops the days up to `sent_through` whenever it writes. Days older than
31 days are dropped by both writers and never sent.

## The daily ping

The shell checks shortly after the start, then every 6 hours while the app stays open. It sends at
most one POST per UTC day, only when every condition of [the switch](#the-switch) holds, to:


```
POST https://fairbeam.org/api/ping
Content-Type: application/json
User-Agent: fairbeam/<version>
```

Installed old apps post to `https://antenlab.akdag.dev/api/ping`. That host stays up for
them: the function does not look at the host, and `vercel.json` redirects only the pages of the
old host, never `/api` (see [DEPLOY.md](DEPLOY.md)).

```json
{
  "schema": "fairbeam.ping/1",
  "install_id": "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b",
  "app_version": "0.4.4",
  "os": "macos",
  "arch": "aarch64",
  "gpu_available": false,
  "day": "2026-09-27",
  "counters": { "app.start": 2, "sim.started.cpu.design": 5, "sim.finished.cpu.design": 4,
                "sim.duration.1-10min": 4, "sim.cells.100k-1m": 4, "sim.failed.cpu.solver": 1,
                "monitor.far_field": 5, "feature.touchstone_export": 1 }
}
```

- Only whole previous days are sent: `day` is before today, never today.
- The oldest unsent day goes first. A user who opens the app on most days sends yesterday's
  counts. A backlog left by failed sends clears at one day per day.
- The shell records the attempt before posting, so a crash cannot turn one day into many POSTs.
- A 2xx answer marks the day as sent (`sent_through`) and removes it from the files.
- A network error, a 429 or a 5xx keeps the counters and tries again the next day.
- A 400, 413 or 422 (the server refused the content) marks the day as sent, so a malformed day
  cannot block the ones after it.
- `os` is `macos`, `windows` or `linux`; `arch` is `aarch64` or `x86_64`. `gpu_available` says
  whether the openEMS build the app started with has the GPU engine.

## Consent

The consent setting is unset until the user answers, and unset means no counting.

- **First-start dialog** (`src/components/UsageStatsPrompt.tsx`). It asks once: *Share usage
  statistics* or *No thanks*. It is shown only when the build switch is on, the environment does
  not disable telemetry and consent is unset. With the switch off it never appears.
- **General settings › Usage statistics** (`src/components/UsageStatsSettings.tsx`) offers:
  - an Off / On choice (Off by default);
  - **View what would be sent**, which shows the exact JSON of the next ping and of today's counts
    so far;
  - **Reset id**, which creates a new random install id and deletes the counts not sent yet;
  - **What is collected**, which opens the privacy page in the browser.
- **Turning it off** stops counting at once and deletes the counts not sent yet.

The wording follows KVKK and GDPR. It says that the data is anonymous counts with a random id,
lists what is sent and what is not, says where it goes (fairbeam.org, stored in a private
GitHub repository) and how to turn it off. The legal basis is consent (KVKK art. 5(1), GDPR
art. 6(1)(a)), which the user can withdraw at any time. The public list is
[landing/privacy.html](../landing/privacy.html), marked "not active yet".

## The receiving side

`api/ping.js` is a Vercel serverless function (Node runtime, web `Request`/`Response` handlers).
Vercel serves every file in `api/` at `/api/*` next to the static `site-dist/` output. Files that
start with `_` are not functions: `api/_ping-core.js` holds the logic and `api/_ping-schema.json`
the key list, and `vercel.json` `functions.includeFiles` bundles the schema with the function. The
function uses no npm packages, only `node:crypto` and `fetch`.

For each request, it:

1. **Refuses without configuration.** It answers 503 and does nothing unless `STATS_GITHUB_TOKEN`
   and `STATS_SALT` are set.
2. **Limits CORS to the app.** Requests without an `Origin` header (the shell's HTTP client) are
   accepted. A browser request is accepted only from the app's own origins (`tauri://localhost`,
   `http(s)://tauri.localhost`) and refused from any other.
3. **Validates strictly.** POST only, `Content-Type: application/json`, at most 8 KiB. Exactly the
   eight fields of the schema, a v4 UUID, a version like `0.4.4`, a known `os` and `arch`, and a
   real `day` between 31 days ago and tomorrow. At most 120 counters, only known keys, whole
   numbers from 0 to 10000. Anything else is refused with 400, 405, 413 or 415.
4. **Pseudonymises.** The install id is replaced by `HMAC-SHA256(STATS_SALT, install_id)`, cut to
   16 hex characters. The plain id is never stored. The salt stays on the server, so the stored
   hash cannot be traced back to an install id. The hash only counts unique installs per day and
   per week.
5. **Rate-limits.** It accepts at most 2 pings per hashed id per receiving day. A second ping for
   the same `day` from the same id is answered 200 `duplicate` and not stored.
6. **Stores.** It appends one line per ping to `data/<receiving day>.jsonl` in the private repo
   (`STATS_REPO`, default `ismailakdag/fairbeam-stats`), through the GitHub Contents API with the
   token. When two pings race, the SHA check fails (409/422) and it re-reads and retries, up to 5
   times. A file over 700 KB continues in `data/<day>-2.jsonl`, `-3` and so on, so every read stays
   under the API's 1 MB limit. One stored line:

   ```json
   {"day":"2026-09-27","id":"3f2a9c0d1e7b4a55","v":"0.4.4","os":"macos","arch":"aarch64","gpu":false,"c":{"app.start":2}}
   ```

   The IP address, the headers and the exact time are not stored. Vercel's own request logs keep
   the IP for a short time, as for any page of the site.

### Setup (by hand, when turning it on)

1. **Create the private repository** `ismailakdag/fairbeam-stats` (GitHub › New repository ›
   Private, with a README so `main` exists).
2. **Create a fine-grained token** (GitHub › Settings › Developer settings › Fine-grained tokens):
   - Resource owner: `ismailakdag`; Repository access: *Only select repositories* ›
     `fairbeam-stats`.
   - Permissions: *Contents: Read and write*, nothing else (Metadata: read is added
     automatically).
   - Expiration: the longest allowed. Put a reminder in the calendar to renew it.
3. **Create a salt**, for example with `openssl rand -hex 32`. Keep it secret. Changing it later
   makes every install look new.
4. **Set the environment variables in Vercel** (Project › Settings › Environment Variables,
   Production only):
   - `STATS_GITHUB_TOKEN` (the token)
   - `STATS_SALT` (the salt)
   - optional: `STATS_REPO` (default `ismailakdag/fairbeam-stats`) and `STATS_BRANCH` (default `main`)

   Redeploy. `curl -i -X POST https://fairbeam.org/api/ping -H 'content-type: application/json' -d '{}'`
   should now answer 400 (invalid ping) instead of 503.

## Summary script

`node scripts/stats-summary.mjs` prints:

- daily and weekly active installs (unique hashed ids per `day`, and per ISO week);
- OS, GPU and version shares;
- simulations per day with the CPU/GPU split, and failures by category;
- feature usage: monitors, sweeps, optimizer methods, import and export.

It reads the ping lines from a local clone (`--dir ../fairbeam-stats/data`) or, with `--gh`, from
the private repository through `gh api`. It removes duplicate lines for the same `(id, day)`.

The numbers that already exist without any telemetry come first, and `--releases-only` prints only
those. They are the download counts of every release asset of `ismailakdag/fairbeam-releases`,
including `latest.json`. The updater fetches `latest.json` on every update check, so its download
count is a rough proxy for launches with update checks turned on.

```bash
node scripts/stats-summary.mjs --releases-only          # works today
node scripts/stats-summary.mjs --dir ../fairbeam-stats/data
node scripts/stats-summary.mjs --gh --days 28
```

## Turning it on

1. Do [the receiving-side setup](#setup-by-hand-when-turning-it-on) and check the 400 answer.
2. Complete `landing/privacy.html`. KVKK and GDPR require the data controller and a contact for
   data-protection requests to be named. Also state how long the daily files are kept. Remove the
   page's "not active yet" note in the same release.
3. Build with the feature. Either add `default = ["telemetry"]` under `[features]` in
   `src-tauri/Cargo.toml`, or pass `--features telemetry` to `tauri build` in the release script.
4. Check a development build: the first-start dialog appears once, and Settings shows On/Off.
   "View what would be sent" shows the JSON. The day after you answer On, one POST reaches the
   repository.
5. After a week, run `node scripts/stats-summary.mjs --gh`.

To turn it off again, leave the feature out of the next build. The shell then ignores the old
files, and the endpoint can be disabled by removing `STATS_GITHUB_TOKEN`.

## Hard rules

- A ping contains nothing but the eight fields above. The counters hold only listed keys, and the
  values are whole numbers.
- A ping never contains file names, design contents, parameter names or values, model names,
  paths, error messages, email addresses, user names, host names or the IP address.
- The install id is a random v4 UUID created on the computer, not derived from the hardware. The
  user can reset it.
- Nothing is counted before consent is `granted`, and nothing is sent in a build without the
  feature.

Tests:

- `src-tauri/src/telemetry.rs`: counters, the day rollover, no forbidden fields, and no send with
  the switch off, without consent or with `FAIRBEAM_NO_TELEMETRY`.
- `python/tests/test_telemetry.py`: the job counts, the buckets and the categories, the key list
  against the schema, and no counts while off.
- `scripts/check-telemetry-api.mjs` (`npm run check:telemetry`): the function's validation with
  fake requests and a fake GitHub, without the network.
