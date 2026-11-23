import { isSshNode, sshCheckoutOf, sshNodeOf, sshPushLimitRefusal, sshServerOf, type SshServer } from "@/agents/ssh-run"

// --- SSH servers in the Hub's "Run on" (#2104 PR 2) ---
//
// Listed next to the mesh peers as `ssh:<name>`, labelled "SSH", when the
// server has a checkout of the issue's repository. This Mac runs the agent
// there, so the agent only has to be on this Mac. A server that does not
// answer over SSH counts as offline, as a peer that is down does.

export interface SshRunOnDeps {
  sshServers?: () => readonly SshServer[]
  /** Whether the server answers over SSH; short timeout. */
  sshHealthy?: (server: SshServer) => Promise<boolean>
}

export interface SshChoice { node: string; label: string; kind: "ssh"; healthy: boolean; hostsAgent: boolean; hasCheckout: true }

/** The SSH servers that can run an issue of `repo`. */
export async function sshChoices(repo: string, localHostsAgent: boolean, deps: SshRunOnDeps): Promise<SshChoice[]> {
  const fit = (deps.sshServers?.() ?? []).filter((s) => !!sshCheckoutOf(s, repo))
  const healthy = await Promise.all(fit.map((s) => healthOf(s, deps)))
  return fit.map((s, i) => ({ node: sshNodeOf(s.name), label: `${s.name} (SSH)`, kind: "ssh" as const, healthy: healthy[i], hostsAgent: localHostsAgent, hasCheckout: true as const }))
}

/** Whether an `ssh:<name>` node answers; false when it is not configured. */
export async function sshNodeHealthy(node: string, deps: SshRunOnDeps): Promise<boolean> {
  const server = sshServerOf(node, deps.sshServers?.())
  return server ? healthOf(server, deps) : false
}

/** Why an issue of `repo` may not move to an `ssh:<name>` node, or null. */
export async function sshTargetRefusal(node: string, repo: string, agentId: string, localHostsAgent: boolean, deps: SshRunOnDeps): Promise<string | null> {
  const server = sshServerOf(node, deps.sshServers?.())
  if (!server) return `"${node}" is not in sshServers on this Mac.`
  const noLimit = sshPushLimitRefusal(server)
  if (noLimit) return noLimit
  if (!sshCheckoutOf(server, repo)) return `${node} has no checkout of ${repo} (sshServers[].checkouts).`
  if (!localHostsAgent) return `${agentId} is not on this Mac, which runs it on ${node}.`
  if (!(await healthOf(server, deps))) return `${node} does not answer over SSH.`
  return null
}

export { isSshNode }

async function healthOf(server: SshServer, deps: SshRunOnDeps): Promise<boolean> {
  if (!deps.sshHealthy) return false
  try { return await deps.sshHealthy(server) } catch { return false }
}
