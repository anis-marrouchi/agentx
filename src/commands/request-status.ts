import { Command } from "commander"
import chalk from "chalk"
import { applyConfigMutation } from "@/daemon/config-mutator"
import { loadDaemonConfig } from "@/daemon/config"
import { STATUS_CHANNELS, setStatusChannel } from "@/requests/status-settings"

// --- agentx request-status: show a request's state where it was made (#383) ---
//
// CLI parity with the dashboard's Channels tab. Edits `requestStatus` in
// agentx.json through applyConfigMutation (validated, then hot-reloaded).
// Run it from the folder that holds agentx.json.
//
//   agentx request-status                 which channels show it
//   agentx request-status gitlab on       turn it on for GitLab
//   agentx request-status github off      turn it off for GitHub

export const requestStatus = new Command("request-status")
  .description("show each person the state of their request in the thread where they asked (GitLab, GitHub)")
  .argument("[channel]", STATUS_CHANNELS.join(" or "))
  .argument("[state]", "on or off")
  .action(async (channel?: string, state?: string) => {
    if (channel !== undefined) {
      if (state !== "on" && state !== "off") { console.error(chalk.red("✗ say on or off, for example: agentx request-status gitlab on")); process.exit(1) }
      let summary = ""
      const r = await applyConfigMutation((c: any) => { summary = setStatusChannel(c, channel, state === "on") })
      if (!r.success) { console.error(chalk.red(`✗ ${r.error}`)); process.exit(1) }
      console.log(chalk.green(`✓ ${summary}`))
      if (r.reloaded) console.log(chalk.dim("  daemon hot-reloaded"))
    }
    const on = loadDaemonConfig().requestStatus.channels.map((c) => c.toLowerCase())
    for (const name of STATUS_CHANNELS) console.log(`  ${name.padEnd(8)} ${on.includes(name) ? chalk.green("on") : chalk.dim("off")}`)
  })
