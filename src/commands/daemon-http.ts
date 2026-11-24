import { loadDaemonConfig } from "@/daemon/config"

// Small helpers shared by `agentx daemon restart` and `agentx daemon upgrade`
// to talk to the local daemon.

export async function getJson(url: string, timeoutMs = 3000): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

/** In-flight count: the restart endpoint, else /health (older daemons only
 *  report per-agent active counts there). Null when the daemon is silent. */
export async function readInflight(base: string): Promise<number | null> {
  const info = await getJson(`${base}/daemon/restart`)
  if (typeof info?.inflight?.total === "number") return info.inflight.total
  const h = await getJson(`${base}/health`)
  if (!h) return null
  if (typeof h.inflight?.total === "number") return h.inflight.total
  return Array.isArray(h.agents) ? h.agents.reduce((n: number, a: any) => n + (Number(a.active) || 0), 0) : null
}

/** The daemon's local URL from agentx.json's node.bind. */
export function daemonBase(configPath?: string): string {
  const config = loadDaemonConfig(configPath)
  const [host, portStr] = config.node.bind.split(":")
  const port = parseInt(portStr || "18800", 10)
  return `http://${!host || host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`
}

/** How long a stopping daemon may take to finish its tasks, plus a minute. */
export function drainLimitMs(): number {
  return parseInt(process.env.AGENTX_DRAIN_TIMEOUT_MS || "300000", 10) + 60_000
}
