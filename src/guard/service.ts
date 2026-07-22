import { existsSync, readdirSync, statSync } from "fs"
import { join, resolve } from "path"
import { loadPolicy, GUARDRAILS_DIR } from "./policy"
import { evaluate } from "./engine"
import { recordDecision } from "./audit"
import { decisionOutput, payloadToInput, type PreToolUsePayload } from "./check"
import type { GuardMode, ResolvedPolicy, Verdict } from "./types"

// --- In-daemon guard service ---
//
// The PreToolUse hook fires on EVERY Bash/Write/Edit call. Spawning `node
// dist/cli.js guard check` per call costs ~300ms of interpreter + bundle
// boot, which is pure latency on every agent command. The daemon is already
// running, so the hook instead POSTs the payload to it over loopback and the
// work happens in-process (~1ms). The CLI path stays as the manual/offline
// entrypoint.
//
// Three wins beyond latency:
//   - Policy is parsed once and cached (invalidated by file mtime, so live
//     edits still take effect on the next call — no restart).
//   - Audit rows are written through the daemon's single SQLite handle, so
//     there's no cross-process writer contention.
//   - Env resolution reads the workspace's .env* files directly (where the
//     incident's DATABASE_URL actually lived) rather than depending on what
//     the hook process happened to inherit.

interface CacheEntry {
  signature: string
  policy: ResolvedPolicy
}

const policyCache = new Map<string, CacheEntry>()

/**
 * Cheap change-detector for the guardrails tree: max mtime + file count.
 * The tree is a handful of small YAML files, so stat-ing it per call is far
 * cheaper than re-parsing, while still honoring "edit the YAML, no restart".
 */
function policySignature(root: string): string {
  const dir = resolve(root, GUARDRAILS_DIR)
  if (!existsSync(dir)) return "none"
  let maxMtime = 0
  let count = 0
  const walk = (d: string, depth: number) => {
    if (depth > 3) return
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      const p = join(d, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p, depth + 1)
      else {
        count++
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs
      }
    }
  }
  walk(dir, 0)
  return `${count}:${maxMtime}`
}

/** Load the policy for an agent, reusing the cached parse when the
 *  guardrails tree hasn't changed. */
export function getPolicy(root: string, agentId?: string): ResolvedPolicy {
  const key = `${resolve(root)}::${agentId ?? ""}`
  const signature = policySignature(root)
  const hit = policyCache.get(key)
  if (hit && hit.signature === signature) return hit.policy
  const policy = loadPolicy(root, agentId)
  policyCache.set(key, { signature, policy })
  return policy
}

/** Test-only: drop cached policies. */
export function resetPolicyCache(): void {
  policyCache.clear()
}

export interface GuardServiceResult {
  verdict: Verdict
  mode: GuardMode
  /** Body to hand back to the hook — "" means "allow, say nothing". */
  stdout: string
  ms: number
}

/**
 * Evaluate one PreToolUse payload. Never throws: on internal error it
 * returns an allow with an empty body so a guard bug can't brick every
 * agent command (the engine's own fail-closed logic still applies to
 * protected-target commands).
 */
export function checkPayload(
  payload: PreToolUsePayload,
  opts: { root: string; agentId?: string; env?: string },
): GuardServiceResult {
  const start = Date.now()
  const allow = (): GuardServiceResult => ({
    verdict: {
      matched: false,
      action: "allow",
      effectiveAction: "allow",
      ruleId: null,
      severity: null,
      message: null,
      resolvedTarget: null,
    },
    mode: "warn",
    stdout: "",
    ms: Date.now() - start,
  })

  try {
    const input = payloadToInput(payload, opts.agentId, opts.env)
    if (!input.command && !input.filePath) return allow()

    const policy = getPolicy(opts.root, opts.agentId)
    const verdict = evaluate(input, policy)
    const ms = Date.now() - start

    recordDecision({ root: opts.root, input, verdict, mode: policy.mode, ms })

    return { verdict, mode: policy.mode, stdout: decisionOutput(verdict).stdout, ms }
  } catch (e: any) {
    process.stderr.write(`[agentx-guard] service error (fail-open): ${e?.message}\n`)
    return allow()
  }
}
