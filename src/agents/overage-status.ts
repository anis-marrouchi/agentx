// --- Claude CLI overage eligibility ---
//
// When Anthropic disables overage ("extra usage" / pay-as-you-go beyond the
// Max allotment) at the org level, every request that would spill past the
// regular Max allotment fails with:
//   API Error: 400 invalid_request_error "You're out of extra usage"
//
// Claude CLI caches the state in ~/.claude.json:
//   cachedExtraUsageDisabledReason: "org_level_disabled_until…"
//   overageCreditGrantCache: { "<id>": { info: { available: false, … } } }
//
// Agents with a warm Claude session can still succeed because the replay is
// largely cache_read and fits under the regular allotment. Agents without a
// warm session pay full cache_create on first call, spill into overage, and
// fail — creating a vicious cycle where the agent never establishes a warm
// session in the first place (observed on pm-hasanah 2026-04-23).
//
// This module reads the cached state so callers can short-circuit doomed
// cold dispatches and surface a crisp operator-facing error instead of
// silently burning Claude CLI subprocesses to reproduce the same symptom.

import { readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

export interface OverageStatus {
  /** True when Anthropic's overage pool is usable; false when org-disabled. */
  available: boolean
  /** Raw reason string from .claude.json when disabled (e.g. "org_level_disabled_until"). */
  reason?: string
  /** Wall-clock ms when this value was computed. */
  checkedAt: number
  /** True when .claude.json was missing or unparseable — treat as "unknown, assume OK". */
  unknown?: boolean
}

export interface OverageGateResult {
  abort: true
  reason: string
  message: string
  raw: OverageStatus
}

let cached: OverageStatus | null = null
const TTL_MS = 60_000

/** Clear the in-memory cache. Exposed for tests and for a manual /reload path. */
export function clearOverageStatusCache(): void { cached = null }

function readClaudeJson(): Record<string, unknown> | null {
  try {
    const path = join(homedir(), ".claude.json")
    const raw = readFileSync(path, "utf8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Read the Claude CLI-cached overage state with a short TTL. Does not hit
 * the network — purely reads the CLI's own cache file that it updates after
 * each billing roundtrip.
 */
export function getOverageStatus(forceRefresh = false): OverageStatus {
  const now = Date.now()
  if (!forceRefresh && cached && now - cached.checkedAt < TTL_MS) return cached

  const data = readClaudeJson()
  if (!data) {
    cached = { available: true, checkedAt: now, unknown: true }
    return cached
  }

  const disabledReason = typeof data.cachedExtraUsageDisabledReason === "string"
    ? (data.cachedExtraUsageDisabledReason as string)
    : undefined
  const grantCache = data.overageCreditGrantCache as
    | Record<string, { info?: { available?: boolean } }>
    | undefined
  const firstGrantInfo = grantCache ? Object.values(grantCache)[0]?.info : undefined
  const explicitlyUnavailable = firstGrantInfo?.available === false

  const unavailable = Boolean(disabledReason) || explicitlyUnavailable

  cached = {
    available: !unavailable,
    reason: disabledReason || (explicitlyUnavailable ? "overage_grant_unavailable" : undefined),
    checkedAt: now,
  }
  return cached
}

/**
 * Heuristic gate for cold claude-code dispatches. When overage is
 * unavailable, a fresh call (no claudeSessionId to --resume into) will pay
 * full cache-create and overwhelmingly likely fail with "out of extra
 * usage". Short-circuiting saves the subprocess and surfaces a crisp,
 * operator-actionable error.
 *
 * Returns `null` when the dispatch can proceed. Returns an abort struct
 * when the caller should skip the dispatch and surface the message.
 */
export function preflightOverageGate(hasWarmSession: boolean): OverageGateResult | null {
  const status = getOverageStatus()
  if (status.available) return null
  if (hasWarmSession) return null  // warm session replays via cache_read → stays in regular allotment
  return {
    abort: true,
    reason: status.reason || "overage_disabled",
    message:
      "Claude Max-plan overage is disabled at the org level and this agent has no warm Claude session to cache against. " +
      "A cold dispatch would pay a fresh cache-create that spills past the regular allotment, producing 'out of extra usage'. " +
      "Re-enable overage at claude.ai/settings/usage, OR wait until a peer agent has established a warm session this agent can inherit before retrying.",
    raw: status,
  }
}
