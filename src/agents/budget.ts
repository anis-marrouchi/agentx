import type Database from "better-sqlite3"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { createCard, readCard, type CardSettings, type DecisionCard } from "@/approvals/cards"
import type { BudgetOrigin } from "@/approvals/origin"
import { openDb } from "@/storage/sqlite"
import { rowCost } from "@/storage/usage-cost"

// --- Monthly dollar budget per agent (#1167) ---
//
// `agents.<id>.budget.monthlyUsd` caps what one agent spends in a calendar
// month (UTC, the same days usage_daily is keyed by). Unset or 0: no cap.
//
//   80%   one Desk card tells the owner. Yes or silence: keep going.
//         No: hold its new tasks now.
//   100%  new tasks are held, with the reason as the task's error, and a
//         Desk card asks whether to allow one more run. Each yes lets one
//         run through; the next held task asks again. Raising the limit
//         lifts the hold at once.
//
// Work already running is never stopped: the check runs before a task
// starts, nowhere else.
//
// Spend is what the Cost page shows for the agent: the tokens recorded in
// usage_daily, priced at the public Anthropic rates (storage/usage-cost.ts).
// A run on a subscription is priced the same way, so a budget also bounds
// how much of the shared plan one agent can take. A model with no Anthropic
// rate (OpenAI, local models) counts as $0, as it does on the Cost page.
//
// State is one small file, .agentx/budgets.json: per agent, the month and
// limit it is for, and the cards raised. A new month or a new limit starts
// it over, so the 80% card comes once per month per limit.

export const BUDGET_NOTICE_RATIO = 0.8

export interface AgentBudgetState {
  /** "YYYY-MM", UTC. */
  month: string
  /** The limit the cards below were raised for. */
  limitUsd: number
  /** The 80% card. */
  notice?: string
  /** The latest 100% card. */
  hold?: string
  /** Hold cards whose yes already let a run through. */
  used?: string[]
}

type BudgetFile = Record<string, AgentBudgetState>

export function budgetFile(root: string): string {
  return resolve(root, ".agentx", "budgets.json")
}

export function readBudgetState(root: string): BudgetFile {
  const path = budgetFile(root)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writeBudgetState(root: string, state: BudgetFile): void {
  const path = budgetFile(root)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n")
  renameSync(tmp, path)
}

/** "2026-10" for any time in October 2026, UTC. */
export function budgetMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7)
}

/** The first day of the month after `month`, as usage_daily keys days. */
function nextMonthStart(month: string): string {
  const [y, m] = month.split("-").map(Number)
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`
}

/** What `agentId` spent in `month`, in dollars, as the Cost page counts it. */
export function monthSpendUsd(db: Database.Database, agentId: string, month: string): number {
  const rows = db.prepare(`
    SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
           tier2_input_tokens, tier2_output_tokens, tier2_cache_read_tokens, tier2_cache_create_tokens
    FROM usage_daily
    WHERE agent_id = ? AND day >= ? AND day < ?
  `).all(agentId, `${month}-01`, nextMonthStart(month)) as Parameters<typeof rowCost>[0][]
  return rows.reduce((sum, r) => sum + rowCost(r), 0)
}

/** The limit set on an agent, or undefined when it has none. */
export function monthlyLimit(def: { budget?: { monthlyUsd?: number } } | undefined): number | undefined {
  const n = def?.budget?.monthlyUsd
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en", { month: "long", timeZone: "UTC" })
}

/** What yes and no do on a budget card, in words, for the Desk. */
export function budgetCardWords(origin: BudgetOrigin): { yes: string; no: string } {
  return origin.level === "notice"
    ? { yes: "keep it running", no: "hold its new tasks now" }
    : { yes: "allow one more run", no: "keep holding its new tasks" }
}

export interface BudgetCheckDeps {
  root: string
  /** Spend this month, or null when it can't be read (no database). */
  spend: (agentId: string, month: string) => number | null
  raiseCard: (card: { title: string; ask: string; recommend: string; if_silent: "keep" | "discard"; raised_by: string }, origin: BudgetOrigin) => string | null
  readCard: (id: string) => DecisionCard | null
  log?: (msg: string) => void
  now?: number
}

export type BudgetCheck =
  | { hold: false; spentUsd?: number }
  | { hold: true; spentUsd: number; message: string }

function yes(card: DecisionCard | null): boolean {
  return card?.status === "decided" && card.verdict === "yes"
}

function no(card: DecisionCard | null): boolean {
  return card?.status === "decided" && card.verdict === "no"
}

/**
 * Whether a new task for `agentId` may start under its monthly limit.
 * Raises the 80% and 100% cards as the spend crosses them. A database that
 * can't be read never holds a task: the check is skipped and logged.
 */
export function checkBudget(agentId: string, limitUsd: number | undefined, deps: BudgetCheckDeps): BudgetCheck {
  if (!limitUsd) return { hold: false }
  const now = deps.now ?? Date.now()
  const month = budgetMonth(now)
  const spent = deps.spend(agentId, month)
  if (spent === null) {
    deps.log?.(`[budget] ${agentId}: spend not readable, budget not checked`)
    return { hold: false }
  }
  const all = readBudgetState(deps.root)
  let state = all[agentId]
  if (!state || state.month !== month || state.limitUsd !== limitUsd) {
    state = { month, limitUsd }
  }
  const save = () => { all[agentId] = state; writeBudgetState(deps.root, all) }
  const ratio = spent / limitUsd
  const figures = `${usd(spent)} of its ${usd(limitUsd)} budget for ${monthName(month)}`
  const heldMessage = (why: string) =>
    `${agentId} is on hold: ${why} (${figures}, months follow UTC). New tasks wait until next month. ` +
    `The owner can allow one more run on the Desk card, or raise budget.monthlyUsd in the agent's settings.`

  if (ratio < BUDGET_NOTICE_RATIO) {
    // Under the notice line: nothing to say. A state for an older month or
    // limit is left as it is; the next card replaces it.
    return { hold: false, spentUsd: spent }
  }

  if (ratio < 1) {
    if (!state.notice) {
      const id = deps.raiseCard({
        title: `${agentId} has used ${Math.floor(ratio * 100)}% of its monthly budget`,
        ask: `${agentId} spent ${figures}. Keep it running until it reaches the limit?`,
        recommend: "Yes: at the limit its new tasks are held by themselves, and you can allow more then.",
        if_silent: "keep",
        raised_by: agentId,
      }, { kind: "budget", agentId, month, level: "notice" })
      if (id) {
        state.notice = id
        save()
        deps.log?.(`[budget] ${agentId}: ${Math.floor(ratio * 100)}% of ${usd(limitUsd)} spent; notice card ${id}`)
      }
      return { hold: false, spentUsd: spent }
    }
    if (no(deps.readCard(state.notice))) {
      return { hold: true, spentUsd: spent, message: heldMessage("the owner asked to hold it at the 80% notice") }
    }
    return { hold: false, spentUsd: spent }
  }

  // At or past the limit. The 80% card is not raised any more: the hold
  // card says everything it would.
  const freshSkip = !state.notice
  if (freshSkip) state.notice = "skipped"
  const card = state.hold ? deps.readCard(state.hold) : null
  if (card && yes(card) && !(state.used ?? []).includes(card.id)) {
    state.used = [...(state.used ?? []), card.id]
    save()
    deps.log?.(`[budget] ${agentId}: over ${usd(limitUsd)}; one more run allowed by card ${card.id}`)
    return { hold: false, spentUsd: spent }
  }
  // Waiting for an answer, or the owner said no: hold without asking again.
  // Raising the limit starts over and asks afresh at the new line.
  if (card && (card.status === "pending" || no(card))) {
    if (freshSkip) save()
    return { hold: true, spentUsd: spent, message: heldMessage("it reached its monthly limit") }
  }
  // No card yet, or the last one expired or its yes was used: ask.
  const id = deps.raiseCard({
    title: `${agentId} reached its monthly budget`,
    ask: `${agentId} spent ${figures}, so its new tasks are held. Allow one more run?`,
    recommend: "To keep it going for the rest of the month, raise its monthly budget in Settings instead.",
    if_silent: "discard",
    raised_by: agentId,
  }, { kind: "budget", agentId, month, level: "hold" })
  if (id) state.hold = id
  save()
  if (id) deps.log?.(`[budget] ${agentId}: ${usd(spent)} of ${usd(limitUsd)} spent; new tasks held, card ${id}`)
  return { hold: true, spentUsd: spent, message: heldMessage("it reached its monthly limit") }
}

/** The check with the daemon's own database and card store. */
export function checkAgentBudget(
  agentId: string,
  limitUsd: number | undefined,
  opts: { root?: string; settings?: CardSettings; log?: (msg: string) => void; now?: number } = {},
): BudgetCheck {
  if (!limitUsd) return { hold: false }
  const root = opts.root ?? process.cwd()
  return checkBudget(agentId, limitUsd, {
    root,
    now: opts.now,
    log: opts.log,
    spend: (id, month) => {
      const db = openDb({ quiet: true })
      if (!db) return null
      try { return monthSpendUsd(db, id, month) } catch { return null }
    },
    readCard: (id) => readCard(root, id),
    raiseCard: (input, origin) => {
      const r = createCard(root, input, { settings: opts.settings, origin, now: opts.now })
      if (!r.ok) {
        opts.log?.(`[budget] ${origin.agentId}: card not raised: ${r.error}`)
        return null
      }
      return r.card.id
    },
  })
}

export interface BudgetRow {
  agent_id: string
  monthlyUsd: number
  spentUsd: number
  ratio: number
  /** "limit" once at or past the limit (new tasks held), "notice" from 80%. */
  status: "ok" | "notice" | "limit"
}

/** Spend against budget for each agent that has one, this month. */
export function budgetRows(db: Database.Database, limits: Record<string, number>, now: number = Date.now()): BudgetRow[] {
  const month = budgetMonth(now)
  return Object.entries(limits).map(([agent_id, monthlyUsd]) => {
    const spentUsd = monthSpendUsd(db, agent_id, month)
    const ratio = spentUsd / monthlyUsd
    const status: BudgetRow["status"] = ratio >= 1 ? "limit" : ratio >= BUDGET_NOTICE_RATIO ? "notice" : "ok"
    return { agent_id, monthlyUsd, spentUsd, ratio, status }
  }).sort((a, b) => b.ratio - a.ratio)
}
