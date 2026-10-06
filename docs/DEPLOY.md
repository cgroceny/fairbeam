# Deploying fairbeam.org

The public site is static: a landing page at `/` and a read-only demo of the viewer at `/app/`.
Vercel builds the site from the public source repository, and only the build output is served at the domain.

`npm run build:site` builds the static site for fairbeam.org into `site-dist/`. It holds the landing page from `landing/` at `/` and the viewer in read-only demo mode (`npm run build:demo`, base `/app/`, the example projects in `public/projects/`, no run server) at `/app/`. The Vercel settings are in `vercel.json`.

## What is public and what is not

| Public (in `site-dist/`) | Not public |
| --- | --- |
| `landing/` (landing page, `guide.html`, `privacy.html`, CSS, a small script; the roadmap board is rendered into the page at build time), the scroll story under `/story/`, `tokens.css` copied from `design-system/` | Python package, models, install scripts, tests |
| The viewer built with `--mode demo` under `/app/` (minified JS/CSS) | `src/` as source code (only the minified bundle ships) |
| The 14 example projects in `public/projects/` (bundle JSON, listed in `index.json`) | The local run server; the demo never calls `/api` |
| Four example SVGs from `examples/drawings/`, IBM Plex woff2 files (OFL) | `.sim/`, raw openEMS output, anything git-ignored |

The demo build (`VITE_FAIRBEAM_DEMO=1`, set in `.env.demo`) replaces the Run button with a
"Read-only demo" note that links to `/#download`, and never probes the run server. Everything else
works offline in the browser: the 3D view, charts, drawings (SVG, PDF, PNG), figures, the VBA macro and
the export package.

## Build settings

`vercel.json` sits at the repository root and holds all of the settings:

| Setting | Value |
| --- | --- |
| Framework preset | Other (`framework: null`) |
| Root directory | repository root |
| Install command | `npm ci` |
| Build command | `npm run build:site` (type-check, then `scripts/build-site.mjs`) |
| Output directory | `site-dist` |
| Node.js | 20 or newer (22 LTS is fine) |

It also sets these headers on every path: `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN`,
`Content-Security-Policy: frame-ancestors 'self'` and a restrictive `Permissions-Policy`. Same-origin
framing stays allowed so the landing page can embed the demo on request. The cache rules are:

- `/app/assets/*` and `/fonts/*`: one year, immutable. App assets have hashed names, and the font files are fixed.
- `/media/*`: one day.
- `/app/projects/*`: one hour.

`/app` redirects to `/app/`. Pushes to branches named `windows/*`, `codex-windows/*`, `mac/*`,
`codex-mac/*`, `codex/*` or `claude/*` do not deploy (`git.deploymentEnabled` in `vercel.json`).

The site also has one serverless function, `api/ping.js`, which receives the desktop app's usage
statistics (see [TELEMETRY.md](TELEMETRY.md)). Vercel deploys every file in `api/` whose name does
not start with `_`. `vercel.json` `functions` bundles `api/_ping-schema.json` with the function. The
function is disabled: without the `STATS_GITHUB_TOKEN` and `STATS_SALT` environment variables it
answers 503 and does nothing. The static build ignores `api/`.

## Check locally before deploying

```bash
npm ci
npm run build:site                          # writes site-dist/
python3 -m http.server -d site-dist 5331    # then open http://127.0.0.1:5331/ and /app/
```

The Python server does not apply the `vercel.json` headers, so the iframe and the cache rules can only
be checked on the Vercel preview URL.

## First-time setup

Done by hand, once. The site is served at fairbeam.org (see [Domains](#domains)), so this list is only for a new Vercel
project or another domain.

1. **Log in.** In a browser, log in to vercel.com. For the CLI route, run `npm i -g vercel` and then `vercel login`.
2. **Create the project from the repository.**
   - Dashboard route: *Add New → Project → Import Git Repository*. Grant the Vercel GitHub app access to `ismailakdag/fairbeam` only, then import it.
   - Keep the root directory at the repository root. Vercel reads `vercel.json`, so leave the build settings as detected: framework *Other*, install `npm ci`, build `npm run build:site`, output `site-dist`.
   - CLI route instead: run `vercel link` in the repository, then `vercel` for a preview deploy.
3. **Check the preview URL.** On the Vercel preview:
   - The landing page loads, and "Open the demo" opens `/app/` with the 14 projects.
   - "Load the demo in this page" shows the viewer inside the iframe (this checks `SAMEORIGIN`).
   - The response headers are present: `curl -I https://<preview>/app/`.
4. **Promote to production.** Promote the preview in the dashboard, or run `vercel --prod`.
5. **Add the domain.** In the project, go to *Settings → Domains → Add* and enter `fairbeam.org` (see [Domains](#domains)).
6. **Add the DNS record.** Vercel shows the record to create at the DNS provider for the domain (an `A` record
   for the apex, or a `CNAME` for a subdomain, pointing at `cname.vercel-dns.com.`). Use whatever value the dashboard shows. If the zone
   already uses Vercel nameservers, Vercel adds the record itself.
   The TLS certificate is issued automatically once DNS resolves.
7. **Automatic deploys.** Pushes to `main` then redeploy automatically. To publish only by hand, turn
   off automatic deploys under *Settings → Git*.

## Domains

| Domain | Role |
| --- | --- |
| `fairbeam.org` | Primary. Everything is served here: the site, the demo at `/app/`, and the usage endpoint `/api/ping`. The app's links and its telemetry endpoint point here. |
| `www.fairbeam.org` | Redirects to the apex (set it in *Settings → Domains*, "Redirect to fairbeam.org"). |
| `antenlab.akdag.dev` | Kept for installed old apps, which call `https://antenlab.akdag.dev/api/ping` and open its guide and privacy pages. Pages redirect permanently to the same path on `fairbeam.org` (a host-based rule in `vercel.json`); `/api/*` is not redirected and keeps working. |

All three domains are attached to the same Vercel project, `fairbeam` (renamed on 2026-10-06; the project
id and its settings are unchanged). GitHub's Deployments list shows that project's per-deployment
`*.vercel.app` URLs; the repository's homepage is `https://fairbeam.org`. The ping function does not check the host
(only the browser origin, see `api/_ping-core.js`), so no code change is needed to accept both.
`npm run check:telemetry` asserts both that the old host's pings are stored and that the redirect rule
never matches `/api`. Keep the old domain for as long as old apps are installed.

## Updating the demo content

The demo ships exactly what is committed in `public/projects/` (bundles and `index.json`) and the SVGs
listed in `scripts/build-site.mjs` (`MEDIA`). To show another project, run it locally, commit its
bundle and the updated `index.json`, then redeploy. To change the landing page, edit `landing/`.
Colors and spacing come from `design-system/tokens.css`, which is copied in at build time; do not
duplicate token values in `landing/styles.css`.
