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
//   core, changes requested   pending
//   files unreadable          error    (never a success on a list not read)
//
// A renamed file counts at its old path too, and a list as long as GitHub
// can give (MAX_LISTED_FILES) counts as core: it may be cut short.
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

export type PolicyState = "success" | "pending" | "error"

/** GitHub lists at most this many changed files for a pull request. A
 *  list this long may be cut short, so it counts as core. */
export const MAX_LISTED_FILES = 3000

/** Author associations that can approve when `approvers` is empty: people
 *  with a say in the repository, not any passer-by with an account. */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])

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
  /** GitHub's author_association: OWNER, MEMBER, COLLABORATOR, … */
  association?: string
}

/** What the policy needs from GitHub. */
export interface MergePolicyGitHub {
  getPullRequest(repo: string, number: number): Promise<PolicyPullRequest>
  /** Every path a PR changes: a renamed file is listed at its old path too. */
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
  /** True when a card for this commit is waiting for an answer, or was
   *  answered NO: the owner is asked once per commit. */
  cardAsked: (repo: string, number: number, sha: string) => boolean
  /** Raise the owner's card. Throws when the card could not be raised. */
  raiseCard: (req: ApprovalCardRequest) => void
  log?: (msg: string) => void
  /** Wait between tries of a check a YES started (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>
}

/** A YES that GitHub failed to hear is tried this many times, a minute apart. */
const CARD_TRIES = 3
const CARD_RETRY_MS = 60_000

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
  private running = new Map<string, Promise<PolicyOutcome | null | undefined>>()
  private readonly log: (msg: string) => void
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private deps: MergePolicyDeps) {
    this.log = deps.log ?? (() => {})
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
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
    return this.checkWithRetry(o.repo, o.pr)
  }

  /** Check PRs whose card the owner answered YES while the daemon was
   *  down or GitHub was failing: the card is marked told before its
   *  result is acted on, so nothing else would bring the YES back. */
  recheck(prs: Array<{ repo: string; pr: number }>): Promise<Array<PolicyOutcome | null>> {
    if (!this.deps.config().enabled) return Promise.resolve([])
    const seen = new Set<string>()
    const unique = prs.filter((p) => !seen.has(`${p.repo}#${p.pr}`) && !!seen.add(`${p.repo}#${p.pr}`))
    return Promise.all(unique.map((p) => this.checkWithRetry(p.repo, p.pr)))
  }

  private async checkWithRetry(repo: string, number: number): Promise<PolicyOutcome | null> {
    for (let i = 1; ; i++) {
      const o = await this.queue(repo, number, true)
      if (o !== undefined || i >= CARD_TRIES) return o ?? null
      await this.sleep(CARD_RETRY_MS)
    }
  }

  /** Run a check after any earlier one for the same PR. A failed check
   *  is logged and ends as null, or as undefined with `failAsUndefined`. */
  private queue(repo: string, number: number): Promise<PolicyOutcome | null>
  private queue(repo: string, number: number, failAsUndefined: true): Promise<PolicyOutcome | null | undefined>
  private queue(repo: string, number: number, failAsUndefined = false): Promise<PolicyOutcome | null | undefined> {
    const key = `${repo}#${number}`
    const prev = this.running.get(key) ?? Promise.resolve(null)
    const next = prev.catch(() => null).then(() => this.check(repo, number)).catch((e: any) => {
      this.log(`${key}: check failed: ${e?.message ?? e}`)
      return failAsUndefined ? undefined : null
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
    let changed: string[]
    try {
      changed = await gh.getChangedFiles(repo, number)
    } catch (e: any) {
      // Never a success on a list we could not read.
      await gh.setStatus(repo, sha, "error", statusText(`could not read the changed files: ${e?.message ?? e}`))
      throw e
    }
    const { core } = classifyFiles(changed, cfg)
    if (changed.length >= MAX_LISTED_FILES && !core.length) core.push(`over ${MAX_LISTED_FILES} files changed`)
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

    const { approvedBy, heldBy } = await this.approval(repo, pr)
    if (heldBy) return post({ state: "pending", description: `${files}; ${heldBy} requested changes`, core })
    if (approvedBy) return post({ state: "success", description: `${files}; approved by ${approvedBy}`, core, approvedBy })

    if (cfg.mode === "advisory") {
      return post({ state: "success", description: `[advisory] ${files}; a person should approve before merge`, core })
    }
    let cardRaised = false
    if (cfg.ownerCard && !this.deps.cardAsked(repo, number, sha)) {
      try {
        this.deps.raiseCard({ repo, number, sha, core, url: pr.url })
        cardRaised = true
      } catch (e: any) {
        this.log(`${repo}#${number}: owner card not raised: ${e?.message ?? e}`)
      }
    }
    return post({ state: "pending", description: `${files}; waiting for a person to approve`, core, cardRaised })
  }

  /** Who approved the head commit, and who holds it with a standing
   *  "changes requested". The owner's card YES outranks both. */
  private async approval(repo: string, pr: PolicyPullRequest): Promise<{ approvedBy?: string; heldBy?: string }> {
    const cfg = this.deps.config()
    const fromCard = this.deps.cardApproval(repo, pr.number, pr.headSha)
    if (fromCard) return { approvedBy: fromCard }
    const allowed = cfg.approvers.map((a) => a.toLowerCase())
    // The latest review per login counts: a later "changes requested" or a
    // dismissal takes an approval back.
    const latest = new Map<string, PolicyReview>()
    for (const r of await this.deps.github.getReviews(repo, pr.number)) {
      const login = r.login.toLowerCase()
      if (r.state === "commented") continue
      latest.set(login, r)
    }
    let approvedBy: string | undefined
    for (const [login, r] of latest) {
      if (login === pr.authorLogin.toLowerCase() || this.deps.isAgentLogin(r.login)) continue
      if (allowed.length ? !allowed.includes(login) : !TRUSTED_ASSOCIATIONS.has((r.association ?? "").toUpperCase())) continue
      if (r.state === "changes_requested") return { heldBy: r.login }
      if (r.state === "approved" && r.commitId === pr.headSha) approvedBy ??= r.login
    }
    return { approvedBy }
  }
}

interface CardLike {
  status: string
  verdict?: string
  decided_by?: string
  decided_at?: string
  origin?: { kind: string; repo?: string; pr?: number; sha?: string }
}

/** What the owner's cards say about one commit: who approved it (the
 *  latest answer wins, so a YES after a NO approves), and whether to hold
 *  off asking (a card waits, or the latest answer is NO). An expired card
 *  may be raised again. */
export function cardVerdict(cards: CardLike[], repo: string, pr: number, sha: string): { approvedBy?: string; asked: boolean } {
  const mine = cards.filter((c) => c.origin?.kind === "merge-policy" && c.origin.repo === repo && c.origin.pr === pr && c.origin.sha === sha)
  const last = mine.filter((c) => c.status === "decided").sort((a, b) => (a.decided_at ?? "").localeCompare(b.decided_at ?? "")).pop()
  return {
    approvedBy: last?.verdict === "yes" ? (last.decided_by || "the owner") : undefined,
    asked: mine.some((c) => c.status === "pending") || last?.verdict === "no",
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
