import { resolve, dirname } from "path"
import { existsSync } from "fs"

// --- Destructive-action guardrails: public surface ---

export * from "./types"
export { CATALOG_POLICY, CATALOG_RULES } from "./catalog"
export { loadPolicy, resolveInMemory, flatten, GUARDRAILS_DIR } from "./policy"
export { evaluate } from "./engine"
export { resolveTargets, buildResolveEnv, expandVars, extractHost, matchProtected, normalizeProtectedSet } from "./resolve"
export { recordDecision, listDecisions } from "./audit"
export type { DecisionRow } from "./audit"
export { runGuard, runCheckFromStdin, payloadToInput, decisionOutput, verdictReason } from "./check"
export type { PreToolUsePayload, RunGuardOptions, GuardResult } from "./check"

/**
 * Best-effort resolution of the AgentX install root (where `.agentx/` lives).
 * The generated hook command passes `--root` explicitly; this is the fallback
 * for manual invocation. cli.js lives at `<root>/dist/cli.js`, so walk up from
 * argv[1] looking for an `.agentx` dir; else use cwd.
 */
export function guessInstallRoot(): string {
  const entry = process.argv[1]
  if (entry) {
    let dir = dirname(resolve(entry))
    for (let i = 0; i < 5; i++) {
      if (existsSync(resolve(dir, ".agentx")) || existsSync(resolve(dir, "agentx.json"))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return process.cwd()
}
