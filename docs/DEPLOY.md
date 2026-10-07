# Deploying fairbeam.org

The public site is static: a landing page at `/` and a read-only demo of the viewer at `/app/`.
Vercel builds the site from the public source repository, and only the build output is served at the domain.

`npm run build:site` builds the static site for fairbeam.org into `site-dist/`. It holds the landing page from `landing/` at `/` and the viewer in read-only demo mode (`npm run build:demo`, base `/app/`, the example projects in `public/projects/`, no run server) at `/app/`. The Vercel settings are in `vercel.json`.

## What the site serves

| On the site (in `site-dist/`) | Not on the site |
| --- | --- |
| `landing/` (the home page, `features.html`, `roadmap.html`, `privacy.html`, CSS and small scripts; the roadmap board is rendered into `roadmap.html` at build time), the scroll story under `/story/`, `tokens.css` copied from `design-system/` | Python package, models, install scripts, tests |
| The docs under `/docs/`: the Markdown files listed in `landing/docs.json`, rendered at build time by `scripts/docs-render.mjs` (links between them go to their pages, other repository files to GitHub), with an overview page | The other Markdown files of the repository (they stay on GitHub) |
| The viewer built with `--mode demo` under `/app/` (minified JS/CSS) | `src/` as source code (only the minified bundle ships) |
| The 20 example projects in `public/projects/` (bundle JSON, listed in `index.json`) | The local run server; the demo never calls `/api` |
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
framing stays allowed, so a site page can embed the demo. The cache rules are:

- `/app/assets/*` and `/fonts/*`: one year, immutable. App assets have hashed names, and the font files are fixed.
- `/media/*`: one day.
- `/app/projects/*`: one hour.

`/app` redirects to `/app/` and `/docs` to `/docs/`. `/guide.html`, the address the app's Help ›
Getting Started Guide opens, redirects to `/docs/getting-started.html` (and `landing/guide.html` does
the same with a meta refresh where the redirect rules do not apply, as in a local preview). Pushes to
branches other than `main` do not deploy (`git.deploymentEnabled` in `vercel.json`).

The site also has one serverless function, `api/ping.js`, which receives the desktop app's opt-in
install counts (see [TELEMETRY.md](TELEMETRY.md)). Vercel deploys every file in `api/` whose name does
not start with `_`. `vercel.json` `functions` bundles `api/_ping-schema.json` with the function. The
function stays disabled until a Redis database is connected (see [Usage counts](#usage-counts-redis)):
without the `KV_REST_API_URL` and `KV_REST_API_TOKEN` environment variables it
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

## Usage counts (Redis)

One-time setup in the Vercel dashboard. Nobody types or copies a token: the integration adds the
environment variables to the project itself.

1. Open the project in the Vercel dashboard and go to the *Storage* tab (or *Marketplace*).
2. Choose *Create Database* (or *Add Integration*), pick **Upstash** and then **Redis**, and accept the free plan. Give it a name such as `fairbeam-counts` and pick a region.
3. Connect it to the Fairbeam project for the *Production* environment (previews do not need it). Leave the environment variable prefix at its default, `KV`.
4. Redeploy production once (*Deployments* → the latest one → *Redeploy*), because environment variables only reach new deployments.
5. Check that it is connected: `curl -i -X POST https://fairbeam.org/api/ping -H 'content-type: application/json' -d '{}'`. The answer `400 invalid ping` means the database is connected; `503` means it is not. The request stores nothing.

The free plan is enough for a few thousand installs a week (check the current limits on the plan page). To read the counts, either open the database's data browser from the Vercel dashboard and look at the hash `fairbeam:{counts}:aggregates`, or run `vercel env pull` and then `node scripts/stats-summary.mjs --redis --no-releases`. To switch counting off on the server, disconnect the database from the project (the API answers 503 again) or delete it.

## Domains

| Domain | Role |
| --- | --- |
| `fairbeam.org` | Primary. Everything is served here: the site, the demo at `/app/`, and the usage endpoint `/api/ping`. The app's links and its telemetry endpoint point here. |
| `www.fairbeam.org` | Redirects to the apex (set it in *Settings → Domains*, "Redirect to fairbeam.org"). |

Both domains are attached to the same Vercel project, `fairbeam`. GitHub's Deployments list shows
that project's per-deployment `*.vercel.app` URLs; the repository's homepage is `https://fairbeam.org`.

## Updating the demo content

The demo ships exactly what is committed in `public/projects/` (bundles and `index.json`) and the SVGs
listed in `scripts/build-site.mjs` (`MEDIA`). To show another project, run it locally, commit its
bundle and the updated `index.json`, then redeploy. To change the site pages, edit `landing/`; `npm run build:site` also checks their size budgets
(the home page HTML and images, every page's HTML, and `media/`).
Colors and spacing come from `design-system/tokens.css`, which is copied in at build time; do not
duplicate token values in `landing/styles.css`.
