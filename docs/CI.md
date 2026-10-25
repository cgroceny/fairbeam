# CI and website publishing

PRs remain the qualification point. Application changes run the web checks and full EN/TR
Windows browser suite, Python suite and one real coarse openEMS smoke. Native, dependency,
script and unknown-path changes use the same full qualification. Documentation/site-only PRs run
web/documentation/site checks without starting a Windows runner. Manual CI runs always use
the full suite. The web checks finish before Windows starts, so a manifest or static-check
failure does not consume a native runner at the same time.

After a normal merge, the planner compares the final merge tree with the PR head tree and
checks GitHub for a successful `ci.yml` PR run at that exact head. Only when both match are
the duplicate jobs skipped. A direct push, changed merge tree, missing token, API failure,
or missing successful run falls back to full qualification. A summary records the decision;
the final `gate` job fails when any required job fails or is cancelled.

The openEMS download archive is cached by OS/architecture, Python ABI and upstream tag;
installation still runs each time. npm uses its download cache, never shared node_modules.
Failure artifacts and smoke bundles are retained for seven days.

## Publish the website once per reviewed batch

Finish a focused change locally before pushing it for review. Run the required checks and
the checks covering the changed behavior against the final commit, and retain their logs,
source SHA and limitations. Do not push intermediate fixes just to discover failures on hosted
CI. When a hosted check fails, inspect its saved evidence and reproduce or diagnose the failure
locally before another push or an explicitly justified rerun. This does not waive required
checks, reuse results from a different source tree, or combine unrelated changes into one PR.

Git-triggered Vercel deployments are disabled in `vercel.json`. The existing live site stays
online; merging application/backend work no longer creates a deployment. Vercel's ignored
build command is deliberately not used: skipped builds still count toward deployment quotas.

From a clean, reviewed `main` checkout after a successful CI run (or a verified reused gate):

```powershell
git pull --ff-only origin main
vercel link --project fairbeam --scope ismailakdags-projects
vercel pull --yes --environment=production --scope ismailakdags-projects
vercel build --prod --scope ismailakdags-projects
# Windows CLI 59.16 packaging workaround (see below):
Copy-Item api/_ping-schema.json .vercel/output/functions/api/ping.func/api/_ping-schema.json
vercel deploy --prebuilt --prod --skip-domain --scope ismailakdags-projects
```

Use Node 24 LTS with its matching npm. `vercel build` runs the configured `npm ci`
and site checks locally, then packages the static site **and** `api/ping` into
`.vercel/output`. `--prebuilt` uploads that output without a remote build. A deployment
still counts as a deployment; serving pages and API requests still uses the hosting plan.
Application-only changes do not need a site deployment. Batch site changes before publishing.

On Windows, Vercel CLI 59.16 can lose the command search path when its child environment
contains both `Path` and `PATH` (`spawn cmd.exe ENOENT`). Normalize the key in the current
PowerShell session before `vercel build`; this does not change the machine's saved environment:

```powershell
$buildPath = $env:Path
Remove-Item Env:Path
$env:PATH = $buildPath
```

Check `node --version` and `npm version` first. Both must use the intended Node installation;
an older npm launcher can select a different Node executable even when `node` is current.
Do not share `node_modules` between checkouts. Keep `.vercel/` and downloaded environment
files ignored. Production secrets that `vercel pull` reports as `[SENSITIVE]` remain managed
on Vercel; never replace production secret values with those placeholders. The static site
does not require the install-count Redis credentials at build time.

Windows CLI 59.16 also declared the ping schema in `filePathMap` but omitted the file from
the local function output in our check. Copy the repository's exact `api/_ping-schema.json`
into the generated function as shown above; the `api/` directory must already exist after
a successful build. Verify its SHA-256 matches the source and that importing the packaged
`api/ping.js` succeeds before uploading. Do not copy production environment files into the
function. The packaged GET handler must return 405; with no Redis credentials, POST must
return 503 without sending or recording a count. Remote runtime credentials are supplied
by the Vercel project, not embedded in this local package.

Inspect the returned deployment URL and its pages, then promote that **production** deployment:

```powershell
vercel inspect <deployment-url> --scope ismailakdags-projects
vercel promote <deployment-url> --scope ismailakdags-projects
```

Use the existing local Vercel login; never put a token in a command or commit credentials.
One local build, one staged production upload, and promotion avoid remote build work and a second
deployment. Do not promote a
preview build as though it were the tested production artifact. This publishes the site/demo,
not a desktop installer or updater release. Re-enable Git deployment explicitly if the team
later chooses automatic publishing again.

Before pushing, run `node scripts/check-ci-scope.mjs`. Workflow changes still require a full
remote qualification once; a green path-classification test alone is not enough.

## Deployment storage maintenance

Deployment Storage measures retained deployment output. Reducing build minutes or using
`--prebuilt` does not by itself remove stored output. GitHub Actions artifacts, Vercel build
caches and deployment output have separate retention controls. See Vercel's
[storage overview](https://vercel.com/docs/deployment-storage) and
[optimization guide](https://vercel.com/docs/deployment-storage/optimize).

Use this procedure when a storage warning arrives and before a website publication batch.
Do not deploy a new copy merely to investigate a quota warning.

1. **Record the baseline.** Confirm the team and project. In the team's Usage view, record
   the Deployment Storage and Functions Storage totals, date range and per-project breakdown.
   Start with the largest contributor; a team-wide warning does not prove Fairbeam caused it.
   Record the project's current retention settings, live deployment ID, domain aliases and
   known-good rollback IDs. An access error is an incomplete audit, not an empty inventory.
2. **Review retention for this project only.** Fairbeam's Hobby policy is seven days for
   canceled/errored builds, fourteen days for pre-production and thirty days for production.
   These values were applied and read back on October 25, 2026. Hobby does not offer the
   previously proposed ninety-day production window. Confirm the offered durations,
   incident-history needs and protected deployments
   before applying it. Keep the live deployment and at least two verified production rollback
   candidates, plus deployments still needed for an open PR or release investigation. If the
   available policy cannot preserve that set, retain the longer period and review candidates
   individually. Do not apply a team-wide policy to unrelated projects.
3. **Prepare a cleanup manifest.** For each candidate, save its project, deployment ID, URL,
   commit, state, creation time, aliases and reason it is no longer needed. Recheck aliases and
   active review links immediately before deletion. Prefer the platform's retention policy;
   do not run an age-only bulk-delete script. Missing evidence or unresolved ownership keeps
   the deployment out of the deletion list. Close PRs only after their work is resolved, not
   to make their previews eligible for cleanup.
4. **Review local output before the next upload.** Inspect `site-dist/` and the complete
   `.vercel/output/`, including function bundles. Keep installers, solver outputs, raw research
   data, logs and environment files out of the website artifact. Preserve required demo files
   and the ping schema. Compare output size and the largest files with the previous reviewed
   batch; investigate unexpected growth before publishing. Local file bytes are a useful
   comparison, not Vercel's billed storage measurement.
5. **Verify the result.** Save the applied policy or exact deleted IDs and timestamps. Verify
   that the live domain and retained rollback deployments still work. Compare Usage again
   after it refreshes, using the same team, project and date range. Record measured reduction;
   do not claim space was freed just because a deletion request succeeded. If usage stays high,
   inspect remaining aliases, retained previews and large output before changing the plan.

Recheck the live policy before each maintenance batch; the dated values above do not prove
that a future project still has the same settings. Vercel's
[retention rules](https://vercel.com/docs/deployment-retention) include protected recent
deployments and aliases; deletion and storage accounting are asynchronous. Hobby's protected
deployment counts can differ from paid plans, so do not assume an old default count still
describes the platform's complete protection rules. Preserve the reviewed rollback set explicitly.
Retain investigation evidence separately before cleanup. Production website publication and
promotion still follow the release owner's responsibilities in [RELEASES.md](RELEASES.md).

Use this read-only PowerShell inventory after a local build. It does not upload, delete or
read file contents, and does not replace the live Usage audit:

```powershell
foreach ($outputPath in @('site-dist', '.vercel/output')) {
  if (-not (Test-Path -LiteralPath $outputPath -PathType Container)) {
    Write-Output "$outputPath : not built"
    continue
  }
  $outputFiles = @(Get-ChildItem -LiteralPath $outputPath -File -Recurse -Force)
  $outputBytes = ($outputFiles | Measure-Object -Property Length -Sum).Sum
  [pscustomobject]@{
    Output = $outputPath
    Files = $outputFiles.Count
    Bytes = $outputBytes
    Largest = @($outputFiles | Sort-Object Length -Descending |
      Select-Object -First 20 FullName, Length)
  } | ConvertTo-Json -Depth 4
}
```

Each batch receipt records source SHA, local checks, output bytes, usage baseline, protected
deployment IDs, cleanup actions (or an explicit skip), the single uploaded deployment ID,
smoke-check results and any promotion. Never store tokens or downloaded environment files in
that receipt. A build or smoke failure stops the batch; it does not trigger automatic redeploys.
