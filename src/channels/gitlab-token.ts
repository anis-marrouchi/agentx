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
