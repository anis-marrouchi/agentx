import type { GuardAction, GuardInput, GuardRule, ResolvedPolicy, Verdict, EffectiveAction } from "./types"
import { buildResolveEnv, resolveTargets, normalizeProtectedSet, matchProtected } from "./resolve"

// --- Guard engine ---
//
// Pure evaluation: (input, resolved policy) -> Verdict. No I/O beyond the
// `.env*` reads resolve.ts does for var expansion. Deterministic: the same
// (command, env, policy) always yields the same verdict — a property the
// tests lean on and the reason the guard is trustworthy as a chokepoint.

const ACTION_RANK: Record<GuardAction, number> = { deny: 3, escalate: 2, warn: 1, allow: 0 }

/** Compile a policy regex. JS RegExp has no inline `(?i)` modifier (it throws),
 *  so we strip any `(?i)` occurrences and always compile case-insensitively —
 *  the right default for command matching, and it lets catalog authors write
 *  the familiar `(?i)` prefix without breaking. */
function compileRegex(src: string): RegExp {
  return new RegExp(src.replace(/\(\?i\)/g, ""), "i")
}

/** Strip an optional `protected_resources.` prefix from a target_in ref. */
function protectedSetName(ref: string): string {
  return ref.replace(/^protected_resources\./, "")
}

interface RuleHit {
  rule: GuardRule
  resolvedTarget: string | null
}

/** Does `rule` apply to this input? Returns the matched protected target when
 *  a `target_in` clause matched (null otherwise). Throws only on a genuinely
 *  broken regex, which the caller turns into a fail-closed verdict. */
function ruleMatches(
  rule: GuardRule,
  input: GuardInput,
  policy: ResolvedPolicy,
  ctx: { candidates: string[]; ambientCandidates: string[]; expandedCommand: string; env: Record<string, string> },
): RuleHit | null {
  const m = rule.match

  // Scope filters.
  if (rule.applies_to?.agents && input.agentId && !rule.applies_to.agents.includes(input.agentId)) return null
  if (rule.applies_to?.envs && input.env && !rule.applies_to.envs.includes(input.env)) return null

  // Tool gate.
  if (m.tool && m.tool !== input.tool) return null

  // Command regex (against the env-expanded command).
  if (m.command_regex) {
    if (!input.command) return null
    if (!compileRegex(m.command_regex).test(ctx.expandedCommand)) return null
  }

  // Path regex (Write/Edit).
  if (m.path_regex) {
    if (!input.filePath) return null
    if (!compileRegex(m.path_regex).test(input.filePath)) return null
  }

  // Protected-target gate.
  let resolvedTarget: string | null = null
  if (m.target_in) {
    const name = protectedSetName(m.target_in)
    const set = policy.protectedResources[name]
    if (!set) return null // referenced env not declared -> cannot match on target
    const tokens = normalizeProtectedSet(set, ctx.env)
    // Ambient targets (DATABASE_URL & friends) only count for rules already
    // scoped to a destructive verb — `prisma migrate reset` names no target
    // but will happily wipe whatever DATABASE_URL points at. A bare
    // `target_in` rule stays on explicit targets so it can't flag every `ls`
    // in a prod-configured workspace.
    const pool = m.command_regex ? [...ctx.candidates, ...ctx.ambientCandidates] : ctx.candidates
    resolvedTarget = matchProtected(pool, tokens)
    if (!resolvedTarget) return null
  }

  // A rule with no match clauses at all never fires (guards against an empty
  // rule silently denying everything).
  if (!m.tool && !m.command_regex && !m.path_regex && !m.target_in) return null

  return { rule, resolvedTarget }
}

function applyMode(action: GuardAction, mode: ResolvedPolicy["mode"]): EffectiveAction {
  if (mode === "off" || mode === "warn") return "allow"
  // enforce:
  switch (action) {
    case "deny":
      return "deny"
    case "escalate":
      return "ask" // interim — Phase 2 routes this through the intent ledger
    case "warn":
    case "allow":
      return "allow"
  }
}

/** Evaluate a proposed tool call against the resolved policy. */
export function evaluate(input: GuardInput, policy: ResolvedPolicy): Verdict {
  const command = input.command ?? ""
  const env = buildResolveEnv(input.cwd)

  let candidates: string[] = []
  let ambientCandidates: string[] = []
  let expandedCommand = command
  try {
    const t = resolveTargets(command, env)
    candidates = t.candidates
    ambientCandidates = t.ambientCandidates
    expandedCommand = t.expandedCommand
  } catch {
    // Resolution itself failed. If any protected set exists, fail closed.
    if (policy.defaults.fail_mode === "closed" && Object.keys(policy.protectedResources).length > 0) {
      return failClosedVerdict(policy.mode, "target resolution failed")
    }
  }

  const ctx = { candidates, ambientCandidates, expandedCommand, env }
  const hits: RuleHit[] = []
  for (const rule of policy.rules) {
    try {
      const hit = ruleMatches(rule, input, policy, ctx)
      if (hit) hits.push(hit)
    } catch {
      // A broken rule regex while judging a command that touches a protected
      // resource => fail closed (deny). Otherwise skip the broken rule.
      if (policy.defaults.fail_mode === "closed" && rule.match.target_in && candidates.length > 0) {
        return failClosedVerdict(policy.mode, `rule "${rule.id}" errored`)
      }
    }
  }

  if (hits.length === 0) {
    const action: GuardAction = policy.defaults.unmatched === "deny" ? "deny" : "allow"
    return {
      matched: false,
      action,
      effectiveAction: applyMode(action, policy.mode),
      ruleId: null,
      severity: null,
      message: null,
      resolvedTarget: null,
    }
  }

  // Highest-precedence action wins; an explicit deny can never be downgraded.
  hits.sort((a, b) => ACTION_RANK[b.rule.action] - ACTION_RANK[a.rule.action])
  const winner = hits[0]
  return {
    matched: true,
    action: winner.rule.action,
    effectiveAction: applyMode(winner.rule.action, policy.mode),
    ruleId: winner.rule.id,
    severity: winner.rule.severity ?? null,
    message: winner.rule.message ?? null,
    resolvedTarget: winner.resolvedTarget,
  }
}

function failClosedVerdict(mode: ResolvedPolicy["mode"], reason: string): Verdict {
  return {
    matched: true,
    action: "deny",
    effectiveAction: applyMode("deny", mode),
    ruleId: "fail-closed",
    severity: "critical",
    message: `Guard failed closed: ${reason}.`,
    resolvedTarget: null,
    failClosed: true,
  }
}
