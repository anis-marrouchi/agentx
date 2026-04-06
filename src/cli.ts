#!/usr/bin/env node
import { Command } from "commander"
import { daemon } from "@/commands/daemon"
import { init } from "@/commands/init"
import { agent, channel, cron, mesh, skillCmd, hook, migrate, configCmd } from "@/commands/manage"
import { usage } from "@/commands/usage"
import { getPackageInfo } from "@/utils/get-package-info"

process.on("SIGINT", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))

async function main() {
  const packageInfo = await getPackageInfo()

  const program = new Command()
    .name("agentx")
    .description(
      "self-hosted multi-agent orchestrator — Telegram, WhatsApp, crons, A2A mesh, wiki knowledge"
    )
    .version(
      packageInfo.version || "1.0.0",
      "-v, --version",
      "display the version number"
    )

  program
    .addCommand(daemon)
    .addCommand(init)
    .addCommand(agent)
    .addCommand(channel)
    .addCommand(cron)
    .addCommand(mesh)
    .addCommand(skillCmd)
    .addCommand(hook)
    .addCommand(migrate)
    .addCommand(configCmd)
    .addCommand(usage)

  const args = process.argv.slice(2)
  if (args.length === 0) {
    program.outputHelp()
    return
  }

  program.parse()
}

main()
