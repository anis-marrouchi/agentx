// Branch protection for main (#989): a red CI build cannot be merged.
//
// Requires every job in .github/workflows/ci.yml as a status check, posted by
// GitHub Actions. Every PR here is opened and merged by one admin account, so:
//   - no required reviews: an author cannot approve their own PR (the review
//     requirement arrives later as a status check, #990);
//   - enforce_admins: without it the admin account skips every rule.
// Checks are not strict (a PR need not be up to date with main), and
// force-pushes and deletion of the branch are blocked.
//
// Applying or removing protection is a repository settings change: run it
// only with the owner's go. Needs `gh` signed in as a repo admin.
// Usage: node scripts/branch-protection.mjs [--repo owner/name] [--branch main]
//          [--dry-run]   print the request, change nothing
//          [--off]       remove the protection again (rollback)
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

/** The app that posts GitHub Actions check runs. Pinning it means a commit
 *  status that happens to be called `test` cannot stand in for the real job. */
export const GITHUB_ACTIONS_APP_ID = 15368
const CI_WORKFLOW = new URL('../.github/workflows/ci.yml', import.meta.url)

export function parseArgs(argv) {
  // A flag's value must be there and must not be the next flag: `--repo --off`
  // would otherwise aim at repo "--off" and also turn the rollback on.
  // `--repo=owner/name` is read the same as `--repo owner/name`.
  const value = (flag, fallback) => {
    const joined = argv.find((arg) => arg.startsWith(`${flag}=`))
    const next = joined !== undefined ? joined.slice(flag.length + 1) : argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback
    if (next === undefined || next === '' || next.startsWith('--')) throw new Error(`${flag} needs a value`)
    return next
  }
  return {
    repo: value('--repo', 'anis-marrouchi/agentx'),
    branch: value('--branch', 'main'),
    dryRun: argv.includes('--dry-run'),
    off: argv.includes('--off'),
  }
}

/** Check names a workflow posts: a job's `name:` when set, else its key.
 *  Matrix jobs post one check per combination, so they cannot be required by
 *  one fixed name and are refused rather than silently skipped. */
export function workflowChecks(source) {
  const jobs = parse(source)?.jobs ?? {}
  return Object.entries(jobs).map(([key, job]) => {
    if (job?.strategy?.matrix) throw new Error(`job "${key}" uses a matrix; list its check names by hand`)
    return job?.name ?? key
  })
}

/** The request for one run: PUT the rules, or DELETE them with --off. */
export function protectionRequest({ repo, branch, off }, checks) {
  const path = `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`
  if (off) return { method: 'DELETE', path }
  if (!checks.length) throw new Error('no checks to require')
  return {
    method: 'PUT',
    path,
    payload: {
      required_status_checks: { strict: false, checks: checks.map((context) => ({ context, app_id: GITHUB_ACTIONS_APP_ID })) },
      enforce_admins: true,
      required_pull_request_reviews: null,
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    },
  }
}

export function describeRequest(req) {
  const lines = [`${req.method} ${req.path}`]
  if (req.payload) lines.push(JSON.stringify(req.payload, null, 2))
  return lines.join('\n')
}

function ghApi(req) {
  const args = ['api', '--method', req.method, req.path, '-H', 'Accept: application/vnd.github+json']
  if (req.payload) args.push('--input', '-')
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)))
    if (req.payload) child.stdin.end(JSON.stringify(req.payload))
  })
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const checks = opts.off ? [] : workflowChecks(await readFile(CI_WORKFLOW, 'utf8'))
  const req = protectionRequest(opts, checks)
  console.log(describeRequest(req))
  if (opts.dryRun) return console.log('\nDry run: nothing was changed.')
  await ghApi(req)
  console.log(opts.off ? `\nProtection removed from ${opts.branch}.` : `\nProtection applied to ${opts.branch}: ${checks.join(', ')} required.`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((err) => {
    console.error(err.message)
    process.exitCode = 1
  })
}
