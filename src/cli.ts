#!/usr/bin/env node
import { Command } from "commander"
import { daemon } from "@/commands/daemon"
import { init } from "@/commands/init"
import { agent, channel, cron, mesh, skillCmd, hook, migrate } from "@/commands/manage"
import { chat } from "@/commands/chat"
import { gen } from "@/commands/generate"
import { serve } from "@/commands/serve"
import { a2a } from "@/commands/a2a"
import { model } from "@/commands/model"
import { globalHooks, loadHooks } from "@/hooks"
import { getPackageInfo } from "@/utils/get-package-info"

process.on("SIGINT", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))

async function main() {
  const packageInfo = await getPackageInfo()

  const cwd = process.cwd()
  loadHooks(cwd, globalHooks)

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
    // Core daemon
    .addCommand(daemon)
    .addCommand(init)
    // Management
    .addCommand(agent)
    .addCommand(channel)
    .addCommand(cron)
    .addCommand(mesh)
    .addCommand(skillCmd)
    .addCommand(hook)
    .addCommand(migrate)
    // Code generation (legacy)
    .addCommand(chat)
    .addCommand(gen)
    .addCommand(serve)
    .addCommand(a2a)
    .addCommand(model)

  // Default: show help
  const args = process.argv.slice(2)
  if (args.length === 0) {
    program.outputHelp()
    return
  }

  program.parse()
}

main()
