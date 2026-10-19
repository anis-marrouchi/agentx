import type { z } from "zod"
import type { mergePolicyConfigSchema } from "@/daemon/config"
import { matchesPath, statusText } from "./review-gate"

// --- Merge policy: core paths need a person, edge paths do not (#1047) ---
//
// Agents may merge changes at the edges of a codebase on green CI. A change
// to its core waits for a person. Which folders are core is the
// repository owner's call, so the path lists live in config and both start
// empty: nothing is core until someone says so.
//
// For each pull request the policy reads the changed files and posts the
// commit status `agentx/merge-policy` on the head commit:
//
//   edge only                 success  ("edge only": merge on green CI)
//   core, opened by a person  success  (a person's own change)
//   core, approved            success  ("approved by …")
//   core, not approved        pending  in required mode, success marked
//                                       "[advisory]" in advisory mode
//
// A core PR also gets a label, so it shows in the PR list. The status only
// blocks a merge once it is a required check on the protected branch; the
// policy never merges and never touches branch protection itself.
//
// A person approves in one of two ways, both tied to the head commit, so a
// later push needs a new approval:
//   - an "Approve" review on GitHub from a login that is not the PR's
//     author and not an account AgentX posts with (and, when `approvers`
//     is set, is one of them);
//   - YES on the owner's approvals card, raised in required mode. Every PR
//     here may be opened by one account, which cannot approve its own PR on
//     GitHub; the card is the approval that still comes from a person.

export type MergePolicyConfig = z.infer<typeof mergePolicyConfigSchema>

export const MERGE_POLICY_CONTEXT = "agentx/merge-policy"

/** Pull request actions that (re)check the policy. */
const CHECK_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"])

export type PolicyState = "success" | "pending"

export interface Classified {
  core: string[]
  edge: string[]
}

/** A changed file is core when it matches a core path and no edge path:
 *  edge paths carve exceptions out of core folders. */
export function classifyFiles(files: string[], cfg: Pick<MergePolicyConfig, "corePaths" | "edgePaths">): Classified {
  const out: Classified = { core: [], edge: [] }
  for (const f of files) {
    const core = cfg.corePaths.some((p) => matchesPath(f, p)) && !cfg.edgePaths.some((p) => matchesPath(f, p))
    ;(core ? out.core : out.edge).push(f)
  }
  return out
}

export interface PolicyPullRequest {
  number: number
  headSha: string
  authorLogin: string
  draft: boolean
  state: string
  labels: string[]
  url?: string
}

export interface PolicyReview {
  login: string
  /** approved | changes_requested | commented | dismissed (lower case). */
  state: string
  commitId: string
}

/** What the policy needs from GitHub. */
export interface MergePolicyGitHub {
  getPullRequest(repo: string, number: number): Promise<PolicyPullRequest>
  getChangedFiles(repo: string, number: number): Promise<string[]>
  getReviews(repo: string, number: number): Promise<PolicyReview[]>
  setStatus(repo: string, sha: string, state: PolicyState, description: string): Promise<void>
  addLabel(repo: string, number: number, label: string): Promise<void>
  removeLabel(repo: string, number: number, label: string): Promise<void>
}

export interface ApprovalCardRequest {
  repo: string
  number: number
  sha: string
  core: string[]
  url?: string
}

export interface MergePolicyDeps {
  config: () => MergePolicyConfig
  github: MergePolicyGitHub
  /** True when the login is an account AgentX posts with (an agent PR). */
  isAgentLogin: (login: string) => boolean
  /** Who decided YES on the owner's card for this commit, else undefined. */
  cardApproval: (repo: string, number: number, sha: string) => string | undefined
  /** True when a card for this commit is still waiting for an answer. */
  cardPending: (repo: string, number: number, sha: string) => boolean
  /** Raise the owner's card. Throws when the card could not be raised. */
  raiseCard: (req: ApprovalCardRequest) => void
  log?: (msg: string) => void
}

export interface PolicyOutcome {
  state: PolicyState
  description: string
  core: string[]
  approvedBy?: string
  cardRaised?: boolean
}

export interface PullRequestEventLike {
  action: string
  repo: string
  number: number
  headSha: string
  draft?: boolean
}

export interface ReviewEventLike {
  action: string
  repo: string
  number: number
  state: string
}

/** Short list of files for a status: "a, b and 3 more". */
function fileList(files: string[], max = 2): string {
  const head = files.slice(0, max).join(", ")
  return files.length > max ? `${head} and ${files.length - max} more` : head
}

export class MergePolicy {
  /** One check per PR at a time; a second event waits for the first. */
  private running = new Map<string, Promise<PolicyOutcome | null>>()
  private readonly log: (msg: string) => void

  constructor(private deps: MergePolicyDeps) {
    this.log = deps.log ?? (() => {})
  }

  /** Called for every pull_request webhook. Does nothing while off. */
  onPullRequest(event: PullRequestEventLike): Promise<PolicyOutcome | null> | null {
    if (!this.deps.config().enabled) return null
    if (!CHECK_ACTIONS.has(event.action) || event.draft) return null
    return this.queue(event.repo, event.number)
  }

  /** Called for every pull_request_review webhook: an approval (or its
   *  dismissal) can change the verdict. */
  onReview(event: ReviewEventLike): Promise<PolicyOutcome | null> | null {
    if (!this.deps.config().enabled) return null
    if (event.action !== "submitted" && event.action !== "dismissed") return null
    return this.queue(event.repo, event.number)
  }

  /** The owner answered a merge-policy card. */
  onCard(card: { status: string; verdict?: string; origin?: { kind: string; repo?: string; pr?: number } }): Promise<PolicyOutcome | null> | null {
    if (!this.deps.config().enabled) return null
    const o = card.origin
    if (o?.kind !== "merge-policy" || !o.repo || !o.pr) return null
    if (card.status !== "decided" || card.verdict !== "yes") return null
    return this.queue(o.repo, o.pr)
  }

  private queue(repo: string, number: number): Promise<PolicyOutcome | null> {
    const key = `${repo}#${number}`
    const prev = this.running.get(key) ?? Promise.resolve(null)
    const next = prev.catch(() => null).then(() => this.check(repo, number)).catch((e: any) => {
      this.log(`${key}: check failed: ${e?.message ?? e}`)
      return null
    })
    this.running.set(key, next)
    void next.finally(() => { if (this.running.get(key) === next) this.running.delete(key) })
    return next
  }

  /** Read the PR as it is now and post the verdict on its head commit. */
  async check(repo: string, number: number): Promise<PolicyOutcome | null> {
    const cfg = this.deps.config()
    const gh = this.deps.github
    const pr = await gh.getPullRequest(repo, number)
    if (pr.state !== "open" || pr.draft) return null
    const sha = pr.headSha
    const { core } = classifyFiles(await gh.getChangedFiles(repo, number), cfg)
    const hasLabel = pr.labels.some((l) => l.toLowerCase() === cfg.label.toLowerCase())

    const post = async (o: PolicyOutcome): Promise<PolicyOutcome> => {
      await gh.setStatus(repo, sha, o.state, statusText(o.description))
      this.log(`${repo}#${number}@${sha.slice(0, 7)}: ${o.state} ${o.description}`)
      return o
    }

    if (!core.length) {
      if (hasLabel) await gh.removeLabel(repo, number, cfg.label).catch((e: any) => this.log(`${repo}#${number}: label removal failed: ${e?.message ?? e}`))
      return post({ state: "success", description: "edge only: merges on green CI", core })
    }
    if (!hasLabel) await gh.addLabel(repo, number, cfg.label).catch((e: any) => this.log(`${repo}#${number}: label failed: ${e?.message ?? e}`))
    const files = `core paths changed (${core.length}: ${fileList(core)})`

    // A person's own PR is a person's change, not an agent's.
    if (pr.authorLogin && !this.deps.isAgentLogin(pr.authorLogin)) {
      return post({ state: "success", description: `${files}; opened by ${pr.authorLogin}, a person`, core, approvedBy: pr.authorLogin })
    }

    const approvedBy = await this.approval(repo, pr)
    if (approvedBy) return post({ state: "success", description: `${files}; approved by ${approvedBy}`, core, approvedBy })

    if (cfg.mode === "advisory") {
      return post({ state: "success", description: `[advisory] ${files}; a person should approve before merge`, core })
    }
    let cardRaised = false
    if (cfg.ownerCard && !this.deps.cardPending(repo, number, sha)) {
      try {
        this.deps.raiseCard({ repo, number, sha, core, url: pr.url })
        cardRaised = true
      } catch (e: any) {
        this.log(`${repo}#${number}: owner card not raised: ${e?.message ?? e}`)
      }
    }
    return post({ state: "pending", description: `${files}; waiting for a person to approve`, core, cardRaised })
  }

  /** Who approved the head commit, or undefined. */
  private async approval(repo: string, pr: PolicyPullRequest): Promise<string | undefined> {
    const cfg = this.deps.config()
    const fromCard = this.deps.cardApproval(repo, pr.number, pr.headSha)
    if (fromCard) return fromCard
    const allowed = cfg.approvers.map((a) => a.toLowerCase())
    // The latest review per login counts: a later "changes requested" or a
    // dismissal takes an approval back.
    const latest = new Map<string, PolicyReview>()
    for (const r of await this.deps.github.getReviews(repo, pr.number)) {
      const login = r.login.toLowerCase()
      if (r.state === "commented") continue
      latest.set(login, r)
    }
    for (const [login, r] of latest) {
      if (r.state !== "approved" || r.commitId !== pr.headSha) continue
      if (login === pr.authorLogin.toLowerCase() || this.deps.isAgentLogin(r.login)) continue
      if (allowed.length && !allowed.includes(login)) continue
      return r.login
    }
    return undefined
  }
}

/** The owner's card for a core PR: one yes/no question. */
export function approvalCardInput(req: ApprovalCardRequest, raisedBy: string): Record<string, unknown> {
  const ref = `${req.repo}#${req.number}`
  return {
    title: `Core change waiting: ${ref}`.slice(0, 120),
    ask: `Approve merging ${ref} at ${req.sha.slice(0, 7)}? It changes core paths: ${fileList(req.core, 3)}`.slice(0, 300),
    recommend: "Read the diff before you answer. YES lets it merge on green CI; a new push asks again.",
    if_silent: "keep",
    raised_by: raisedBy,
    ...(req.url ? { source: req.url } : {}),
  }
}
