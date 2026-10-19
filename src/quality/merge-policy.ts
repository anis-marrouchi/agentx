import type { z } from "zod"
import type { mergePolicyConfigSchema } from "@/daemon/config"
import { detectAgentxMarker } from "@/channels/outbound-marker"
import { matchesPath, statusText } from "./review-gate"

// --- Merge policy: core paths need a person, edge paths auto-merge (#1047) ---
//
// Agents may merge only changes at the edges. The owner lists core paths
// (and, optionally, edge paths) in quality.mergePolicy. Every pull request
// is sorted by the files it changes:
//
//   - edge only: the status `agentx/merge-policy` is success at once, so
//     auto-merge on green CI works as before. Full CI still runs; this
//     status is one more check, never a replacement for the others.
//   - touches a core path: the PR gets the core label, and on an agent's PR
//     the status stays pending until a person approves the head commit.
//
// The status blocks a merge only once it is a required check in the
// branch rules on GitHub. It belongs to one commit: a push asks for a new
// approval, so an approval never covers code the person did not see.

export type MergePolicyConfig = z.infer<typeof mergePolicyConfigSchema>

export const MERGE_POLICY_CONTEXT = "agentx/merge-policy"

/** Pull request actions that can change the files, the head or the label. */
const PR_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review", "edited", "unlabeled"])

/** Review actions that can change the approval. */
const REVIEW_ACTIONS = new Set(["submitted", "dismissed", "edited"])

/** Review authors whose approval counts: people with write access. */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])

/** GitHub lists at most 3000 changed files for a pull request. */
export const MAX_LISTED_FILES = 3000

export type MergePolicyState = "success" | "pending" | "error"

export interface ChangedFile {
  path: string
  /** The old path of a renamed file: moving a file out of core is a core change. */
  previousPath?: string
}

export interface PullRequestReview {
  login: string
  isBot: boolean
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING */
  state: string
  commitId: string
  /** OWNER | MEMBER | COLLABORATOR | CONTRIBUTOR | NONE … */
  association: string
}

export interface MergePolicyPullRequest {
  headSha: string
  authorLogin: string
  body: string
  labels: string[]
  state: string
}

/** What the policy needs from GitHub. Built from REST calls in the daemon. */
export interface MergePolicyGitHub {
  getPullRequest(repo: string, number: number): Promise<MergePolicyPullRequest>
  getChangedFiles(repo: string, number: number): Promise<ChangedFile[]>
  getReviews(repo: string, number: number): Promise<PullRequestReview[]>
  setStatus(repo: string, sha: string, state: MergePolicyState, description: string): Promise<void>
  addLabel(repo: string, number: number, label: string): Promise<void>
  removeLabel(repo: string, number: number, label: string): Promise<void>
}

export interface MergePolicyDeps {
  config: () => MergePolicyConfig
  github: MergePolicyGitHub
  /** True when the login is an account AgentX posts with (an agent PR). */
  isAgentLogin: (login: string) => boolean
  log?: (msg: string) => void
}

export interface MergePolicyEvent {
  /** "pull_request" or "pull_request_review". */
  kind: "pull_request" | "pull_request_review"
  action: string
  repo: string
  number: number
}

export interface Classification {
  core: boolean
  /** The core files, as matched (old and new path of a rename both count). */
  coreFiles: string[]
  /** True when GitHub's list was cut, so some changes were not seen. */
  truncated: boolean
}

export interface MergePolicyOutcome {
  state: MergePolicyState
  description: string
  core: boolean
  agentPR: boolean
  approvedBy: string[]
}

// --- Pure helpers ---

/** Whether one path is core. A core pattern always wins. With edge paths
 *  listed, a path under neither list is core too: a new folder needs a
 *  person until someone files it as edge. */
export function isCorePath(file: string, cfg: Pick<MergePolicyConfig, "corePaths" | "edgePaths">): boolean {
  if (cfg.corePaths.some((p) => matchesPath(file, p))) return true
  if (!cfg.edgePaths.length) return false
  return !cfg.edgePaths.some((p) => matchesPath(file, p))
}

/** Sorts a pull request by its changed files. A list GitHub cut short is
 *  core: the files it left out were never checked. */
export function classify(files: ChangedFile[], cfg: Pick<MergePolicyConfig, "corePaths" | "edgePaths">): Classification {
  const coreFiles: string[] = []
  for (const f of files) {
    for (const p of [f.path, f.previousPath]) {
      if (p && isCorePath(p, cfg) && !coreFiles.includes(p)) coreFiles.push(p)
    }
  }
  const truncated = files.length >= MAX_LISTED_FILES
  return { core: truncated || coreFiles.length > 0, coreFiles, truncated }
}

/** The people whose latest review approves the head commit, and those
 *  whose latest review asks for changes. A comment-only review changes
 *  nothing; a dismissed one cancels that person's earlier verdict. Bots,
 *  AgentX's own accounts, the PR's author and people without write access
 *  never count, and with `approvers` set only those logins do. */
export function approvals(
  reviews: PullRequestReview[],
  opts: { headSha: string; authorLogin: string; approvers: string[]; isAgentLogin: (login: string) => boolean },
): { approvedBy: string[]; changesRequestedBy: string[] } {
  const allowed = opts.approvers.map((a) => a.toLowerCase())
  const latest = new Map<string, PullRequestReview>()
  for (const r of reviews) {
    if (r.state === "COMMENTED" || r.state === "PENDING") continue
    latest.set(r.login.toLowerCase(), r)
  }
  const approvedBy: string[] = []
  const changesRequestedBy: string[] = []
  for (const [login, r] of latest) {
    if (r.isBot || opts.isAgentLogin(r.login) || login === opts.authorLogin.toLowerCase()) continue
    if (allowed.length ? !allowed.includes(login) : !TRUSTED_ASSOCIATIONS.has(r.association)) continue
    if (r.state === "CHANGES_REQUESTED") changesRequestedBy.push(r.login)
    else if (r.state === "APPROVED" && r.commitId === opts.headSha) approvedBy.push(r.login)
  }
  return { approvedBy, changesRequestedBy }
}

/** One line naming the first core files, for the status description. */
function coreSummary(c: Classification): string {
  if (c.truncated && !c.coreFiles.length) return `over ${MAX_LISTED_FILES} files changed`
  const shown = c.coreFiles.slice(0, 2).join(", ")
  const more = c.coreFiles.length > 2 ? ` +${c.coreFiles.length - 2}` : ""
  return `core: ${shown}${more}`
}

/** The status for one pull request at its head commit. */
export function decide(input: {
  classification: Classification
  agentPR: boolean
  approvedBy: string[]
  changesRequestedBy: string[]
  required: number
}): MergePolicyOutcome {
  const { classification: c, agentPR, approvedBy, changesRequestedBy, required } = input
  const base = { core: c.core, agentPR, approvedBy }
  if (!c.core) return { ...base, state: "success", description: "edge only: merges on green CI" }
  const what = coreSummary(c)
  if (!agentPR) return { ...base, state: "success", description: `${what}; opened by a person` }
  if (changesRequestedBy.length) return { ...base, state: "pending", description: `${what}; changes requested by ${changesRequestedBy.join(", ")}` }
  if (approvedBy.length >= required) return { ...base, state: "success", description: `${what}; approved by ${approvedBy.join(", ")}` }
  const need = required - approvedBy.length
  return { ...base, state: "pending", description: `${what}; needs ${need} more human approval${need > 1 ? "s" : ""} of this commit` }
}

// --- The policy ---

export class MergePolicy {
  /** One check at a time per pull request, so statuses land in order. */
  private queue = new Map<string, Promise<unknown>>()
  private readonly log: (msg: string) => void

  constructor(private deps: MergePolicyDeps) {
    this.log = deps.log ?? (() => {})
  }

  /** Called for every pull_request and pull_request_review webhook. Does
   *  nothing while the policy is off. Returns the check's promise when one
   *  started (tests await it). */
  onEvent(event: MergePolicyEvent): Promise<MergePolicyOutcome | null> | null {
    if (!this.deps.config().enabled) return null
    const actions = event.kind === "pull_request" ? PR_ACTIONS : REVIEW_ACTIONS
    if (!actions.has(event.action)) return null
    const key = `${event.repo}#${event.number}`
    const run = (this.queue.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.check(event.repo, event.number))
      .catch((e: any) => { this.log(`check of ${key} failed: ${e?.message || e}`); return null })
    this.queue.set(key, run)
    void run.finally(() => { if (this.queue.get(key) === run) this.queue.delete(key) })
    return run
  }

  /** Sorts one pull request at its current head, labels it and posts the
   *  status. Reads the PR afresh, so a late event never posts on an old
   *  commit with an old file list. */
  async check(repo: string, number: number): Promise<MergePolicyOutcome | null> {
    const cfg = this.deps.config()
    const gh = this.deps.github
    const pr = await gh.getPullRequest(repo, number)
    if (pr.state !== "open") return null
    const agentPR = this.deps.isAgentLogin(pr.authorLogin) || detectAgentxMarker(pr.body) !== null

    let outcome: MergePolicyOutcome
    try {
      const classification = classify(await gh.getChangedFiles(repo, number), cfg)
      const { approvedBy, changesRequestedBy } = classification.core && agentPR
        ? approvals(await gh.getReviews(repo, number), { headSha: pr.headSha, authorLogin: pr.authorLogin, approvers: cfg.approvers, isAgentLogin: this.deps.isAgentLogin })
        : { approvedBy: [], changesRequestedBy: [] }
      outcome = decide({ classification, agentPR, approvedBy, changesRequestedBy, required: cfg.requiredApprovals })
    } catch (e: any) {
      // Never success on a failed read: the files are unknown.
      outcome = { state: "error", description: `check failed: ${e?.message || e}`, core: false, agentPR, approvedBy: [] }
    }

    if (outcome.state !== "error" && cfg.label) {
      const has = pr.labels.some((l) => l.toLowerCase() === cfg.label.toLowerCase())
      try {
        if (outcome.core && !has) await gh.addLabel(repo, number, cfg.label)
        else if (!outcome.core && has) await gh.removeLabel(repo, number, cfg.label)
      } catch (e: any) {
        // The status is what blocks; a missing label must not keep it back.
        this.log(`could not ${outcome.core ? "add" : "remove"} label ${cfg.label} on ${repo}#${number}: ${e?.message || e}`)
      }
    }
    await gh.setStatus(repo, pr.headSha, outcome.state, statusText(outcome.description))
    return outcome
  }
}
