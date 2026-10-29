import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"
import { formatQueue } from "@/admission/format"
import type { AdmissionSnapshot } from "@/admission/queue"

// --- agentx queue — what runs on this node, what waits, and why (#1521) ---
//
//   agentx queue            resources, gate, caps, running, waiting, next
//   agentx queue --json     the same, as GET /api/queue returns it
//
// Settings: `agentx config set admission.<key> <value>` (maxSessions,
// minAvailableMemoryMB, maxSwapUsedMB, maxLoadPerCpu, classes, …).

export const queue = new Command()
  .name("queue")
  .description("show the node's session queue: resources, running, waiting and next in line")
  .option("-c, --config <path>", "daemon config file")
  .option("--node <url>", "daemon URL (default: dashboard.daemonUrl)")
  .option("--json", "print the raw JSON")
  .action(async (opts: { config?: string; node?: string; json?: boolean }) => {
    let baseUrl = opts.node || ""
    let token = ""
    try {
      const cfg = loadDaemonConfig(opts.config)
      if (!baseUrl) baseUrl = cfg.dashboard?.daemonUrl || ""
      token = cfg.dashboard?.token || ""
    } catch { /* defaults below */ }
    baseUrl = (baseUrl || "http://localhost:18800").replace(/\/+$/, "")
    let snap: AdmissionSnapshot
    try {
      const res = await fetch(`${baseUrl}/api/queue`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        console.log(chalk.red(`  HTTP ${res.status} from ${baseUrl}/api/queue${res.status === 404 ? " (the daemon is older than this command)" : ""}`))
        process.exit(1)
      }
      snap = await res.json() as AdmissionSnapshot
    } catch (e: any) {
      console.log(chalk.red(`  could not reach daemon at ${baseUrl}: ${e?.message || e}`))
      process.exit(1)
    }
    console.log(opts.json ? JSON.stringify(snap, null, 2) : formatQueue(snap))
  })
