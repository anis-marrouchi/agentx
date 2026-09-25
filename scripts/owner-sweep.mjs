// Owner sweep (#53): give every open issue and PR an owner and a next step.
//
// Reads open issues/PRs with `gh`, decides who owns the next step from the
// table in issue #53, and prints only steps that are new (or still true after
// `remindHours`). Always exits 0; the first stdout line is the verdict:
//   RESULT steps=<n> [applied=<m>]  followed by one line per step
//   RESULT error=collection         when gh failed (state is left untouched)
//
// Without --assignee it never writes to GitHub: the workflow's agent acts on
// every step. With --assignee (Anis's choice on #53: agents share one GitHub
// login, so the login is assigned and an `agent:<id>` label names the owner),
// ownership needs no judgment and the script applies it itself:
//   - an item with no assignee or no agent label gets both: an issue its
//     marker agent or --owner, a PR its author agent;
//   - a PR with no review yet gets `review:<reviewer>` and a review step for
//     --reviewer (one login cannot request its own review on GitHub).
// Only the steps that need judgment are left for agents.
//
// Usage: node scripts/owner-sweep.mjs --repo owner/name --state path.json
//          [--agent coder-agent] [--coordinator secretary-agent]
//          [--assignee login --owner coder-agent --reviewer devops-agent]
//          [--stale-minutes 30] [--max-ci-retries 2] [--remind-hours 24]
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER_RE = /<!--\s*agentx:([a-z0-9_-]+)\s*-->/i
const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

/** Collapse a statusCheckRollup into none | pending | failing | passing. */
export function ciState(rollup = []) {
  if (rollup.length === 0) return { state: 'none', failing: [] }
  const failing = rollup.filter((c) => FAILED.has(c.conclusion ?? c.state))
  if (failing.length) {
    return { state: 'failing', failing: failing.map((c) => ({ name: c.name ?? c.context, url: c.detailsUrl ?? c.targetUrl })) }
  }
  const pending = rollup.some((c) => (c.__typename === 'StatusContext' ? c.state === 'PENDING' : c.status !== 'COMPLETED'))
  return { state: pending ? 'pending' : 'passing', failing: [] }
}

const agentLabel = (item) => item.labels?.find((l) => /^agent:/i.test(l.name ?? ''))
const reviewLabel = (item) => item.labels?.find((l) => /^review:/i.test(l.name ?? ''))

/** Decide the next steps. Pure: returns new steps, the edits to apply
 *  (only with opts.assignee) and the next state. */
export function planSweep({ issues, prs }, state = {}, now = new Date(), opts = {}) {
  const o = { agent: 'coder-agent', coordinator: 'secretary-agent', owner: 'coder-agent', reviewer: 'devops-agent', assignee: null, staleMinutes: 30, maxCiRetries: 2, remindHours: 24, ...opts }
  const seen = { ...(state.seen ?? {}) }
  const ciFixes = { ...(state.ciFixes ?? {}) }
  const steps = []
  const apply = []
  const open = new Set()
  const age = (iso) => (now.getTime() - new Date(iso).getTime()) / 60000

  const propose = (item, owner, step, why, key) => {
    const at = seen[key]
    if (at && age(at) < o.remindHours * 60) return
    seen[key] = now.toISOString()
    steps.push({ kind: item.kind, number: item.number, title: item.title, url: item.url, owner, step, why })
  }

  // Assign the login and label the owning agent, whichever is missing.
  const own = (item, agent) => {
    const edit = { kind: item.kind, number: item.number, labels: [] }
    if (!item.assignees?.length) edit.assignee = o.assignee
    if (!agentLabel(item)) edit.labels.push(`agent:${agent}`)
    if (edit.assignee || edit.labels.length) apply.push(edit)
  }

  for (const issue of issues) {
    const item = { ...issue, kind: 'issue' }
    open.add(`issue#${issue.number}`)
    if (o.assignee) own(item, issue.body?.match(MARKER_RE)?.[1] ?? o.owner)
    else if (!issue.assignees?.length) propose(item, o.coordinator, 'assign-owner', 'no assignee', `issue#${issue.number}:assign`)
    const doing = issue.labels?.some((l) => l.name?.toLowerCase() === 'doing')
    if (doing && age(issue.updatedAt) > o.staleMinutes) {
      propose(item, o.coordinator, 'nudge', `in progress, no activity for ${Math.round(age(issue.updatedAt))} min`, `issue#${issue.number}:stale:${issue.updatedAt}`)
    }
  }

  for (const pr of prs) {
    const item = { ...pr, kind: 'pr' }
    const n = pr.number
    open.add(`pr#${n}`)
    const author = pr.body?.match(MARKER_RE)?.[1] ?? o.agent
    const ci = ciState(pr.statusCheckRollup)
    const sha = pr.headRefOid

    const unreviewed = !pr.reviewRequests?.length && !pr.latestReviews?.length && !reviewLabel(pr)
    if (o.assignee) {
      own(item, author)
      if (unreviewed) {
        apply.push({ kind: 'pr', number: n, labels: [`review:${o.reviewer}`] })
        propose(item, o.reviewer, 'review', `new PR by ${author}: review it, Anis gives the final approval`, `pr#${n}:review`)
      }
    } else {
      if (!pr.assignees?.length) propose(item, o.coordinator, 'assign-owner', 'no assignee', `pr#${n}:assign`)
      if (unreviewed) propose(item, o.coordinator, 'request-review', 'no reviewer yet: agent review first, then Anis', `pr#${n}:review`)
    }
    if (!pr.closingIssuesReferences?.length) propose(item, o.coordinator, 'link-issue', 'no linked issue', `pr#${n}:link`)

    if (ci.state === 'failing') {
      const tried = ciFixes[n] ?? []
      const checks = ci.failing.map((c) => `${c.name} ${c.url ?? ''}`.trim()).join('; ')
      if (!tried.includes(sha) && tried.length >= o.maxCiRetries) {
        propose(item, o.coordinator, 'escalate-ci', `CI still red after ${tried.length} fix attempts: ${checks}`, `pr#${n}:ci:${sha}`)
      } else {
        if (!tried.includes(sha)) ciFixes[n] = [...tried, sha]
        const attempt = (ciFixes[n] ?? tried).indexOf(sha) + 1
        propose(item, author, 'fix-ci', `CI red on ${sha?.slice(0, 7)} (attempt ${attempt}/${o.maxCiRetries}), branch ${pr.headRefName}: ${checks}`, `pr#${n}:ci:${sha}`)
      }
    } else if (ci.state === 'passing' && pr.isDraft) {
      propose(item, author, 'mark-ready', `CI green on ${sha?.slice(0, 7)}, still draft`, `pr#${n}:ready:${sha}`)
    } else if (ci.state === 'passing') {
      propose(item, o.coordinator, 'review-and-merge', `ready and green on ${sha?.slice(0, 7)}`, `pr#${n}:merge:${sha}`)
    }

    const waitingOnHuman = ci.state === 'passing' && !pr.isDraft
    if (ci.state !== 'pending' && !waitingOnHuman && age(pr.updatedAt) > o.staleMinutes) {
      propose(item, o.coordinator, 'nudge', `no activity for ${Math.round(age(pr.updatedAt))} min`, `pr#${n}:stale:${pr.updatedAt}`)
    }
  }

  // Forget closed items so a reopen starts fresh.
  for (const key of Object.keys(seen)) if (!open.has(key.split(':')[0])) delete seen[key]
  for (const n of Object.keys(ciFixes)) if (!open.has(`pr#${n}`)) delete ciFixes[n]
  return { steps, apply, state: { seen, ciFixes } }
}

/** `applied` is what the script already did; it is listed after the steps
 *  so the agent knows, and never counted as work for it. */
export function formatSteps(steps, applied = []) {
  const lines = steps.map((s) => `- ${s.owner} ${s.step} ${s.kind} #${s.number} "${s.title}": ${s.why} ${s.url}`)
  const done = applied.map((a) => `  applied ${a.kind} #${a.number}: ${a.result}`)
  return [`RESULT steps=${steps.length}${applied.length ? ` applied=${applied.length}` : ''}`, ...lines, ...done].join('\n')
}

/** Apply ownership edits with `gh`. Each edit reports its own result, so one
 *  failure (a deleted issue, a missing permission) never hides the rest. */
export async function applyEdits(repo, edits, run = ghRun) {
  const labels = [...new Set(edits.flatMap((e) => e.labels))]
  for (const name of labels) {
    await run(['label', 'create', name, '-R', repo, '--color', name.startsWith('review:') ? 'FBCA04' : '5319E7', '--force']).catch(() => {})
  }
  const results = []
  for (const e of edits) {
    const args = [e.kind === 'pr' ? 'pr' : 'issue', 'edit', String(e.number), '-R', repo]
    if (e.assignee) args.push('--add-assignee', e.assignee)
    for (const l of e.labels) args.push('--add-label', l)
    const what = [e.assignee && `assigned ${e.assignee}`, ...e.labels.map((l) => `labelled ${l}`)].filter(Boolean).join(', ')
    try {
      await run(args)
      results.push({ ...e, result: what })
    } catch (error) {
      results.push({ ...e, result: `failed to apply (${error.code ?? 'unknown'}): ${what}` })
    }
  }
  return results
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1]
  return args
}

async function ghRun(args) {
  const { stdout } = await promisify(execFile)('gh', args, { timeout: 45000, maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

async function gh(args) {
  return JSON.parse(await ghRun(args))
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  if (!a.repo || !a.state) {
    console.log('RESULT error=usage (need --repo and --state)')
    return
  }
  let snapshot
  try {
    const [issues, prs] = await Promise.all([
      gh(['issue', 'list', '-R', a.repo, '--state', 'open', '--limit', '100', '--json', 'number,title,url,body,assignees,labels,updatedAt']),
      gh(['pr', 'list', '-R', a.repo, '--state', 'open', '--limit', '100', '--json',
        'number,title,url,body,isDraft,headRefName,headRefOid,assignees,labels,reviewRequests,latestReviews,closingIssuesReferences,statusCheckRollup,updatedAt']),
    ])
    snapshot = { issues, prs }
  } catch (error) {
    // Do not echo stderr: auth errors can carry local details.
    console.log(`RESULT error=collection (${error.code ?? 'unknown'})`)
    return
  }
  const prev = JSON.parse(await readFile(a.state, 'utf8').catch(() => '{}'))
  const opts = {}
  if (a.agent) opts.agent = a.agent
  if (a.coordinator) opts.coordinator = a.coordinator
  for (const k of ['assignee', 'owner', 'reviewer']) if (a[k]) opts[k] = a[k]
  for (const [flag, key] of [['stale-minutes', 'staleMinutes'], ['max-ci-retries', 'maxCiRetries'], ['remind-hours', 'remindHours']]) {
    if (a[flag] !== undefined) opts[key] = Number(a[flag])
  }
  const { steps, apply, state } = planSweep(snapshot, prev, new Date(), opts)
  const applied = apply.length ? await applyEdits(a.repo, apply) : []
  await mkdir(dirname(a.state), { recursive: true })
  await writeFile(`${a.state}.tmp`, JSON.stringify(state, null, 2))
  await rename(`${a.state}.tmp`, a.state)
  console.log(formatSteps(steps, applied))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
