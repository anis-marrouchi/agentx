// --- Per-agent integration credential resolver ---
//
// Given an agent's `integrations[]` registration in agentx.json, resolve the
// concrete credential (env-var lookup, keyring read, etc.) at use-time.
// Skills, channel adapters, and the action layer call into this instead of
// hard-coding env-var names.
//
// Secrets never live in the config; only references do. This module is the
// single chokepoint where references become values, so audit / redact /
// rotate logic can land here later without touching call sites.

import type { DaemonConfig } from "@/daemon/config"
import type { Integration } from "@/daemon/config"

export type ResolvedStatus = "ok" | "env-unset" | "no-credential" | "kind-not-found" | "agent-not-found"

export interface ResolvedCredential {
  status: ResolvedStatus
  value?: string
  envVar?: string
  /** Surfaced in error logs; safe to log (never the secret itself). */
  reason?: string
}

/**
 * Look up an integration on an agent by `kind` (or `kind` + `label`). When
 * multiple integrations of the same kind exist, the caller should pass a
 * label to disambiguate; otherwise the first matching enabled entry wins.
 */
export function getIntegration(
  config: DaemonConfig,
  agentId: string,
  kind: string,
  label?: string,
): { agentId: string; integration: Integration } | null {
  const agent = config.agents?.[agentId]
  if (!agent) return null
  const list = (agent as any).integrations as Integration[] | undefined
  if (!Array.isArray(list)) return null
  const match = list.find(
    (i) => i.enabled !== false && i.kind === kind && (!label || i.label === label),
  )
  return match ? { agentId, integration: match } : null
}

/**
 * List every integration of a given kind across all agents. Useful for
 * webhook-routing UI ("which agents have hubspot?") and for skill loaders.
 */
export function findIntegrationsByKind(
  config: DaemonConfig,
  kind: string,
): Array<{ agentId: string; integration: Integration }> {
  const out: Array<{ agentId: string; integration: Integration }> = []
  for (const [agentId, agent] of Object.entries(config.agents ?? {})) {
    const list = (agent as any).integrations as Integration[] | undefined
    if (!Array.isArray(list)) continue
    for (const integration of list) {
      if (integration.enabled === false) continue
      if (integration.kind === kind) out.push({ agentId, integration })
    }
  }
  return out
}

/**
 * Resolve a specific credential field on an integration. The `key` is one
 * of the optional fields on credentialsSchema (`tokenEnv`, `apiKeyEnv`,
 * `privateAppTokenEnv`, etc.) OR `auth` for keyring directive.
 *
 * Resolution rules:
 *   - `*Env` keys → look up process.env[<value>]
 *   - `auth: "keyring"` → returns `{ status: "ok", value: undefined }` —
 *     skills are responsible for the actual keyring read (uses agentId+kind
 *     as the canonical entry name).
 *   - missing field → `{ status: "no-credential" }`
 */
export function resolveCredential(
  integration: Integration,
  key: keyof Integration["credentials"],
): ResolvedCredential {
  const creds = integration.credentials ?? {}
  const ref = (creds as any)[key]
  if (!ref) {
    return { status: "no-credential", reason: `integration "${integration.label}" has no ${String(key)} configured` }
  }
  // Keyring directive — caller (the skill) does the actual read.
  if (key === "auth" && ref === "keyring") {
    return { status: "ok" }
  }
  // Env-var ref.
  if (typeof ref === "string" && /^[A-Z][A-Z0-9_]*$/.test(ref)) {
    const value = process.env[ref]
    if (!value) {
      return {
        status: "env-unset",
        envVar: ref,
        reason: `env var ${ref} is unset (declared by integration "${integration.label}")`,
      }
    }
    return { status: "ok", value, envVar: ref }
  }
  // Anything else is a literal string field (e.g. sessionDir for whatsapp).
  if (typeof ref === "string") {
    return { status: "ok", value: ref }
  }
  return { status: "no-credential", reason: `unrecognized credential ref shape for ${String(key)}` }
}

/**
 * Convenience: resolve the agent + kind in one call.
 */
export function resolveAgentCredential(
  config: DaemonConfig,
  agentId: string,
  kind: string,
  key: keyof Integration["credentials"],
  label?: string,
): ResolvedCredential {
  const found = getIntegration(config, agentId, kind, label)
  if (!found) {
    return {
      status: "kind-not-found",
      reason: `agent "${agentId}" has no integration of kind "${kind}"${label ? ` with label "${label}"` : ""}`,
    }
  }
  return resolveCredential(found.integration, key)
}
