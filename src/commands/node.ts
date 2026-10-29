import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"
import { formatNode } from "@/node-env/format"
import type { NodeReport } from "@/node-env"

// --- agentx node — what the node knows about its own environment (#1531) ---
//
//   agentx node            machine, programs, Claude account, running work
//   agentx node --json     the same, as GET /api/node returns it
//
// Settings: `environment.tools` (the programs whose versions it reads)
// and `environment.toolsRefreshHours`.

export const node = new Command()
  .name("node")
  .description("show what this node knows about itself: machine, programs, Claude account limits and running work")
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
    let report: NodeReport
    try {
      const res = await fetch(`${baseUrl}/api/node`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        console.log(chalk.red(`  HTTP ${res.status} from ${baseUrl}/api/node${res.status === 404 ? " (the daemon is older than this command)" : ""}`))
        process.exit(1)
      }
      report = await res.json() as NodeReport
    } catch (e: any) {
      console.log(chalk.red(`  could not reach daemon at ${baseUrl}: ${e?.message || e}`))
      process.exit(1)
    }
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatNode(report))
  })
