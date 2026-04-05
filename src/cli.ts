#!/usr/bin/env node
import { chat } from "@/commands/chat"
import { gen } from "@/commands/generate"
import { evolve } from "@/commands/evolve"
import { create } from "@/commands/create"
import { run } from "@/commands/run"
import { inspect } from "@/commands/inspect"
import { skill } from "@/commands/skill"
import { serve } from "@/commands/serve"
import { model } from "@/commands/model"
import { git } from "@/commands/git"
import { a2a } from "@/commands/a2a"
import { daemon } from "@/commands/daemon"
import { init } from "@/commands/init"
import { Command } from "commander"
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
      "self-hosted multi-agent orchestrator — Telegram, WhatsApp, crons, A2A mesh"
    )
    .version(
      packageInfo.version || "1.0.0",
      "-v, --version",
      "display the version number"
    )

  program
    .addCommand(chat)
    .addCommand(gen)
    .addCommand(evolve)
    .addCommand(git)
    .addCommand(create)
    .addCommand(run)
    .addCommand(inspect)
    .addCommand(skill)
    .addCommand(serve)
    .addCommand(model)
    .addCommand(a2a)
    .addCommand(daemon)
    .addCommand(init)

  // Default to chat when no command is given and stdin is a TTY
  const args = process.argv.slice(2)
  if (args.length === 0 && process.stdin.isTTY) {
    process.argv.push("chat")
  }

  program.parse()
}

main()
