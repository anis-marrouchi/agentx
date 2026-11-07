// Which GitLab token a write for an agent uses. Shared by the daemon's
// /gitlab/* peer endpoints and the GitLab adapter (#1745), so both read an
// agent's token from the same places in the same order.

import type { DaemonConfig } from "@/daemon/config"
import { resolveAgentCredential } from "@/integrations/resolve"

/** The token declared in `agents[id].integrations[]` (kind `gitlab-user`,
 *  `tokenEnv`). `token` is unset when there is none; `source` then carries
 *  the resolver status (safe to log, never the secret). */
export function gitlabIntegrationToken(config: DaemonConfig, agentId: string): { token?: string; source: string } {
  const credential = resolveAgentCredential(config, agentId, "gitlab-user", "tokenEnv")
  if (credential.status === "ok" && credential.value) {
    return { token: credential.value, source: `integrations(${credential.envVar})` }
  }
  return { source: credential.status }
}

/** Resolve a GitLab API token for the given agent, checking (in order):
 *    1. `channels.gitlab.agentMappings[].token` — legacy per-agent token
 *    2. `agents[id].integrations[]` (kind=gitlab-user, tokenEnv) — newer
 *       style used by agents declared via `agentx manage`
 *    3. `channels.gitlab.token` — global fallback (group bot identity)
 *  Returns the token plus a `source` tag for diagnostic logging. */
export function resolveGitlabTokenForAgent(config: DaemonConfig, agentId?: string): { token: string | undefined; source: string } {
  const globalToken = config.channels.gitlab?.token
  if (!agentId) return { token: globalToken, source: "global" }
  const mapping = (config.channels.gitlab?.agentMappings || []).find((m: any) => m.agentId === agentId)
  if (mapping?.token) return { token: mapping.token, source: "agentMappings" }
  const integration = gitlabIntegrationToken(config, agentId)
  if (integration.token) return { token: integration.token, source: integration.source }
  if (globalToken) return { token: globalToken, source: "global" }
  return { token: undefined, source: integration.source }
}

// --- The agent's own token in its runs (glab, curl scripts) ---
//
// Every agent run inherited the daemon's GITLAB_TOKEN, so `glab` in any
// agent's shell wrote as the shared account: the coder's notes and pushes
// read as DevOps's on GitLab, and nobody could tell who did the work. The
// daemon registers a resolver at start; each run then gets its own token
// in GITLAB_TOKEN when it has one (agentMappings or integrations). An
// agent without its own token keeps the inherited value.

/** An agent's own GitLab token, never the global one. */
export function ownGitlabToken(config: DaemonConfig, agentId: string): string | undefined {
  const mapping = (config.channels.gitlab?.agentMappings || []).find((m: any) => m.agentId === agentId)
  if (mapping?.token) return mapping.token
  return gitlabIntegrationToken(config, agentId).token
}

let agentTokenResolver: ((agentId: string) => string | undefined) | null = null

/** Set by the daemon (reads the live config at each call). Null: off. */
export function setAgentGitlabTokenResolver(fn: ((agentId: string) => string | undefined) | null): void {
  agentTokenResolver = fn
}

/** Put the agent's own GitLab token where glab and scripts read it. */
export function withAgentGitlabEnv(env: NodeJS.ProcessEnv, agentId: string): NodeJS.ProcessEnv {
  let token: string | undefined
  try { token = agentTokenResolver?.(agentId) } catch { token = undefined }
  if (token) {
    env.GITLAB_TOKEN = token
    env.GITLAB_ACCESS_TOKEN = token
  }
  return env
}
