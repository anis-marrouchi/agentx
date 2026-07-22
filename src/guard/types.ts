import { z } from "zod"

// --- Destructive-action guardrails: policy + verdict types ---
//
// The guard sits between an agent's intent (a proposed tool call) and its
// execution. Claude Code fires a PreToolUse hook that shells out to
// `agentx guard check`; the guard resolves the command's real target,
// evaluates it against a layered policy, and returns allow/deny/escalate.
//
// Everything here is DATA — the default catalog (catalog.ts) ships as a
// GuardPolicy literal, and operators override it with YAML under
// `.agentx/guardrails/`. No behavior is hardcoded in the engine.
//
// Phase 1 ships in `warn` mode: deny/escalate verdicts are computed and
// audited but downgraded to non-blocking output. The `escalate` action and
// `preconditions` are carried through the schema so Phase 2/3 (intent-ledger
// approvals, backup preconditions) slot in without a schema change.

/** What a matching rule wants to happen. Precedence when several match:
 *  deny > escalate > warn > allow (an explicit deny can never be downgraded
 *  by a lower-priority match — see engine.pickVerdict). */
export const guardActionSchema = z.enum(["deny", "escalate", "warn", "allow"])
export type GuardAction = z.infer<typeof guardActionSchema>

export const guardSeveritySchema = z.enum(["critical", "high", "medium", "low"])
export type GuardSeverity = z.infer<typeof guardSeveritySchema>

/** Enforcement posture. `warn` = compute+audit but never block (Phase 1
 *  default, and the PRD's rollout stance). `enforce` = honor the action.
 *  `off` = short-circuit to allow (kill-switch / opt-out). */
export const guardModeSchema = z.enum(["warn", "enforce", "off"])
export type GuardMode = z.infer<typeof guardModeSchema>

/** What a rule matches on. All present fields must match (AND). A rule with
 *  only `target_in` matches purely on the resolved target (the "coder never
 *  touches prod" case); a rule with `command_regex` + `target_in` requires
 *  both (the incident's shadow-DB-against-prod case). */
export const ruleMatchSchema = z.object({
  /** Tool name gate: "Bash" | "Write" | "Edit" | ... Omit to match any tool. */
  tool: z.string().optional(),
  /** JS regex source, tested against the (env-expanded) command string.
   *  Embed `(?i)`-style flags via inline groups, e.g. `(?i)drop\\s+table`. */
  command_regex: z.string().optional(),
  /** JS regex source, tested against a Write/Edit file_path. */
  path_regex: z.string().optional(),
  /** Dotted reference into protected_resources, e.g. "production" or
   *  "protected_resources.production". Matches when the command resolves to
   *  any resource in that set. */
  target_in: z.string().optional(),
})
export type RuleMatch = z.infer<typeof ruleMatchSchema>

export const guardRuleSchema = z.object({
  /** Stable id, surfaced in audit + agent feedback. Unique within a policy. */
  id: z.string(),
  match: ruleMatchSchema,
  action: guardActionSchema,
  severity: guardSeveritySchema.optional(),
  /** Human-readable reason handed to the agent when denied/escalated. */
  message: z.string().optional(),
  /** Phase 3: gates that must hold before an `allow`/`escalate` proceeds,
   *  e.g. "fresh_backup(production)". Carried but NOT evaluated in Phase 1. */
  preconditions: z.array(z.string()).default([]),
  /** Optional scope filter — only apply this rule to these agents/envs. */
  applies_to: z
    .object({ agents: z.array(z.string()).optional(), envs: z.array(z.string()).optional() })
    .optional(),
})
export type GuardRule = z.infer<typeof guardRuleSchema>

/** A named set of production-ish resources a command must not touch. Values
 *  may themselves contain `${VAR}` — expanded with the same env as the
 *  command before comparison. */
export const protectedSetSchema = z.object({
  db_urls: z.array(z.string()).default([]),
  hosts: z.array(z.string()).default([]),
  buckets: z.array(z.string()).default([]),
  /** k8s contexts, droplet ids, cluster names — any opaque token to match. */
  contexts: z.array(z.string()).default([]),
  /** When true, expand `$VAR`/`${VAR}` (and `.env*` reads) in the command
   *  before matching, so `--shadow-database-url $DATABASE_URL` is caught. */
  resolve_env: z.boolean().default(true),
})
export type ProtectedSet = z.infer<typeof protectedSetSchema>

export const guardDefaultsSchema = z.object({
  /** On guard error while judging a command that touches a protected
   *  resource: `closed` => deny, `open` => allow. */
  fail_mode: z.enum(["closed", "open"]).default("closed"),
  /** Verdict for commands no rule matched. */
  unmatched: z.enum(["allow", "deny"]).default("allow"),
})
export type GuardDefaults = z.infer<typeof guardDefaultsSchema>

/** One policy layer. Layers are deep-merged global -> environment -> agent
 *  (policy.ts). The top-level `mode`/`defaults`/`protected_resources` from
 *  the most specific layer that sets them win; `rules` accumulate across
 *  layers, and per-agent `agents.<id>.rules` are appended for that agent. */
export const guardPolicySchema = z.object({
  version: z.number().optional(),
  mode: guardModeSchema.optional(),
  defaults: guardDefaultsSchema.optional(),
  /** envName -> protected set. envName is what `target_in` references. */
  protected_resources: z.record(z.string(), protectedSetSchema).default({}),
  rules: z.array(guardRuleSchema).default([]),
  /** Per-agent overrides: extra rules (and optional mode) for one agent. */
  agents: z
    .record(
      z.string(),
      z.object({ mode: guardModeSchema.optional(), rules: z.array(guardRuleSchema).default([]) }),
    )
    .default({}),
})
export type GuardPolicy = z.infer<typeof guardPolicySchema>

/** The fully-resolved policy the engine evaluates against (post-merge). */
export interface ResolvedPolicy {
  mode: GuardMode
  defaults: GuardDefaults
  protectedResources: Record<string, ProtectedSet>
  rules: GuardRule[]
}

/** The proposed action being judged. Built from the PreToolUse stdin payload
 *  (check.ts) or from `guard test` args. */
export interface GuardInput {
  tool: string
  command?: string
  filePath?: string
  /** Workspace cwd (from the PreToolUse payload) — base for `.env*` reads. */
  cwd?: string
  agentId?: string
  /** Environment name to scope `applies_to.envs` filtering, if known. */
  env?: string
}

/** What Claude Code is ultimately told to do, after the mode downgrade. */
export type EffectiveAction = "allow" | "deny" | "ask" | "warn"

export interface Verdict {
  /** True when at least one rule matched. */
  matched: boolean
  /** The policy's action for the winning rule (pre-mode). */
  action: GuardAction
  /** What we actually enforce, after applying `mode`. `warn`/`off` => allow. */
  effectiveAction: EffectiveAction
  ruleId: string | null
  severity: GuardSeverity | null
  message: string | null
  /** The protected resource the command resolved to, if a target matched. */
  resolvedTarget: string | null
  /** True when the verdict came from the fail-closed error path. */
  failClosed?: boolean
}
