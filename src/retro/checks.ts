import type Database from "better-sqlite3"
import { listCards, type CardInput, type DecisionCard } from "@/approvals/cards"
import type { ApprovalSettings } from "@/approvals/sweep"
import { CHOICE_LIMITS } from "@/approvals/choices"
import { CHECK_CHOICES, retroApproved, type RetroCheckOrigin } from "@/approvals/origin"
import { listPolicyRules } from "@/guard/policy"
import type { GuardRule } from "@/guard/types"
import { groupStats, loadTaskSamples, type GroupStats } from "@/storage/lesson-impact"
import { raiseRetroCard } from "./retro"

// --- Monthly review of the checks retros added (#743, P2) ---
//
// A retro's fix is tagged `retro:<taskId>`. A check that fires often on
// work that went well costs the agents time and teaches them to ignore it,
// so once a month each tagged check that did comes back as a card: keep,
// loosen or remove. The card shows how the agent's runs did before and
// after the check, with the lesson report's numbers (storage/lesson-impact.ts).
//
// Only guard rules are measured: every time one matches, the guard writes a
// row to `guardrail_decisions`. Hooks, CI checks and scripts leave no such
// record here; they are reviewed in their pull requests.
//
// Like the retro, this only proposes. A card nobody answers is discarded and
// the rule stays; a pick goes to the agent that built the rule, which opens
// a pull request (origin.ts retroCheckLines).

/** How far back firings are counted, and the span compared on each side
 *  of the day the check was added. */
export const CHECK_WINDOW_DAYS = 30
/** Fires on runs that ended well, within the window, before a check is
 *  noisy enough to review. */
export const DEFAULT_MIN_GOOD_FIRES = 5
/** Review cards raised per pass, unless `--max` says otherwise. */
export const DEFAULT_CHECK_REVIEWS = 3
/** A check is not asked about again for this long after its last review. */
export const REVIEW_QUIET_DAYS = 30
/** Runs needed on each side before before/after is worth a recommendation. */
const MIN_COMPARE = 3
const DAY_MS = 86_400_000
const TAG_RE = /^retro:([A-Za-z0-9._:-]+)$/
const MESSAGE_TAG_RE = /\bretro:([A-Za-z0-9._-]+)/

export interface RetroCheck {
  rule: GuardRule
  /** The run whose retro asked for it. */
  taskId: string
  /** The policy file, relative to the daemon's folder. */
  file: string
  /** Set when the rule applies to one agent only. */
  agentId?: string
}

/** The run a rule's `retro:` tag names. A tag in `tags` wins; an agent that
 *  wrote the tag in the rule's message instead is found too. */
export function retroTagOf(rule: GuardRule): string | null {
  for (const t of rule.tags ?? []) {
    const m = TAG_RE.exec(t.trim())
    if (m) return m[1]
  }
  return MESSAGE_TAG_RE.exec(rule.message ?? "")?.[1] ?? null
}

/** Every guard rule a retro asked for, from every policy file. */
export function listRetroChecks(root: string): RetroCheck[] {
  const out: RetroCheck[] = []
  for (const e of listPolicyRules(root)) {
    const taskId = retroTagOf(e.rule)
    if (taskId) out.push({ rule: e.rule, taskId, file: e.file, ...(e.agentId ? { agentId: e.agentId } : {}) })
  }
  return out
}

export interface CheckFires {
  total: number
  /** On runs that ended ok. */
  good: number
  /** On runs that ended in an error or a timeout. */
  failed: number
  /** The guard could not tell which run it was in. */
  unknown: number
  agents: string[]
}

/** Times the rule matched since `since`, split by how the run ended. The
 *  guard does not always know its task id; then the run is the agent's run
 *  that was going on at that moment. */
export function checkFires(db: Database.Database, ruleId: string, since: number): CheckFires {
  let rows: Array<{ agent_id: string | null; status: string | null }> = []
  try {
    rows = db.prepare(`
      SELECT d.agent_id, COALESCE(
        (SELECT t.status FROM task_traces t WHERE t.task_id = d.task_id),
        (SELECT t.status FROM task_traces t
          WHERE d.task_id IS NULL AND t.agent_id = d.agent_id
            AND t.started_at <= d.ts AND t.started_at + COALESCE(t.duration_ms, 0) >= d.ts
          ORDER BY t.started_at DESC LIMIT 1)
      ) AS status
      FROM guardrail_decisions d
      WHERE d.matched_rule = ? AND d.ts >= ?
    `).all(ruleId, since) as typeof rows
  } catch {
    // no guard audit table on this node
  }
  const fires: CheckFires = { total: rows.length, good: 0, failed: 0, unknown: 0, agents: [] }
  const agents = new Set<string>()
  for (const r of rows) {
    if (r.agent_id) agents.add(r.agent_id)
    if (r.status === "ok") fires.good++
    else if (r.status === "error" || r.status === "timeout") fires.failed++
    else fires.unknown++
  }
  fires.agents = [...agents].sort()
  return fires
}

function firstFire(db: Database.Database, ruleId: string): number | null {
  try {
    const row = db.prepare("SELECT MIN(ts) AS ts FROM guardrail_decisions WHERE matched_rule = ?").get(ruleId) as { ts: number | null }
    return row.ts ?? null
  } catch {
    return null
  }
}

export interface CheckReview {
  check: RetroCheck
  fires: CheckFires
  /** When the check started: the day its retro card was answered, else
   *  its first fire. Null when neither is known. */
  addedAt: number | null
  /** The agents whose runs are compared. */
  agents: string[]
  before: GroupStats | null
  after: GroupStats | null
  /** Fires on good work at least `minGoodFires` times in the window. */
  noisy: boolean
  /** Who the card is raised for: the agent that built the check. */
  owner?: string
}

/** Fires and before/after numbers for every check a retro added. */
export function reviewRetroChecks(
  db: Database.Database,
  root: string,
  opts: { now?: number; minGoodFires?: number } = {},
): CheckReview[] {
  const now = opts.now ?? Date.now()
  const min = opts.minGoodFires ?? DEFAULT_MIN_GOOD_FIRES
  const window = CHECK_WINDOW_DAYS * DAY_MS
  const retroCards = listCards(root).filter((c) => c.origin?.kind === "retro")
  return listRetroChecks(root).map((check) => {
    const fires = checkFires(db, check.rule.id, now - window)
    const card = retroCards.find((c) => c.origin?.kind === "retro" && c.origin.taskId === check.taskId && retroApproved(c))
    const decided = card?.decided_at ? Date.parse(card.decided_at) : NaN
    const addedAt = Number.isFinite(decided) ? decided : firstFire(db, check.rule.id)
    const agents = check.agentId
      ? [check.agentId]
      : check.rule.applies_to?.agents?.length ? [...check.rule.applies_to.agents]
      : fires.agents.length ? fires.agents
      : card ? [card.raised_by] : []
    let before: GroupStats | null = null
    let after: GroupStats | null = null
    if (addedAt !== null && agents.length) {
      const samples = loadTaskSamples(db, { since: addedAt - window }).filter((s) => agents.includes(s.agentId))
      before = groupStats(samples.filter((s) => s.startedAt < addedAt))
      after = groupStats(samples.filter((s) => s.startedAt >= addedAt && s.startedAt < addedAt + window))
    }
    return { check, fires, addedAt, agents, before, after, noisy: fires.good >= min, owner: card?.raised_by ?? agents[0] }
  })
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

function side(s: GroupStats | null): string {
  if (!s || !s.n) return "no runs"
  const d = s.medianDurationMs != null ? `, median ${Math.round(s.medianDurationMs / 1000)}s` : ""
  return `${pct(s.successRate)} ok over ${s.n} run(s)${d}`
}

/** "before: …; after: …", as on the card and in the CLI. */
export function beforeAfter(r: Pick<CheckReview, "before" | "after">): string {
  return `before: ${side(r.before)}; after: ${side(r.after)}`
}

/** Loosen when the agent's runs went better after the check, remove when
 *  they did not, loosen when there are too few runs to tell. */
export function recommendFor(r: CheckReview): { choice: string; why: string } {
  const goodShare = r.fires.total ? ` (${r.fires.good} of ${r.fires.total} fires were on runs that went well)` : ""
  if (r.before && r.after && r.before.n >= MIN_COMPARE && r.after.n >= MIN_COMPARE) {
    if (r.after.successRate > r.before.successRate) {
      return { choice: CHECK_CHOICES.loosen, why: `runs went better after it (${pct(r.before.successRate)} → ${pct(r.after.successRate)} ok), but it fires on good work${goodShare}` }
    }
    return { choice: CHECK_CHOICES.remove, why: `runs did not go better after it (${pct(r.before.successRate)} → ${pct(r.after.successRate)} ok) and it fires on good work${goodShare}` }
  }
  return { choice: CHECK_CHOICES.loosen, why: `too few runs to compare before and after; it fires on good work${goodShare}` }
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** The review card for one check. Never saved here. */
export function checkCard(r: CheckReview): CardInput & { origin: RetroCheckOrigin } {
  const rec = recommendFor(r)
  const id = r.check.rule.id
  return {
    title: clip(`Check "${id}" fires on good work`, 120),
    ask: "Keep this check, loosen it, or remove it?",
    context: clip(
      `Guard rule ${id} in ${r.check.file}, added by the retro on run ${r.check.taskId}. ` +
      `Last ${CHECK_WINDOW_DAYS} days: ${r.fires.total} fire(s), ${r.fires.good} on runs that went well, ${r.fires.failed} on runs that failed` +
      `${r.fires.unknown ? `, ${r.fires.unknown} on runs it could not tell` : ""}. ` +
      `${r.agents.join(", ") || "Its agent"} ${beforeAfter(r)}.`,
      CHOICE_LIMITS.context,
    ),
    choices: [CHECK_CHOICES.keep, CHECK_CHOICES.loosen, CHECK_CHOICES.remove],
    recommend: clip(`${rec.choice}: ${rec.why}`, 300),
    draft: `{choice}: guard rule ${id} (${r.check.file})`,
    say: clip(`Check ${id} fires on good work`, CHOICE_LIMITS.say),
    if_silent: "discard",
    source: "agentx retro checks",
    raised_by: r.owner!,
    origin: { kind: "retro-check", ruleId: id, taskId: r.check.taskId, file: r.check.file },
  }
}

/** The check's last review card, when it is waiting or was raised less
 *  than REVIEW_QUIET_DAYS ago. */
export function recentReview(root: string, ruleId: string, now = Date.now()): DecisionCard | undefined {
  const cutoff = now - REVIEW_QUIET_DAYS * DAY_MS
  return listCards(root).find((c) =>
    c.origin?.kind === "retro-check" && c.origin.ruleId === ruleId &&
    (c.status === "pending" || Date.parse(c.created_at) > cutoff))
}

export type CheckOutcome =
  | { ruleId: string; result: "raised"; cardId: string }
  | { ruleId: string; result: "skipped"; why: string }
  | { ruleId: string; result: "would-raise" }

export interface CheckPassOptions {
  root: string
  db: Database.Database
  settings: ApprovalSettings
  minGoodFires?: number
  /** Review cards raised in this pass at most. */
  max?: number
  /** Raise the cards. Off: show what it would do. */
  commit?: boolean
  now?: number
}

export interface CheckPassResult {
  reviews: CheckReview[]
  outcomes: CheckOutcome[]
  /** Set when the pass could not raise cards at all. */
  error?: string
}

/** Review every check a retro added and, with `commit`, raise a card for
 *  each noisy one: most fires on good work first, at most `max`. */
export function reviewChecksPass(opts: CheckPassOptions): CheckPassResult {
  const now = opts.now ?? Date.now()
  const reviews = reviewRetroChecks(opts.db, opts.root, { now, minGoodFires: opts.minGoodFires })
  const outcomes: CheckOutcome[] = []
  if (opts.commit && opts.settings.forwardTo) {
    return {
      reviews, outcomes,
      error: `approvals.forwardTo is set (${opts.settings.forwardTo}): retro cards can't be forwarded to another machine yet. Run this on a machine that keeps its own cards.`,
    }
  }
  const max = opts.max ?? DEFAULT_CHECK_REVIEWS
  let raised = 0
  for (const r of reviews.filter((x) => x.noisy).sort((a, b) => b.fires.good - a.fires.good)) {
    if (raised >= max) break
    const ruleId = r.check.rule.id
    const last = recentReview(opts.root, ruleId, now)
    if (last) { outcomes.push({ ruleId, result: "skipped", why: `card:${last.id} reviewed it on ${last.created_at.slice(0, 10)}` }); continue }
    if (!r.owner) { outcomes.push({ ruleId, result: "skipped", why: "no agent to give the answer to" }); continue }
    if (!opts.commit) { outcomes.push({ ruleId, result: "would-raise" }); raised++; continue }
    const card = raiseRetroCard(opts.root, checkCard(r), opts.settings)
    if (!card.ok) { outcomes.push({ ruleId, result: "skipped", why: card.error }); continue }
    outcomes.push({ ruleId, result: "raised", cardId: card.card.id })
    raised++
  }
  return { reviews, outcomes }
}
