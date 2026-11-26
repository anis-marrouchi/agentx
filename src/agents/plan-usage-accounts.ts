// --- Plan usage for every CLI account, not only the one in use (#2101 R28d) ---
//
// The owner can add more than one Claude Code or Codex account (#2206,
// cli-accounts.ts). The plan readers follow the account new runs use; this
// reads the others too, so the Hub's status bar can show a bar for each.
//
//   Claude: one PlanUsageReader per account folder, read at most every
//           5 minutes (15 after the endpoint says "rate limited"), with the
//           login that folder's Claude Code stored. Read only, as for the
//           account in use (claude-plan-usage.ts).
//   Codex:  that account's last session file (codex-plan-usage.ts), cached
//           a minute per folder.
//
// The account in use is listed with no reading of its own: the daemon's
// main readers already have it. Only names, percentages, times and an error
// kind leave here, never a folder or a token.

import { homedir } from "node:os"
import { activeCliDir, CLI_PROVIDERS, DEFAULT_PROFILE, readCliAccounts, withCliAccountEnv, type CliAccounts, type CliProvider } from "./cli-accounts"
import { PlanUsageReader, readStoredLogin, type PlanUsageErrorKind, type PlanWindowReading } from "./claude-plan-usage"
import { readCodexPlanUsageCached, type CodexPlanUsage } from "./codex-plan-usage"

export interface AccountPlanReading {
  name: string
  /** New runs use this account; its reading is the provider's main one. */
  active: boolean
  windows?: PlanWindowReading[]
  readAt?: number
  plan?: string
  /** Why the last read failed, when it did. */
  error?: PlanUsageErrorKind
}

export type AccountsPlanUsage = Partial<Record<CliProvider, AccountPlanReading[]>>

/** How often an added Claude account is read. */
export const ACCOUNT_READ_MS = 5 * 60_000
/** How long to wait after the usage endpoint says "rate limited". */
const RATE_LIMITED_WAIT_MS = 15 * 60_000
/** How long a /usage/plan request waits for a Claude read; a slower one lands on the next poll. */
const READ_WAIT_MS = 2_000

export interface AccountsReadDeps {
  state?: CliAccounts
  env?: NodeJS.ProcessEnv
  home?: string
  now?: number
  /** A reader for the login in `env` (tests pass a fake). */
  claudeReader?: (env: NodeJS.ProcessEnv) => PlanUsageReader
  codex?: (dir: string) => Promise<CodexPlanUsage | null>
  /**
   * session.planUsage.enabled, read per call so a settings change applies
   * without a restart. Off: no added Claude account is read, as the main
   * reader then reads nothing either (claude-plan-usage.ts configure).
   */
  enabled?: boolean
  log?: (msg: string) => void
}

const claudeReaders = new Map<string, { reader: PlanUsageReader; next: number; pending?: Promise<void> }>()

/** Drops the readers of folders no longer read: removed accounts, the one now in use, or all when reading is off. */
function dropClaudeReaders(keep: Set<string>): void {
  for (const [dir, e] of claudeReaders) {
    if (keep.has(dir)) continue
    e.reader.stop()
    claudeReaders.delete(dir)
  }
}

async function readClaudeAccount(dir: string, env: NodeJS.ProcessEnv, now: number, make: (env: NodeJS.ProcessEnv) => PlanUsageReader) {
  let e = claudeReaders.get(dir)
  if (!e) { e = { reader: make(env), next: 0 }; claudeReaders.set(dir, e) }
  const entry = e
  if (now >= entry.next && !entry.pending) {
    entry.pending = entry.reader.readNow().then((s) => {
      entry.next = now + (s.lastError?.kind === "rate-limited" ? RATE_LIMITED_WAIT_MS : ACCOUNT_READ_MS)
    }).finally(() => { entry.pending = undefined })
  }
  if (entry.pending) {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([entry.pending, new Promise<void>((r) => { timer = setTimeout(r, READ_WAIT_MS); timer.unref?.() })])
    clearTimeout(timer)
  }
  const s = entry.reader.getState()
  return {
    ...(s.reading && { windows: s.reading.windows, readAt: s.reading.readAt }),
    ...(s.lastError && { error: s.lastError.kind }),
  }
}

/** Each provider's accounts and their readings, for providers with an added account. */
export async function readAccountsPlanUsage(deps: AccountsReadDeps = {}): Promise<AccountsPlanUsage> {
  const state = deps.state ?? readCliAccounts()
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const now = deps.now ?? Date.now()
  const make = deps.claudeReader ?? ((e: NodeJS.ProcessEnv) => new PlanUsageReader({ readLogin: () => readStoredLogin({ env: e }) }))
  const codex = deps.codex ?? ((dir: string) => readCodexPlanUsageCached(dir, now))
  const enabled = deps.enabled ?? true
  const log = deps.log ?? (() => {})
  const out: AccountsPlanUsage = {}
  const claudeDirs = new Set<string>()
  for (const p of Object.keys(CLI_PROVIDERS) as CliProvider[]) {
    const s = state[p]
    if (!s || !s.profiles.length) continue
    // Claude's usage endpoint is not called while the owner has turned it off.
    if (p === "claude" && !enabled) continue
    const names = [DEFAULT_PROFILE, ...s.profiles.map((x) => x.name)]
    out[p] = await Promise.all(names.map(async (name): Promise<AccountPlanReading> => {
      if (name === s.active) return { name, active: true }
      // That account as if it were the one in use: its folder, and the env a run on it gets.
      const as: CliAccounts = { ...state, [p]: { ...s, active: name } }
      const dir = activeCliDir(p, as, env, home)
      if (p === "claude") {
        claudeDirs.add(dir)
        return { name, active: false, ...(await readClaudeAccount(dir, withCliAccountEnv({ ...env }, [], as), now, make)) }
      }
      const r = await codex(dir).catch((e) => { log(`[plan-usage] Codex account "${name}" not read: ${e?.message ?? e}`); return null })
      return { name, active: false, ...(r && { windows: r.windows, readAt: r.readAt, ...(r.plan && { plan: r.plan }) }) }
    }))
  }
  dropClaudeReaders(claudeDirs)
  return out
}

/** For tests. */
export function clearAccountsPlanUsage(): void { claudeReaders.clear() }
