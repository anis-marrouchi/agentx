import { existsSync, readFileSync, readdirSync } from "fs"
import { resolve, join } from "path"
import yaml from "js-yaml"
import { guardPolicySchema, type GuardPolicy, type GuardRule, type ResolvedPolicy, type ProtectedSet } from "./types"
import { CATALOG_POLICY } from "./catalog"

// --- Layered policy loader ---
//
// Resolution order (most specific wins for scalar fields; rules accumulate):
//   built-in catalog  ->  policy.yaml  ->  environments/*.yaml  ->  agents/<id>.yaml
//
// Files live under `<root>/.agentx/guardrails/`. `root` is the daemon's
// install dir (passed via `--root` from the generated hook command), NOT the
// agent workspace — policy is fleet-central and reviewed as one unit.
//
// Mirrors the YAML+Zod approach of src/agents/references/loader.ts.

export const GUARDRAILS_DIR = ".agentx/guardrails"

export function readPolicyFile(path: string): GuardPolicy | null {
  if (!existsSync(path)) return null
  try {
    const parsed = yaml.load(readFileSync(path, "utf8"))
    if (parsed == null) return null
    return guardPolicySchema.parse(parsed)
  } catch (e: any) {
    // A malformed policy file must not silently disable the guard. Surface on
    // stderr (the hook's stderr is logged) and skip this layer.
    process.stderr.write(`[agentx-guard] failed to load policy ${path}: ${e?.message}\n`)
    return null
  }
}

/** Merge `layer` onto `base` in place-ish (returns a new object). Scalars
 *  (mode/defaults) from `layer` win when set; protected_resources are keyed
 *  by env name (layer overrides same-named sets); rules concatenate. */
function mergeLayer(base: GuardPolicy, layer: GuardPolicy): GuardPolicy {
  return {
    version: layer.version ?? base.version,
    mode: layer.mode ?? base.mode,
    defaults: { ...base.defaults, ...layer.defaults } as GuardPolicy["defaults"],
    protected_resources: { ...base.protected_resources, ...layer.protected_resources },
    rules: [...(base.rules ?? []), ...(layer.rules ?? [])],
    agents: { ...base.agents, ...layer.agents },
  }
}

/**
 * Load and merge every policy layer under `<root>/.agentx/guardrails/`, then
 * flatten into a ResolvedPolicy for `agentId`. When no files exist, the
 * built-in catalog is returned as-is (so a fresh install still has the
 * default protections in warn mode).
 */
export function loadPolicy(root: string, agentId?: string): ResolvedPolicy {
  const dir = resolve(root, GUARDRAILS_DIR)
  let merged: GuardPolicy = CATALOG_POLICY

  // 1. global policy.yaml
  const global = readPolicyFile(join(dir, "policy.yaml"))
  if (global) merged = mergeLayer(merged, global)

  // 2. environments/*.yaml (alphabetical, deterministic)
  const envDir = join(dir, "environments")
  if (existsSync(envDir)) {
    let files: string[] = []
    try {
      files = readdirSync(envDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort()
    } catch {
      /* ignore */
    }
    for (const f of files) {
      const layer = readPolicyFile(join(envDir, f))
      if (layer) merged = mergeLayer(merged, layer)
    }
  }

  // 3. agents/<id>.yaml — the filename implies the agent, so its top-level
  //    `rules`/`mode` are auto-scoped to <id> (operators need not repeat the
  //    id inside). Its `protected_resources` still merge globally.
  if (agentId) {
    const agentLayer = readPolicyFile(join(dir, "agents", `${agentId}.yaml`))
    if (agentLayer) {
      merged = mergeLayer(merged, {
        ...agentLayer,
        mode: undefined, // don't let an agent file change the GLOBAL mode
        rules: [], // scoped below, not applied fleet-wide
        agents: {},
      })
      const prior = merged.agents?.[agentId]
      merged.agents = {
        ...merged.agents,
        [agentId]: {
          mode: agentLayer.mode ?? agentLayer.agents?.[agentId]?.mode ?? prior?.mode,
          rules: [
            ...(prior?.rules ?? []),
            ...(agentLayer.agents?.[agentId]?.rules ?? []),
            ...(agentLayer.rules ?? []),
          ],
        },
      }
    }
  }

  return flatten(merged, agentId)
}

/** Flatten a merged GuardPolicy for one agent: apply the agent's `mode`
 *  override (if any), and append the agent's scoped rules. */
export function flatten(policy: GuardPolicy, agentId?: string): ResolvedPolicy {
  const agentBlock = agentId ? policy.agents?.[agentId] : undefined
  const rules = [...(policy.rules ?? [])]
  if (agentBlock?.rules?.length) rules.push(...agentBlock.rules)

  const protectedResources: Record<string, ProtectedSet> = {}
  for (const [k, v] of Object.entries(policy.protected_resources ?? {})) protectedResources[k] = v

  return {
    mode: agentBlock?.mode ?? policy.mode ?? "warn",
    defaults: {
      fail_mode: policy.defaults?.fail_mode ?? "closed",
      unmatched: policy.defaults?.unmatched ?? "allow",
    },
    protectedResources,
    rules,
  }
}

/** Build a ResolvedPolicy from an in-memory GuardPolicy (tests, `guard test`
 *  with an inline policy) without touching disk. */
export function resolveInMemory(policy: GuardPolicy, agentId?: string): ResolvedPolicy {
  return flatten(mergeLayer(CATALOG_POLICY, policy), agentId)
}

/** One rule as written in a policy file, before any merge. */
export interface PolicyRuleEntry {
  rule: GuardRule
  /** The file, relative to `root`. */
  file: string
  /** Set when the rule only applies to one agent: an `agents/<id>.yaml`
   *  file, or an `agents.<id>.rules` block. */
  agentId?: string
}

/** Every rule in every policy file under `<root>/.agentx/guardrails/`, for
 *  every agent. The built-in catalog is left out: nothing tags it. */
export function listPolicyRules(root: string): PolicyRuleEntry[] {
  const dir = resolve(root, GUARDRAILS_DIR)
  const yamls = (d: string) => {
    try {
      return readdirSync(d).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort()
    } catch {
      return []
    }
  }
  const files: Array<{ path: string; agentId?: string }> = [{ path: "policy.yaml" }]
  for (const f of yamls(join(dir, "environments"))) files.push({ path: `environments/${f}` })
  // loadPolicy reads only `agents/<id>.yaml`, so a `.yml` there is not live.
  for (const f of yamls(join(dir, "agents")).filter((f) => f.endsWith(".yaml"))) {
    files.push({ path: `agents/${f}`, agentId: f.slice(0, -".yaml".length) })
  }

  const out: PolicyRuleEntry[] = []
  for (const f of files) {
    const policy = readPolicyFile(join(dir, f.path))
    if (!policy) continue
    const file = `${GUARDRAILS_DIR}/${f.path}`
    for (const rule of policy.rules ?? []) out.push({ rule, file, ...(f.agentId ? { agentId: f.agentId } : {}) })
    for (const [agentId, block] of Object.entries(policy.agents ?? {})) {
      for (const rule of block.rules ?? []) out.push({ rule, file, agentId })
    }
  }
  return out
}
