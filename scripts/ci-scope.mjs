// Conservative CI planning. Unknown files or missing evidence run the full checks.
import {execFileSync} from 'node:child_process';
import {appendFileSync, readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export function classify(files) {
  const docsOnly = files.length > 0 && files.every(file =>
    /^(docs\/|landing\/|landing-src\/|examples\/drawings\/|examples\/reports\/)/.test(file) ||
    /^(README(?:\.[a-z]+)?\.md|CONTRIBUTING\.md|AI_POLICY\.md|LICENSE|CITATION\.cff)$/.test(file));
  const full = !docsOnly;
  // UI/TS edits can affect the Python geometry contract; keep native qualification for code.
  return {full, native: full};
}

// Drafts are an editing stage, not a qualification receipt. Changes to the CI policy
// itself must exercise the complete pipeline even when the PR is still a draft.
export function planPullRequest(files, draft) {
  const scope = classify(files);
  const policy = files.some(file => file.startsWith('.github/') ||
    /^scripts\/(?:ci-|check-ci-)/.test(file));
  const deferred = draft === true && scope.full && !policy;
  return {full: scope.full && !deferred, native: scope.native && !deferred,
    docs: !scope.full, deferred, reuse: false};
}

// A green lightweight draft run is deliberately insufficient. Read actual job
// conclusions; both the native/browser runner and web checks must have succeeded.
export async function hasFullQualification(sha, repository, token, request = fetch) {
  if (!token) return false;
  const get = async path => {
    const response = await request(`https://api.github.com/repos/${repository}/${path}`, {
      headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json'},
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('CI evidence request failed');
    return await response.json();
  };
  try {
    for (const event of ['pull_request', 'workflow_dispatch']) {
      const data = await get(`actions/workflows/ci.yml/runs?event=${event}&status=success&head_sha=${sha}&per_page=100`);
      for (const run of data.workflow_runs ?? []) {
        if (run.head_sha !== sha || run.event !== event || run.conclusion !== 'success') continue;
        const data = await get(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
        if (!Array.isArray(data.jobs) || data.total_count > 100) continue;
        if (['plan', 'web', 'windows', 'gate'].every(name => {
          const jobs = data.jobs.filter(job => job.name === name);
          return jobs.length === 1 && jobs[0].status === 'completed' && jobs[0].conclusion === 'success';
        })) return true;
      }
    }
  } catch { /* Missing or ambiguous evidence must run the checks, never skip them. */ }
  return false;
}

export async function verifiedMergeReuse(head, git, hasSuccessfulPrRun) {
  const parents = git(['rev-list', '--parents', '-n', '1', head]).trim().split(/\s+/);
  if (parents.length !== 3) return false;
  const tested = parents[2];
  if (git(['rev-parse', `${head}^{tree}`]).trim() !== git(['rev-parse', `${tested}^{tree}`]).trim()) return false;
  return await hasSuccessfulPrRun(tested);
}

async function run() {
  const git = args => execFileSync('git', args, {encoding:'utf8', maxBuffer:16*1024*1024});
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const kind = process.env.GITHUB_EVENT_NAME;
  let result = {full:true, native:true, docs:false, deferred:false, reuse:false, reason:'Manual or unknown event: full qualification'};
  try {
    if (kind === 'pull_request') {
      const base = git(['merge-base', event.pull_request.base.sha, event.pull_request.head.sha]).trim();
      const files = git(['diff', '--name-only', '-z', base, event.pull_request.head.sha, '--']).split('\0').filter(Boolean);
      result = {...planPullRequest(files, event.pull_request.draft), reason:`Pull request: ${files.length} changed paths`};
      if (result.deferred) result.reason += '; draft editing checks only, full qualification deferred until ready or manual dispatch';
    } else if (kind === 'push') {
      const reuse = await verifiedMergeReuse(process.env.GITHUB_SHA, git, sha =>
        hasFullQualification(sha, process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN));
      if (reuse) result = {full:false, native:false, reuse:true, reason:'Merge tree exactly matches a successful PR CI head'};
      else {
        // A documentation-only push should not become a native run merely because
        // its PR was merged before the documentation checks finished.
        const files = git(['diff', '--name-only', '-z', event.before, process.env.GITHUB_SHA, '--']).split('\0').filter(Boolean);
        const scope = classify(files);
        result = {...scope, docs: !scope.full, deferred:false, reuse:false,
          reason: scope.full ? 'No identical fully qualified PR/dispatch tree: full qualification' : 'Documentation-only push: web/site qualification'};
      }
    }
  } catch {
    result = {full:true, native:true, docs:false, deferred:false, reuse:false, reason:'Planning evidence unavailable: full qualification'};
  }
  for (const key of ['full','native','reuse','docs','deferred']) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${result[key] === true}\n`);
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### CI plan\n${result.reason}\n\nFull browser/web: ${result.full}; native Python/smoke: ${result.native}; reused checks: ${result.reuse}; deferred draft: ${result.deferred === true}.\n${result.deferred ? '\nThis green draft run is NOT full merge/release qualification. Mark the PR ready or dispatch ci on this branch, wait for success, then merge the frozen SHA.\n' : ''}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
